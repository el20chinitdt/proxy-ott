// ============================================================================
// CLOUDFLARE WORKER: FULL CORS PROXY + ADAPTADOR PARA CESBO ASTRA (HLS/DASH)
// Versión: Autónoma, 100% compatible con W3C CORS, con soporte de credenciales.
// ============================================================================

// ---------------------------------------------------------------------------
// CONFIGURACIÓN (Ajustable aquí o en Variables de Entorno de Cloudflare)
// ---------------------------------------------------------------------------
const SECRET_KEY = "";          // Opcional: si pones "mi_clave", exigirá ?key=mi_clave
const SEGMENT_TTL_S = 60;        // Vida de segmentos en caché (.ts / .m4s)
const MASTER_TTL_S = 60;         // Caché para Master Playlist (resoluciones/audios)
const MANIFEST_LIVE_TTL_S = 2;   // Micro-caché para manifiesto live
const STALE_MAX_MS = 30000;      // Margen de gracia si Astra cae (30 segundos)
const UPSTREAM_TIMEOUT_MS = 5000;// Timeout por intento hacia Astra
const UPSTREAM_RETRIES = 2;      // Reintentos si Astra devuelve 5xx o corta conexión
const PREFETCH_COUNT = 2;        // Segmentos a precalentar en el Edge (0 = off)

// Memoria RAM viva del Worker para stale-if-error (funciona en *.workers.dev)
const memoryCache = new Map();

// ---------------------------------------------------------------------------
// 1. IDENTIDAD DE NAVEGADOR Y FINGERPRINTING (Chromium GREASE + Client Hints)
// ---------------------------------------------------------------------------
function currentChromeMajor(env) {
  const fromEnv = parseInt(env && env.CHROME_MAJOR, 10);
  if (fromEnv > 0) return fromEnv;
  const anchor = Date.UTC(2026, 5, 2);
  const cycles = Math.max(0, Math.floor((Date.now() - anchor) / (28 * 24 * 60 * 60 * 1000)));
  return 149 + Math.max(0, cycles - 1);
}

function chromeBrandList(major) {
  const chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
  const versions = ["8", "99", "24"];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const greaseBrand = `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`;
  const order = orders[major % orders.length];
  const list = [];
  list[order[0]] = `"${greaseBrand}";v="${versions[major % 3]}"`;
  list[order[1]] = `"Chromium";v="${major}"`;
  list[order[2]] = `"Google Chrome";v="${major}"`;
  return list.join(", ");
}

