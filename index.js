// ============================================================================
// CLOUDFLARE WORKER: CORS PROXY + ADAPTADOR PARA CESBO ASTRA & HLS/DASH
// Versión REFORZADA: ninguna ruta puede lanzar una excepción sin controlar
// (los "500" propios del worker), los fallos del origen salen como 502 con
// cabeceras de diagnóstico (X-Proxy-Error / X-Proxy-Origin-Status).
// ============================================================================

// ---------------------------------------------------------------------------
// CONFIGURACIÓN DE CACHÉ / RESILIENCIA (ajusta a la duración de tus segmentos)
// ---------------------------------------------------------------------------
const SEGMENT_TTL_S = 60;         // vida de un segmento en el edge (debe ser > ventana del playlist)
const MANIFEST_TTL_S = 1;         // micro-caché del manifiesto live (≤ 1/2 duración de segmento)
const STALE_MAX_MS = 30000;       // cuánto tiempo servir el último manifiesto bueno si el origen cae
const UPSTREAM_TIMEOUT_MS = 6000; // ms máximos para recibir cabeceras del origen (por salto)
const UPSTREAM_RETRIES = 2;       // reintentos ante 5xx / timeout / (404 en segmentos)
const UPSTREAM_BUDGET_MS = 14000; // tiempo total máx. entre intentos (un player se rinde antes que 3 x 6 s)
const PREFETCH_COUNT = 2;         // últimos N segmentos del manifiesto que se precalientan (0 = off)

const MAX_REDIRECTS = 5;                  // saltos 30x que seguimos a mano
const BODY_TIMEOUT_MS = 8000;             // máx. para leer un manifiesto completo
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const PREFETCH_MAX_BYTES = 8 * 1024 * 1024;
const ERROR_BODY_MAX_BYTES = 2048;        // cuánto del cuerpo de un error del origen reenviamos
const WILDCARD_DNS = ["sslip.io", "nip.io"]; // se alternan en cada reintento

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const HLS_CT = "application/vnd.apple.mpegurl; charset=utf-8";
const DASH_CT = "application/dash+xml; charset=utf-8";
const NO_STORE = "no-cache, no-store, must-revalidate";

// ---------------------------------------------------------------------------
// 0. Utilidades "a prueba de excepciones"
// ---------------------------------------------------------------------------

// Cabeceras HTTP solo admiten ASCII imprimible: un solo carácter raro en un
// referer/UA hacía que Headers.set() lanzara TypeError -> 500.
function ascii(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[^\x20-\x7E]/g, "").trim();
  return s || null;
}

// new Response() LANZA si el status es 204/205/304 con cuerpo (aunque sea "")
// o si el status está fuera de 200-599. Esto lo evita siempre.
function mkResponse(body, init) {
  let status = init.status || 200;
  if (status < 200 || status > 599) status = 502;
  if (NULL_BODY_STATUSES.has(status)) body = null;
  return new Response(body, { ...init, status });
}

function discard(res) {
  try {
    const p = res && res.body && res.body.cancel();
    if (p && p.catch) p.catch(() => {});
  } catch (_) {}
}

function withTimeout(promise, ms, message) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Lee un cuerpo como texto con tope de bytes y de tiempo (nunca cuelga ni
// se come un stream infinito). Devuelve { text, truncated }.
async function readAllText(reader, firstChunk, maxBytes, timeoutMs) {
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;
  let truncated = false;

  const work = (async () => {
    if (firstChunk && firstChunk.byteLength) {
      total += firstChunk.byteLength;
      text += decoder.decode(firstChunk, { stream: true });
      if (total >= maxBytes) truncated = true;
    }
    while (!truncated) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (total >= maxBytes) truncated = true;
    }
    text += decoder.decode();
  })();

  try {
    await withTimeout(work, timeoutMs, "Timeout leyendo el cuerpo del origen");
  } finally {
    reader.cancel().catch(() => {});
  }
  return { text, truncated };
}

// Fragmento de texto de un error del origen. Jamás lanza.
async function readErrorSnippet(res) {
  try {
    if (!res.body) return "";
    const { text } = await readAllText(res.body.getReader(), null, ERROR_BODY_MAX_BYTES, 3000);
    return text;
  } catch (_) {
    return "";
  }
}

function errorResponse(cors, status, code, detail, extra) {
  const h = new Headers(cors);
  h.set("Content-Type", "text/plain; charset=utf-8");
  h.set("Cache-Control", "no-store");
  const hv = ascii(detail ? `${code}: ${String(detail).slice(0, 100)}` : code);
  if (hv) h.set("X-Proxy-Error", hv);
  for (const [k, v] of Object.entries(extra || {})) {
    const val = ascii(v);
    if (val) h.set(k, val);
  }
  return mkResponse(detail ? `${code}: ${detail}` : code, { status, headers: h });
}

// ---------------------------------------------------------------------------
// 1. Identidad de navegador COHERENTE (UA + Client Hints + Sec-Fetch-*)
// ---------------------------------------------------------------------------

// Versión mayor de Chrome. Lo correcto es fijarla con la variable CHROME_MAJOR del Worker
// (consulta chromereleases.googleblog.com). Si no existe, se estima desde Chrome 149
// (estable ~2 jun 2026) con ciclos de 4 semanas y 1 versión de margen.
function currentChromeMajor(env) {
  const fromEnv = parseInt(env && env.CHROME_MAJOR, 10);
  if (fromEnv > 0) return fromEnv;
  const anchor = Date.UTC(2026, 5, 2);
  const cycles = Math.max(0, Math.floor((Date.now() - anchor) / (28 * 24 * 60 * 60 * 1000)));
  return 149 + Math.max(0, cycles - 1);
}

