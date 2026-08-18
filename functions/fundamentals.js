// functions/fundamentals.js

import { getAccessPayload, isTrustedOrigin } from "./access-lib.js";
import { hasFeature } from "./entitlements.js";

const SEC_USER_AGENT = "CapexIQ Research flipsensazn@gmail.com";
const CIK_MAP_CACHE_KEY = "secCikMap_v1";
const CIK_MAP_TTL_SECONDS = 7 * 24 * 60 * 60;
const FUNDAMENTALS_TTL_SECONDS = 24 * 60 * 60;
const TICKER_PATTERN = /^[A-Z0-9^][A-Z0-9.^=-]{0,14}$/;

const CONCEPTS = {
  revenue: {
    unit: "USD",
    tags: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "SalesRevenueNet",
    ],
  },
  grossProfit: { unit: "USD", tags: ["GrossProfit"] },
  operatingIncome: { unit: "USD", tags: ["OperatingIncomeLoss"] },
  netIncome: { unit: "USD", tags: ["NetIncomeLoss", "ProfitLoss"] },
  epsDiluted: { unit: "USD/shares", tags: ["EarningsPerShareDiluted"] },
  researchDevelopment: { unit: "USD", tags: ["ResearchAndDevelopmentExpense"] },
  totalAssets: { unit: "USD", tags: ["Assets"] },
  totalLiabilities: { unit: "USD", tags: ["Liabilities"] },
  equity: {
    unit: "USD",
    tags: [
      "StockholdersEquity",
      "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ],
  },
  cash: {
    unit: "USD",
    tags: [
      "CashAndCashEquivalentsAtCarryingValue",
      "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents",
    ],
  },
  currentAssets: { unit: "USD", tags: ["AssetsCurrent"] },
  currentLiabilities: { unit: "USD", tags: ["LiabilitiesCurrent"] },
  longTermDebt: { unit: "USD", tags: ["LongTermDebtNoncurrent", "LongTermDebt"] },
  operatingCashFlow: {
    unit: "USD",
    tags: [
      "NetCashProvidedByUsedInOperatingActivities",
      "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
    ],
  },
  capex: {
    unit: "USD",
    tags: [
      "PaymentsToAcquirePropertyPlantAndEquipment",
      "PaymentsToAcquireProductiveAssets",
      "PaymentsToAcquirePropertyPlantAndEquipmentAndIntangibleAssets",
    ],
  },
  dividendsPaid: {
    unit: "USD",
    tags: ["PaymentsOfDividendsCommonStock", "PaymentsOfDividends"],
  },
  buybacks: { unit: "USD", tags: ["PaymentsForRepurchaseOfCommonStock"] },
  sharesDiluted: { unit: "shares", tags: ["WeightedAverageNumberOfDilutedSharesOutstanding"] },
};

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function readKvJson(kv, key) {
  if (!kv) return null;
  try {
    return await kv.get(key, "json");
  } catch (err) {
    console.error(`[fundamentals] KV read failed for ${key}:`, err);
    return null;
  }
}

async function writeKvJson(kv, key, value, expirationTtl) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl });
  } catch (err) {
    console.error(`[fundamentals] KV write failed for ${key}:`, err);
  }
}

async function fetchSecJson(url, signal) {
  const response = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT }, signal });
  if (!response.ok) throw new Error(`SEC returned ${response.status}`);
  return await response.json();
}

async function getCikMap(env, signal) {
  const cached = await readKvJson(env.SHARED_DATA, CIK_MAP_CACHE_KEY);
  if (cached && typeof cached === "object") return cached;

  const secMap = await fetchSecJson("https://www.sec.gov/files/company_tickers.json", signal);
  const cikMap = {};
  for (const entry of Object.values(secMap)) {
    if (!entry?.ticker || !Number.isFinite(Number(entry.cik_str))) continue;
    cikMap[String(entry.ticker).toUpperCase()] = String(entry.cik_str).padStart(10, "0");
  }

  await writeKvJson(env.SHARED_DATA, CIK_MAP_CACHE_KEY, cikMap, CIK_MAP_TTL_SECONDS);
  return cikMap;
}

