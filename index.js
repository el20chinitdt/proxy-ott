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
  // Reescritura universal de URIs en etiquetas HLS (claves DRM, audios secundarios, subtítulos, mapas)
  let patched = text.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${makeProxied(uri)}"`);

  const lines = patched.split("\n");
  const processedLines = [];

  for (let line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      processedLines.push(line);
      continue;
    }

    // A) Sanear pistas de audio en #EXT-X-MEDIA
    if (trimmed.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      // Los navegadores no soportan MP2 (mp4a.69 / mp4a.6b).
      // Si el stream tiene audio MP2, normalizamos la firma a AAC para engañar al demuxer MSE
      if (/mp4a\.6[9b]/i.test(trimmed)) {
        line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
      }
    }

    // B) Corregir metadatos de códecs en master playlists (#EXT-X-STREAM-INF)
    if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
      if (!trimmed.includes("CODECS=")) {
        // Astra suele omitir el parámetro CODECS, lo que rompe hls.js en navegadores.
        // Forzamos AVC (H.264) High Profile + AAC estéreo estándar:
        line = `${trimmed},CODECS="avc1.4d401f,mp4a.40.2"`;
      } else {
        // Si Astra declara codecs MP2 explícitos, los reemplazamos por AAC
        line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
      }
    }

    // C) Segmentos binarios (.ts) o sub-playlists
    if (!trimmed.startsWith("#")) {
      line = makeProxied(trimmed);
    }

    processedLines.push(line);
  }

  return processedLines.join("\n");
}

export default {
  async fetch(request) {
    const reqOrigin = request.headers.get("Origin");

    // Cabeceras CORS universales con soporte de credenciales
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

      // Heartbeat para mantener vivos los reproductores o sockets
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

      // Limpiar query params de configuración propios del proxy
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
        targetUrl = "https://" + targetUrl;
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

      // 4. FETCH AL ORIGEN
      const fetchOptions = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        fetchOptions.body = request.body;
      }

      const res = await fetch(fetchUrl, fetchOptions);

      // Respuesta directa a peticiones HEAD
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
          // Si el chunk no tiene query params pero el stream original requiere token en query (?token=...), se lo adjuntamos
          if (!resolved.search && manifestSearchParams) {
            resolved.search = manifestSearchParams;
          }
          return `${proxyPrefix}${resolved.href}`;
        } catch (_) {
          return `${proxyPrefix}${trimmed}`;
        }
      }

      // 6. DETECCIÓN DE TIPOS DE CONTENIDO
      const cleanTarget = parsedTarget.pathname.toLowerCase();
      const rawContentType = (res.headers.get("content-type") || "").toLowerCase();

      let isHls = cleanTarget.endsWith(".m3u8") || rawContentType.includes("mpegurl");
      let isDash = cleanTarget.endsWith(".mpd") || rawContentType.includes("dash+xml");

      let responseText = null;
      // Detección heurística en caso de que Astra o el servidor omitan el Content-Type
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

        // Aplicamos el parche de códecs y URLs para Astra
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

      // Si la URL termina en .ts o es un endpoint directo de Astra (ej. /play/a001 o /canal)
      const isAstraDirectTs = rawContentType.includes("mp2t") || 
                              rawContentType.includes("octet-stream") || 
                              cleanTarget.endsWith(".ts") ||
                              cleanTarget.includes("/play/");

      if (isAstraDirectTs) {
        binaryHeaders.set("Content-Type", "video/mp2t");
        // Los flujos continuos en vivo no deben cachearse ni declarar soporte de rango
        binaryHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      } else if (cleanTarget.endsWith(".m4s")) {
        binaryHeaders.set("Content-Type", "video/iso.segment");
      }

      // Retorno en modo streaming (pipe directo sin acumular en memoria)
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