// Algoritmo de Chromium para sec-ch-ua: la marca "GREASE", su versión y el ORDEN de
// las tres marcas cambian con la versión mayor (no es un texto fijo).
function chromeBrandList(major) {
  const chars = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
  const versions = ["8", "99", "24"];
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const greaseBrand = `Not${chars[major % chars.length]}A${chars[(major + 1) % chars.length]}Brand`;
  const order = orders[major % orders.length];
  const list = [];
  list[order[0]] = `"${greaseBrand}";v="${versions[major % 3]}"`;
  list[order[1]] = `"Chromium";v="${major}"`;
  list[order[2]] = `"Google Chrome";v="${major}"`;
  return list.join(", ");
}

// Client Hints derivados del UA que realmente se envía (null si no es Chrome "puro")
function chromeHintsFromUa(ua) {
  const m = ua.match(/Chrome\/(\d+)/);
  if (!m || /Edg\/|OPR\/|Firefox\//.test(ua)) return null;
  const platform = /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Macintosh/.test(ua) ? "macOS"
    : /CrOS/.test(ua) ? "Chrome OS"
    : /Linux|X11/.test(ua) ? "Linux" : null;
  if (!platform) return null;
  return {
    secChUa: chromeBrandList(parseInt(m[1], 10)),
    mobile: /Mobile/.test(ua) ? "?1" : "?0",
    platform: `"${platform}"`,
  };
}

// La identidad (origin/referer/ua) viaja en la RUTA de las URLs reescritas: /i/<id>/<url>.
// En la query se perdía: al resolver URLs relativas (p. ej. DASH BaseURL) la query se descarta.
function encodeIdentity(id) {
  const json = JSON.stringify({ o: id.o || undefined, r: id.r || undefined, u: id.u || undefined });
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeIdentity(str) {
  try {
    const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    const o = JSON.parse(json);
    return { o: o.o || null, r: o.r || null, u: o.u || null };
  } catch (_) {
    return { o: null, r: null, u: null };
  }
}

// Un navegador envía como Origin solo esquema+host+puerto (sin ruta ni "/" final)
function normalizeOrigin(value) {
  if (!value) return null;
  try { return new URL(value).origin; } catch (_) { return value; }
}

// Cabeceras upstream: cada una existe solo si un cliente real con ese UA la enviaría.
function buildUpstreamHeaders({ request, parsedTarget, ua, origin, referer, chromeMajor, dropRange }) {
  const finalUa = ua ||
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;

  const h = new Headers();
  h.set("User-Agent", finalUa);
  h.set("Accept", "*/*");

  const isBrowser = /^Mozilla\/5\.0/.test(finalUa);

  // Navegador: Origin/Referer por defecto = el propio destino. Reproductor (VLC, ExoPlayer,
  // Lavf...): no manda Origin ni Referer, salvo que se pidan explícitamente.
  if (origin || referer || isBrowser) {
    const effOrigin = origin || parsedTarget.origin;
    h.set("Origin", effOrigin);
    h.set("Referer", referer || `${effOrigin}/`);
  }

  if (isBrowser) {
    h.set("Accept-Language", "es-ES,es;q=0.9,en;q=0.8");

    // Chrome solo manda Sec-Fetch-* y Client Hints a destinos HTTPS. Con http://IP:puerto
    // (típico de Astra) enviarlos delata que la petición no viene de un navegador real.
    if (parsedTarget.protocol === "https:") {
      const effOrigin = origin || parsedTarget.origin;
      h.set("Sec-Fetch-Site", effOrigin === parsedTarget.origin ? "same-origin" : "cross-site");
      h.set("Sec-Fetch-Mode", "cors");
      h.set("Sec-Fetch-Dest", "empty");

      const hints = chromeHintsFromUa(finalUa);
      if (hints) {
        h.set("sec-ch-ua", hints.secChUa);
        h.set("sec-ch-ua-mobile", hints.mobile);
        h.set("sec-ch-ua-platform", hints.platform);
      }
    }
  }

  if (request.headers.has("cookie")) h.set("Cookie", request.headers.get("cookie"));
  // Range solo tiene sentido en segmentos: en manifiestos (que reescribimos) y en el
  // stream continuo provoca 206/416/500 en orígenes que no lo soportan.
  if (!dropRange && request.headers.has("range")) h.set("Range", request.headers.get("range"));
  return h;
}

// ---------------------------------------------------------------------------
// 2. Adaptador y saneador de manifiestos HLS emitidos por Cesbo Astra
// ---------------------------------------------------------------------------
function patchAstraHlsManifest(text, makeProxied) {
  let patched = text.replace(/URI="([^"]+)"/g, (m, uri) => `URI="${makeProxied(uri)}"`);

  const lines = patched.split(/\r?\n/);
  const processedLines = [];

  for (let line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      processedLines.push(line);
      continue;
    }

    if (trimmed.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      if (/mp4a\.6[9b]/i.test(trimmed)) {
        line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
      }
    }

    if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
      if (!trimmed.includes("CODECS=")) {
        line = `${trimmed},CODECS="avc1.4d401f,mp4a.40.2"`;
      } else {
        line = line.replace(/mp4a\.6[9b]/gi, "mp4a.40.2");
      }
    }

    if (!trimmed.startsWith("#")) {
      line = makeProxied(trimmed);
    }

    processedLines.push(line);
  }

  return processedLines.join("\n");
}

