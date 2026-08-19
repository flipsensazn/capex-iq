// functions/stress.js
//
// GET /stress — serves the transcript NLP supply-chain stress scores produced
// by src/transcript_stress.py (weekly GitHub Actions ETL → Neon).
//
// Returns the two most recent analyzed quarters per ticker so the frontend
// can show both the level and the quarter-over-quarter trend:
//
//   { success: true, data: { NVDA: { latest: {...}, prev: {...}|null }, ... } }

import { getAccessPayload, isTrustedOrigin } from "./access-lib.js";
import { buildDataHealth, fetchLatestManifest, latestAsOf } from "./data-health.js";
import { hasFeature, isServiceRequest } from "./entitlements.js";

const PIPELINE = "transcript_stress";
const STALE_AFTER_HOURS = 9 * 24;
const CACHE_KEY = "stressView_v1";
const CACHE_TTL_SECONDS = 600;
const DATA_CACHE_CONTROL = "private, max-age=300";
const NO_STORE = "no-store";
const SOURCE_METHODOLOGY = "transcript-stress-v1";
const MAX_SOURCE_PERIOD_AGE_DAYS = 365;
const MAX_FUTURE_SOURCE_PERIOD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

async function readKvJson(kv) {
  if (!kv) return null;
  try {
    return await kv.get(CACHE_KEY, "json");
  } catch (error) {
    console.error(`[stress] KV read failed for ${CACHE_KEY}:`, error);
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
    console.error(`[stress] KV write failed for ${CACHE_KEY}:`, error);
  }
}

function numberOrNull(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function methodologyToken(value, fallback) {
  const normalized = value == null ? "" : String(value).trim();
  return encodeURIComponent(normalized || fallback);
}

export function transcriptSourceMethodology(row) {
  return `${SOURCE_METHODOLOGY}:model=${methodologyToken(row.model, "lexicon-only")};provider=${methodologyToken(row.provider, "unknown")}`;
}

function sourcePeriodExclusions(value, now) {
  if (value == null || String(value).trim() === "") {
    return [{ code: "missing_source_period_end" }];
  }
  const periodText = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodText)) {
    return [{ code: "invalid_source_period_end" }];
  }
  const periodTime = Date.parse(`${periodText}T00:00:00Z`);
  if (
    !Number.isFinite(periodTime)
    || new Date(periodTime).toISOString().slice(0, 10) !== periodText
  ) {
    return [{ code: "invalid_source_period_end" }];
  }
  const current = new Date(now);
  if (!Number.isFinite(current.getTime())) {
    return [{ code: "invalid_freshness_reference_time" }];
  }
  const todayUtc = Date.UTC(
    current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate(),
  );
  const ageDays = Math.floor((todayUtc - periodTime) / DAY_MS);
  if (ageDays < -MAX_FUTURE_SOURCE_PERIOD_DAYS) {
    return [{ code: "future_source_period", ageDays }];
  }
  if (ageDays > MAX_SOURCE_PERIOD_AGE_DAYS) {
    return [{
      code: "stale_source_period",
      ageDays,
      maxAgeDays: MAX_SOURCE_PERIOD_AGE_DAYS,
    }];
  }
  return [];
}

export function normalizeStressRow(row, now = Date.now()) {
  const scorePeriodExclusions = sourcePeriodExclusions(row.call_date, now);
  if (row.provider == null || String(row.provider).trim() === "") {
    scorePeriodExclusions.push({ code: "missing_source_provider" });
  }
  const scorePeriodEligible = scorePeriodExclusions.length === 0;
  const scoreValue = value => scorePeriodEligible ? numberOrNull(value) : null;
  return {
    fiscalYear: row.fiscal_year,
    fiscalQuarter: row.fiscal_quarter,
    callDate: row.call_date,
    scorePeriodEligible,
    scorePeriodExclusions,
    sourceMethodology: transcriptSourceMethodology(row),
    provider: row.provider ?? null,
    model: row.model ?? null,
    stressScore: scoreValue(row.stress_score),
    lexiconScore: scoreValue(row.lexicon_score),
    // The hit count, summary, and quotes remain visible as audit evidence even
    // when the dated score is not eligible for graph or trend calculations.
    lexiconHits: row.lexicon_hits,
    direction: scorePeriodEligible ? row.direction : null,
    summary: row.summary,
    quotes: row.quotes,
    analyzedAt: row.analyzed_at,
  };
}

