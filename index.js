// ============================================================================
// CLOUDFLARE WORKER: CORS PROXY + ADAPTADOR PARA CESBO ASTRA & HLS/DASH
// Versión completa restaurada, optimizada para *.workers.dev y anti-baneos
// ============================================================================

// ---------------------------------------------------------------------------
// 1. CONFIGURACIÓN Y MEMORIA RAM LOCAL (Compatible con *.workers.dev)
// ---------------------------------------------------------------------------
const SEGMENT_TTL_S = 60;          // Cache edge para segmentos
const MANIFEST_RAM_TTL_MS = 2000;  // Micro-caché en RAM del manifiesto (2 segundos)
const STALE_MAX_MS = 35000;        // Tiempo para servir manifiesto viejo si el origen cae
const UPSTREAM_TIMEOUT_MS = 7000;  // Timeout de conexión al servidor
const UPSTREAM_RETRIES = 2;        // Reintentos en caso de microcorte

// Memoria RAM interna del Worker (aislada y rápida, no requiere dominio)
const RAM_CACHE = new Map();

function saveToRam(key, text, contentType) {
  if (RAM_CACHE.size > 80) {
    const firstKey = RAM_CACHE.keys().next().value;
    RAM_CACHE.delete(firstKey);
  }
  RAM_CACHE.set(key, { text, contentType, time: Date.now() });
}

function getFromRam(key) {
  const item = RAM_CACHE.get(key);
  if (!item) return null;
  const age = Date.now() - item.time;
  if (age <= MANIFEST_RAM_TTL_MS) {
    return { text: item.text, contentType: item.contentType, isStale: false };
  }
  if (age <= STALE_MAX_MS) {
    return { text: item.text, contentType: item.contentType, isStale: true };
  }
  RAM_CACHE.delete(key);
  return null;
}

// ---------------------------------------------------------------------------
// 2. CODIFICACIÓN DE IDENTIDAD EN RUTA (/i/<id>/<url>)
// ---------------------------------------------------------------------------
function encodeIdentity(id) {
  const json = JSON.stringify({ o: id.o || undefined, r: id.r || undefined, u: id.u || undefined });
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeIdentity(str) {
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const json = new TextDecoder().decode(bytes);
    const o = JSON.parse(json);
    return { o: o.o || null, r: o.r || null, u: o.u || null };
  } catch (_) {
    return { o: null, r: null, u: null };
  }
}

function normalizeOrigin(value) {
  if (!value) return null;
  try { return new URL(value).origin; } catch (_) { return value; }
}

// ---------------------------------------------------------------------------
// 3. CABECERAS LIMPIAS (Evita disparar WAFs y baneos de IP)
// ---------------------------------------------------------------------------
function buildUpstreamHeaders({ request, parsedTarget, ua, origin, referer }) {
  const h = new Headers();

  // User-Agent real del cliente o estándar compatible con reproductores de video
  const clientUa = request.headers.get("User-Agent");
  const finalUa = ua || clientUa || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

  h.set("User-Agent", finalUa);
  h.set("Accept", "*/*");
  h.set("Accept-Language", "es-ES,es;q=0.9,en;q=0.8");

  // El Host DEBE ser exactamente el del destino original (evita bloqueos de Nginx/Astra)
  h.set("Host", parsedTarget.host);

  const effOrigin = origin || parsedTarget.origin;
  h.set("Origin", effOrigin);
  h.set("Referer", referer || `${parsedTarget.origin}/`);

  if (request.headers.has("range")) h.set("Range", request.headers.get("range"));
  if (request.headers.has("cookie")) h.set("Cookie", request.headers.get("cookie"));

  return h;
}

// ---------------------------------------------------------------------------
// 4. ADAPTADOR Y SANEADOR DE MANIFIESTOS ASTRA HLS
// ---------------------------------------------------------------------------
function patchAstraHlsManifest(text, makeProxied) {
  // Reescritura de claves DRM, mapas fMP4, subtítulos y audio alternativo
  let patched = text.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${makeProxied(uri)}"`);

  const lines = patched.split("\n");
  const processedLines = [];

  for (let line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      processedLines.push(line);
      continue;
    }

    // Parcheo de códecs de audio antiguos de Astra a AAC LC estándar
    if (trimmed.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      if (/mp4a\.6[9b]/i.test(trimmed)) {
        line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
      }
    }

    // Inyección de códecs de video si Astra los omite
    if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
      if (!trimmed.includes("CODECS=")) {
        line = `${trimmed},CODECS="avc1.4d401f,mp4a.40.2"`;
      } else {
        line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
      }
    }

    // Línea de segmento o submanifiesto
    if (!trimmed.startsWith("#")) {
      line = makeProxied(trimmed);
    }

    processedLines.push(line);
  }

  return processedLines.join("\n");
}

