// functions/prices.js

const CACHE_TTL_SECONDS = 60; // 1 minute — keeps KV writes well under the 1,000/day free tier limit
const STRIP_TICKERS  = new Set(["^GSPC", "^DJI", "^IXIC", "BTC-USD", "ETH-USD", "XRP-USD"]);
const INDEX_TICKERS  = ["^GSPC", "^DJI", "^IXIC"];
const CRYPTO_TICKERS = ["BTC-USD", "ETH-USD", "XRP-USD"];
const FINNHUB_CRYPTO_MAP = {
  "BTC-USD": "BINANCE:BTCUSDT",
  "ETH-USD": "BINANCE:ETHUSDT",
  "XRP-USD": "BINANCE:XRPUSDT",
};
const KV_CACHE_KEY  = "priceCache_v10"; // v10: covered-set hit check (see below)
const KV_REFS_KEY   = "priceRefs_v1";   // long-lived per-ticker reference data
const REFS_TTL_MS   = 6 * 60 * 60 * 1000; // history refs change ~daily; 6h is plenty
const QUOTE_STALE_SEC = 20 * 60;        // v7 quote older than this → live-probe it
const KV_CRUMB_KEY  = "yahooSession_v1";
const CRUMB_TTL_MS  = 55 * 60 * 1000; // 55 minutes
const USER_AGENT    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
// Single-request sanity bound, not the abuse ceiling (/prices has no per-IP
// limit, so volume is the real lever). Sized well above the largest real
// active-view request (~197 tickers / ~933 chars) with room to grow. The query
// length is raised in step with the ticker cap so it doesn't become the hidden
// binding limit — 500 tickers averaging ~5 chars is ~3000 chars.
const MAX_TICKERS = 500;
const MAX_TICKERS_QUERY_LENGTH = 4096;
const TICKER_PATTERN = /^[A-Z0-9^][A-Z0-9.^=-]{0,14}$/;

// ── COOKIE HELPER ────────────────────────────────────────────────────────────
// Headers.get("set-cookie") collapses multiple cookies into one comma-joined
// string, so .split(";")[0] can mangle the session. getSetCookie() returns each
// Set-Cookie header separately; we keep the name=value pair from each and rejoin.
function parseCookies(headers) {
  const raw = typeof headers.getSetCookie === "function"
    ? headers.getSetCookie()
    : (headers.get("set-cookie") ? [headers.get("set-cookie")] : []);
  return raw.map(c => c.split(";")[0]).filter(Boolean).join("; ");
}

// ── CRUMB HELPER ─────────────────────────────────────────────────────────────
async function getYahooSession(env) {
  if (env.SHARED_DATA) {
    try {
      const cached = await env.SHARED_DATA.get(KV_CRUMB_KEY, "json");
      if (cached && cached.timestamp && (Date.now() - cached.timestamp < CRUMB_TTL_MS)) {
        return { cookie: cached.cookie, crumb: cached.crumb };
      }
    } catch (err) {
      console.error("KV crumb read error:", err);
    }
  }

  const cookieRes = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": USER_AGENT } });
  const cookie    = parseCookies(cookieRes.headers);

  const crumbRes = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    headers: { "User-Agent": USER_AGENT, "Cookie": cookie }
  });
  const crumb = await crumbRes.text();

  if (env.SHARED_DATA) {
    try {
      await env.SHARED_DATA.put(
        KV_CRUMB_KEY,
        JSON.stringify({ cookie, crumb, timestamp: Date.now() }),
        { expirationTtl: 3600 }
      );
    } catch (err) {}
  }

  return { cookie, crumb };
}

