// functions/presence.js

export async function onRequest(context) {
  const { request, env } = context;

  // Handle CORS
  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Vary": "Origin",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  }

  let sessionId = null;

  if (request.method === "POST") {
    try {
      const body = await request.json();
      const raw = typeof body?.session === "string" ? body.session : "";
      sessionId = raw.replace(/[^a-zA-Z0-9-]/g, "").substring(0, 50) || null;
    } catch {}
  }

  if (!sessionId) {
    return new Response(JSON.stringify({ count: 1 }), { status: 200, headers });
  }

  const DATABASE_URL = env.DATABASE_URL;
  if (!DATABASE_URL) return new Response(JSON.stringify({ count: 1 }), { status: 200, headers });

  try {
    const url = new URL(DATABASE_URL.replace("postgresql://", "https://").replace("postgres://", "https://"));
    const neonEndpoint = `https://${url.hostname}/sql`;

    // 1. Delete sessions older than 2 minutes
    // 2. Upsert the current user's session
    // 3. Count remaining active sessions
    const sqlQuery = `
      WITH cleanup AS (
          DELETE FROM active_sessions WHERE last_seen < NOW() - INTERVAL '2 minutes'
      ),
      upsert AS (
          INSERT INTO active_sessions (session_id, last_seen)
          VALUES ($1, NOW())
          ON CONFLICT (session_id) DO UPDATE SET last_seen = NOW()
      )
      SELECT COUNT(*) AS active_users FROM active_sessions;
    `;

    const dbRes = await fetch(neonEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": DATABASE_URL,
      },
      body: JSON.stringify({ query: sqlQuery, params: [sessionId] }),
    });

    if (!dbRes.ok) throw new Error("DB Error");

    const result = await dbRes.json();
    const count = result.rows?.[0]?.active_users || 1;

    return new Response(JSON.stringify({ count: parseInt(count, 10) }), { status: 200, headers });

  } catch (err) {
    // Fail silently to 1 if the DB errors out so the UI doesn't break
    return new Response(JSON.stringify({ count: 1 }), { status: 200, headers });
  }
}
