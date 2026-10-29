export default async (req, context) => {
  // 1. Manejo de peticiones de validación CORS (Preflight)
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // 2. Extraer y validar la URL del video
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("url");

  if (!targetUrl) {
    return new Response("Falta el parámetro ?url=", { status: 400, headers: corsHeaders });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response("La URL solicitada es inválida", { status: 400, headers: corsHeaders });
  }

  // 3. Cabeceras para simular un navegador real hacia el servidor de video
  const upstreamHeaders = new Headers();
  upstreamHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  upstreamHeaders.set("Accept", "*/*");
  upstreamHeaders.set("Referer", parsedTarget.origin + "/");
  upstreamHeaders.set("Origin", parsedTarget.origin);

  // Reenviar la petición de bytes si el reproductor pide saltar en la línea de tiempo
  if (req.headers.has("range")) {
    upstreamHeaders.set("range", req.headers.get("range"));
  }

  // 4. Petición al servidor de video original con captura de errores
  let res;
  try {
    res = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return new Response("Error al conectar con la señal original: " + err.message, {
      status: 502,
      headers: corsHeaders,
    });
  }

  // Preparar rutas para reescribir todo a través de este proxy en HTTPS
  const proxyBase = `${url.origin}${url.pathname}?url=`;
  const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

  function toAbsolute(pathOrUrl) {
    const trimmed = pathOrUrl.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      return trimmed;
    }
    if (trimmed.startsWith("/")) {
      return parsedTarget.origin + trimmed;
    }
    return baseUrl + trimmed;
  }

  function makeProxied(pathOrUrl) {
    return `${proxyBase}${encodeURIComponent(toAbsolute(pathOrUrl))}`;
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();

  // 5. CASO A: Es HLS (.m3u8)
  if (parsedTarget.pathname.endsWith(".m3u8") || contentType.includes("mpegurl") || contentType.includes("application/x-mpegurl")) {
    let text = await res.text();

    // Reescribe llaves de cifrado (#EXT-X-KEY:URI=...) y mapas de inicio (#EXT-X-MAP:URI=...)
    text = text.replace(/URI="([^"]+)"/g, (match, uri) => {
      return `URI="${makeProxied(uri)}"`;
    });

    // Reescribe segmentos de video y sub-playlists
    text = text.split("\n").map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      return makeProxied(trimmed);
    }).join("\n");

    return new Response(text, {
      status: res.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/vnd.apple.mpegurl",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  }

  // 6. CASO B: Es MPEG-DASH (.mpd)
  if (parsedTarget.pathname.endsWith(".mpd") || contentType.includes("dash+xml")) {
    let text = await res.text();
    const proxiedBase = `<BaseURL>${proxyBase}${encodeURIComponent(baseUrl)}</BaseURL>`;

    if (text.includes("<BaseURL>")) {
      text = text.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (m, p1) => {
        return `<BaseURL>${makeProxied(p1)}</BaseURL>`;
      });
    } else {
      text = text.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  ${proxiedBase}`);
    }

    return new Response(text, {
      status: res.status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/dash+xml",
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    });
  }

  // 7. CASO C: Segmentos binarios (.ts, .m4s, llaves de descifrado, etc.)
  const responseHeaders = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders)) {
    responseHeaders.set(k, v);
  }

  return new Response(res.body, {
    status: res.status,
    headers: responseHeaders,
  });
};

export const config = {
  path: "/proxy",
};
