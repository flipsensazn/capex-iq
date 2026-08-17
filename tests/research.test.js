import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as fundamentals } from "../functions/fundamentals.js";

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

function createKv() {
  const store = new Map();
  const puts = [];
  return {
    puts,
    async get(key, type) {
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

function fact(val, fy, end) {
  return { start: `${fy - 1}-01-01`, end, val, fy, fp: "FY", form: "10-K" };
}

function companyFactsFixture() {
  return {
    entityName: "MICROSOFT CORP",
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: {
            USD: [fact(1000, 2024, "2024-06-30"), fact(1200, 2025, "2025-06-30")],
          },
        },
        NetIncomeLoss: {
          units: {
            USD: [fact(200, 2024, "2024-06-30"), fact(300, 2025, "2025-06-30")],
          },
        },
        NetCashProvidedByUsedInOperatingActivities: {
          units: {
            USD: [fact(350, 2024, "2024-06-30"), fact(400, 2025, "2025-06-30")],
          },
        },
        PaymentsToAcquirePropertyPlantAndEquipment: {
          units: {
            USD: [fact(100, 2024, "2024-06-30"), fact(125, 2025, "2025-06-30")],
          },
        },
      },
    },
  };
}

async function requestAsAdmin({ ticker, companyFacts = companyFactsFixture() }) {
  const teamDomain = `test-${crypto.randomUUID()}.example.com`;
  const accessAud = "test-audience";
  const { jwt, jwk } = await createAccessJwt({
    aud: accessAud,
    email: "admin@example.com",
    sub: "admin-123",
  });
  const kv = createKv();
  const originalFetch = globalThis.fetch;
  const secRequests = [];

  globalThis.fetch = async (url, options) => {
    const href = String(url);
    if (href === `https://${teamDomain}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [jwk] });
    }
    secRequests.push({ url: href, options });
    if (href === "https://www.sec.gov/files/company_tickers.json") {
      return Response.json({
        0: { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" },
      });
    }
    if (href === "https://data.sec.gov/api/xbrl/companyfacts/CIK0000789019.json") {
      return Response.json(companyFacts);
    }
    throw new Error(`Unexpected upstream request: ${href}`);
  };

  try {
    const response = await fundamentals({
      request: new Request(`https://capex-iq.us/fundamentals?ticker=${encodeURIComponent(ticker)}`, {
        headers: {
          Cookie: `CF_Authorization=${jwt}`,
          Origin: "https://capex-iq.us",
        },
      }),
      env: {
        ACCESS_TEAM_DOMAIN: teamDomain,
        ACCESS_AUD: accessAud,
        ADMIN_EMAILS: "admin@example.com",
        ALLOWED_ORIGIN: "https://capex-iq.us",
        SHARED_DATA: kv,
      },
    });
    return { response, kv, secRequests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("fundamentals rejects a non-admin before SEC fetches", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    throw new Error("Unexpected fetch");
  };

  try {
    const response = await fundamentals({
      request: new Request("https://capex-iq.us/fundamentals?ticker=MSFT", {
        headers: { Origin: "https://capex-iq.us" },
      }),
      env: {
        ALLOWED_ORIGIN: "https://capex-iq.us",
        ADMIN_EMAILS: "admin@example.com",
      },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fundamentals rejects an invalid ticker before SEC fetches", { concurrency: false }, async () => {
  const { response, secRequests } = await requestAsAdmin({ ticker: "bad ticker" });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Invalid ticker format");
  assert.equal(secRequests.length, 0);
});

test("fundamentals extracts annual facts and computes derived metrics", { concurrency: false }, async () => {
  const { response, kv, secRequests } = await requestAsAdmin({ ticker: "msft" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.fiscalYears, [2024, 2025]);
  assert.deepEqual(body.statements.income.revenue, { 2024: 1000, 2025: 1200 });
  assert.deepEqual(body.statements.income.netIncome, { 2024: 200, 2025: 300 });
  assert.deepEqual(body.metrics.netMargin, { 2024: 20, 2025: 25 });
  assert.deepEqual(body.statements.cashFlow.freeCashFlow, { 2024: 250, 2025: 275 });
  assert.equal(secRequests.length, 2);
  assert.ok(secRequests.every(({ options }) =>
    options.headers["User-Agent"] === "CapexIQ Research flipsensazn@gmail.com"
  ));
  assert.deepEqual(
    kv.puts.map(({ key, options }) => ({ key, expirationTtl: options.expirationTtl })),
    [
      { key: "secCikMap_v1", expirationTtl: 604800 },
      { key: "fundamentals_v1_MSFT", expirationTtl: 86400 },
    ]
  );
});

test("fundamentals returns null when every candidate tag is missing", { concurrency: false }, async () => {
  const { response } = await requestAsAdmin({ ticker: "MSFT" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.statements.income.grossProfit, { 2024: null, 2025: null });
  assert.deepEqual(body.metrics.grossMargin, { 2024: null, 2025: null });
});

test("fundamentals merges candidate tags across years when a filer switches tags", { concurrency: false }, async () => {
  const companyFacts = {
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: {
            USD: [fact(100, 2021, "2021-12-31"), fact(200, 2022, "2022-12-31")],
          },
        },
        Revenues: {
          units: {
            USD: [
              fact(999, 2022, "2022-12-31"),
              fact(300, 2023, "2023-12-31"),
              fact(400, 2024, "2024-12-31"),
            ],
          },
        },
      },
    },
  };

  const { response } = await requestAsAdmin({ ticker: "MSFT", companyFacts });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.statements.income.revenue, {
    2021: 100,
    2022: 200,
    2023: 300,
    2024: 400,
  });
});

test("fundamentals fills capex from an alternate tag", { concurrency: false }, async () => {
  const companyFacts = {
    facts: {
      "us-gaap": {
        NetCashProvidedByUsedInOperatingActivities: {
          units: {
            USD: [fact(500, 2024, "2024-12-31"), fact(600, 2025, "2025-12-31")],
          },
        },
        PaymentsToAcquireProductiveAssets: {
          units: {
            USD: [fact(125, 2024, "2024-12-31"), fact(150, 2025, "2025-12-31")],
          },
        },
      },
    },
  };

  const { response } = await requestAsAdmin({ ticker: "MSFT", companyFacts });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.statements.cashFlow.capex, { 2024: 125, 2025: 150 });
  assert.deepEqual(body.statements.cashFlow.freeCashFlow, { 2024: 375, 2025: 450 });
});
