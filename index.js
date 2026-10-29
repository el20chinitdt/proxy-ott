export default {
  async fetch(request) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const reqUrl = new URL(request.url);
    const customOrigin = reqUrl.searchParams.get("origin");
    const customReferer = reqUrl.searchParams.get("referer");

    const rawUrl = request.url;
    const urlMatches = rawUrl.match(/[?&]url=(.+)$/);
    let targetUrl = urlMatches ? urlMatches[1] : reqUrl.searchParams.get("url");

    if (!targetUrl) return new Response("Falta ?url=", { status: 400, headers: corsHeaders });

    targetUrl = targetUrl.replace(/&origin=[^&]+/, "").replace(/&referer=[^&]+/, "");
    try {
      if (targetUrl.includes("%3A") || targetUrl.includes("%2F")) {
        targetUrl = decodeURIComponent(targetUrl);
      }
    } catch (_) {}

    const parsedTarget = new URL(targetUrl);

    const upstreamHeaders = new Headers();
    upstreamHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
    upstreamHeaders.set("Accept", "*/*");

    const effectiveOrigin = customOrigin || parsedTarget.origin;
    const effectiveReferer = customReferer || (customOrigin ? `${customOrigin}/` : `${parsedTarget.origin}/`);
    upstreamHeaders.set("Origin", effectiveOrigin);
    upstreamHeaders.set("Referer", effectiveReferer);

    if (request.headers.has("range")) {
      upstreamHeaders.set("range", request.headers.get("range"));
    }

    const res = await fetch(targetUrl, {
      method: request.method,
      headers: upstreamHeaders,
      redirect: "follow",
    });

    const cleanPath = targetUrl.split("?")[0];
    const baseUrl = cleanPath.substring(0, cleanPath.lastIndexOf("/") + 1);

    let proxyBase = `${reqUrl.origin}/?`;
    if (customOrigin) proxyBase += `origin=${encodeURIComponent(customOrigin)}&`;
    if (customReferer) proxyBase += `referer=${encodeURIComponent(customReferer)}&`;
    proxyBase += `url=`;

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
    const contentType = (res.headers.get("content-type") || "").toLowerCase();

    // 1. LISTAS HLS (.m3u8)
    if (cleanTarget.endsWith(".m3u8") || contentType.includes("mpegurl")) {
      let text = await res.text();
      text = text.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${makeProxied(uri)}"`);
      text = text.split("\n").map(l => {
        const t = l.trim();
        if (!t || t.startsWith("#")) return l;
        return makeProxied(t);
      }).join("\n");

      return new Response(text, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/vnd.apple.mpegurl; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      });
    }

    // 2. DASH (.mpd)
    if (cleanTarget.endsWith(".mpd") || contentType.includes("dash+xml") || contentType.includes("text/xml")) {
      let text = await res.text();
      const proxiedBase = `<BaseURL>${proxyBase}${encodeURIComponent(baseUrl)}</BaseURL>`;

      if (text.includes("<BaseURL>")) {
        text = text.replace(/<BaseURL>([^<]+)<\/BaseURL>/g, (m, p1) => `<BaseURL>${makeProxied(p1)}</BaseURL>`);
      } else {
        text = text.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  ${proxiedBase}`);
      }

      return new Response(text, {
        headers: {
          ...corsHeaders,
          "Content-Type": "application/dash+xml; charset=utf-8",
          "Cache-Control": "no-cache, no-store, must-revalidate",
        },
      });
    }

    // 3. SEGMENTOS BINARIOS (.ts, .m4s) -> ZERO-COPY DIRECTO
    const binaryHeaders = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders)) {
      binaryHeaders.set(k, v);
    }

    if (cleanTarget.endsWith(".ts")) {
      binaryHeaders.set("Content-Type", "video/mp2t");
    } else if (cleanTarget.endsWith(".m4s")) {
      binaryHeaders.set("Content-Type", "video/iso.segment");
    }

    binaryHeaders.set("Cache-Control", "public, max-age=60");

    return new Response(res.body, {
      status: res.status,
      headers: binaryHeaders,
    });
  },
};
