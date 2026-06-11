// functions/exposure.js
//
// GET /exposure — serves customer-concentration disclosures extracted from
// SEC filings by src/customer_exposure.py (monthly GitHub Actions ETL → Neon).
//
//   { success: true, data: { FN: { topRevenuePct: 35,
//       customers: [{ label, ticker, pct, basis, period, form, quote }] } } }

export async function onRequest(context) {
  const { request, env } = context;

  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Vary": "Origin",
    // ETL runs monthly — cache browser 1 hour, CDN edge 12 hours
    "Cache-Control": "public, max-age=3600, s-maxage=43200",
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
    const url  = new URL(DATABASE_URL.replace("postgresql://", "https://").replace("postgres://", "https://"));
    const host = url.hostname;

    const sqlQuery = `
      SELECT ticker, customer_label, customer_ticker, pct, basis, period,
             source_form, quote
      FROM customer_exposure
      ORDER BY ticker, pct DESC
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
      console.error("exposure DB query failed", { status: dbRes.status, detail: errText });
      return new Response(
        JSON.stringify({ success: false, message: "Exposure data is temporarily unavailable." }),
        { status: 500, headers }
      );
    }

    const result = await dbRes.json();
    const rows   = result.rows ?? [];

    const data = {};
    for (const row of rows) {
      const entry = (data[row.ticker] ??= { topRevenuePct: null, customers: [] });
      const pct = row.pct != null ? Number(row.pct) : null;
      entry.customers.push({
        label:  row.customer_label,
        ticker: row.customer_ticker,
        pct,
        basis:  row.basis,
        period: row.period,
        form:   row.source_form,
        quote:  row.quote,
      });
      if (row.basis === "revenue" && pct != null) {
        entry.topRevenuePct = Math.max(entry.topRevenuePct ?? 0, pct);
      }
    }

    return new Response(
      JSON.stringify({ success: true, count: Object.keys(data).length, data }),
      { status: 200, headers }
    );

  } catch (err) {
    console.error("exposure unexpected error", err);
    return new Response(
      JSON.stringify({ success: false, message: "Exposure data is temporarily unavailable." }),
      { status: 500, headers }
    );
  }
}
