import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as members } from "../functions/members.js";
import { createAccessFixture, warmAccessFixture } from "./access-fixture.js";

const ORIGIN = "https://capex-iq.us";
const ADMIN_EMAIL = "admin@example.com";
const MEMBER_EMAIL = "member@example.com";
const SERVICE_TOKEN = "members-service-token";
const ACCESS_API_TOKEN = "members-access-api-token";
const ACCESS_MEMBERS_LIST_ID = "capex-iq-members-list";
const DEFAULT_ACCESS_ACCOUNT_ID = "0e727bf4fae81b99443d3150ca244484";
const ALL_FEATURES = {
  research: true,
  radar: true,
  funds: true,
  signals: true,
};

const access = await createAccessFixture("members-endpoint");
const adminJwt = await access.createJwt({ email: ADMIN_EMAIL, sub: "members-admin" });
const memberJwt = await access.createJwt({ email: MEMBER_EMAIL, sub: "members-member" });
await warmAccessFixture(access, adminJwt);

function createKv(entries = {}, pages = null) {
  const values = new Map();
  const gets = [];
  const puts = [];
  const deletes = [];
  const lists = [];

  for (const [key, value] of Object.entries(entries)) {
    values.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }

  return {
    values,
    gets,
    puts,
    deletes,
    lists,
    async list(options) {
      lists.push(options);
      if (pages) {
        const page = pages[lists.length - 1];
        assert.ok(page, `Unexpected KV list page ${lists.length}`);
        return page;
      }
      return {
        keys: [...values.keys()]
          .filter(key => key.startsWith(options.prefix))
          .map(name => ({ name })),
        list_complete: true,
      };
    },
    async get(key, type) {
      gets.push({ key, type });
      const value = values.get(key);
      if (value == null) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value, options) {
      puts.push({ key, value, options });
      values.set(key, value);
    },
    async delete(key) {
      deletes.push(key);
      values.delete(key);
    },
  };
}

function createEnv(kv = createKv(), overrides = {}) {
  return {
    ACCESS_TEAM_DOMAIN: access.teamDomain,
    ACCESS_AUD: access.accessAud,
    ADMIN_EMAILS: ADMIN_EMAIL,
    ALLOWED_ORIGIN: ORIGIN,
    SIGNALS_SERVICE_TOKEN: SERVICE_TOKEN,
    SHARED_DATA: kv,
    ...overrides,
  };
}

function membersRequest(method, jwt, {
  origin = ORIGIN,
  body,
  serviceToken = null,
} = {}) {
  const headers = new Headers();
  if (origin != null) headers.set("Origin", origin);
  if (jwt) headers.set("Cookie", `CF_Authorization=${jwt}`);
  if (serviceToken != null) headers.set("X-Service-Token", serviceToken);

  const init = { method, headers };
  if (method === "POST") {
    headers.set("Content-Type", "application/json");
    init.body = JSON.stringify(body ?? {
      action: "grant",
      email: "new-member@example.com",
      features: ALL_FEATURES,
      researchQuota: 50,
    });
  }
  return new Request(`${ORIGIN}/members`, init);
}

async function callMembers(method, jwt, options = {}, env = createEnv()) {
  return members({ request: membersRequest(method, jwt, options), env });
}

