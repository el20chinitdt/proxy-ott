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

  const res = await fetch(targetUrl);
  const contentType = res.headers.get("content-type") || "";

  // Si es HLS (.m3u8), convierte los fragmentos a HTTPS
  if (targetUrl.includes(".m3u8") || contentType.includes("mpegurl")) {
    let text = await res.text();
    const proxyBase = `${url.origin}${url.pathname}?url=`;

    text = text.split("\n").map(line => {
      line = line.trim();
      if (!line || line.startsWith("#")) return line;
      if (line.startsWith("http://") || line.startsWith("https://")) {
        return `${proxyBase}${encodeURIComponent(line)}`;
      }
      return line;
    }).join("\n");

    return new Response(text, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/vnd.apple.mpegurl",
      },
    });
  }

  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(res.body, { status: res.status, headers });
};

export const config = {
  path: "/proxy",
};