// ---------------------------------------------------------------------------
// 3. Utilidades de caché y resiliencia
// ---------------------------------------------------------------------------

// Quita origin/referer/ua/user-agent de la URL destino (con o sin "?" / "&" delante)
// para que la clave de caché sea idéntica pidan lo que pidan los clientes.
function stripControlParams(url) {
  return url
    .replace(/([?&])(?:origin|referer|ua|user-agent|dbgkey)=[^&]*/gi, (_, sep) => (sep === "?" ? "?" : ""))
    .replace(/\?&+/, "?")
    .replace(/\?$/, "");
}

// Stream MPEG-TS continuo de Astra: UNA sola componente tras /play/ (ej. /play/a001).
// Los segmentos HLS (/play/a001/123.ts) y los manifiestos NO entran aquí.
function isContinuousTs(path) {
  return /\/play\/[^/]+\/?$/.test(path);
}

function classify(path) {
  if (path.endsWith(".m3u8") || path.endsWith(".mpd")) return "manifest";
  if (isContinuousTs(path)) return "stream";
  if (path.endsWith(".ts") || path.endsWith(".m4s") || path.endsWith(".aac")) return "segment";
  return "other";
}

// Opciones de caché del edge de Cloudflare según el tipo de recurso.
// OJO: con cacheEverything, Cloudflare cachea por defecto un 301/302 durante 20-120 min.
// Un redirect con token cacheado = tokens caducados = origen respondiendo 401/403/500.
// Por eso 3xx/4xx/5xx se marcan SIEMPRE como "no cachear" (-1).
function cfOptions(kind) {
  const noCacheErrors = { "300-399": -1, "400-499": -1, "500-599": -1 };
  if (kind === "segment") {
    return { cacheEverything: true, cacheTtlByStatus: { "200-299": SEGMENT_TTL_S, ...noCacheErrors } };
  }
  if (kind === "manifest") {
    // Micro-caché: N espectadores -> 1 petición/seg al origen por datacenter.
    return { cacheEverything: true, cacheTtlByStatus: { "200-299": MANIFEST_TTL_S, ...noCacheErrors } };
  }
  return { cacheEverything: false };
}

// IP directa -> wildcard DNS (Cloudflare bloquea fetch a IPs). Se alterna sslip.io / nip.io
// según el intento, así una caída de uno de los dos DNS no tumba el stream.
function toFetchUrl(urlStr, attempt = 0) {
  const u = new URL(urlStr);
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(u.hostname)) {
    u.hostname = `${u.hostname}.${WILDCARD_DNS[attempt % WILDCARD_DNS.length]}`;
    return u.href;
  }
  return urlStr;
}

// Inversa: si un Location devuelve 1.2.3.4.sslip.io lo volvemos a 1.2.3.4
function fromFetchUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const m = u.hostname.match(/^((?:\d{1,3}\.){3}\d{1,3})\.(?:sslip|nip)\.io$/i);
    if (m) {
      u.hostname = m[1];
      return u.href;
    }
  } catch (_) {}
  return urlStr;
}

// Una petición con redirecciones seguidas A MANO: cada salto pasa por toFetchUrl, así un
// 302 hacia http://IP:puerto/token/... no revienta contra el bloqueo de IPs de Cloudflare,
// y sabemos cuál es la URL FINAL (la base correcta para resolver URLs relativas del manifiesto).
async function fetchChain(startUrl, options, attempt) {
  const manual = options.method === "GET" || options.method === "HEAD";
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(toFetchUrl(current, attempt), {
        ...options,
        redirect: manual ? "manual" : "follow",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer); // el cuerpo ya puede fluir sin que el timeout lo corte
    }

    if (!manual || !REDIRECT_STATUSES.has(res.status)) return { res, url: current };
    const location = res.headers.get("location");
    if (!location) return { res, url: current };

    discard(res);
    current = fromFetchUrl(new URL(location, current).href);
  }
  throw new Error("Demasiadas redirecciones");
}

// fetchChain + reintentos con backoff. Devuelve { res, url } (url = URL final real).
// Los reintentos se detienen si ya no cabe otro intento dentro de UPSTREAM_BUDGET_MS.
async function fetchUpstream(url, options, { retry404 = false, retries = UPSTREAM_RETRIES } = {}) {
  const canRetry = options.method === "GET" || options.method === "HEAD";
  const max = canRetry ? retries : 0;
  const started = Date.now();
  const noBudget = () => Date.now() - started + UPSTREAM_TIMEOUT_MS > UPSTREAM_BUDGET_MS;
  let lastErr;

  for (let i = 0; i <= max; i++) {
    try {
      const out = await fetchChain(url, options, i);
      const bad = out.res.status >= 500 || (retry404 && out.res.status === 404);
      if (!bad || i === max || noBudget()) return out;
      discard(out.res);
    } catch (err) {
      lastErr = err;
      if (i === max || noBudget()) throw err;
    }
    await new Promise((r) => setTimeout(r, 200 * (i + 1)));
  }
  throw lastErr;
}

