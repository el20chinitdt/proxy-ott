export default async (req, context) => {
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("url");

  if (!targetUrl) return new Response("Falta ?url=", { status: 400 });

  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  // Fingimos ser un navegador real para que el servidor de video no corte la conexión
  const upstreamHeaders = new Headers();
  upstreamHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36");

  const res = await fetch(targetUrl, { headers: upstreamHeaders });
  const contentType = res.headers.get("content-type") || "";

  // Si es lista HLS (.m3u8)
  if (targetUrl.includes(".m3u8") || contentType.includes("mpegurl")) {
    let text = await res.text();
    const proxyBase = `${url.origin}${url.pathname}?url=`;
    
    // Obtenemos la carpeta base del video original
    const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);

    text = text.split("\n").map(line => {
      line = line.trim();
      if (!line || line.startsWith("#")) return line;

      // Si el pedacito de video es relativo, le ponemos la URL completa de origen
      let fullSegmentUrl = line;
      if (!line.startsWith("http://") && !line.startsWith("https://")) {
        if (line.startsWith("/")) {
          const originUrl = new URL(targetUrl).origin;
          fullSegmentUrl = originUrl + line;
        } else {
          fullSegmentUrl = baseUrl + line;
        }
      }

      // Lo enviamos a través de nuestro proxy seguro
      return `${proxyBase}${encodeURIComponent(fullSegmentUrl)}`;
    }).join("\n");

    return new Response(text, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "*",
        "Content-Type": "application/vnd.apple.mpegurl",
      },
    });
  }

  // Para fragmentos de video (.ts)
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");

  return new Response(res.body, { status: res.status, headers });
};

export const config = {
  path: "/proxy",
};