function annualSeriesForTag(usGaapFacts, tag, unit) {
  const entries = usGaapFacts?.[tag]?.units?.[unit];
  if (!Array.isArray(entries)) return null;

  const annual = entries.filter(entry =>
    entry?.form === "10-K" &&
    entry?.fp === "FY" &&
    Number.isInteger(Number(entry?.fy)) &&
    Number.isFinite(entry?.val)
  );
  if (!annual.length) return null;

  const candidatesByYear = {};
  for (const entry of annual) {
    const year = String(Number(entry.fy));
    (candidatesByYear[year] ||= []).push(entry);
  }

  const byYear = {};
  for (const [year, candidates] of Object.entries(candidatesByYear)) {
    // Unframed facts represent the filing context most directly. Fall back
    // per year because some filers publish a mix of framed and unframed years.
    const unframed = candidates.filter(entry => !("frame" in entry));
    const pool = unframed.length ? unframed : candidates;
    byYear[year] = pool.reduce((latest, entry) =>
      String(entry.end || "") >= String(latest.end || "") ? entry : latest
    );
  }

  return Object.fromEntries(Object.entries(byYear).map(([year, entry]) => [year, entry.val]));
}

function extractConcepts(usGaapFacts) {
  const extracted = {};
  for (const [name, { unit, tags }] of Object.entries(CONCEPTS)) {
    extracted[name] = {};
    for (const tag of tags) {
      const series = annualSeriesForTag(usGaapFacts, tag, unit);
      for (const [year, value] of Object.entries(series || {})) {
        if (!(year in extracted[name])) extracted[name][year] = value;
      }
    }
  }
  return extracted;
}

function extractSharesOutstanding(deiFacts) {
  const units = deiFacts?.EntityCommonStockSharesOutstanding?.units;
  if (!units || typeof units !== "object") return { value: null, asOf: null };

  const entries = Object.values(units)
    .flatMap(unitEntries => Array.isArray(unitEntries) ? unitEntries : [])
    .filter(entry => typeof entry?.end === "string");
  if (!entries.length) return { value: null, asOf: null };

  const latest = entries.reduce((current, entry) =>
    entry.end >= current.end ? entry : current
  );
  return {
    value: Number.isFinite(latest.val) ? latest.val : null,
    asOf: latest.end || null,
  };
}

function valuesForYears(series, fiscalYears) {
  return Object.fromEntries(fiscalYears.map(year => [year, series[String(year)] ?? null]));
}

function calculateSeries(fiscalYears, calculation) {
  return Object.fromEntries(fiscalYears.map(year => [year, calculation(year)]));
}

function ratio(numerator, denominator, percentage = false) {
  if (numerator == null || denominator == null || denominator === 0) return null;
  const value = numerator / denominator * (percentage ? 100 : 1);
  return Number.isFinite(value) ? value : null;
}

function cagr(series, fiscalYears) {
  const available = fiscalYears
    .map(year => ({ year, value: series[year] }))
    .filter(({ value }) => value != null);
  if (available.length < 2 || available[0].value <= 0) return null;

  const first = available[0];
  const last = available[available.length - 1];
  const years = last.year - first.year;
  if (years <= 0) return null;

  const value = (Math.pow(last.value / first.value, 1 / years) - 1) * 100;
  return Number.isFinite(value) ? value : null;
}

