// functions/register.js
// Public beta registration, protected by Turnstile and serialized through the
// site Worker's OperationCoordinator Durable Object.

import { isTrustedOrigin } from "./access-lib.js";
import { readBoundedJson } from "./bounded-json.js";

const MEMBERS_GROUP_NAME = "Capex IQ Members";
const GROUP_ID_KV_KEY = "accessMembersTargetExact_v2";
const TURNSTILE_ACTION = "turnstile-spin-v1";
const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_BODY_BYTES = 4 * 1024;
const MAX_TURNSTILE_TOKEN_LENGTH = 2048;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DEFAULT_ACCOUNT_ID = "0e727bf4fae81b99443d3150ca244484";

export class AccessRegistrationError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AccessRegistrationError";
    this.status = status;
    this.code = code;
  }
}

function responseHeaders(request, env) {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json",
    "Vary": "Origin",
  });
  const origin = request.headers.get("Origin") || "";
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN);
  }
  return headers;
}

function reply(status, body, headers, extraHeaders = {}) {
  const next = new Headers(headers);
  for (const [name, value] of Object.entries(extraHeaders)) next.set(name, value);
  return new Response(JSON.stringify(body), { status, headers: next });
}

function registrationError(status, code, message) {
  return { status, body: { success: false, code, message } };
}

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validEmail(email) {
  return email.length <= 254 && EMAIL_RE.test(email);
}

function normalizedName(value) {
  return typeof value === "string" ? value.toLowerCase().replace(/\s+/g, " ").trim() : "";
}

function exactRosterName(value) {
  return normalizedName(value) === normalizedName(MEMBERS_GROUP_NAME);
}

async function cloudflareJson(url, options, failureMessage) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      signal: options?.signal || AbortSignal.timeout(10_000),
    });
  } catch {
    throw new AccessRegistrationError(502, "access_api_failed", failureMessage);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new AccessRegistrationError(502, "access_api_failed", failureMessage);
  }
  if (!response.ok || body?.success === false) {
    throw new AccessRegistrationError(502, "access_api_failed", failureMessage);
  }
  return body;
}

async function discoverRoster(env, base, apiHeaders) {
  const [groupsResult, listsResult] = await Promise.allSettled([
    cloudflareJson(
      `${base}/access/groups?per_page=50`,
      { headers: apiHeaders },
      "Unable to discover the member roster"
    ),
    cloudflareJson(
      `${base}/gateway/lists`,
      { headers: apiHeaders },
      "Unable to discover the member roster"
    ),
  ]);
  if (groupsResult.status === "rejected" && listsResult.status === "rejected") {
    throw new AccessRegistrationError(502, "access_api_failed", "Unable to discover the member roster");
  }
  const groupsBody = groupsResult.status === "fulfilled" ? groupsResult.value : null;
  const listsBody = listsResult.status === "fulfilled" ? listsResult.value : null;
  const groups = Array.isArray(groupsBody?.result) ? groupsBody.result : [];
  const lists = Array.isArray(listsBody?.result) ? listsBody.result : [];
  const emailLists = lists.filter(item => String(item?.type || "").toUpperCase() === "EMAIL");

  const exactList = emailLists.find(item => exactRosterName(item?.name));
  const exactGroup = groups.find(item => exactRosterName(item?.name));
  if (exactList) return `list:${exactList.id}`;
  if (exactGroup) return `group:${exactGroup.id}`;
  throw new AccessRegistrationError(503, "roster_unavailable", "Registration is being set up — check back soon.");
}

async function resolveRosterTarget(env, base, apiHeaders) {
  const configuredList = typeof env.ACCESS_MEMBERS_LIST_ID === "string"
    ? env.ACCESS_MEMBERS_LIST_ID.trim()
    : "";
  if (configuredList) return `list:${configuredList}`;

  const configuredGroup = typeof env.ACCESS_MEMBERS_GROUP_ID === "string"
    ? env.ACCESS_MEMBERS_GROUP_ID.trim()
    : "";
  if (configuredGroup) return `group:${configuredGroup}`;

  let cached = null;
  if (env.SHARED_DATA) {
    try { cached = await env.SHARED_DATA.get(GROUP_ID_KV_KEY); } catch {}
  }
  if (/^(?:list|group):[^:]+$/.test(cached || "")) return cached;

  const target = await discoverRoster(env, base, apiHeaders);
  if (env.SHARED_DATA) {
    try { await env.SHARED_DATA.put(GROUP_ID_KV_KEY, target); } catch {}
  }
  return target;
}

