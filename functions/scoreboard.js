// functions/scoreboard.js
//
// GET /scoreboard — the Signal Performance Scoreboard, fed weekly by
// src/signal_scoreboard.py. Answers "when this system fires a signal, does
// the stock actually beat the market afterwards?"
//
//   { success: true,
//     stats: [{ type,            // event type, or "all" for the rollup row
//               n,               // total events logged
//               horizons: { "1w": { n, medianExcess, hitRate }, "1m": ..., "3m": ... } }],
//     events: [{ ticker, type, date, score, excess: { "1w": pct|null, ... } }] }
//
// Excess = event return minus QQQ over the same window, percentage points.
// Horizon stats only include events whose window has matured.

export async function onRequest(context) {
  const { request, env } = context;

  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Vary": "Origin",
    // Weekly ETL — browser 30 min, edge 6 hours
    "Cache-Control": "public, max-age=1800, s-maxage=21600",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers });
  }

  const DATABASE_URL = env.DATABASE_URL;
  if (!DATABASE_URL) {
    return new Response(
      JSON.stringify({ success: false, message: "DATABASE_URL not configured." }),
      { status: 500, headers }
    );
  }

  const url  = new URL(DATABASE_URL.replace("postgresql://", "https://").replace("postgres://", "https://"));
  const host = url.hostname;

  const runQuery = async (query) => {
    const res = await fetch(`https://${host}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": DATABASE_URL,
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const detail = await res.text();
      const err = new Error(detail);
      err.missingTable = /does not exist/i.test(detail);
      throw err;
    }
    return (await res.json()).rows ?? [];
  };

  const STATS_SQL = `
    SELECT COALESCE(event_type, 'all') AS type,
           COUNT(*) AS n,
           COUNT(*) FILTER (WHERE ret_1w IS NOT NULL AND bench_1w IS NOT NULL) AS n_1w,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ret_1w - bench_1w)
             FILTER (WHERE ret_1w IS NOT NULL AND bench_1w IS NOT NULL) AS med_1w,
           AVG((ret_1w > bench_1w)::int)
             FILTER (WHERE ret_1w IS NOT NULL AND bench_1w IS NOT NULL) AS hit_1w,
           COUNT(*) FILTER (WHERE ret_1m IS NOT NULL AND bench_1m IS NOT NULL) AS n_1m,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ret_1m - bench_1m)
             FILTER (WHERE ret_1m IS NOT NULL AND bench_1m IS NOT NULL) AS med_1m,
           AVG((ret_1m > bench_1m)::int)
             FILTER (WHERE ret_1m IS NOT NULL AND bench_1m IS NOT NULL) AS hit_1m,
           COUNT(*) FILTER (WHERE ret_3m IS NOT NULL AND bench_3m IS NOT NULL) AS n_3m,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ret_3m - bench_3m)
             FILTER (WHERE ret_3m IS NOT NULL AND bench_3m IS NOT NULL) AS med_3m,
           AVG((ret_3m > bench_3m)::int)
             FILTER (WHERE ret_3m IS NOT NULL AND bench_3m IS NOT NULL) AS hit_3m
    FROM signal_events
    GROUP BY ROLLUP(event_type)
    ORDER BY n DESC
  `;

  const EVENTS_SQL = `
    SELECT ticker, event_type, event_date, score,
           ret_1w, bench_1w, ret_1m, bench_1m, ret_3m, bench_3m
    FROM signal_events
    ORDER BY event_date DESC, ticker
    LIMIT 30
  `;

  try {
    const [statRows, eventRows] = await Promise.all([
      runQuery(STATS_SQL),
      runQuery(EVENTS_SQL),
    ]);

    const num = v => (v != null ? Number(v) : null);
    const round1 = v => (v != null ? Math.round(v * 10) / 10 : null);

    const stats = statRows.map(r => ({
      type: r.type,
      n: num(r.n),
      horizons: Object.fromEntries(["1w", "1m", "3m"].map(h => [h, {
        n: num(r[`n_${h}`]) ?? 0,
        medianExcess: round1(num(r[`med_${h}`])),
        hitRate: r[`hit_${h}`] != null ? Math.round(Number(r[`hit_${h}`]) * 100) : null,
      }])),
    }));

    const events = eventRows.map(r => ({
      ticker: r.ticker,
      type: r.event_type,
      date: r.event_date,
      score: num(r.score),
      excess: Object.fromEntries(["1w", "1m", "3m"].map(h => [h,
        r[`ret_${h}`] != null && r[`bench_${h}`] != null
          ? round1(Number(r[`ret_${h}`]) - Number(r[`bench_${h}`]))
          : null,
      ])),
    }));

    return new Response(
      JSON.stringify({ success: true, stats, events }),
      { status: 200, headers }
    );

  } catch (err) {
    // Table won't exist until the first ETL run — serve an empty scoreboard.
    if (err.missingTable) {
      return new Response(
        JSON.stringify({ success: true, stats: [], events: [] }),
        { status: 200, headers }
      );
    }
    console.error("scoreboard query failed", err.message);
    return new Response(
      JSON.stringify({ success: false, message: "Scoreboard data is temporarily unavailable." }),
      { status: 500, headers }
    );
  }
}
