// functions/robotics-intel.js
//
// Search-grounded investment intel for the Robotics view — same pattern as
// /capex-intel and /musk-intel. Gemini estimates total humanoid-robot
// investment/spend and allocates it across the component tracks, weighted by
// bill-of-materials content value (Goldman: precision motion and dexterous
// modules carry the highest BOM share). Cached 6h; admin POST busts the cache.

const CACHE_KEY = "roboticsIntel";
const CACHE_TTL = 6 * 60 * 60 * 1000;
const MODEL     = "gemini-3.5-flash-lite";

const COMPANY_IDS = ["TSLA", "FIGURE", "AGILITY", "UNITREE", "ONEX", "XPEV", "BYD"];

const SECTORS = [
  { id: "brain",     label: "Brain & Edge AI",          description: "foundation models, on-device compute (NVIDIA GR00T/Jetson, Qualcomm), edge AI inference (Ambarella, Lattice, Ceva)" },
  { id: "sensors",   label: "Sensors & Perception",     description: "vision/LiDAR (Ouster, Cognex, Hesai), force/torque/position sensing (Allegro, Vishay Precision, Novanta)" },
  { id: "motors",    label: "Motors & Motion",          description: "coreless/frameless motors and drives (Nidec, AMETEK, Regal Rexnord), precision bearings (RBC)" },
  { id: "joints",    label: "Joints & Precision Motion", description: "harmonic/strain-wave gears (Harmonic Drive), planetary roller screws and linear motion (THK, Allient) — the supply bottleneck" },
  { id: "power",     label: "Power Electronics",        description: "GaN/SiC power (Navitas, Wolfspeed, onsemi), motor-control MCUs and conversion (TI, STMicro, Monolithic, Infineon, Renesas)" },
  { id: "materials", label: "Rare Earth & Energy",      description: "rare-earth magnets and mining (MP Materials, USA Rare Earth, Lynas, Energy Fuels), batteries (EnerSys)" },
];

function buildPrompt1() {
  return `You are an analyst covering the humanoid-robot supply chain.

Search for the most recent estimates of total annual INVESTMENT / capital spend flowing into the humanoid-robot buildout this year across the leading makers: Tesla (Optimus), Figure AI, Agility Robotics, Unitree, 1X, XPeng (Iron), and BYD. Include component procurement, factory tooling, and R&D where reported.

This is an early, pre-revenue market — use best public estimates. Respond with ONLY a valid JSON object — no markdown fences, no preamble:

{
  "totalCapexBillions": <integer, sum of the seven>,
  "byCompany": {
    "TSLA": <integer billions>,
    "FIGURE": <integer billions>,
    "AGILITY": <integer billions>,
    "UNITREE": <integer billions>,
    "ONEX": <integer billions>,
    "XPEV": <integer billions>,
    "BYD": <integer billions>
  }
}`;
}

