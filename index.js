// ============================================================================
// CLOUDFLARE WORKER: CORS PROXY + ADAPTADOR PARA CESBO ASTRA & HLS/DASH
// Blindado automáticamente contra bajas de velocidad, throttling y stalls
// ============================================================================

// ---------------------------------------------------------------------------
// CONFIGURACIÓN DE CACHÉ, RESILIENCIA Y ANTI-THROTTLING
// ---------------------------------------------------------------------------
const SEGMENT_TTL_S = 60;              // vida de un segmento en el edge
const MANIFEST_TTL_S = 1;              // micro-caché del manifiesto live
const STALE_MAX_MS = 30000;            // cuánto tiempo servir el último manifiesto bueno si cae el origen
const UPSTREAM_TIMEOUT_MS = 6000;      // ms máximos para recibir cabeceras del origen
const HEDGE_DELAY_MS = 1200;           // si tarda >1.2s en cabeceras, lanza petición paralela de respaldo
const UPSTREAM_RETRIES = 2;            // reintentos ante 5xx / 429 / timeout / (404 en segmentos)
const PREFETCH_COUNT = 2;              // últimos N segmentos del manifiesto que se precalientan (0 = off)

const STALL_TIMEOUT_MS = 3000;         // si un segmento/archivo deja de enviar bytes 3s -> reanuda/escala
const STREAM_IDLE_TIMEOUT_MS = 15000;  // watchdog de inactividad para streams TS continuos
const THROTTLE_GRACE_MS = 600;         // gracia inicial antes de evaluar caída de velocidad
const THROTTLE_FLOOR_BPS = 350 * 1024; // < 350 KB/s -> escala a Multi-Range paralelo
const MULTI_RANGE_MIN_REMAINING = 256 * 1024; // mínimo restante para dividir en Multi-Range
const MULTI_RANGE_CONCURRENCY = 4;     // conexiones paralelas (máximo permitido en CF = 6)
const MULTI_CHUNK_BYTES = 512 * 1024;  // tamaño base de chunk (512 KB)
const MAX_CHUNKS_PER_REQ = 24;         // tope de chunks por petición (seguro bajo límite de subrequests CF)
const MAX_RESUME_ATTEMPTS = 3;         // reintentos de reanudación ante cortes/stalls
const MAX_CACHEABLE_BYTES = 24 * 1024 * 1024; // 24 MB (seguro bajo límite de ~128 MB de tee())
const THROTTLED_HOST_TTL_MS = 120000;  // memoria por isolate: 2 min recordando CDNs que caparon velocidad
const NO_RANGE_HOST_TTL_MS = 600000;   // 10 min recordando orígenes que ignoran Range

// Memoria ligera por isolate para acelerar automáticamente CDNs lentas desde el byte 0
const throttledHosts = new Map();
const noRangeHosts = new Map();

function markMapTtl(map, key, ttlMs) {
  if (map.size >= 200) {
    const firstKey = map.keys().next().value;
    if (firstKey !== undefined) map.delete(firstKey);
  }
  map.set(key, Date.now() + ttlMs);
}

function hasValidTtl(map, key) {
  const exp = map.get(key);
  if (!exp) return false;
  if (Date.now() > exp) {
    map.delete(key);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 1. IDENTIDAD DE NAVEGADOR COHERENTE (UA + Client Hints + Sec-Fetch-*)
// ---------------------------------------------------------------------------
function currentChromeMajor(env) {
  const fromEnv = parseInt(env && env.CHROME_MAJOR, 10);
  if (fromEnv > 0) return fromEnv;
  const anchor = Date.UTC(2026, 5, 2);
  const cycles = Math.max(0, Math.floor((Date.now() - anchor) / (28 * 24 * 60 * 60 * 1000)));
  return 149 + Math.max(0, cycles - 1);
}

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

function normalizeOrigin(value) {
  if (!value) return null;
  try { return new URL(value).origin; } catch (_) { return value; }
}

function isSameSiteOrigin(originA, originB) {
  try {
    const a = new URL(originA).hostname;
    const b = new URL(originB).hostname;
    if (a === b) return true;
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(a) || /^(\d{1,3}\.){3}\d{1,3}$/.test(b)) return false;
    return a.split(".").slice(-2).join(".") === b.split(".").slice(-2).join(".");
  } catch (_) {
    return false;
  }
}

function buildUpstreamHeaders({ request, parsedTarget, ua, origin, referer, chromeMajor }) {
  const finalUa = ua ||
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;

  const h = new Headers();
  h.set("User-Agent", finalUa);
  h.set("Accept", "*/*");

  const isBrowser = /^Mozilla\/5\.0/.test(finalUa);

  if (origin || referer || isBrowser) {
    const effOrigin = origin || parsedTarget.origin;
    h.set("Origin", effOrigin);
    h.set("Referer", referer || `${effOrigin}/`);
  }

  if (isBrowser) {
    h.set("Accept-Language", "es-ES,es;q=0.9,en;q=0.8");
    if (parsedTarget.protocol === "https:") {
      const effOrigin = origin || parsedTarget.origin;
      const site = effOrigin === parsedTarget.origin
        ? "same-origin"
        : (isSameSiteOrigin(effOrigin, parsedTarget.origin) ? "same-site" : "cross-site");
      h.set("Sec-Fetch-Site", site);
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

  if (request.headers.has("authorization")) h.set("Authorization", request.headers.get("authorization"));
  if (request.headers.has("cookie")) h.set("Cookie", request.headers.get("cookie"));
  if (request.headers.has("range")) h.set("Range", request.headers.get("range"));
  return h;
}

// ---------------------------------------------------------------------------
// 2. ADAPTADOR Y SANEADOR DE MANIFIESTOS HLS (CESBO ASTRA)
// ---------------------------------------------------------------------------
function patchAstraHlsManifest(text, makeProxied) {
  const patched = text.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${makeProxied(uri)}"`);
  const lines = patched.split(/\r?\n/);
  const processedLines = [];

  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      processedLines.push("");
      continue;
    }

    if (trimmed.startsWith("#EXT-X-MEDIA:TYPE=AUDIO")) {
      if (/mp4a\.6[79b]/i.test(trimmed)) {
        line = trimmed.replace(/mp4a\.6[79b]/gi, "mp4a.40.2");
      }
    } else if (trimmed.startsWith("#EXT-X-STREAM-INF:")) {
      if (!/CODECS=/i.test(trimmed)) {
        line = `${trimmed},CODECS="avc1.4d401f,mp4a.40.2"`;
      } else {
        line = trimmed.replace(/mp4a\.6[79b]/gi, "mp4a.40.2");
      }
    } else if (!trimmed.startsWith("#")) {
      line = makeProxied(trimmed);
    }

    processedLines.push(line);
  }

  return processedLines.join("\n");
}

// ---------------------------------------------------------------------------
// 3. UTILIDADES DE CACHÉ, SEGURIDAD Y CLASIFICACIÓN
// ---------------------------------------------------------------------------
function stripControlParams(url) {
  return url
    .replace(/([?&])(?:origin|referer|ua|user-agent)=[^&]*/gi, (_, sep) => (sep === "?" ? "?" : ""))
    .replace(/\?&+/, "?")
    .replace(/&+$/, "")
    .replace(/\?$/, "");
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    h === "localhost" ||
    h === "::1" ||
    h === "::" ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".localhost")
  ) return true;

  if (/^127\./.test(h) || /^10\./.test(h) || /^0\./.test(h) || /^169\.254\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  const m172 = h.match(/^172\.(\d+)\./);
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
  if (/^(fc|fd|fe80)/i.test(h)) return true;
  return false;
}