async function withFetchStub(stub, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function assertNoStore(response) {
  assert.equal(response.headers.get("Cache-Control"), "no-store");
}

test("members preflight and unsupported methods are handled before authentication", async () => {
  const env = createEnv();
  const preflight = await callMembers("OPTIONS", null, {}, env);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS");
  assertNoStore(preflight);

  const unsupported = await callMembers("PUT", null, {}, env);
  assert.equal(unsupported.status, 405);
  assert.equal(await unsupported.text(), "Method Not Allowed");
  assertNoStore(unsupported);
});

for (const method of ["GET", "POST"]) {
  test(`members ${method} gate rejects anonymous requests with 401`, async () => {
    const kv = createKv();
    const env = createEnv(kv);
    for (const serviceToken of [null, SERVICE_TOKEN]) {
      const response = await callMembers(method, null, { serviceToken }, env);
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Authentication required" });
      assertNoStore(response);
    }
    assert.equal(kv.lists.length, 0);
    assert.equal(kv.gets.length, 0);
    assert.equal(kv.puts.length, 0);
  });

  test(`members ${method} gate rejects untrusted origins with 403`, async () => {
    const kv = createKv();
    const response = await callMembers(method, adminJwt, {
      origin: "https://attacker.example",
    }, createEnv(kv));

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });
    assertNoStore(response);
    assert.equal(kv.lists.length, 0);
    assert.equal(kv.gets.length, 0);
    assert.equal(kv.puts.length, 0);
  });

  test(`members ${method} gate rejects non-admin members with admin_only`, async () => {
    const kv = createKv();
    const response = await callMembers(method, memberJwt, {}, createEnv(kv));

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "Member administration is admin-only",
      code: "admin_only",
    });
    assertNoStore(response);
    assert.equal(kv.lists.length, 0);
    assert.equal(kv.gets.length, 0);
    assert.equal(kv.puts.length, 0);
  });

  test(`members ${method} gate allows admins with 200`, async () => {
    const response = await callMembers(method, adminJwt);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assertNoStore(response);
  });
}

test("members GET paginates all KV records, surfaces malformed records, and attaches research usage only", async () => {
  const olderEmail = "older@example.com";
  const researchEmail = "research@example.com";
  const undatedEmail = "undated@example.com";
  const malformedEmail = "malformed@example.com";
  const researchUsageKey = `usage:${researchEmail}:${new Date().toISOString().slice(0, 7)}`;
  const nonResearchUsageKey = `usage:${olderEmail}:${new Date().toISOString().slice(0, 7)}`;
  const kv = createKv({
    [`member:${olderEmail}`]: {
      features: { signals: true },
      registeredAt: "2026-08-01T12:00:00.000Z",
      source: "self-register",
    },
    [`member:${researchEmail}`]: {
      features: { research: true, radar: false },
      registeredAt: "2026-08-15T12:00:00.000Z",
      grantedAt: "2026-08-16T12:00:00.000Z",
      source: "owner-grant",
      researchQuota: 25,
    },
    [`member:${undatedEmail}`]: { features: {} },
    [`member:${malformedEmail}`]: "{not-valid-json",
    [researchUsageKey]: "7",
    [nonResearchUsageKey]: "99",
  }, [
    {
      keys: [
        { name: `member:${olderEmail}` },
        { name: `member:${malformedEmail}` },
      ],
      list_complete: false,
      cursor: "members-page-2",
    },
    {
      keys: [
        { name: `member:${researchEmail}` },
        { name: `member:${undatedEmail}` },
      ],
      list_complete: true,
    },
  ]);

  const response = await callMembers("GET", adminJwt, {}, createEnv(kv));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(body.success, true);
  assert.equal(body.count, 4);
  assert.deepEqual(kv.lists, [
    { prefix: "member:" },
    { prefix: "member:", cursor: "members-page-2" },
  ]);
  assert.deepEqual(body.members.slice(0, 2).map(member => member.email), [
    researchEmail,
    olderEmail,
  ]);
  assert.deepEqual(new Set(body.members.slice(2).map(member => member.email)), new Set([
    undatedEmail,
    malformedEmail,
  ]));

  assert.deepEqual(body.members.find(member => member.email === researchEmail), {
    email: researchEmail,
    features: { research: true, radar: false },
    registeredAt: "2026-08-15T12:00:00.000Z",
    grantedAt: "2026-08-16T12:00:00.000Z",
    source: "owner-grant",
    researchQuota: 25,
    usage: { used: 7, limit: 25 },
  });
  const older = body.members.find(member => member.email === olderEmail);
  assert.deepEqual(older, {
    email: olderEmail,
    features: { signals: true },
    registeredAt: "2026-08-01T12:00:00.000Z",
    grantedAt: null,
    source: "self-register",
    researchQuota: null,
  });
  assert.equal(Object.hasOwn(older, "usage"), false);
  assert.deepEqual(body.members.find(member => member.email === undatedEmail), {
    email: undatedEmail,
    features: {},
    registeredAt: null,
    grantedAt: null,
    source: null,
    researchQuota: null,
  });
  assert.deepEqual(body.members.find(member => member.email === malformedEmail), {
    email: malformedEmail,
    malformed: true,
  });
  assert.ok(kv.gets.some(({ key }) => key === researchUsageKey));
  assert.equal(kv.gets.some(({ key }) => key === nonResearchUsageKey), false);
});

