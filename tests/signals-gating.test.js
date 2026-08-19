import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as candidates } from "../functions/candidates.js";
import { onRequest as capexHistory } from "../functions/capex-history.js";
import { onRequest as composite } from "../functions/composite.js";
import { onRequest as exposure } from "../functions/exposure.js";
import { onRequest as gauges } from "../functions/gauges.js";
import { onRequest as scoreboard } from "../functions/scoreboard.js";
import { onRequest as stress } from "../functions/stress.js";
import { createAccessFixture, warmAccessFixture } from "./access-fixture.js";

const ORIGIN = "https://capex-iq.us";
const DATABASE_URL = "postgresql://user:pass@example.neon.tech/watchlist";
const MEMBER_EMAIL = "member@example.com";
const VISITOR_EMAIL = "visitor@example.com";
const ADMIN_EMAIL = "admin@example.com";

const access = await createAccessFixture("signals-gating");
const memberJwt = await access.createJwt({ email: MEMBER_EMAIL, sub: "signals-member" });
const visitorJwt = await access.createJwt({ email: VISITOR_EMAIL, sub: "signals-visitor" });
const adminJwt = await access.createJwt({ email: ADMIN_EMAIL, sub: "signals-admin" });
await warmAccessFixture(access, memberJwt);

function createKv(entries = {}) {
  const store = new Map();
  const gets = [];
  const puts = [];

  const seed = (key, value) => {
    store.set(key, typeof value === "string" ? value : JSON.stringify(value));
  };
  for (const [key, value] of Object.entries(entries)) seed(key, value);

  return {
    gets,
    puts,
    seed,
    async get(key, type) {
      gets.push({ key, type });
      const value = store.get(key);
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value, options) {
      store.set(key, value);
      puts.push({ key, value, options });
    },
  };
}

function createEnv(kv) {
  return {
    ACCESS_TEAM_DOMAIN: access.teamDomain,
    ACCESS_AUD: access.accessAud,
    ADMIN_EMAILS: ADMIN_EMAIL,
    ALLOWED_ORIGIN: ORIGIN,
    DATABASE_URL,
    SHARED_DATA: kv,
  };
}

function endpointRequest(path, jwt, origin = ORIGIN) {
  const headers = new Headers();
  if (origin != null) headers.set("Origin", origin);
  if (jwt) headers.set("Cookie", `CF_Authorization=${jwt}`);
  return new Request(`${ORIGIN}${path}`, { method: "GET", headers });
}

async function withFetch(stub, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const signalEndpoints = [
  ["composite", "/composite", composite],
  ["scoreboard", "/scoreboard", scoreboard],
  ["gauges", "/gauges", gauges],
  ["stress", "/stress", stress],
  ["exposure", "/exposure", exposure],
  ["capex history", "/capex-history", capexHistory],
];

for (const [name, path, handler] of signalEndpoints) {
  test(`${name} requires a trusted signals member and allows admins`, { concurrency: false }, async () => {
    const kv = createKv({
      [`member:${MEMBER_EMAIL}`]: { features: { signals: true } },
      [`member:${VISITOR_EMAIL}`]: { features: {} },
    });
    const env = createEnv(kv);

    await withFetch(async () => Response.json({ rows: [] }), async () => {
      let response = await handler({ request: endpointRequest(path, null), env });
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Authentication required" });
      assert.equal(response.headers.get("Cache-Control"), "no-store");

      response = await handler({
        request: endpointRequest(path, memberJwt, "https://attacker.example"),
        env,
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: "Forbidden" });
      assert.equal(response.headers.get("Cache-Control"), "no-store");

      response = await handler({ request: endpointRequest(path, visitorJwt), env });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: "Signals access is not enabled for this account",
        code: "members_only",
      });
      assert.equal(response.headers.get("Cache-Control"), "no-store");

      response = await handler({ request: endpointRequest(path, memberJwt), env });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "private, max-age=300");
      assert.equal((await response.json()).success, true);

      response = await handler({ request: endpointRequest(path, adminJwt), env });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "private, max-age=300");
      assert.equal((await response.json()).success, true);
    });
  });
}

test("candidates GET requires a trusted admin", { concurrency: false }, async () => {
  const kv = createKv();
  const env = createEnv(kv);

  await withFetch(async () => Response.json({ rows: [] }), async () => {
    let response = await candidates({ request: endpointRequest("/candidates", null), env });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
    assert.equal(response.headers.get("Cache-Control"), "no-store");

    response = await candidates({
      request: endpointRequest("/candidates", adminJwt, "https://attacker.example"),
      env,
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });
    assert.equal(response.headers.get("Cache-Control"), "no-store");

    response = await candidates({ request: endpointRequest("/candidates", visitorJwt), env });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "Candidate review is admin-only",
      code: "admin_only",
    });
    assert.equal(response.headers.get("Cache-Control"), "no-store");

    response = await candidates({ request: endpointRequest("/candidates", adminJwt), env });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).success, true);
  });
});

test("signal payload cache is read only after the gate and avoids a second Neon fetch", { concurrency: false }, async () => {
  const cacheKey = "capexHistoryView_v1";
  const kv = createKv({
    [`member:${MEMBER_EMAIL}`]: { features: { signals: true } },
    [`member:${VISITOR_EMAIL}`]: { features: {} },
  });
  const env = createEnv(kv);
  let neonFetches = 0;

  await withFetch(async () => {
    neonFetches += 1;
    return Response.json({ rows: [] });
  }, async () => {
    const firstResponse = await capexHistory({
      request: endpointRequest("/capex-history", memberJwt),
      env,
    });
    const firstBody = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(neonFetches, 1);
    assert.equal(kv.puts.length, 1);
    assert.equal(kv.puts[0].key, cacheKey);
    assert.deepEqual(kv.puts[0].options, { expirationTtl: 600 });
    assert.deepEqual(JSON.parse(kv.puts[0].value), firstBody);

    const secondResponse = await capexHistory({
      request: endpointRequest("/capex-history", memberJwt),
      env,
    });
    assert.equal(secondResponse.status, 200);
    assert.deepEqual(await secondResponse.json(), firstBody);
    assert.equal(neonFetches, 1);

    const cacheReadsBeforeDeniedRequests = kv.gets.filter(({ key }) => key === cacheKey).length;

    const anonymousResponse = await capexHistory({
      request: endpointRequest("/capex-history", null),
      env,
    });
    assert.equal(anonymousResponse.status, 401);

    const visitorResponse = await capexHistory({
      request: endpointRequest("/capex-history", visitorJwt),
      env,
    });
    assert.equal(visitorResponse.status, 403);
    assert.equal((await visitorResponse.json()).code, "members_only");

    assert.equal(
      kv.gets.filter(({ key }) => key === cacheKey).length,
      cacheReadsBeforeDeniedRequests,
    );
    assert.equal(neonFetches, 1);
  });
});
