// ============================================================================
// VERCEL FUNCTION: CORS PROXY + ADAPTADOR PARA CESBO ASTRA & HLS/DASH
// Sin dependencias externas - listo para deploy directo desde GitHub
// ============================================================================

const SEGMENT_TTL_S = 60;
const MANIFEST_TTL_S = 1;
const STALE_MAX_MS = 30000;
const STALE_MAX_S = Math.floor(STALE_MAX_MS / 1000);
const UPSTREAM_TIMEOUT_MS = 6000;
const UPSTREAM_RETRIES = 2;
const PREFETCH_COUNT = 0; // En Vercel conviene en 0 (si lo activas consume invocaciones extra)
const USE_SSLIP_IO = process.env.USE_SSLIP_IO === "1";

const staleManifestCache = new Map();
const STALE_CACHE_MAX_ENTRIES = 200;

function runInBackground(promise) {
  const ctx = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(promise);
  }
}

// 1. Identidad de navegador COHERENTE (UA + Client Hints + Sec-Fetch-*)
function currentChromeMajor() {
  const fromEnv = parseInt(process.env.CHROME_MAJOR || "", 10);
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

function encodeIdentity(id) {
  const json = JSON.stringify({ o: id.o || undefined, r: id.r || undefined, u: id.u || undefined });
  return Buffer.from(json, "utf8").toString("base64url");
}

function decodeIdentity(str) {
  try {
    const json = Buffer.from(str, "base64url").toString("utf8");
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

  if (request.headers.has("cookie")) h.set("Cookie", request.headers.get("cookie"));
  if (request.headers.has("range")) h.set("Range", request.headers.get("range"));
  return h;
}

// 2. Adaptador y saneador de manifiestos HLS emitidos por Cesbo Astra
function patchAstraHlsManifest(text, makeProxied) {
  const patched = text.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${makeProxied(uri)}"`);

  const lines = patched.split("\n");
  const processedLines = [];

  for (let line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      processedLines.push(line);
      continue;
    }

    if (trimmed.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      if (/mp4a\.6[9b]/i.test(trimmed)) {
        line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
      }
    }

    if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
      if (!trimmed.includes("CODECS=")) {
        line = `${trimmed},CODECS="avc1.4d401f,mp4a.40.2"`;
      } else {
        line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
      }
    }

    if (!trimmed.startsWith("#")) {
      line = makeProxied(trimmed);
    }

    processedLines.push(line);
  }

  return processedLines.join("\n");
}

// 3. Utilidades de caché y resiliencia
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

function toFetchUrl(urlStr) {
  if (!USE_SSLIP_IO) return urlStr;
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
      res.body?.cancel().catch(() => {});
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (i === max) throw err;
    }
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  throw lastErr;
}

