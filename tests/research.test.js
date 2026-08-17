import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as fundamentals } from "../functions/fundamentals.js";
import { onRequest as research } from "../functions/research.js";

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
        WeightedAverageNumberOfDilutedSharesOutstanding: {
          units: {
            shares: [fact(100, 2024, "2024-06-30"), fact(100, 2025, "2025-06-30")],
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

function aaoiCompanyFactsFixture() {
  return {
    entityName: "APPLIED OPTOELECTRONICS, INC.",
    facts: {
      dei: {
        EntityCommonStockSharesOutstanding: {
          units: {
            shares: [{ end: "2026-08-03", val: 84_569_237 }],
          },
        },
      },
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: {
          units: { USD: [fact(455_715_000, 2025, "2025-12-31")] },
        },
        NetIncomeLoss: {
          units: { USD: [fact(-38_230_000, 2025, "2025-12-31")] },
        },
        WeightedAverageNumberOfDilutedSharesOutstanding: {
          units: { shares: [fact(60_183_987, 2025, "2025-12-31")] },
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
      { key: "fundamentals_v2_MSFT", expirationTtl: 86400 },
    ]
  );
});

test("fundamentals extracts the most recent shares outstanding across unit keys", { concurrency: false }, async () => {
  const companyFacts = companyFactsFixture();
  companyFacts.facts.dei = {
    EntityCommonStockSharesOutstanding: {
      units: {
        shares: [
          { end: "2025-07-25", val: 75_000_000 },
          { end: "2026-02-10", val: 80_000_000 },
        ],
        alternate: [{ end: "2026-08-03", val: 84_569_237 }],
      },
    },
  };

  const { response } = await requestAsAdmin({ ticker: "MSFT", companyFacts });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.sharesOutstanding, { value: 84_569_237, asOf: "2026-08-03" });
});

test("fundamentals reports null shares outstanding when the dei fact is absent", { concurrency: false }, async () => {
  const { response } = await requestAsAdmin({ ticker: "MSFT" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.sharesOutstanding, { value: null, asOf: null });
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

async function requestResearchAsAdmin({
  ticker = "MSFT",
  geminiAnalysis,
  cachedResult,
  geminiKey = "test-gemini-key",
  companyFacts = companyFactsFixture(),
  currentPrice = 400,
}) {
  const teamDomain = `research-${crypto.randomUUID()}.example.com`;
  const accessAud = "research-audience";
  const { jwt, jwk } = await createAccessJwt({
    aud: accessAud,
    email: "admin@example.com",
    sub: "research-admin",
  });
  const kv = createKv();
  await kv.put("priceCache_v10", JSON.stringify({
    data: { MSFT: { price: currentPrice, change: 0 } },
    covered: ["MSFT"],
    timestamp: Date.now(),
  }), { expirationTtl: 60 });
  if (cachedResult) {
    await kv.put(`research_v3_${ticker.toUpperCase()}`, JSON.stringify(cachedResult), { expirationTtl: 86400 });
  }

  const originalFetch = globalThis.fetch;
  const upstreamRequests = [];
  const geminiPrompts = [];
  let geminiCalls = 0;
  globalThis.fetch = async (url, options) => {
    const href = String(url);
    if (href === `https://${teamDomain}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [jwk] });
    }
    upstreamRequests.push(href);
    if (href === "https://www.sec.gov/files/company_tickers.json") {
      return Response.json({
        0: { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" },
      });
    }
    if (href === "https://data.sec.gov/api/xbrl/companyfacts/CIK0000789019.json") {
      return Response.json(companyFacts);
    }
    if (href.startsWith("https://generativelanguage.googleapis.com/")) {
      geminiCalls += 1;
      geminiPrompts.push(JSON.parse(options.body).contents[0].parts[0].text);
      return Response.json({
        candidates: [{
          content: {
            parts: [{ text: `<think>structured response follows</think>\n\`\`\`json\n${JSON.stringify(geminiAnalysis)}\n\`\`\`` }],
          },
        }],
      });
    }
    throw new Error(`Unexpected upstream request: ${href}`);
  };

  try {
    const response = await research({
      request: new Request("https://capex-iq.us/research", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: `CF_Authorization=${jwt}`,
          Origin: "https://capex-iq.us",
        },
        body: JSON.stringify({ ticker }),
      }),
      env: {
        ACCESS_TEAM_DOMAIN: teamDomain,
        ACCESS_AUD: accessAud,
        ADMIN_EMAILS: "admin@example.com",
        ALLOWED_ORIGIN: "https://capex-iq.us",
        GEMINI_API_KEY: geminiKey,
        SHARED_DATA: kv,
      },
    });
    return { response, kv, upstreamRequests, geminiCalls, geminiPrompts };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function geminiAnalysisForCase(scenario) {
  return {
    summary: "Revenue and earnings were assessed from the supplied filed figures.",
    strengths: ["Revenue data was available."],
    risks: ["Scenario outcomes depend on the stated assumptions."],
    quality: { score: 72, rationale: "The key pricing inputs were available." },
    cases: {
      bear: { ...scenario, rationale: "Bear assumptions." },
      base: { ...scenario, rationale: "Base assumptions." },
      bull: { ...scenario, rationale: "Bull assumptions." },
    },
    dataGaps: [],
  };
}

