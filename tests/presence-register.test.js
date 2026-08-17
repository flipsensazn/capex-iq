import assert from "node:assert/strict";
import test from "node:test";

import {
  hashPresenceSession,
  onRequest as presence,
  shouldCleanupStaleSessions,
} from "../functions/presence.js";
import {
  AccessRegistrationError,
  onRequest as register,
  registerMemberInAccess,
} from "../functions/register.js";

const b64url = value => Buffer.from(value).toString("base64url");

async function createAccessJwt({ aud, email = "member@example.com", sub = "member-123" }) {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const kid = `test-${crypto.randomUUID()}`;
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    aud,
    email,
    sub,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const input = `${head}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(input)
  );
  return {
    jwt: `${input}.${Buffer.from(signature).toString("base64url")}`,
    jwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
  };
}

async function accessFixture(overrides = {}) {
  const teamDomain = `presence-${crypto.randomUUID()}.example.com`;
  const accessAud = `aud-${crypto.randomUUID()}`;
  const { jwt, jwk } = await createAccessJwt({ aud: accessAud, ...overrides });
  return { teamDomain, accessAud, jwt, jwk };
}

function presenceRequest(jwt, session = "6ba7b810-9dad-4d80-b641-00c04fd430c8") {
  return new Request("https://capex-iq.us/presence", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `CF_Authorization=${jwt}`,
      Origin: "https://capex-iq.us",
    },
    body: JSON.stringify({ session }),
  });
}

function basePresenceEnv(fixture, limiter = async () => ({ success: true })) {
  return {
    ACCESS_TEAM_DOMAIN: fixture.teamDomain,
    ACCESS_AUD: fixture.accessAud,
    ALLOWED_ORIGIN: "https://capex-iq.us",
    DATABASE_URL: "postgresql://user:pass@example.neon.tech/db",
    PRESENCE_RATE_LIMITER: { limit: limiter },
  };
}

test("presence requires a verified Access identity", { concurrency: false }, async () => {
  let limiterCalls = 0;
  const response = await presence({
    request: presenceRequest("not-a-jwt"),
    env: {
      ACCESS_TEAM_DOMAIN: "presence-no-auth.example.com",
      ACCESS_AUD: "audience",
      ALLOWED_ORIGIN: "https://capex-iq.us",
      PRESENCE_RATE_LIMITER: { limit: async () => { limiterCalls += 1; } },
    },
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "authentication_required");
  assert.equal(limiterCalls, 0);
});

test("presence rejects anything other than an exact UUID v4", { concurrency: false }, async () => {
  const fixture = await accessFixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url) === `https://${fixture.teamDomain}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [fixture.jwk] });
    }
    throw new Error("Database should not be called");
  };
  try {
    for (const session of [
      "6ba7b810-9dad-1d80-b641-00c04fd430c8",
      "6ba7b810-9dad-4d80-b641-00c04fd430c8-extra",
      "not-a-uuid",
    ]) {
      const response = await presence({
        request: presenceRequest(fixture.jwt, session),
        env: basePresenceEnv(fixture),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "invalid_request");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("presence rate-limits by verified subject before database work", { concurrency: false }, async () => {
  const fixture = await accessFixture({ sub: "subject-456" });
  const originalFetch = globalThis.fetch;
  let limiterKey;
  let databaseCalls = 0;
  globalThis.fetch = async url => {
    if (String(url) === `https://${fixture.teamDomain}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [fixture.jwk] });
    }
    databaseCalls += 1;
    throw new Error("Database should not be called");
  };
  try {
    const response = await presence({
      request: presenceRequest(fixture.jwt),
      env: basePresenceEnv(fixture, async ({ key }) => {
        limiterKey = key;
        return { success: false };
      }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(limiterKey, "subject-456");
    assert.equal(databaseCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("presence stores only a stable identity-scoped hash and counts the current upsert", { concurrency: false }, async () => {
  const fixture = await accessFixture({ sub: "private-subject" });
  const originalFetch = globalThis.fetch;
  const databaseBodies = [];
  const background = [];
  globalThis.fetch = async (url, options) => {
    if (String(url) === `https://${fixture.teamDomain}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [fixture.jwk] });
    }
    databaseBodies.push(JSON.parse(options.body));
    return Response.json({ rows: [{ active_users: "7" }] });
  };
  try {
    const response = await presence({
      request: presenceRequest(fixture.jwt),
      env: basePresenceEnv(fixture),
      waitUntil: promise => background.push(promise),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { count: 7 });
    const heartbeat = databaseBodies[0];
    assert.match(heartbeat.query, /RETURNING session_id/);
    assert.match(heartbeat.query, /UNION ALL/);
    assert.match(heartbeat.query, /last_seen >= NOW\(\) - INTERVAL '2 minutes'/);
    assert.equal(heartbeat.params[0].length, 43);
    assert.doesNotMatch(heartbeat.params[0], /private-subject|6ba7b810/i);
    await Promise.all(background);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("presence session hashes are stable and identity scoped", async () => {
  const session = "6ba7b810-9dad-4d80-b641-00c04fd430c8";
  const first = await hashPresenceSession("sub:one", session);
  assert.equal(first, await hashPresenceSession("sub:one", session.toUpperCase()));
  assert.notEqual(first, await hashPresenceSession("sub:two", session));
  assert.notEqual(first, await hashPresenceSession("sub:one", "6ba7b811-9dad-4d80-b641-00c04fd430c8"));
  assert.equal(first.length, 43);
  assert.equal(shouldCleanupStaleSessions(12), true);
  assert.equal(shouldCleanupStaleSessions(13), false);
});

function registerRequest(body, headers = {}) {
  return new Request("https://capex-iq.us/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10",
      Origin: "https://capex-iq.us",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function baseRegisterEnv(overrides = {}) {
  return {
    ALLOWED_ORIGIN: "https://capex-iq.us",
    TURNSTILE_SITE_KEY: "public-site-key",
    TURNSTILE_SECRET_KEY: "private-secret-key",
    CF_ACCESS_API_TOKEN: "access-token",
    REGISTER_RATE_LIMITER: { limit: async () => ({ success: true }) },
    OPERATION_COORDINATOR: {
      getByName: () => ({ fetch: async () => Response.json({ success: true, already: false }) }),
    },
    ...overrides,
  };
}

test("register GET exposes only the public Turnstile site key", async () => {
  const response = await register({
    request: new Request("https://capex-iq.us/register"),
    env: baseRegisterEnv(),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { success: true, siteKey: "public-site-key" });

  const unavailable = await register({
    request: new Request("https://capex-iq.us/register"),
    env: baseRegisterEnv({ TURNSTILE_SITE_KEY: "" }),
  });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "registration_unavailable");
});

test("register rejects invalid input before rate limiting or verification", async () => {
  let limiterCalls = 0;
  const response = await register({
    request: registerRequest({ email: "bad", turnstileToken: "" }),
    env: baseRegisterEnv({
      REGISTER_RATE_LIMITER: { limit: async () => { limiterCalls += 1; return { success: true }; } },
    }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "invalid_email");
  assert.equal(limiterCalls, 0);
});

test("register cancels an oversized streamed body without Content-Length", async () => {
  let limiterCalls = 0;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(5 * 1024)));
      controller.close();
    },
  });
  const request = new Request("https://capex-iq.us/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": "203.0.113.10",
      Origin: "https://capex-iq.us",
    },
    body: stream,
    duplex: "half",
  });
  const response = await register({
    request,
    env: baseRegisterEnv({
      REGISTER_RATE_LIMITER: { limit: async () => { limiterCalls += 1; return { success: true }; } },
    }),
  });

  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "request_too_large");
  assert.equal(limiterCalls, 0);
});

test("register rate limit denial never consumes the Turnstile challenge", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error("Unexpected Siteverify"); };
  try {
    const response = await register({
      request: registerRequest({ email: "member@example.com", turnstileToken: "challenge-token" }),
      env: baseRegisterEnv({
        REGISTER_RATE_LIMITER: { limit: async () => ({ success: false }) },
      }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("register verifies Turnstile action and hostname before using the coordinator", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let verificationBody;
  let coordinatorName;
  let coordinatorRequest;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://challenges.cloudflare.com/turnstile/v0/siteverify");
    verificationBody = JSON.parse(options.body);
    return Response.json({ success: true, action: "turnstile-spin-v1", hostname: "capex-iq.us" });
  };
  try {
    const response = await register({
      request: registerRequest({ email: "MEMBER@EXAMPLE.COM", turnstileToken: "challenge-token" }),
      env: baseRegisterEnv({
        OPERATION_COORDINATOR: {
          getByName(name) {
            coordinatorName = name;
            return {
              async fetch(request) {
                coordinatorRequest = request;
                return Response.json({ success: true, already: false, message: "registered" }, { status: 201 });
              },
            };
          },
        },
      }),
    });
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { success: true, already: false, message: "registered" });
    assert.deepEqual(verificationBody, {
      secret: "private-secret-key",
      response: "challenge-token",
      remoteip: "203.0.113.10",
      idempotency_key: verificationBody.idempotency_key,
    });
    assert.match(verificationBody.idempotency_key, /^[0-9a-f-]{36}$/i);
    assert.equal(coordinatorName, "registration:members");
    assert.equal(coordinatorRequest.url, "https://operation-coordinator/register-member");
    assert.deepEqual(await coordinatorRequest.json(), { email: "member@example.com" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("register rejects a valid challenge with the wrong action or hostname", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const verification of [
      { success: true, action: "wrong", hostname: "capex-iq.us" },
      { success: true, action: "turnstile-spin-v1", hostname: "attacker.example" },
    ]) {
      let coordinatorCalls = 0;
      globalThis.fetch = async () => Response.json(verification);
      const response = await register({
        request: registerRequest({ email: "member@example.com", turnstileToken: "challenge-token" }),
        env: baseRegisterEnv({
          OPERATION_COORDINATOR: {
            getByName: () => ({ fetch: async () => { coordinatorCalls += 1; } }),
          },
        }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "invalid_verification");
      assert.equal(coordinatorCalls, 0);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Access registration uses a configured email list atomically", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith("/items?per_page=1000")) return Response.json({ success: true, result: [] });
    return Response.json({ success: true, result: {} });
  };
  try {
    const result = await registerMemberInAccess({
      CF_ACCESS_API_TOKEN: "access-token",
      ACCESS_MEMBERS_LIST_ID: "members-list",
    }, "MEMBER@EXAMPLE.COM");
    assert.equal(result.success, true);
    assert.equal(result.already, false);
    assert.equal(requests.length, 2);
    assert.match(requests[0].url, /gateway\/lists\/members-list\/items/);
    assert.equal(requests[1].options.method, "PATCH");
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      append: [{ value: "member@example.com" }],
      remove: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Access registration failures retain safe status and code metadata", async () => {
  await assert.rejects(
    registerMemberInAccess({}, "member@example.com"),
    error => error instanceof AccessRegistrationError
      && error.status === 503
      && error.code === "registration_unavailable"
  );
});
