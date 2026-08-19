import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as scoreboardTeaser } from "../functions/scoreboard-teaser.js";
import siteWorker from "../workers/site/index.js";

const ORIGIN = "https://capex-iq.us";
const DATABASE_URL = "postgresql://user:pass@example.neon.tech/db";
const FORBIDDEN_KEYS = new Set([
  "score",
  "composite",
  "delta",
  "quality",
  "technical",
]);
const ALLOWED_NUMERIC_KEYS = new Set([
  "rank",
  "moverCount",
  "totalTracked",
]);

async function withFetch(stub, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function createKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  const gets = [];
  const puts = [];
  return {
    gets,
    puts,
    async get(key, type) {
      gets.push({ key, type });
      const value = store.get(key);
      if (value == null) return null;
      const serialized = typeof value === "string" ? value : JSON.stringify(value);
      return type === "json" ? JSON.parse(serialized) : serialized;
    },
    async put(key, value, options) {
      puts.push({ key, value, options });
      store.set(key, value);
    },
  };
}

function requestContext(kv, envOverrides = {}) {
  return {
    request: new Request(ORIGIN + "/scoreboard-teaser", {
      method: "GET",
      headers: { Origin: ORIGIN },
    }),
    env: {
      ALLOWED_ORIGIN: ORIGIN,
      DATABASE_URL,
      SHARED_DATA: kv,
      ...envOverrides,
    },
  };
}

function assertLeakFreePayload(value, parentKey = "root") {
  if (Array.isArray(value)) {
    for (const item of value) assertLeakFreePayload(item, parentKey);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, child] of Object.entries(value)) {
    assert.equal(
      FORBIDDEN_KEYS.has(key.toLowerCase()),
      false,
      "forbidden teaser key: " + key
    );
    if (typeof child === "number") {
      assert.equal(
        ALLOWED_NUMERIC_KEYS.has(key),
        true,
        "unexpected numeric teaser field: " + key
      );
    }
    assertLeakFreePayload(child, key);
  }
}

test("scoreboard teaser is public, top-three only, and leak-free", { concurrency: false }, async () => {
  const kv = createKv();
  let neonFetches = 0;

  await withFetch(async (url, options) => {
    neonFetches += 1;
    assert.equal(url, "https://example.neon.tech/sql");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["Neon-Connection-String"], DATABASE_URL);

    const { query } = JSON.parse(options.body);
    assert.match(query, /FROM composite_scores/);
    assert.match(query, /ROW_NUMBER/);
    assert.doesNotMatch(
      query,
      /FROM composite_scores\s+WHERE composite IS NOT NULL/
    );
    assert.match(
      query,
      /latest_snapshot\.snapshot_number = 1\s+AND latest_snapshot\.composite IS NOT NULL/
    );
    assert.match(query, /previous_composite IS NOT NULL/);
    assert.match(query, /IS DISTINCT FROM/);
    assert.match(query, /LIMIT 3/);

    return new Response(JSON.stringify({
      rows: [
        {
          ticker: "NVDA",
          rank: "1",
          mover_count: "7",
          total_tracked: "24",
          as_of: "2026-08-18",
          composite: "97.2",
          delta: "3.1",
        },
        {
          ticker: "AVGO",
          rank: "2",
          mover_count: "7",
          total_tracked: "24",
          as_of: "2026-08-18",
          score: "91.0",
          quality: "88.0",
        },
        {
          ticker: "TSM",
          rank: "3",
          mover_count: "7",
          total_tracked: "24",
          as_of: "2026-08-18",
          technical: "80.0",
          components: { transcript: 99 },
        },
      ],
    }), { status: 200 });
  }, async () => {
    const { request, env } = requestContext(kv);
    const response = await siteWorker.fetch(
      request,
      {
        ...env,
        ASSETS: {
          fetch: async () => {
            throw new Error("/scoreboard-teaser unexpectedly fell through to static assets");
          },
        },
      },
      { waitUntil() {} }
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Cache-Control"),
      "public, max-age=300, s-maxage=600"
    );
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), ORIGIN);
    assert.deepEqual(body, {
      success: true,
      asOf: "2026-08-18",
      top: [
        { ticker: "NVDA", rank: 1 },
        { ticker: "AVGO", rank: 2 },
        { ticker: "TSM", rank: 3 },
      ],
      moverCount: 7,
      totalTracked: 24,
    });
    assert.deepEqual(Object.keys(body), [
      "success",
      "asOf",
      "top",
      "moverCount",
      "totalTracked",
    ]);
    assert.equal(body.top.length, 3);
    for (const row of body.top) {
      assert.deepEqual(Object.keys(row), ["ticker", "rank"]);
    }
    assertLeakFreePayload(body);
  });

  assert.equal(neonFetches, 1);
  assert.deepEqual(kv.gets, [
    { key: "scoreboardTeaser_v1", type: "json" },
  ]);
  assert.equal(kv.puts.length, 1);
  assert.equal(kv.puts[0].key, "scoreboardTeaser_v1");
  assert.deepEqual(kv.puts[0].options, { expirationTtl: 600 });
  assertLeakFreePayload(JSON.parse(kv.puts[0].value));
});

test("scoreboard teaser KV hit skips Neon and strips non-contract fields", { concurrency: false }, async () => {
  const kv = createKv({
    scoreboardTeaser_v1: {
      success: true,
      asOf: "2026-08-11",
      top: [
        { ticker: "AMD", rank: 1, score: 99 },
        { ticker: "MU", rank: 2, composite: 98 },
        { ticker: "AMAT", rank: 3, delta: 4 },
      ],
      moverCount: 5,
      totalTracked: 18,
      technical: 100,
    },
  });
  let neonFetches = 0;

  await withFetch(async () => {
    neonFetches += 1;
    throw new Error("Neon should not be called on a KV hit");
  }, async () => {
    const response = await scoreboardTeaser(requestContext(kv));
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get("Cache-Control"),
      "public, max-age=300, s-maxage=600"
    );
    assert.deepEqual(body, {
      success: true,
      asOf: "2026-08-11",
      top: [
        { ticker: "AMD", rank: 1 },
        { ticker: "MU", rank: 2 },
        { ticker: "AMAT", rank: 3 },
      ],
      moverCount: 5,
      totalTracked: 18,
    });
    assertLeakFreePayload(body);
  });

  assert.equal(neonFetches, 0);
  assert.equal(kv.puts.length, 0);
});

test("scoreboard teaser failures keep the same exact leak-free contract", async () => {
  const kv = createKv();
  const response = await scoreboardTeaser(requestContext(kv, {
    DATABASE_URL: undefined,
  }));
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(body, {
    success: false,
    asOf: null,
    top: [],
    moverCount: 0,
    totalTracked: 0,
  });
  assertLeakFreePayload(body);
});
