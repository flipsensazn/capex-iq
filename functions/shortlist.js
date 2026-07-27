// functions/shortlist.js
// GET  — public, returns the shared shortlist for all users
// POST — admin only, updates the shared shortlist in KV

import { isAuthorizedAdmin } from "./access-lib.js";

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

  // EVERYONE: Read the shared shortlist
  if (request.method === "GET") {
    try {
      const data = env.SHARED_DATA ? await env.SHARED_DATA.get("shortlist", "json") : null;
      return new Response(JSON.stringify({ tickers: data || [] }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ tickers: [], error: err.message }), { status: 200, headers });
    }
  }

  // ADMIN ONLY: Update the shared shortlist
  if (request.method === "POST") {
    try {
      const body = await request.json();

      const adminPassword = env.ADMIN_PASSWORD;
      if (!adminPassword) {
        return new Response(JSON.stringify({ error: "Server misconfiguration: ADMIN_PASSWORD not set." }), { status: 500, headers });
      }
      if (!(await isAuthorizedAdmin(request, env, body.password))) {
        return new Response(JSON.stringify({ error: "Incorrect Admin Password" }), { status: 401, headers });
      }

      if (env.SHARED_DATA && Array.isArray(body.tickers)) {
        await env.SHARED_DATA.put("shortlist", JSON.stringify(body.tickers));
        return new Response(JSON.stringify({ success: true, tickers: body.tickers }), { status: 200, headers });
      }

      return new Response(JSON.stringify({ error: "Cloudflare KV not bound correctly." }), { status: 500, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers });
}