// ── CHART-META FALLBACK ──────────────────────────────────────────────────────
// Yahoo's v7/finance/quote endpoint periodically freezes, serving every symbol
// a snapshot of the previous close (observed 2026-07-14: regularMarketTime
// stuck at Monday's 4:00 PM close all Tuesday morning). The v8 chart endpoint
// keeps ticking through these outages — its meta.regularMarketPrice is a live
// quote. This derives {price, change} from 2y chart data: previous close is
// the bar before today's (today's daily bar updates in near-realtime during
// the session), or the last bar if today's hasn't opened.
function chartFallback(cd) {
  if (cd?.metaPrice == null) return null;
  const pts = [];
  for (let i = 0; i < (cd.timestamps?.length ?? 0); i++) {
    if (cd.closes?.[i] != null) pts.push({ ts: cd.timestamps[i], close: cd.closes[i] });
  }
  let prev = null;
  if (pts.length) {
    const day = t => new Date(t * 1000).toISOString().slice(0, 10);
    const last = pts[pts.length - 1];
    prev = (cd.metaTime && day(last.ts) === day(cd.metaTime) && pts.length >= 2)
      ? pts[pts.length - 2].close
      : last.close;
  }
  return {
    price: cd.metaPrice,
    change: prev > 0 ? ((cd.metaPrice - prev) / prev) * 100 : 0,
  };
}

// A v7 quote is stale when the chart meta has traded meaningfully past it.
function quoteIsStale(q, cd) {
  if (cd?.metaPrice == null) return false;
  return q?.regularMarketTime == null || (cd.metaTime ?? 0) > q.regularMarketTime + 120;
}

// ── REFERENCE PRICES ─────────────────────────────────────────────────────────
// The 5D/1M/6M/YTD/1Y percentages only need one historical close each, and
// those change once per trading day — refetching 2 years of daily bars per
// ticker every 30s refresh was ~95% of this function's Yahoo traffic. We
// instead resolve each period to its reference CLOSE once, cache the refs in
// KV for REFS_TTL_MS, and recompute the percentage against the live price on
// every request (so cached refs never serve a stale current-day number).
function findRefPrices(timestamps, closes) {
  if (!timestamps || !closes || timestamps.length === 0) return {};

  const now = Date.now() / 1000;

  // Per-period tolerance: how many calendar days the nearest bar can be off-target.
  // Wider for longer periods to absorb weekends, holidays, and sparse data.
  const targets = {
    r5D:  { ts: now - 7   * 86400, maxGapDays: 10 },
    r1M:  { ts: now - 30  * 86400, maxGapDays: 10 },
    r6M:  { ts: now - 182 * 86400, maxGapDays: 14 },
    rYTD: { ts: new Date(new Date().getFullYear(), 0, 1).getTime() / 1000, maxGapDays: 10 },
    r1Y:  { ts: now - 365 * 86400, maxGapDays: 14 },
  };

  const refs = {};
  for (const [key, { ts: targetTs, maxGapDays }] of Object.entries(targets)) {
    let bestIdx = -1;
    let minDiff = Infinity;
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      const diff = Math.abs(timestamps[i] - targetTs);
      if (diff < minDiff) { minDiff = diff; bestIdx = i; }
    }
    refs[key] = (bestIdx !== -1 && minDiff < maxGapDays * 86400 && closes[bestIdx] > 0)
      ? parseFloat(closes[bestIdx].toFixed(4))
      : null;
  }
  return refs;
}

function pctFrom(ref, price) {
  return (ref > 0 && price > 0)
    ? parseFloat((((price - ref) / ref) * 100).toFixed(2))
    : null;
}

