// functions/capex-intel.js
//
// Dynamically queries Google Gemini to get the latest publicly-announced
// hyperscaler AI capex allocations across the 6 infrastructure sectors.
// Results are cached in Cloudflare KV for 6 hours to avoid hammering the API.
//
// GET  /capex-intel   → returns cached or freshly-fetched intel
// POST /capex-intel   → admin-only force-refresh (busts the cache)

const CACHE_KEY = "capexIntel";

// Combined TOTAL capex across the five hyperscalers below which a reading is
// treated as a stale prior-year answer rather than current guidance. See the
// staleness tripwire in the handler.
const STALE_TOTAL_FLOOR = 400;
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours in ms
const MODEL     = "gemini-2.5-flash";

const SECTORS = [
  {
    id:          "compute",
    label:       "Compute & Silicon",
    description: "GPU/AI accelerators (NVDA, AMD), memory & HBM (MU, WDC), custom ASICs/TPUs (AVGO, MRVL), leading-edge foundry (TSM), semiconductor equipment (AMAT, LRCX, ASML), advanced packaging",
  },
  {
    id:          "networking",
    label:       "Networking & Connectivity",
    description: "Ethernet switching (ANET, CSCO), optical transceivers 400G/800G (LITE, COHR), cables & connectors, cybersecurity infrastructure (PANW, CRWD)",
  },
  {
    id:          "photonics",
    label:       "Photonics & Interconnects",
    description: "Optical engines, InP substrate & epiwafers, epitaxy equipment (VECO), silicon photonics foundry, high-speed interconnects",
  },
  {
    id:          "neoclouds",
    label:       "Neoclouds & Data Centers",
    description: "Hyperscale REIT construction (EQIX, DLR), GPU cloud operators / neoclouds (CoreWeave, IREN, APLD), AI server infrastructure (SMCI, VRT), MEP contractors (FIX, EME, MTZ)",
  },
  {
    id:          "power",
    label:       "Power & Cooling",
    description: "Power generation & utilities (VST, NEE, BE), nuclear (OKLO, SMR), UPS/power management (ETN, VRT), liquid & immersion cooling",
  },
  {
    id:          "frontier",
    label:       "Frontier / Speculative",
    description: "Quantum computing, neuromorphic AI, space (RKLB, ASTS), SaaS platforms (PLTR, SNOW, NOW), robotics, precious metals hedge",
  },
];

// --- PROMPT 1: Determine total + per-company capex (search-grounded) ---
// This call runs with Google Search grounding so the numbers track the LATEST
// guidance revisions and news, not the model's training data.
function buildPrompt1() {
  return `You are a financial analyst specializing in AI infrastructure capital expenditure.

Search for the most recent capex guidance, earnings-call statements, and credible reporting for the five primary hyperscalers: Amazon (AWS), Microsoft (Azure), Alphabet/Google, Meta, and Oracle.

RECENCY IS MANDATORY. Report the CURRENT fiscal-year (2026) guidance as most recently revised —
not a prior-year actual. Hyperscaler capex has grown several-fold since 2023, so a figure that
looks like a 2022-2024 actual is wrong for this question. As calibration: each of these companies
now guides annual TOTAL capex in the high tens to low hundreds of billions. If your total-capex
figure for Amazon, Microsoft, Alphabet or Meta is below $80B, you are almost certainly quoting a
historical year — search again for the latest guidance and use that instead.

For EACH company, report two distinct figures for its current fiscal year (2026-era guidance):
  1. totalCapex — the company's total announced/guided capital expenditure.
  2. aiCapex — ONLY the portion attributable to AI infrastructure.

CRITICAL — these are not the same number, and aiCapex must be strictly LESS than totalCapex for
every company. Total capex includes large non-AI investment: fulfillment centres, warehouses and
logistics, offices and real estate, retail, vehicles, consumer devices, content, and general
non-AI network build. aiCapex counts only AI/ML infrastructure: AI servers and accelerators, the
datacentre shells and power/cooling capacity built to house them, and AI-specific networking.

Where a company does not disclose the split, estimate the AI-attributable share from management
commentary rather than assuming all datacentre spend is AI, and say what share you applied. Do NOT
report a company's headline total capex in the aiCapex field — that is the most common error and
it materially overstates the figure.

Use the most recently reported or revised numbers you can find, preferring company guidance over
third-party estimates.

Respond with ONLY a valid JSON object — no markdown fences, no preamble, no explanation outside the JSON:

{
  "totalCapexBillions": <integer, the sum of the five aiCapex values>,
  "byCompany": {
    "AMZN": <integer billions, AI-attributable only>,
    "MSFT": <integer billions, AI-attributable only>,
    "GOOG": <integer billions, AI-attributable only>,
    "META": <integer billions, AI-attributable only>,
    "ORCL": <integer billions, AI-attributable only>
  },
  "byCompanyTotalCapex": {
    "AMZN": <integer billions, total capex>,
    "MSFT": <integer billions, total capex>,
    "GOOG": <integer billions, total capex>,
    "META": <integer billions, total capex>,
    "ORCL": <integer billions, total capex>
  },
  "fiscalYear": "<the fiscal year these figures cover, e.g. 2026>",
  "aiShareNote": "<one sentence: how the AI-attributable share was derived, and the share applied>"
}`;
}

