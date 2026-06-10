// functions/stress.js
//
// GET /stress — serves the transcript NLP supply-chain stress scores produced
// by src/transcript_stress.py (weekly GitHub Actions ETL → Neon).
//
// Returns the two most recent analyzed quarters per ticker so the frontend
// can show both the level and the quarter-over-quarter trend:
//
//   { success: true, data: { NVDA: { latest: {...}, prev: {...}|null }, ... } }

export async function onRequest(context) {
  const { request, env } = context;

  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Vary": "Origin",
    // ETL runs weekly — cache browser 30 min, CDN edge 6 hours
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

  try {
    // Convert the connection string into the Neon HTTP SQL endpoint.
    const url  = new URL(DATABASE_URL.replace("postgresql://", "https://").replace("postgres://", "https://"));
    const host = url.hostname;

    // Two most recent analyzed quarters per ticker.
    const sqlQuery = `
      WITH ranked AS (
        SELECT
          ticker,
          fiscal_year,
          fiscal_quarter,
          call_date,
          stress_score,
          lexicon_score,
          lexicon_hits,
          direction,
          summary,
          quotes,
          analyzed_at,
          ROW_NUMBER() OVER (
            PARTITION BY ticker
            ORDER BY fiscal_year DESC, fiscal_quarter DESC
          ) AS rn
        FROM transcript_stress
      )
      SELECT * FROM ranked WHERE rn <= 2 ORDER BY ticker, rn
    `;

    const dbRes = await fetch(`https://${host}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": DATABASE_URL,
      },
      body: JSON.stringify({ query: sqlQuery }),
    });

    if (!dbRes.ok) {
      const errText = await dbRes.text();
      console.error("stress DB query failed", { status: dbRes.status, detail: errText });
      return new Response(
        JSON.stringify({ success: false, message: "Stress data is temporarily unavailable." }),
        { status: 500, headers }
      );
    }

    const result = await dbRes.json();
    const rows   = result.rows ?? [];

    const data = {};
    for (const row of rows) {
      let quotes = row.quotes;
      if (typeof quotes === "string") {
        try { quotes = JSON.parse(quotes); } catch { quotes = []; }
      }
      const entry = {
        fiscalYear:    row.fiscal_year,
        fiscalQuarter: row.fiscal_quarter,
        callDate:      row.call_date,
        stressScore:   row.stress_score != null ? Number(row.stress_score) : null,
        lexiconScore:  row.lexicon_score != null ? Number(row.lexicon_score) : null,
        lexiconHits:   row.lexicon_hits,
        direction:     row.direction,
        summary:       row.summary,
        quotes:        Array.isArray(quotes) ? quotes : [],
        analyzedAt:    row.analyzed_at,
      };
      if (!data[row.ticker]) data[row.ticker] = { latest: null, prev: null };
      if (Number(row.rn) === 1) data[row.ticker].latest = entry;
      else data[row.ticker].prev = entry;
    }

    return new Response(
      JSON.stringify({ success: true, count: Object.keys(data).length, data }),
      { status: 200, headers }
    );

  } catch (err) {
    console.error("stress unexpected error", err);
    return new Response(
      JSON.stringify({ success: false, message: "Stress data is temporarily unavailable." }),
      { status: 500, headers }
    );
  }
}