export async function registerMemberInAccess(env, emailValue) {
  const email = normalizeEmail(emailValue);
  if (!validEmail(email)) {
    throw new AccessRegistrationError(400, "invalid_email", "That doesn't look like a valid email address.");
  }
  if (!env.CF_ACCESS_API_TOKEN) {
    throw new AccessRegistrationError(503, "registration_unavailable", "Registration isn't open yet — check back soon.");
  }

  const accountId = env.ACCESS_ACCOUNT_ID || DEFAULT_ACCOUNT_ID;
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const apiHeaders = {
    "Authorization": `Bearer ${env.CF_ACCESS_API_TOKEN}`,
    "Content-Type": "application/json",
  };

  try {
    const target = await resolveRosterTarget(env, base, apiHeaders);
    const separator = target.indexOf(":");
    const kind = target.slice(0, separator);
    const targetId = target.slice(separator + 1);
    let already = false;

    if (kind === "list") {
      const itemsBody = await cloudflareJson(
        `${base}/gateway/lists/${targetId}/items?per_page=1000`,
        { headers: apiHeaders },
        "Unable to read the member roster"
      );
      const items = Array.isArray(itemsBody?.result) ? itemsBody.result : [];
      already = items.some(item => normalizeEmail(item?.value) === email);
      if (!already) {
        await cloudflareJson(
          `${base}/gateway/lists/${targetId}`,
          {
            method: "PATCH",
            headers: apiHeaders,
            body: JSON.stringify({ append: [{ value: email }], remove: [] }),
          },
          "Unable to update the member roster"
        );
      }
    } else if (kind === "group") {
      const groupBody = await cloudflareJson(
        `${base}/access/groups/${targetId}`,
        { headers: apiHeaders },
        "Unable to read the member roster"
      );
      const group = groupBody?.result;
      if (!group || typeof group !== "object") {
        throw new AccessRegistrationError(502, "access_api_failed", "Unable to read the member roster");
      }
      const include = Array.isArray(group.include) ? [...group.include] : [];
      already = include.some(rule => normalizeEmail(rule?.email?.email) === email);
      if (!already) {
        include.push({ email: { email } });
        await cloudflareJson(
          `${base}/access/groups/${targetId}`,
          {
            method: "PUT",
            headers: apiHeaders,
            body: JSON.stringify({
              name: group.name,
              include,
              exclude: Array.isArray(group.exclude) ? group.exclude : [],
              require: Array.isArray(group.require) ? group.require : [],
            }),
          },
          "Unable to update the member roster"
        );
      }
    } else {
      throw new AccessRegistrationError(503, "roster_unavailable", "Registration is being set up — check back soon.");
    }

    return {
      success: true,
      already,
      message: already
        ? "You're already registered — click Sign In to continue with Google."
        : "You're in! Click Sign In to continue with Google.",
    };
  } catch (error) {
    if (error instanceof AccessRegistrationError) throw error;
    throw new AccessRegistrationError(502, "access_api_failed", "Registration failed — please try again.");
  }
}

