// functions/research.js

import { isAuthorizedAdmin } from "./access-lib.js";
import { onRequest as fundamentalsHandler } from "./fundamentals.js";
import { onRequest as pricesHandler } from "./prices.js";
import { computeQualityScore } from "./quality-score.js";

const CACHE_KEY_PREFIX = "research_v4_";
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const MAX_BODY_BYTES = 2 * 1024;
const MODEL = "gemini-3.5-flash-lite";
const TICKER_PATTERN = /^[A-Z0-9^][A-Z0-9.^=-]{0,14}$/;

const SYSTEM_PROMPT = `You are a disciplined equity financial analyst.
Reason ONLY from the supplied filed SEC figures. Do not use outside knowledge and do not invent data.
When a supplied figure is null, say the data is unavailable rather than estimating or guessing it.
The server computes every scenario price deterministically. Supply assumptions only and do NOT output a price.
The quality score has been computed deterministically from the filed figures and is supplied as qualityScore. Write one sentence explaining what drives it, and do not contradict it or return a different score.
The market currently values this company at the supplied marketContext.currentPs, and at marketContext.currentPe when available. Each chosen exit multiple MUST be reasoned relative to that current multiple, not picked from generic sector heuristics.
If a chosen exit multiple differs materially from the current multiple, that case's rationale MUST state explicitly why the market's current multiple is expected to re-rate (compress or expand) and by roughly how much.
After selecting assumptions, cross-check each resulting implied price against the supplied currentPrice. A case may land far from the current price ONLY when its rationale explicitly addresses that gap, for example by stating that the market is pricing in materially more growth than the filings support. A bull case far below the current price without such an explanation is incoherent and must be reconsidered.
Do NOT contort assumptions merely to match the current price. An honest conclusion that the market is overpaying is acceptable and valuable when the rationale states it explicitly.

Return ONLY one valid JSON object, without markdown fences or prose outside the JSON, using exactly this schema:
{
  "summary": "3-5 sentence plain-English read of the financial trajectory",
  "strengths": ["2-4 items, each citing a real supplied figure"],
  "risks": ["2-4 items, each citing a real supplied figure"],
  "quality": { "rationale": "one sentence explaining the supplied quality score" },
  "cases": {
    "bear": { "revenueCagr": 0, "exitNetMargin": 0, "multipleType": "pe", "multipleValue": 0, "rationale": "explicit assumptions and reasoning" },
    "base": { "revenueCagr": 0, "exitNetMargin": 0, "multipleType": "pe", "multipleValue": 0, "rationale": "explicit assumptions and reasoning" },
    "bull": { "revenueCagr": 0, "exitNetMargin": 0, "multipleType": "pe", "multipleValue": 0, "rationale": "explicit assumptions and reasoning" }
  },
  "dataGaps": ["concepts that were null and limited the analysis"]
}

Use percentage-point numbers for revenueCagr and exitNetMargin: 8.5 means 8.5%, not 0.085.
For multipleType, use "pe" (price / earnings) ONLY when projected exit net income is positive.
When projected exit net margin is zero or negative, you MUST use "ps" (price / sales, meaning market capitalisation divided by revenue), because P/E is undefined for loss-making companies.
multipleValue is the numeric multiple for the selected multipleType.
Do not calculate or return impliedPrice; the server will calculate it from the supplied assumptions and filed data.
Keep all claims tied to the supplied filed figures, and ensure strengths and risks cite those figures explicitly.`;

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function readKvJson(kv, key) {
  if (!kv) return null;
  try {
    return await kv.get(key, "json");
  } catch (err) {
    console.error(`[research] KV read failed for ${key}:`, err);
    return null;
  }
}

async function writeKvJson(kv, key, value) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error(`[research] KV write failed for ${key}:`, err);
  }
}

