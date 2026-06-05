// functions/analyze.js
//
// POST /analyze  { ticker, currentPrice, peRatio, marketCap, week52Low, week52High }
// Runs 3 Gemini agents concurrently (Fundamentals · Technical · Qual/Macro),
// then synthesizes into a markdown report with a BUY/HOLD/SELL score and
// 3-year price projection.  Results cached in KV for 24 hours.

const CACHE_KEY_PREFIX = "analysis_v2_";
const CACHE_TTL_SEC    = 24 * 60 * 60;
const MODEL            = "gemini-2.0-flash";

// ── GEMINI HELPER ─────────────────────────────────────────────────────────────
async function callGemini(apiKey, systemPrompt, userContent, maxTokens = 900) {
  const prompt = `${systemPrompt}\n\n${userContent}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: maxTokens },
      }),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini ${res.status}: ${body.slice(0, 200)}`);
  }

  const data    = await res.json();
  const rawText = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "";
  const clean   = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  return JSON.parse(clean);
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

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: synthPrompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 1400 },
      }),
    }
  );

  if (!res.ok) throw new Error(`Synthesis API error ${res.status}`);
  const data = await res.json();
  const report = data?.candidates?.[0]?.content?.parts?.map(p => p.text).join("") ?? "";

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

  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "GEMINI_API_KEY not configured. Add it as a Cloudflare Pages environment variable." }),
      { status: 500, headers }
    );
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400, headers });
  }

  const ticker = (typeof body.ticker === "string" ? body.ticker.trim().toUpperCase() : "").replace(/[^A-Z0-9.\-^]/g, "").slice(0, 10);
  if (!ticker) {
    return new Response(JSON.stringify({ error: "ticker is required" }), { status: 400, headers });
  }

  const currentPrice = typeof body.currentPrice === "number" ? body.currentPrice : null;
  const contextData  = {
    ticker,
    currentPrice,
    peRatio:    body.peRatio    ?? "unknown",
    marketCap:  body.marketCap  ?? "unknown",
    week52Low:  body.week52Low  ?? "unknown",
    week52High: body.week52High ?? "unknown",
    sector:     body.sector     ?? "unknown",
    industry:   body.industry   ?? "unknown",
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
    // ── Run 3 agents concurrently ─────────────────────────
    const [fundamentals, technical, macro] = await Promise.all([
      callGemini(apiKey, FUNDAMENTALS_SYSTEM, contextBlock, 900),
      callGemini(apiKey, TECHNICAL_SYSTEM,    contextBlock, 800),
      callGemini(apiKey, MACRO_SYSTEM,        contextBlock, 800),
    ]);

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
      model:       MODEL,
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
    return new Response(
      JSON.stringify({ error: "Analysis failed", detail: err.message }),
      { status: 502, headers }
    );
  }
}
