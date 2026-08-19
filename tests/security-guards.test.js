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

async function analyzeAsVerifiedMember({ email, sub, env = {} }) {
  const teamDomain = `test-${crypto.randomUUID()}.example.com`;
  const accessAud = "test-audience";
  const { jwt, jwk } = await createAccessJwt({ aud: accessAud, email, sub });
  const originalFetch = globalThis.fetch;
  let nonJwksFetches = 0;
  let limiterCalls = 0;

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
          limit: async () => {
            limiterCalls += 1;
            return { success: false };
          },
        },
        ...env,
      },
    });
    return { response, nonJwksFetches, limiterCalls };
  } finally {
    globalThis.fetch = originalFetch;
  }
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
        ANALYZE_ALLOWED_EMAILS: "member@example.com",
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

test("analyze rejects a verified member who is not on the allow-list", { concurrency: false }, async () => {
  const { response, nonJwksFetches, limiterCalls } = await analyzeAsVerifiedMember({
    email: "member@example.com",
    sub: "member-not-allowed",
    env: {
      ADMIN_EMAILS: "admin@example.com",
      ANALYZE_ALLOWED_EMAILS: "allowed@example.com",
    },
  });

  assert.equal(response.status, 403);
  const body = await response.json();
  assert.equal(body.error, "Analysis access is not enabled for this account");
  assert.equal(body.code, "members_only");
  assert.equal(nonJwksFetches, 0);
  assert.equal(limiterCalls, 0);
});

test("analyze allows an admin email when the allow-list is empty", { concurrency: false }, async () => {
  const { response, nonJwksFetches, limiterCalls } = await analyzeAsVerifiedMember({
    email: "admin@example.com",
    sub: "admin-123",
    env: {
      ADMIN_EMAILS: "admin@example.com",
      ANALYZE_ALLOWED_EMAILS: "",
    },
  });

  assert.equal(response.status, 429);
  assert.equal(nonJwksFetches, 0);
  assert.equal(limiterCalls, 1);
});

test("analyze allows an email on the allow-list", { concurrency: false }, async () => {
  const { response, nonJwksFetches, limiterCalls } = await analyzeAsVerifiedMember({
    email: "member@example.com",
    sub: "member-allowed",
    env: {
      ADMIN_EMAILS: "admin@example.com",
      ANALYZE_ALLOWED_EMAILS: "other@example.com, MEMBER@EXAMPLE.COM ",
    },
  });

  assert.equal(response.status, 429);
  assert.equal(nonJwksFetches, 0);
  assert.equal(limiterCalls, 1);
});

test("analyze rejects a verified member at the monthly quota before Gemini", { concurrency: false }, async () => {
  const email = "member@example.com";
  const month = new Date().toISOString().slice(0, 7);
  const { response, nonJwksFetches, limiterCalls } = await analyzeAsVerifiedMember({
    email,
    sub: "member-at-quota",
    env: {
      ADMIN_EMAILS: "admin@example.com",
      SHARED_DATA: {
        get: async (key, type) => {
          if (key === `member:${email}`) {
            const record = { features: { research: true }, researchQuota: 4 };
            return type === "json" ? record : JSON.stringify(record);
          }
          if (key === `usage:${email}:${month}`) return "4";
          return null;
        },
      },
    },
  });
  const body = await response.json();
  const now = new Date();
  const resetsOn = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);

  assert.equal(response.status, 429);
  assert.deepEqual(body, {
    error: "Monthly research limit reached",
    code: "quota_exceeded",
    used: 4,
    limit: 4,
    resetsOn,
  });
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(nonJwksFetches, 0);
  assert.equal(limiterCalls, 0);
});

test("prices rejects more than 500 distinct tickers before upstream work", async () => {
  const tickerList = Array.from({ length: 501 }, (_, index) => `T${index}`);
  const response = await prices({
    request: new Request(`https://capex-iq.us/prices?tickers=${tickerList.join(",")}`),
    env: {},
  });

  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /maximum of 500/i);
});

test("prices rejects malformed tickers before upstream work", async () => {
  const response = await prices({
    request: new Request("https://capex-iq.us/prices?tickers=MSFT,bad%20ticker"),
    env: {},
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Invalid ticker format");
});