// --- PROMPT 2: Allocate the dynamic total across sectors ---
function buildPrompt2(totalCapex) {
  return `You are a financial analyst specializing in AI infrastructure capital expenditure.

The five primary hyperscalers (Amazon, Microsoft, Alphabet, Meta, Oracle) have collectively announced roughly $${totalCapex} billion in AI-related capex for 2025-2026.

Based on your knowledge of their public guidance and capital allocation priorities, estimate how this $${totalCapex} billion total spend flows across the following six infrastructure sectors.

Sectors to allocate:
${SECTORS.map(s => `• ${s.id} — "${s.label}": ${s.description}`).join("\n")}

Guidelines:
- The six sectors MUST sum to exactly ${totalCapex}.
- "Compute & Silicon" (chips + foundry + equipment) typically absorbs the largest share (~25-35%).
- "Neoclouds & Data Centers" (physical build-out) is the second-largest (~18-22%).
- Use your best estimate for sectors where direct figures are unavailable, flagging confidence accordingly.
- Include a one-sentence rationale citing the basis for each sector's allocation.

Respond with ONLY a valid JSON array — no markdown fences, no preamble, no explanation outside the JSON:

[
  {
    "id": "compute",
    "capex": <integer, billions USD>,
    "value": "<display string e.g. ~$185B>",
    "rationale": "<one sentence explaining the basis for this allocation>",
    "confidence": "high|medium|low"
  },
  ...six objects total...
]`;
}

// Helper to execute Gemini API requests.
// `grounded: true` attaches the Google Search tool — required for prompt 1 so
// the totals reflect this week's guidance, not training-data memory. Search
// grounding is incompatible with JSON response mode, so we always parse from
// text with fence-stripping. Thinking is disabled: its tokens count against
// maxOutputTokens and can truncate the JSON mid-string.
async function callGemini(promptText, apiKey, temperature, maxTokens, timeoutMs = 15000, grounded = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method:  "POST",
        signal:  controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          ...(grounded ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: {
            temperature: temperature,
            maxOutputTokens: maxTokens,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const textContent = data?.candidates?.[0]?.content?.parts
      ?.filter(p => p.text)
      ?.map(p => p.text)
      ?.join("") ?? "";

    if (!textContent) throw new Error("Empty response from Gemini");

    const clean = textContent.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(clean);

  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
    throw err;
  }
}

const COMPANY_IDS = ["AMZN", "MSFT", "GOOG", "META", "ORCL"];

function validateByCompany(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const id of COMPANY_IDS) {
    const v = Number(raw[id]);
    if (!Number.isFinite(v) || v <= 0 || v > 500) return null; // any bad value voids the split
    out[id] = Math.round(v);
  }
  return out;
}

