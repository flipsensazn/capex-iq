// functions/analyze.js
//
// POST /analyze  { ticker, currentPrice, peRatio, marketCap, week52Low, week52High }
// Runs 3 Gemini agents concurrently (Fundamentals · Technical · Qual/Macro),
// then synthesizes into a markdown report with a BUY/HOLD/SELL score and
// 3-year price projection.  Results cached in KV for 24 hours.

import { getAccessPayload, isAnalyzeAllowedEmail, isTrustedOrigin } from "./access-lib.js";

const CACHE_KEY_PREFIX = "analysis_v3_";
const CACHE_TTL_SEC    = 24 * 60 * 60;
const MODEL_AGENT = "gemini-2.5-flash";
const MODEL_SYNTH = "gemini-2.5-flash";
const MAX_BODY_BYTES = 8 * 1024;
const TICKER_PATTERN = /^[A-Z0-9^][A-Z0-9.^=-]{0,14}$/;

function normalizeContextValue(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return "unknown";
  const normalized = value.replace(/[\r\n]+/g, " ").trim().slice(0, 100);
  return normalized || "unknown";
}

// ── JSON EXTRACTOR ────────────────────────────────────────────────────────────
// Finds the first balanced { } or [ ] block in a string, ignoring surrounding
// text, markdown fences, and thinking-mode tokens that gemini-2.5 can emit.
function extractJson(text) {
  const start = text.search(/[{\[]/);
  if (start === -1) return null;
  const open = text[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ── GEMINI HELPER ─────────────────────────────────────────────────────────────
async function callGemini(apiKey, systemPrompt, userContent, maxTokens = 900, timeoutMs = 25000) {
  const prompt = `${systemPrompt}\n\n${userContent}`;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_AGENT}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
      // Disable thinking mode — we need fast structured JSON, not deep reasoning.
      // Thinking tokens also leak into the response text and break JSON parsing.
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  // 3 attempts with exponential backoff: 2s then 4s.
  // Capped at 3 — Cloudflare Functions have a 30s wall-clock limit so longer
  // waits would be killed before they complete anyway.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      const delay = 2000 * Math.pow(2, attempt - 1); // 2s, 4s
      await new Promise(r => setTimeout(r, delay));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 || res.status === 503 || res.status === 529) {
      lastError = new Error(`Gemini ${res.status}: rate limited / overloaded (attempt ${attempt + 1})`);
      continue; // delay handled at top of loop
    }

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Gemini ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = await res.json();

    // Gemini sometimes returns 200 with an error field instead of candidates
    if (data.error) {
      const msg = data.error.message || JSON.stringify(data.error);
      if (attempt < 2) { lastError = new Error(`Gemini error: ${msg}`); continue; }
      throw new Error(`Gemini error: ${msg}`);
    }

    // Safety block — candidates array is empty
    const blockReason = data.promptFeedback?.blockReason;
    if (blockReason) throw new Error(`Gemini blocked: ${blockReason}`);

    const rawText = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "";
    if (!rawText) throw new Error("Gemini returned empty content");

    // Extract the first balanced JSON object or array.
    // This handles thinking-mode leakage, markdown fences, and trailing prose.
    const extracted = extractJson(rawText);
    if (!extracted) throw new Error(`No valid JSON found in response: ${rawText.slice(0, 200)}`);

    try {
      return JSON.parse(extracted);
    } catch (e) {
      throw new Error(`JSON parse failed: ${e.message} — raw: ${extracted.slice(0, 200)}`);
    }
  }

  throw lastError;
}

// ── AGENT SYSTEM PROMPTS ──────────────────────────────────────────────────────
const FUNDAMENTALS_SYSTEM = `You are a senior equity research analyst specializing in fundamental analysis.
Analyze the provided stock using your training knowledge of the company's financials, business model, capex allocation, and competitive dynamics.
Pay special attention to capital expenditure trends — especially for companies exposed to AI/hyperscaler spending cycles.
Return ONLY a valid JSON object. No markdown fences, no explanation outside the JSON.

Schema:
{
  "revenue_growth_yoy": <number, decimal e.g. 0.22 for 22%>,
  "revenue_growth_3y_cagr": <number, decimal, your best estimate>,
  "gross_margin": <number, decimal>,
  "operating_margin": <number, decimal>,
  "fcf_yield": <number, decimal>,
  "debt_to_equity": <number>,
  "capex_intensity": <number, capex as fraction of revenue>,
  "capex_trend": <"increasing"|"stable"|"decreasing">,
  "capex_note": <string, 1 sentence on capex strategy>,
  "valuation_signal": <"cheap"|"fair"|"stretched">,
  "financial_health": <"strong"|"moderate"|"weak">,
  "key_strengths": <string[], 2-4 items>,
  "key_risks": <string[], 2-4 items>,
  "score": <integer 0-100, 100 = strongest buy signal on fundamentals alone>,
  "summary": <string, 2-3 sentences>
}`;

const TECHNICAL_SYSTEM = `You are a quantitative technical analyst specializing in price action, momentum, and market structure.
Analyze the provided stock using your training knowledge of its recent price history, institutional support levels, and technical indicators.
All values are estimates based on your training data — be transparent if the ticker is obscure.
Return ONLY a valid JSON object. No markdown fences, no explanation outside the JSON.

Schema:
{
  "trend": <"uptrend"|"downtrend"|"sideways">,
  "ma50_position": <"above"|"below">,
  "ma200_position": <"above"|"below">,
  "golden_cross_active": <boolean>,
  "rsi_estimate": <number 0-100>,
  "rsi_signal": <"oversold"|"neutral"|"overbought">,
  "macd_signal": <"bullish"|"bearish"|"neutral">,
  "momentum": <"strong_positive"|"positive"|"neutral"|"negative"|"strong_negative">,
  "estimated_support": <number, price level>,
  "estimated_resistance": <number, price level>,
  "volume_trend": <"accumulation"|"distribution"|"neutral">,
  "score": <integer 0-100, 100 = strongest buy signal on technicals alone>,
  "summary": <string, 2-3 sentences>
}`;

const MACRO_SYSTEM = `You are a macro strategist and qualitative analyst specializing in sector dynamics, supply chains, regulatory environments, and competitive positioning.
Analyze the provided stock considering the current macroeconomic backdrop (interest rates, AI capex supercycle, geopolitics, sector tailwinds/headwinds).
Return ONLY a valid JSON object. No markdown fences, no explanation outside the JSON.

Schema:
{
  "sector_tailwind": <"strong"|"moderate"|"neutral"|"headwind">,
  "macro_backdrop": <"favorable"|"neutral"|"unfavorable">,
  "rate_sensitivity": <"high"|"moderate"|"low">,
  "competitive_moat": <"wide"|"narrow"|"none">,
  "ai_capex_exposure": <"direct_beneficiary"|"indirect"|"unrelated">,
  "regulatory_risk": <"high"|"moderate"|"low">,
  "geopolitical_risk": <"high"|"moderate"|"low">,
  "supply_chain_risks": <string[], 1-3 items or []>,
  "sector_catalysts": <string[], 1-3 near-term catalysts>,
  "sentiment": <"bullish"|"neutral"|"bearish">,
  "score": <integer 0-100, 100 = strongest buy signal from macro/qual perspective>,
  "summary": <string, 2-3 sentences>
}`;

// Assembled from the three agents when Gemini's synthesis call is unavailable,
// so the analysis still returns a usable report instead of a hard error.
function buildFallbackReport({ ticker, verdict, weightedScore, fundamentals, technical, macro, reason }) {
  const risks = Array.isArray(fundamentals.key_risks) ? fundamentals.key_risks.slice(0, 5) : [];
  const riskLines = risks.length
    ? risks.map(r => `- ${r}`).join("\n")
    : "- Detailed synthesis was unavailable; see the agent scores above.";
  return `## Executive Summary
${ticker} scores ${weightedScore}/100 — a ${verdict} signal — based on the three agent analyses below. (AI synthesis was temporarily unavailable${reason ? ` — ${reason}` : ""}; this summary was auto-assembled from the agents.)

## Fundamental Analysis
${fundamentals.summary || "No summary returned."}

## Technical Analysis
${technical.summary || "No summary returned."}

## Macro & Qualitative Factors
${macro.summary || "No summary returned."}

## Key Risks
${riskLines}`;
}

// ── SYNTHESIZER ───────────────────────────────────────────────────────────────
async function synthesize(geminiKey, ticker, currentPrice, fundamentals, technical, macro) {
  const weightedScore =
    Math.round(fundamentals.score * 0.40 + technical.score * 0.30 + macro.score * 0.30);

  const verdict = weightedScore >= 65 ? "BUY" : weightedScore >= 45 ? "HOLD" : "SELL";

  // 3-year price projection (model-based heuristic, capped at reasonable ranges)
  const growthRate  = fundamentals.revenue_growth_3y_cagr ?? fundamentals.revenue_growth_yoy ?? 0.10;
  const macroMult   = macro.sector_tailwind === "strong" ? 1.15 : macro.sector_tailwind === "moderate" ? 1.05 : macro.sector_tailwind === "neutral" ? 1.0 : 0.90;
  const techMult    = technical.trend === "uptrend" ? 1.08 : technical.trend === "downtrend" ? 0.92 : 1.0;

  const bullMultiplier  = Math.pow(1 + growthRate * 1.6, 3) * macroMult * 1.1;
  const baseMultiplier  = Math.pow(1 + growthRate, 3) * macroMult;
  const bearMultiplier  = Math.pow(1 + growthRate * 0.25, 3) * (macro.macro_backdrop === "unfavorable" ? 0.80 : 0.90);

  const projection = {
    current: currentPrice,
    bull:    currentPrice ? parseFloat((currentPrice * bullMultiplier).toFixed(2)) : null,
    base:    currentPrice ? parseFloat((currentPrice * baseMultiplier).toFixed(2)) : null,
    bear:    currentPrice ? parseFloat((currentPrice * bearMultiplier).toFixed(2)) : null,
    assumptions: `Revenue CAGR: ${(growthRate * 100).toFixed(1)}% · Sector: ${macro.sector_tailwind} tailwind · Trend: ${technical.trend}`,
  };

  const synthPrompt = `You are synthesizing a multi-agent stock analysis into a clean, readable investment brief.
You will receive structured JSON from three analysts. Combine their insights into a concise markdown report.
Do not repeat the JSON. Write in flowing prose organized under the exact headers below.
Be direct — this is for sophisticated investors who want signal, not filler.

Return ONLY the markdown — no JSON, no fences, no preamble.

## Executive Summary
(3-4 sentences covering the core thesis and key factors driving the verdict)

## Fundamental Analysis
(4-6 sentences covering financial health, revenue trajectory, margins, capex strategy, valuation)

## Technical Analysis
(3-5 sentences covering trend, key levels, momentum indicators, near-term setup)

## Macro & Qualitative Factors
(4-5 sentences covering sector tailwinds, macro environment, competitive position, risks)

## Key Risks
(Bullet list of the 3-5 most critical risks to the thesis)

## 3-Year Price Projection Rationale
(2-3 sentences explaining the bull/base/bear scenario assumptions)

---
TICKER: ${ticker}
CURRENT PRICE: ${currentPrice ? "$" + currentPrice : "unknown"}
VERDICT: ${verdict} (Composite Score: ${weightedScore}/100)

FUNDAMENTALS JSON:
${JSON.stringify(fundamentals, null, 2)}

TECHNICAL JSON:
${JSON.stringify(technical, null, 2)}

MACRO JSON:
${JSON.stringify(macro, null, 2)}`;

  // Gemini's synthesis call occasionally returns 429/503/529 when overloaded —
  // the same transient statuses the agent calls already retry on. Retry with
  // backoff; if it still fails, fall back to an agent-assembled report so a
  // single hiccup doesn't sink the whole analysis with a hard error.
  let report = "";
  let reason = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, 1500 * Math.pow(2, attempt - 1))); // 1.5s, 3s
    }

    const synthController = new AbortController();
    const synthTimer = setTimeout(() => synthController.abort(), 25000);
    let synthRes;
    try {
      synthRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_SYNTH}:generateContent?key=${geminiKey}`,
        {
          method: "POST",
          signal: synthController.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: synthPrompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 3000 },
          }),
        }
      );
    } catch (e) {
      reason = e.name === "AbortError" ? "synthesis timed out" : "synthesis network error";
      continue; // transient — retry
    } finally {
      clearTimeout(synthTimer);
    }

    if (synthRes.status === 429 || synthRes.status === 503 || synthRes.status === 529) {
      reason = `Gemini ${synthRes.status}`;
      continue; // overloaded / rate limited — retry
    }
    if (!synthRes.ok) {
      reason = `Gemini ${synthRes.status}`;
      break; // non-transient — stop and use the fallback
    }

    const data = await synthRes.json();
    report = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "";
    if (report) break;
    reason = "empty synthesis response";
  }

  if (!report) {
    report = buildFallbackReport({ ticker, verdict, weightedScore, fundamentals, technical, macro, reason });
  }

  return { report, weightedScore, verdict, projection };
}

// ── REQUEST HANDLER ───────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;

  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin         = request.headers.get("Origin") || "";
  const corsOrigin     = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Cache-Control": "private, no-store",
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
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers });
  }

  const accessPayload = await getAccessPayload(request, env);
  const memberKey = accessPayload?.sub || accessPayload?.email?.toLowerCase();
  if (!memberKey) {
    return new Response(JSON.stringify({ error: "Authentication required" }), { status: 401, headers });
  }
  if (!isTrustedOrigin(request, env)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403, headers });
  }
  const email = accessPayload?.email?.toLowerCase();
  if (!isAnalyzeAllowedEmail(email, env)) {
    return new Response(
      JSON.stringify({ error: "Analysis access is not enabled for this account" }),
      { status: 403, headers }
    );
  }

  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "Request body too large" }), { status: 413, headers });
  }

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "Analysis service is not configured" }),
      { status: 500, headers }
    );
  }

  let rawBody;
  try {
    rawBody = await request.text();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers });
  }

  if (rawBody.length > MAX_BODY_BYTES || new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
    return new Response(JSON.stringify({ error: "Request body too large" }), { status: 413, headers });
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return new Response(JSON.stringify({ error: "JSON body must be an object" }), { status: 400, headers });
  }

  const ticker = typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "";
  if (!TICKER_PATTERN.test(ticker)) {
    return new Response(JSON.stringify({ error: "A valid ticker is required" }), { status: 400, headers });
  }

  const currentPrice = typeof body.currentPrice === "number" && Number.isFinite(body.currentPrice)
    ? body.currentPrice
    : null;
  const contextData  = {
    ticker,
    currentPrice,
    peRatio:    normalizeContextValue(body.peRatio),
    marketCap:  normalizeContextValue(body.marketCap),
    week52Low:  normalizeContextValue(body.week52Low),
    week52High: normalizeContextValue(body.week52High),
    sector:     normalizeContextValue(body.sector),
    industry:   normalizeContextValue(body.industry),
  };

  // ── KV Cache check ────────────────────────────────────────
  const cacheKey = CACHE_KEY_PREFIX + ticker;
  if (env.SHARED_DATA) {
    try {
      const cached = await env.SHARED_DATA.get(cacheKey, "json");
      if (cached?.generatedAt && Date.now() - cached.generatedAt < CACHE_TTL_SEC * 1000) {
        return new Response(JSON.stringify({ ...cached, fromCache: true }), { status: 200, headers });
      }
    } catch {}
  }

  // ── Build shared user prompt ──────────────────────────────
  // Cached reports are free to read, but each cache miss fans out to four
  // Gemini requests. Rate-limit misses by the verified Access member ID.
  if (!env.ANALYZE_RATE_LIMITER) {
    return new Response(
      JSON.stringify({ error: "Analysis service is temporarily unavailable" }),
      { status: 503, headers }
    );
  }

  try {
    const { success } = await env.ANALYZE_RATE_LIMITER.limit({ key: String(memberKey) });
    if (!success) {
      return new Response(
        JSON.stringify({ error: "Analysis limit reached. Try again in a minute." }),
        { status: 429, headers: { ...headers, "Retry-After": "60" } }
      );
    }
  } catch (err) {
    console.error("[analyze] rate limit error:", err);
    return new Response(
      JSON.stringify({ error: "Analysis service is temporarily unavailable" }),
      { status: 503, headers }
    );
  }

  const contextBlock = `TICKER: ${ticker}
