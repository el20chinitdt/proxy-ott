// ============================================================================
// CLOUDFLARE WORKER: PROXY ASTRA / HLS / DASH (ESPECIAL PARA *.WORKERS.DEV)
// Sin dependencias de dominio propio. RAM Micro-Cache + Request Coalescing.
// ============================================================================

const CONFIG = {
  MANIFEST_TTL_MS: 1500,     // Duración del manifiesto en RAM (1.5 segundos)
  STALE_FALLBACK_MS: 30000,  // Cuánto tiempo aguantar con el último manifiesto si Astra cae
  UPSTREAM_TIMEOUT_MS: 6000, // Timeout para conectar al servidor
  UPSTREAM_RETRIES: 2,       // Reintentos en caso de microcorte de red
  DEFAULT_VIDEO_CODEC: 'avc1.4d401f,mp4a.40.2', // Fallback si Astra omite códecs
};

// ---------------------------------------------------------------------------
// 1. MEMORIA RAM LOCAL (Vive en el nodo de Cloudflare mientras haya tráfico)
// ---------------------------------------------------------------------------
const MEM_CACHE = new Map();         // Almacena manifiestos procesados
const IN_FLIGHT_REQUESTS = new Map(); // Colapsa peticiones idénticas a 1 sola

function getFromRam(key) {
  const item = MEM_CACHE.get(key);
  if (!item) return null;
  const age = Date.now() - item.time;
  if (age <= CONFIG.MANIFEST_TTL_MS) {
    return { data: item.data, contentType: item.contentType, isStale: false };
  }
  if (age <= CONFIG.STALE_FALLBACK_MS) {
    return { data: item.data, contentType: item.contentType, isStale: true };
  }
  MEM_CACHE.delete(key);
  return null;
}

function saveToRam(key, data, contentType) {
  // Limpieza preventiva si el mapa crece demasiado
  if (MEM_CACHE.size > 100) {
    const oldestKey = MEM_CACHE.keys().next().value;
    MEM_CACHE.delete(oldestKey);
  }
  MEM_CACHE.set(key, { data, contentType, time: Date.now() });
}

// ---------------------------------------------------------------------------
// 2. IDENTIDAD Y NAVEGADOR DINÁMICO (Para evitar bloqueos de firewalls)
// ---------------------------------------------------------------------------
function getChromeMajor(env) {
  const fromEnv = parseInt(env?.CHROME_MAJOR, 10);
  if (fromEnv > 0) return fromEnv;
  const anchorDate = Date.UTC(2024, 0, 1);
  const weeksElapsed = Math.floor((Date.now() - anchorDate) / (1000 * 60 * 60 * 24 * 7));
  return 120 + Math.floor(weeksElapsed / 4);
}

function buildChromeBrandList(major) {
  const chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
  const greaseChar1 = chars[major % chars.length];
  const greaseChar2 = chars[(major + 1) % chars.length];
  const greaseBrand = `Not${greaseChar1}A${greaseChar2}Brand`;
  const greaseVer = ["8", "99", "24"][major % 3];
  
  const orders = [
    [`"${greaseBrand}";v="${greaseVer}"`, `"Chromium";v="${major}"`, `"Google Chrome";v="${major}"`],
    [`"${greaseBrand}";v="${greaseVer}"`, `"Google Chrome";v="${major}"`, `"Chromium";v="${major}"`],
    [`"Chromium";v="${major}"`, `"${greaseBrand}";v="${greaseVer}"`, `"Google Chrome";v="${major}"`],
  ];
  return orders[major % orders.length].join(", ");
}

