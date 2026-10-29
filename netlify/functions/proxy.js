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

  // 1. CAPTURA DE URL COMPLETA (Arregla que no se corten los tokens con & en MPD)
  const rawUrl = req.url;
  const urlParamIndex = rawUrl.indexOf("?url=");
  if (urlParamIndex === -1) {
    return new Response("Falta el parámetro ?url=", { status: 400, headers: corsHeaders });
  }

  let targetUrl = rawUrl.substring(urlParamIndex + 5);
  try {
    if (targetUrl.includes("%3A") || targetUrl.includes("%2F")) {
      targetUrl = decodeURIComponent(targetUrl);
    }
  } catch (_) {}

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return new Response("URL inválida: " + targetUrl, { status: 400, headers: corsHeaders });
  }

  // 2. Cabeceras limpias simulando navegador
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

  const proxyBase = `${new URL(req.url).origin}/proxy?url=`;
  const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

  function makeProxied(pathOrUrl) {
    const trimmed = pathOrUrl.trim();
    if (!trimmed) return "";
    let full = trimmed;
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      full = trimmed.startsWith("/") ? parsedTarget.origin + trimmed : baseUrl + trimmed;
    }
    return `${proxyBase}${encodeURIComponent(full)}`;
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const isHls = targetUrl.includes(".m3u8") || contentType.includes("mpegurl");
  const isDash = targetUrl.includes(".mpd") || contentType.includes("dash+xml") || contentType.includes("text/xml");

  // CABECERA CERO CACHÉ PARA TRANSMISIONES EN VIVO
  const noCacheHeaders = {
    ...corsHeaders,
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Netlify-CDN-Cache-Control": "no-store",
  };

  // CASO A: HLS (.m3u8)
  if (isHls) {
    let text = await res.text();

    text = text.replace(/URI="([^"]+)"/g, (match, uri) => `URI="${makeProxied(uri)}"`);

    text = text.split("\n").map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      return makeProxied(trimmed);
    }).join("\n");

    return new Response(text, {
      status: res.status,
      headers: {
        ...noCacheHeaders,
        "Content-Type": "application/vnd.apple.mpegurl",
      },
    });
  }

  // CASO B: DASH (.mpd)
  if (isDash) {
    let text = await res.text();
    const proxiedBase = `<BaseURL>${proxyBase}${encodeURIComponent(baseUrl)}</BaseURL>`;

    if (text.includes("<BaseURL>")) {
      text = text.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (m, p1) => `<BaseURL>${makeProxied(p1)}</BaseURL>`);
    } else {
      text = text.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  ${proxiedBase}`);
    }

    return new Response(text, {
      status: res.status,
      headers: {
        ...noCacheHeaders,
        "Content-Type": "application/dash+xml; charset=utf-8",
      },
    });
  }

  // CASO C: FRAGMENTOS DE VIDEO DIRECTOS (.ts, .m4s)
  // Túnel ultrarrápido sin tocar el contenido para que no se frene el buffer
  const cleanHeaders = new Headers(corsHeaders);
  const safeHeaders = ["content-type", "content-length", "content-range", "accept-ranges"];
  for (const [k, v] of res.headers.entries()) {
    if (safeHeaders.includes(k.toLowerCase())) {
      cleanHeaders.set(k, v);
    }
  }

  cleanHeaders.set("Cache-Control", "public, max-age=120");

  return new Response(res.body, {
    status: res.status,
    headers: cleanHeaders,
  });
};

export const config = {
  path: "/proxy",
};
