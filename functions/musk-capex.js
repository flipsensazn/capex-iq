// functions/musk-capex.js
//
// The Musk Galaxy capex map — same KV-backed pattern as /capex, separate key.
// GET: public read of the saved map (null → frontend uses its default).
// POST: admin-only save.

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

  if (request.method === "GET") {
    try {
      const data = env.SHARED_DATA ? await env.SHARED_DATA.get("muskCapexData", "json") : null;
      return new Response(JSON.stringify({ capexData: data }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ capexData: null, error: err.message }), { status: 200, headers });
    }
  }

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

      if (env.SHARED_DATA && body.capexData) {
        const payload = { ...body.capexData, version: body.capexData.version ?? 1 };
        await env.SHARED_DATA.put("muskCapexData", JSON.stringify(payload));
        return new Response(JSON.stringify({ success: true }), { status: 200, headers });
      }

      return new Response(JSON.stringify({ error: "Cloudflare KV not bound correctly." }), { status: 500, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers });
}