// Clave sintética (hash corto) del "último manifiesto bueno" en la Cache API.
// Con la URL entera en la clave, tokens largos superaban el límite y el put fallaba.
// (En *.workers.dev la Cache API no guarda nada; el respaldo en memoria de abajo cubre ese caso.)
async function makeStaleKey(url) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return new Request(`https://stale.proxy.internal/${hex}`);
}

// Último manifiesto bueno EN MEMORIA del isolate: funciona en cualquier sitio, también en
// *.workers.dev (donde la Cache API es un no-op). La Cache API se usa además como segundo
// nivel (compartido entre isolates del mismo datacenter) cuando hay dominio propio.
const MEM_STALE = new Map();
const MEM_STALE_MAX = 200;

function memRemember(key, text, contentType) {
  MEM_STALE.delete(key);
  MEM_STALE.set(key, { text, contentType, at: Date.now() });
  while (MEM_STALE.size > MEM_STALE_MAX) MEM_STALE.delete(MEM_STALE.keys().next().value);
}

async function serveStale(key, cors) {
  let text = null;
  let contentType = null;
  let at = 0;

  const mem = MEM_STALE.get(key.url);
  if (mem) {
    ({ text, contentType, at } = mem);
  } else {
    try {
      const stale = await caches.default.match(key);
      if (stale) {
        at = Number(stale.headers.get("X-Cached-At") || 0);
        contentType = stale.headers.get("Content-Type");
        text = await stale.text();
      }
    } catch (_) {}
  }

  if (text === null || !(Date.now() - at < STALE_MAX_MS)) {
    MEM_STALE.delete(key.url);
    return null;
  }
  const h = new Headers(cors);
  h.set("Content-Type", contentType || HLS_CT);
  h.set("Cache-Control", NO_STORE);
  h.set("X-Proxy-Cache", "STALE");
  return { body: text, headers: h };
}

// ¿Parece un manifiesto? Mira solo el principio del cuerpo (binario o texto).
function looksLikeManifest(bytes) {
  if (!bytes || !bytes.byteLength) return null;
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("#EXTM3U")) return "hls";
  if (/^(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<MPD[\s>]/i.test(head)) return "dash";
  return null;
}

// Para respuestas con Content-Type ambiguo (text/plain, octet-stream, vacío...): mira el
// primer trozo SIN consumir el cuerpo (tee). Si no es manifiesto, el cuerpo sigue intacto
// y se reenvía como binario; si lo es, se lee entero con tope de tamaño y de tiempo.
async function sniffBody(res) {
  if (!res.body) return { type: null, body: null };
  const [probe, pass] = res.body.tee();
  const reader = probe.getReader();

  let first;
  try {
    first = await withTimeout(reader.read(), BODY_TIMEOUT_MS, "Timeout esperando datos del origen");
  } catch (err) {
    reader.cancel().catch(() => {});
    pass.cancel().catch(() => {});
    throw err;
  }

  const type = looksLikeManifest(first.value);
  if (!type) {
    reader.cancel().catch(() => {});
    return { type: null, body: pass };
  }

  pass.cancel().catch(() => {});
  const { text, truncated } = await readAllText(reader, first.value, MANIFEST_MAX_BYTES, BODY_TIMEOUT_MS);
  if (truncated) throw new Error("Manifiesto demasiado grande");
  return { type, text };
}

