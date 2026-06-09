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
const KV_CACHE_KEY  = "priceCache_v9"; // v9: replaced broken spark with chart endpoint
const KV_CRUMB_KEY  = "yahooSession_v1";
const CRUMB_TTL_MS  = 55 * 60 * 1000; // 55 minutes
const USER_AGENT    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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

// ── HISTORICAL CHANGE HELPER ─────────────────────────────────────────────────
function getHistoricalChanges(timestamps, closes, currentPrice) {
  if (!timestamps || !closes || timestamps.length === 0 || !currentPrice) return {};

  const now = Date.now() / 1000;

  // Per-period tolerance: how many calendar days the nearest bar can be off-target.
  // Wider for longer periods to absorb weekends, holidays, and sparse data.
  const targets = {
    "5D":  { ts: now - 7   * 86400, maxGapDays: 10 },
    "1M":  { ts: now - 30  * 86400, maxGapDays: 10 },
    "6M":  { ts: now - 182 * 86400, maxGapDays: 14 },
    "YTD": { ts: new Date(new Date().getFullYear(), 0, 1).getTime() / 1000, maxGapDays: 10 },
    "1Y":  { ts: now - 365 * 86400, maxGapDays: 14 },
  };

  const changes = {};

  for (const [period, { ts: targetTs, maxGapDays }] of Object.entries(targets)) {
    let bestIdx = -1;
    let minDiff = Infinity;

    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      const diff = Math.abs(timestamps[i] - targetTs);
      if (diff < minDiff) { minDiff = diff; bestIdx = i; }
    }

    if (bestIdx !== -1 && minDiff < maxGapDays * 86400) {
      const oldPrice = closes[bestIdx];
      changes[period] = oldPrice > 0
        ? parseFloat((((currentPrice - oldPrice) / oldPrice) * 100).toFixed(2))
        : null;
    } else {
      changes[period] = null;
    }
  }
  return changes;
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

  const { searchParams } = new URL(request.url);
  const tickersParam = searchParams.get("tickers");
  const tickers = tickersParam ? [...new Set(tickersParam.split(",").filter(Boolean))] : [];

  if (!tickers.length) {
    return new Response(JSON.stringify({ error: "No tickers provided" }), { status: 400, headers });
  }

  const allStrip = tickers.length > 0 && tickers.every(t => STRIP_TICKERS.has(t));
  if (allStrip) {
    const stripResults = {};
    const FINNHUB_KEY = env.FINNHUB_KEY;

    await Promise.all([
      (async () => {
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
              stripResults[q.symbol] = { price: parseFloat(price.toFixed(2)), change: parseFloat(change.toFixed(2)), session };
            }
          }
        } catch (err) {}
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

  if (env.SHARED_DATA) {
    try {
      const cached = await env.SHARED_DATA.get(KV_CACHE_KEY, "json");
      if (cached && cached.timestamp && (Date.now() - cached.timestamp < CACHE_TTL_SECONDS * 1000)) {
        const allPresent = tickers.every(t => cached.data && t in cached.data);
        if (allPresent) return new Response(JSON.stringify({ data: cached.data, cached: true }), { status: 200, headers });
      }
    } catch (err) {}
  }

  const results = {};
  const FINNHUB_KEY = env.FINNHUB_KEY;

  try {
    const { cookie, crumb } = await getYahooSession(env);
    const batchSize = 40;
    
    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);

      // ── STEP 1: Fetch 2-year daily chart history for every ticker in parallel.
      // Uses /v8/finance/chart per ticker — the same endpoint that powers the
      // Bloomberg macro charts and is confirmed to work reliably.
      // The /v8/finance/spark endpoint has been removed; it silently returned
      // empty results and was the root cause of all non-1D percentages being blank.
      const chartData = {};
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
              };
            }
          }
        } catch (e) {}
      }));

      // ── STEP 2: Fetch current quote data for the batch
      const url = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${batch.join(",")}&corsDomain=finance.yahoo.com&formatted=false&crumb=${encodeURIComponent(crumb)}`;
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, "Cookie": cookie } });

      if (res.ok) {
        const data = await res.json();
        const quoteList = data?.quoteResponse?.result || [];

        for (const q of quoteList) {
          if (q.regularMarketPrice === undefined) continue;

          const state = q.marketState;
          let price, change, session;

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

          const currentPrice = parseFloat(price.toFixed(2));
          const cd = chartData[q.symbol];
          const extraChanges = cd
            ? getHistoricalChanges(cd.timestamps, cd.closes, currentPrice)
            : {};

          results[q.symbol] = {
            price:      currentPrice,
            change:     parseFloat(change.toFixed(2)),
            change5D:   extraChanges["5D"]  ?? null,
            change1M:   extraChanges["1M"]  ?? null,
            change6M:   extraChanges["6M"]  ?? null,
            changeYTD:  extraChanges["YTD"] ?? null,
            change1Y:   extraChanges["1Y"]  ?? null,
            session,
            week52Low:  q.fiftyTwoWeekLow  != null ? parseFloat(q.fiftyTwoWeekLow.toFixed(2))  : null,
            week52High: q.fiftyTwoWeekHigh != null ? parseFloat(q.fiftyTwoWeekHigh.toFixed(2)) : null,
            earningsDate: q.earningsTimestamp || q.earningsTimestampStart || null,
          };
        }
      } else if (res.status === 401 || res.status === 403) {
        if (env.SHARED_DATA) {
          try { await env.SHARED_DATA.delete(KV_CRUMB_KEY); } catch {}
        }
      }
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
      const cachePayload = JSON.stringify({ data: results, timestamp: Date.now() });
      await env.SHARED_DATA.put(KV_CACHE_KEY, cachePayload, { expirationTtl: CACHE_TTL_SECONDS * 4 });
    } catch (err) {}
  }

  return new Response(JSON.stringify({ data: results, cached: false }), { status: 200, headers });
}