test("members GET makes no roster API call when roster sync is configured", { concurrency: false }, async () => {
  let fetchCalls = 0;
  const response = await withFetchStub(async () => {
    fetchCalls += 1;
    throw new Error("GET must not call the roster API");
  }, () => callMembers("GET", adminJwt, {}, createEnv(createKv(), {
    CF_ACCESS_API_TOKEN: ACCESS_API_TOKEN,
    ACCESS_MEMBERS_LIST_ID,
  })));

  assert.equal(response.status, 200);
  assert.equal(fetchCalls, 0);
});

test("members POST grant rejects unknown and non-boolean feature fields", async () => {
  const kv = createKv();
  const env = createEnv(kv);
  for (const features of [
    { research: true, unknown: true },
    { research: "yes" },
  ]) {
    const response = await callMembers("POST", adminJwt, {
      body: { action: "grant", email: "lead@example.com", features },
    }, env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "invalid_features");
    assertNoStore(response);
  }
  assert.equal(kv.gets.length, 0);
  assert.equal(kv.puts.length, 0);
});

test("members POST grant merges known features over a lead and preserves registration metadata", async () => {
  const email = "lead@example.com";
  const registeredAt = "2026-08-01T12:00:00.000Z";
  const kv = createKv({
    [`member:${email}`]: {
      features: { radar: true, funds: false },
      registeredAt,
      source: "self-register",
      researchQuota: 10,
    },
  });
  const before = Date.now();
  const response = await callMembers("POST", adminJwt, {
    body: {
      action: "grant",
      email: "  LEAD@EXAMPLE.COM  ",
      features: { research: true, signals: true },
      researchQuota: 75,
    },
  }, createEnv(kv));
  const after = Date.now();
  const body = await response.json();

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.equal(body.success, true);
  assert.equal(body.member.email, email);
  assert.deepEqual(body.member.features, {
    research: true,
    radar: true,
    funds: false,
    signals: true,
  });
  assert.equal(body.member.registeredAt, registeredAt);
  assert.equal(body.member.source, "self-register");
  assert.equal(body.member.researchQuota, 75);
  assert.deepEqual(body.roster, { synced: false, reason: "unconfigured" });
  assert.ok(Date.parse(body.member.grantedAt) >= before);
  assert.ok(Date.parse(body.member.grantedAt) <= after);
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].key, `member:${email}`);

  const stored = JSON.parse(kv.values.get(`member:${email}`));
  assert.deepEqual(stored.features, body.member.features);
  assert.equal(stored.registeredAt, registeredAt);
  assert.equal(stored.source, "self-register");
  assert.equal(stored.researchQuota, 75);
  assert.equal(stored.grantedAt, body.member.grantedAt);
});

