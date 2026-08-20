// functions/research.js

import { getAccessPayload, isTrustedOrigin } from "./access-lib.js";
import {
  getResearchQuota,
  getResearchUsage,
  hasFeature,
  incrementResearchUsage,
  nextMonthResetDate,
} from "./entitlements.js";
import { onRequest as fundamentalsHandler } from "./fundamentals.js";
import { onRequest as historyHandler } from "./history.js";
import { findNotablePoints } from "./notable-points.js";
import { onRequest as pricesHandler } from "./prices.js";
import { computeQualityScore } from "./quality-score.js";
import { computeTechnicalScore } from "./technical-score.js";

const CACHE_KEY_PREFIX = "research_v8_";
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const MAX_BODY_BYTES = 2 * 1024;
const MODEL = "gemini-3.5-flash-lite";
const DEFAULT_INTERNAL_TIMEOUT_MS = 10_000;
const DEFAULT_MODEL_TIMEOUT_MS = 40_000;
const MIN_TIMEOUT_MS = 10;
const MAX_TIMEOUT_MS = 60_000;
const TICKER_PATTERN = /^[A-Z0-9^][A-Z0-9.^=-]{0,14}$/;

const SYSTEM_PROMPT = `You are a disciplined equity financial analyst.
Reason ONLY from the supplied filed SEC figures, except that the technical section may use the supplied priceContext and the macro section may use qualitative general sector knowledge under the rules below. Do not invent data.
When a supplied figure is null, say the data is unavailable rather than estimating or guessing it.
The server computes every scenario price deterministically. Supply assumptions only and do NOT output a price.
The quality score has been computed deterministically from the filed figures and is supplied as qualityScore. Write one sentence explaining what drives it, and do not contradict it or return a different score.
The market currently values this company at the supplied marketContext.currentPs, and at marketContext.currentPe when available. The one selected scenario-set method and every chosen exit multiple MUST be reasoned relative to those current multiples, not picked from generic sector heuristics.
A P/E of N at an exit net margin of M% implies a P/S of N × M/100. Compute that implied P/S for each case as a sanity check against marketContext.currentPs, and state in each rationale why the market's current P/S is expected to re-rate to that level.
If the implied P/S differs materially from the current P/S, that case's rationale MUST state explicitly why the market's current multiple is expected to re-rate (compress or expand) and by roughly how much.
After selecting assumptions, cross-check each resulting implied price against the supplied currentPrice. A case may land far from the current price ONLY when its rationale explicitly addresses that gap, for example by stating that the market is pricing in materially more growth than the filings support. A bull case far below the current price without such an explanation is incoherent and must be reconsidered.
The bear case must produce the lowest implied price and the bull case the highest. If your assumptions do not yield bear <= base <= bull, reconsider them before answering.
Do NOT contort assumptions merely to match the current price. An honest conclusion that the market is overpaying is acceptable and valuable when the rationale states it explicitly.
The technical read must cite only the supplied priceContext figures and notablePoints. When a priceContext field is null, say the data is unavailable rather than inferring it.
Annotations MUST reference only the supplied notablePoints ids. Do NOT invent dates, price levels, support/resistance values or patterns.
Select only the genuinely informative annotation candidates; fewer is better, and zero is acceptable.
The technical score is computed deterministically and supplied as technicalScore. Explain it if useful, do not restate or contradict it, and do not emit your own score.
The macro read is explicitly qualitative and may draw on general sector knowledge, but must NOT assert specific numbers such as revenue figures, market share percentages, or competitor financials that are not in the supplied data. Frame it as context, not fact-claims.
Macro remains unscored and must not emit a score.

Return ONLY one valid JSON object, without markdown fences or prose outside the JSON, using exactly this schema:
{
  "summary": "3-5 sentence plain-English read of the financial trajectory",
  "strengths": ["2-4 items, each citing a real supplied figure"],
  "risks": ["2-4 items, each citing a real supplied figure"],
  "technical": {
    "read": "2-3 sentences on trend, momentum and position within the 52-week range",
    "points": ["2-4 short observations, each citing a supplied price figure"],
    "annotations": [ { "id": "<one of the supplied notablePoints ids>", "label": "short chart label, max 40 chars" } ]
  },
  "macro": {
    "read": "2-3 sentences on sector dynamics, competitive position, supply-chain and regulatory context",
    "points": ["2-4 short observations"]
  },
  "quality": { "rationale": "one sentence explaining the supplied quality score" },
  "cases": {
    "multipleType": "pe",
    "bear": { "revenueCagr": 0, "exitNetMargin": 0, "multipleValue": 0, "rationale": "explicit assumptions and reasoning" },
    "base": { "revenueCagr": 0, "exitNetMargin": 0, "multipleValue": 0, "rationale": "explicit assumptions and reasoning" },
    "bull": { "revenueCagr": 0, "exitNetMargin": 0, "multipleValue": 0, "rationale": "explicit assumptions and reasoning" }
  },
  "dataGaps": ["concepts that were null and limited the analysis"]
}

Use percentage-point numbers for revenueCagr and exitNetMargin: 8.5 means 8.5%, not 0.085.
Choose ONE valuation method for all three cases so they are directly comparable, and return it once as cases.multipleType. Do not put multipleType inside an individual case.
You MUST use "ps" (price / sales, meaning market capitalisation divided by revenue) if ANY of the three cases has non-positive projected exit net income, because P/E is undefined there and mixing methods makes the set incomparable.
You may use "pe" (price / earnings) ONLY when all three cases have positive projected exit net income.
multipleValue is each case's numeric exit multiple under the single cases.multipleType.
For a P/E case, compute the implied P/S as multipleValue × exitNetMargin / 100, sanity-check it against marketContext.currentPs, and explain the re-rating in the rationale. Do not add implied P/S to the JSON; the server derives it deterministically.
Do not calculate or return impliedPrice; the server will calculate it from the supplied assumptions and filed data.
Keep financial claims tied to the supplied filed figures, ensure strengths and risks cite those figures explicitly, and follow the technical and macro sourcing rules above.`;

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

function boundedTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= MIN_TIMEOUT_MS && parsed <= MAX_TIMEOUT_MS
    ? parsed
    : fallback;
}

async function withTimeout(operation, timeoutMs, label) {
  const controller = new AbortController();
  const timeoutError = new Error(`${label} timed out after ${timeoutMs}ms`);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(timeoutError);
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
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

async function callGemini(apiKey, fundamentals, currentPrice, priceContext, marketContext, calculationInputs, qualityScore, technicalScore, notablePoints, composite, timeoutMs) {
  const prompt = `${SYSTEM_PROMPT}\n\nSUPPLIED FILED DATA AND PRICE CONTEXT:\n${JSON.stringify({ fundamentals, currentPrice, priceContext, marketContext, calculationInputs, qualityScore, technicalScore, notablePoints, composite })}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 5120,
            responseMimeType: "application/json",
            // No thinkingConfig: Gemini 3.x replaced `thinkingBudget` with
            // `thinking_level`, so the old `thinkingBudget: 0` is rejected with
            // 400 INVALID_ARGUMENT. This model defaults to minimal thinking,
            // which is what we want. Tune via `thinkingLevel` if ever needed.
          },
        }),
        signal: controller.signal,
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
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Analysis model timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function buildPriceContext(entry) {
  return {
    price: finiteNumber(entry?.price),
    change: finiteNumber(entry?.change),
    change5D: finiteNumber(entry?.change5D),
    change1M: finiteNumber(entry?.change1M),
    change6M: finiteNumber(entry?.change6M),
    changeYTD: finiteNumber(entry?.changeYTD),
    change1Y: finiteNumber(entry?.change1Y),
    week52Low: finiteNumber(entry?.week52Low),
    week52High: finiteNumber(entry?.week52High),
    session: typeof entry?.session === "string" ? entry.session : null,
  };
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

function priceCase(modelCase, multipleType, latestRevenue, latestShares) {
  const validCase = modelCase && typeof modelCase === "object" && !Array.isArray(modelCase)
    ? modelCase
    : {};
  const revenueCagr = finiteNumber(validCase.revenueCagr);
  const exitNetMargin = finiteNumber(validCase.exitNetMargin);
  const hasPerCaseMultipleType = Object.prototype.hasOwnProperty.call(validCase, "multipleType");
  const multipleValue = finiteNumber(validCase.multipleValue);
  const revenue = finiteNumber(latestRevenue);
  const shares = finiteNumber(latestShares);
  let projectedRevenue = null;
  let exitNetIncome = null;
  let impliedPrice = null;
  let impliedPs = null;
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
  } else if (!methodError && hasPerCaseMultipleType) {
    methodError = "Multiple type must be supplied once at the cases level, not per case";
  } else if (!methodError && multipleType == null) {
    methodError = "Set-level multiple type is missing or invalid";
  } else if (!methodError && multipleValue == null) {
    methodError = "Multiple value is missing";
  } else if (!methodError && multipleType === "pe" && exitNetIncome <= 0) {
    methodError = "P/E is not meaningful for non-positive projected earnings";
  } else if (!methodError) {
    const price = multipleType === "pe"
      ? (exitNetIncome / shares) * multipleValue
      : (projectedRevenue * multipleValue) / shares;
    if (!Number.isFinite(price) || price < 0) {
      methodError = "Computed price is not meaningful";
    } else {
      impliedPrice = Number(price.toFixed(2));
      impliedPs = finiteRatio(finiteProduct(impliedPrice, shares), projectedRevenue);
    }
  }

  return {
    revenueCagr,
    exitNetMargin,
    multipleValue,
    rationale: typeof validCase.rationale === "string" ? validCase.rationale : "",
    impliedPrice,
    impliedPs,
    projectedRevenue: Number.isFinite(projectedRevenue) ? Math.round(projectedRevenue) : null,
    exitNetIncome: Number.isFinite(exitNetIncome) ? Math.round(exitNetIncome) : null,
    methodError,
  };
}

function validateCaseOrdering(pricedCases) {
  const orderedCases = [
    ["bear", "Bear"],
    ["base", "Base"],
    ["bull", "Bull"],
  ];
  const violations = [];

  for (let leftIndex = 0; leftIndex < orderedCases.length; leftIndex += 1) {
    const [leftKey, leftLabel] = orderedCases[leftIndex];
    const leftPrice = finiteNumber(pricedCases?.[leftKey]?.impliedPrice);
    if (leftPrice == null) continue;

    for (let rightIndex = leftIndex + 1; rightIndex < orderedCases.length; rightIndex += 1) {
      const [rightKey] = orderedCases[rightIndex];
      const rightPrice = finiteNumber(pricedCases?.[rightKey]?.impliedPrice);
      if (rightPrice == null || leftPrice <= rightPrice) continue;
      violations.push(`${leftLabel} ($${leftPrice.toFixed(2)}) exceeds ${rightKey} ($${rightPrice.toFixed(2)})`);
    }
  }

  if (violations.length === 0) return { valid: true, message: null };

  const message = `${violations.join("; ")} — the cases are not internally consistent`;
  console.warn(`[research] ${message}`);
  return { valid: false, message };
}

async function getPriceContext(request, env, ticker, signal) {
  try {
    const priceRequest = new Request(
      `https://internal/prices?tickers=${encodeURIComponent(ticker)}`,
      { method: "GET", headers: request.headers, signal }
    );
    const response = await pricesHandler({ request: priceRequest, env });
    if (!response.ok) return buildPriceContext(null);
    const body = await response.json();
    return buildPriceContext(body?.data?.[ticker]);
  } catch (error) {
    if (signal?.aborted) throw error;
    return buildPriceContext(null);
  }
}

