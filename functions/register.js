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
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const apiHeaders = { "Authorization": `Bearer ${apiToken}`, "Content-Type": "application/json" };
  const norm = s => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
  const nameMatches = (name) =>
    name === MEMBERS_GROUP_NAME || norm(name) === norm(MEMBERS_GROUP_NAME)
    || (/capex/i.test(name || "") && /member/i.test(name || ""));

  try {
    // The members roster can be either an Access Group (include rules) or a
    // Zero Trust email List (referenced by an "Emails in list" policy rule).
    // Support both; find whichever exists. Cached in KV after first lookup
    // as "group:<id>" or "list:<id>".
    let target = env.SHARED_DATA ? await env.SHARED_DATA.get(GROUP_ID_KV_KEY) : null;

    if (!target) {
      const groupsRes = await fetch(`${base}/access/groups?per_page=50`, { headers: apiHeaders });
      const groups = (await groupsRes.json())?.result || [];
      const group = groups.find(g => nameMatches(g.name));
      if (group) {
        target = `group:${group.id}`;
      } else {
        const listsRes = await fetch(`${base}/gateway/lists`, { headers: apiHeaders });
        const listsBody = await listsRes.text();
        let lists = [];
        try { lists = JSON.parse(listsBody)?.result || []; } catch {}
        const list = lists.find(l => (l.type || "").toUpperCase() === "EMAIL" && nameMatches(l.name))
          ?? lists.find(l => nameMatches(l.name));
        if (list) {
          target = `list:${list.id}`;
        } else {
          console.error("register: no Members roster found;",
            "groups:", JSON.stringify(groups.map(g => g.name)),
            "lists status:", listsRes.status, "lists:", listsBody.slice(0, 300));
          return reply(503, { success: false, message: "Registration is being set up — check back soon." });
        }
      }
      if (env.SHARED_DATA) {
        try { await env.SHARED_DATA.put(GROUP_ID_KV_KEY, target); } catch {}
      }
    }

    const [kind, targetId] = target.split(":");
    let already = false;

    if (kind === "group") {
      // Read-modify-write the Access group's email includes.
      const groupRes = await fetch(`${base}/access/groups/${targetId}`, { headers: apiHeaders });
      const group = (await groupRes.json())?.result;
      if (!group) {
        return reply(502, { success: false, message: "Registration failed — please try again." });
      }
      const include = group.include || [];
      already = include.some(rule => rule?.email?.email?.toLowerCase() === email);
      if (!already) {
        include.push({ email: { email } });
        const putRes = await fetch(`${base}/access/groups/${targetId}`, {
          method: "PUT",
          headers: apiHeaders,
          body: JSON.stringify({ name: group.name, include, exclude: group.exclude || [], require: group.require || [] }),
        });
        const put = await putRes.json();
        if (!put?.success) {
          console.error("register: group update failed", JSON.stringify(put?.errors));
          return reply(502, { success: false, message: "Registration failed — please try again." });
        }
      }
    } else {
      // Zero Trust email list: check current items, then append.
      const itemsRes = await fetch(`${base}/gateway/lists/${targetId}/items?per_page=1000`, { headers: apiHeaders });
      const items = (await itemsRes.json())?.result || [];
      already = items.some(it => (it.value || "").toLowerCase() === email);
      if (!already) {
        const patchRes = await fetch(`${base}/gateway/lists/${targetId}`, {
          method: "PATCH",
          headers: apiHeaders,
          body: JSON.stringify({ append: [{ value: email }], remove: [] }),
        });
        const patch = await patchRes.json();
        if (!patch?.success) {
          console.error("register: list append failed", JSON.stringify(patch?.errors));
          return reply(502, { success: false, message: "Registration failed — please try again." });
        }
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
      // `already` lets the landing page skip the activation countdown for
      // returning users — their list membership propagated long ago, so only a
      // genuinely new append needs the ~60s gate before the first PIN can send.
      already,
      message: already
        ? "You're already registered — click Sign In and a one-time PIN will be emailed to you."
        : "You're in! Click Sign In — a one-time PIN will be emailed to you.",
    });
  } catch (err) {
    console.error("register: unexpected error", err);
    return reply(500, { success: false, message: "Registration failed — please try again." });
  }
}
