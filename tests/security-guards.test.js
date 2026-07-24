import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { onRequest as analyze } from "../functions/analyze.js";
import { onRequest as prices } from "../functions/prices.js";

const jsonRequest = (url, body, headers = {}) => new Request(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

const b64url = value => Buffer.from(value).toString("base64url");

async function createAccessJwt({ aud, email, sub }) {
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

test("analyze rejects requests without a verified Access member", async () => {
  const response = await analyze({
    request: jsonRequest("https://capex-iq.us/analyze", { ticker: "MSFT" }),
    env: { GEMINI_API_KEY: "test" },
  });

  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "Authentication required");
});

test("analyze rate-limits a verified member before calling Gemini", { concurrency: false }, async () => {
  const teamDomain = `test-${crypto.randomUUID()}.example.com`;
  const accessAud = "test-audience";
  const { jwt, jwk } = await createAccessJwt({
    aud: accessAud,
    email: "member@example.com",
    sub: "member-123",
  });
  const originalFetch = globalThis.fetch;
  let nonJwksFetches = 0;
  let limiterKey;

  globalThis.fetch = async url => {
    if (String(url) === `https://${teamDomain}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [jwk] });
    }
    nonJwksFetches += 1;
    throw new Error(`Unexpected upstream request: ${url}`);
  };

  try {
    const response = await analyze({
      request: jsonRequest(
        "https://capex-iq.us/analyze",
        { ticker: "MSFT" },
        { Cookie: `CF_Authorization=${jwt}` }
      ),
      env: {
        ACCESS_TEAM_DOMAIN: teamDomain,
        ACCESS_AUD: accessAud,
        GEMINI_API_KEY: "test",
        ANALYZE_RATE_LIMITER: {
          limit: async ({ key }) => {
            limiterKey = key;
            return { success: false };
          },
        },
      },
    });

    assert.equal(response.status, 429);
    assert.equal(response.headers.get("Retry-After"), "60");
    assert.equal(limiterKey, "member-123");
    assert.equal(nonJwksFetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prices rejects more than 250 distinct tickers before upstream work", async () => {
  const tickerList = Array.from({ length: 251 }, (_, index) => `T${index}`);
  const response = await prices({
    request: new Request(`https://capex-iq.us/prices?tickers=${tickerList.join(",")}`),
    env: {},
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /maximum of 250/i);
});

test("prices rejects malformed tickers before upstream work", async () => {
  const response = await prices({
    request: new Request("https://capex-iq.us/prices?tickers=MSFT,bad%20ticker"),
    env: {},
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Invalid ticker format");
});

test("premarket scanner targets the canonical production endpoint", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/premarket-scanner.yml", import.meta.url),
    "utf8"
  );

  assert.match(workflow, /GAP_SCANNER_URL: https:\/\/capex-iq\.us\/gap-scanner/);
  assert.doesNotMatch(workflow, /wizzles-watchlist\.pages\.dev/);
});
