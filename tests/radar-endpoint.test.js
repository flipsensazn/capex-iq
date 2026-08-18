import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as radar } from "../functions/radar.js";

const ORIGIN = "https://capex-iq.us";
const DATABASE_URL = "postgresql://user:pass@example.neon.tech/watchlist";
const NEON_SQL_URL = "https://example.neon.tech/sql";
const MEMBER_EMAIL = "member@example.com";

const b64url = value => Buffer.from(value).toString("base64url");

async function createAccessJwt({ aud, email, sub = "radar-member" }) {
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
  const kid = `radar-${crypto.randomUUID()}`;
  const payloadObject = {
    aud,
    sub,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  if (email !== undefined) payloadObject.email = email;

  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify(payloadObject));
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

async function createAccessFixture({ email = MEMBER_EMAIL } = {}) {
  const teamDomain = `radar-${crypto.randomUUID()}.example.com`;
  const accessAud = `radar-aud-${crypto.randomUUID()}`;
  const token = await createAccessJwt({ aud: accessAud, email });
  return {
    ...token,
    teamDomain,
    accessAud,
    jwksUrl: `https://${teamDomain}/cdn-cgi/access/certs`,
  };
}

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

function manifestRow(overrides = {}) {
  return {
    pipeline: "radar_scores",
    run_id: "radar-run",
    run_date: "2099-01-15",
    state: "success",
    started_at: "2099-01-15T10:00:00Z",
    finished_at: "2099-01-15T10:05:00Z",
    run_data_fresh_at: "2099-01-15T10:05:00Z",
    last_data_fresh_at: "2099-01-15T10:05:00Z",
    expected: "263",
    attempted: "263",
    usable: "215",
    known_no_data: "48",
    transient_failures: "0",
    degraded: "0",
    provider_coverage: "1",
    usable_coverage: "1",
    baseline_usable: "215",
    error_message: null,
    details: {},
    ...overrides,
  };
}

function radarRequest(jwt, path = "", { method = "GET", origin = ORIGIN } = {}) {
  const headers = new Headers();
  if (origin != null) headers.set("Origin", origin);
  if (jwt) headers.set("Cookie", `CF_Authorization=${jwt}`);
  return new Request(`${ORIGIN}/radar${path}`, { method, headers });
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

async function createHarness({
  radarEnabled = true,
  initialKv = {},
  radarRows = [],
  manifestRows = [manifestRow()],
  radarReply,
  manifestReply,
} = {}) {
  const access = await createAccessFixture();
  const memberKey = `member:${MEMBER_EMAIL}`;
  const entries = { ...initialKv };
  if (radarEnabled && !Object.hasOwn(entries, memberKey)) {
    entries[memberKey] = { features: { radar: true } };
  }
  const kv = createKv(entries);
  const queries = [];
  let jwksFetches = 0;

  const fetchStub = async (url, init = {}) => {
    const href = String(url);
    if (href === access.jwksUrl) {
      jwksFetches += 1;
      return Response.json({ keys: [access.jwk] });
    }

    assert.equal(href, NEON_SQL_URL);
    assert.equal(init.method, "POST");
    assert.equal(new Headers(init.headers).get("Neon-Connection-String"), DATABASE_URL);
    const requestBody = JSON.parse(init.body);
    queries.push(requestBody);

    if (requestBody.query.includes("etl_run_manifest")) {
      return manifestReply
        ? manifestReply(requestBody)
        : Response.json({ rows: manifestRows });
    }
    return radarReply
      ? radarReply(requestBody)
      : Response.json({ rows: radarRows });
  };

  return {
    access,
    env: {
      ACCESS_TEAM_DOMAIN: access.teamDomain,
      ACCESS_AUD: access.accessAud,
      ADMIN_EMAILS: "admin@example.com",
      ALLOWED_ORIGIN: ORIGIN,
      DATABASE_URL,
      SHARED_DATA: kv,
    },
    fetchStub,
    kv,
    queries,
    memberKey,
    get jwksFetches() {
      return jwksFetches;
    },
  };
}

test("radar enforces preflight, method, authentication, origin, and membership gates in order", { concurrency: false }, async () => {
  const harness = await createHarness({ radarEnabled: false });
  const emailLessAccess = await createAccessFixture({ email: null });

  await withFetch(async (url, init) => {
    if (String(url) === emailLessAccess.jwksUrl) {
      return Response.json({ keys: [emailLessAccess.jwk] });
    }
    return harness.fetchStub(url, init);
  }, async () => {
    let response = await radar({
      request: radarRequest(null, "", { method: "OPTIONS" }),
      env: harness.env,
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("Access-Control-Allow-Methods"), "GET, OPTIONS");

    response = await radar({
      request: radarRequest(null, "", { method: "POST" }),
      env: harness.env,
    });
    assert.equal(response.status, 405);
    assert.deepEqual(await response.json(), { error: "Method Not Allowed" });

    response = await radar({ request: radarRequest(null), env: harness.env });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
    assert.equal(harness.kv.gets.length, 0);
    assert.equal(harness.queries.length, 0);

    response = await radar({
      request: radarRequest(emailLessAccess.jwt),
      env: {
        ...harness.env,
        ACCESS_TEAM_DOMAIN: emailLessAccess.teamDomain,
        ACCESS_AUD: emailLessAccess.accessAud,
      },
    });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
    assert.equal(harness.kv.gets.length, 0);

    response = await radar({
      request: radarRequest(harness.access.jwt, "", { origin: "https://attacker.example" }),
      env: harness.env,
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });
    assert.equal(harness.kv.gets.length, 0);
    assert.equal(harness.queries.length, 0);

    response = await radar({ request: radarRequest(harness.access.jwt), env: harness.env });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), {
      error: "Radar access is not enabled for this account",
      code: "members_only",
    });
    assert.deepEqual(harness.kv.gets, [{ key: harness.memberKey, type: "json" }]);
    assert.equal(harness.queries.length, 0);

    harness.kv.seed(harness.memberKey, { features: { radar: true } });
    response = await radar({ request: radarRequest(harness.access.jwt), env: harness.env });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, max-age=300");
    assert.equal(body.success, true);
    assert.deepEqual(body.rows, []);
    assert.equal(harness.queries.length, 2);
  });
});

test("radar assembles the latest snapshot and previous scores from the two newest dates", { concurrency: false }, async () => {
  const radarRows = [
    {
      ticker: "OLD",
      as_of_date: "2099-01-01",
      coverage: "scored",
      quality_score: "99",
      technical_score: "99",
      chain_count: "1",
      chains: ["ai"],
      memberships: {},
      price: "1",
      market_cap: "2",
      computed_at: "2099-01-01T08:00:00Z",
    },
    {
      ticker: "NVDA",
      as_of_date: "2099-01-08",
      coverage: "scored",
      quality_score: "79.5",
      technical_score: "68",
      chain_count: "2",
      chains: ["ai", "robotics"],
      memberships: {},
      price: "900",
      market_cap: "2200000000000",
      computed_at: "2099-01-08T08:00:00Z",
    },
    {
      ticker: "FUND",
      as_of_date: "2099-01-15",
      coverage: "fund",
      quality_score: null,
      technical_score: null,
      chain_count: "1",
      chains: ["ai"],
      memberships: { ai: ["Funds"] },
      price: "51.25",
      market_cap: null,
      computed_at: "2099-01-15T08:00:00Z",
    },
    {
      ticker: "NVDA",
      as_of_date: "2099-01-15",
      coverage: "scored",
      quality_score: "84.5",
      technical_score: "74",
      chain_count: "2",
      chains: "{ai,robotics}",
      memberships: JSON.stringify({ ai: ["Semiconductors"], robotics: ["Compute"] }),
      price: "950.5",
      market_cap: "2300000000000",
      computed_at: "2099-01-15T08:00:00Z",
    },
  ];
  const harness = await createHarness({ radarRows });

  await withFetch(harness.fetchStub, async () => {
    const response = await radar({ request: radarRequest(harness.access.jwt), env: harness.env });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, max-age=300");
    assert.equal(body.success, true);
    assert.equal(body.asOf, "2099-01-15");
    assert.deepEqual(body.rows, [
      {
        ticker: "FUND",
        coverage: "fund",
        quality: null,
        technical: null,
        prevQuality: null,
        prevTechnical: null,
        chainCount: 1,
        chains: ["ai"],
        memberships: { ai: ["Funds"] },
        price: 51.25,
        marketCap: null,
        asOf: "2099-01-15",
      },
      {
        ticker: "NVDA",
        coverage: "scored",
        quality: 84.5,
        technical: 74,
        prevQuality: 79.5,
        prevTechnical: 68,
        chainCount: 2,
        chains: ["ai", "robotics"],
        memberships: { ai: ["Semiconductors"], robotics: ["Compute"] },
        price: 950.5,
        marketCap: 2300000000000,
        asOf: "2099-01-15",
      },
    ]);
    assert.equal(body.health.pipeline, "radar_scores");
    assert.equal(body.health.state, "success");
    assert.equal(body.health.staleAfterHours, 9 * 24);

    const dataQuery = harness.queries.find(({ query }) => !query.includes("etl_run_manifest"));
    assert.match(dataQuery.query, /SELECT DISTINCT as_of_date/);
    assert.match(dataQuery.query, /LIMIT 2/);
    assert.equal(dataQuery.params, undefined);
    assert.equal(harness.kv.puts.length, 1);
    assert.equal(harness.kv.puts[0].key, "radarView_v1");
    assert.deepEqual(harness.kv.puts[0].options, { expirationTtl: 3600 });
    assert.deepEqual(JSON.parse(harness.kv.puts[0].value), body);
  });
});

test("radar leaves previous scores null when only one snapshot date exists", { concurrency: false }, async () => {
  const harness = await createHarness({
    radarRows: [{
      ticker: "AMD",
      as_of_date: "2099-01-15",
      coverage: "scored",
      quality_score: "58",
      technical_score: "63.5",
      chain_count: "1",
      chains: ["ai"],
      memberships: { ai: ["Semiconductors"] },
      price: "180.25",
      market_cap: "290000000000",
      computed_at: "2099-01-15T08:00:00Z",
    }],
  });

  await withFetch(harness.fetchStub, async () => {
    const response = await radar({ request: radarRequest(harness.access.jwt), env: harness.env });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.rows.length, 1);
    assert.equal(body.rows[0].ticker, "AMD");
    assert.equal(body.rows[0].quality, 58);
    assert.equal(body.rows[0].technical, 63.5);
    assert.equal(body.rows[0].prevQuality, null);
    assert.equal(body.rows[0].prevTechnical, null);
  });
});