async function verifyTurnstile(env, token, remoteIp, expectedHostname) {
  let response;
  try {
    response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteIp,
        idempotency_key: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return registrationError(503, "verification_unavailable", "Security verification is temporarily unavailable.");
  }

  let verification;
  try {
    verification = await response.json();
  } catch {
    return registrationError(503, "verification_unavailable", "Security verification is temporarily unavailable.");
  }
  if (!response.ok || !verification || typeof verification !== "object") {
    return registrationError(503, "verification_unavailable", "Security verification is temporarily unavailable.");
  }
  if (verification.success !== true) {
    return registrationError(400, "turnstile_failed", "Complete the security check and try again.");
  }
  const hostname = typeof verification.hostname === "string" ? verification.hostname.toLowerCase() : "";
  if (verification.action !== TURNSTILE_ACTION || hostname !== expectedHostname) {
    return registrationError(400, "invalid_verification", "Security verification was invalid. Please try again.");
  }
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = responseHeaders(request, env);

  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    return new Response(null, { status: 204, headers });
  }
  if (request.method === "GET") {
    if (!env.TURNSTILE_SITE_KEY) {
      return reply(503, registrationError(
        503,
        "registration_unavailable",
        "Registration isn't open yet — check back soon."
      ).body, headers);
    }
    return reply(200, { success: true, siteKey: env.TURNSTILE_SITE_KEY }, headers);
  }
  if (request.method !== "POST") {
    return reply(405, { success: false, code: "method_not_allowed", message: "Method Not Allowed" }, headers);
  }
  if (!isTrustedOrigin(request, env)) {
    return reply(403, { success: false, code: "forbidden", message: "Forbidden" }, headers);
  }

  const contentType = (request.headers.get("Content-Type") || "").split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return reply(415, { success: false, code: "unsupported_media_type", message: "Content-Type must be application/json." }, headers);
  }
  const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
  if (parsed.error === "request_too_large") {
    return reply(413, { success: false, code: parsed.error, message: "Request body too large." }, headers);
  }
  if (parsed.error) {
    return reply(400, { success: false, code: "invalid_request", message: "Invalid request." }, headers);
  }
  // JSON.parse accepts bare `null`, numbers and strings; only `null` would
  // throw on property access below, so reject every non-object body here.
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return reply(400, { success: false, code: "invalid_request", message: "Invalid request." }, headers);
  }

  const email = normalizeEmail(parsed.value.email);
  const turnstileToken = typeof parsed.value.turnstileToken === "string"
    ? parsed.value.turnstileToken.trim()
    : "";
  if (!validEmail(email)) {
    return reply(400, { success: false, code: "invalid_email", message: "That doesn't look like a valid email address." }, headers);
  }
  if (!turnstileToken || turnstileToken.length > MAX_TURNSTILE_TOKEN_LENGTH) {
    return reply(400, { success: false, code: "invalid_turnstile_token", message: "Complete the security check and try again." }, headers);
  }

  if (
    !env.TURNSTILE_SECRET_KEY
    || !env.CF_ACCESS_API_TOKEN
    || !env.REGISTER_RATE_LIMITER
    || typeof env.OPERATION_COORDINATOR?.getByName !== "function"
  ) {
    return reply(503, {
      success: false,
      code: "registration_unavailable",
      message: "Registration isn't open yet — check back soon.",
    }, headers);
  }

  const remoteIp = request.headers.get("CF-Connecting-IP") || "";
  if (!remoteIp) {
    return reply(400, { success: false, code: "invalid_request", message: "Unable to verify this request." }, headers);
  }

  let expectedHostname;
  try {
    expectedHostname = new URL(env.ALLOWED_ORIGIN || request.url).hostname.toLowerCase();
    if (!expectedHostname) throw new Error("Missing hostname");
  } catch {
    return reply(503, {
      success: false,
      code: "registration_unavailable",
      message: "Registration isn't open yet — check back soon.",
    }, headers);
  }

  try {
    const { success } = await env.REGISTER_RATE_LIMITER.limit({ key: remoteIp });
    if (!success) {
      return reply(
        429,
        { success: false, code: "rate_limited", message: "Too many registration attempts. Try again in a minute." },
        headers,
        { "Retry-After": "60" }
      );
    }
  } catch {
    return reply(503, {
      success: false,
      code: "rate_limit_unavailable",
      message: "Registration is temporarily unavailable.",
    }, headers);
  }

  const verificationError = await verifyTurnstile(env, turnstileToken, remoteIp, expectedHostname);
  if (verificationError) return reply(verificationError.status, verificationError.body, headers);

  try {
    const coordinator = env.OPERATION_COORDINATOR.getByName("registration:members");
    const response = await coordinator.fetch(new Request("https://operation-coordinator/register-member", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }));
    const responseHeaders = new Headers(headers);
    responseHeaders.set("Content-Type", "application/json");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } catch {
    return reply(503, {
      success: false,
      code: "registration_unavailable",
      message: "Registration is temporarily unavailable.",
    }, headers);
  }
}