function isContinuousTs(path) {
  return /\/play\/[^/]+\/?$/.test(path);
}

function classify(path) {
  if (path.endsWith(".m3u8") || path.endsWith(".mpd")) return "manifest";
  if (isContinuousTs(path)) return "stream";
  if (/\.(ts|m4s|aac|m4a|cmfv|cmfa)$/i.test(path)) return "segment";
  if (/\.(mp4|webm|mkv|mov|m4v)$/i.test(path)) return "vod";
  return "other";
}

function cfOptions(kind) {
  if (kind === "segment") {
    return {
      cacheEverything: true,
      cacheTtlByStatus: { "200-299": SEGMENT_TTL_S, "404": -1, "500-599": -1 },
    };
  }
  if (kind === "manifest") {
    return {
      cacheEverything: true,
      cacheTtlByStatus: { "200-299": MANIFEST_TTL_S, "404": -1, "500-599": -1 },
    };
  }
  return { cacheEverything: false };
}

function toFetchUrl(urlStr) {
  const host = new URL(urlStr).hostname;
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) ? urlStr.replace(host, `${host}.sslip.io`) : urlStr;
}

function cleanCacheHeaders(headers, ttlSeconds) {
  const h = new Headers(headers);
  h.delete("set-cookie");
  h.delete("vary");
  h.delete("pragma");
  h.delete("expires");
  h.set("Cache-Control", `public, max-age=${ttlSeconds}`);
  return h;
}

function parseContentRange(headerVal) {
  if (!headerVal) return null;
  const m = headerVal.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: Number(m[2]),
    total: m[3] === "*" ? null : Number(m[3]),
  };
}

function parseSingleRangeRequest(rangeHeader) {
  if (!rangeHeader) return null;
  const m = rangeHeader.match(/^bytes=(\d+)-(\d*)$/i);
  if (!m) return null;
  return {
    start: Number(m[1]),
    end: m[2] ? Number(m[2]) : null,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// 4. MOTOR DE RED RESILIENTE (HEDGING + RETRIES + MULTI-RANGE ANTI-THROTTLE)
// ---------------------------------------------------------------------------

// Lee el cuerpo completo de un chunk con timeout por INACTIVIDAD (no por duración total),
// evitando falsos timeouts si la CDN va lenta pero progresando, y cortando al instante si se congela.
async function readBytesWithStallTimeout(body, expectedLen, stallMs, ctrl) {
  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      let timer;
      const res = await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            ctrl.abort();
            reject(new Error("CHUNK_STALL"));
          }, stallMs);
        }),
      ]);
      clearTimeout(timer);

      if (res.done) break;
      chunks.push(res.value);
      total += res.value.byteLength;
    }
  } catch (err) {
    try { await reader.cancel(); } catch (_) {}
    throw err;
  }

  if (expectedLen > 0 && total !== expectedLen) {
    throw new Error(`Chunk incompleto: ${total}/${expectedLen}`);
  }

  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