// Consume un segmento (con tope) para que el edge termine de guardarlo en caché
async function drain(res, maxBytes) {
  try {
    if (!res.ok || !res.body) return discard(res);
    const len = Number(res.headers.get("content-length"));
    if (len > maxBytes) return discard(res);
    const reader = res.body.getReader();
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (_) {}
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function unescapeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// ---------------------------------------------------------------------------
// 3b. MODO DIAGNÓSTICO:  /debug/<url>   (opcional: &ua= &origin= &referer= &dbgkey=)
// Prueba el MISMO destino con varios perfiles de cabeceras (secuencial, para no
// disparar límites de conexiones) y dice cuál acepta el origen. No reenvía el stream.
// ---------------------------------------------------------------------------
const DEBUG_HEADERS = ["content-type", "server", "www-authenticate", "retry-after", "via", "x-powered-by", "location", "content-length", "cf-ray"];

function debugVerdict(rows) {
  const ok = (r) => r.status && r.status < 400;
  const base = rows[0];
  if (rows.every((r) => !r.status)) {
    return "Ninguna variante llegó al origen (timeout / conexión rechazada): el origen probablemente bloquea las IPs de Cloudflare, el puerto no es alcanzable desde Cloudflare o el host está caído.";
  }
  if (!ok(base) && rows.some(ok)) {
    const good = rows.find(ok);
    return `El origen rechaza el perfil del worker (${base.status || "sin respuesta"}) pero acepta "${good.perfil}" (HTTP ${good.status}): el problema son las cabeceras/UA o el DNS comodín, no el servidor en sí. Prueba a pasar ua= / origin= / referer= equivalentes.`;
  }
  if (rows.every((r) => r.status >= 500)) {
    return "El origen responde 5xx a TODAS las variantes desde Cloudflare: sospecha de bloqueo por IP/ASN de Cloudflare, token ligado a la IP del cliente, límite de conexiones simultáneas o fallo del propio origen. Compara con un curl directo desde otra máquina/IP.";
  }
  if (rows.every((r) => r.status === 401 || r.status === 403)) {
    return "401/403 en todas las variantes: credenciales o token inválidos/caducados, o bloqueo por IP.";
  }
  if (ok(base)) {
    return "El perfil del worker obtiene respuesta correcta ahora mismo: si falla en uso real, mira límite de conexiones simultáneas (varios espectadores + prefetch) o un token que caduca.";
  }
  return "Resultados mixtos: revisa cada fila.";
}

async function debugReport({ env, parsedTarget, customUa, customOrigin, customReferer, cors }) {
  const dummy = new Request("https://debug.invalid/");
  const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(parsedTarget.hostname);
  const chromeMajor = currentChromeMajor(env);

  const probes = [
    { perfil: "como lo usa el worker", ua: customUa, origin: customOrigin, referer: customReferer, attempt: 0 },
    { perfil: "reproductor tipo VLC (sin Origin/Referer)", ua: "VLC/3.0.20 LibVLC/3.0.20", origin: null, referer: null, attempt: 0 },
    { perfil: "Chrome por defecto (Origin/Referer del propio destino)", ua: null, origin: null, referer: null, attempt: 0 },
  ];
  if (isIp) {
    probes.push({ perfil: "como el worker pero vía nip.io", ua: customUa, origin: customOrigin, referer: customReferer, attempt: 1 });
  }

  const rows = [];
  for (const pr of probes) {
    const headers = buildUpstreamHeaders({
      request: dummy, parsedTarget, ua: pr.ua, origin: pr.origin, referer: pr.referer, chromeMajor, dropRange: true,
    });
    const row = { perfil: pr.perfil };
    const t0 = Date.now();
    try {
      const { res, url } = await fetchChain(parsedTarget.href, { method: "GET", headers }, pr.attempt);
      row.status = res.status;
      const u = new URL(url);
      u.username = ""; u.password = ""; u.search = u.search ? "?(oculta)" : "";
      row.urlFinal = u.href;
      row.redirigido = url !== parsedTarget.href;
      row.cabecerasOrigen = {};
      for (const n of DEBUG_HEADERS) {
        const v = res.headers.get(n);
        if (v) row.cabecerasOrigen[n] = n === "location" ? v.replace(/\?.*$/, "?(oculta)") : v.slice(0, 150);
      }
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (res.body && (res.status >= 400 || /text|xml|json|mpegurl/.test(ct))) {
        row.cuerpo = (await readErrorSnippet(res)).slice(0, 300);
      }
      discard(res);
    } catch (err) {
      row.error = String(err && err.message ? err.message : err).replace(/https?:\/\/\S+/g, "(url)").slice(0, 200);
    }
    row.ms = Date.now() - t0;
    rows.push(row);
  }

  const h = new Headers(cors);
  h.set("Content-Type", "application/json; charset=utf-8");
  h.set("Cache-Control", "no-store");
  const dest = new URL(parsedTarget.href);
  dest.username = ""; dest.password = ""; dest.search = dest.search ? "?(oculta)" : "";
  return new Response(JSON.stringify({ destino: dest.href, veredicto: debugVerdict(rows), pruebas: rows }, null, 2), { status: 200, headers: h });
}

// ---------------------------------------------------------------------------
// 4. Handler principal
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const reqOrigin = request.headers.get("Origin");

    const corsHeaders = {
      "Access-Control-Allow-Origin": reqOrigin || "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
      // Con credenciales, "*" se interpreta como un nombre de cabecera literal: se refleja
      // lo que pide el preflight (p. ej. Range) y "*" solo como último recurso.
      "Access-Control-Allow-Headers": request.headers.get("Access-Control-Request-Headers") || "*",
      "Access-Control-Max-Age": "86400",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date, Set-Cookie, X-Proxy-Cache, X-Proxy-Error, X-Proxy-Origin-Status",
      "Vary": "Origin, Access-Control-Request-Headers",
    };
    if (reqOrigin) corsHeaders["Access-Control-Allow-Credentials"] = "true";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      return await handle(request, env, ctx, corsHeaders);
    } catch (err) {
      // Última red de seguridad: nunca debería llegar aquí, pero si pasa se ve el motivo.
      return errorResponse(corsHeaders, 500, "worker-exception", err && err.message ? err.message : String(err));
    }
  },
};