function buildChromeHints(ua) {
  const m = ua.match(/Chrome\/(\d+)/);
  if (!m || /Edg\/|OPR\/|Firefox\//i.test(ua)) return null;
  const major = parseInt(m[1], 10);
  
  let platform = '"Windows"';
  if (/Android/i.test(ua)) platform = '"Android"';
  else if (/Macintosh|Mac OS X/i.test(ua)) platform = '"macOS"';
  else if (/Linux/i.test(ua)) platform = '"Linux"';

  return {
    secChUa: buildChromeBrandList(major),
    mobile: /Mobile/i.test(ua) ? "?1" : "?0",
    platform,
  };
}

function encodeIdentity(id) {
  const json = JSON.stringify({ o: id.o || undefined, r: id.r || undefined, u: id.u || undefined });
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeIdentity(str) {
  try {
    let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return { o: parsed.o || null, r: parsed.r || null, u: parsed.u || null };
  } catch (_) {
    return { o: null, r: null, u: null };
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

  const isBrowser = /^Mozilla\/5\.0/i.test(finalUa);
  const effOrigin = origin || parsedTarget.origin;

  if (origin || referer || isBrowser) {
    h.set("Origin", effOrigin);
    h.set("Referer", referer || `${effOrigin}/`);
  }

  if (isBrowser && parsedTarget.protocol === "https:") {
    h.set("Sec-Fetch-Site", effOrigin === parsedTarget.origin ? "same-origin" : "cross-site");
    h.set("Sec-Fetch-Mode", "cors");
    h.set("Sec-Fetch-Dest", "empty");
    const hints = buildChromeHints(finalUa);
    if (hints) {
      h.set("sec-ch-ua", hints.secChUa);
      h.set("sec-ch-ua-mobile", hints.mobile);
      h.set("sec-ch-ua-platform", hints.platform);
    }
  }

  if (request.headers.has("range")) h.set("Range", request.headers.get("range"));
  if (request.headers.has("cookie")) h.set("Cookie", request.headers.get("cookie"));
  return h;
}

// ---------------------------------------------------------------------------
// 3. PARSEO DE MANIFIESTOS (ASTRA HLS / DASH)
// ---------------------------------------------------------------------------
function patchAstraHlsManifest(text, makeProxied) {
  let patched = text.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${makeProxied(uri)}"`);
  const lines = patched.split("\n");
  const processed = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      processed.push(line);
      continue;
    }
    if (trimmed.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
    } else if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
      if (!trimmed.includes("CODECS=")) {
        line = `${trimmed},CODECS="${CONFIG.DEFAULT_VIDEO_CODEC}"`;
      } else {
        line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
      }
    } else if (!trimmed.startsWith("#")) {
      line = makeProxied(trimmed);
    }
    processed.push(line);
  }
  return processed.join("\n");
}

function stripControlParams(url) {
  return url
    .replace(/([?&])(?:origin|referer|ua|user-agent)=[^&]*/gi, (_, sep) => (sep === "?" ? "?" : ""))
    .replace(/\?&+/, "?")
    .replace(/\?$/, "");
}

function toFetchUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    // Cloudflare no permite fetch directo a IPv4 puras si no tienen resolución de nombre
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(u.hostname)) {
      u.hostname = `${u.hostname}.sslip.io`;
      return u.href;
    }
    return urlStr;
  } catch (_) {
    return urlStr;
  }
}