// Petición con timeout en cabeceras + Hedged Request si el origen tarda en responder.
// Devuelve { res, hedged, activeCtrl } para que el stream pueda abortar el socket si se congela después.
async function fetchWithHedge(url, options, { hedgeDelayMs = HEDGE_DELAY_MS, timeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  const canHedge = hedgeDelayMs > 0 && (!options.method || options.method === "GET" || options.method === "HEAD");

  const runOnce = () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return {
      ctrl,
      promise: fetch(url, { ...options, signal: ctrl.signal }).finally(() => clearTimeout(timer)),
    };
  };

  if (!canHedge) {
    const single = runOnce();
    const res = await single.promise;
    return { res, hedged: false, activeCtrl: single.ctrl };
  }

  const primary = runOnce();
  let backup = null;
  let settled = false;

  return new Promise((resolve, reject) => {
    let errors = 0;
    const totalExpected = () => (backup ? 2 : 1);

    const handleSuccess = (res, isBackup, selfCtrl, otherCtrl) => {
      if (settled) {
        res.body?.cancel();
        return;
      }
      if ((res.status >= 500 || res.status === 429) && backup && !isBackup) {
        res.body?.cancel();
        errors++;
        if (errors >= totalExpected()) reject(new Error(`Upstream HTTP ${res.status}`));
        return;
      }
      settled = true;
      clearTimeout(hedgeTimer);
      try { otherCtrl?.abort(); } catch (_) {}
      resolve({ res, hedged: isBackup, activeCtrl: selfCtrl });
    };

    const handleFailure = (err) => {
      if (settled) return;
      errors++;
      if (!backup || errors >= totalExpected()) {
        settled = true;
        clearTimeout(hedgeTimer);
        reject(err);
      }
    };

    const hedgeTimer = setTimeout(() => {
      if (settled) return;
      backup = runOnce();
      backup.promise.then(
        (res) => handleSuccess(res, true, backup.ctrl, primary.ctrl),
        (err) => handleFailure(err)
      );
    }, hedgeDelayMs);

    primary.promise.then(
      (res) => handleSuccess(res, false, primary.ctrl, backup?.ctrl),
      (err) => handleFailure(err)
    );
  });
}

async function fetchWithRetry(url, options, { retry404 = false, hedgeDelayMs = HEDGE_DELAY_MS } = {}) {
  const canRetry = !options.method || options.method === "GET" || options.method === "HEAD";
  const max = canRetry ? UPSTREAM_RETRIES : 0;
  let lastErr;
  let usedHedge = false;

  for (let i = 0; i <= max; i++) {
    try {
      const out = await fetchWithHedge(url, options, {
        hedgeDelayMs: i === 0 ? hedgeDelayMs : Math.min(hedgeDelayMs, 800),
      });
      if (out.hedged) usedHedge = true;

      const bad = out.res.status >= 500 || out.res.status === 429 || (retry404 && out.res.status === 404);
      if (!bad || i === max) return { res: out.res, hedged: usedHedge, activeCtrl: out.activeCtrl };

      const retryAfter = Number(out.res.headers.get("retry-after"));
      out.res.body?.cancel();
      const waitMs = out.res.status === 429 && retryAfter > 0 ? Math.min(retryAfter * 1000, 1500) : 200 * (i + 1);
      await sleep(waitMs);
    } catch (err) {
      lastErr = err;
      if (i === max) throw err;
      await sleep(200 * (i + 1));
    }
  }
  throw lastErr;
}

async function fetchRangeChunk(url, baseHeaders, start, end, ifRange, signal) {
  for (let attempt = 0; attempt <= UPSTREAM_RETRIES; attempt++) {
    if (signal?.aborted) throw new Error("Aborted");
    const ctrl = new AbortController();
    const onExtAbort = () => ctrl.abort();
    signal?.addEventListener("abort", onExtAbort, { once: true });

    const connectTimer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const h = new Headers(baseHeaders);
      h.set("Range", `bytes=${start}-${end}`);
      if (ifRange) h.set("If-Range", ifRange);

      const res = await fetch(url, {
        method: "GET",
        headers: h,
        redirect: "follow",
        signal: ctrl.signal,
        cf: { cacheEverything: false },
      });
      clearTimeout(connectTimer);

      if (res.status !== 206) {
        res.body?.cancel();
        if ((res.status >= 500 || res.status === 429) && attempt < UPSTREAM_RETRIES) {
          await sleep(180 * (attempt + 1));
          continue;
        }
        throw new Error(`Chunk esperaba 206, recibió ${res.status}`);
      }

      const expectedLen = end - start + 1;
      return await readBytesWithStallTimeout(res.body, expectedLen, STALL_TIMEOUT_MS, ctrl);
    } catch (err) {
      clearTimeout(connectTimer);
      if (signal?.aborted || attempt === UPSTREAM_RETRIES) throw err;
      await sleep(180 * (attempt + 1));
    } finally {
      signal?.removeEventListener("abort", onExtAbort);
    }
  }
}

function createMultiRangePump({ url, headers, startByte, endByte, ifRange, concurrency, preloadedFirstChunk = null }) {
  const totalRemaining = endByte - startByte + 1;
  const chunkSize = Math.max(MULTI_CHUNK_BYTES, Math.ceil(totalRemaining / MAX_CHUNKS_PER_REQ));

  const chunks = [];
  let cursor = startByte + (preloadedFirstChunk ? preloadedFirstChunk.byteLength : 0);
  while (cursor <= endByte) {
    const cEnd = Math.min(cursor + chunkSize - 1, endByte);
    chunks.push({ index: chunks.length, start: cursor, end: cEnd });
    cursor = cEnd + 1;
  }

  const masterCtrl = new AbortController();
  const completed = new Map();
  let nextToDispatch = 0;
  let nextToDeliver = 0;
  let inFlight = 0;
  let fatalError = null;
  let notify = null;
  let servedPreloaded = false;

  const wake = () => {
    if (notify) {
      const fn = notify;
      notify = null;
      fn();
    }
  };

  const pumpDispatch = () => {
    while (
      !fatalError &&
      !masterCtrl.signal.aborted &&
      inFlight < concurrency &&
      nextToDispatch < chunks.length &&
      (nextToDispatch - nextToDeliver) < concurrency * 2
    ) {
      const c = chunks[nextToDispatch++];
      inFlight++;
      fetchRangeChunk(url, headers, c.start, c.end, ifRange, masterCtrl.signal)
        .then((buf) => {
          completed.set(c.index, buf);
        })
        .catch((err) => {
          if (!fatalError && !masterCtrl.signal.aborted) {
            fatalError = err;
            masterCtrl.abort();
          }
        })
        .finally(() => {
          inFlight--;
          pumpDispatch();
          wake();
        });
    }
  };

  return {
    start() {
      pumpDispatch();
    },
    async next() {
      if (!servedPreloaded && preloadedFirstChunk) {
        servedPreloaded = true;
        return { value: preloadedFirstChunk, done: false };
      }
      while (true) {
        if (fatalError) throw fatalError;
        if (nextToDeliver >= chunks.length) return { done: true };
        if (completed.has(nextToDeliver)) {
          const buf = completed.get(nextToDeliver);
          completed.delete(nextToDeliver);
          nextToDeliver++;
          pumpDispatch();
          return { value: buf, done: false };
        }
        await new Promise((r) => { notify = r; });
      }
    },
    abort() {
      masterCtrl.abort();
      completed.clear();
      wake();
    },
  };
}

