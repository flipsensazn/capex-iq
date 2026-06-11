// functions/candidates.js
//
// The Bottleneck Scout review queue (populated weekly by src/bottleneck_scout.py).
//
// GET  /candidates  → pending candidates + recently reviewed (for context)
// POST /candidates  → admin review: { password, ticker, action: "approved"|"rejected" }
//
// Approval here only flips the status — the dashboard's review panel is
// responsible for actually inserting the ticker into the capex map (it owns
// the current map state and the existing admin save flow).

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
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  const DATABASE_URL = env.DATABASE_URL;
  if (!DATABASE_URL) {
    return new Response(
      JSON.stringify({ success: false, message: "DATABASE_URL not configured." }),
      { status: 500, headers }
    );
  }

  const host = new URL(
    DATABASE_URL.replace("postgresql://", "https://").replace("postgres://", "https://")
  ).hostname;
  const sql = (query, params = []) =>
    fetch(`https://${host}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": DATABASE_URL,
      },
      body: JSON.stringify({ query, params }),
    });

  // ── POST: admin approve / reject ──────────────────────────────────────────
  if (request.method === "POST") {
    try {
      const body = await request.json();
      const adminPassword = env.ADMIN_PASSWORD;
      if (!adminPassword || body.password !== adminPassword) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }
      const ticker = String(body.ticker || "").toUpperCase();
      const action = body.action;
      if (!ticker || !["approved", "rejected"].includes(action)) {
        return new Response(JSON.stringify({ error: "Need ticker and action (approved|rejected)." }), { status: 400, headers });
      }
      const res = await sql(
        `UPDATE bottleneck_candidates
         SET status = $1, reviewed_at = now()
         WHERE ticker = $2 AND status = 'pending'`,
        [action, ticker]
      );
      if (!res.ok) {
        const detail = await res.text();
        console.error("candidate review failed", detail);
        return new Response(JSON.stringify({ error: "Review update failed." }), { status: 500, headers });
      }
      return new Response(JSON.stringify({ success: true, ticker, status: action }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  // ── GET: the queue ─────────────────────────────────────────────────────────
  if (request.method === "GET") {
    try {
      const res = await sql(`
        SELECT ticker, company_name, exchange, is_otc, market_cap, price,
               track_id, view, suggested_subsector, chokepoint, thesis,
               stress_score, stress_direction, stress_summary, stress_quotes,
               order_gap, rpo_yoy, revenue_yoy, inventory_days, backlog_score,
               status, discovered_at, reviewed_at
        FROM bottleneck_candidates
        WHERE status = 'pending'
           OR (status = 'rejected' AND reviewed_at > now() - interval '14 days')
        ORDER BY (status = 'pending') DESC, discovered_at DESC
        LIMIT 60
      `);
      if (!res.ok) {
        const detail = await res.text();
        // table may simply not exist yet (scout never ran) — return empty queue
        if (/does not exist/i.test(detail)) {
          return new Response(JSON.stringify({ success: true, candidates: [] }), { status: 200, headers });
        }
        console.error("candidates query failed", detail);
        return new Response(JSON.stringify({ success: false, message: "Queue unavailable." }), { status: 500, headers });
      }
      const rows = (await res.json()).rows ?? [];
      const candidates = rows.map(r => {
        let quotes = r.stress_quotes;
        if (typeof quotes === "string") {
          try { quotes = JSON.parse(quotes); } catch { quotes = []; }
        }
        const num = v => (v != null ? Number(v) : null);
        return {
          ticker: r.ticker,
          name: r.company_name,
          exchange: r.exchange,
          isOtc: !!r.is_otc,
          marketCap: num(r.market_cap),
          price: num(r.price),
          trackId: r.track_id,
          view: r.view || "ai",
          suggestedSubsector: r.suggested_subsector,
          chokepoint: r.chokepoint,
          thesis: r.thesis,
          stressScore: num(r.stress_score),
          stressDirection: r.stress_direction,
          stressSummary: r.stress_summary,
          stressQuotes: Array.isArray(quotes) ? quotes : [],
          orderGap: num(r.order_gap),
          rpoYoy: num(r.rpo_yoy),
          revenueYoy: num(r.revenue_yoy),
          inventoryDays: num(r.inventory_days),
          backlogScore: num(r.backlog_score),
          status: r.status,
          discoveredAt: r.discovered_at,
          reviewedAt: r.reviewed_at,
        };
      });
      return new Response(JSON.stringify({ success: true, count: candidates.length, candidates }), { status: 200, headers });
    } catch (err) {
      console.error("candidates unexpected error", err);
      return new Response(JSON.stringify({ success: false, message: "Queue unavailable." }), { status: 500, headers });
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers });
}
