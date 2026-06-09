// functions/quote.js

const KV_CRUMB_KEY = "yahooSession_v1";
const CRUMB_TTL_MS = 55 * 60 * 1000; // 55 minutes
const USER_AGENT   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

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
// Shared with prices.js — reads from KV first, fetches fresh only when stale.
// Both functions use the same KV_CRUMB_KEY so they share the cached session.
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
    } catch (err) {
      console.error("KV crumb write error:", err);
    }
  }

  return { cookie, crumb };
}

// ── REQUEST HANDLER ──────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;

  // Restrict CORS to your actual domain (set ALLOWED_ORIGIN as a Cloudflare env var)
  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Vary": "Origin",
    "Cache-Control": "public, max-age=300, s-maxage=300"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    });
  }

  const { searchParams } = new URL(request.url);
  const ticker = searchParams.get("ticker");

  if (!ticker) {
    return new Response(JSON.stringify({ error: "No ticker provided" }), { status: 400, headers });
  }

  try {
    // getYahooSession() uses KV — no extra round trips when the crumb is warm
    const { cookie, crumb } = await getYahooSession(env);

    const modules = "assetProfile,summaryDetail,price,financialData,defaultKeyStatistics,calendarEvents";

    // Fetch Quote Summary, 1-Month Chart, AND Latest News simultaneously
    const quoteUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=${modules}&crumb=${crumb}`;
    const chartUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1mo&interval=1d&crumb=${crumb}`;
    const newsUrl  = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=1&crumb=${crumb}`;

    const [quoteRes, chartRes, newsRes] = await Promise.all([
      fetch(quoteUrl, { headers: { "User-Agent": USER_AGENT, "Cookie": cookie } }),
      fetch(chartUrl, { headers: { "User-Agent": USER_AGENT, "Cookie": cookie } }),
      fetch(newsUrl,  { headers: { "User-Agent": USER_AGENT, "Cookie": cookie } }),
    ]);

    // If Yahoo rejects the crumb, evict it so the next request fetches fresh
    if (quoteRes.status === 401 || quoteRes.status === 403) {
      if (env.SHARED_DATA) {
        try { await env.SHARED_DATA.delete(KV_CRUMB_KEY); } catch {}
      }
      return new Response(JSON.stringify({ error: "Yahoo session expired, please retry" }), { status: 503, headers });
    }

    const quoteData = await quoteRes.json();
    const chartData = await chartRes.json();
    const newsData  = await newsRes.json();

    // Merge responses into a single payload
    return new Response(JSON.stringify({
      quoteSummary: quoteData.quoteSummary,
      chart:        chartData.chart,
      news:         newsData?.news?.[0] || null, // Extract the single latest news item
    }), { status: 200, headers });

  } catch (err) {
    return new Response(JSON.stringify({ error: "Fetch failed" }), { status: 500, headers });
  }
}
