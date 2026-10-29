Deno.serve(async (req) => {
  const url = new URL(req.url);
  const targetUrl = url.searchParams.get("url");

  if (!targetUrl) return new Response("Falta ?url=", { status: 400 });

  // Manejo de peticiones previas de la OTT (CORS Preflight)
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

  // Si es una lista HLS (.m3u8), convertimos TODOS los fragmentos internos a HTTPS
  if (targetUrl.includes(".m3u8") || contentType.includes("mpegurl")) {
    let text = await res.text();
    const proxyBase = `${url.origin}/?url=`;

    // Convierte cualquier chunk que venga en http:// a tu proxy https://
    text = text.split("\n").map(line => {
      line = line.trim();
      if (!line || line.startsWith("#")) return line;
      if (line.startsWith("http://") || line.startsWith("https://")) {
        return `${proxyBase}${encodeURIComponent(line)}`;
      }
      return line; // Si es relativa la dejamos igual
    }).join("\n");

    return new Response(text, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/vnd.apple.mpegurl",
      },
    });
  }

  // Para segmentos de video (.ts, .m4s, etc.)
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");

  return new Response(res.body, { status: res.status, headers });
});