CURRENT PRICE: ${currentPrice ? "$" + currentPrice : "unknown"}
P/E RATIO: ${contextData.peRatio}
MARKET CAP: ${contextData.marketCap}
52W LOW: ${contextData.week52Low}
52W HIGH: ${contextData.week52High}
SECTOR: ${contextData.sector}
INDUSTRY: ${contextData.industry}

Analyze ${ticker} based on the above data points and your training knowledge of this company.`;

  try {
    // ── Run 3 agents with staggered starts to avoid 429s ──
    const fundamentals = await callGemini(apiKey, FUNDAMENTALS_SYSTEM, contextBlock, 2048);
    await new Promise(r => setTimeout(r, 5000));
    const technical = await callGemini(apiKey, TECHNICAL_SYSTEM, contextBlock, 2048);
    await new Promise(r => setTimeout(r, 5000));
    const macro = await callGemini(apiKey, MACRO_SYSTEM, contextBlock, 2048);

    // ── Synthesize ────────────────────────────────────────
    const { report, weightedScore, verdict, projection } =
      await synthesize(apiKey, ticker, currentPrice, fundamentals, technical, macro);

    const result = {
      ticker,
      fundamentals,
      technical,
      macro,
      report,
      weightedScore,
      verdict,
      projection,
      model:       MODEL_AGENT,
      generatedAt: Date.now(),
      disclaimer:  "AI-generated analysis based on training data through August 2025. Not financial advice. Always conduct your own due diligence.",
    };

    // ── Cache result ──────────────────────────────────────
    if (env.SHARED_DATA) {
      try {
        await env.SHARED_DATA.put(cacheKey, JSON.stringify(result), { expirationTtl: CACHE_TTL_SEC });
      } catch {}
    }

    return new Response(JSON.stringify({ ...result, fromCache: false }), { status: 200, headers });

  } catch (err) {
    console.error("[analyze] error:", err.message);
    return new Response(
      JSON.stringify({ error: "Analysis failed", detail: err.message }),
      { status: 502, headers }
    );
  }
}