async function fetchWithRetry(url, options) {
  const canRetry = options.method === "GET" || options.method === "HEAD";
  const maxRetries = canRetry ? CONFIG.UPSTREAM_RETRIES : 0;
  let lastError;

  for (let i = 0; i <= maxRetries; i++) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), CONFIG.UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timeout);
      if (res.status < 500 || i === maxRetries) return res;
      res.body?.cancel();
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      if (i === maxRetries) throw err;
    }
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// 4. HANDLER PRINCIPAL
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const reqOrigin = request.headers.get("Origin");

    const corsHeaders = {
      "Access-Control-Allow-Origin": reqOrigin || "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400", // Navegador recuerda el preflight por 24h
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
          const match = request.url.match(/[?&]url=(.+)$/);
          targetUrl = match ? match[1] : sp.get("url");
        }

        if (targetUrl) targetUrl = stripControlParams(targetUrl);
      }

      if (!targetUrl) {
        return new Response("Uso: /p/URL o ?url=URL", {
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
        targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
      }

      const parsedTarget = new URL(targetUrl);
      const cleanPath = parsedTarget.pathname.toLowerCase();
      const isManifest = /\.(m3u8|mpd)(\?|$)/i.test(cleanPath);

      // ---------------------------------------------------------------------
      // REVISIÓN DE MEMORIA RAM (Sólo para manifiestos)
      // ---------------------------------------------------------------------
      if (isManifest && request.method === "GET") {
        const ramHit = getFromRam(targetUrl);
        if (ramHit && !ramHit.isStale) {
          return new Response(ramHit.data, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": ramHit.contentType,
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "X-Proxy-Cache": "RAM-HIT",
            },
          });
        }
      }

      // ---------------------------------------------------------------------
      // REQUEST COALESCING (Evita saturar Astra si muchos piden lo mismo a la vez)
      // ---------------------------------------------------------------------
      if (isManifest && request.method === "GET" && IN_FLIGHT_REQUESTS.has(targetUrl)) {
        try {
          const pooled = await IN_FLIGHT_REQUESTS.get(targetUrl);
          return new Response(pooled.data, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": pooled.contentType,
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "X-Proxy-Cache": "POOLED-WAIT",
            },
          });
        } catch (_) {}
      }

      const upstreamHeaders = buildUpstreamHeaders({
        request,
        parsedTarget,
        ua: identity.u,
        origin: normalizeOrigin(identity.o),
        referer: identity.r,
        chromeMajor: getChromeMajor(env),
      });

      const fetchOptions = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        fetchOptions.body = request.body;
      }

      // EJECUCIÓN CON RESILIENCIA Y SINGLE-FLIGHT REGISTRADO
      let fetchPromise = fetchWithRetry(toFetchUrl(targetUrl), fetchOptions);
      if (isManifest && request.method === "GET") {
        IN_FLIGHT_REQUESTS.set(targetUrl, fetchPromise);
      }

      let res = null;
      try {
        res = await fetchPromise;
      } catch (_) {
        res = null;
      } finally {
        if (isManifest && request.method === "GET") {
          IN_FLIGHT_REQUESTS.delete(targetUrl);
        }
      }

      // STALE-FALLBACK: Si Astra dio error 5xx o timeout, pero tenemos versión previa en RAM
      if ((!res || res.status >= 500) && isManifest && request.method === "GET") {
        const ramStale = getFromRam(targetUrl);
        if (ramStale) {
          res?.body?.cancel();
          return new Response(ramStale.data, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": ramStale.contentType,
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "X-Proxy-Cache": "STALE-RAM-FALLBACK",
            },
          });
        }
      }

      if (!res) {
        return new Response("Astra o Stream no responde (Timeout o Conexión caída)", {
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
      const hasId = identity.o || identity.r || identity.u;
      const proxyPrefix = hasId
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

      // PREPARACIÓN DE CABECERAS PARA MANIFIESTOS (Elimina compresión vieja)
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

      // DETECCIÓN DE CONTENIDO
      const rawContentType = (res.headers.get("content-type") || "").toLowerCase();
      let isHls = cleanPath.endsWith(".m3u8") || rawContentType.includes("mpegurl");
      let isDash = cleanPath.endsWith(".mpd") || rawContentType.includes("dash+xml");

      let responseText = null;
      if (!isHls && !isDash && (rawContentType.includes("text") || rawContentType.includes("xml"))) {
        responseText = await res.text();
        if (responseText.includes("#EXTM3U")) isHls = true;
        else if (responseText.includes("<MPD") || responseText.includes("<mpd")) isDash = true;
      }

      // PROCESAMIENTO HLS
      if (isHls) {
        const originalText = responseText !== null ? responseText : await res.text();
        const patchedText = patchAstraHlsManifest(originalText, makeProxied);
        const cType = "application/vnd.apple.mpegurl; charset=utf-8";

        if (request.method === "GET" && res.status === 200) {
          saveToRam(targetUrl, patchedText, cType);
        }

        return new Response(patchedText, {
          status: res.status,
          headers: cleanManifestHeaders(cType),
        });
      }

      // PROCESAMIENTO DASH
      if (isDash) {
        let originalText = responseText !== null ? responseText : await res.text();
        const proxiedBase = `<BaseURL>${proxyPrefix}${baseUrl}</BaseURL>`;

        if (/<BaseURL[^>]*>/i.test(originalText)) {
          originalText = originalText.replace(
            /<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi,
            (_, uri) => `<BaseURL>${makeProxied(uri)}</BaseURL>`
          );
        } else {
          originalText = originalText.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  ${proxiedBase}`);
        }

        const cType = "application/dash+xml; charset=utf-8";
        if (request.method === "GET" && res.status === 200) {
          saveToRam(targetUrl, originalText, cType);
        }

        return new Response(originalText, {
          status: res.status,
          headers: cleanManifestHeaders(cType),
        });
      }

      // SEGMENTOS (.TS / .M4S) O STREAM CONTINUO (ZERO-BUFFERING PASS-THROUGH)
      const binaryHeaders = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders)) binaryHeaders.set(k, v);

      if (cleanPath.endsWith(".ts") || /\/play\/[^/]+\/?$/.test(cleanPath)) {
        binaryHeaders.set("Content-Type", "video/mp2t");
      } else if (cleanPath.endsWith(".m4s")) {
        binaryHeaders.set("Content-Type", "video/iso.segment");
      }

      if (typeof res.headers.getSetCookie === "function") {
        for (const cookie of res.headers.getSetCookie()) {
          binaryHeaders.append("Set-Cookie", cookie);
        }
      }

      // El body fluye directamente por tubería sin gastar RAM ni tiempo de CPU
      return new Response(res.body, {
        status: res.status,
        headers: binaryHeaders,
      });

    } catch (err) {
      return new Response("Error Proxy: " + err.message, {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
  },
};