test("research rejects a non-admin with zero Gemini calls", { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let geminiCalls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).startsWith("https://generativelanguage.googleapis.com/")) geminiCalls += 1;
    throw new Error("Unexpected fetch");
  };

  try {
    const response = await research({
      request: new Request("https://capex-iq.us/research", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://capex-iq.us" },
        body: JSON.stringify({ ticker: "MSFT" }),
      }),
      env: {
        ALLOWED_ORIGIN: "https://capex-iq.us",
        ADMIN_EMAILS: "admin@example.com",
        GEMINI_API_KEY: "test-gemini-key",
      },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "Forbidden" });
    assert.equal(geminiCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("research rejects an invalid ticker before upstream work", { concurrency: false }, async () => {
  const { response, upstreamRequests, geminiCalls } = await requestResearchAsAdmin({
    ticker: "bad ticker",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid ticker format" });
  assert.equal(upstreamRequests.length, 0);
  assert.equal(geminiCalls, 0);
});

test("research rejects P/E pricing when projected earnings are negative", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCase({
    revenueCagr: 5,
    exitNetMargin: -5,
    multipleType: "pe",
    multipleValue: 5,
  });
  const { response, geminiCalls } = await requestResearchAsAdmin({ geminiAnalysis });
  const body = await response.json();
  const bear = body.analysis.cases.bear;

  assert.equal(response.status, 200);
  assert.equal(geminiCalls, 1);
  assert.equal(body.currentPrice, 400);
  assert.equal(body.latestFiscalYear, 2025);
  assert.equal(bear.impliedPrice, null);
  assert.ok(bear.methodError);
  assert.ok(bear.impliedPrice == null || bear.impliedPrice >= 0);
});

test("research uses current shares outstanding for the per-share denominator", { concurrency: false }, async () => {
  const revenue = 455_715_000;
  const shares = 84_569_237;
  const revenueCagr = 10;
  const multipleValue = 2.5;
  const geminiAnalysis = geminiAnalysisForCase({
    revenueCagr,
    exitNetMargin: -2,
    multipleType: "ps",
    multipleValue,
  });
  const { response } = await requestResearchAsAdmin({
    geminiAnalysis,
    companyFacts: aaoiCompanyFactsFixture(),
  });
  const body = await response.json();
  const base = body.analysis.cases.base;
  const projectedRevenue = revenue * Math.pow(1 + revenueCagr / 100, 3);
  const expectedPrice = (projectedRevenue * multipleValue) / shares;

  assert.equal(response.status, 200);
  assert.equal(body.shareCount, shares);
  assert.equal(body.shareCountBasis, "current_outstanding");
  assert.equal(body.shareCountAsOf, "2026-08-03");
  assert.equal(base.methodError, null);
  assert.ok(base.impliedPrice > 0);
  assert.ok(Math.abs(base.impliedPrice - expectedPrice) <= 0.01);
  assert.equal(base.projectedRevenue, Math.round(projectedRevenue));
});

test("research falls back to the latest weighted-average diluted shares", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCase({
    revenueCagr: 0,
    exitNetMargin: 10,
    multipleType: "ps",
    multipleValue: 1,
  });
  const { response } = await requestResearchAsAdmin({ geminiAnalysis });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.shareCount, 100);
  assert.equal(body.shareCountBasis, "weighted_average_diluted");
  assert.equal(body.shareCountAsOf, null);
  assert.equal(body.analysis.cases.base.impliedPrice, 12);
});

