// ============================================================================
// CLOUDFLARE WORKER: CORS PROXY + ADAPTADOR PARA CESBO ASTRA & HLS/DASH
// Versión con caché mejorada y tolerancia a fallos del origen
// ============================================================================

// ---------------------------------------------------------------------------
// CONFIGURACIÓN DE CACHÉ / RESILIENCIA (ajusta a la duración de tus segmentos)
// ---------------------------------------------------------------------------
const SEGMENT_TTL_S = 60;       // vida de un segmento en el edge (debe ser > ventana del playlist)
const MANIFEST_TTL_S = 1;       // micro-caché del manifiesto live (≤ 1/2 duración de segmento)
const STALE_MAX_MS = 30000;     // cuánto tiempo servir el último manifiesto bueno si el origen cae
const UPSTREAM_TIMEOUT_MS = 6000; // ms máximos para recibir cabeceras del origen
const UPSTREAM_RETRIES = 2;     // reintentos ante 5xx / timeout / (404 en segmentos)
const PREFETCH_COUNT = 2;       // últimos N segmentos del manifiesto que se precalientan (0 = off)

// 1. Identidad de navegador COHERENTE (UA + Client Hints + Sec-Fetch-*)

// Versión mayor de Chrome. Lo correcto es fijarla con la variable CHROME_MAJOR del Worker
// (consulta chromereleases.googleblog.com). Si no existe, se estima desde Chrome 149
// (estable ~2 jun 2026) con ciclos de 4 semanas y 1 versión de margen.
function currentChromeMajor(env) {
  const fromEnv = parseInt(env && env.CHROME_MAJOR, 10);
  if (fromEnv > 0) return fromEnv;
  const anchor = Date.UTC(2026, 5, 2);
  const cycles = Math.max(0, Math.floor((Date.now() - anchor) / (28 * 24 * 60 * 60 * 1000)));
  return 149 + Math.max(0, cycles - 1);
}

// Algoritmo de Chromium para sec-ch-ua: la marca "GREASE", su versión y el ORDEN de
// las tres marcas cambian con la versión mayor (no es un texto fijo).
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

// Client Hints derivados del UA que realmente se envía (null si no es Chrome "puro")
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

// La identidad (origin/referer/ua) viaja en la RUTA de las URLs reescritas: /i/<id>/<url>.
// En la query se perdía: al resolver URLs relativas (p. ej. DASH BaseURL) la query se descarta.
function encodeIdentity(id) {
  const json = JSON.stringify({ o: id.o || undefined, r: id.r || undefined, u: id.u || undefined });
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
    return { o: o.o || null, r: o.r || null, u: o.u || null };
  } catch (_) {
    return { o: null, r: null, u: null };
  }
}

// Un navegador envía como Origin solo esquema+host+puerto (sin ruta ni "/" final)
function normalizeOrigin(value) {
  if (!value) return null;
  try { return new URL(value).origin; } catch (_) { return value; }
}