function chromeHintsFromUa(ua) {
  const m = ua.match(/Chrome\/(\d+)/);
  if (!m || /Edg\/|OPR\/|Firefox\//.test(ua)) return null;
  const platform = /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh/.test(ua) ? "macOS"
    : /CrOS/.test(ua) ? "Chrome OS"
    : /Linux|X11/.test(ua) ? "Linux" : null;
  if (!platform) return null;
  return {
    secChUa: chromeBrandList(parseInt(m[1], 10)),
    mobile: /Mobile/.test(ua) ? "?1" : "?0",
    platform: `"${platform}"`,
  };
}

// Persistencia de identidad y claves en la URL para no romper rutas relativas
function encodeIdentity(id) {
  const json = JSON.stringify({ 
    o: id.o || undefined, 
    r: id.r || undefined, 
    u: id.u || undefined,
    k: id.k || undefined 
  });
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeIdentity(str) {
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const o = JSON.parse(json);
    return { o: o.o || null, r: o.r || null, u: o.u || null, k: o.k || null };
  } catch (_) {
    return { o: null, r: null, u: null, k: null };
  }
}

function normalizeOrigin(value) {
  if (!value) return null;
  try { return new URL(value).origin; } catch (_) { return value; }
}

function buildUpstreamHeaders({ request, parsedTarget, ua, origin, referer, chromeMajor }) {
  const finalUa = ua ||
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;

  const h = new Headers();
  h.set("User-Agent", finalUa);
  h.set("Accept", "*/*");

  const isBrowser = /^Mozilla\/5\.0/.test(finalUa);
  if (origin || referer || isBrowser) {
    const effOrigin = origin || parsedTarget.origin;
    h.set("Origin", effOrigin);
    h.set("Referer", referer || `${effOrigin}/`);
  }

  if (isBrowser) {
    h.set("Accept-Language", "es-ES,es;q=0.9,en;q=0.8");
    if (parsedTarget.protocol === "https:") {
      const effOrigin = origin || parsedTarget.origin;
      h.set("Sec-Fetch-Site", effOrigin === parsedTarget.origin ? "same-origin" : "cross-site");
      h.set("Sec-Fetch-Mode", "cors");
      h.set("Sec-Fetch-Dest", "empty");

      const hints = chromeHintsFromUa(finalUa);
      if (hints) {
        h.set("sec-ch-ua", hints.secChUa);
        h.set("sec-ch-ua-mobile", hints.mobile);
        h.set("sec-ch-ua-platform", hints.platform);
      }
    }
  }

  // Conserva cookies del cliente y soporte de Range (206)
  if (request.headers.has("cookie")) h.set("Cookie", request.headers.get("cookie"));
  if (request.headers.has("range")) h.set("Range", request.headers.get("range"));
  return h;
}

// ---------------------------------------------------------------------------
// 2. PARCHEADOR DE CÓDECS Y RUTAS DE CESBO ASTRA
// ---------------------------------------------------------------------------
function patchAstraHlsManifest(text, makeProxied) {
  let patched = text.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${makeProxied(uri)}"`);
  const lines = patched.split("\n");
  const processedLines = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      processedLines.push(line);
      continue;
    }
    // Corrige audio problemático emitido por Astra a AAC estándar
    if (trimmed.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      if (/mp4a\.6[9b]/i.test(trimmed)) line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
    }
    // Inyecta códecs si Astra los omitió
    if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
      if (!trimmed.includes("CODECS=")) {
        line = `${trimmed},CODECS="avc1.4d401f,mp4a.40.2"`;
      } else {
        line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
      }
    }
    // Reescribe segmentos y claves
    if (!trimmed.startsWith("#")) {
      line = makeProxied(trimmed);
    }
    processedLines.push(line);
  }
  return processedLines.join("\n");
}

function stripControlParams(url) {
  return url
    .replace(/([?&])(?:origin|referer|ua|user-agent|key)=[^&]*/gi, (_, sep) => (sep === "?" ? "?" : ""))
    .replace(/\?&+/, "?")
    .replace(/\?$/, "");
}

function classify(path, hasRange) {
  if (path.endsWith(".m3u8") || path.endsWith(".mpd")) return "manifest";
  if (path.endsWith(".ts") || path.endsWith(".m4s") || path.endsWith(".aac")) {
    return hasRange ? "segment-range" : "segment";
  }
  return "other";
}

function cfOptions(kind) {
  if (kind === "segment") {
    return {
      cacheEverything: true,
      cacheTtlByStatus: { "200-299": SEGMENT_TTL_S, "404": -1, "500-599": -1 },
    };
  }
  if (kind === "manifest") {
    return {
      cacheEverything: true,
      cacheTtlByStatus: { "200-299": MANIFEST_LIVE_TTL_S, "404": -1, "500-599": -1 },
    };
  }
  return { cacheEverything: false };
}