async function getHistory(request, env, ticker, signal) {
  try {
    const historyRequest = new Request(
      `https://internal/history?ticker=${encodeURIComponent(ticker)}`,
      { method: "GET", headers: request.headers, signal }
    );
    const response = await historyHandler({ request: historyRequest, env });
    if (!response.ok) return null;
    const body = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

function computeComposite(qualityScore, technicalScore) {
  const lensDefinitions = [
    { key: "fundamentals", label: "Fundamentals", rawWeight: 0.40, score: finiteNumber(qualityScore?.score) },
    { key: "technical", label: "Technical", rawWeight: 0.30, score: finiteNumber(technicalScore?.score) },
    {
      key: "macro",
      label: "Macro",
      rawWeight: 0.30,
      score: null,
      unscored: true,
      note: "Qualitative only — no numeric inputs to score",
    },
  ];
  const availableRawWeight = lensDefinitions.reduce((sum, lens) =>
    lens.score == null ? sum : sum + lens.rawWeight
  , 0);
  const lenses = lensDefinitions.map(lens => ({
    key: lens.key,
    label: lens.label,
    score: lens.score,
    weight: lens.score != null && availableRawWeight > 0
      ? lens.rawWeight / availableRawWeight
      : 0,
    rawWeight: lens.rawWeight,
    ...(lens.unscored ? { unscored: true, note: lens.note } : {}),
  }));
  const weightedScore = lenses.reduce((sum, lens) =>
    lens.score == null ? sum : sum + lens.score * lens.weight
  , 0);
  const score = availableRawWeight > 0 && Number.isFinite(weightedScore)
    ? Math.round(weightedScore)
    : null;

  return {
    score,
    verdict: score == null ? null : score >= 65 ? "BUY" : score >= 45 ? "HOLD" : "SELL",
    lenses,
    note: score == null ? "Insufficient scored lenses to compute a composite" : null,
  };
}

function validateTechnicalAnnotations(modelTechnical, notablePoints) {
  const candidates = new Map(notablePoints.map(candidate => [candidate.id, candidate]));
  const requested = Array.isArray(modelTechnical?.annotations)
    ? modelTechnical.annotations
    : [];
  const annotations = [];

  for (const annotation of requested) {
    const candidate = annotation && typeof annotation === "object" && !Array.isArray(annotation)
      ? candidates.get(annotation.id)
      : null;
    if (!candidate || typeof annotation.label !== "string") continue;
    annotations.push({
      id: candidate.id,
      label: annotation.label.slice(0, 40),
      date: candidate.date,
      close: candidate.close,
      kind: candidate.kind,
    });
  }

  const droppedCount = requested.length - annotations.length;
  if (droppedCount > 0) {
    console.warn(`[research] dropped ${droppedCount} invalid technical annotation${droppedCount === 1 ? "" : "s"}`);
  }
  return annotations;
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
  const quota = await getResearchQuota(email, env);
  let usage = quota;
  if (!quota.unmetered) {
    usage = { used: await getResearchUsage(email, env), limit: quota.limit };
  }
  if (cached) return jsonResponse({ ...cached, usage }, 200, headers);

  if (!quota.unmetered && usage.used >= usage.limit) {
    return jsonResponse({
      error: "Monthly research limit reached",
      code: "quota_exceeded",
      used: usage.used,
      limit: usage.limit,
      resetsOn: nextMonthResetDate(),
    }, 429, headers);
  }

  // Cache hits are free. Fail closed and rate-limit only work that can fan out
  // to SEC/Yahoo and a paid Gemini request.
  if (!env.ANALYZE_RATE_LIMITER) {
    return jsonResponse({ error: "Analysis service is temporarily unavailable" }, 503, headers);
  }
  try {
    const { success } = await env.ANALYZE_RATE_LIMITER.limit({ key: String(memberKey) });
    if (!success) {
      return jsonResponse(
        { error: "Analysis limit reached. Try again in a minute." },
        429,
        { ...headers, "Retry-After": "60" }
      );
    }
  } catch (err) {
    console.error("[research] rate limit error:", err);
    return jsonResponse({ error: "Analysis service is temporarily unavailable" }, 503, headers);
  }

  if (!env.GEMINI_API_KEY) {
    return jsonResponse({ error: "Analysis service is not configured" }, 503, headers);
  }

  const internalTimeoutMs = boundedTimeout(env.RESEARCH_INTERNAL_TIMEOUT_MS, DEFAULT_INTERNAL_TIMEOUT_MS);
  const modelTimeoutMs = boundedTimeout(env.RESEARCH_MODEL_TIMEOUT_MS, DEFAULT_MODEL_TIMEOUT_MS);

  let fundamentalsResponse;
  try {
    fundamentalsResponse = await withTimeout(
      signal => fundamentalsHandler({
        request: new Request(
          `https://internal/fundamentals?ticker=${encodeURIComponent(ticker)}`,
          { method: "GET", headers: request.headers, signal }
        ),
        env,
      }),
      internalTimeoutMs,
      "SEC fundamentals"
    );
  } catch (err) {
    console.error("[research] fundamentals failed:", err);
    return jsonResponse({ error: "Unable to load SEC fundamentals" }, 504, headers);
  }
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
  let priceContext;
  let history;
  try {
    [priceContext, history] = await Promise.all([
      withTimeout(signal => getPriceContext(request, env, ticker, signal), internalTimeoutMs, "Price context"),
      withTimeout(signal => getHistory(request, env, ticker, signal), internalTimeoutMs, "Price history"),
    ]);
  } catch (err) {
    console.error("[research] market context failed:", err);
    return jsonResponse({ error: "Unable to load market context" }, 504, headers);
  }
  const technicalScore = computeTechnicalScore(priceContext, history);
  const notablePoints = history
    ? findNotablePoints(history.points, history.displayFrom)
    : [];
  const composite = computeComposite(qualityScore, technicalScore);
  const currentPrice = priceContext.price;
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
    const modelAnalysis = await callGemini(env.GEMINI_API_KEY, fundamentals, currentPrice, priceContext, marketContext, calculationInputs, qualityScore, technicalScore, notablePoints, composite, modelTimeoutMs);
    const modelCases = modelAnalysis?.cases && typeof modelAnalysis.cases === "object" && !Array.isArray(modelAnalysis.cases)
      ? modelAnalysis.cases
      : {};
    const multipleType = modelCases.multipleType === "pe" || modelCases.multipleType === "ps"
      ? modelCases.multipleType
      : null;
    const pricedCases = {
      bear: priceCase(modelCases.bear, multipleType, latestRevenue.value, shareCount),
      base: priceCase(modelCases.base, multipleType, latestRevenue.value, shareCount),
      bull: priceCase(modelCases.bull, multipleType, latestRevenue.value, shareCount),
    };
    const modelTechnical = modelAnalysis?.technical && typeof modelAnalysis.technical === "object" && !Array.isArray(modelAnalysis.technical)
      ? modelAnalysis.technical
      : {};
    const technicalAnalysis = { ...modelTechnical };
    delete technicalAnalysis.score;
    const macroAnalysis = modelAnalysis?.macro && typeof modelAnalysis.macro === "object" && !Array.isArray(modelAnalysis.macro)
      ? { ...modelAnalysis.macro }
      : {};
    delete macroAnalysis.score;
    const analysis = {
      ...modelAnalysis,
      technical: {
        ...technicalAnalysis,
        annotations: validateTechnicalAnnotations(technicalAnalysis, notablePoints),
      },
      macro: macroAnalysis,
      quality: {
        ...qualityScore,
        rationale: typeof modelAnalysis?.quality?.rationale === "string"
          ? modelAnalysis.quality.rationale
          : "",
      },
      cases: {
        multipleType,
        currentPs: marketContext.currentPs,
        ...pricedCases,
        ordering: validateCaseOrdering(pricedCases),
      },
    };
    const result = {
      ticker,
      entityName: fundamentals.entityName ?? null,
      currentPrice,
      priceContext,
      history,
      technicalScore,
      notablePoints,
      composite,
      shareCount,
      shareCountBasis,
      shareCountAsOf,
      marketContext,
      latestFiscalYear,
      analysis,
      generatedAt: new Date().toISOString(),
      model: MODEL,
      disclaimer: "This is a model-generated projection from filed data, and the verdict is a model-assisted composite, not investment advice.",
    };

    if (!quota.unmetered) {
      usage = {
        used: await incrementResearchUsage(email, env),
        limit: quota.limit,
      };
    }
    await writeKvJson(env.SHARED_DATA, cacheKey, result);
    return jsonResponse({ ...result, usage }, 200, headers);
  } catch (err) {
    console.error("[research] analysis failed:", err);
    return jsonResponse({ error: "Analysis failed", detail: String(err?.message || err).slice(0, 400) }, 502, headers);
  }
}
