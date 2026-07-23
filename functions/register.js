// functions/register.js
//
// POST /register {email} — free-beta self-registration.
//
// Adds the email to the Zero Trust Access Group named "Members" via the
// Cloudflare API, so the Access policy on /app immediately admits them
// (they still have to pass the One-time PIN to their inbox — registering
// an address you don't control gets you nothing). Also mirrors into a KV
// registry for our own records.
//
// Env:
//   CF_ACCESS_API_TOKEN  secret — API token with Access: Groups Edit.
//                        Unset → 503 (registration not open yet).
//   ACCESS_ACCOUNT_ID    optional var; defaults to the account this Worker
//                        is deployed on (hardcoded fallback below).
//
// Notes for the paywall future: flip this endpoint to create a pending
// record instead of adding to the group, and let the payment webhook do
// the group add. The Access policy doesn't change at all.

const MEMBERS_GROUP_NAME = "Capex IQ Members";
const GROUP_ID_KV_KEY = "accessMembersGroupId_v1";
const REGISTRY_KV_KEY = "membersRegistry_v1";
const RATE_KV_PREFIX = "regRate_";
const RATE_LIMIT_PER_DAY = 5;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const DEFAULT_ACCOUNT_ID = "0e727bf4fae81b99443d3150ca244484";

export async function onRequest(context) {
  const { request, env } = context;

  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
  const reply = (status, body) =>
    new Response(JSON.stringify(body), { status, headers });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...headers, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" },
    });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers });
  }

  const apiToken = env.CF_ACCESS_API_TOKEN;
  if (!apiToken) {
    return reply(503, { success: false, message: "Registration isn't open yet — check back soon." });
  }

  let email;
  try {
    email = String((await request.json()).email || "").trim().toLowerCase();
  } catch {
    return reply(400, { success: false, message: "Invalid request." });
  }
  if (!EMAIL_RE.test(email) || email.length > 254) {
    return reply(400, { success: false, message: "That doesn't look like a valid email address." });
  }

  // Light per-IP rate limit (KV, daily window) to keep list spam down.
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (env.SHARED_DATA) {
    try {
      const rateKey = `${RATE_KV_PREFIX}${ip}`;
      const count = parseInt(await env.SHARED_DATA.get(rateKey) || "0", 10);
      if (count >= RATE_LIMIT_PER_DAY) {
        return reply(429, { success: false, message: "Too many registrations from this network today — try again tomorrow." });
      }
      await env.SHARED_DATA.put(rateKey, String(count + 1), { expirationTtl: 86400 });
    } catch (err) {}
  }

  const accountId = env.ACCESS_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/groups`;
  const apiHeaders = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };

  try {
    // Resolve the Members group id (cached in KV after first lookup).
    let groupId = env.SHARED_DATA ? await env.SHARED_DATA.get(GROUP_ID_KV_KEY) : null;
    if (!groupId) {
      const listRes = await fetch(`${api}?name=${MEMBERS_GROUP_NAME}`, { headers: apiHeaders });
      const list = await listRes.json();
      groupId = list?.result?.find(g => g.name === MEMBERS_GROUP_NAME)?.id;
      if (!groupId) {
        console.error("register: Members group not found", list?.errors);
        return reply(503, { success: false, message: "Registration is being set up — check back soon." });
      }
      if (env.SHARED_DATA) {
        try { await env.SHARED_DATA.put(GROUP_ID_KV_KEY, groupId); } catch {}
      }
    }

    // Read-modify-write the group's email includes.
    const groupRes = await fetch(`${api}/${groupId}`, { headers: apiHeaders });
    const group = (await groupRes.json())?.result;
    if (!group) {
      return reply(502, { success: false, message: "Registration failed — please try again." });
    }
    const include = group.include || [];
    const already = include.some(rule => rule?.email?.email?.toLowerCase() === email);

    if (!already) {
      include.push({ email: { email } });
      const putRes = await fetch(`${api}/${groupId}`, {
        method: "PUT",
        headers: apiHeaders,
        body: JSON.stringify({ name: group.name, include, exclude: group.exclude || [], require: group.require || [] }),
      });
      const put = await putRes.json();
      if (!put?.success) {
        console.error("register: group update failed", put?.errors);
        return reply(502, { success: false, message: "Registration failed — please try again." });
      }
    }

    // Mirror into our own KV registry (append-only, best effort).
    if (env.SHARED_DATA) {
      try {
        const registry = (await env.SHARED_DATA.get(REGISTRY_KV_KEY, "json")) || [];
        if (!registry.some(r => r.email === email)) {
          registry.push({ email, registeredAt: new Date().toISOString() });
          await env.SHARED_DATA.put(REGISTRY_KV_KEY, JSON.stringify(registry));
        }
      } catch (err) {}
    }

    return reply(200, {
      success: true,
      message: already
        ? "You're already registered — click Sign In and a one-time PIN will be emailed to you."
        : "You're in! Click Sign In — a one-time PIN will be emailed to you.",
    });
  } catch (err) {
    console.error("register: unexpected error", err);
    return reply(500, { success: false, message: "Registration failed — please try again." });
  }
}