async function handle(request, env, ctx, cors) {
  const reqUrl = new URL(request.url);

  if (reqUrl.pathname === "/ping" || reqUrl.pathname === "/heartbeat") {
    return new Response("OK", { status: 200, headers: cors });
  }

  const method = request.method;
  const isGetLike = method === "GET" || method === "HEAD";
  const isDebug = reqUrl.pathname.startsWith("/debug/");

  // Modo diagnóstico: si defines DEBUG_KEY como variable del Worker, exige ?dbgkey=...
  if (isDebug && env && env.DEBUG_KEY && reqUrl.searchParams.get("dbgkey") !== env.DEBUG_KEY) {
    return errorResponse(cors, 403, "forbidden", "dbgkey incorrecta");
  }

  // 1+2. IDENTIDAD (origin/referer/ua) Y URL DESTINO
  // Entradas aceptadas:
  //   /i/<identidad>/<url>              (las generan los manifiestos reescritos)
  //   /p/<url>?origin=&referer=&ua=
  //   /?url=<url>&origin=&referer=&ua=
  let identity;
  let targetUrl = "";
  const idMatch = reqUrl.pathname.match(/^\/i\/([A-Za-z0-9_-]+)\/(.+)$/);

  if (idMatch) {
    identity = decodeIdentity(idMatch[1]);
    targetUrl = (idMatch[2] + reqUrl.search).replace(/^(https?):\/+([^\/])/i, "$1://$2");
  } else {
    const sp = reqUrl.searchParams;
    identity = { o: sp.get("origin"), r: sp.get("referer"), u: sp.get("ua") || sp.get("user-agent") };

    if (reqUrl.pathname.startsWith("/p/") || isDebug) {
      targetUrl = reqUrl.pathname.substring(isDebug ? 7 : 3) + reqUrl.search;
      // Corrección de barras duplicadas o reducidas
      targetUrl = targetUrl.replace(/^(https?):\/+([^\/])/i, "$1://$2");
    } else {
      const urlMatches = request.url.match(/[?&]url=(.+)$/);
      targetUrl = urlMatches ? urlMatches[1] : sp.get("url");
    }
    // Los parámetros de control no deben llegar al origen ni a la clave de caché
    if (targetUrl) targetUrl = stripControlParams(targetUrl);
  }

  if (!targetUrl) {
    return errorResponse(cors, 400, "bad-request", "Falta el parámetro ?url= o la ruta /p/URL");
  }

  // Identidad saneada: cualquier carácter no-ASCII rompía Headers.set() -> 500
  const customOrigin = ascii(normalizeOrigin(identity.o));
  const customReferer = ascii(identity.r);
  const customUa = ascii(identity.u);

  // Solo se decodifica si la URL ENTERA llegó codificada (http%3A%2F%2F...). Antes se
  // decodificaba todo en cuanto aparecía un %2F/%3A, y eso corrompía tokens firmados
  // dentro de la query (p. ej. ?token=ab%2Fcd) -> el origen los rechazaba.
  try {
    const pathPart = targetUrl.split("?")[0];
    const wholeEncoded = /^https?%3A/i.test(targetUrl);
    const schemeless = !/^https?:\/\//i.test(targetUrl) && /%3A|%2F/i.test(pathPart);
    if (wholeEncoded || schemeless) targetUrl = decodeURIComponent(targetUrl);
  } catch (_) {}

  if (!/^https?:\/\//i.test(targetUrl)) {
    targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (err) {
    return errorResponse(cors, 400, "bad-url", "URL de destino inválida");
  }
  if (parsedTarget.hostname === reqUrl.hostname) {
    return errorResponse(cors, 400, "loop", "El destino es el propio proxy");
  }

  if (isDebug) {
    return debugReport({ env, parsedTarget, customUa, customOrigin, customReferer, cors });
  }

  // 3. CABECERAS UPSTREAM (coherentes con el UA; sin Host: Cloudflare no permite
  //    fijar un Host distinto al del destino)
  const kind = classify(parsedTarget.pathname.toLowerCase());
  const upstreamHeaders = buildUpstreamHeaders({
    request,
    parsedTarget,
    ua: customUa,
    origin: customOrigin,
    referer: customReferer,
    chromeMajor: currentChromeMajor(env),
    dropRange: method === "HEAD" || kind === "manifest" || kind === "stream",
  });

  // HEAD se hace como GET (y se cancela el cuerpo): muchos orígenes de streaming
  // responden 500/405 a HEAD o incluso arrancan el stream completo.
  const fetchOptions = {
    method: isGetLike ? "GET" : method,
    headers: upstreamHeaders,
    cf: cfOptions(kind),
  };
  if (!isGetLike) fetchOptions.body = await request.arrayBuffer();

  // Clave del "último manifiesto bueno" (se calcula una sola vez y solo si hace falta)
  let staleKeyP = null;
  const getStaleKey = () => (staleKeyP = staleKeyP || makeStaleKey(parsedTarget.href));

  // 4. FETCH AL ORIGEN (CACHÉ POR TIPO + REINTENTOS + STALE-IF-ERROR)
  let out = null;
  let fetchErr = null;
  const doFetch = async () => {
    try {
      out = await fetchUpstream(parsedTarget.href, fetchOptions, { retry404: kind === "segment" });
      fetchErr = null;
    } catch (err) {
      out = null;
      fetchErr = err;
    }
  };

  await doFetch();

  // Segmento con Range que el origen no soporta (416 / 5xx): reintento sin Range.
  // Es válido responder 200 completo a una petición con Range.
  if (out && upstreamHeaders.has("Range") && (out.res.status === 416 || out.res.status >= 500)) {
    discard(out.res);
    upstreamHeaders.delete("Range");
    await doFetch();
  }

  let res = out ? out.res : null;

  // Origen caído: servimos el último manifiesto bueno (si es reciente) para que
  // el reproductor siga consumiendo su buffer mientras el origen se recupera.
  if ((!res || res.status >= 500) && isGetLike) {
    const stale = await serveStale(await getStaleKey(), cors);
    if (stale) {
      discard(res);
      return mkResponse(method === "HEAD" ? null : stale.body, { status: 200, headers: stale.headers });
    }
  }

  if (!res) {
    return errorResponse(cors, 502, "upstream-unreachable", fetchErr && fetchErr.message ? fetchErr.message : "Origen no disponible");
  }

  const originStatus = String(res.status);

  // El origen devuelve 5xx de forma persistente: 502 (así se distingue de un fallo
  // propio del worker, que sería 500) y el status real viaja en X-Proxy-Origin-Status.
  if (res.status >= 500) {
    const snippet = method === "HEAD" ? "" : await readErrorSnippet(res);
    discard(res);
    return errorResponse(cors, 502, `upstream-${originStatus}`, snippet || "El origen respondió con error", {
      "X-Proxy-Origin-Status": originStatus,
    });
  }

  const finalUrl = new URL(out.url);
  const finalPath = finalUrl.pathname.toLowerCase();
  const finalKind = classify(finalPath);
  const effKind = kind === "stream" || finalKind === "stream" ? "stream" : finalKind;
  const ctype = (res.headers.get("content-type") || "").toLowerCase();

  const declaredHls = finalPath.endsWith(".m3u8") || ctype.includes("mpegurl");
  const declaredDash = finalPath.endsWith(".mpd") || ctype.includes("dash+xml");

  // Cabeceras de respuesta: CORS + las del origen (sin duplicar Set-Cookie).
  // Si el cuerpo se reescribe, las cabeceras de longitud/codificación del origen
  // dejan de ser válidas y se eliminan.
  function respHeaders({ rewritten, contentType }) {
    const h = new Headers(res.headers);
    if (rewritten) {
      for (const n of ["content-length", "content-encoding", "transfer-encoding", "etag", "last-modified", "content-range", "accept-ranges", "content-md5", "digest"]) {
        h.delete(n);
      }
    }
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    if (contentType) h.set("Content-Type", contentType);
    if (typeof res.headers.getSetCookie === "function") {
      h.delete("Set-Cookie");
      for (const cookie of res.headers.getSetCookie()) h.append("Set-Cookie", cookie);
    }
    h.set("X-Proxy-Origin-Status", originStatus);
    const cacheStatus = res.headers.get("cf-cache-status");
    if (cacheStatus) h.set("X-Proxy-Cache", cacheStatus);
    return h;
  }

  // HEAD: ya tenemos las cabeceras; el cuerpo del GET interno se descarta
  if (method === "HEAD") {
    discard(res);
    const isManifestLike = declaredHls || declaredDash || kind === "manifest";
    return mkResponse(null, { status: res.status, headers: respHeaders({ rewritten: isManifestLike }) });
  }

  // Errores 3xx sin Location / 4xx: se reenvía el status con un cuerpo pequeño y SIN caché
  // (y sin lanzar si es 204/304, que no admiten cuerpo)
  if (!res.ok && res.status !== 206) {
    const snippet = await readErrorSnippet(res);
    discard(res);
    const h = new Headers(cors);
    h.set("Content-Type", "text/plain; charset=utf-8");
    h.set("Cache-Control", "no-store");
    h.set("X-Proxy-Origin-Status", originStatus);
    return mkResponse(snippet, { status: res.status, headers: h });
  }

  // 5. HELPERS PARA RECONSTRUIR URLs RELATIVAS A TRAVÉS DEL PROXY
  //    (base = URL FINAL tras redirecciones, no la original)
  const baseUrl = new URL("./", finalUrl).href;
  const hasIdentity = customOrigin || customReferer || customUa;
  const proxyPrefix = hasIdentity
    ? `${reqUrl.origin}/i/${encodeIdentity({ o: customOrigin, r: customReferer, u: customUa })}/`
    : `${reqUrl.origin}/p/`;
  const manifestSearchParams = finalUrl.search || parsedTarget.search;

  // URL real (upstream) de una línea/URI del manifiesto
  function resolveUpstream(pathOrUrl) {
    const resolved = new URL(pathOrUrl.trim(), baseUrl);
    if ((resolved.protocol === "http:" || resolved.protocol === "https:") && !resolved.search && manifestSearchParams) {
      resolved.search = manifestSearchParams;
    }
    return resolved;
  }

  function makeProxied(pathOrUrl) {
    const trimmed = pathOrUrl.trim();
    if (!trimmed) return "";
    try {
      const resolved = resolveUpstream(trimmed);
      // data:, skd:// (FairPlay), etc. no son recursos HTTP: se dejan intactos
      if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return trimmed;
      return `${proxyPrefix}${resolved.href}`;
    } catch (_) {
      return trimmed;
    }
  }

  // Guarda el último manifiesto bueno (ya reescrito) para el fallback stale-if-error
  function rememberManifest(text, contentType) {
    ctx.waitUntil(
      (async () => {
        try {
          const key = await getStaleKey();
          memRemember(key.url, text, contentType);
          await caches.default.put(
            key,
            new Response(text, {
              headers: {
                "Content-Type": contentType,
                "Cache-Control": "public, max-age=120",
                "X-Cached-At": String(Date.now()),
              },
            })
          );
        } catch (_) {}
      })()
    );
  }

  // Precalienta en el edge los últimos segmentos de un playlist MEDIA, de modo que
  // incluso el primer espectador los reciba desde caché. Solo URLs que realmente son
  // segmentos y con tope de tamaño: antes un playlist con URIs sin extensión podía
  // arrastrar un stream infinito a arrayBuffer() y matar el worker por memoria.
  function prefetchSegments(manifestText) {
    if (!PREFETCH_COUNT) return;
    if (!manifestText.includes("#EXTINF") || manifestText.includes("#EXT-X-STREAM-INF")) return;

    const uris = manifestText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !/\.(m3u8|mpd)(\?|$)/i.test(l))
      .slice(-PREFETCH_COUNT);

    const prefetchHeaders = new Headers(upstreamHeaders);
    prefetchHeaders.delete("range");

    for (const uri of uris) {
      try {
        const target = resolveUpstream(uri);
        if (target.protocol !== "http:" && target.protocol !== "https:") continue;
        if (classify(target.pathname.toLowerCase()) !== "segment") continue;
        ctx.waitUntil(
          (async () => {
            try {
              const r = await fetchUpstream(
                target.href,
                { method: "GET", headers: prefetchHeaders, cf: cfOptions("segment") },
                { retries: 0 }
              );
              await drain(r.res, PREFETCH_MAX_BYTES);
            } catch (_) {}
          })()
        );
      } catch (_) {}
    }
  }

  // 6. DETECCIÓN Y LECTURA DEL CONTENIDO (siempre acotada en tamaño y tiempo)
  const ambiguous =
    !declaredHls && !declaredDash && finalKind !== "segment" &&
    (ctype === "" || /^(text\/|binary\/octet-stream|application\/(octet-stream|xml|x-?xml))/.test(ctype) ||
      ctype.includes("xml") || finalPath.includes("manifest"));

  let type = declaredHls ? "hls" : declaredDash ? "dash" : null;
  let manifestText = null;
  let passBody = res.body;

  try {
    if (type) {
      const r = await readAllText(res.body ? res.body.getReader() : emptyReader(), null, MANIFEST_MAX_BYTES, BODY_TIMEOUT_MS);
      if (r.truncated) throw new Error("Manifiesto demasiado grande");
      manifestText = r.text;
    } else if (ambiguous) {
      const s = await sniffBody(res);
      type = s.type;
      if (type) manifestText = s.text;
      else passBody = s.body;
    }
  } catch (err) {
    // El origen cortó o se colgó a mitad del cuerpo: stale si lo hay, si no 502 (no 500)
    discard(res);
    const stale = await serveStale(await getStaleKey(), cors);
    if (stale) return mkResponse(stale.body, { status: 200, headers: stale.headers });
    return errorResponse(cors, 502, "upstream-body", err && err.message ? err.message : "Error leyendo el origen", {
      "X-Proxy-Origin-Status": originStatus,
    });
  }

  // Cabecera declarada pero el cuerpo no es un manifiesto (HTML de error, JSON...):
  // se devuelve tal cual en vez de "reescribirlo" y romperlo.
  if (type === "hls" && !/^\uFEFF?\s*#EXTM3U/.test(manifestText)) type = "raw";
  if (type === "dash" && !/<MPD[\s>]/i.test(manifestText)) type = "raw";

  if (type === "raw") {
    return mkResponse(manifestText, { status: res.status, headers: respHeaders({ rewritten: true }) });
  }

  // CASO A: HLS (.m3u8) CON ADAPTADOR CESBO ASTRA
  if (type === "hls") {
    const text = patchAstraHlsManifest(manifestText, makeProxied);

    if (res.status === 200) {
      rememberManifest(text, HLS_CT);
      // Solo precalentamos cuando el manifiesto es nuevo (no un HIT de la micro-caché)
      if (res.headers.get("cf-cache-status") !== "HIT") prefetchSegments(manifestText);
    }

    const h = respHeaders({ rewritten: true, contentType: HLS_CT });
    h.set("Cache-Control", NO_STORE);
    return mkResponse(text, { status: res.status, headers: h });
  }

  // CASO B: MPEG-DASH (.mpd)
  if (type === "dash") {
    let text = manifestText;
    const proxiedBase = `<BaseURL>${escapeXml(proxyPrefix + baseUrl)}</BaseURL>`;

    if (/<BaseURL[^>]*>/i.test(text)) {
      text = text.replace(/<BaseURL[^>]*>([^<]+)<\/BaseURL>/gi, (m, p1) => `<BaseURL>${escapeXml(makeProxied(unescapeXml(p1)))}</BaseURL>`);
    } else {
      text = text.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  ${proxiedBase}`);
    }

    if (res.status === 200) rememberManifest(text, DASH_CT);

    const h = respHeaders({ rewritten: true, contentType: DASH_CT });
    h.set("Cache-Control", NO_STORE);
    return mkResponse(text, { status: res.status, headers: h });
  }

  // CASO C: SEGMENTOS BINARIOS (.ts, .m4s) O STREAM CONTINUO MPEG-TS DIRECTO DE ASTRA
  const binaryHeaders = respHeaders({ rewritten: false });

  if (effKind === "stream") {
    // Stream continuo: jamás cacheable
    binaryHeaders.set("Content-Type", "video/mp2t");
    binaryHeaders.set("Cache-Control", NO_STORE);
  } else if (finalPath.endsWith(".ts")) {
    binaryHeaders.set("Content-Type", "video/mp2t");
    binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
  } else if (finalPath.endsWith(".m4s")) {
    binaryHeaders.set("Content-Type", "video/iso.segment");
    binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
  } else if (ctype.includes("mp2t") || ctype.includes("octet-stream")) {
    binaryHeaders.set("Content-Type", "video/mp2t");
    binaryHeaders.set("Cache-Control", NO_STORE);
  }

  return mkResponse(passBody, { status: res.status, headers: binaryHeaders });
}

// Lector vacío para respuestas sin cuerpo (res.body === null)
function emptyReader() {
  return { read: async () => ({ done: true, value: undefined }), cancel: async () => {} };
}
