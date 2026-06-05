// functions/capex-intel.js
//
// Dynamically queries Google Gemini to get the latest publicly-announced
// hyperscaler AI capex allocations across the 6 infrastructure sectors.
// Results are cached in Cloudflare KV for 6 hours to avoid hammering the API.
//
// GET  /capex-intel   → returns cached or freshly-fetched intel
// POST /capex-intel   → admin-only force-refresh (busts the cache)

const CACHE_KEY = "capexIntel";
const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours in ms
const MODEL     = "gemini-3.5-flash";

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

// --- PROMPT 1: Determine the total capex spending ---
function buildPrompt1() {
  return `You are a financial analyst specializing in AI infrastructure capital expenditure.

Analyze the most recent public guidance, earnings calls, investor-day presentations, and SEC filings for the five primary hyperscalers: Amazon (AWS), Microsoft (Azure), Alphabet/Google, Meta, and Oracle.

Determine their collective announced or estimated AI-related capex for 2025-2026. Previously this was roughly $600 billion. 

Respond with ONLY a valid JSON object containing the total estimated amount in billions of USD. No markdown fences, no preamble, no explanation outside the JSON:

{
  "totalCapexBillions": <integer>
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

// Helper to execute Gemini API requests
async function callGemini(promptText, apiKey, temperature, maxTokens, timeoutMs = 15000) {
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
          generationConfig: {
            temperature: temperature,
            maxOutputTokens: maxTokens,
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
      if (!adminPassword || body.password !== adminPassword) {
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

      let totalCapex = 600; // Default fallback just in case the first prompt fails structurally

      // STEP 2A: Execute Prompt 1 (Get Total Capex)
      try {
        const totalResult = await callGemini(buildPrompt1(), geminiKey, 0.1, 100);
        if (totalResult && typeof totalResult.totalCapexBillions === 'number') {
          totalCapex = totalResult.totalCapexBillions;
        }
      } catch (prompt1Err) {
        console.warn("Prompt 1 failed, proceeding with default $600B total.", prompt1Err);
        // We will swallow this error and allow Prompt 2 to execute with the $600B fallback
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
        allocations,
        fetchedAt: Date.now(),
        model:     MODEL,
        note:      "Allocations derived from Gemini based on public hyperscaler filings and earnings calls.",
      };

      // 3. Persist to KV for 6 hours
      if (env.SHARED_DATA) {
        await env.SHARED_DATA.put(CACHE_KEY, JSON.stringify(result));
      }

      return new Response(JSON.stringify({ ...result, fromCache: false }), { status: 200, headers });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers });
}
