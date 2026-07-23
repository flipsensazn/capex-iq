// watchlist-prewarm — scheduled Worker that keeps the /prices KV cache warm.
//
// Every 2 minutes during market hours it assembles the FULL ticker universe
// (all three capex maps + scanner pool + shortlist + market strip + pinned
// hubs) and makes one /prices request through the public site. That request
// populates the shared KV quote cache with a covered-set that is a superset
// of anything a real visitor asks for, so client refreshes are cache hits.
//
// No bindings needed — it warms through the same public endpoints the
// frontend uses, so cache keys, TTLs, and fallback logic stay in one place
// (functions/prices.js).

// The custom domain, NOT the workers.dev URL: a Worker cannot fetch()
// same-account workers.dev hostnames (error 1042), but Custom Domains are
// explicitly supported for worker-to-worker addressing.
const BASE = "https://capex-iq.us";

// Mirrors App.jsx — keep in sync if those constants change.
const MARKET_TICKERS = [
  "^GSPC", "^DJI", "^IXIC",          // INDEX_TICKERS
  "BTC-USD", "ETH-USD", "XRP-USD",   // CRYPTO_TICKERS
  "AMZN", "MSFT", "GOOG", "META", "ORCL", // HYPERSCALER_TICKERS
];
// PINNED_TICKERS: public Sankey hubs not present in a capex map
// (MUSK_COMPANIES / ROBOTICS_COMPANIES with isPublic, ticker ?? id).
const PINNED_TICKERS = ["TSLA", "CCXI", "XPEV", "BYDDY"];

async function getJson(path) {
  try {
    const res = await fetch(`${BASE}${path}`);
    return res.ok ? await res.json() : null;
  } catch (err) {
    return null;
  }
}

async function warm() {
  const tickers = new Set([...MARKET_TICKERS, ...PINNED_TICKERS]);

  const maps = await Promise.all(
    ["/capex", "/musk-capex", "/robotics-capex"].map(getJson));
  for (const m of maps) {
    for (const track of m?.capexData?.tracks ?? []) {
      for (const sub of track.subsectors ?? []) {
        for (const t of sub.tickers ?? []) tickers.add(t);
      }
    }
  }

  const scanner = await getJson("/scanner");
  for (const t of scanner?.tickers ?? []) tickers.add(t);
  const shortlist = await getJson("/shortlist");
  for (const t of shortlist?.tickers ?? []) tickers.add(t);

  const list = [...tickers].join(",");
  const res = await fetch(`${BASE}/prices?tickers=${encodeURIComponent(list)}`);
  const body = res.ok ? await res.json() : null;
  console.log(`prewarm: ${tickers.size} tickers requested, status ${res.status}, ` +
              `${body?.data ? Object.keys(body.data).length : 0} priced, cached=${body?.cached}`);
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(warm());
  },
};