function createResilientBody({
  initialRes,
  initialCtrl,
  fetchUrl,
  targetHost,
  upstreamHeaders,
  expectedEnd,
  startOffset,
  supportsRange,
  ifRange,
  throttleFloorBps,
  concurrency,
}) {
  let reader = initialRes.body.getReader();
  let activeCtrl = initialCtrl || null;
  let bytesDelivered = 0;
  let resumeAttempts = 0;
  let mode = "single";
  let multiPump = null;
  let closed = false;

  const streamStartAt = Date.now();
  let windowStartAt = streamStartAt;
  let windowBytes = 0;

  const hasKnownEnd = Number.isFinite(expectedEnd) && expectedEnd >= startOffset;

  const abortCurrentReader = () => {
    try { activeCtrl?.abort(); } catch (_) {}
    try { reader?.cancel().catch(() => {}); } catch (_) {}
  };

  const escalateToMulti = () => {
    markMapTtl(throttledHosts, targetHost, THROTTLED_HOST_TTL_MS);
    const cursor = startOffset + bytesDelivered;
    mode = "multi";
    multiPump = createMultiRangePump({
      url: fetchUrl,
      headers: upstreamHeaders,
      startByte: cursor,
      endByte: expectedEnd,
      ifRange,
      concurrency,
    });
    multiPump.start();
  };

  const resumeSingleStream = async () => {
    if (resumeAttempts >= MAX_RESUME_ATTEMPTS) {
      throw new Error("Máximo de reanudaciones alcanzado");
    }
    resumeAttempts++;
    const cursor = startOffset + bytesDelivered;

    const h = new Headers(upstreamHeaders);
    if (supportsRange && cursor > 0) {
      const rangeEnd = hasKnownEnd ? expectedEnd : "";
      h.set("Range", `bytes=${cursor}-${rangeEnd}`);
      if (ifRange) h.set("If-Range", ifRange);
    } else if (bytesDelivered > 0) {
      throw new Error("El origen no soporta Range para reanudar");
    }

    const ctrl = new AbortController();
    activeCtrl = ctrl;
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let r;
    try {
      r = await fetch(fetchUrl, {
        method: "GET",
        headers: h,
        redirect: "follow",
        signal: ctrl.signal,
        cf: { cacheEverything: false },
      });
    } finally {
      clearTimeout(timer);
    }

    if (cursor > 0 && r.status !== 206) {
      r.body?.cancel();
      throw new Error(`Reanudación fallida: HTTP ${r.status}`);
    }
    if (!r.ok && r.status !== 206) {
      r.body?.cancel();
      throw new Error(`Reanudación HTTP ${r.status}`);
    }

    reader = r.body.getReader();
    windowStartAt = Date.now();
    windowBytes = 0;
  };

  return new ReadableStream({
    async pull(controller) {
      if (closed) return;

      try {
        while (true) {
          if (mode === "multi") {
            const { value, done } = await multiPump.next();
            if (done) {
              closed = true;
              controller.close();
              return;
            }
            bytesDelivered += value.byteLength;
            controller.enqueue(value);
            return;
          }

          let stallTimer;
          let result;
          try {
            result = await Promise.race([
              reader.read(),
              new Promise((_, reject) => {
                stallTimer = setTimeout(() => reject(new Error("STALL")), STALL_TIMEOUT_MS);
              }),
            ]);
          } catch (err) {
            clearTimeout(stallTimer);
            abortCurrentReader();

            if (err.message === "STALL") {
              markMapTtl(throttledHosts, targetHost, THROTTLED_HOST_TTL_MS);
              const remaining = hasKnownEnd ? (expectedEnd - (startOffset + bytesDelivered) + 1) : 0;
              if (supportsRange && hasKnownEnd && remaining >= MULTI_RANGE_MIN_REMAINING) {
                escalateToMulti();
                continue;
              }
              await resumeSingleStream();
              continue;
            }
            throw err;
          }
          clearTimeout(stallTimer);

          if (result.done) {
            const currentPos = startOffset + bytesDelivered;
            if (hasKnownEnd && currentPos <= expectedEnd) {
              const remaining = expectedEnd - currentPos + 1;
              if (supportsRange && remaining >= MULTI_RANGE_MIN_REMAINING) {
                escalateToMulti();
                continue;
              }
              await resumeSingleStream();
              continue;
            }
            closed = true;
            controller.close();
            return;
          }

          const chunk = result.value;
          bytesDelivered += chunk.byteLength;
          windowBytes += chunk.byteLength;

          const now = Date.now();
          const elapsedTotal = now - streamStartAt;
          const elapsedWin = now - windowStartAt;

          if (
            supportsRange &&
            hasKnownEnd &&
            elapsedTotal >= THROTTLE_GRACE_MS &&
            elapsedWin >= 450
          ) {
            const winBps = (windowBytes * 1000) / elapsedWin;
            const remaining = expectedEnd - (startOffset + bytesDelivered) + 1;

            if (winBps < throttleFloorBps && remaining >= MULTI_RANGE_MIN_REMAINING) {
              controller.enqueue(chunk);
              abortCurrentReader();
              escalateToMulti();
              return;
            }
            if (elapsedWin >= 1000) {
              windowStartAt = now;
              windowBytes = 0;
            }
          }

          controller.enqueue(chunk);
          return;
        }
      } catch (err) {
        closed = true;
        try { multiPump?.abort(); } catch (_) {}
        abortCurrentReader();
        controller.error(err);
      }
    },
    cancel() {
      closed = true;
      try { multiPump?.abort(); } catch (_) {}
      abortCurrentReader();
    },
  });
}