test("research computes AAOI current P/S from price, chosen shares, and latest revenue", { concurrency: false }, async () => {
  const price = 150.99;
  const shares = 84_569_237;
  const revenue = 455_715_000;
  const expectedMarketCap = price * shares;
  const expectedCurrentPs = expectedMarketCap / revenue;
  const geminiAnalysis = geminiAnalysisForCase({
    revenueCagr: 10,
    exitNetMargin: -2,
    multipleType: "ps",
    multipleValue: 2.5,
  });
  const { response, geminiPrompts } = await requestResearchAsAdmin({
    geminiAnalysis,
    companyFacts: aaoiCompanyFactsFixture(),
    currentPrice: price,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.marketContext.marketCap, expectedMarketCap);
  assert.ok(Math.abs(body.marketContext.currentPs - expectedCurrentPs) < 1e-10);
  assert.ok(body.marketContext.currentPs > 27 && body.marketContext.currentPs < 29);
  assert.match(geminiPrompts[0], /"marketContext":\{"marketCap":/);
});

test("research reports null current P/E when latest net income is negative", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCase({
    revenueCagr: 10,
    exitNetMargin: -2,
    multipleType: "ps",
    multipleValue: 2.5,
  });
  const { response } = await requestResearchAsAdmin({
    geminiAnalysis,
    companyFacts: aaoiCompanyFactsFixture(),
    currentPrice: 150.99,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.marketContext.currentPe, null);
});

test("research computes a P/E price from positive projected earnings", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCase({
    revenueCagr: 10,
    exitNetMargin: 20,
    multipleType: "pe",
    multipleValue: 20,
  });
  const { response } = await requestResearchAsAdmin({ geminiAnalysis });
  const body = await response.json();
  const base = body.analysis.cases.base;

  assert.equal(response.status, 200);
  assert.equal(base.impliedPrice, 63.89);
  assert.equal(base.projectedRevenue, 1597);
  assert.equal(base.exitNetIncome, 319);
  assert.equal(base.methodError, null);
});

test("research returns an explained null price when diluted shares are missing", { concurrency: false }, async () => {
  const companyFacts = companyFactsFixture();
  delete companyFacts.facts["us-gaap"].WeightedAverageNumberOfDilutedSharesOutstanding;
  const geminiAnalysis = geminiAnalysisForCase({
    revenueCagr: 10,
    exitNetMargin: 20,
    multipleType: "pe",
    multipleValue: 20,
  });
  const { response } = await requestResearchAsAdmin({ geminiAnalysis, companyFacts });
  const body = await response.json();
  const base = body.analysis.cases.base;

  assert.equal(response.status, 200);
  assert.equal(base.impliedPrice, null);
  assert.match(base.methodError, /shares/i);
});

test("research returns a cached result without calling Gemini", { concurrency: false }, async () => {
  const cachedResult = {
    ticker: "MSFT",
    entityName: "MICROSOFT CORP",
    currentPrice: null,
    latestFiscalYear: 2025,
    analysis: { summary: "Cached analysis" },
    generatedAt: "2026-08-16T00:00:00.000Z",
    model: "gemini-2.5-flash",
    disclaimer: "This is a model-generated projection from filed data, not investment advice.",
  };
  const { response, upstreamRequests, geminiCalls } = await requestResearchAsAdmin({
    cachedResult,
    geminiKey: undefined,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), cachedResult);
  assert.equal(geminiCalls, 0);
  assert.equal(upstreamRequests.length, 0);
});