// ---------------------------------------------------------------------------
// 5. CLASIFICACIÓN DE FLUJOS Y PETICIONES
// ---------------------------------------------------------------------------
function stripControlParams(url) {
  return url
    .replace(/([?&])(?:origin|referer|ua|user-agent)=[^&]*/gi, (_, sep) => (sep === "?" ? "?" : ""))
    .replace(/\?&+/, "?")
    .replace(/\?$/, "");
}

function isContinuousTs(path) {
  return /\/play\/[^/]+\/?$/.test(path);
}

function classify(path) {
  if (path.endsWith(".m3u8") || path.endsWith(".mpd")) return "manifest";
  if (isContinuousTs(path)) return "stream";
  if (path.endsWith(".ts") || path.endsWith(".m4s") || path.endsWith(".aac")) return "segment";
  return "other";
}

async function fetchWithRetry(url, options, { retry404 = false } = {}) {
  const canRetry = options.method === "GET" || options.method === "HEAD";
  const max = canRetry ? UPSTREAM_RETRIES : 0;
  let lastErr;

  for (let i = 0; i <= max; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer);
      const bad = res.status >= 500 || (retry404 && res.status === 404);
      if (!bad || i === max) return res;
      res.body?.cancel();
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i === max) throw err;
    }
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// 6. HANDLER PRINCIPAL
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const reqOrigin = request.headers.get("Origin");

    const corsHeaders = {
      "Access-Control-Allow-Origin": reqOrigin || "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date, Set-Cookie, X-Proxy-Cache",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const reqUrl = new URL(request.url);

      if (reqUrl.pathname === "/ping" || reqUrl.pathname === "/heartbeat") {
        return new Response("OK", { status: 200, headers: corsHeaders });
      }

      // EXTRACCIÓN DE IDENTIDAD Y URL DESTINO
      let identity = { o: null, r: null, u: null };
      let targetUrl = "";
      const idMatch = reqUrl.pathname.match(/^\/i\/([A-Za-z0-9_-]+)\/(.+)$/);

      if (idMatch) {
        identity = decodeIdentity(idMatch[1]);
        targetUrl = (idMatch[2] + reqUrl.search).replace(/^(https?):\/+([^\/])/i, "$1://$2");
      } else {
        const sp = reqUrl.searchParams;
        identity = { o: sp.get("origin"), r: sp.get("referer"), u: sp.get("ua") || sp.get("user-agent") };

        if (reqUrl.pathname.startsWith("/p/")) {
          targetUrl = reqUrl.pathname.substring(3) + reqUrl.search;
          targetUrl = targetUrl.replace(/^(https?):\/+([^\/])/i, "$1://$2");
        } else {
          const rawUrl = request.url;
          const urlMatches = rawUrl.match(/[?&]url=(.+)$/);
          targetUrl = urlMatches ? urlMatches[1] : sp.get("url");
        }
        if (targetUrl) targetUrl = stripControlParams(targetUrl);
      }

      if (!targetUrl) {
        return new Response("Falta el parámetro ?url= o la ruta /p/URL", {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      try {
        if (targetUrl.includes("%3A") || targetUrl.includes("%2F")) {
          targetUrl = decodeURIComponent(targetUrl);
        }
      } catch (_) {}

      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = "http://" + targetUrl.replace(/^\/+/, "");
      }

      const parsedTarget = new URL(targetUrl);
      const cleanTarget = parsedTarget.pathname.toLowerCase();
      const kind = classify(cleanTarget);

      // VERIFICACIÓN EN MEMORIA RAM (Evita saturar Astra con peticiones repetidas)
      if (kind === "manifest" && request.method === "GET") {
        const ramHit = getFromRam(targetUrl);
        if (ramHit && !ramHit.isStale) {
          const h = new Headers(corsHeaders);
          h.set("Content-Type", ramHit.contentType);
          h.set("Cache-Control", "no-cache, no-store, must-revalidate");
          h.set("X-Proxy-Cache", "RAM-HIT");
          return new Response(ramHit.text, { status: 200, headers: h });
        }
      }

      // CONSTRUCCIÓN DE CABECERAS UPSTREAM
      const upstreamHeaders = buildUpstreamHeaders({
        request,
        parsedTarget,
        ua: identity.u,
        origin: normalizeOrigin(identity.o),
        referer: identity.r,
      });

      const fetchOptions = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        fetchOptions.body = request.body;
      }

      // PETICIÓN DIRECTA AL ORIGEN (Sin sslip.io)
      let res = null;
      try {
        res = await fetchWithRetry(targetUrl, fetchOptions, { retry404: kind === "segment" });
      } catch (_) {
        res = null;
      }

      // RECUPERACIÓN SI EL ORIGEN CAE (Sirve la última versión de RAM)
      if ((!res || res.status >= 500) && request.method === "GET" && kind === "manifest") {
        const stale = getFromRam(targetUrl);
        if (stale) {
          res?.body?.cancel();
          const h = new Headers(corsHeaders);
          h.set("Content-Type", stale.contentType);
          h.set("Cache-Control", "no-cache, no-store, must-revalidate");
          h.set("X-Proxy-Cache", "STALE-RECOVERY");
          return new Response(stale.text, { status: 200, headers: h });
        }
      }

      if (!res) {
        return new Response("Origen no disponible (Timeout o Conexión rechazada)", {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      if (request.method === "HEAD") {
        const headHeaders = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders)) headHeaders.set(k, v);
        return new Response(null, { status: res.status, headers: headHeaders });
      }

      if (!res.ok && res.status !== 206) {
        const errorText = await res.text();
        return new Response(errorText, {
          status: res.status,
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      // RECONSTRUCCIÓN DE URLS RELATIVAS
      const baseUrl = new URL("./", parsedTarget).href;
      const hasIdentity = identity.o || identity.r || identity.u;
      const proxyPrefix = hasIdentity
        ? `${reqUrl.origin}/i/${encodeIdentity(identity)}/`
        : `${reqUrl.origin}/p/`;

      function resolveUpstream(pathOrUrl) {
        const resolved = new URL(pathOrUrl.trim(), baseUrl);
        if (parsedTarget.searchParams) {
          for (const [k, v] of parsedTarget.searchParams.entries()) {
            if (!resolved.searchParams.has(k)) {
              resolved.searchParams.set(k, v);
            }
          }
        }
        return resolved;
      }

      function makeProxied(pathOrUrl) {
        const trimmed = pathOrUrl.trim();
        if (!trimmed) return "";
        try {
          return `${proxyPrefix}${resolveUpstream(trimmed).href}`;
        } catch (_) {
          return `${proxyPrefix}${trimmed}`;
        }
      }

      // CABECERAS LIMPIAS PARA MANIFIESTOS (Elimina compresión previa para no romper decodificación)
      function cleanManifestHeaders(contentType) {
        const h = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
        h.delete("Content-Encoding");
        h.delete("Content-Length");
        h.delete("Transfer-Encoding");
        h.set("Content-Type", contentType);
        h.set("Cache-Control", "no-cache, no-store, must-revalidate");
        return h;
      }

      // DETECCIÓN DE TIPO DE CONTENIDO
      const rawContentType = (res.headers.get("content-type") || "").toLowerCase();
      let isHls = cleanTarget.endsWith(".m3u8") || rawContentType.includes("mpegurl");
      let isDash = cleanTarget.endsWith(".mpd") || rawContentType.includes("dash+xml");

      let responseText = null;
      if (!isHls && !isDash && (rawContentType.includes("xml") || rawContentType.includes("text") || cleanTarget.includes("manifest"))) {
        responseText = await res.text();
        if (responseText.includes("#EXTM3U")) isHls = true;
        else if (responseText.includes("<MPD") || responseText.includes("<mpd")) isDash = true;
      }

      // CASO A: HLS (.m3u8) CON ADAPTADOR CESBO ASTRA
      if (isHls) {
        const original = responseText !== null ? responseText : await res.text();
        const text = patchAstraHlsManifest(original, makeProxied);
        const cType = "application/vnd.apple.mpegurl; charset=utf-8";

        if (request.method === "GET" && res.status === 200) {
          saveToRam(targetUrl, text, cType);
        }

        return new Response(text, {
          status: res.status,
          headers: cleanManifestHeaders(cType),
        });
      }

      // CASO B: MPEG-DASH (.mpd)
      if (isDash) {
        let text = responseText !== null ? responseText : await res.text();
        const proxiedBase = `<BaseURL>${proxyPrefix}${baseUrl}</BaseURL>`;

        if (/<BaseURL[^>]*>/i.test(text)) {
          text = text.replace(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi, (_, p1) => `<BaseURL>${makeProxied(p1)}</BaseURL>`);
        } else {
          text = text.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  ${proxiedBase}`);
        }

        const cType = "application/dash+xml; charset=utf-8";
        if (request.method === "GET" && res.status === 200) {
          saveToRam(targetUrl, text, cType);
        }

        return new Response(text, {
          status: res.status,
          headers: cleanManifestHeaders(cType),
        });
      }

      // CASO C: SEGMENTOS BINARIOS (.ts, .m4s) O STREAM CONTINUO DIRECTO
      const binaryHeaders = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders)) binaryHeaders.set(k, v);

      if (kind === "stream" || rawContentType.includes("mp2t")) {
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      } else if (cleanTarget.endsWith(".ts")) {
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
      } else if (cleanTarget.endsWith(".m4s")) {
        binaryHeaders.set("Content-Type", "video/iso.segment");
        binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
      }

      if (typeof res.headers.getSetCookie === "function") {
        for (const cookie of res.headers.getSetCookie()) {
          binaryHeaders.append("Set-Cookie", cookie);
        }
      }

      // Streaming directo sin tocar memoria
      return new Response(res.body, {
        status: res.status,
        headers: binaryHeaders,
      });

    } catch (err) {
      return new Response("Error al procesar stream: " + err.message, {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
};
