// Genera dinámicamente una versión de Chrome vigente y sus Client Hints
function getModernChromeIdentity() {
  const baseTimestamp = 1718150400000; // Chrome 126 (~junio 2024)
  const cycleMs = 28 * 24 * 60 * 60 * 1000; // Ciclo de 4 semanas
  const elapsedCycles = Math.max(0, Math.floor((Date.now() - baseTimestamp) / cycleMs));
  const chromeMajor = 126 + elapsedCycles;

  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
  const secChUa = `"Not/A)Brand";v="8", "Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}"`;

  return { ua, secChUa };
}

export default {
  async fetch(request) {
    const reqOrigin = request.headers.get("Origin");

    // CORS dinámico: si hay cookies/credenciales, no se puede usar "*"
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

      // 4. HEARTBEAT LOCAL / SONDEO
      // Permite que la app mantenga activa la sesión con un ping liviano
      if (reqUrl.pathname === "/ping" || reqUrl.pathname === "/heartbeat") {
        return new Response("OK", { status: 200, headers: corsHeaders });
      }

      // 1. EXTRACCIÓN DE PARÁMETROS
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
        return new Response("Falta el parámetro ?url=", { status: 400, headers: corsHeaders });
      }

      // Limpiar parámetros de control del proxy
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

      // Bypass de bloqueo de IPs directas en Cloudflare
      let fetchUrl = targetUrl;
      const isDirectIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsedTarget.hostname);
      if (isDirectIp) {
        fetchUrl = targetUrl.replace(parsedTarget.hostname, `${parsedTarget.hostname}.sslip.io`);
      }

      // 3. CABECERAS UPSTREAM BLINDADAS Y SIMULACIÓN DE NAVEGADOR
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

      // Forzar comportamiento no persistente en caché
      upstreamHeaders.set("Cache-Control", "no-cache");
      upstreamHeaders.set("Pragma", "no-cache");

      // PROPAGACIÓN DE COOKIES: Cliente -> Upstream
      if (request.headers.has("cookie")) {
        upstreamHeaders.set("Cookie", request.headers.get("cookie"));
      }

      if (request.headers.has("range")) {
        upstreamHeaders.set("Range", request.headers.get("range"));
      }

      // EJECUCIÓN DEL FETCH
      const fetchOptions = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        fetchOptions.body = request.body;
      }

      const res = await fetch(fetchUrl, fetchOptions);

      // Si es un sondeo HEAD, respondemos inmediatamente con las cabeceras
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
          headers: { ...corsHeaders, "Content-Type": "text/plain" },
        });
      }

      // RESOLUCIÓN DE RUTAS Y HERENCIA DE TOKENS
      const baseUrl = new URL("./", parsedTarget).href;
      const proxyPrefix = `${reqUrl.origin}/p/`;

      // Si el manifiesto principal tiene tokens en query, los guardamos para propagarlos
      const manifestSearchParams = parsedTarget.search;

      function makeProxied(pathOrUrl) {
        const trimmed = pathOrUrl.trim();
        if (!trimmed) return "";
        try {
          const resolved = new URL(trimmed, baseUrl);

          // Si el chunk no tiene query params propios pero el manifiesto sí traía tokens/firmas, se los adjuntamos
          if (!resolved.search && manifestSearchParams) {
            resolved.search = manifestSearchParams;
          }

          return `${proxyPrefix}${resolved.href}`;
        } catch (_) {
          return `${proxyPrefix}${trimmed}`;
        }
      }

      const cleanTarget = parsedTarget.pathname.toLowerCase();
      const contentType = (res.headers.get("content-type") || "").toLowerCase();

      let isHls = cleanTarget.endsWith(".m3u8") || contentType.includes("mpegurl");
      let isDash = cleanTarget.endsWith(".mpd") || contentType.includes("dash+xml");

      let responseText = null;
      if (!isHls && !isDash && (contentType.includes("xml") || contentType.includes("text") || cleanTarget.includes("manifest"))) {
        responseText = await res.text();
        if (responseText.includes("<MPD") || responseText.includes("<mpd")) {
          isDash = true;
        }
      }

      // Preparar cabeceras de respuesta y propagar Set-Cookie (Upstream -> Cliente)
      function createResponseHeaders(defaultContentType) {
        const h = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders)) {
          h.set(k, v);
        }
        if (defaultContentType) {
          h.set("Content-Type", defaultContentType);
        }

        // Propagación de Set-Cookie múltiple
        if (typeof res.headers.getSetCookie === "function") {
          const cookies = res.headers.getSetCookie();
          for (const cookie of cookies) {
            h.append("Set-Cookie", cookie);
          }
        }
        return h;
      }

      // CASO A: HLS (.m3u8)
      if (isHls) {
        let text = responseText !== null ? responseText : await res.text();

        // Claves DRM, mapas de inicialización (#EXT-X-MAP:URI="...")
        text = text.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${makeProxied(uri)}"`);

        // Segmentos de video y sub-playlists
        text = text.split("\n").map(line => {
          const t = line.trim();
          if (!t || t.startsWith("#")) return line;
          return makeProxied(t);
        }).join("\n");

        const hlsHeaders = createResponseHeaders("application/vnd.apple.mpegurl; charset=utf-8");
        hlsHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");

        return new Response(text, { status: res.status, headers: hlsHeaders });
      }

      // CASO B: DASH (.mpd)
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

      // CASO C: SEGMENTOS BINARIOS (.ts, .m4s, licencias)
      const binaryHeaders = createResponseHeaders();

      if (cleanTarget.endsWith(".ts")) {
        binaryHeaders.set("Content-Type", "video/mp2t");
      } else if (cleanTarget.endsWith(".m4s")) {
        binaryHeaders.set("Content-Type", "video/iso.segment");
      }

      return new Response(res.body, {
        status: res.status,
        headers: binaryHeaders,
      });

    } catch (err) {
      return new Response("Error al procesar: " + err.message, {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};
