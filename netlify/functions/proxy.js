// Permite conectar a servidores con certificados SSL vencidos o autofirmados
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

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

  const reqUrl = new URL(req.url);

  // 1. OBTENER ORIGIN Y REFERER FALSOS (Si los necesitas)
  const customOrigin = reqUrl.searchParams.get("origin");
  const customReferer = reqUrl.searchParams.get("referer");

  // 2. EXTRAER LA URL DESTINO (Evita que los tokens con & se corten)
  const rawUrl = req.url;
  const urlMatches = rawUrl.match(/[?&]url=(.+)$/);
  let targetUrl = urlMatches ? urlMatches[1] : reqUrl.searchParams.get("url");

  if (!targetUrl) {
    return new Response("Falta el parámetro ?url=", { status: 400, headers: corsHeaders });
  }

  // Limpiar parámetros de nuestro proxy si quedaron pegados al final
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

  // 3. INYECCIÓN DE CABECERAS (ORIGIN / REFERER / USER-AGENT)
  const upstreamHeaders = new Headers();
  upstreamHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
  upstreamHeaders.set("Accept", "*/*");

  // Si pasaste un origin falso lo usa; si no, usa el dominio del servidor
  const effectiveOrigin = customOrigin || parsedTarget.origin;
  const effectiveReferer = customReferer || (customOrigin ? `${customOrigin}/` : `${parsedTarget.origin}/`);

  upstreamHeaders.set("Origin", effectiveOrigin);
  upstreamHeaders.set("Referer", effectiveReferer);

  if (req.headers.has("range")) {
    upstreamHeaders.set("range", req.headers.get("range"));
  }

  // 4. FETCH CON TIMEOUT (Evita que la conexión quede colgada infinitamente)
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 9500);

  let res;
  try {
    res = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutId);
    return new Response(`Error al conectar con origen: ${err.message}`, {
      status: 502,
      headers: corsHeaders,
    });
  }
  clearTimeout(timeoutId);

  // Base para proxificar URLs hijas arrastrando el origin falso
  let proxyBase = `${reqUrl.origin}/proxy?`;
  if (customOrigin) proxyBase += `origin=${encodeURIComponent(customOrigin)}&`;
  if (customReferer) proxyBase += `referer=${encodeURIComponent(customReferer)}&`;
  proxyBase += `url=`;

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
      headers: { ...noCacheHeaders, "Content-Type": "application/vnd.apple.mpegurl" },
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
      headers: { ...noCacheHeaders, "Content-Type": "application/dash+xml; charset=utf-8" },
    });
  }

  // CASO C: FRAGMENTOS (.ts, .m4s)
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
