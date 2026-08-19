// functions/capex-history.js
//
// GET /capex-history — the capex guidance time series. Every fresh
// capex-intel reading is appended to Neon (see persistHistory in
// capex-intel.js); this endpoint serves the trend so the UI can show the
// FIRST DERIVATIVE of hyperscaler guidance — the actual signal.
//
//   { success: true, history: [{ fetchedAt, total, byCompany }] }   (oldest → newest)

import { getAccessPayload, isTrustedOrigin } from "./access-lib.js";
import { hasFeature, isServiceRequest } from "./entitlements.js";

const CACHE_KEY = "capexHistoryView_v1";
const CACHE_TTL_SECONDS = 600;
const DATA_CACHE_CONTROL = "private, max-age=300";
const NO_STORE = "no-store";

async function readKvJson(kv) {
  if (!kv) return null;
  try {
    return await kv.get(CACHE_KEY, "json");
  } catch (error) {
    console.error(`[capex-history] KV read failed for ${CACHE_KEY}:`, error);
    return null;
  }
}

async function writeKvJson(kv, value) {
  if (!kv) return;
  try {
    await kv.put(CACHE_KEY, JSON.stringify(value), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch (error) {
    console.error(`[capex-history] KV write failed for ${CACHE_KEY}:`, error);
  }
}

export async function onRequest(context) {
  const { request, env } = context;

  const ALLOWED_ORIGIN = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "";

  const headers = cacheControl => ({
    "Access-Control-Allow-Origin": corsOrigin,
    "Content-Type": "application/json",
    "Vary": "Origin",
    "Cache-Control": cacheControl,
  });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...headers(NO_STORE),
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "GET") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: headers(NO_STORE),
    });
  }

  if (!(await isServiceRequest(request, env))) {
    const accessPayload = await getAccessPayload(request, env);
    const email = accessPayload?.email?.toLowerCase();
    if (!email) {
      return new Response(
        JSON.stringify({ error: "Authentication required" }),
        { status: 401, headers: headers(NO_STORE) }
      );
    }
    if (!isTrustedOrigin(request, env)) {
      return new Response(
        JSON.stringify({ error: "Forbidden" }),
        { status: 403, headers: headers(NO_STORE) }
      );
    }
    if (!(await hasFeature(email, env, "signals"))) {
      return new Response(
        JSON.stringify({
          error: "Signals access is not enabled for this account",
          code: "members_only",
        }),
        { status: 403, headers: headers(NO_STORE) }
      );
    }
  }

  const cached = await readKvJson(env.SHARED_DATA);
  if (cached) {
    return new Response(JSON.stringify(cached), {
      status: 200,
      headers: headers(DATA_CACHE_CONTROL),
    });
  }

  const DATABASE_URL = env.DATABASE_URL;
  if (!DATABASE_URL) {
    return new Response(
      JSON.stringify({ success: false, message: "DATABASE_URL not configured." }),
      { status: 500, headers: headers(NO_STORE) }
    );
  }

  try {
    const url  = new URL(DATABASE_URL.replace("postgresql://", "https://").replace("postgres://", "https://"));
    const host = url.hostname;

    // Last 180 days, thinned to one reading per day (the latest) so the
    // payload stays small no matter how often intel refreshes.
    const sqlQuery = `
      SELECT DISTINCT ON (fetched_at::date)
        fetched_at, total_capex, by_company
      FROM capex_intel_history
      WHERE fetched_at > now() - interval '180 days'
      ORDER BY fetched_at::date, fetched_at DESC
    `;

    const dbRes = await fetch(`https://${host}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": DATABASE_URL,
      },
      body: JSON.stringify({ query: sqlQuery }),
    });

    if (!dbRes.ok) {
      const errText = await dbRes.text();
      console.error("capex-history DB query failed", { status: dbRes.status, detail: errText });
      return new Response(
        JSON.stringify({ success: false, message: "History is temporarily unavailable." }),
        { status: 500, headers: headers(NO_STORE) }
      );
    }

    const result = await dbRes.json();
    const rows   = result.rows ?? [];

    const history = rows.map(row => {
      let byCompany = row.by_company;
      if (typeof byCompany === "string") {
        try { byCompany = JSON.parse(byCompany); } catch { byCompany = null; }
      }
      return {
        fetchedAt: row.fetched_at,
        total: row.total_capex != null ? Number(row.total_capex) : null,
        byCompany: byCompany ?? null,
      };
    }).sort((a, b) => new Date(a.fetchedAt) - new Date(b.fetchedAt));

    const payload = { success: true, count: history.length, history };
    await writeKvJson(env.SHARED_DATA, payload);
    return new Response(
      JSON.stringify(payload),
      { status: 200, headers: headers(DATA_CACHE_CONTROL) }
    );

  } catch (err) {
    console.error("capex-history unexpected error", err);
    return new Response(
      JSON.stringify({ success: false, message: "History is temporarily unavailable." }),
      { status: 500, headers: headers(NO_STORE) }
    );
  }
}