function createContinuousStreamWithWatchdog(body, initialCtrl) {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      let timer;
      try {
        const res = await Promise.race([
          reader.read(),
          new Promise((_, rej) => {
            timer = setTimeout(() => rej(new Error("Stream inactivo")), STREAM_IDLE_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
        if (res.done) {
          controller.close();
          return;
        }
        controller.enqueue(res.value);
      } catch (err) {
        clearTimeout(timer);
        try { initialCtrl?.abort(); } catch (_) {}
        try { reader.cancel().catch(() => {}); } catch (_) {}
        controller.error(err);
      }
    },
    cancel() {
      try { initialCtrl?.abort(); } catch (_) {}
      try { reader.cancel().catch(() => {}); } catch (_) {}
    },
  });
}

// ---------------------------------------------------------------------------
// 5. ENTRYPOINT PRINCIPAL DEL WORKER
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const reqOrigin = request.headers.get("Origin");

    const corsHeaders = {
      "Access-Control-Allow-Origin": reqOrigin || "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers":
        "Content-Length, Content-Range, Content-Type, Accept-Ranges, Date, ETag, Set-Cookie, X-Proxy-Cache, X-Proxy-Resilience",
      "Vary": "Origin",
    };
    if (reqOrigin) {
      corsHeaders["Access-Control-Allow-Credentials"] = "true";
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const reqUrl = new URL(request.url);

      if (reqUrl.pathname === "/ping" || reqUrl.pathname === "/heartbeat") {
        return new Response("OK", { status: 200, headers: corsHeaders });
      }

      const throttleFloorBps =
        Number(env && env.THROTTLE_FLOOR_BPS) > 0
          ? Number(env.THROTTLE_FLOOR_BPS)
          : THROTTLE_FLOOR_BPS;

      // 1+2. IDENTIDAD (origin/referer/ua) Y URL DESTINO
      let identity;
      let targetUrl = "";
      const idMatch = reqUrl.pathname.match(/^\/i\/([A-Za-z0-9_-]+)\/(.+)$/);

      if (idMatch) {
        identity = decodeIdentity(idMatch[1]);
        targetUrl = (idMatch[2] + reqUrl.search).replace(/^(https?):\/+([^\/])/i, "$1://$2");
        targetUrl = stripControlParams(targetUrl);
      } else {
        const sp = reqUrl.searchParams;
        identity = {
          o: sp.get("origin"),
          r: sp.get("referer"),
          u: sp.get("ua") || sp.get("user-agent"),
        };

        if (reqUrl.pathname.startsWith("/p/")) {
          targetUrl = reqUrl.pathname.substring(3) + reqUrl.search;
          targetUrl = targetUrl.replace(/^(https?):\/+([^\/])/i, "$1://$2");
        } else {
          const urlMatches = request.url.match(/[?&]url=(.+)$/);
          targetUrl = urlMatches ? urlMatches[1] : sp.get("url");
        }
        if (targetUrl) targetUrl = stripControlParams(targetUrl);
      }

      if (!targetUrl) {
        return new Response("Falta el parámetro ?url= o la ruta /p/URL", {
          status: 400,
          headers: corsHeaders,
        });
      }

      try {
        if (targetUrl.includes("%3A") || targetUrl.includes("%2F")) {
          targetUrl = decodeURIComponent(targetUrl);
        }
      } catch (_) {}

      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = "https://" + targetUrl.replace(/^\/+/, "");
      }

      const parsedTarget = new URL(targetUrl);
      const targetHost = parsedTarget.hostname.toLowerCase();

      if (isBlockedHost(targetHost)) {
        return new Response("Destino bloqueado por seguridad", { status: 403, headers: corsHeaders });
      }

      if (env && env.ALLOWED_HOSTS) {
        const allowed = env.ALLOWED_HOSTS.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (allowed.length && !allowed.some((a) => targetHost === a || targetHost.endsWith(`.${a}`))) {
          return new Response("Host no autorizado", { status: 403, headers: corsHeaders });
        }
      }

      const customOrigin = normalizeOrigin(identity.o);
      const customReferer = identity.r || null;
      const customUa = identity.u || null;
      const fetchUrl = toFetchUrl(targetUrl);

      const upstreamHeaders = buildUpstreamHeaders({
        request,
        parsedTarget,
        ua: customUa,
        origin: customOrigin,
        referer: customReferer,
        chromeMajor: currentChromeMajor(env),
      });

      const cleanTarget = parsedTarget.pathname.toLowerCase();
      const kind = classify(cleanTarget);

      const staleKey = new Request(`https://stale.proxy.internal/${encodeURIComponent(fetchUrl)}`);
      const segCacheKey = new Request(`https://seg.proxy.internal/${encodeURIComponent(fetchUrl)}`);
      const clientRange = parseSingleRangeRequest(request.headers.get("range"));

      // 3. LECTURA RÁPIDA EN CACHÉ EDGE (Cache API) PARA SEGMENTOS
      if (
        request.method === "GET" &&
        kind === "segment" &&
        (!clientRange || (clientRange.start === 0 && clientRange.end === null))
      ) {
        const cachedSeg = await caches.default.match(segCacheKey).catch(() => null);
        if (cachedSeg) {
          const h = new Headers(cachedSeg.headers);
          for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
          h.set("X-Proxy-Cache", "HIT-EDGE");
          h.set("X-Proxy-Resilience", "edge-cache");
          return new Response(cachedSeg.body, { status: 200, headers: h });
        }
      }

      // 4. ACELERACIÓN PROACTIVA AUTOMÁTICA SI EL HOST YA DEMOSTRÓ BAJA VELOCIDAD
      let preFetchedOut = null;
      const shouldAutoParallel =
        request.method === "GET" &&
        (kind === "segment" || kind === "vod") &&
        (!clientRange || clientRange.end === null) &&
        hasValidTtl(throttledHosts, targetHost) &&
        !hasValidTtl(noRangeHosts, targetHost);

      if (shouldAutoParallel) {
        const probeStart = clientRange ? clientRange.start : 0;
        const probeEnd = probeStart + MULTI_CHUNK_BYTES - 1;
        const probeHeaders = new Headers(upstreamHeaders);
        probeHeaders.set("Range", `bytes=${probeStart}-${probeEnd}`);

        let probeOut = null;
        try {
          probeOut = await fetchWithRetry(
            fetchUrl,
            { method: "GET", headers: probeHeaders, redirect: "follow", cf: { cacheEverything: false } },
            { retry404: kind === "segment", hedgeDelayMs: HEDGE_DELAY_MS }
          );
        } catch (_) {
          probeOut = null;
        }

        if (probeOut && probeOut.res.status === 206) {
          const probeRes = probeOut.res;
          const cr = parseContentRange(probeRes.headers.get("content-range"));

          if (cr && cr.total && cr.end < cr.total - 1) {
            const firstBytes = await readBytesWithStallTimeout(
              probeRes.body,
              cr.end - cr.start + 1,
              STALL_TIMEOUT_MS,
              probeOut.activeCtrl
            ).catch(() => null);

            if (firstBytes) {
              const totalEnd = cr.total - 1;
              const totalLen = cr.total - probeStart;
              const ifRange = probeRes.headers.get("etag") || probeRes.headers.get("last-modified") || null;

              const pump = createMultiRangePump({
                url: fetchUrl,
                headers: upstreamHeaders,
                startByte: probeStart,
                endByte: totalEnd,
                ifRange,
                concurrency: MULTI_RANGE_CONCURRENCY,
                preloadedFirstChunk: firstBytes,
              });
              pump.start();

              let stream = new ReadableStream({
                async pull(controller) {
                  try {
                    const { value, done } = await pump.next();
                    if (done) controller.close();
                    else controller.enqueue(value);
                  } catch (err) {
                    controller.error(err);
                  }
                },
                cancel() {
                  pump.abort();
                },
              });

              const h = new Headers(probeRes.headers);
              for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
              h.delete("content-encoding");
              h.set("Accept-Ranges", "bytes");
              h.set("Content-Length", String(totalLen));
              h.set("X-Proxy-Cache", "MISS");
              h.set("X-Proxy-Resilience", `auto-multi(${MULTI_RANGE_CONCURRENCY}x)`);

              const status = clientRange ? 206 : 200;
              if (status === 206) {
                h.set("Content-Range", `bytes ${probeStart}-${totalEnd}/${cr.total}`);
              } else {
                h.delete("content-range");
              }

              if (kind === "segment") {
                h.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
                if (!clientRange && totalLen <= MAX_CACHEABLE_BYTES) {
                  const [clientBranch, cacheBranch] = stream.tee();
                  stream = clientBranch;
                  ctx.waitUntil(
                    caches.default
                      .put(segCacheKey, new Response(cacheBranch, { status: 200, headers: cleanCacheHeaders(h, SEGMENT_TTL_S) }))
                      .catch(() => {})
                  );
                }
              }

              return new Response(stream, { status, headers: h });
            }
          } else if (cr && cr.total && cr.end === cr.total - 1) {
            const h = new Headers(probeRes.headers);
            for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
            h.set("Content-Length", String(cr.total - probeStart));
            h.set("X-Proxy-Resilience", "auto-multi(1x)");
            if (!clientRange) h.delete("content-range");
            return new Response(probeRes.body, { status: clientRange ? 206 : 200, headers: h });
          } else {
            probeRes.body?.cancel();
          }
        } else if (probeOut && probeOut.res) {
          if (probeOut.res.status === 200 && !clientRange) {
            // El origen ignoró Range: lo recordamos y reutilizamos esta misma respuesta sin repetir fetch
            markMapTtl(noRangeHosts, targetHost, NO_RANGE_HOST_TTL_MS);
            preFetchedOut = probeOut;
          } else if (!probeOut.res.ok) {
            probeOut.res.body?.cancel();
          } else {
            preFetchedOut = probeOut;
          }
        }
      }

      // 5. FETCH PRINCIPAL AL ORIGEN (CACHÉ POR TIPO + HEDGING + RETRIES + STALE)
      const fetchOptions = {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
        cf: cfOptions(kind),
      };
      if (request.method !== "GET" && request.method !== "HEAD") {
        fetchOptions.body = request.body;
      }

      let out = preFetchedOut;
      if (!out) {
        try {
          out = await fetchWithRetry(fetchUrl, fetchOptions, {
            retry404: kind === "segment",
            hedgeDelayMs: kind === "stream" ? 2500 : HEDGE_DELAY_MS,
          });
        } catch (_) {
          out = null;
        }
      }

      const res = out ? out.res : null;
      const hedged = out ? out.hedged : false;
      const initialCtrl = out ? out.activeCtrl : null;

      if ((!res || res.status >= 500) && request.method === "GET") {
        const stale = await caches.default.match(staleKey).catch(() => null);
        if (stale) {
          const age = Date.now() - Number(stale.headers.get("X-Cached-At") || 0);
          if (age < STALE_MAX_MS) {
            res?.body?.cancel();
            const h = new Headers(stale.headers);
            for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
            h.set("Cache-Control", "no-cache, no-store, must-revalidate");
            h.set("X-Proxy-Cache", "STALE");
            h.set("X-Proxy-Resilience", "stale-fallback");
            return new Response(stale.body, { status: 200, headers: h });
          }
        }
      }

      if (!res) {
        return new Response("Origen no disponible", {
          status: 502,
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      if (request.method === "HEAD") {
        const headHeaders = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders)) headHeaders.set(k, v);
        headHeaders.set("X-Proxy-Resilience", hedged ? "hedged" : "direct");
        return new Response(null, { status: res.status, headers: headHeaders });
      }

      if (!res.ok && res.status !== 206) {
        const errorText = await res.text();
        return new Response(errorText, {
          status: res.status,
          headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      // 6. HELPERS PARA MANIFIESTOS Y PREFETCH
      const baseUrl = new URL("./", parsedTarget).href;
      const hasIdentity = customOrigin || customReferer || customUa;
      const proxyPrefix = hasIdentity
        ? `${reqUrl.origin}/i/${encodeIdentity({ o: customOrigin, r: customReferer, u: customUa })}/`
        : `${reqUrl.origin}/p/`;
      const manifestSearchParams = parsedTarget.search;

      function resolveUpstream(pathOrUrl) {
        const trimmed = pathOrUrl.trim();
        const isExplicitAbsolute = /^https?:\/\//i.test(trimmed);
        const resolved = new URL(trimmed, baseUrl);
        if (!resolved.search && manifestSearchParams && (!isExplicitAbsolute || resolved.origin === parsedTarget.origin)) {
          resolved.search = manifestSearchParams;
        }
        return resolved;
      }

      function makeProxied(pathOrUrl) {
        const trimmed = pathOrUrl.trim();
        if (!trimmed) return "";
        try {
          return `${proxyPrefix}${resolveUpstream(trimmed).href}`;
        } catch (_) {
          return `${proxyPrefix}${trimmed}`;
        }
      }

      function rememberManifest(text, contentType) {
        ctx.waitUntil(
          caches.default
            .put(
              staleKey,
              new Response(text, {
                headers: {
                  "Content-Type": contentType,
                  "Cache-Control": "public, max-age=120",
                  "X-Cached-At": String(Date.now()),
                },
              })
            )
            .catch(() => {})
        );
      }

      function prefetchSegments(manifestText) {
        if (!PREFETCH_COUNT) return;
        const uris = manifestText
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith("#") && !/\.(m3u8|mpd)(\?|$)/i.test(l))
          .slice(-PREFETCH_COUNT);

        const prefetchHeaders = new Headers(upstreamHeaders);
        prefetchHeaders.delete("range");

        for (const uri of uris) {
          try {
            const rawTarget = resolveUpstream(uri).href;
            const targetFetchUrl = toFetchUrl(rawTarget);
            const cacheReq = new Request(`https://seg.proxy.internal/${encodeURIComponent(targetFetchUrl)}`);

            ctx.waitUntil(
              (async () => {
                const hit = await caches.default.match(cacheReq).catch(() => null);
                if (hit) {
                  hit.body?.cancel();
                  return;
                }
                const r = await fetch(targetFetchUrl, {
                  headers: prefetchHeaders,
                  redirect: "follow",
                  cf: cfOptions("segment"),
                });
                if (!r.ok || !r.body) {
                  r.body?.cancel();
                  return;
                }
                const len = Number(r.headers.get("content-length") || 0);
                if (len > MAX_CACHEABLE_BYTES) {
                  r.body.cancel();
                  return;
                }
                await caches.default.put(
                  cacheReq,
                  new Response(r.body, { status: 200, headers: cleanCacheHeaders(r.headers, SEGMENT_TTL_S) })
                );
              })().catch(() => {})
            );
          } catch (_) {}
        }
      }

      function createResponseHeaders(defaultContentType) {
        const h = new Headers(res.headers);
        for (const [k, v] of Object.entries(corsHeaders)) h.set(k, v);
        h.delete("content-security-policy");
        h.delete("x-frame-options");
        if (defaultContentType) h.set("Content-Type", defaultContentType);
        return h;
      }

      // 7. DETECCIÓN DE CONTENIDO
      const rawContentType = (res.headers.get("content-type") || "").toLowerCase();
      let isHls = cleanTarget.endsWith(".m3u8") || rawContentType.includes("mpegurl");
      let isDash = cleanTarget.endsWith(".mpd") || rawContentType.includes("dash+xml");

      let responseText = null;
      if (!isHls && !isDash && (rawContentType.includes("xml") || rawContentType.includes("text") || cleanTarget.includes("manifest"))) {
        responseText = await res.text();
        if (responseText.includes("#EXTM3U")) isHls = true;
        else if (/<MPD[\s>]/i.test(responseText)) isDash = true;
      }

      // CASO A: HLS (.m3u8) CON ADAPTADOR CESBO ASTRA
      if (isHls) {
        const original = responseText !== null ? responseText : await res.text();
        const text = patchAstraHlsManifest(original, makeProxied);

        if (request.method === "GET" && res.status === 200) {
          rememberManifest(text, "application/vnd.apple.mpegurl; charset=utf-8");
          if (res.headers.get("cf-cache-status") !== "HIT") prefetchSegments(original);
        }

        const hlsHeaders = createResponseHeaders("application/vnd.apple.mpegurl; charset=utf-8");
        hlsHeaders.delete("content-length");
        hlsHeaders.delete("content-encoding");
        hlsHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        hlsHeaders.set("X-Proxy-Cache", res.headers.get("cf-cache-status") || "MISS");
        hlsHeaders.set("X-Proxy-Resilience", hedged ? "hedged" : "direct");

        return new Response(text, { status: res.status, headers: hlsHeaders });
      }

      // CASO B: MPEG-DASH (.mpd)
      if (isDash) {
        let text = responseText !== null ? responseText : await res.text();
        const proxiedBase = `<BaseURL>${proxyPrefix}${baseUrl}</BaseURL>`;

        if (/<BaseURL[^>]*>/i.test(text)) {
          text = text.replace(/<BaseURL([^>]*)>([^<]+)<\/BaseURL>/gi, (_, attrs, p1) => `<BaseURL${attrs}>${makeProxied(p1)}</BaseURL>`);
        } else {
          text = text.replace(/<MPD([^>]*)>/i, `<MPD$1>\n  ${proxiedBase}`);
        }
        text = text.replace(/<Location>([^<]+)<\/Location>/gi, (_, p1) => `<Location>${makeProxied(p1)}</Location>`);

        if (request.method === "GET" && res.status === 200) {
          rememberManifest(text, "application/dash+xml; charset=utf-8");
        }

        const dashHeaders = createResponseHeaders("application/dash+xml; charset=utf-8");
        dashHeaders.delete("content-length");
        dashHeaders.delete("content-encoding");
        dashHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        dashHeaders.set("X-Proxy-Cache", res.headers.get("cf-cache-status") || "MISS");
        dashHeaders.set("X-Proxy-Resilience", hedged ? "hedged" : "direct");

        return new Response(text, { status: res.status, headers: dashHeaders });
      }

      // CASO C: STREAM CONTINUO MPEG-TS (SIN CACHÉ, CON WATCHDOG ANTI-CONGELAMIENTO)
      const binaryHeaders = createResponseHeaders();
      const cacheStatus = res.headers.get("cf-cache-status");
      if (cacheStatus) binaryHeaders.set("X-Proxy-Cache", cacheStatus);

      const contentLenHeader = Number(res.headers.get("content-length") || 0);
      const isLiveContinuous =
        kind === "stream" ||
        (rawContentType.includes("mp2t") && !cleanTarget.endsWith(".ts")) ||
        (!contentLenHeader && rawContentType.includes("octet-stream") && kind === "other");

      if (isLiveContinuous) {
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
        binaryHeaders.set("X-Proxy-Resilience", hedged ? "hedged-stream" : "live-stream");
        const streamBody = res.body ? createContinuousStreamWithWatchdog(res.body, initialCtrl) : null;
        return new Response(streamBody, { status: res.status, headers: binaryHeaders });
      }

      // CASO D: SEGMENTOS / VOD / BINARIOS CON BLINDAJE ANTI-THROTTLING Y ANTI-STALL
      if (cleanTarget.endsWith(".ts")) {
        binaryHeaders.set("Content-Type", "video/mp2t");
        binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
      } else if (cleanTarget.endsWith(".m4s") || cleanTarget.endsWith(".cmfv") || cleanTarget.endsWith(".cmfa")) {
        binaryHeaders.set("Content-Type", "video/iso.segment");
        binaryHeaders.set("Cache-Control", `public, max-age=${SEGMENT_TTL_S}`);
      } else if (rawContentType.includes("octet-stream") && kind !== "vod") {
        binaryHeaders.set("Content-Type", "video/mp2t");
      }

      if (!res.body || request.method !== "GET") {
        return new Response(responseText !== null ? responseText : res.body, {
          status: res.status,
          headers: binaryHeaders,
        });
      }

      const contentEncoding = (res.headers.get("content-encoding") || "").toLowerCase();
      const isCompressed = contentEncoding !== "" && contentEncoding !== "identity";
      const acceptRangesHeader = (res.headers.get("accept-ranges") || "").toLowerCase();
      const supportsRange = !isCompressed && (acceptRangesHeader.includes("bytes") || res.status === 206);
      const cr = parseContentRange(res.headers.get("content-range"));
      const ifRange = res.headers.get("etag") || res.headers.get("last-modified") || null;

      let startOffset = 0;
      let expectedEnd = NaN;
      if (!isCompressed) {
        if (res.status === 206 && cr) {
          startOffset = cr.start;
          expectedEnd = cr.end;
        } else if (res.status === 200 && contentLenHeader > 0) {
          startOffset = 0;
          expectedEnd = contentLenHeader - 1;
        }
      }

      let outStream = createResilientBody({
        initialRes: res,
        initialCtrl,
        fetchUrl,
        targetHost,
        upstreamHeaders,
        expectedEnd,
        startOffset,
        supportsRange,
        ifRange,
        throttleFloorBps,
        concurrency: MULTI_RANGE_CONCURRENCY,
      });

      const expectedTotal = Number.isFinite(expectedEnd) ? expectedEnd - startOffset + 1 : 0;
      if (
        kind === "segment" &&
        res.status === 200 &&
        (!expectedTotal || expectedTotal <= MAX_CACHEABLE_BYTES)
      ) {
        const [clientBranch, cacheBranch] = outStream.tee();
        outStream = clientBranch;
        ctx.waitUntil(
          caches.default
            .put(segCacheKey, new Response(cacheBranch, { status: 200, headers: cleanCacheHeaders(binaryHeaders, SEGMENT_TTL_S) }))
            .catch(() => {})
        );
      }

      binaryHeaders.set("X-Proxy-Resilience", hedged ? "hedged-adaptive" : "adaptive");
      return new Response(outStream, { status: res.status, headers: binaryHeaders });
    } catch (err) {
      return new Response("Error al procesar stream: " + err.message, {
        status: 500,
        headers: corsHeaders,
      });
    }
  },
};