test("members POST grant patches the configured roster once with the normalized email", { concurrency: false }, async () => {
  const email = "new-member@example.com";
  const kv = createKv();
  const env = createEnv(kv, {
    CF_ACCESS_API_TOKEN: ACCESS_API_TOKEN,
    ACCESS_MEMBERS_LIST_ID,
  });
  const calls = [];

  const response = await withFetchStub(async (input, init) => {
    calls.push({ input, init });
    return Response.json({ success: true });
  }, () => callMembers("POST", adminJwt, {
    body: {
      action: "grant",
      email: `  ${email.toUpperCase()}  `,
      features: ALL_FEATURES,
    },
  }, env));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(kv.puts.length, 1);
  assert.deepEqual(body.roster, { synced: true });
  assert.equal(calls.length, 1);
  const [{ input, init }] = calls;
  assert.equal(
    String(input),
    `https://api.cloudflare.com/client/v4/accounts/${DEFAULT_ACCESS_ACCOUNT_ID}/gateway/lists/${env.ACCESS_MEMBERS_LIST_ID}`,
  );
  assert.equal(init.method, "PATCH");
  assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${env.CF_ACCESS_API_TOKEN}`);
  assert.deepEqual(JSON.parse(init.body), {
    append: [{ value: email }],
    remove: [],
  });
});

test("members POST reports unconfigured roster sync without attempting fetch", { concurrency: false }, async () => {
  const kv = createKv();
  let fetchCalls = 0;

  const response = await withFetchStub(async () => {
    fetchCalls += 1;
    throw new Error("Unconfigured roster sync must not call fetch");
  }, () => callMembers("POST", adminJwt, {
    body: { action: "grant", email: "unconfigured@example.com", features: ALL_FEATURES },
  }, createEnv(kv)));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(kv.puts.length, 1);
  assert.equal(fetchCalls, 0);
  assert.deepEqual(body.roster, { synced: false, reason: "unconfigured" });
});

test("members POST keeps the KV grant when the roster API fails", { concurrency: false }, async () => {
  const kv = createKv();
  const env = createEnv(kv, {
    CF_ACCESS_API_TOKEN: ACCESS_API_TOKEN,
    ACCESS_MEMBERS_LIST_ID,
  });
  const logged = [];
  const originalConsoleError = console.error;
  console.error = (...args) => logged.push(args);

  let response;
  try {
    response = await withFetchStub(
      async () => Response.json({ success: false }, { status: 500 }),
      () => callMembers("POST", adminJwt, {
        body: { action: "grant", email: "api-failure@example.com", features: ALL_FEATURES },
      }, env),
    );
  } finally {
    console.error = originalConsoleError;
  }
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(kv.puts.length, 1);
  assert.deepEqual(body.roster, { synced: false, reason: "api_error" });
  assert.ok(logged.some(args => args.includes(500)));
  assert.equal(JSON.stringify(logged).includes(ACCESS_API_TOKEN), false);
});

test("members POST rejects invalid actions, emails, and research quotas", async () => {
  const kv = createKv();
  const env = createEnv(kv);
  const cases = [
    [{ action: "promote", email: "lead@example.com" }, "invalid_request"],
    [{ action: "grant", email: "not-an-email", features: {} }, "invalid_request"],
    [{ action: "grant", email: "lead@example.com", researchQuota: 0 }, "invalid_research_quota"],
    [{ action: "grant", email: "lead@example.com", researchQuota: 10_001 }, "invalid_research_quota"],
    [{ action: "grant", email: "lead@example.com", researchQuota: 1.5 }, "invalid_research_quota"],
  ];

  for (const [requestBody, code] of cases) {
    const response = await callMembers("POST", adminJwt, { body: requestBody }, env);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, code);
    assertNoStore(response);
  }
  assert.equal(kv.gets.length, 0);
  assert.equal(kv.puts.length, 0);
});

test("members POST revoke keeps the lead while clearing grants and quota", async () => {
  const email = "granted@example.com";
  const registeredAt = "2026-08-01T12:00:00.000Z";
  const kv = createKv({
    [`member:${email}`]: {
      features: ALL_FEATURES,
      registeredAt,
      grantedAt: "2026-08-02T12:00:00.000Z",
      source: "self-register",
      researchQuota: 75,
    },
  });

  const response = await callMembers("POST", adminJwt, {
    body: { action: "revoke", email },
  }, createEnv(kv));
  const body = await response.json();

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.deepEqual(body, {
    success: true,
    member: {
      email,
      features: {},
      registeredAt,
      grantedAt: null,
      source: "self-register",
      researchQuota: null,
    },
    roster: { synced: false, reason: "unconfigured" },
  });
  const stored = JSON.parse(kv.values.get(`member:${email}`));
  assert.deepEqual(stored.features, {});
  assert.equal(stored.registeredAt, registeredAt);
  assert.equal(stored.source, "self-register");
  assert.equal(Object.hasOwn(stored, "grantedAt"), false);
  assert.equal(Object.hasOwn(stored, "researchQuota"), false);
});

test("members POST delete removes the KV record", async () => {
  const email = "delete@example.com";
  const key = `member:${email}`;
  const kv = createKv({ [key]: { features: {}, source: "self-register" } });

  const response = await callMembers("POST", adminJwt, {
    body: { action: "delete", email },
  }, createEnv(kv));

  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.deepEqual(await response.json(), {
    success: true,
    deleted: true,
    roster: { synced: false, reason: "unconfigured" },
  });
  assert.deepEqual(kv.deletes, [key]);
  assert.equal(kv.values.has(key), false);
});

test("members POST revoke and delete patch roster removal after the KV mutation", { concurrency: false }, async () => {
  for (const action of ["revoke", "delete"]) {
    const email = `${action}@example.com`;
    const key = `member:${email}`;
    const kv = createKv({ [key]: { features: ALL_FEATURES, researchQuota: 50 } });
    const env = createEnv(kv, {
      CF_ACCESS_API_TOKEN: ACCESS_API_TOKEN,
      ACCESS_MEMBERS_LIST_ID,
    });
    const calls = [];

    const response = await withFetchStub(async (input, init) => {
      calls.push({ input, init, kvChanged: action === "delete" ? !kv.values.has(key) : kv.puts.length === 1 });
      return Response.json({ success: true });
    }, () => callMembers("POST", adminJwt, {
      body: { action, email },
    }, env));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.deepEqual(body.roster, { synced: true });
    assert.equal(calls.length, 1);
    const [{ input, init, kvChanged }] = calls;
    assert.equal(kvChanged, true);
    assert.ok(String(input).includes(env.ACCESS_MEMBERS_LIST_ID));
    assert.equal(init.method, "PATCH");
    assert.equal(new Headers(init.headers).get("Authorization"), `Bearer ${env.CF_ACCESS_API_TOKEN}`);
    assert.deepEqual(JSON.parse(init.body), {
      append: [],
      remove: [email],
    });
  }
});

test("members POST revoke and delete return 404 for absent records", async () => {
  const kv = createKv();
  const env = createEnv(kv);
  for (const action of ["revoke", "delete"]) {
    const response = await callMembers("POST", adminJwt, {
      body: { action, email: "absent@example.com" },
    }, env);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "not_found");
    assertNoStore(response);
  }
  assert.equal(kv.puts.length, 0);
  assert.equal(kv.deletes.length, 0);
});

test("members POST enforces the 4KB body bound for streamed requests", async () => {
  const kv = createKv();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(4 * 1024 + 1)));
      controller.close();
    },
  });
  const request = new Request(`${ORIGIN}/members`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: `CF_Authorization=${adminJwt}`,
      Origin: ORIGIN,
    },
    body: stream,
    duplex: "half",
  });

  const response = await members({ request, env: createEnv(kv) });
  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: "Request body too large",
    code: "request_too_large",
  });
  assertNoStore(response);
  assert.equal(kv.gets.length, 0);
  assert.equal(kv.puts.length, 0);
});
