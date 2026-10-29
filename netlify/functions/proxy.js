export default async (req, context) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("url");

  if (!targetUrl) {
    return new Response("Falta el parámetro ?url=", { status: 400, headers: corsHeaders });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response("URL inválida", { status: 400, headers: corsHeaders });
  }

  const upstreamHeaders = new Headers();
  upstreamHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  upstreamHeaders.set("Accept", "*/*");
  upstreamHeaders.set("Referer", parsedTarget.origin + "/");
  upstreamHeaders.set("Origin", parsedTarget.origin);

  if (req.headers.has("range")) {
    upstreamHeaders.set("range", req.headers.get("range"));
  }

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
  const isHls = targetUrl.includes(".m3u8") || contentType.includes("mpegurl");
  const isDash = targetUrl.includes(".mpd") || contentType.includes("dash+xml");

  // REGLA CLAVE: Cero caché para listas en vivo para que nunca se congele
  const liveListHeaders = {
    ...corsHeaders,
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Netlify-CDN-Cache-Control": "no-store",
  };

  // 1. MANEJO DE HLS (.m3u8)
  if (isHls) {
    let text = await res.text();

    text = text.replace(/URI="([^"]+)"/g, (match, uri) => {
      return `URI="${makeProxied(uri)}"`;
    });

    text = text.split("\n").map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      return makeProxied(trimmed);
    }).join("\n");

    return new Response(text, {
      status: res.status,
      headers: {
        ...liveListHeaders,
        "Content-Type": "application/vnd.apple.mpegurl",
      },
    });
  }

  // 2. MANEJO DE DASH (.mpd)
  if (isDash) {
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
        ...liveListHeaders,
        "Content-Type": "application/dash+xml",
      },
    });
  }

  // 3. SEGMENTOS BINARIOS DE VIDEO (.ts, .m4s)
  // Limpiamos cabeceras de red peligrosas que cortan la conexión
  const cleanHeaders = new Headers(corsHeaders);
  const safeHeaders = ["content-type", "content-length", "content-range", "accept-ranges"];
  for (const [k, v] of res.headers.entries()) {
    if (safeHeaders.includes(k.toLowerCase())) {
      cleanHeaders.set(k, v);
    }
  }

  // Permitir que el reproductor guarde los pedazos que ya vio para que no gaste doble datos
  cleanHeaders.set("Cache-Control", "public, max-age=60");

  return new Response(res.body, {
    status: res.status,
    headers: cleanHeaders,
  });
};

export const config = {
  path: "/proxy",
};
