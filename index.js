// Genera dinámicamente una versión de Chrome vigente y sus Client Hints
function getModernChromeIdentity() {
  // Chrome 126 salió a mediados de junio 2024 (~1718150400000). Google lanza una versión cada 28 días.
  const baseTimestamp = 1718150400000;
  const cycleMs = 28 * 24 * 60 * 60 * 1000;
  const elapsedCycles = Math.max(0, Math.floor((Date.now() - baseTimestamp) / cycleMs));
  const chromeMajor = 126 + elapsedCycles;

  const ua = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;
  const secChUa = `"Not/A)Brand";v="8", "Chromium";v="${chromeMajor}", "Google Chrome";v="${chromeMajor}"`;

  return { ua, secChUa };
}

export default {
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      const reqUrl = new URL(request.url);

      // 1. PARÁMETROS MANUALES (Opcionales)
      const customOrigin = reqUrl.searchParams.get("origin");
      const customReferer = reqUrl.searchParams.get("referer");
      const customUa = reqUrl.searchParams.get("ua") || reqUrl.searchParams.get("user-agent");

      // 2. EXTRACCIÓN Y LIMPIEZA DE URL DESTINO
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

      // Eliminar parámetros de control propios de la URL final
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

      // Bypass de bloqueo de IPs directas en Cloudflare usando sslip.io
      let fetchUrl = targetUrl;
      const isDirectIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsedTarget.hostname);
      if (isDirectIp) {
        fetchUrl = targetUrl.replace(parsedTarget.hostname, `${parsedTarget.hostname}.sslip.io`);
      }

      // 3. CABECERAS UPSTREAM BLINDADAS Y AUTO-ACTUALIZABLES
      const { ua: autoUa, secChUa: autoSecChUa } = getModernChromeIdentity();
      const finalUa = customUa || autoUa;

      const upstreamHeaders = new Headers();
      upstreamHeaders.set("User-Agent", finalUa);

      // Sincronizar Client Hints
      if (finalUa.includes("Chrome")) {
        upstreamHeaders.set("sec-ch-ua", autoSecChUa);
        upstreamHeaders.set("sec-ch-ua-mobile", "?0");
        upstreamHeaders.set("sec-ch-ua-platform", '"Windows"');
      }

      // Forzar Origin y Referer exactos del destino para neutralizar bloqueos anti-hotlink
      const effectiveOrigin = customOrigin || parsedTarget.origin;
      const effectiveReferer = customReferer || (customOrigin ? `${customOrigin}/` : `${parsedTarget.origin}/`);
      upstreamHeaders.set("Origin", effectiveOrigin);
      upstreamHeaders.set("Referer", effectiveReferer);

      // Contexto de navegación de navegador legítimo
      upstreamHeaders.set("Accept", "*/*");
      upstreamHeaders.set("Accept-Language", "es-ES,es;q=0.9,en;q=0.8");
      upstreamHeaders.set("Sec-Fetch-Site", "cross-origin");
      upstreamHeaders.set("Sec-Fetch-Mode", "cors");
      upstreamHeaders.set("Sec-Fetch-Dest", "empty");

      if (request.headers.has("range")) {
        upstreamHeaders.set("Range", request.headers.get("range"));
      }

      // 4. EJECUCIÓN DEL FETCH (Soporte POST para peticiones DRM/licencias)
      const fetchOptions = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      };

      if (request.method !== "GET" && request.method !== "HEAD") {
        fetchOptions.body = request.body;
      }

      const res = await fetch(fetchUrl, fetchOptions);

      if (!res.ok && res.status !== 206) {
        const errorText = await res.text();
        return new Response(errorText, {
          status: res.status,
          headers: { ...corsHeaders, "Content-Type": "text/plain" },
        });
      }

      // 5. RESOLUCIÓN DE RUTAS CON new URL (Siempre termina en "/")
      const baseUrl = new URL("./", parsedTarget).href;
      const proxyPrefix = `${reqUrl.origin}/p/`;

      function makeProxied(pathOrUrl) {
        const trimmed = pathOrUrl.trim();
        if (!trimmed) return "";
        try {
          const full = new URL(trimmed, baseUrl).href;
          return `${proxyPrefix}${full}`;
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

      // CASO A: HLS (.m3u8)
      if (isHls) {
        let text = responseText !== null ? responseText : await res.text();
        
        // Claves DRM, mapas y sub-recursos con atributo URI="..."
        text = text.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${makeProxied(uri)}"`);
        
        // Segmentos de video y playlists secundarias
        text = text.split("\n").map(line => {
          const t = line.trim();
          if (!t || t.startsWith("#")) return line;
          return makeProxied(t);
        }).join("\n");

        return new Response(text, {
          status: res.status,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        });
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

        return new Response(text, {
          status: res.status,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/dash+xml; charset=utf-8",
            "Cache-Control": "no-cache, no-store, must-revalidate",
          },
        });
      }

      // CASO C: SEGMENTOS BINARIOS (.ts, .m4s, licencias)
      const binaryHeaders = new Headers(res.headers);
      for (const [k, v] of Object.entries(corsHeaders)) {
        binaryHeaders.set(k, v);
      }

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
