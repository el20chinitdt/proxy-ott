// ============================================================================
// CLOUDFLARE WORKER: CORS PROXY + ADAPTADOR PARA CESBO ASTRA & HLS/DASH
// ============================================================================

// 1. Generador dinámico de identidad Chrome y Client Hints
function getModernChromeIdentity() {
  const baseTimestamp = 1718150400000; // Chrome 126 (~junio 2024)
  const cycleMs = 28 * 24 * 60 * 60 * 1000; // Ciclo de 4 semanas por versión
  const elapsedCycles = Math.max(0, Math.floor((Date.now() - baseTimestamp) / cycleMs));
  const chromeMajor = 126 + elapsedCycles;

  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
  const secChUa = `"Not/A)Brand";v="8", "Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}"`;

  return { ua, secChUa };
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

export default {
  async fetch(request, env, ctx) {
    const reqOrigin = request.headers.get("Origin");

    const corsHeaders = {
      "Access-Control-Allow-Origin": reqOrigin || "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date, Set-Cookie",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const reqUrl = new URL(request.url);

      if (reqUrl.pathname === "/ping" || reqUrl.pathname === "/heartbeat") {
        return new Response("OK", { status: 200, headers: corsHeaders });
      }

      // 1. EXTRACCIÓN DE PARÁMETROS DE CONTROL
      const customOrigin = reqUrl.searchParams.get("origin");
      const customReferer = reqUrl.searchParams.get("referer");
      const customUa = reqUrl.searchParams.get("ua") || reqUrl.searchParams.get("user-agent");

      // 2. EXTRACCIÓN DE URL DESTINO
      let targetUrl = "";
      if (reqUrl.pathname.startsWith("/p/")) {
        targetUrl = reqUrl.pathname.substring(3) + reqUrl.search;
        // Corrección de barras duplicadas o reducidas
        targetUrl = targetUrl.replace(/^(https?):\/+([^\/])/i, "$1://$2");
      } else {
        const rawUrl = request.url;
        const urlMatches = rawUrl.match(/[?&]url=(.+)$/);
        targetUrl = urlMatches ? urlMatches[1] : reqUrl.searchParams.get("url");
      }

      if (!targetUrl) {
        return new Response("Falta el parámetro ?url= o la ruta /p/URL", {
          status: 400,
          headers: corsHeaders,
        });
      }

      targetUrl = targetUrl
        .replace(/&origin=[^&]+/, "")
        .replace(/&referer=[^&]+/, "")
        .replace(/&(?:ua|user-agent)=[^&]+/, "");

      try {
        if (targetUrl.includes("%3A") || targetUrl.includes("%2F")) {
          targetUrl = decodeURIComponent(targetUrl);
        }
      } catch (_) {}

      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
      }

      const parsedTarget = new URL(targetUrl);

      // Bypass de bloqueo de IPs directas de Cloudflare utilizando wildcard DNS
      let fetchUrl = targetUrl;
      const isDirectIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsedTarget.hostname);
      if (isDirectIp) {
        fetchUrl = targetUrl.replace(parsedTarget.hostname, `${parsedTarget.hostname}.sslip.io`);
      }

      // 3. CABECERAS UPSTREAM BLINDADAS
      const { ua: autoUa, secChUa: autoSecChUa } = getModernChromeIdentity();
      const finalUa = customUa || autoUa;

      const upstreamHeaders = new Headers();
      upstreamHeaders.set("Host", parsedTarget.host);
      upstreamHeaders.set("User-Agent", finalUa);

      if (finalUa.includes("Chrome")) {
        upstreamHeaders.set("sec-ch-ua", autoSecChUa);
        upstreamHeaders.set("sec-ch-ua-mobile", "?0");
        upstreamHeaders.set("sec-ch-ua-platform", '"Windows"');
      }

      const effectiveOrigin = customOrigin || parsedTarget.origin;
      const effectiveReferer = customReferer || (customOrigin ? `${customOrigin}/` : `${parsedTarget.origin}/`);
      upstreamHeaders.set("Origin", effectiveOrigin);
      upstreamHeaders.set("Referer", effectiveReferer);

      upstreamHeaders.set("Accept", "*/*");
      upstreamHeaders.set("Accept-Language", "es-ES,es;q=0.9,en;q=0.8");
      upstreamHeaders.set("Sec-Fetch-Site", "cross-origin");
      upstreamHeaders.set("Sec-Fetch-Mode", "cors");
      upstreamHeaders.set("Sec-Fetch-Dest", "empty");

      upstreamHeaders.set("Cache-Control", "no-cache");
      upstreamHeaders.set("Pragma", "no-cache");

      if (request.headers.has("cookie")) {
        upstreamHeaders.set("Cookie", request.headers.get("cookie"));
      }

      if (request.headers.has("range")) {
        upstreamHeaders.set("Range", request.headers.get("range"));
      }

      // 4. FETCH AL ORIGEN (CON CACHÉ INTELIGENTE)
      const cleanTarget = parsedTarget.pathname.toLowerCase();
      const isSegment = cleanTarget.endsWith(".m4s") || (cleanTarget.endsWith(".ts") && !cleanTarget.includes("/play/"));

      const fetchOptions = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
        cf: isSegment ? {
          cacheEverything: true,
          cacheTtlByStatus: { "200-299": 15, "404": 1, "500-599": 0 }
        } : {
          cacheEverything: false
        }
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        fetchOptions.body = request.body;
      }

      const res = await fetch(fetchUrl, fetchOptions);

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

      // 5. HELPER PARA RECONSTRUIR URLs RELATIVAS A TRAVÉS DEL PROXY
      const baseUrl = new URL("./", parsedTarget).href;
      const proxyPrefix = `${reqUrl.origin}/p/`;
      const manifestSearchParams = parsedTarget.search;

      function makeProxied(pathOrUrl) {
        const trimmed = pathOrUrl.trim();
        if (!trimmed) return "";
        try {
          const resolved = new URL(trimmed, baseUrl);
          if (!resolved.search && manifestSearchParams) {
            resolved.search = manifestSearchParams;
          }
          return `${proxyPrefix}${resolved.href}`;
        } catch (_) {
          return `${proxyPrefix}${trimmed}`;
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
        let text = responseText !== null ? responseText : await res.text();
        text = patchAstraHlsManifest(text, makeProxied);

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

        const dashHeaders = createResponseHeaders("application/dash+xml; charset=utf-8");
        dashHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");

        return new Response(text, { status: res.status, headers: dashHeaders });
      }

      // CASO C: SEGMENTOS BINARIOS (.ts, .m4s) O STREAM CONTINUO MPEG-TS DIRECTO DE ASTRA
      const binaryHeaders = createResponseHeaders();

      const isAstraDirectTs = rawContentType.includes("mp2t") || 
                              rawContentType.includes("octet-stream") || 
                              cleanTarget.endsWith(".ts") ||
                              cleanTarget.includes("/play/");

      if (isAstraDirectTs) {
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      } else if (cleanTarget.endsWith(".m4s")) {
        binaryHeaders.set("Content-Type", "video/iso.segment");
        binaryHeaders.set("Cache-Control", "public, max-age=15");
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
