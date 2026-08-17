import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as fundamentals } from "../functions/fundamentals.js";
import { onRequest as me } from "../functions/me.js";
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

function historyFixture() {
  return {
    ticker: "MSFT",
    currency: "USD",
    points: [
      { date: "2026-05-12", close: 390, volume: 1000, ma20: 389, ma50: 391 },
      { date: "2026-05-13", close: 395, volume: 1100, ma20: 392, ma50: 391 },
      { date: "2026-05-14", close: 420, volume: 1200, ma20: 400, ma50: 393 },
      { date: "2026-05-15", close: 400, volume: 900, ma20: 402, ma50: 395 },
    ],
    displayFrom: "2026-05-12",
    source: "Yahoo v8 chart",
    retrievedAt: "2026-05-15T22:00:00.000Z",
  };
}

async function requestFundamentals({
  ticker,
  companyFacts = companyFactsFixture(),
  email = "admin@example.com",
  sub = "admin-123",
  adminEmails = "admin@example.com",
  analyzeAllowedEmails = "",
}) {
  const teamDomain = `test-${crypto.randomUUID()}.example.com`;
  const accessAud = "test-audience";
  const { jwt, jwk } = await createAccessJwt({
    aud: accessAud,
    email,
    sub,
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
        ADMIN_EMAILS: adminEmails,
        ANALYZE_ALLOWED_EMAILS: analyzeAllowedEmails,
        ALLOWED_ORIGIN: "https://capex-iq.us",
        SHARED_DATA: kv,
      },
    });
    return { response, kv, secRequests };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function requestMeAsVerifiedMember({ email, adminEmails, analyzeAllowedEmails }) {
  const teamDomain = `me-${crypto.randomUUID()}.example.com`;
  const accessAud = "me-audience";
  const { jwt, jwk } = await createAccessJwt({
    aud: accessAud,
    email,
    sub: `member-${crypto.randomUUID()}`,
  });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href === `https://${teamDomain}/cdn-cgi/access/certs`) {
      return Response.json({ keys: [jwk] });
    }
    throw new Error(`Unexpected upstream request: ${href}`);
  };

  try {
    return await me({
      request: new Request("https://capex-iq.us/me", {
        headers: {
          Cookie: `CF_Authorization=${jwt}`,
          Origin: "https://capex-iq.us",
        },
      }),
      env: {
        ACCESS_TEAM_DOMAIN: teamDomain,
        ACCESS_AUD: accessAud,
        ADMIN_EMAILS: adminEmails,
        ANALYZE_ALLOWED_EMAILS: analyzeAllowedEmails,
        ALLOWED_ORIGIN: "https://capex-iq.us",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("fundamentals rejects requests without a verified Access identity", { concurrency: false }, async () => {
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

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
    assert.equal(fetches, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fundamentals rejects a verified non-allow-listed member before SEC fetches", { concurrency: false }, async () => {
  const { response, secRequests } = await requestFundamentals({
    ticker: "MSFT",
    email: "member@example.com",
    sub: "member-not-allowed",
    adminEmails: "admin@example.com",
    analyzeAllowedEmails: "allowed@example.com",
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Analysis access is not enabled for this account",
    code: "members_only",
  });
  assert.equal(secRequests.length, 0);
});

test("fundamentals allows an allow-listed member who is not an admin", { concurrency: false }, async () => {
  const { response, secRequests } = await requestFundamentals({
    ticker: "MSFT",
    email: "member@example.com",
    sub: "member-allowed",
    adminEmails: "admin@example.com",
    analyzeAllowedEmails: "other@example.com, MEMBER@EXAMPLE.COM ",
  });

  assert.equal(response.status, 200);
  assert.equal(secRequests.length, 2);
});

test("me exposes research capability for admins and non-allow-listed members", { concurrency: false }, async () => {
  const adminResponse = await requestMeAsVerifiedMember({
    email: "admin@example.com",
    adminEmails: "admin@example.com",
    analyzeAllowedEmails: "",
  });
  const memberResponse = await requestMeAsVerifiedMember({
    email: "member@example.com",
    adminEmails: "admin@example.com",
    analyzeAllowedEmails: "allowed@example.com",
  });
  const adminBody = await adminResponse.json();
  const memberBody = await memberResponse.json();

  assert.equal(adminResponse.status, 200);
  assert.equal(adminBody.isAdmin, true);
  assert.equal(adminBody.canResearch, true);
  assert.equal(memberResponse.status, 200);
  assert.equal(memberBody.isAdmin, false);
  assert.equal(memberBody.canResearch, false);
});

test("fundamentals rejects an invalid ticker before SEC fetches", { concurrency: false }, async () => {
  const { response, secRequests } = await requestFundamentals({ ticker: "bad ticker" });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Invalid ticker format");
  assert.equal(secRequests.length, 0);
});

test("fundamentals extracts annual facts and computes derived metrics", { concurrency: false }, async () => {
  const { response, kv, secRequests } = await requestFundamentals({ ticker: "msft" });
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

  const { response } = await requestFundamentals({ ticker: "MSFT", companyFacts });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.sharesOutstanding, { value: 84_569_237, asOf: "2026-08-03" });
});

test("fundamentals reports null shares outstanding when the dei fact is absent", { concurrency: false }, async () => {
  const { response } = await requestFundamentals({ ticker: "MSFT" });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.sharesOutstanding, { value: null, asOf: null });
});

test("fundamentals returns null when every candidate tag is missing", { concurrency: false }, async () => {
  const { response } = await requestFundamentals({ ticker: "MSFT" });
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

  const { response } = await requestFundamentals({ ticker: "MSFT", companyFacts });
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

  const { response } = await requestFundamentals({ ticker: "MSFT", companyFacts });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.statements.cashFlow.capex, { 2024: 125, 2025: 150 });
  assert.deepEqual(body.statements.cashFlow.freeCashFlow, { 2024: 375, 2025: 450 });
});

async function requestResearch({
  ticker = "MSFT",
  geminiAnalysis,
  cachedResult,
  geminiKey = "test-gemini-key",
  companyFacts = companyFactsFixture(),
  currentPrice = 400,
  priceEntry,
  history = historyFixture(),
  historyStatus = 502,
  email = "admin@example.com",
  sub = "research-admin",
  adminEmails = "admin@example.com",
  analyzeAllowedEmails = "",
  rateLimiterEnabled = true,
  rateLimitSuccess = true,
  rateLimitError = null,
  geminiFetch = null,
  secCompanyFactsFetch = null,
  researchInternalTimeoutMs,
  researchModelTimeoutMs,
}) {
  const teamDomain = `research-${crypto.randomUUID()}.example.com`;
  const accessAud = "research-audience";
  const { jwt, jwk } = await createAccessJwt({
    aud: accessAud,
    email,
    sub,
  });
  const kv = createKv();
  await kv.put("priceCache_v10", JSON.stringify({
    data: { MSFT: priceEntry ?? { price: currentPrice, change: 0 } },
    covered: ["MSFT"],
    timestamp: Date.now(),
  }), { expirationTtl: 60 });
  if (history) {
    await kv.put(`history_v1_${ticker.toUpperCase()}`, JSON.stringify(history), { expirationTtl: 3600 });
  }
  if (cachedResult) {
    await kv.put(`research_v7_${ticker.toUpperCase()}`, JSON.stringify(cachedResult), { expirationTtl: 86400 });
  }

  const originalFetch = globalThis.fetch;
  const upstreamRequests = [];
  const geminiPrompts = [];
  let geminiCalls = 0;
  const rateLimitKeys = [];
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
      if (secCompanyFactsFetch) return secCompanyFactsFetch(url, options);
      return Response.json(companyFacts);
    }
    if (href.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/")) {
      return Response.json({ chart: { result: null, error: { description: "upstream unavailable" } } }, { status: historyStatus });
    }
    if (href.startsWith("https://generativelanguage.googleapis.com/")) {
      geminiCalls += 1;
      geminiPrompts.push(JSON.parse(options.body).contents[0].parts[0].text);
      if (geminiFetch) return geminiFetch(url, options);
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
        ADMIN_EMAILS: adminEmails,
        ANALYZE_ALLOWED_EMAILS: analyzeAllowedEmails,
        ALLOWED_ORIGIN: "https://capex-iq.us",
        GEMINI_API_KEY: geminiKey,
        SHARED_DATA: kv,
        ...(researchInternalTimeoutMs == null ? {} : { RESEARCH_INTERNAL_TIMEOUT_MS: String(researchInternalTimeoutMs) }),
        ...(researchModelTimeoutMs == null ? {} : { RESEARCH_MODEL_TIMEOUT_MS: String(researchModelTimeoutMs) }),
        ...(rateLimiterEnabled ? {
          ANALYZE_RATE_LIMITER: {
            limit: async ({ key }) => {
              rateLimitKeys.push(key);
              if (rateLimitError) throw rateLimitError;
              return { success: rateLimitSuccess };
            },
          },
        } : {}),
      },
    });
    return { response, kv, upstreamRequests, geminiCalls, geminiPrompts, rateLimitKeys };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function geminiAnalysisForCases(multipleType, scenarios) {
  return {
    summary: "Revenue and earnings were assessed from the supplied filed figures.",
    strengths: ["Revenue data was available."],
    risks: ["Scenario outcomes depend on the stated assumptions."],
    technical: {
      read: "The supplied price context frames the recent trend and momentum.",
      points: ["The current price was supplied by the server."],
      annotations: [],
    },
    macro: {
      read: "Sector conditions provide qualitative context for the filed results.",
      points: ["Competitive and regulatory conditions may affect execution."],
    },
    quality: { score: 72, rationale: "The key pricing inputs were available." },
    cases: {
      multipleType,
      bear: { ...scenarios.bear, rationale: scenarios.bear?.rationale ?? "Bear assumptions." },
      base: { ...scenarios.base, rationale: scenarios.base?.rationale ?? "Base assumptions." },
      bull: { ...scenarios.bull, rationale: scenarios.bull?.rationale ?? "Bull assumptions." },
    },
    dataGaps: [],
  };
}