// Bypass de Cloudflare para IPs directas (convierte 1.2.3.4 -> 1.2.3.4.sslip.io)
function toFetchUrl(urlStr) {
  const host = new URL(urlStr).hostname;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ? urlStr.replace(host, `${host}.sslip.io`) : urlStr;
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
// 3. HANDLER PRINCIPAL (FETCH & CORS ENGINE)
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const reqOrigin = request.headers.get("Origin");

    // MOTOR CORS COMPLETO:
    // 1. Refleja dinámicamente el Origin para permitir credenciales/cookies
    // 2. Si no hay Origin (VLC, apps), usa comodín '*' sin romper la regla W3C
    const corsHeaders = {
      "Access-Control-Allow-Origin": reqOrigin || "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
      "Access-Control-Expose-Headers": "*",
      "Access-Control-Max-Age": "86400", // Cachea el preflight 24h para acelerar la carga
      "Vary": "Origin",
    };

    if (reqOrigin) {
      corsHeaders["Access-Control-Allow-Credentials"] = "true";
    }

    // Respuesta a Preflight OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const reqUrl = new URL(request.url);

      if (reqUrl.pathname === "/ping" || reqUrl.pathname === "/heartbeat") {
        return new Response("OK", { status: 200, headers: corsHeaders });
      }

      // EXTRACCIÓN DE IDENTIDAD Y URL DESTINO
      let identity;
      let targetUrl = "";
      const idMatch = reqUrl.pathname.match(/^\/i\/([A-Za-z0-9_-]+)\/(.+)$/);

      if (idMatch) {
        identity = decodeIdentity(idMatch[1]);
        targetUrl = (idMatch[2] + reqUrl.search).replace(/^(https?):\/+([^\/])/i, "$1://$2");
      } else {
        const sp = reqUrl.searchParams;
        identity = { 
          o: sp.get("origin"), 
          r: sp.get("referer"), 
          u: sp.get("ua") || sp.get("user-agent"),
          k: sp.get("key")
        };

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

      // Verificación de clave secreta (si está configurada)
      const effectiveKey = identity.k || reqUrl.searchParams.get("key");
      const configuredKey = (env && env.SECRET_KEY) || SECRET_KEY;
      if (configuredKey && effectiveKey !== configuredKey) {
        return new Response("No autorizado: Falta key o es inválida", { 
          status: 403, 
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } 
        });
      }

      if (!targetUrl) {
        return new Response("Uso: /p/URL o ?url=URL", { 
          status: 400, 
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } 
        });
      }

      try {
        if (targetUrl.includes("%3A") || targetUrl.includes("%2F")) {
          targetUrl = decodeURIComponent(targetUrl);
        }
      } catch (_) {}

      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
      }

      const parsedTarget = new URL(targetUrl);
      const fetchUrl = toFetchUrl(targetUrl);

      const upstreamHeaders = buildUpstreamHeaders({
        request,
        parsedTarget,
        ua: identity.u,
        origin: normalizeOrigin(identity.o),
        referer: identity.r,
        chromeMajor: currentChromeMajor(env),
      });

      const cleanTarget = parsedTarget.pathname.toLowerCase();
      const hasRange = request.headers.has("range");
      const kind = classify(cleanTarget, hasRange);

      const fetchOptions = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
        cf: cfOptions(kind),
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        fetchOptions.body = request.body;
      }

      let res = null;
      try {
        res = await fetchWithRetry(fetchUrl, fetchOptions, { retry404: kind.startsWith("segment") });
      } catch (_) {
        res = null;
      }

      // STALE FALLBACK: Si Astra falla, servimos el último manifiesto vivo desde RAM
      if ((!res || res.status >= 500) && request.method === "GET") {
        const cached = memoryCache.get(fetchUrl);
        if (cached && (Date.now() - cached.time < STALE_MAX_MS)) {
          const h = new Headers(cached.headers);
          for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
          h.set("X-Proxy-Cache", "STALE-MEMORY");
          return new Response(cached.body, { status: 200, headers: h });
        }
      }

      if (!res) {
        return new Response("Origen no disponible (Timeout/Error Astra)", { 
          status: 502, 
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } 
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
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } 
        });
      }

      // PREFIJO PARA REESCRITURA DE URLs RELATIVAS
      const baseUrl = new URL("./", parsedTarget).href;
      const proxyPrefix = `${reqUrl.origin}/i/${encodeIdentity({ 
        o: identity.o, 
        r: identity.r, 
        u: identity.u,
        k: effectiveKey 
      })}/`;

      function resolveUpstream(pathOrUrl) {
        const resolved = new URL(pathOrUrl.trim(), baseUrl);
        if (!resolved.search && parsedTarget.search) resolved.search = parsedTarget.search;
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

      function prefetchSegments(manifestText) {
        if (!PREFETCH_COUNT) return;
        const uris = manifestText
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#") && !/\.(m3u8|mpd)(\?|$)/i.test(l))
          .slice(-PREFETCH_COUNT);

        const preHeaders = new Headers(upstreamHeaders);
        preHeaders.delete("range");

        for (const uri of uris) {
          try {
            const target = resolveUpstream(uri).href;
            ctx.waitUntil(
              fetch(toFetchUrl(target), {
                headers: preHeaders,
                redirect: "follow",
                cf: cfOptions("segment"),
              }).then((r) => (r.ok ? r.arrayBuffer() : r.body?.cancel())).catch(() => {})
            );
          } catch (_) {}
        }
      }

      // DETECCIÓN DE CONTENIDO
      const rawContentType = (res.headers.get("content-type") || "").toLowerCase();
      let isHls = cleanTarget.endsWith(".m3u8") || rawContentType.includes("mpegurl");
      let isDash = cleanTarget.endsWith(".mpd") || rawContentType.includes("dash+xml");

      let responseText = null;
      if (!isHls && !isDash && (rawContentType.includes("xml") || rawContentType.includes("text") || cleanTarget.includes("manifest"))) {
        responseText = await res.text();
        if (responseText.includes("#EXTM3U")) isHls = true;
        else if (responseText.includes("<MPD") || responseText.includes("<mpd")) isDash = true;
      }

      function createResponseHeaders(defaultType) {
        const h = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
        if (defaultType) h.set("Content-Type", defaultType);

        // Reenvío de cookies hacia el reproductor (si Astra manda Set-Cookie)
        if (typeof res.headers.getSetCookie === "function") {
          for (const c of res.headers.getSetCookie()) h.append("Set-Cookie", c);
        }
        return h;
      }

      // CASO A: MANIFIESTOS HLS (.m3u8)
      if (isHls) {
        const original = responseText !== null ? responseText : await res.text();
        const text = patchAstraHlsManifest(original, makeProxied);
        const isMaster = original.includes("#EXT-X-STREAM-INF");

        if (request.method === "GET" && res.status === 200) {
          const hlsHdrs = createResponseHeaders("application/vnd.apple.mpegurl; charset=utf-8");
          memoryCache.set(fetchUrl, { body: text, headers: hlsHdrs, time: Date.now() });
          if (!isMaster && res.headers.get("cf-cache-status") !== "HIT") {
            prefetchSegments(original);
          }
        }

        const hlsHeaders = createResponseHeaders("application/vnd.apple.mpegurl; charset=utf-8");
        // Master Playlist se cachea por más tiempo; playlist de segmentos live solo dura 1-2s
        hlsHeaders.set("Cache-Control", isMaster ? `public, max-age=${MASTER_TTL_S}` : "no-cache, no-store, must-revalidate");

        return new Response(text, { status: res.status, headers: hlsHeaders });
      }

      // CASO B: MANIFIESTOS MPEG-DASH (.mpd)
      if (isDash) {
        let text = responseText !== null ? responseText : await res.text();
        const proxiedBase = `<BaseURL>${proxyPrefix}${baseUrl}</BaseURL>`;
        if (/<BaseURL[^>]*>/i.test(text)) {
          text = text.replace(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi, (m, p1) => `<BaseURL>${makeProxied(p1)}</BaseURL>`);
        } else {
          text = text.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  ${proxiedBase}`);
        }

        const dashHeaders = createResponseHeaders("application/dash+xml; charset=utf-8");
        dashHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        return new Response(text, { status: res.status, headers: dashHeaders });
      }

      // CASO C: SEGMENTOS BINARIOS (.ts, .m4s, .aac)
      const binaryHeaders = createResponseHeaders();
      const cacheStatus = res.headers.get("cf-cache-status");
      if (cacheStatus) binaryHeaders.set("X-Proxy-Cache", cacheStatus);

      if (cleanTarget.endsWith(".ts")) {
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
      } else if (cleanTarget.endsWith(".m4s")) {
        binaryHeaders.set("Content-Type", "video/iso.segment");
        binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
      }

      return new Response(res.body, { status: res.status, headers: binaryHeaders });

    } catch (err) {
      return new Response("Error proxy: " + err.message, { 
        status: 500, 
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" } 
      });
    }
  },
};