function buildPrompt2(totalCapex) {
  return `The humanoid-robot makers are collectively investing roughly $${totalCapex} billion this year.

Allocate this total across the following component categories, weighted by bill-of-materials content value (Goldman Sachs: harmonic reduction gears, dexterous-hand and actuator modules carry the highest BOM content value; brain/sensors are meaningful; raw power electronics and materials are lower content):

${SECTORS.map(s => `• ${s.id} — "${s.label}": ${s.description}`).join("\n")}

Guidelines:
- The six categories MUST sum to exactly ${totalCapex}.
- "Joints & Precision Motion" and "Motors & Motion" typically carry the largest content value.
- Include a one-sentence rationale per category.

Respond with ONLY a valid JSON array — no markdown fences, no preamble:

[
  { "id": "brain", "capex": <integer billions>, "value": "<e.g. ~$8B>", "rationale": "<one sentence>", "confidence": "high|medium|low" },
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
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join("") ?? "";
    if (!text) throw new Error("Empty response from Gemini");
    const clean = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    const m = clean.match(/[\[{][\s\S]*[\]}]/);
    return JSON.parse(m ? m[0] : clean);
  } catch (err) {
    if (controller.signal.aborted) throw new Error(`Gemini request timed out after ${timeoutMs}ms`);
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

function validateByCompany(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const id of COMPANY_IDS) {
    const v = Number(raw[id]);
    if (!Number.isFinite(v) || v < 0 || v > 100) return null;
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
  if (cleaned.length !== SECTORS.length) throw new Error(`Expected ${SECTORS.length} sectors, received ${cleaned.length}`);
  const total = cleaned.reduce((s, a) => s + a.capex, 0);
  const delta = totalCapex - total;
  if (Math.abs(delta) > 1) throw new Error(`Allocations sum ${total} != ${totalCapex}`);
  if (delta !== 0) {
    const i = cleaned.reduce((b, a, idx, arr) => a.capex > arr[b].capex ? idx : b, 0);
    cleaned[i] = { ...cleaned[i], capex: cleaned[i].capex + delta, value: `~$${cleaned[i].capex + delta}B` };
  }
  return cleaned;
}

import { isAuthorizedAdmin } from "./access-lib.js";
import {
  IntelRefreshError,
  intelErrorResponse,
  invalidateIntelCoordinated,
  refreshIntelCoordinated,
  refreshIntelInBackground,
} from "./operation-coordinator.js";

export async function refreshRoboticsIntel(env, { force = false } = {}) {
  if (!force && env.SHARED_DATA) {
    const cached = await env.SHARED_DATA.get(CACHE_KEY, "json");
    if (cached?.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL) {
      return cached;
    }
  }

  const geminiKey = env.GEMINI_API_KEY;
  if (!geminiKey) {
    throw new IntelRefreshError(500, { error: "GEMINI_API_KEY not set." });
  }

  let totalCapex = 40;
  let byCompany = null;
  try {
    const totalResult = await callGemini(buildPrompt1(), geminiKey, 0.1, 1024, 25000, true);
    byCompany = validateByCompany(totalResult?.byCompany);
    if (byCompany) {
      totalCapex = Object.values(byCompany).reduce((sum, value) => sum + value, 0);
    } else if (typeof totalResult?.totalCapexBillions === "number") {
      totalCapex = totalResult.totalCapexBillions;
    }
  } catch (error) {
    console.warn("robotics-intel prompt 1 failed, using fallback total", error);
  }

  let allocations;
  try {
    allocations = validateAllocations(
      await callGemini(buildPrompt2(totalCapex), geminiKey, 0.2, 1500),
      totalCapex
    );
  } catch (error) {
    throw new IntelRefreshError(502, {
      error: "Failed to gather allocations",
      detail: error.message,
    });
  }

  const result = {
    totalCapexDerived: totalCapex,
    byCompany,
    allocations,
    fetchedAt: Date.now(),
    model: MODEL,
    note: "Search-grounded humanoid-robot investment estimates; an early market, figures are approximate and largely from public reporting, not filings.",
  };

  if (env.SHARED_DATA) {
    await env.SHARED_DATA.put(CACHE_KEY, JSON.stringify(result));
  }
  return result;
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
      if (!(await isAuthorizedAdmin(request, env, body.password))) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers });
      }
      await invalidateIntelCoordinated(env, "robotics");
      return new Response(JSON.stringify({ success: true, message: "Cache cleared." }), { status: 200, headers });
    } catch (err) {
      return intelErrorResponse(err, headers);
    }
  }

  if (request.method === "GET") {
    try {
      let cached = null;
      if (env.SHARED_DATA) {
        cached = await env.SHARED_DATA.get(CACHE_KEY, "json");
        if (cached?.fetchedAt && Date.now() - cached.fetchedAt < CACHE_TTL) {
          return new Response(JSON.stringify({ ...cached, fromCache: true }), { status: 200, headers });
        }
      }

      if (cached) {
        refreshIntelInBackground(context, env, "robotics");
        return new Response(
          JSON.stringify({ ...cached, fromCache: true, stale: true }),
          { status: 200, headers }
        );
      }

      const result = await refreshIntelCoordinated(env, "robotics");
      return new Response(JSON.stringify({ ...result, fromCache: false }), { status: 200, headers });
    } catch (err) {
      return intelErrorResponse(err, headers);
    }
  }

  return new Response("Method Not Allowed", { status: 405, headers });
}