export function attachStressTrend(snapshot) {
  const { latest, prev } = snapshot;
  const comparable = Boolean(
    latest?.scorePeriodEligible
    && prev?.scorePeriodEligible
    && latest.provider
    && prev.provider
    && latest.sourceMethodology
    && latest.sourceMethodology === prev.sourceMethodology
    && latest.stressScore != null
    && prev.stressScore != null
  );
  return {
    ...snapshot,
    trendComparable: comparable,
    trendDelta: comparable ? latest.stressScore - prev.stressScore : null,
  };
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
      JSON.stringify({
        success: false,
        message: "DATABASE_URL not configured.",
        health: buildDataHealth({
          pipeline: PIPELINE,
          manifest: null,
          staleAfterHours: STALE_AFTER_HOURS,
        }),
      }),
      { status: 500, headers: headers(NO_STORE) }
    );
  }

  try {
    // Convert the connection string into the Neon HTTP SQL endpoint.
    const url  = new URL(DATABASE_URL.replace("postgresql://", "https://").replace("postgres://", "https://"));
    const host = url.hostname;
    const manifestPromise = fetchLatestManifest({
      host,
      databaseUrl: DATABASE_URL,
      pipeline: PIPELINE,
    });

    // Two most recent analyzed quarters per ticker.
    const sqlQuery = `
      WITH ranked AS (
        SELECT
          ticker,
          fiscal_year,
          fiscal_quarter,
          call_date,
          stress_score,
          lexicon_score,
          lexicon_hits,
          direction,
          summary,
          quotes,
          provider,
          model,
          analyzed_at,
          ROW_NUMBER() OVER (
            PARTITION BY ticker
            ORDER BY fiscal_year DESC, fiscal_quarter DESC
          ) AS rn
        FROM transcript_stress
      )
      SELECT * FROM ranked WHERE rn <= 2 ORDER BY ticker, rn
    `;

    const [dbRes, manifest] = await Promise.all([
      fetch(`https://${host}/sql`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Neon-Connection-String": DATABASE_URL,
        },
        body: JSON.stringify({ query: sqlQuery }),
      }),
      manifestPromise,
    ]);

    if (!dbRes.ok) {
      const errText = await dbRes.text();
      console.error("stress DB query failed", { status: dbRes.status, detail: errText });
      return new Response(
        JSON.stringify({
          success: false,
          message: "Stress data is temporarily unavailable.",
          health: buildDataHealth({
            pipeline: PIPELINE,
            manifest,
            staleAfterHours: STALE_AFTER_HOURS,
          }),
        }),
        { status: 500, headers: headers(NO_STORE) }
      );
    }

    const result = await dbRes.json();
    const rows   = result.rows ?? [];

    const data = {};
    const now = context.now ?? Date.now();
    for (const row of rows) {
      let quotes = row.quotes;
      if (typeof quotes === "string") {
        try { quotes = JSON.parse(quotes); } catch { quotes = []; }
      }
      const entry = normalizeStressRow({ ...row, quotes: Array.isArray(quotes) ? quotes : [] }, now);
      if (!data[row.ticker]) data[row.ticker] = { latest: null, prev: null };
      if (Number(row.rn) === 1) data[row.ticker].latest = entry;
      else data[row.ticker].prev = entry;
    }
    for (const ticker of Object.keys(data)) {
      data[ticker] = attachStressTrend(data[ticker]);
    }

    const payload = {
      success: true,
      count: Object.keys(data).length,
      data,
      health: buildDataHealth({
        pipeline: PIPELINE,
        manifest,
        fallbackAsOf: latestAsOf(rows, "analyzed_at", "call_date"),
        staleAfterHours: STALE_AFTER_HOURS,
      }),
    };
    await writeKvJson(env.SHARED_DATA, payload);
    return new Response(
      JSON.stringify(payload),
      { status: 200, headers: headers(DATA_CACHE_CONTROL) }
    );

  } catch (err) {
    console.error("stress unexpected error", err);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Stress data is temporarily unavailable.",
        health: buildDataHealth({
          pipeline: PIPELINE,
          manifest: null,
          staleAfterHours: STALE_AFTER_HOURS,
        }),
      }),
      { status: 500, headers: headers(NO_STORE) }
    );
  }
}