// ── REQUEST HANDLER ──────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;

  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Vary": "Origin",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    });
  }

  if (request.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers });
  }

  const { searchParams } = new URL(request.url);
  const tickersParam = searchParams.get("tickers");
  if (!tickersParam) {
    return new Response(JSON.stringify({ error: "No tickers provided" }), { status: 400, headers });
  }

  if (tickersParam.length > MAX_TICKERS_QUERY_LENGTH) {
    return new Response(
      JSON.stringify({ error: `Ticker query exceeds ${MAX_TICKERS_QUERY_LENGTH} characters` }),
      { status: 414, headers }
    );
  }

  const requestedTickers = tickersParam.split(",").map(ticker => ticker.trim().toUpperCase());
  const invalidTickers = requestedTickers.filter(ticker => !TICKER_PATTERN.test(ticker));
  if (invalidTickers.length) {
    return new Response(
      JSON.stringify({ error: "Invalid ticker format", tickers: invalidTickers.slice(0, 5) }),
      { status: 400, headers }
    );
  }

  const tickers = [...new Set(requestedTickers)];
  if (tickers.length > MAX_TICKERS) {
    return new Response(
      JSON.stringify({ error: `A maximum of ${MAX_TICKERS} tickers is allowed` }),
      { status: 400, headers }
    );
  }

  const allStrip = tickers.length > 0 && tickers.every(t => STRIP_TICKERS.has(t));
  if (allStrip) {
    const stripResults = {};
    const FINNHUB_KEY = env.FINNHUB_KEY;

    await Promise.all([
      (async () => {
        const v7 = {};
        try {
          const { cookie, crumb } = await getYahooSession(env);
          const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${INDEX_TICKERS.join(",")}&corsDomain=finance.yahoo.com&formatted=false&crumb=${crumb}`;
          const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Cookie": cookie } });
          if (res.ok) {
            const data = await res.json();
            const quotes = data?.quoteResponse?.result || [];
            for (const q of quotes) {
              if (q.regularMarketPrice === undefined) continue;
              const state = q.marketState;
              let price, change, session;
              if (state === "POST" || state === "POSTPOST") {
                price = q.postMarketPrice ?? q.regularMarketPrice;
                change = q.postMarketChangePercent ?? q.regularMarketChangePercent ?? 0;
                session = "POST";
              } else if (state === "PRE") {
                price = q.preMarketPrice ?? q.regularMarketPrice;
                change = q.preMarketChangePercent ?? q.regularMarketChangePercent ?? 0;
                session = "PRE";
              } else if (state === "CLOSED") {
                price = q.postMarketPrice ?? q.regularMarketPrice;
                change = q.postMarketChangePercent ?? q.regularMarketChangePercent ?? 0;
                session = q.postMarketPrice != null ? "POST" : "CLOSED";
              } else {
                price = q.regularMarketPrice;
                change = q.regularMarketChangePercent ?? 0;
                session = "REGULAR";
              }
              v7[q.symbol] = { price: parseFloat(price.toFixed(2)), change: parseFloat(change.toFixed(2)), session, time: q.regularMarketTime ?? 0 };
            }
          }
        } catch (err) {}

        // v7 freeze protection (see chartFallback): the 1d chart meta keeps
        // ticking when v7 serves a frozen snapshot; prefer whichever is fresher.
        await Promise.all(INDEX_TICKERS.map(async (t) => {
          try {
            const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1d&interval=5m`, { headers: { "User-Agent": USER_AGENT } });
            if (!res.ok) return;
            const meta = (await res.json())?.chart?.result?.[0]?.meta;
            if (meta?.regularMarketPrice == null) return;
            const q7 = v7[t];
            if (q7 && (meta.regularMarketTime ?? 0) <= q7.time + 120) return; // v7 is fresh — keep its pre/post awareness
            const prev = meta.chartPreviousClose;
            const change = prev > 0 ? ((meta.regularMarketPrice - prev) / prev) * 100 : 0;
            stripResults[t] = { price: parseFloat(meta.regularMarketPrice.toFixed(2)), change: parseFloat(change.toFixed(2)), session: "REGULAR" };
          } catch (err) {}
        }));
        for (const t of INDEX_TICKERS) {
          if (!stripResults[t] && v7[t]) {
            stripResults[t] = { price: v7[t].price, change: v7[t].change, session: v7[t].session };
          }
        }
      })(),
      ...CRYPTO_TICKERS.map(async (yahooSymbol) => {
        if (!FINNHUB_KEY) return;
        const finnhubSymbol = FINNHUB_CRYPTO_MAP[yahooSymbol];
        if (!finnhubSymbol) return;
        try {
          const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${finnhubSymbol}&token=${FINNHUB_KEY}`);
          if (res.ok) {
            const q = await res.json();
            if (q.c != null && q.c > 0) {
              const change = q.dp != null ? q.dp : (q.pc > 0 ? ((q.c - q.pc) / q.pc) * 100 : 0);
              stripResults[yahooSymbol] = { price: parseFloat(q.c.toFixed(2)), change: parseFloat(change.toFixed(2)), session: "REGULAR" };
            }
          }
        } catch (err) {}
      }),
    ]);
    return new Response(JSON.stringify({ data: stripResults, cached: false }), { status: 200, headers });
  }

  // ── QUOTE CACHE (60s) ──────────────────────────────────────────────────────
  // The hit check is subset-based against the set of tickers the cached cycle
  // ATTEMPTED ("covered"), not the set that resolved. A dead or delisted
  // ticker used to make `t in data` fail forever, forcing every request down
  // the uncached path — one bad symbol poisoned the whole board's cache.
  if (env.SHARED_DATA) {
    try {
      const cached = await env.SHARED_DATA.get(KV_CACHE_KEY, "json");
      if (cached && cached.timestamp && (Date.now() - cached.timestamp < CACHE_TTL_SECONDS * 1000)) {
        const covered = new Set(cached.covered ?? Object.keys(cached.data ?? {}));
        if (tickers.every(t => covered.has(t))) {
          return new Response(JSON.stringify({ data: cached.data, cached: true }), { status: 200, headers });
        }
      }
    } catch (err) {}
  }

  const results = {};
  const FINNHUB_KEY = env.FINNHUB_KEY;

  // Long-lived reference data (historical closes, 52wk range, earnings date)
  let refs = null;
  if (env.SHARED_DATA) {
    try { refs = await env.SHARED_DATA.get(KV_REFS_KEY, "json"); } catch (err) {}
  }
  const refsFresh = !!(refs?.timestamp && (Date.now() - refs.timestamp < REFS_TTL_MS));
  if (!refs || typeof refs.data !== "object" || refs.data == null) refs = { timestamp: 0, data: {} };
  const needRefs = refsFresh ? tickers.filter(t => !refs.data[t]) : [...tickers];
  let refsDirty = false;

  try {
    const { cookie, crumb } = await getYahooSession(env);

    // ── STEP 1: rebuild reference data where missing/expired (2y chart per
    // ticker). On warm cycles this set is EMPTY, so the expensive per-ticker
    // history fetches happen once per REFS_TTL_MS instead of every refresh.
    const chartData = {};
    for (let i = 0; i < needRefs.length; i += 40) {
      const batch = needRefs.slice(i, i + 40);
      await Promise.all(batch.map(async (ticker) => {
        try {
          const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d&crumb=${encodeURIComponent(crumb)}`;
          const chartRes = await fetch(chartUrl, { headers: { "User-Agent": USER_AGENT, "Cookie": cookie } });
          if (chartRes.ok) {
            const cd = await chartRes.json();
            const r  = cd?.chart?.result?.[0];
            if (r?.timestamp?.length) {
              chartData[ticker] = {
                timestamps: r.timestamp,
                closes:     r.indicators?.quote?.[0]?.close || [],
                metaPrice:  r.meta?.regularMarketPrice ?? null,
                metaTime:   r.meta?.regularMarketTime ?? null,
                meta52Low:  r.meta?.fiftyTwoWeekLow ?? null,
                meta52High: r.meta?.fiftyTwoWeekHigh ?? null,
              };
            }
          }
        } catch (e) {}
      }));
    }
    for (const [tkr, cd] of Object.entries(chartData)) {
      refs.data[tkr] = {
        ...findRefPrices(cd.timestamps, cd.closes),
        w52L: cd.meta52Low,
        w52H: cd.meta52High,
        earnings: refs.data[tkr]?.earnings ?? null,
      };
      refsDirty = true;
    }

    // ── STEP 2: live quotes for every requested ticker (1 call per 40)
    const quotes = {};
    for (let i = 0; i < tickers.length; i += 40) {
      const batch = tickers.slice(i, i + 40);
      const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${batch.join(",")}&corsDomain=finance.yahoo.com&formatted=false&crumb=${encodeURIComponent(crumb)}`;
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Cookie": cookie } });
      if (res.ok) {
        const data = await res.json();
        for (const q of data?.quoteResponse?.result || []) quotes[q.symbol] = q;
      } else if (res.status === 401 || res.status === 403) {
        if (env.SHARED_DATA) {
          try { await env.SHARED_DATA.delete(KV_CRUMB_KEY); } catch {}
        }
      }
    }

    // ── STEP 3: live-probe tickers v7 dropped or went stale on (frozen-v7
    // outages, delistings, symbol drift). The 1d chart meta is a live quote.
    const probes = {};
    const nowSec = Date.now() / 1000;
    const needProbe = tickers.filter(t => {
      if (chartData[t]?.metaPrice != null) return false; // this cycle already has live meta
      const q = quotes[t];
      return !q || q.regularMarketPrice === undefined || q.regularMarketTime == null
        || (nowSec - q.regularMarketTime) > QUOTE_STALE_SEC;
    });
    for (let i = 0; i < needProbe.length; i += 40) {
      const batch = needProbe.slice(i, i + 40);
      await Promise.all(batch.map(async (t) => {
        try {
          const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=1d&interval=5m`, { headers: { "User-Agent": USER_AGENT } });
          if (!res.ok) return;
          const meta = (await res.json())?.chart?.result?.[0]?.meta;
          if (meta?.regularMarketPrice == null) return;
          probes[t] = {
            metaPrice: meta.regularMarketPrice,
            metaTime:  meta.regularMarketTime ?? null,
            prevClose: meta.chartPreviousClose ?? null,
          };
        } catch (e) {}
      }));
    }

    // ── STEP 4: assemble results — v7 when fresh (keeps pre/post sessions),
    // chart meta when v7 is stale or missing the symbol.
    for (const tkr of tickers) {
      const q = quotes[tkr];
      const cd = chartData[tkr];
      const probe = probes[tkr];

      let price = null, change = 0, session = "REGULAR";
      if (q?.regularMarketPrice !== undefined) {
        const state = q.marketState;
        if (state === "POST" || state === "POSTPOST") {
          price   = q.postMarketPrice ?? q.regularMarketPrice;
          change  = q.postMarketChangePercent ?? q.regularMarketChangePercent ?? 0;
          session = "POST";
        } else if (state === "PRE") {
          price   = q.preMarketPrice ?? q.regularMarketPrice;
          change  = q.preMarketChangePercent ?? q.regularMarketChangePercent ?? 0;
          session = "PRE";
        } else if (state === "CLOSED") {
          if (q.postMarketPrice != null) {
            price   = q.postMarketPrice;
            change  = q.postMarketChangePercent ?? q.regularMarketChangePercent ?? 0;
            session = "POST";
          } else {
            price   = q.regularMarketPrice;
            change  = q.regularMarketChangePercent ?? 0;
            session = "CLOSED";
          }
        } else {
          price   = q.regularMarketPrice;
          change  = q.regularMarketChangePercent ?? 0;
          session = "REGULAR";
        }
      }

      if (cd && quoteIsStale(q, cd)) {
        const fb = chartFallback(cd);
        if (fb) { price = fb.price; change = fb.change; session = "REGULAR"; }
      } else if (probe?.metaPrice != null
                 && (price == null || (probe.metaTime ?? 0) > (q?.regularMarketTime ?? 0) + 120)) {
        price   = probe.metaPrice;
        change  = probe.prevClose > 0 ? ((probe.metaPrice - probe.prevClose) / probe.prevClose) * 100 : 0;
        session = "REGULAR";
      }

      if (price == null) continue; // Finnhub fallback below

      const currentPrice = parseFloat(price.toFixed(2));
      const r = refs.data[tkr] || {};
      const qEarnings = q?.earningsTimestamp || q?.earningsTimestampStart || null;
      if (qEarnings && refs.data[tkr] && refs.data[tkr].earnings !== qEarnings) {
        refs.data[tkr].earnings = qEarnings;
        if (needRefs.includes(tkr)) refsDirty = true; // persist on rebuild cycles only
      }

      results[tkr] = {
        price:      currentPrice,
        change:     parseFloat(change.toFixed(2)),
        change5D:   pctFrom(r.r5D,  currentPrice),
        change1M:   pctFrom(r.r1M,  currentPrice),
        change6M:   pctFrom(r.r6M,  currentPrice),
        changeYTD:  pctFrom(r.rYTD, currentPrice),
        change1Y:   pctFrom(r.r1Y,  currentPrice),
        session,
        week52Low:  q?.fiftyTwoWeekLow  != null ? parseFloat(q.fiftyTwoWeekLow.toFixed(2))  : (r.w52L != null ? parseFloat(r.w52L.toFixed(2)) : null),
        week52High: q?.fiftyTwoWeekHigh != null ? parseFloat(q.fiftyTwoWeekHigh.toFixed(2)) : (r.w52H != null ? parseFloat(r.w52H.toFixed(2)) : null),
        earningsDate: qEarnings || r.earnings || null,
      };
    }

    const MACRO_TICKERS = new Set(["^GSPC", "^DJI", "^IXIC", "BTC-USD", "ETH-USD", "XRP-USD"]);
    const macrosToFetch = tickers.filter(t => MACRO_TICKERS.has(t));

    if (macrosToFetch.length > 0) {
      await Promise.all(macrosToFetch.map(async (t) => {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?range=2d&interval=15m&crumb=${crumb}`;
          const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Cookie": cookie } });
          if (res.ok) {
            const data = await res.json();
            const result = data.chart?.result?.[0];
            if (result && result.indicators?.quote?.[0]?.close) {
               results[t] = results[t] || {};
               results[t].chartData = result.indicators.quote[0].close;
               results[t].chartTimestamps = result.timestamp;
            }
          }
        } catch (e) {}
      }));
    }
  } catch (err) {}

  const missingTickers = tickers.filter(t => !results[t]);
  if (missingTickers.length > 0 && FINNHUB_KEY) {
    const safeMissing = missingTickers.slice(0, 45);
    const BATCH_SIZE  = 8;
    async function fetchFinnhub(t) {
      try {
        const res = await fetch(`https://finnhub.io/api/v1/quote?symbol=${t}&token=${FINNHUB_KEY}`);
        if (res.ok) {
          const quote = await res.json();
          if (quote.dp !== null && quote.dp !== undefined) {
            results[t] = { price: parseFloat((quote.c ?? 0).toFixed(2)), change: parseFloat(quote.dp.toFixed(2)), session: "REGULAR" };
          }
        }
      } catch (e) {}
    }
    for (let i = 0; i < safeMissing.length; i += BATCH_SIZE) {
      const batch = safeMissing.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(fetchFinnhub));
      if (i + BATCH_SIZE < safeMissing.length) await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  if (Object.keys(results).length > 0 && env.SHARED_DATA) {
    try {
      // covered = every ticker this cycle ATTEMPTED, resolved or not — so a
      // dead symbol can't force every future request down the uncached path.
      const cachePayload = JSON.stringify({ data: results, covered: tickers, timestamp: Date.now() });
      await env.SHARED_DATA.put(KV_CACHE_KEY, cachePayload, { expirationTtl: CACHE_TTL_SECONDS * 4 });
    } catch (err) {}
    if (refsDirty) {
      try {
        refs.timestamp = refsFresh ? refs.timestamp : Date.now();
        await env.SHARED_DATA.put(KV_REFS_KEY, JSON.stringify(refs), { expirationTtl: 172800 });
      } catch (err) {}
    }
  }

  return new Response(JSON.stringify({ data: results, cached: false }), { status: 200, headers });
}
