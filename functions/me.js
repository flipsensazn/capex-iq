// functions/me.js
//
// GET /me — who is this request, according to Cloudflare Access?
//   { email: "user@x.com" | null, isAdmin: bool, canResearch: bool, authConfigured: bool }
//
// The dashboard calls this on load: a valid admin identity auto-enables
// editing (no password prompt); a null email just means the auth layer
// isn't configured yet or the visitor hasn't signed in.

import { getAccessPayload, isAdminEmail, isAnalyzeAllowedEmail } from "./access-lib.js";

export async function onRequest(context) {
  const { request, env } = context;

  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Vary": "Origin, Cookie",
    "Cache-Control": "no-store",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...headers, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    });
  }
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers });
  }

  const authConfigured = !!(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);
  const payload = await getAccessPayload(request, env);
  const email = payload?.email ?? null;

  return new Response(JSON.stringify({
    email,
    isAdmin: isAdminEmail(email, env),
    canResearch: isAnalyzeAllowedEmail(email, env),
    authConfigured,
  }), { status: 200, headers });
}