// Cabeceras upstream: cada una existe solo si un cliente real con ese UA la enviaría.
function buildUpstreamHeaders({ request, parsedTarget, ua, origin, referer, chromeMajor }) {
  const finalUa = ua ||
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;

  const h = new Headers();
  h.set("User-Agent", finalUa);
  h.set("Accept", "*/*");

  const isBrowser = /^Mozilla\/5\.0/.test(finalUa);

  // Navegador: Origin/Referer por defecto = el propio destino. Reproductor (VLC, ExoPlayer,
  // Lavf...): no manda Origin ni Referer, salvo que se pidan explícitamente.
  if (origin || referer || isBrowser) {
    const effOrigin = origin || parsedTarget.origin;
    h.set("Origin", effOrigin);
    h.set("Referer", referer || `${effOrigin}/`);
  }

  if (isBrowser) {
    h.set("Accept-Language", "es-ES,es;q=0.9,en;q=0.8");

    // Chrome solo manda Sec-Fetch-* y Client Hints a destinos HTTPS. Con http://IP:puerto
    // (típico de Astra) enviarlos delata que la petición no viene de un navegador real.
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
  let patched = text.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${makeProxied(uri)}"`);

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

// ---------------------------------------------------------------------------
// 3. Utilidades de caché y resiliencia
// ---------------------------------------------------------------------------

// Quita origin/referer/ua/user-agent de la URL destino (con o sin "?" / "&" delante)
// para que la clave de caché sea idéntica pidan lo que pidan los clientes.
function stripControlParams(url) {
  return url
    .replace(/([?&])(?:origin|referer|ua|user-agent)=[^&]*/gi, (_, sep) => (sep === "?" ? "?" : ""))
    .replace(/\?&+/, "?")
    .replace(/\?$/, "");
}

// Stream MPEG-TS continuo de Astra: UNA sola componente tras /play/ (ej. /play/a001).
// Los segmentos HLS (/play/a001/123.ts) y los manifiestos NO entran aquí.
function isContinuousTs(path) {
  return /\/play\/[^/]+\/?$/.test(path);
}

function classify(path) {
  if (path.endsWith(".m3u8") || path.endsWith(".mpd")) return "manifest";
  if (isContinuousTs(path)) return "stream";
  if (path.endsWith(".ts") || path.endsWith(".m4s") || path.endsWith(".aac")) return "segment";
  return "other";
}

// Opciones de caché del edge de Cloudflare según el tipo de recurso
function cfOptions(kind) {
  if (kind === "segment") {
    return {
      cacheEverything: true,
      // Los segmentos son inmutables. 404/5xx NO se cachean (en live un 404 suele
      // significar "aún no existe" y debe poder reintentarse al instante).
      cacheTtlByStatus: { "200-299": SEGMENT_TTL_S, "404": -1, "500-599": -1 },
    };
  }
  if (kind === "manifest") {
    // Micro-caché: N espectadores -> 1 petición/seg al origen por datacenter.
    return {
      cacheEverything: true,
      cacheTtlByStatus: { "200-299": MANIFEST_TTL_S, "404": -1, "500-599": -1 },
    };
  }
  return { cacheEverything: false };
}

// IP directa -> wildcard DNS (Cloudflare bloquea fetch a IPs)
function toFetchUrl(urlStr) {
  const host = new URL(urlStr).hostname;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ? urlStr.replace(host, `${host}.sslip.io`) : urlStr;
}

// fetch con timeout (solo hasta recibir cabeceras) y reintentos con backoff
async function fetchWithRetry(url, options, { retry404 = false } = {}) {
  const canRetry = options.method === "GET" || options.method === "HEAD";
  const max = canRetry ? UPSTREAM_RETRIES : 0;
  let lastErr;

  for (let i = 0; i <= max; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: ctrl.signal });
      clearTimeout(timer); // el cuerpo ya puede fluir sin que el timeout lo corte
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

export default {
  async fetch(request, env, ctx) {
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

      if (reqUrl.pathname === "/ping" || reqUrl.pathname === "/heartbeat") {
        return new Response("OK", { status: 200, headers: corsHeaders });
      }

      // 1+2. IDENTIDAD (origin/referer/ua) Y URL DESTINO
      // Entradas aceptadas:
      //   /i/<identidad>/<url>              (las generan los manifiestos reescritos)
      //   /p/<url>?origin=&referer=&ua=
      //   /?url=<url>&origin=&referer=&ua=
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
          // Corrección de barras duplicadas o reducidas
          targetUrl = targetUrl.replace(/^(https?):\/+([^\/])/i, "$1://$2");
        } else {
          const rawUrl = request.url;
          const urlMatches = rawUrl.match(/[?&]url=(.+)$/);
          targetUrl = urlMatches ? urlMatches[1] : sp.get("url");
        }
        // Los parámetros de control no deben llegar al origen ni a la clave de caché
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

      // 3. CABECERAS UPSTREAM (coherentes con el UA; sin Host: Cloudflare no permite
      //    fijar un Host distinto al del destino, así que esa línea no hacía nada)
      const upstreamHeaders = buildUpstreamHeaders({
        request,
        parsedTarget,
        ua: customUa,
        origin: customOrigin,
        referer: customReferer,
        chromeMajor: currentChromeMajor(env),
      });

      // 4. FETCH AL ORIGEN (CACHÉ POR TIPO + REINTENTOS + STALE-IF-ERROR)
      const cleanTarget = parsedTarget.pathname.toLowerCase();
      const kind = classify(cleanTarget);

      // Clave sintética donde guardamos el "último manifiesto bueno" (Cache API).
      // OJO: la Cache API no funciona en *.workers.dev; necesita dominio propio/ruta.
      const staleKey = new Request(`https://stale.proxy.internal/${encodeURIComponent(fetchUrl)}`);

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
        res = await fetchWithRetry(fetchUrl, fetchOptions, { retry404: kind === "segment" });
      } catch (_) {
        res = null; // timeout / error de red tras agotar reintentos
      }

      // Origen caído: servimos el último manifiesto bueno (si es reciente) para que
      // el reproductor siga consumiendo su buffer mientras el origen se recupera.
      if ((!res || res.status >= 500) && request.method === "GET") {
        const stale = await caches.default.match(staleKey);
        if (stale) {
          const age = Date.now() - Number(stale.headers.get("X-Cached-At") || 0);
          if (age < STALE_MAX_MS) {
            res?.body?.cancel();
            const h = new Headers(stale.headers);
            for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
            h.set("Cache-Control", "no-cache, no-store, must-revalidate");
            h.set("X-Proxy-Cache", "STALE");
            return new Response(stale.body, { status: 200, headers: h });
          }
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

      // 5. HELPERS PARA RECONSTRUIR URLs RELATIVAS A TRAVÉS DEL PROXY
      const baseUrl = new URL("./", parsedTarget).href;
      const hasIdentity = customOrigin || customReferer || customUa;
      const proxyPrefix = hasIdentity
        ? `${reqUrl.origin}/i/${encodeIdentity({ o: customOrigin, r: customReferer, u: customUa })}/`
        : `${reqUrl.origin}/p/`;
      const manifestSearchParams = parsedTarget.search;

      // URL real (upstream) de una línea/URI del manifiesto
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
          return `${proxyPrefix}${resolved.href}`;
        } catch (_) {
          return `${proxyPrefix}${trimmed}`;
        }
      }

      // Guarda el último manifiesto bueno (ya reescrito) para el fallback stale-if-error
      function rememberManifest(text, contentType) {
        ctx.waitUntil(
          caches.default
            .put(
              staleKey,
              new Response(text, {
                headers: {
                  "Content-Type": contentType,
                  "Cache-Control": "public, max-age=120",
                  "X-Cached-At": String(Date.now()),
                },
              })
            )
            .catch(() => {})
        );
      }

      // Precalienta en el edge los últimos segmentos del manifiesto, de modo que
      // incluso el primer espectador los reciba desde caché.
      function prefetchSegments(manifestText) {
        if (!PREFETCH_COUNT) return;
        const uris = manifestText
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#") && !/\.(m3u8|mpd)(\?|$)/i.test(l))
          .slice(-PREFETCH_COUNT);

        const prefetchHeaders = new Headers(upstreamHeaders);
        prefetchHeaders.delete("range");

        for (const uri of uris) {
          try {
            const target = resolveUpstream(uri).href;
            ctx.waitUntil(
              fetch(toFetchUrl(target), {
                headers: prefetchHeaders,
                redirect: "follow",
                cf: cfOptions("segment"),
              })
                // Hay que CONSUMIR el cuerpo para que el edge complete el guardado en caché
                .then((r) => (r.ok ? r.arrayBuffer() : r.body?.cancel()))
                .catch(() => {})
            );
          } catch (_) {}
        }
      }

      // 6. DETECCIÓN DE CONTENIDO
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

      function createResponseHeaders(defaultContentType) {
        const h = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders)) {
          h.set(k, v);
        }
        if (defaultContentType) {
          h.set("Content-Type", defaultContentType);
        }
        if (typeof res.headers.getSetCookie === "function") {
          const cookies = res.headers.getSetCookie();
          for (const cookie of cookies) {
            h.append("Set-Cookie", cookie);
          }
        }
        return h;
      }

      // CASO A: HLS (.m3u8) CON ADAPTADOR CESBO ASTRA
      if (isHls) {
        const original = responseText !== null ? responseText : await res.text();
        const text = patchAstraHlsManifest(original, makeProxied);

        if (request.method === "GET" && res.status === 200) {
          rememberManifest(text, "application/vnd.apple.mpegurl; charset=utf-8");
          // Solo precalentamos cuando el manifiesto es nuevo (no un HIT de la micro-caché)
          if (res.headers.get("cf-cache-status") !== "HIT") prefetchSegments(original);
        }

        const hlsHeaders = createResponseHeaders("application/vnd.apple.mpegurl; charset=utf-8");
        hlsHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");

        return new Response(text, { status: res.status, headers: hlsHeaders });
      }

      // CASO B: MPEG-DASH (.mpd)
      if (isDash) {
        let text = responseText !== null ? responseText : await res.text();
        const proxiedBase = `<BaseURL>${proxyPrefix}${baseUrl}</BaseURL>`;

        if (/<BaseURL[^>]*>/i.test(text)) {
          text = text.replace(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi, (m, p1) => `<BaseURL>${makeProxied(p1)}</BaseURL>`);
        } else {
          text = text.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  ${proxiedBase}`);
        }

        if (request.method === "GET" && res.status === 200) {
          rememberManifest(text, "application/dash+xml; charset=utf-8");
        }

        const dashHeaders = createResponseHeaders("application/dash+xml; charset=utf-8");
        dashHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");

        return new Response(text, { status: res.status, headers: dashHeaders });
      }

      // CASO C: SEGMENTOS BINARIOS (.ts, .m4s) O STREAM CONTINUO MPEG-TS DIRECTO DE ASTRA
      const binaryHeaders = createResponseHeaders();

      const cacheStatus = res.headers.get("cf-cache-status");
      if (cacheStatus) binaryHeaders.set("X-Proxy-Cache", cacheStatus);

      if (kind === "stream") {
        // Stream continuo: jamás cacheable
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      } else if (cleanTarget.endsWith(".ts")) {
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
      } else if (cleanTarget.endsWith(".m4s")) {
        binaryHeaders.set("Content-Type", "video/iso.segment");
        binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
      } else if (rawContentType.includes("mp2t") || rawContentType.includes("octet-stream")) {
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
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
