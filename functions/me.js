// functions/me.js
//
// GET /me — who is this request, according to Cloudflare Access?
//   { email, isAdmin, canResearch, features, tier, authConfigured }
//
// The dashboard calls this on load: a valid admin identity auto-enables
// editing (no password prompt); a null email just means the auth layer
// isn't configured yet or the visitor hasn't signed in.

import { getAccessPayload, isAdminEmail } from "./access-lib.js";
import { resolveEntitlements } from "./entitlements.js";

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
  const { tier, features } = await resolveEntitlements(email, env);

  return new Response(JSON.stringify({
    email,
    isAdmin: isAdminEmail(email, env),
    canResearch: Boolean(features.research),
    features,
    tier,
    authConfigured,
  }), { status: 200, headers });
}
