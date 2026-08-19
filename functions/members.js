// functions/members.js
//
// Admin review queue for member registrations stored in SHARED_DATA.

import {
  getAccessPayload,
  isAdminEmail,
  isTrustedOrigin,
} from "./access-lib.js";
import { readBoundedJson } from "./bounded-json.js";
import {
  FEATURES,
  getResearchQuota,
  getResearchUsage,
} from "./entitlements.js";

const MEMBER_PREFIX = "member:";
const MAX_BODY_BYTES = 4 * 1024;
const MAX_RESEARCH_QUOTA = 10_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DEFAULT_ACCESS_ACCOUNT_ID = "0e727bf4fae81b99443d3150ca244484";

function responseHeaders(request, env) {
  const allowedOrigin = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": origin === allowedOrigin ? allowedOrigin : "",
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}

function reply(status, body, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validEmail(email) {
  return email.length <= 254 && EMAIL_RE.test(email);
}

async function syncRoster(env, email, mode) {
  if (!env.CF_ACCESS_API_TOKEN || !env.ACCESS_MEMBERS_LIST_ID) {
    return { synced: false, reason: "unconfigured" };
  }

  const accountId = env.ACCESS_ACCOUNT_ID || DEFAULT_ACCESS_ACCOUNT_ID;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/gateway/lists/${env.ACCESS_MEMBERS_LIST_ID}`;
  const payload = mode === "append"
    ? { append: [{ value: email }], remove: [] }
    : { append: [], remove: [email] };
  let status = "network_error";

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer ${env.CF_ACCESS_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    status = response.status;
    const body = await response.json();
    if (!response.ok || body?.success === false) {
      console.error("members roster sync failed", status);
      return { synced: false, reason: "api_error" };
    }
    return { synced: true };
  } catch {
    console.error("members roster sync failed", status);
    return { synced: false, reason: "api_error" };
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function memberResponse(email, record) {
  return {
    email,
    features: record.features ?? null,
    registeredAt: record.registeredAt ?? null,
    grantedAt: record.grantedAt ?? null,
    source: record.source ?? null,
    researchQuota: record.researchQuota ?? null,
  };
}

function normalizeFeatures(value) {
  if (!isRecord(value)) return null;
  const featureNames = Object.keys(value);
  if (featureNames.some(feature => !FEATURES.includes(feature))) return null;

  const features = {};
  for (const feature of FEATURES) {
    if (Object.hasOwn(value, feature)) {
      if (typeof value[feature] !== "boolean") return null;
      features[feature] = value[feature];
    }
  }
  return features;
}

async function readMember(kv, key) {
  const record = await kv.get(key, "json");
  if (record === null) return null;
  if (!isRecord(record)) throw new Error(`Malformed member record for ${key}`);
  return record;
}

async function listMemberKeys(kv) {
  const keys = [];
  let cursor;
  let listComplete = false;
  while (!listComplete) {
    const options = cursor
      ? { prefix: MEMBER_PREFIX, cursor }
      : { prefix: MEMBER_PREFIX };
    const page = await kv.list(options);
    keys.push(...(page.keys || []));
    listComplete = page.list_complete === true;
    cursor = page.cursor;
  }
  return keys;
}

async function getMembers(env) {
  const keys = await listMemberKeys(env.SHARED_DATA);
  const members = await Promise.all(keys.map(async ({ name }) => {
    const email = name.slice(MEMBER_PREFIX.length);
    let record;
    try {
      record = await env.SHARED_DATA.get(name, "json");
    } catch {
      return { email, malformed: true };
    }
    if (!isRecord(record)) return { email, malformed: true };

    const member = memberResponse(email, record);
    if (record.features?.research === true) {
      const [used, quota] = await Promise.all([
        getResearchUsage(email, env),
        getResearchQuota(email, env),
      ]);
      member.usage = { used, limit: quota.limit ?? null };
    }
    return member;
  }));

  members.sort((left, right) => {
    const leftTime = Date.parse(left.registeredAt || "");
    const rightTime = Date.parse(right.registeredAt || "");
    const leftValid = Number.isFinite(leftTime);
    const rightValid = Number.isFinite(rightTime);
    if (leftValid && rightValid) return rightTime - leftTime;
    if (leftValid) return -1;
    if (rightValid) return 1;
    return 0;
  });
  return members;
}

async function mutateMember(body, env, headers) {
  if (!isRecord(body)) {
    return reply(400, { error: "Invalid request", code: "invalid_request" }, headers);
  }

  const action = body.action;
  const email = normalizeEmail(body.email);
  if (!["grant", "revoke", "delete"].includes(action) || !validEmail(email)) {
    return reply(400, { error: "Invalid action or email", code: "invalid_request" }, headers);
  }

  let requestedFeatures;
  if (action === "grant" && Object.hasOwn(body, "features")) {
    requestedFeatures = normalizeFeatures(body.features);
    if (requestedFeatures === null) {
      return reply(400, { error: "Invalid features", code: "invalid_features" }, headers);
    }
  }

  if (
    action === "grant"
    && Object.hasOwn(body, "researchQuota")
    && (
      !Number.isInteger(body.researchQuota)
      || body.researchQuota < 1
      || body.researchQuota > MAX_RESEARCH_QUOTA
    )
  ) {
    return reply(400, { error: "Invalid research quota", code: "invalid_research_quota" }, headers);
  }

  const key = `${MEMBER_PREFIX}${email}`;
  const existing = await readMember(env.SHARED_DATA, key);

  if (action === "delete") {
    if (existing === null) {
      return reply(404, { error: "Member not found", code: "not_found" }, headers);
    }
    await env.SHARED_DATA.delete(key);
    const roster = await syncRoster(env, email, "remove");
    return reply(200, { success: true, deleted: true, roster }, headers);
  }

  if (action === "revoke") {
    if (existing === null) {
      return reply(404, { error: "Member not found", code: "not_found" }, headers);
    }
    const revoked = { ...existing, features: {} };
    delete revoked.researchQuota;
    delete revoked.grantedAt;
    await env.SHARED_DATA.put(key, JSON.stringify(revoked));
    const roster = await syncRoster(env, email, "remove");
    return reply(200, { success: true, member: memberResponse(email, revoked), roster }, headers);
  }

  const granted = {
    ...(existing || {}),
    features: {
      ...(normalizeFeatures(existing?.features) ?? {}),
      ...(requestedFeatures ?? {}),
    },
    grantedAt: new Date().toISOString(),
  };
  if (Object.hasOwn(body, "researchQuota")) {
    granted.researchQuota = body.researchQuota;
  }
  await env.SHARED_DATA.put(key, JSON.stringify(granted));
  const roster = await syncRoster(env, email, "append");
  return reply(200, { success: true, member: memberResponse(email, granted), roster }, headers);
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = responseHeaders(request, env);

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

  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers });
  }

  const accessPayload = await getAccessPayload(request, env);
  const email = accessPayload?.email?.toLowerCase();
  if (!email) {
    return reply(401, { error: "Authentication required" }, headers);
  }
  if (!isTrustedOrigin(request, env)) {
    return reply(403, { error: "Forbidden" }, headers);
  }
  if (!isAdminEmail(email, env)) {
    return reply(403, {
      error: "Member administration is admin-only",
      code: "admin_only",
    }, headers);
  }

  try {
    if (request.method === "GET") {
      const members = await getMembers(env);
      return reply(200, { success: true, members, count: members.length }, headers);
    }

    const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
    if (parsed.error === "request_too_large") {
      return reply(413, {
        error: "Request body too large",
        code: "request_too_large",
      }, headers);
    }
    if (parsed.error) {
      return reply(400, { error: "Invalid request", code: "invalid_request" }, headers);
    }
    return await mutateMember(parsed.value, env, headers);
  } catch (err) {
    console.error("members unexpected error", err);
    return reply(500, { success: false, message: "Member administration unavailable." }, headers);
  }
}
