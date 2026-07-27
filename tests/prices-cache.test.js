import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as prices } from "../functions/prices.js";

const PRICE_CACHE_KEY = "priceCache_v10";
const STRIP_CACHE_KEY = "stripCache_v1";
const REFS_KEY = "priceRefs_v1";
const SESSION_KEY = "yahooSession_v1";

function createKv(seed = {}) {
  const store = new Map(
    Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)])
  );
  const putOptions = new Map();

  return {
    store,
    putOptions,
    async get(key, type) {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === "json" ? JSON.parse(value) : value;
    },
    async put(key, value, options) {
      store.set(key, value);
      putOptions.set(key, options);
    },
    async delete(key) {
      store.delete(key);
    },
    readJson(key) {
      const value = store.get(key);
      return value === undefined ? null : JSON.parse(value);
    },
  };
}

function requestFor(tickers) {
  const url = new URL("https://capex-iq.us/prices");
  url.searchParams.set("tickers", tickers.join(","));
  return new Request(url, {
    headers: { "CF-Connecting-IP": "203.0.113.10" },
  });
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

test("cache merge preserves a fresh superset and successful dead-symbol coverage", { concurrency: false }, async () => {
  const now = Date.now();
  const kv = createKv({
    [PRICE_CACHE_KEY]: {
      data: {
        AAPL: { price: 200, change: 1, session: "REGULAR" },
        NVDA: { price: 150, change: 2, session: "REGULAR" },
      },
      covered: ["AAPL", "NVDA"],
      timestamp: now,
    },
    [REFS_KEY]: {
      data: { MSFT: {}, DEAD: {} },
      timestamp: now,
    },
    [SESSION_KEY]: {
      cookie: "A=test",
      crumb: "test-crumb",
      timestamp: now,
    },
  });
  let limiterKey;

  await withFetch(async url => {
    const value = String(url);
    if (value.includes("/v7/finance/quote")) {
      return Response.json({
        quoteResponse: {
          result: [{
            symbol: "MSFT",
            regularMarketPrice: 450,
            regularMarketChangePercent: 1.5,
            regularMarketTime: Math.floor(Date.now() / 1000),
            marketState: "REGULAR",
          }],
        },
      });
    }
    if (value.includes("/v8/finance/chart/DEAD")) {
      return new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected upstream request: ${value}`);
  }, async () => {
    const response = await prices({
      request: requestFor(["MSFT", "DEAD"]),
      env: {
        SHARED_DATA: kv,
        PRICES_RATE_LIMITER: {
          limit: async ({ key }) => {
            limiterKey = key;
            return { success: true };
          },
        },
      },
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).cached, false);
  });

  const stored = kv.readJson(PRICE_CACHE_KEY);
  assert.deepEqual(new Set(stored.covered), new Set(["AAPL", "NVDA", "MSFT", "DEAD"]));
  assert.deepEqual(stored.data.AAPL, { price: 200, change: 1, session: "REGULAR" });
  assert.deepEqual(stored.data.NVDA, { price: 150, change: 2, session: "REGULAR" });
  assert.equal(stored.data.MSFT.price, 450);
  assert.equal(stored.data.DEAD, undefined);
  assert.equal(limiterKey, "203.0.113.10");
});

test("cache hit is served without upstream or limiter calls", { concurrency: false }, async () => {
  const kv = createKv({
    [PRICE_CACHE_KEY]: {
      data: { AAPL: { price: 200, change: 1, session: "REGULAR" } },
      covered: ["AAPL"],
      timestamp: Date.now(),
    },
  });
  let limiterCalls = 0;

  await withFetch(async url => {
    throw new Error(`Unexpected upstream request: ${url}`);
  }, async () => {
    const response = await prices({
      request: requestFor(["AAPL"]),
      env: {
        SHARED_DATA: kv,
        PRICES_RATE_LIMITER: {
          limit: async () => {
            limiterCalls += 1;
            return { success: false };
          },
        },
      },
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.cached, true);
    assert.equal(body.data.AAPL.price, 200);
  });

  assert.equal(limiterCalls, 0);
});

test("rate limit applies to strip and main cache misses before upstream fetches", { concurrency: false }, async () => {
  let upstreamCalls = 0;

  await withFetch(async () => {
    upstreamCalls += 1;
    throw new Error("Upstream must not be called");
  }, async () => {
    for (const tickers of [["^GSPC"], ["AAPL"]]) {
      const response = await prices({
        request: requestFor(tickers),
        env: {
          SHARED_DATA: createKv(),
          PRICES_RATE_LIMITER: {
            limit: async () => ({ success: false }),
          },
        },
      });
      const body = await response.json();

      assert.equal(response.status, 429);
      assert.match(body.error, /limit reached/i);
    }
  });

  assert.equal(upstreamCalls, 0);
});

test("rate limit does not apply to a warm main cache hit", { concurrency: false }, async () => {
  const kv = createKv({
    [PRICE_CACHE_KEY]: {
      data: { MSFT: { price: 450, change: 1.5, session: "REGULAR" } },
      covered: ["MSFT"],
      timestamp: Date.now(),
    },
  });
  let limiterCalls = 0;

  await withFetch(async url => {
    throw new Error(`Unexpected upstream request: ${url}`);
  }, async () => {
    const response = await prices({
      request: requestFor(["MSFT"]),
      env: {
        SHARED_DATA: kv,
        PRICES_RATE_LIMITER: {
          limit: async () => {
            limiterCalls += 1;
            return { success: false };
          },
        },
      },
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).cached, true);
  });

  assert.equal(limiterCalls, 0);
});

test("missing prices limiter fails open", { concurrency: false }, async () => {
  let upstreamCalls = 0;

  await withFetch(async () => {
    upstreamCalls += 1;
    throw new Error("Simulated Yahoo failure");
  }, async () => {
    const response = await prices({
      request: requestFor(["AAPL"]),
      env: { SHARED_DATA: createKv() },
    });

    assert.equal(response.status, 200);
    assert.notEqual(response.status, 429);
    assert.equal((await response.json()).cached, false);
  });

  assert.equal(upstreamCalls, 1);
});

test("throwing prices limiter fails open", { concurrency: false }, async () => {
  await withFetch(async () => {
    throw new Error("Simulated Yahoo failure");
  }, async () => {
    const response = await prices({
      request: requestFor(["AAPL"]),
      env: {
        SHARED_DATA: createKv(),
        PRICES_RATE_LIMITER: {
          limit: async () => {
            throw new Error("Simulated limiter failure");
          },
        },
      },
    });

    assert.equal(response.status, 200);
    assert.notEqual(response.status, 429);
  });
});

test("failed fan-out caches coverage only for resolved tickers", { concurrency: false }, async () => {
  const kv = createKv();

  await withFetch(async url => {
    const value = String(url);
    if (value.includes("finnhub.io") && value.includes("symbol=AAPL")) {
      return Response.json({ c: 200, dp: 1 });
    }
    if (value.includes("finnhub.io")) {
      return Response.json({ c: null, dp: null });
    }
    throw new Error("Simulated Yahoo fan-out failure");
  }, async () => {
    const response = await prices({
      request: requestFor(["AAPL", "MSFT"]),
      env: {
        SHARED_DATA: kv,
        FINNHUB_KEY: "test-key",
        PRICES_RATE_LIMITER: {
          limit: async () => ({ success: true }),
        },
      },
    });

    assert.equal(response.status, 200);
  });

  const stored = kv.readJson(PRICE_CACHE_KEY);
  assert.deepEqual(stored.covered, ["AAPL"]);
  assert.equal(stored.data.AAPL.price, 200);
  assert.equal(stored.data.MSFT, undefined);
});

test("strip miss writes the 10-second cache and the next request hits it", { concurrency: false }, async () => {
  const kv = createKv();
  let limiterCalls = 0;
  let upstreamCalls = 0;

  await withFetch(async url => {
    upstreamCalls += 1;
    const value = String(url);
    if (value === "https://fc.yahoo.com") {
      return new Response(null, { headers: { "Set-Cookie": "A=test; Path=/" } });
    }
    if (value.includes("/v1/test/getcrumb")) {
      return new Response("test-crumb");
    }
    if (value.includes("/v7/finance/quote")) {
      return Response.json({
        quoteResponse: {
          result: [{
            symbol: "^GSPC",
            regularMarketPrice: 6500,
            regularMarketChangePercent: 0.5,
            regularMarketTime: Math.floor(Date.now() / 1000),
            marketState: "REGULAR",
          }],
        },
      });
    }
    if (value.includes("/v8/finance/chart/")) {
      return new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected upstream request: ${value}`);
  }, async () => {
    const env = {
      SHARED_DATA: kv,
      PRICES_RATE_LIMITER: {
        limit: async () => {
          limiterCalls += 1;
          return { success: true };
        },
      },
    };

    const miss = await prices({ request: requestFor(["^GSPC"]), env });
    assert.equal(miss.status, 200);
    assert.equal((await miss.json()).cached, false);

    const callsAfterMiss = upstreamCalls;
    const hit = await prices({ request: requestFor(["^GSPC"]), env });
    const hitBody = await hit.json();
    assert.equal(hit.status, 200);
    assert.equal(hitBody.cached, true);
    assert.equal(hitBody.data["^GSPC"].price, 6500);
    assert.equal(upstreamCalls, callsAfterMiss);
  });

  const stored = kv.readJson(STRIP_CACHE_KEY);
  assert.equal(stored.data["^GSPC"].price, 6500);
  assert.ok(Date.now() - stored.timestamp < 10_000);
  assert.deepEqual(kv.putOptions.get(STRIP_CACHE_KEY), { expirationTtl: 60 });
  assert.equal(limiterCalls, 1);
});