// Append each FRESH intel reading to Neon so guidance becomes a time series
// (served by GET /capex-history). Failures are non-fatal — history is a
// nice-to-have, the live response must not break on a DB hiccup.
async function persistHistory(env, result) {
  if (!env.DATABASE_URL) return;
  try {
    const host = new URL(
      env.DATABASE_URL.replace("postgresql://", "https://").replace("postgres://", "https://")
    ).hostname;
    const sql = (query, params = []) =>
      fetch(`https://${host}/sql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Neon-Connection-String": env.DATABASE_URL,
        },
        body: JSON.stringify({ query, params }),
      });

    await sql(`
      CREATE TABLE IF NOT EXISTS capex_intel_history (
        fetched_at  TIMESTAMPTZ DEFAULT now(),
        total_capex INTEGER NOT NULL,
        by_company  JSONB,
        allocations JSONB,
        model       TEXT
      )
    `);
    await sql(
      `INSERT INTO capex_intel_history (total_capex, by_company, allocations, model)
       VALUES ($1, $2, $3, $4)`,
      [
        result.totalCapexDerived,
        JSON.stringify(result.byCompany),
        JSON.stringify(result.allocations),
        result.model,
      ]
    );
  } catch (err) {
    console.warn("capex history persist failed", err);
  }
}

function validateAllocations(allocations, totalCapex) {
  if (!Array.isArray(allocations)) {
    throw new Error("Expected allocations to be a JSON array");
  }

  const validIds = new Set(SECTORS.map(s => s.id));
  const seenIds = new Set();
  const cleaned = [];

  for (const allocation of allocations) {
    if (!allocation || typeof allocation !== "object") continue;
    if (!validIds.has(allocation.id)) continue;
    if (seenIds.has(allocation.id)) {
      throw new Error(`Duplicate sector returned: ${allocation.id}`);
    }

    const capex = Number(allocation.capex);
    if (!Number.isFinite(capex) || capex < 0) {
      throw new Error(`Invalid capex for sector: ${allocation.id}`);
    }

    seenIds.add(allocation.id);
    cleaned.push({
      ...allocation,
      capex,
      value: allocation.value || `~$${capex}B`,
    });
  }

  if (cleaned.length !== SECTORS.length) {
    throw new Error(`Expected ${SECTORS.length} sectors, received ${cleaned.length}`);
  }

  const missingIds = SECTORS
    .map(sector => sector.id)
    .filter(id => !seenIds.has(id));

  if (missingIds.length > 0) {
    throw new Error(`Missing sectors: ${missingIds.join(", ")}`);
  }

  const totalAllocated = cleaned.reduce((sum, allocation) => sum + allocation.capex, 0);
  const delta = Math.abs(totalAllocated - totalCapex);
  if (delta > 1) {
    throw new Error(`Sector capex total ${totalAllocated} does not reconcile to ${totalCapex}`);
  }

  if (delta > 0) {
    const largestIndex = cleaned.reduce(
      (bestIdx, allocation, idx, arr) => allocation.capex > arr[bestIdx].capex ? idx : bestIdx,
      0
    );
    cleaned[largestIndex] = {
      ...cleaned[largestIndex],
      capex: cleaned[largestIndex].capex + (totalCapex - totalAllocated),
      value: `~$${cleaned[largestIndex].capex + (totalCapex - totalAllocated)}B`,
    };
  }

  return cleaned;
}

import { isAdminRequest } from "./access-lib.js";

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
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  // ── POST: admin-only cache-bust ───────────────────────────────────────────
  if (request.method === "POST") {
    try {
      const body = await request.json();
      const adminPassword = env.ADMIN_PASSWORD;
      if ((!adminPassword || body.password !== adminPassword) && !(await isAdminRequest(request, env))) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }
      if (env.SHARED_DATA) await env.SHARED_DATA.delete(CACHE_KEY);
      return new Response(JSON.stringify({ success: true, message: "Cache cleared — next GET will fetch live intel." }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  // ── GET: serve from cache or fetch fresh ─────────────────────────────────
  if (request.method === "GET") {
    try {
      // 1. Try KV cache first
      if (env.SHARED_DATA) {
        const cached = await env.SHARED_DATA.get(CACHE_KEY, "json");
        if (cached?.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return new Response(JSON.stringify({ ...cached, fromCache: true }), { status: 200, headers });
        }
      }

      // 2. Cache miss — Call Gemini
      const geminiKey = env.GEMINI_API_KEY;
      if (!geminiKey) {
        return new Response(
          JSON.stringify({ error: "GEMINI_API_KEY not set. Add it as a Cloudflare Pages environment variable." }),
          { status: 500, headers }
        );
      }

      let totalCapex = null;
      let byCompany  = null;
      let byCompanyTotalCapex = null;
      let aiShareNote = null;

      // STEP 2A: Execute Prompt 1 (search-grounded total + per-company split)
      try {
        const totalResult = await callGemini(buildPrompt1(), geminiKey, 0.1, 1024, 25000, true);
        byCompany = validateByCompany(totalResult?.byCompany);
        byCompanyTotalCapex = validateByCompany(totalResult?.byCompanyTotalCapex);
        aiShareNote = typeof totalResult?.aiShareNote === "string" ? totalResult.aiShareNote : null;

        // Guard: the model's classic failure here is reporting each company's
        // HEADLINE capex in the AI field — which inflates a number the UI labels
        // "AI capex". AI-attributable spend must be strictly below the company's
        // own total; if it isn't, the split is conflated and we discard it
        // rather than publish an overstated figure.
        if (byCompany && byCompanyTotalCapex) {
          const conflated = COMPANY_IDS.filter(id => byCompany[id] >= byCompanyTotalCapex[id]);
          if (conflated.length) {
            console.warn("capex-intel: AI capex conflated with total capex for",
              conflated.join(", "), "— discarding this reading");
            byCompany = null;
          }
        }

        // Staleness tripwire. The opposite failure to conflation: the model
        // answers with a prior-year actual instead of current guidance (a 2023
        // reading lands near $200B across the five, versus the ~$700B+ these
        // companies now guide). This is a floor for detecting obviously-stale
        // data, NOT a target — a genuine reading well above it is untouched.
        if (byCompany && byCompanyTotalCapex) {
          const totalSum = Object.values(byCompanyTotalCapex).reduce((s, v) => s + v, 0);
          if (totalSum < STALE_TOTAL_FLOOR) {
            console.warn("capex-intel: total capex sum", totalSum,
              "is below the staleness floor", STALE_TOTAL_FLOOR, "— discarding this reading");
            byCompany = null;
          }
        }

        if (byCompany) {
          // The per-company sum is the most defensible total
          totalCapex = Object.values(byCompany).reduce((s, v) => s + v, 0);
        } else if (!byCompanyTotalCapex && totalResult && typeof totalResult.totalCapexBillions === "number") {
          // No per-company detail to cross-check against — accept the headline.
          totalCapex = totalResult.totalCapexBillions;
        }
      } catch (prompt1Err) {
        console.warn("capex-intel: prompt 1 failed", prompt1Err);
      }

      // No trustworthy AI-attributable total → serve an error instead of a
      // fabricated one. Both surfaces fall back to the curated map values,
      // which are conservative and clearly labelled as estimates.
      if (!totalCapex || totalCapex <= 0) {
        return new Response(
          JSON.stringify({
            error: "Could not establish an AI-attributable capex total",
            detail: "The grounded reading was missing or conflated AI capex with total capex.",
          }),
          { status: 502, headers: { ...headers, "Cache-Control": "no-store" } }
        );
      }

      // STEP 2B: Execute Prompt 2 (Get Allocations based on dynamic total)
      let allocations;
      try {
        allocations = await callGemini(buildPrompt2(totalCapex), geminiKey, 0.2, 1500);
        allocations = validateAllocations(allocations, totalCapex);
      } catch (prompt2Err) {
        return new Response(
          JSON.stringify({ error: "Failed to gather allocations", detail: prompt2Err.message }),
          { status: 502, headers }
        );
      }

      const result = {
        totalCapexDerived: totalCapex, // Returning this so you can inspect what the model decided
        byCompany,
        byCompanyTotalCapex, // headline capex per company — the audit trail for the AI split
        aiShareNote,
        allocations,
        fetchedAt: Date.now(),
        model:     MODEL,
        note:      "Search-grounded AI-ATTRIBUTABLE capex per hyperscaler (the AI portion of total capex, not total capex); sector allocations derived from Gemini based on public filings and earnings calls.",
      };

      // 3. Persist to KV for 6 hours + append to the guidance-history table
      if (env.SHARED_DATA) {
        await env.SHARED_DATA.put(CACHE_KEY, JSON.stringify(result));
      }
      await persistHistory(env, result);

      return new Response(JSON.stringify({ ...result, fromCache: false }), { status: 200, headers });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers });
}