function geminiAnalysisForCase(multipleType, scenario) {
  return geminiAnalysisForCases(multipleType, {
    bear: scenario,
    base: scenario,
    bull: scenario,
  });
}

test("research rejects requests without a verified Access identity with zero Gemini calls", { concurrency: false }, async () => {
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

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Authentication required" });
    assert.equal(geminiCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("research rejects a verified non-allow-listed member with zero Gemini calls", { concurrency: false }, async () => {
  const { response, upstreamRequests, geminiCalls } = await requestResearch({
    email: "member@example.com",
    sub: "research-member-not-allowed",
    adminEmails: "admin@example.com",
    analyzeAllowedEmails: "allowed@example.com",
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: "Analysis access is not enabled for this account",
    code: "members_only",
  });
  assert.equal(geminiCalls, 0);
  assert.equal(upstreamRequests.length, 0);
});

test("research rejects an invalid ticker before upstream work", { concurrency: false }, async () => {
  const { response, upstreamRequests, geminiCalls } = await requestResearch({
    ticker: "bad ticker",
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid ticker format" });
  assert.equal(upstreamRequests.length, 0);
  assert.equal(geminiCalls, 0);
});

test("research rate-limits cache misses before upstream work", { concurrency: false }, async () => {
  const { response, upstreamRequests, geminiCalls, rateLimitKeys } = await requestResearch({
    rateLimitSuccess: false,
  });

  assert.equal(response.status, 429);
  assert.equal(response.headers.get("Retry-After"), "60");
  assert.deepEqual(await response.json(), {
    error: "Analysis limit reached. Try again in a minute.",
  });
  assert.deepEqual(rateLimitKeys, ["research-admin"]);
  assert.equal(upstreamRequests.length, 0);
  assert.equal(geminiCalls, 0);
});

test("research fails closed when the rate limiter is unavailable", { concurrency: false }, async () => {
  const { response, upstreamRequests, geminiCalls } = await requestResearch({
    rateLimiterEnabled: false,
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "Analysis service is temporarily unavailable",
  });
  assert.equal(upstreamRequests.length, 0);
  assert.equal(geminiCalls, 0);
});

test("research aborts a model request at its configured deadline", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCase("pe", {
    revenueCagr: 5,
    exitNetMargin: 20,
    multipleValue: 20,
  });
  const { response, geminiCalls } = await requestResearch({
    geminiAnalysis,
    researchModelTimeoutMs: 10,
    geminiFetch: async (_url, options) => new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        reject(options.signal.reason);
        return;
      }
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(geminiCalls, 1);
  assert.equal(body.error, "Analysis failed");
  assert.match(body.detail, /Analysis model timed out after 10ms/);
});

test("research keeps the model deadline active while reading the response body", { concurrency: false }, async () => {
  let bodyAbortObserved = false;
  const { response, geminiCalls } = await requestResearch({
    researchModelTimeoutMs: 10,
    geminiFetch: async (_url, options) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"candidates":['));
        options.signal.addEventListener("abort", () => {
          bodyAbortObserved = true;
          controller.error(options.signal.reason);
        }, { once: true });
      },
    }), { headers: { "Content-Type": "application/json" } }),
  });
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(geminiCalls, 1);
  assert.equal(bodyAbortObserved, true);
  assert.match(body.detail, /Analysis model timed out after 10ms/);
});

test("research cancels SEC work when its internal deadline expires", { concurrency: false }, async () => {
  let secAbortObserved = false;
  const { response, geminiCalls } = await requestResearch({
    history: historyFixture(),
    researchInternalTimeoutMs: 10,
    secCompanyFactsFetch: async (_url, options) => new Promise((resolve, reject) => {
      if (options.signal.aborted) {
        secAbortObserved = true;
        reject(options.signal.reason);
        return;
      }
      options.signal.addEventListener("abort", () => {
        secAbortObserved = true;
        reject(options.signal.reason);
      }, { once: true });
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 504);
  assert.equal(geminiCalls, 0);
  assert.equal(secAbortObserved, true);
  assert.deepEqual(body, { error: "Unable to load SEC fundamentals" });
});

test("research returns server-derived price context and model technical and macro lenses", { concurrency: false }, async () => {
  const technical = {
    read: "At $400, the shares are 4% higher over five days and sit within the supplied $300-$450 range.",
    points: ["The supplied one-month change is 0%.", "Six-month change data is unavailable."],
    annotations: [],
  };
  const macro = {
    read: "Enterprise software demand and regulation provide qualitative context for the filing trend.",
    points: ["Competitive execution remains important.", "Supply-chain exposure is business-model dependent."],
  };
  const geminiAnalysis = geminiAnalysisForCase("pe", {
    revenueCagr: 5,
    exitNetMargin: 20,
    multipleValue: 20,
  });
  geminiAnalysis.technical = technical;
  geminiAnalysis.macro = macro;
  const priceEntry = {
    price: 400,
    change: -1.5,
    change5D: 4,
    change1M: 0,
    change6M: null,
    changeYTD: 12.25,
    change1Y: 20,
    week52Low: 300,
    week52High: 450,
    session: "REGULAR",
  };
  const { response, geminiCalls, geminiPrompts } = await requestResearch({
    geminiAnalysis,
    priceEntry,
    email: "member@example.com",
    sub: "research-member-allowed",
    adminEmails: "admin@example.com",
    analyzeAllowedEmails: "member@example.com",
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(geminiCalls, 1);
  assert.deepEqual(body.priceContext, priceEntry);
  assert.deepEqual(body.analysis.technical, technical);
  assert.deepEqual(body.analysis.macro, macro);
  assert.match(geminiPrompts[0], /"priceContext":\{"price":400/);
  assert.match(geminiPrompts[0], /Choose ONE valuation method for all three cases/);
  assert.match(geminiPrompts[0], /P\/E of N at an exit net margin of M% implies a P\/S of N × M\/100/);
  assert.match(geminiPrompts[0], /bear case must produce the lowest implied price/);
});

test("research applies one set-level P/S method to all three cases", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCases("ps", {
    bear: { revenueCagr: 0, exitNetMargin: -5, multipleValue: 1 },
    base: { revenueCagr: 0, exitNetMargin: 0, multipleValue: 2 },
    bull: { revenueCagr: 0, exitNetMargin: 10, multipleValue: 3 },
  });
  const { response } = await requestResearch({ geminiAnalysis });
  const body = await response.json();
  const cases = body.analysis.cases;
  const expectedBasePrice = (1200 * 2) / 100;

  assert.equal(response.status, 200);
  assert.equal(cases.multipleType, "ps");
  assert.equal(cases.currentPs, body.marketContext.currentPs);
  assert.deepEqual([cases.bear.impliedPrice, cases.base.impliedPrice, cases.bull.impliedPrice], [12, 24, 36]);
  assert.equal(cases.base.impliedPrice, expectedBasePrice);
  assert.deepEqual([cases.bear.methodError, cases.base.methodError, cases.bull.methodError], [null, null, null]);
  assert.equal("multipleType" in cases.base, false);
});

test("research rejects set-level P/E for a case with non-positive projected income without substituting P/S", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCases("pe", {
    bear: { revenueCagr: 0, exitNetMargin: 0, multipleValue: 10 },
    base: { revenueCagr: 0, exitNetMargin: 10, multipleValue: 20 },
    bull: { revenueCagr: 0, exitNetMargin: 20, multipleValue: 25 },
  });
  const { response, geminiCalls } = await requestResearch({ geminiAnalysis });
  const body = await response.json();
  const cases = body.analysis.cases;

  assert.equal(response.status, 200);
  assert.equal(geminiCalls, 1);
  assert.equal(cases.multipleType, "pe");
  assert.equal(cases.bear.exitNetIncome, 0);
  assert.equal(cases.bear.multipleValue, 10);
  assert.equal(cases.bear.impliedPrice, null);
  assert.equal(cases.bear.impliedPs, null);
  assert.match(cases.bear.methodError, /P\/E.*non-positive projected earnings/i);
  assert.equal(cases.base.impliedPrice, 24);
  assert.equal(cases.bull.impliedPrice, 60);
  assert.ok(cases.bear.impliedPrice == null || cases.bear.impliedPrice >= 0);
});

test("research rejects a legacy per-case multiple type instead of mixing methods", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCases("ps", {
    bear: { revenueCagr: 0, exitNetMargin: 5, multipleValue: 1 },
    base: { revenueCagr: 0, exitNetMargin: 10, multipleValue: 2 },
    bull: { revenueCagr: 0, exitNetMargin: 15, multipleValue: 3 },
  });
  geminiAnalysis.cases.bear.multipleType = "pe";
  const { response } = await requestResearch({ geminiAnalysis });
  const body = await response.json();
  const cases = body.analysis.cases;

  assert.equal(response.status, 200);
  assert.equal(cases.multipleType, "ps");
  assert.equal(cases.bear.projectedRevenue, 1200);
  assert.equal(cases.bear.impliedPrice, null);
  assert.match(cases.bear.methodError, /cases level, not per case/i);
  assert.equal("multipleType" in cases.bear, false);
  assert.deepEqual([cases.base.impliedPrice, cases.bull.impliedPrice], [24, 36]);
});

test("research uses current shares outstanding for the per-share denominator", { concurrency: false }, async () => {
  const revenue = 455_715_000;
  const shares = 84_569_237;
  const revenueCagr = 10;
  const multipleValue = 2.5;
  const geminiAnalysis = geminiAnalysisForCase("ps", {
    revenueCagr,
    exitNetMargin: -2,
    multipleValue,
  });
  const { response } = await requestResearch({
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
  const geminiAnalysis = geminiAnalysisForCase("ps", {
    revenueCagr: 0,
    exitNetMargin: 10,
    multipleValue: 1,
  });
  const { response } = await requestResearch({ geminiAnalysis });
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
  const geminiAnalysis = geminiAnalysisForCase("ps", {
    revenueCagr: 10,
    exitNetMargin: -2,
    multipleValue: 2.5,
  });
  const { response, geminiPrompts } = await requestResearch({
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
  const geminiAnalysis = geminiAnalysisForCase("ps", {
    revenueCagr: 10,
    exitNetMargin: -2,
    multipleValue: 2.5,
  });
  const { response } = await requestResearch({
    geminiAnalysis,
    companyFacts: aaoiCompanyFactsFixture(),
    currentPrice: 150.99,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.marketContext.currentPe, null);
});

test("research computes a P/E price from positive projected earnings", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCase("pe", {
    revenueCagr: 10,
    exitNetMargin: 20,
    multipleValue: 20,
  });
  const { response } = await requestResearch({ geminiAnalysis });
  const body = await response.json();
  const base = body.analysis.cases.base;

  assert.equal(response.status, 200);
  assert.equal(base.impliedPrice, 63.89);
  assert.equal(base.projectedRevenue, 1597);
  assert.equal(base.exitNetIncome, 319);
  assert.equal(base.methodError, null);
});

test("research computes the implied P/S for a P/E-based case", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCase("pe", {
    revenueCagr: 0,
    exitNetMargin: 3,
    multipleValue: 25,
  });
  const { response } = await requestResearch({ geminiAnalysis });
  const body = await response.json();
  const base = body.analysis.cases.base;

  assert.equal(response.status, 200);
  assert.equal(base.impliedPrice, 9);
  assert.ok(Math.abs(base.impliedPs - 0.75) < 1e-12);
  assert.equal(body.analysis.cases.currentPs, body.marketContext.currentPs);
});

test("research detects inverted scenario ordering without altering prices", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCases("ps", {
    bear: { revenueCagr: 0, exitNetMargin: 5, multipleValue: 3 },
    base: { revenueCagr: 0, exitNetMargin: 10, multipleValue: 1 },
    bull: { revenueCagr: 0, exitNetMargin: 15, multipleValue: 2 },
  });
  const warnings = [];
  const originalWarn = console.warn;
  let response;

  try {
    console.warn = (...args) => warnings.push(args.join(" "));
    ({ response } = await requestResearch({ geminiAnalysis }));
  } finally {
    console.warn = originalWarn;
  }

  const body = await response.json();
  const cases = body.analysis.cases;

  assert.equal(response.status, 200);
  assert.equal(cases.ordering.valid, false);
  assert.match(cases.ordering.message, /Bear \(\$36\.00\) exceeds bull \(\$24\.00\)/);
  assert.deepEqual([cases.bear.impliedPrice, cases.base.impliedPrice, cases.bull.impliedPrice], [36, 12, 24]);
  assert.ok(warnings.some(warning => warning.includes(cases.ordering.message)));
});

test("research marks monotonically ordered scenarios as valid", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCases("ps", {
    bear: { revenueCagr: 0, exitNetMargin: 5, multipleValue: 1 },
    base: { revenueCagr: 0, exitNetMargin: 10, multipleValue: 2 },
    bull: { revenueCagr: 0, exitNetMargin: 15, multipleValue: 3 },
  });
  const { response } = await requestResearch({ geminiAnalysis });
  const body = await response.json();
  const cases = body.analysis.cases;

  assert.equal(response.status, 200);
  assert.deepEqual([cases.bear.impliedPrice, cases.base.impliedPrice, cases.bull.impliedPrice], [12, 24, 36]);
  assert.deepEqual(cases.ordering, { valid: true, message: null });
});

test("research returns an explained null price when diluted shares are missing", { concurrency: false }, async () => {
  const companyFacts = companyFactsFixture();
  delete companyFacts.facts["us-gaap"].WeightedAverageNumberOfDilutedSharesOutstanding;
  const geminiAnalysis = geminiAnalysisForCase("pe", {
    revenueCagr: 10,
    exitNetMargin: 20,
    multipleValue: 20,
  });
  const { response } = await requestResearch({ geminiAnalysis, companyFacts });
  const body = await response.json();
  const base = body.analysis.cases.base;

  assert.equal(response.status, 200);
  assert.equal(base.impliedPrice, null);
  assert.match(base.methodError, /shares/i);
});

test("research drops hallucinated annotations and attaches real candidate data", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCase("pe", {
    revenueCagr: 5,
    exitNetMargin: 20,
    multipleValue: 20,
  });
  const longLabel = "A genuinely informative period-high annotation label";
  geminiAnalysis.technical.annotations = [
    { id: "periodHigh", label: longLabel },
    { id: "invented-resistance", label: "Invented resistance" },
  ];

  const { response } = await requestResearch({ geminiAnalysis });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body.analysis.technical.annotations, [{
    id: "periodHigh",
    label: longLabel.slice(0, 40),
    date: "2026-05-14",
    close: 420,
    kind: "periodHigh",
  }]);
  assert.ok(body.notablePoints.some(point =>
    point.id === "periodHigh" && point.date === "2026-05-14" && point.close === 420
  ));
});

test("research computes a renormalised fundamentals and technical composite", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCase("pe", {
    revenueCagr: 5,
    exitNetMargin: 20,
    multipleValue: 20,
  });
  geminiAnalysis.technical.score = 1;
  geminiAnalysis.macro.score = 99;
  const priceEntry = {
    price: 400,
    change: 1,
    change5D: 5,
    change1M: 12,
    change6M: 40,
    changeYTD: 30,
    change1Y: 80,
    week52Low: 300,
    week52High: 450,
    session: "REGULAR",
  };

  const { response, geminiPrompts } = await requestResearch({ geminiAnalysis, priceEntry });
  const body = await response.json();
  const fundamentalsLens = body.composite.lenses.find(lens => lens.key === "fundamentals");
  const technicalLens = body.composite.lenses.find(lens => lens.key === "technical");
  const macroLens = body.composite.lenses.find(lens => lens.key === "macro");
  const expectedScore = Math.round(
    (body.analysis.quality.score * 0.40 + body.technicalScore.score * 0.30) / 0.70
  );
  const expectedVerdict = expectedScore >= 65 ? "BUY" : expectedScore >= 45 ? "HOLD" : "SELL";

  assert.equal(response.status, 200);
  assert.notEqual(body.analysis.quality.score, null);
  assert.notEqual(body.technicalScore.score, null);
  assert.equal(body.composite.score, expectedScore);
  assert.equal(body.composite.verdict, expectedVerdict);
  assert.ok(Math.abs(fundamentalsLens.weight - 0.40 / 0.70) < 1e-12);
  assert.ok(Math.abs(technicalLens.weight - 0.30 / 0.70) < 1e-12);
  assert.equal(macroLens.score, null);
  assert.equal(macroLens.weight, 0);
  assert.equal(macroLens.unscored, true);
  assert.equal("score" in body.analysis.technical, false);
  assert.equal("score" in body.analysis.macro, false);
  assert.match(geminiPrompts[0], /"technicalScore":\{/);
  assert.match(geminiPrompts[0], /"composite":\{/);
});

test("research degrades gracefully when history is unavailable", { concurrency: false }, async () => {
  const geminiAnalysis = geminiAnalysisForCase("pe", {
    revenueCagr: 5,
    exitNetMargin: 20,
    multipleValue: 20,
  });

  const { response, upstreamRequests } = await requestResearch({
    geminiAnalysis,
    history: null,
    historyStatus: 502,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.history, null);
  assert.equal(body.technicalScore.score, null);
  assert.notEqual(body.composite.score, null);
  assert.equal(body.composite.score, body.analysis.quality.score);
  assert.ok(upstreamRequests.some(url =>
    url.startsWith("https://query1.finance.yahoo.com/v8/finance/chart/")
  ));
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
  const { response, upstreamRequests, geminiCalls, rateLimitKeys } = await requestResearch({
    cachedResult,
    geminiKey: undefined,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), cachedResult);
  assert.equal(geminiCalls, 0);
  assert.equal(upstreamRequests.length, 0);
  assert.equal(rateLimitKeys.length, 0);
});
