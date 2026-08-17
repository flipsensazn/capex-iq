// functions/presence.js

import { getAccessPayload, isTrustedOrigin } from "./access-lib.js";
import { readBoundedJson } from "./bounded-json.js";

const MAX_BODY_BYTES = 512;
const SESSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_WINDOW = "2 minutes";

const HEARTBEAT_SQL = `
  WITH upsert AS (
    INSERT INTO active_sessions (session_id, last_seen)
    VALUES ($1, NOW())
    ON CONFLICT (session_id) DO UPDATE SET last_seen = NOW()
    RETURNING session_id
  )
  SELECT COUNT(DISTINCT active.session_id) AS active_users
  FROM (
    SELECT session_id
    FROM active_sessions
    WHERE last_seen >= NOW() - INTERVAL '${ACTIVE_WINDOW}'
    UNION ALL
    SELECT session_id FROM upsert
  ) AS active;
`;

const CLEANUP_SQL = `
  DELETE FROM active_sessions
  WHERE last_seen < NOW() - INTERVAL '${ACTIVE_WINDOW}';
`;

function logFailure(event, error) {
  console.error(JSON.stringify({
    scope: "presence",
    event,
    errorType: error?.name || "Error",
  }));
}

function responseHeaders(request, env) {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json",
    "Vary": "Origin",
  });
  const origin = request.headers.get("Origin") || "";
  if (env.ALLOWED_ORIGIN && origin === env.ALLOWED_ORIGIN) {
    headers.set("Access-Control-Allow-Origin", env.ALLOWED_ORIGIN);
  }
  return headers;
}

function jsonResponse(body, status, headers, extraHeaders = {}) {
  const next = new Headers(headers);
  for (const [name, value] of Object.entries(extraHeaders)) next.set(name, value);
  return new Response(JSON.stringify(body), { status, headers: next });
}

function neonEndpoint(connectionString) {
  if (typeof connectionString !== "string" || !/^postgres(?:ql)?:\/\//i.test(connectionString)) {
    throw new Error("Invalid database configuration");
  }
  const url = new URL(connectionString.replace(/^postgres(?:ql)?:\/\//i, "https://"));
  if (!url.hostname) throw new Error("Invalid database configuration");
  return `https://${url.hostname}/sql`;
}

async function runNeonQuery(endpoint, connectionString, query, params = []) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": connectionString,
    },
    body: JSON.stringify({ query, params }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("Database query failed");
  return response.json();
}

function bytesToBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashPresenceSession(identity, session) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${identity}\0${session.toLowerCase()}`)
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

export function shouldCleanupStaleSessions(randomByte) {
  const sample = randomByte ?? crypto.getRandomValues(new Uint8Array(1))[0];
  return sample < 13;
}

export async function onRequest(context) {
  const { request, env } = context;
  const headers = responseHeaders(request, env);

  if (request.method === "OPTIONS") {
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    return new Response(null, { status: 204, headers });
  }
  if (request.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed", code: "method_not_allowed" }, 405, headers);
  }
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return jsonResponse({ error: "Presence is temporarily unavailable", code: "authentication_unavailable" }, 503, headers);
  }

  const accessPayload = await getAccessPayload(request, env);
  const subject = typeof accessPayload?.sub === "string" ? accessPayload.sub.trim() : "";
  const email = typeof accessPayload?.email === "string" ? accessPayload.email.trim().toLowerCase() : "";
  if (!subject && !email) {
    return jsonResponse({ error: "Authentication required", code: "authentication_required" }, 401, headers);
  }
  if (!isTrustedOrigin(request, env)) {
    return jsonResponse({ error: "Forbidden", code: "forbidden" }, 403, headers);
  }

  const parsed = await readBoundedJson(request, MAX_BODY_BYTES);
  if (parsed.error === "request_too_large") {
    return jsonResponse({ error: "Request body too large", code: parsed.error }, 413, headers);
  }
  const session = typeof parsed.value?.session === "string" ? parsed.value.session : "";
  if (parsed.error || !SESSION_PATTERN.test(session)) {
    return jsonResponse({ error: "Invalid session", code: "invalid_request" }, 400, headers);
  }

  if (!env.PRESENCE_RATE_LIMITER) {
    return jsonResponse({ error: "Presence is temporarily unavailable", code: "rate_limit_unavailable" }, 503, headers);
  }
  const identity = subject ? `sub:${subject}` : `email:${email}`;
  try {
    const { success } = await env.PRESENCE_RATE_LIMITER.limit({ key: subject || email });
    if (!success) {
      return jsonResponse(
        { error: "Too many presence updates", code: "rate_limited" },
        429,
        headers,
        { "Retry-After": "60" }
      );
    }
  } catch (error) {
    logFailure("rate_limit_failed", error);
    return jsonResponse({ error: "Presence is temporarily unavailable", code: "rate_limit_unavailable" }, 503, headers);
  }

  let endpoint;
  try {
    endpoint = neonEndpoint(env.DATABASE_URL);
  } catch (error) {
    logFailure("database_configuration_invalid", error);
    return jsonResponse({ error: "Presence is temporarily unavailable", code: "database_unavailable" }, 503, headers);
  }

  try {
    const sessionKey = await hashPresenceSession(identity, session);
    const result = await runNeonQuery(endpoint, env.DATABASE_URL, HEARTBEAT_SQL, [sessionKey]);
    const count = Number(result?.rows?.[0]?.active_users);
    if (!Number.isSafeInteger(count) || count < 1) throw new Error("Invalid database response");

    try {
      if (typeof context.waitUntil === "function" && shouldCleanupStaleSessions()) {
        context.waitUntil(
          runNeonQuery(endpoint, env.DATABASE_URL, CLEANUP_SQL)
            .catch(error => logFailure("cleanup_failed", error))
        );
      }
    } catch (error) {
      logFailure("cleanup_schedule_failed", error);
    }
    return jsonResponse({ count }, 200, headers);
  } catch (error) {
    logFailure("database_failed", error);
    return jsonResponse({ error: "Presence is temporarily unavailable", code: "database_unavailable" }, 503, headers);
  }
}