// Finds the first balanced JSON object/array while ignoring surrounding
// markdown fences, prose, and Gemini thinking-token leakage.
function extractJson(text) {
  const start = text.search(/[{\[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (escape) { escape = false; continue; }
    if (char === "\\" && inString) { escape = true; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === open) depth += 1;
    if (char === close) {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }

  return null;
}

async function callGemini(apiKey, fundamentals, currentPrice, marketContext, calculationInputs, qualityScore) {
  const prompt = `${SYSTEM_PROMPT}\n\nSUPPLIED FILED DATA AND PRICE CONTEXT:\n${JSON.stringify({ fundamentals, currentPrice, marketContext, calculationInputs, qualityScore })}`;
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 4096,
          responseMimeType: "application/json",
          // No thinkingConfig: Gemini 3.x replaced `thinkingBudget` with
          // `thinking_level`, so the old `thinkingBudget: 0` is rejected with
          // 400 INVALID_ARGUMENT. This model defaults to minimal thinking,
          // which is what we want. Tune via `thinkingLevel` if ever needed.
        },
      }),
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`[model ${MODEL}] Gemini ${response.status}: ${detail.slice(0, 300)}`);
  }

  const data = await response.json();
  if (data?.error) throw new Error(`Gemini error: ${data.error.message || JSON.stringify(data.error)}`);
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`Gemini blocked: ${blockReason}`);

  const rawText = data?.candidates?.[0]?.content?.parts?.map(part => part.text).join("") ?? "";
  const extracted = extractJson(rawText);
  if (!extracted) throw new Error("Gemini returned no valid JSON object");

  const parsed = JSON.parse(extracted);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !parsed.cases) {
    throw new Error("Gemini returned an invalid analysis schema");
  }
  return parsed;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function latestFiledValue(series, fiscalYears) {
  for (let index = fiscalYears.length - 1; index >= 0; index -= 1) {
    const value = finiteNumber(series?.[fiscalYears[index]]);
    if (value != null) return { value, fiscalYear: fiscalYears[index] };
  }
  return { value: null, fiscalYear: null };
}

function finiteProduct(left, right) {
  if (left == null || right == null) return null;
  const value = left * right;
  return Number.isFinite(value) ? value : null;
}

