// functions/gap-scanner.js
// GET  — public, returns the latest pre-market gap scan (with TJL results)
// POST — admin only, the local scanner pipeline pushes today's results here

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
      headers: { ...headers, "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    });
  }

  // EVERYONE: read the latest scan
  if (request.method === "GET") {
    try {
      const data = env.SHARED_DATA ? await env.SHARED_DATA.get("gap_scanner", "json") : null;
      if (!data) {
        return new Response(JSON.stringify({ success: false, message: "No gap scan yet today. The local pipeline pushes results each market morning." }), { status: 200, headers });
      }
      return new Response(JSON.stringify({ success: true, data }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ success: false, error: err.message }), { status: 200, headers });
    }
  }

  // ADMIN ONLY: scanner pipeline pushes results
  if (request.method === "POST") {
    try {
      const body = await request.json();

      const adminPassword = env.ADMIN_PASSWORD;
      if (!adminPassword) {
        return new Response(JSON.stringify({ error: "Server misconfiguration: ADMIN_PASSWORD not set." }), { status: 500, headers });
      }
      if (body.password !== adminPassword) {
        return new Response(JSON.stringify({ error: "Incorrect Admin Password" }), { status: 401, headers });
      }

      const scan = body.scan;
      if (env.SHARED_DATA && scan && Array.isArray(scan.gappers)) {
        await env.SHARED_DATA.put("gap_scanner", JSON.stringify(scan));
        return new Response(JSON.stringify({ success: true, count: scan.gappers.length }), { status: 200, headers });
      }

      return new Response(JSON.stringify({ error: "Bad payload (expected {password, scan:{gappers:[]}}) or KV not bound." }), { status: 500, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers });
}