function buildResult(ticker, cik, companyFacts) {
  const extracted = extractConcepts(companyFacts?.facts?.["us-gaap"] || {});
  const sharesOutstanding = extractSharesOutstanding(companyFacts?.facts?.dei || {});
  const fiscalYears = [...new Set(
    Object.values(extracted).flatMap(series => Object.keys(series).map(Number))
  )]
    .filter(Number.isInteger)
    .sort((a, b) => b - a)
    .slice(0, 6)
    .sort((a, b) => a - b);

  const values = Object.fromEntries(
    Object.entries(extracted).map(([name, series]) => [name, valuesForYears(series, fiscalYears)])
  );
  const freeCashFlow = calculateSeries(fiscalYears, year => {
    const operatingCashFlow = values.operatingCashFlow[year];
    const capex = values.capex[year];
    return operatingCashFlow != null && capex != null ? operatingCashFlow - capex : null;
  });

  const metrics = {
    grossMargin: calculateSeries(fiscalYears, year => ratio(values.grossProfit[year], values.revenue[year], true)),
    operatingMargin: calculateSeries(fiscalYears, year => ratio(values.operatingIncome[year], values.revenue[year], true)),
    netMargin: calculateSeries(fiscalYears, year => ratio(values.netIncome[year], values.revenue[year], true)),
    fcfMargin: calculateSeries(fiscalYears, year => ratio(freeCashFlow[year], values.revenue[year], true)),
    roe: calculateSeries(fiscalYears, year => ratio(values.netIncome[year], values.equity[year])),
    debtToEquity: calculateSeries(fiscalYears, year => ratio(values.longTermDebt[year], values.equity[year])),
    currentRatio: calculateSeries(fiscalYears, year => ratio(values.currentAssets[year], values.currentLiabilities[year])),
  };

  const revenueYoy = calculateSeries(fiscalYears, (year) => {
    const previousYear = year - 1;
    if (!fiscalYears.includes(previousYear)) return null;
    const revenue = values.revenue[year];
    const previousRevenue = values.revenue[previousYear];
    if (revenue == null || previousRevenue == null) return null;
    return ratio(revenue - previousRevenue, previousRevenue, true);
  });

  return {
    ticker,
    cik,
    entityName: companyFacts?.entityName || null,
    fiscalYears,
    currency: "USD",
    sharesOutstanding,
    statements: {
      income: {
        revenue: values.revenue,
        grossProfit: values.grossProfit,
        operatingIncome: values.operatingIncome,
        netIncome: values.netIncome,
        epsDiluted: values.epsDiluted,
        researchDevelopment: values.researchDevelopment,
        sharesDiluted: values.sharesDiluted,
      },
      balance: {
        totalAssets: values.totalAssets,
        totalLiabilities: values.totalLiabilities,
        equity: values.equity,
        cash: values.cash,
        currentAssets: values.currentAssets,
        currentLiabilities: values.currentLiabilities,
        longTermDebt: values.longTermDebt,
      },
      cashFlow: {
        operatingCashFlow: values.operatingCashFlow,
        capex: values.capex,
        freeCashFlow,
        dividendsPaid: values.dividendsPaid,
        buybacks: values.buybacks,
      },
    },
    metrics,
    growth: {
      revenueCagr: cagr(values.revenue, fiscalYears),
      netIncomeCagr: cagr(values.netIncome, fiscalYears),
      revenueYoy,
    },
    source: "SEC XBRL companyfacts",
    retrievedAt: new Date().toISOString(),
  };
}

export async function onRequest(context) {
  const { request, env } = context;
  const allowedOrigin = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === allowedOrigin ? allowedOrigin : "";
  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "GET") {
    return jsonResponse({ error: "Method Not Allowed" }, 405, headers);
  }

  const accessPayload = await getAccessPayload(request, env);
  const memberKey = accessPayload?.sub || accessPayload?.email?.toLowerCase();
  if (!memberKey) {
    return jsonResponse({ error: "Authentication required" }, 401, headers);
  }
  if (!isTrustedOrigin(request, env)) {
    return jsonResponse({ error: "Forbidden" }, 403, headers);
  }
  const email = accessPayload?.email?.toLowerCase();
  if (!(await hasFeature(email, env, "research"))) {
    return jsonResponse({
      error: "Analysis access is not enabled for this account",
      code: "members_only",
    }, 403, headers);
  }

  const ticker = (new URL(request.url).searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker || !TICKER_PATTERN.test(ticker)) {
    return jsonResponse({ error: "Invalid ticker format" }, 400, headers);
  }

  const cacheKey = `fundamentals_v2_${ticker}`;
  const cached = await readKvJson(env.SHARED_DATA, cacheKey);
  if (cached) return jsonResponse(cached, 200, headers);

  try {
    const cikMap = await getCikMap(env, request.signal);
    const cik = cikMap[ticker];
    if (!cik) {
      return jsonResponse({
        error: "No SEC filer found for that ticker",
        ticker,
        note: "Only US SEC filers are covered",
      }, 404, headers);
    }

    let companyFacts = await fetchSecJson(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`,
      request.signal
    );
    const result = buildResult(ticker, cik, companyFacts);
    companyFacts = null;
    await writeKvJson(env.SHARED_DATA, cacheKey, result, FUNDAMENTALS_TTL_SECONDS);
    return jsonResponse(result, 200, headers);
  } catch (err) {
    console.error("[fundamentals] SEC fetch failed:", err);
    return jsonResponse({ error: "Unable to retrieve SEC fundamentals" }, 502, headers);
  }
}
