process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

export default async (req, context) => {
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const reqUrl = new URL(req.url);

  // 1. ORIGIN Y REFERER PERSONALIZADOS
  const customOrigin = reqUrl.searchParams.get("origin");
  const customReferer = reqUrl.searchParams.get("referer");

  // 2. EXTRAER URL DESTINO
  const rawUrl = req.url;
  const urlMatches = rawUrl.match(/[?&]url=(.+)$/);
  let targetUrl = urlMatches ? urlMatches[1] : reqUrl.searchParams.get("url");

  if (!targetUrl) {
    return new Response("Falta el parámetro ?url=", { status: 400, headers: corsHeaders });
  }

  targetUrl = targetUrl.replace(/&origin=[^&]+/, "").replace(/&referer=[^&]+/, "");

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

  // 3. CABECERAS UPSTREAM
  const upstreamHeaders = new Headers();
  upstreamHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  upstreamHeaders.set("Accept", "*/*");
  upstreamHeaders.set("Connection", "keep-alive");

  const effectiveOrigin = customOrigin || parsedTarget.origin;
  const effectiveReferer = customReferer || (customOrigin ? `${customOrigin}/` : `${parsedTarget.origin}/`);

  upstreamHeaders.set("Origin", effectiveOrigin);
  upstreamHeaders.set("Referer", effectiveReferer);

  if (req.headers.has("range")) {
    upstreamHeaders.set("range", req.headers.get("range"));
  }

  // 4. FETCH
  let res;
  try {
    res = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      redirect: "follow",
    });
  } catch (err) {
    return new Response(`Error al conectar con origen: ${err.message}`, {
      status: 502,
      headers: corsHeaders,
    });
  }

  // Base para subrecursos (evitando romper rutas con query params)
  let proxyBase = `${reqUrl.origin}/proxy?`;
  if (customOrigin) proxyBase += `origin=${encodeURIComponent(customOrigin)}&`;
  if (customReferer) proxyBase += `referer=${encodeURIComponent(customReferer)}&`;
  proxyBase += `url=`;

  const cleanPath = targetUrl.split("?")[0];
  const baseUrl = cleanPath.substring(0, cleanPath.lastIndexOf("/") + 1);

  function makeProxied(pathOrUrl) {
    const trimmed = pathOrUrl.trim();
    if (!trimmed) return "";
    let full = trimmed;
    if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
      full = trimmed.startsWith("/") ? parsedTarget.origin + trimmed : baseUrl + trimmed;
    }
    return `${proxyBase}${encodeURIComponent(full)}`;
  }

  const cleanTarget = parsedTarget.pathname.toLowerCase();
  const rawContentType = (res.headers.get("content-type") || "").toLowerCase();

  const isHls = cleanTarget.endsWith(".m3u8") || rawContentType.includes("mpegurl");
  const isDash = cleanTarget.endsWith(".mpd") || rawContentType.includes("dash+xml") || rawContentType.includes("text/xml");

  const noCacheHeaders = {
    ...corsHeaders,
    "Cache-Control": "no-cache, no-store, must-revalidate, max-age=0",
    "Pragma": "no-cache",
    "Expires": "0",
    "Netlify-CDN-Cache-Control": "no-store",
  };

  // CASO A: LISTAS HLS (.m3u8)
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
        "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
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

  // CASO C: SEGMENTOS BINARIOS (.ts, .m4s, .mp4, llaves)
  // Descargamos el buffer completo para que Hls.js no reciba paquetes corruptos
  const buffer = await res.arrayBuffer();

  const binaryHeaders = new Headers(corsHeaders);
  binaryHeaders.set("Content-Length", buffer.byteLength.toString());
  binaryHeaders.set("Accept-Ranges", "bytes");
  binaryHeaders.set("Cache-Control", "public, max-age=120");

  // Asignamos el Content-Type ESTRICTO que Hls.js necesita para no romper
  if (cleanTarget.endsWith(".ts")) {
    binaryHeaders.set("Content-Type", "video/mp2t");
  } else if (cleanTarget.endsWith(".m4s")) {
    binaryHeaders.set("Content-Type", "video/iso.segment");
  } else if (cleanTarget.endsWith(".mp4")) {
    binaryHeaders.set("Content-Type", "video/mp4");
  } else {
    binaryHeaders.set("Content-Type", rawContentType || "application/octet-stream");
  }

  return new Response(buffer, {
    status: res.status,
    headers: binaryHeaders,
  });
};

export const config = {
  path: "/proxy",
};