test("radar treats a missing table before the first manifest-backed run as bootstrap", { concurrency: false }, async () => {
  const harness = await createHarness({
    manifestRows: [],
    radarReply: () => Response.json({
      code: "42P01",
      message: 'relation "radar_scores" does not exist',
    }, { status: 400 }),
  });

  await withFetch(harness.fetchStub, async () => {
    const response = await radar({ request: radarRequest(harness.access.jwt), env: harness.env });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.asOf, null);
    assert.deepEqual(body.rows, []);
    assert.equal(body.health.pipeline, "radar_scores");
    assert.equal(body.health.state, "unknown");
    assert.equal(body.health.stale, true);
    assert.equal(harness.queries.length, 2);
    assert.equal(harness.kv.puts.length, 0);
  });
});

test("radar detail returns full component JSON and a newest-first twelve-point trend", { concurrency: false }, async () => {
  const qualityComponents = [
    { key: "growth", label: "Growth", score: 91, weight: 0.4, detail: "Strong filed growth." },
    { key: "returns", label: "Returns", score: 84, weight: 0.6, detail: "Healthy returns." },
  ];
  const technicalComponents = [
    { key: "trend", label: "Trend", score: 88, weight: 0.5, detail: "Above moving averages." },
    { key: "momentum", label: "Momentum", score: 79, weight: 0.5, detail: "Positive momentum." },
  ];
  const radarRows = Array.from({ length: 13 }, (_, index) => ({
    ticker: "NVDA",
    as_of_date: new Date(Date.UTC(2099, 0, 15 - index)).toISOString().slice(0, 10),
    coverage: "scored",
    quality_score: String(91 - index),
    quality_components: index === 0 ? JSON.stringify(qualityComponents) : [],
    technical_score: String(86 - index),
    technical_components: index === 0 ? technicalComponents : [],
    fiscal_year_basis: "2098",
  }));
  const harness = await createHarness({ radarRows });

  await withFetch(harness.fetchStub, async () => {
    const response = await radar({
      request: radarRequest(harness.access.jwt, "?ticker=nvda"),
      env: harness.env,
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, max-age=300");
    assert.deepEqual(body, {
      success: true,
      ticker: "NVDA",
      coverage: "scored",
      quality: 91,
      technical: 86,
      qualityComponents,
      technicalComponents,
      fiscalYearBasis: 2098,
      asOf: "2099-01-15",
      trend: radarRows.slice(0, 12).map(row => ({
        asOf: row.as_of_date,
        quality: Number(row.quality_score),
        technical: Number(row.technical_score),
      })),
    });
    assert.equal(harness.queries.length, 1);
    assert.deepEqual(harness.queries[0].params, ["NVDA"]);
    assert.match(harness.queries[0].query, /ORDER BY as_of_date DESC/);
    assert.match(harness.queries[0].query, /LIMIT 12/);
    assert.equal(harness.kv.puts.length, 0);
    assert.equal(harness.kv.gets.some(({ key }) => key === "radarView_v1"), false);
  });
});

test("radar detail returns a stable not-found error for an unknown ticker", { concurrency: false }, async () => {
  const harness = await createHarness({ radarRows: [] });

  await withFetch(harness.fetchStub, async () => {
    const response = await radar({
      request: radarRequest(harness.access.jwt, "?ticker=ZZZZ"),
      env: harness.env,
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Unknown ticker", code: "not_found" });
    assert.equal(harness.queries.length, 1);
    assert.deepEqual(harness.queries[0].params, ["ZZZZ"]);
  });
});

test("radar rejects an invalid detail ticker before querying Neon", { concurrency: false }, async () => {
  const harness = await createHarness();

  await withFetch(harness.fetchStub, async () => {
    const response = await radar({
      request: radarRequest(harness.access.jwt, "?ticker=bad%20ticker"),
      env: harness.env,
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid ticker format" });
    assert.equal(harness.queries.length, 0);
    assert.equal(harness.kv.gets.some(({ key }) => key === "radarView_v1"), false);
  });
});

test("radar serves the screener KV cache without querying Neon", { concurrency: false }, async () => {
  const cached = {
    success: true,
    asOf: "2099-01-15",
    rows: [{
      ticker: "NVDA",
      coverage: "scored",
      quality: 84,
      technical: 74,
      prevQuality: 80,
      prevTechnical: 70,
      chainCount: 2,
      chains: ["ai", "robotics"],
      memberships: { ai: ["Semiconductors"], robotics: ["Compute"] },
      price: 950,
      marketCap: 2300000000000,
      asOf: "2099-01-15",
    }],
    health: { pipeline: "radar_scores", state: "success", stale: false },
  };
  const harness = await createHarness({ initialKv: { radarView_v1: cached } });

  await withFetch(harness.fetchStub, async () => {
    const response = await radar({ request: radarRequest(harness.access.jwt), env: harness.env });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "private, max-age=300");
    assert.deepEqual(await response.json(), cached);
    assert.equal(harness.queries.length, 0);
    assert.equal(harness.jwksFetches, 1);
    assert.equal(harness.kv.puts.length, 0);
  });
});