function finiteRatio(numerator, denominator) {
  if (numerator == null || denominator == null || denominator === 0) return null;
  const value = numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

function priceCase(modelCase, latestRevenue, latestShares) {
  const validCase = modelCase && typeof modelCase === "object" && !Array.isArray(modelCase)
    ? modelCase
    : {};
  const revenueCagr = finiteNumber(validCase.revenueCagr);
  const exitNetMargin = finiteNumber(validCase.exitNetMargin);
  const multipleType = validCase.multipleType === "pe" || validCase.multipleType === "ps"
    ? validCase.multipleType
    : null;
  const multipleValue = finiteNumber(validCase.multipleValue);
  const revenue = finiteNumber(latestRevenue);
  const shares = finiteNumber(latestShares);
  let projectedRevenue = null;
  let exitNetIncome = null;
  let impliedPrice = null;
  let methodError = null;

  if (revenue == null) methodError = "Latest revenue is missing";
  else if (revenueCagr == null) methodError = "Revenue CAGR is missing";
  else {
    projectedRevenue = revenue * Math.pow(1 + revenueCagr / 100, 3);
    if (!Number.isFinite(projectedRevenue)) methodError = "Computed price is not meaningful";
  }

  if (!methodError && exitNetMargin == null) methodError = "Exit net margin is missing";
  else if (!methodError) {
    exitNetIncome = projectedRevenue * (exitNetMargin / 100);
    if (!Number.isFinite(exitNetIncome)) methodError = "Computed price is not meaningful";
  }

  if (!methodError && (shares == null || shares <= 0)) {
    methodError = "Shares are missing or zero";
  } else if (!methodError && multipleType == null) {
    methodError = "Multiple type is missing or invalid";
  } else if (!methodError && multipleValue == null) {
    methodError = "Multiple value is missing";
  } else if (!methodError && multipleType === "pe" && exitNetIncome <= 0) {
    methodError = "P/E is not meaningful for negative projected earnings";
  } else if (!methodError) {
    const price = multipleType === "pe"
      ? (exitNetIncome / shares) * multipleValue
      : (projectedRevenue * multipleValue) / shares;
    if (!Number.isFinite(price) || price < 0) {
      methodError = "Computed price is not meaningful";
    } else {
      impliedPrice = Number(price.toFixed(2));
    }
  }

  return {
    revenueCagr,
    exitNetMargin,
    multipleType,
    multipleValue,
    rationale: typeof validCase.rationale === "string" ? validCase.rationale : "",
    impliedPrice,
    projectedRevenue: Number.isFinite(projectedRevenue) ? Math.round(projectedRevenue) : null,
    exitNetIncome: Number.isFinite(exitNetIncome) ? Math.round(exitNetIncome) : null,
    methodError,
  };
}

async function getCurrentPrice(request, env, ticker) {
  try {
    const priceRequest = new Request(
      `https://internal/prices?tickers=${encodeURIComponent(ticker)}`,
      { method: "GET", headers: request.headers }
    );
    const response = await pricesHandler({ request: priceRequest, env });
    if (!response.ok) return null;
    const body = await response.json();
    return finiteNumber(body?.data?.[ticker]?.price);
  } catch {
    return null;
  }
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
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405, headers);
  }

  if (!await isAuthorizedAdmin(request, env, undefined)) {
    return jsonResponse({ error: "Forbidden" }, 403, headers);
  }

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Request body too large" }, 413, headers);
  }

  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, headers);
  }

  if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return jsonResponse({ error: "Request body too large" }, 413, headers);
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400, headers);
  }

  const ticker = body && typeof body === "object" && !Array.isArray(body) && typeof body.ticker === "string"
    ? body.ticker.trim().toUpperCase()
    : "";
  if (!ticker || !TICKER_PATTERN.test(ticker)) {
    return jsonResponse({ error: "Invalid ticker format" }, 400, headers);
  }

  const cacheKey = `${CACHE_KEY_PREFIX}${ticker}`;
  const cached = await readKvJson(env.SHARED_DATA, cacheKey);
  if (cached) return jsonResponse(cached, 200, headers);

  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: "Analysis service is not configured" }, 503, headers);
  }

  const fundamentalsRequest = new Request(
    `https://internal/fundamentals?ticker=${encodeURIComponent(ticker)}`,
    { method: "GET", headers: request.headers }
  );
  const fundamentalsResponse = await fundamentalsHandler({ request: fundamentalsRequest, env });
  if (!fundamentalsResponse.ok) {
    return new Response(fundamentalsResponse.body, {
      status: fundamentalsResponse.status,
      headers,
    });
  }

  let fundamentals;
  try {
    fundamentals = await fundamentalsResponse.json();
  } catch {
    return jsonResponse({ error: "Unable to read SEC fundamentals" }, 502, headers);
  }

  const qualityScore = computeQualityScore(fundamentals);
  const currentPrice = await getCurrentPrice(request, env, ticker);
  const fiscalYears = Array.isArray(fundamentals.fiscalYears) ? fundamentals.fiscalYears : [];
  const latestFiscalYear = fiscalYears.length ? fiscalYears[fiscalYears.length - 1] : null;
  const latestRevenue = latestFiledValue(fundamentals?.statements?.income?.revenue, fiscalYears);
  const latestNetIncome = latestFiledValue(fundamentals?.statements?.income?.netIncome, fiscalYears);
  const latestDilutedShares = latestFiledValue(fundamentals?.statements?.income?.sharesDiluted, fiscalYears);
  const currentShares = finiteNumber(fundamentals?.sharesOutstanding?.value);
  const usesCurrentShares = currentShares != null && currentShares > 0;
  const shareCount = usesCurrentShares
    ? currentShares
    : latestDilutedShares.value != null && latestDilutedShares.value > 0
      ? latestDilutedShares.value
      : null;
  const shareCountBasis = usesCurrentShares
    ? "current_outstanding"
    : shareCount != null
      ? "weighted_average_diluted"
      : null;
  const shareCountAsOf = usesCurrentShares && typeof fundamentals?.sharesOutstanding?.asOf === "string"
    ? fundamentals.sharesOutstanding.asOf
    : null;
  const marketCap = finiteProduct(currentPrice, shareCount);
  const marketContext = {
    marketCap,
    currentPs: finiteRatio(marketCap, latestRevenue.value),
    currentPe: latestNetIncome.value != null && latestNetIncome.value > 0
      ? finiteRatio(marketCap, latestNetIncome.value)
      : null,
  };
  const calculationInputs = {
    latestRevenue: latestRevenue.value,
    latestRevenueFiscalYear: latestRevenue.fiscalYear,
    latestDilutedShares: latestDilutedShares.value,
    latestDilutedSharesFiscalYear: latestDilutedShares.fiscalYear,
    shareCount,
    shareCountBasis,
    shareCountAsOf,
  };

  try {
    const modelAnalysis = await callGemini(env.GEMINI_API_KEY, fundamentals, currentPrice, marketContext, calculationInputs, qualityScore);
    const cases = modelAnalysis.cases || {};
    const analysis = {
      ...modelAnalysis,
      quality: {
        ...qualityScore,
        rationale: typeof modelAnalysis?.quality?.rationale === "string"
          ? modelAnalysis.quality.rationale
          : "",
      },
      cases: {
        ...cases,
        bear: priceCase(cases.bear, latestRevenue.value, shareCount),
        base: priceCase(cases.base, latestRevenue.value, shareCount),
        bull: priceCase(cases.bull, latestRevenue.value, shareCount),
      },
    };
    const result = {
      ticker,
      entityName: fundamentals.entityName ?? null,
      currentPrice,
      shareCount,
      shareCountBasis,
      shareCountAsOf,
      marketContext,
      latestFiscalYear,
      analysis,
      generatedAt: new Date().toISOString(),
      model: MODEL,
      disclaimer: "This is a model-generated projection from filed data, not investment advice.",
    };

    await writeKvJson(env.SHARED_DATA, cacheKey, result);
    return jsonResponse(result, 200, headers);
  } catch (err) {
    console.error("[research] analysis failed:", err);
    return jsonResponse({ error: "Analysis failed", detail: String(err?.message || err).slice(0, 400) }, 502, headers);
  }
}
