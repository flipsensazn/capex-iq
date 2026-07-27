// functions/scanner.js
import { isAuthorizedAdmin } from "./access-lib.js";

export async function onRequest(context) {
  const { request, env } = context;

  // The fallback list if the database is empty
  const DEFAULT_LIST = [
    "YELP", "NVRI", "CXM", "SFL", "WWW", "FIVN", "STGW", "ECVT", "CRI",
    "TRIP", "OLPX", "LZ", "GLDD", "ARHS", "ACEL", "CRCT", "PGY", "TDAY",
    "NABL", "NRDS", "STKL", "UDMY", "GOGO", "YEXT", "EHAB", "AHH", "RIGL",
    "RPD", "AKBA"
  ];

  // ── FIX #3: Restrict CORS to your actual domain ──────────────────────────
  // Set ALLOWED_ORIGIN as a Cloudflare env var, e.g. "https://your-project.pages.dev"
  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Vary": "Origin",
  };

  // Handle CORS preflight
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

  // EVERYONE: Read the global list
  if (request.method === "GET") {
    try {
      const data = env.SHARED_DATA ? await env.SHARED_DATA.get("scannerPool", "json") : null;
      return new Response(JSON.stringify({ tickers: data || DEFAULT_LIST }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ tickers: DEFAULT_LIST, error: err.message }), { status: 200, headers });
    }
  }

  // ADMIN ONLY: Update the global list
  if (request.method === "POST") {
    try {
      const body = await request.json();

      // ── FIX #1: Password read from Cloudflare env var, never hardcoded ──
      const adminPassword = env.ADMIN_PASSWORD;
      if (!adminPassword) {
        return new Response(JSON.stringify({ error: "Server misconfiguration: ADMIN_PASSWORD not set." }), { status: 500, headers });
      }
      if (!(await isAuthorizedAdmin(request, env, body.password))) {
        return new Response(JSON.stringify({ error: "Incorrect Admin Password" }), { status: 401, headers });
      }

      if (body.verifyOnly) {
        if (!env.SHARED_DATA) {
          return new Response(JSON.stringify({ error: "Cloudflare KV not bound correctly." }), { status: 500, headers });
        }
        return new Response(JSON.stringify({ success: true }), { status: 200, headers });
      }

      if (env.SHARED_DATA && Array.isArray(body.tickers)) {
        await env.SHARED_DATA.put("scannerPool", JSON.stringify(body.tickers));
        return new Response(JSON.stringify({ success: true, tickers: body.tickers }), { status: 200, headers });
      }

      return new Response(JSON.stringify({ error: "Cloudflare KV not bound correctly." }), { status: 500, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers });
}