export default {
  async fetch(request) {
    const reqOrigin = request.headers.get("Origin");

    const corsHeaders = {
      "Access-Control-Allow-Origin": reqOrigin || "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date, Set-Cookie, X-Proxy-Cache",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const reqUrl = new URL(request.url);
      let cleanRawUrl = request.url;

      if (reqUrl.pathname === "/api/proxy" && reqUrl.searchParams.has("__vpath")) {
        const originalPath = reqUrl.searchParams.get("__vpath") || "/";
        reqUrl.searchParams.delete("__vpath");
        reqUrl.pathname = originalPath.startsWith("/") ? originalPath : `/${originalPath}`;
        cleanRawUrl = request.url.replace(/([?&])__vpath=[^&]*(&|$)/, (_, sep, end) =>
          end === "&" ? sep : ""
        );
      }

      if (reqUrl.pathname === "/ping" || reqUrl.pathname === "/heartbeat") {
        return new Response("OK", { status: 200, headers: corsHeaders });
      }

      let identity;
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
          const urlMatches = cleanRawUrl.match(/[?&]url=(.+)$/);
          targetUrl = urlMatches ? urlMatches[1] : sp.get("url");
        }
        if (targetUrl) targetUrl = stripControlParams(targetUrl);
      }

      if (!targetUrl) {
        return new Response("Falta el parámetro ?url= o la ruta /p/URL", {
          status: 400,
          headers: corsHeaders,
        });
      }

      const customOrigin = normalizeOrigin(identity.o);
      const customReferer = identity.r || null;
      const customUa = identity.u || null;

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
        ua: customUa,
        origin: customOrigin,
        referer: customReferer,
        chromeMajor: currentChromeMajor(),
      });

      const cleanTarget = parsedTarget.pathname.toLowerCase();
      const kind = classify(cleanTarget);

      const fetchOptions = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      };

      if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
        fetchOptions.body = request.body;
        fetchOptions.duplex = "half";
      }

      let res = null;
      try {
        res = await fetchWithRetry(fetchUrl, fetchOptions, { retry404: kind === "segment" });
      } catch (_) {
        res = null;
      }

      if ((!res || res.status >= 500) && request.method === "GET") {
        const stale = staleManifestCache.get(fetchUrl);
        if (stale && Date.now() - stale.cachedAt < STALE_MAX_MS) {
          res?.body?.cancel().catch(() => {});
          return new Response(stale.body, {
            status: 200,
            headers: {
              ...corsHeaders,
              "Content-Type": stale.contentType,
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "Vercel-CDN-Cache-Control": "no-store",
              "X-Proxy-Cache": "STALE",
            },
          });
        }
      }

      if (!res) {
        return new Response("Origen no disponible", {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      if (request.method === "HEAD") {
        const headHeaders = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders)) {
          headHeaders.set(k, v);
        }
        return new Response(null, { status: res.status, headers: headHeaders });
      }

      if (!res.ok && res.status !== 206) {
        const errorText = await res.text();
        return new Response(errorText, {
          status: res.status,
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      const baseUrl = new URL("./", parsedTarget).href;
      const hasIdentity = customOrigin || customReferer || customUa;
      const proxyPrefix = hasIdentity
        ? `${reqUrl.origin}/i/${encodeIdentity({ o: customOrigin, r: customReferer, u: customUa })}/`
        : `${reqUrl.origin}/p/`;
      const manifestSearchParams = parsedTarget.search;

      function resolveUpstream(pathOrUrl) {
        const resolved = new URL(pathOrUrl.trim(), baseUrl);
        if (!resolved.search && manifestSearchParams) {
          resolved.search = manifestSearchParams;
        }
        return resolved;
      }

      function makeProxied(pathOrUrl) {
        const trimmed = pathOrUrl.trim();
        if (!trimmed) return "";
        try {
          const resolved = resolveUpstream(trimmed);
          const safePath = resolved.href.replace(/^(https?):\/\//i, "$1:/");
          return `${proxyPrefix}${safePath}`;
        } catch (_) {
          return `${proxyPrefix}${trimmed}`;
        }
      }

      function rememberManifest(text, contentType) {
        if (staleManifestCache.size >= STALE_CACHE_MAX_ENTRIES) {
          const oldestKey = staleManifestCache.keys().next().value;
          staleManifestCache.delete(oldestKey);
        }
        staleManifestCache.set(fetchUrl, {
          body: text,
          contentType,
          cachedAt: Date.now(),
        });
      }

      function prefetchSegments(manifestText) {
        if (!PREFETCH_COUNT || request.headers.get("x-proxy-prefetch")) return;
        const uris = manifestText
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#") && !/\.(m3u8|mpd)(\?|$)/i.test(l))
          .slice(-PREFETCH_COUNT);

        for (const uri of uris) {
          try {
            const proxied = makeProxied(uri);
            runInBackground(
              fetch(proxied, {
                headers: {
                  "x-proxy-prefetch": "1",
                  ...(reqOrigin ? { Origin: reqOrigin } : {}),
                },
              })
                .then((r) => r.body?.cancel().catch(() => {}))
                .catch(() => {})
            );
          } catch (_) {}
        }
      }

      const rawContentType = (res.headers.get("content-type") || "").toLowerCase();

      let isHls = cleanTarget.endsWith(".m3u8") || rawContentType.includes("mpegurl");
      let isDash = cleanTarget.endsWith(".mpd") || rawContentType.includes("dash+xml");

      let responseText = null;
      if (!isHls && !isDash && (rawContentType.includes("xml") || rawContentType.includes("text") || cleanTarget.includes("manifest"))) {
        responseText = await res.text();
        if (responseText.includes("#EXTM3U")) {
          isHls = true;
        } else if (responseText.includes("<MPD") || responseText.includes("<mpd")) {
          isDash = true;
        }
      }

      function createResponseHeaders(defaultContentType, { allowCookies = false, stripEncoding = false } = {}) {
        const h = new Headers(res.headers);
        if (!allowCookies) {
          h.delete("set-cookie");
        } else if (typeof res.headers.getSetCookie === "function") {
          h.delete("set-cookie");
          for (const cookie of res.headers.getSetCookie()) {
            h.append("Set-Cookie", cookie);
          }
        }

        if (stripEncoding || h.has("content-encoding")) {
          h.delete("content-encoding");
          h.delete("content-length");
        }

        for (const [k, v] of Object.entries(corsHeaders)) {
          h.set(k, v);
        }
        if (defaultContentType) {
          h.set("Content-Type", defaultContentType);
        }
        return h;
      }

      if (isHls) {
        const original = responseText !== null ? responseText : await res.text();
        const text = patchAstraHlsManifest(original, makeProxied);

        if (request.method === "GET" && res.status === 200) {
          rememberManifest(text, "application/vnd.apple.mpegurl; charset=utf-8");
          prefetchSegments(original);
        }

        const hlsHeaders = createResponseHeaders("application/vnd.apple.mpegurl; charset=utf-8", {
          allowCookies: false,
          stripEncoding: true,
        });
        hlsHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        if (request.method === "GET" && res.status === 200) {
          const cdnPolicy = `public, s-maxage=${MANIFEST_TTL_S}, stale-while-revalidate=2, stale-if-error=${STALE_MAX_S}`;
          hlsHeaders.set("Vercel-CDN-Cache-Control", cdnPolicy);
          hlsHeaders.set("CDN-Cache-Control", cdnPolicy);
        }

        return new Response(text, { status: res.status, headers: hlsHeaders });
      }

      if (isDash) {
        let text = responseText !== null ? responseText : await res.text();
        const safeBase = baseUrl.replace(/^(https?):\/\//i, "$1:/");
        const proxiedBase = `<BaseURL>${proxyPrefix}${safeBase}</BaseURL>`;

        if (/<BaseURL[^>]*>/i.test(text)) {
          text = text.replace(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi, (m, p1) => `<BaseURL>${makeProxied(p1)}</BaseURL>`);
        } else {
          text = text.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  ${proxiedBase}`);
        }

        if (request.method === "GET" && res.status === 200) {
          rememberManifest(text, "application/dash+xml; charset=utf-8");
        }

        const dashHeaders = createResponseHeaders("application/dash+xml; charset=utf-8", {
          allowCookies: false,
          stripEncoding: true,
        });
        dashHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        if (request.method === "GET" && res.status === 200) {
          const cdnPolicy = `public, s-maxage=${MANIFEST_TTL_S}, stale-while-revalidate=2, stale-if-error=${STALE_MAX_S}`;
          dashHeaders.set("Vercel-CDN-Cache-Control", cdnPolicy);
          dashHeaders.set("CDN-Cache-Control", cdnPolicy);
        }

        return new Response(text, { status: res.status, headers: dashHeaders });
      }

      const allowCookies = kind === "other";
      const binaryHeaders = createResponseHeaders(null, { allowCookies });

      if (kind === "stream") {
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        binaryHeaders.set("Vercel-CDN-Cache-Control", "no-store");
      } else if (kind === "segment") {
        if (cleanTarget.endsWith(".ts")) binaryHeaders.set("Content-Type", "video/mp2t");
        else if (cleanTarget.endsWith(".m4s")) binaryHeaders.set("Content-Type", "video/iso.segment");

        if (request.method === "GET" && res.status === 200) {
          binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
          binaryHeaders.set("Vercel-CDN-Cache-Control", `public, s-maxage=${SEGMENT_TTL_S}, stale-if-error=${STALE_MAX_S}`);
          binaryHeaders.set("CDN-Cache-Control", `public, s-maxage=${SEGMENT_TTL_S}`);
        }
      } else if (rawContentType.includes("mp2t") || rawContentType.includes("octet-stream")) {
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        binaryHeaders.set("Vercel-CDN-Cache-Control", "no-store");
      }

      return new Response(res.body, {
        status: res.status,
        headers: binaryHeaders,
      });

    } catch (err) {
      return new Response("Error al procesar stream: " + err.message, {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};
