// functions/musk-intel.js
//
// Search-grounded capex intel for the Musk Galaxy view — same pattern as
// /capex-intel: Gemini with Google Search estimates per-company capex for
// Musk's companies and allocates it across the Musk tracks. Cached in KV
// for 6 hours; admin POST busts the cache.

const CACHE_KEY = "muskIntel";
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MODEL     = "gemini-2.5-flash";

const COMPANY_IDS = ["TSLA", "SPACEX", "XAI", "STARLINK", "BORING", "NEURALINK"];

const SECTORS = [
  { id: "ai",       label: "AI & Compute",            description: "xAI Colossus GPU clusters, Dojo, the planned Terafab chip fab project" },
  { id: "vehicles", label: "Vehicles & Autonomy",     description: "Tesla vehicle factories, FSD/autonomy compute, robotaxi build-out" },
  { id: "space",    label: "Launch & Starlink",       description: "Starship/Falcon production and launch infrastructure, Starlink satellite constellation" },
  { id: "energy",   label: "Energy & Storage",        description: "Megapack factories, energy storage deployment, charging network" },
  { id: "infra",    label: "Build-out, Power & Tunnels", description: "Datacenter/factory construction, site power generation, Boring Company tunnels" },
  { id: "frontier", label: "Neuralink & Robotics",    description: "Neuralink clinical/manufacturing, Optimus robot production lines" },
];

function buildPrompt1() {
  return `You are a financial analyst covering Elon Musk's companies.

Search for the most recent reported or credibly estimated CAPITAL EXPENDITURE (not valuation) for the current year across Musk's companies: Tesla (TSLA guidance), SpaceX (Starship + launch infrastructure), Starlink (satellite constellation build), xAI (Colossus datacenters, GPU purchases), The Boring Company, and Neuralink. Include the Terafab chip fab project spend under xAI if attributed there.

Respond with ONLY a valid JSON object — no markdown fences, no preamble:

{
  "totalCapexBillions": <integer, sum of the six>,
  "byCompany": {
    "TSLA": <integer billions>,
    "SPACEX": <integer billions>,
    "XAI": <integer billions>,
    "STARLINK": <integer billions>,
    "BORING": <integer billions>,
    "NEURALINK": <integer billions>
  }
}`;
}

function buildPrompt2(totalCapex) {
  return `Elon Musk's companies are collectively spending roughly $${totalCapex} billion in capex this year.

Allocate this total across the following infrastructure sectors based on what is publicly known about their spending priorities:

${SECTORS.map(s => `• ${s.id} — "${s.label}": ${s.description}`).join("\n")}

Guidelines:
- The six sectors MUST sum to exactly ${totalCapex}.
- Include a one-sentence rationale per sector.

Respond with ONLY a valid JSON array — no markdown fences, no preamble:

[
  { "id": "ai", "capex": <integer billions>, "value": "<e.g. ~$25B>", "rationale": "<one sentence>", "confidence": "high|medium|low" },
  ...six objects total...
]`;
}

async function callGemini(promptText, apiKey, temperature, maxTokens, timeoutMs = 25000, grounded = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        signal: controller.signal,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }],
          ...(grounded ? { tools: [{ google_search: {} }] } : {}),
          generationConfig: {
            temperature,
            maxOutputTokens: maxTokens,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join("") ?? "";
    if (!text) throw new Error("Empty response from Gemini");
    const clean = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const m = clean.match(/[\[{][\s\S]*[\]}]/);
    return JSON.parse(m ? m[0] : clean);
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
    throw err;
  }
}

function validateByCompany(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const id of COMPANY_IDS) {
    const v = Number(raw[id]);
    if (!Number.isFinite(v) || v < 0 || v > 200) return null;
    out[id] = Math.round(v);
  }
  return out;
}

function validateAllocations(allocations, totalCapex) {
  if (!Array.isArray(allocations)) throw new Error("Expected a JSON array");
  const validIds = new Set(SECTORS.map(s => s.id));
  const cleaned = [];
  const seen = new Set();
  for (const a of allocations) {
    if (!a || typeof a !== "object" || !validIds.has(a.id) || seen.has(a.id)) continue;
    const capex = Number(a.capex);
    if (!Number.isFinite(capex) || capex < 0) continue;
    seen.add(a.id);
    cleaned.push({ ...a, capex, value: a.value || `~$${capex}B` });
  }
  if (cleaned.length !== SECTORS.length) {
    throw new Error(`Expected ${SECTORS.length} sectors, received ${cleaned.length}`);
  }
  const total = cleaned.reduce((s, a) => s + a.capex, 0);
  const delta = totalCapex - total;
  if (Math.abs(delta) > 1) throw new Error(`Allocations sum ${total} != ${totalCapex}`);
  if (delta !== 0) {
    const i = cleaned.reduce((b, a, idx, arr) => a.capex > arr[b].capex ? idx : b, 0);
    cleaned[i] = { ...cleaned[i], capex: cleaned[i].capex + delta, value: `~$${cleaned[i].capex + delta}B` };
  }
  return cleaned;
}

export async function onRequest(context) {
  const { request, env } = context;

  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

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

  if (request.method === "POST") {
    try {
      const body = await request.json();
      if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }
      if (env.SHARED_DATA) await env.SHARED_DATA.delete(CACHE_KEY);
      return new Response(JSON.stringify({ success: true, message: "Cache cleared." }), { status: 200, headers });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500, headers });
    }
  }

  if (request.method === "GET") {
    try {
      if (env.SHARED_DATA) {
        const cached = await env.SHARED_DATA.get(CACHE_KEY, "json");
        if (cached?.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return new Response(JSON.stringify({ ...cached, fromCache: true }), { status: 200, headers });
        }
      }

      const geminiKey = env.GEMINI_API_KEY;
      if (!geminiKey) {
        return new Response(JSON.stringify({ error: "GEMINI_API_KEY not set." }), { status: 500, headers });
      }

      let totalCapex = 60; // conservative fallback
      let byCompany  = null;
      try {
        const totalResult = await callGemini(buildPrompt1(), geminiKey, 0.1, 1024, 25000, true);
        byCompany = validateByCompany(totalResult?.byCompany);
        if (byCompany) {
          totalCapex = Object.values(byCompany).reduce((s, v) => s + v, 0);
        } else if (typeof totalResult?.totalCapexBillions === "number") {
          totalCapex = totalResult.totalCapexBillions;
        }
      } catch (err) {
        console.warn("musk-intel prompt 1 failed, using fallback total", err);
      }

      let allocations;
      try {
        allocations = validateAllocations(
          await callGemini(buildPrompt2(totalCapex), geminiKey, 0.2, 1500),
          totalCapex
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: "Failed to gather allocations", detail: err.message }), { status: 502, headers });
      }

      const result = {
        totalCapexDerived: totalCapex,
        byCompany,
        allocations,
        fetchedAt: Date.now(),
        model: MODEL,
        note: "Search-grounded Musk-company capex estimates; private-company figures are public reporting, not filings.",
      };

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
