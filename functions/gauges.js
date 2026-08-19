// functions/gauges.js
//
// GET /gauges — serves the SEC XBRL supply-chain gauges produced by
// src/xbrl_gauges.py (weekly GitHub Actions ETL → Neon).
//
// Returns the most recent run's row per ticker:
//
//   { success: true, data: { ANET: { latestQuarterEnd, revenueYoy, rpoYoy,
//                                    orderGap, backlogScore, ... }, ... } }

import { getAccessPayload, isTrustedOrigin } from "./access-lib.js";
import { buildDataHealth, fetchLatestManifest, latestAsOf } from "./data-health.js";
import { hasFeature, isServiceRequest } from "./entitlements.js";

const PIPELINE = "xbrl_gauges";
const STALE_AFTER_HOURS = 9 * 24;
const CACHE_KEY = "gaugesView_v1";
const CACHE_TTL_SECONDS = 600;
const DATA_CACHE_CONTROL = "private, max-age=300";
const NO_STORE = "no-store";
const SCORE_PERIOD_METHODOLOGY = "xbrl-gauge-score-period-v1";
const MAX_SCORE_PERIOD_AGE_DAYS = 365;
const MAX_FUTURE_SCORE_PERIOD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

async function readKvJson(kv) {
  if (!kv) return null;
  try {
    return await kv.get(CACHE_KEY, "json");
  } catch (error) {
    console.error(`[gauges] KV read failed for ${CACHE_KEY}:`, error);
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
    console.error(`[gauges] KV write failed for ${CACHE_KEY}:`, error);
  }
}

function numberOrNull(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
}

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function normalizeGaugeRow(row, now = Date.now()) {
  const periodProvenance = jsonObject(row.period_provenance);
  const scorePeriodEnd = periodProvenance?.scorePeriodEnd ?? null;
  const scorePeriodText = scorePeriodEnd == null
    ? ""
    : String(scorePeriodEnd);
  const latestQuarterEnd = row.latest_quarter_end == null
    ? null
    : String(row.latest_quarter_end).slice(0, 10);
  const parsedScorePeriod = !/^\d{4}-\d{2}-\d{2}$/.test(scorePeriodText)
    ? NaN
    : Date.parse(`${scorePeriodText}T00:00:00Z`);
  const normalizedScorePeriod = Number.isFinite(parsedScorePeriod)
    ? new Date(parsedScorePeriod).toISOString().slice(0, 10)
    : null;
  const current = new Date(now);
  const todayUtc = Number.isFinite(current.getTime())
    ? Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate())
    : NaN;
  const ageDays = Number.isFinite(todayUtc) && Number.isFinite(parsedScorePeriod)
    ? Math.floor((todayUtc - parsedScorePeriod) / DAY_MS)
    : null;
  const exclusions = [];
  if (
    periodProvenance?.methodology !== SCORE_PERIOD_METHODOLOGY
    || !latestQuarterEnd
    || scorePeriodText !== latestQuarterEnd
    || !Number.isFinite(parsedScorePeriod)
    || normalizedScorePeriod !== scorePeriodText
    || ageDays == null
  ) {
    exclusions.push({ code: "unverified_score_period_provenance" });
  } else if (ageDays < -MAX_FUTURE_SCORE_PERIOD_DAYS) {
    exclusions.push({
      code: "future_source_period",
      ageDays,
    });
  } else if (ageDays > MAX_SCORE_PERIOD_AGE_DAYS) {
    exclusions.push({
      code: "stale_score_period",
      ageDays,
      maxAgeDays: MAX_SCORE_PERIOD_AGE_DAYS,
    });
  }
  const scorePeriodEligible = exclusions.length === 0;
  const gaugeNumber = value => scorePeriodEligible ? numberOrNull(value) : null;

  return {
    asOfDate: row.as_of_date,
    latestQuarterEnd: row.latest_quarter_end,
    revenuePeriodEnd: row.revenue_period_end ?? null,
    inventoryPeriodEnd: row.inventory_period_end ?? null,
    rpoPeriodEnd: row.rpo_period_end ?? null,
    backlogPeriodEnd: row.backlog_period_end ?? null,
    periodProvenance,
    scorePeriodEligible,
    scorePeriodExclusions: exclusions,
    revenueQ: numberOrNull(row.revenue_q),
    revenueYoy: numberOrNull(row.revenue_yoy),
    inventory: gaugeNumber(row.inventory),
    inventoryYoy: gaugeNumber(row.inventory_yoy),
    inventoryDays: gaugeNumber(row.inventory_days),
    inventoryDaysYoy: gaugeNumber(row.inventory_days_yoy),
    rpo: gaugeNumber(row.rpo),
    rpoYoy: gaugeNumber(row.rpo_yoy),
    rpoToTtmRevenue: gaugeNumber(row.rpo_to_ttm_revenue),
    orderGap: gaugeNumber(row.order_gap),
    backlogScore: gaugeNumber(row.backlog_score),
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
      return new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: headers(NO_STORE),
      });
    }
    if (!isTrustedOrigin(request, env)) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: headers(NO_STORE),
      });
    }
    if (!(await hasFeature(email, env, "signals"))) {
      return new Response(JSON.stringify({
        error: "Signals access is not enabled for this account",
        code: "members_only",
      }), {
        status: 403,
        headers: headers(NO_STORE),
      });
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

    // Prefer the newest source period, not merely the newest ETL run date.
    // This also repairs pre-guard history where a later run may have persisted
    // an older CompanyFacts snapshot.
    const sqlQuery = `
      WITH ranked AS (
        SELECT *,
          ROW_NUMBER() OVER (
            PARTITION BY ticker
            ORDER BY latest_quarter_end DESC NULLS LAST, as_of_date DESC
          ) AS rn
        FROM xbrl_gauges
      )
      SELECT ticker, as_of_date, latest_quarter_end, revenue_q, revenue_yoy,
             inventory, inventory_yoy, inventory_days, inventory_days_yoy,
             rpo, rpo_yoy, rpo_to_ttm_revenue, order_gap, backlog_score,
             NULLIF(to_jsonb(ranked)->>'revenue_period_end', '')
               AS revenue_period_end,
             NULLIF(to_jsonb(ranked)->>'inventory_period_end', '')
               AS inventory_period_end,
             NULLIF(to_jsonb(ranked)->>'rpo_period_end', '')
               AS rpo_period_end,
             NULLIF(to_jsonb(ranked)->>'backlog_period_end', '')
               AS backlog_period_end,
             to_jsonb(ranked)->'period_provenance' AS period_provenance,
             fetched_at
      FROM ranked WHERE rn = 1 ORDER BY ticker
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
      console.error("gauges DB query failed", { status: dbRes.status, detail: errText });
      return new Response(
        JSON.stringify({
          success: false,
          message: "Gauge data is temporarily unavailable.",
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
    for (const row of rows) {
      data[row.ticker] = normalizeGaugeRow(row);
    }

    const payload = {
      success: true,
      count: Object.keys(data).length,
      data,
      health: buildDataHealth({
        pipeline: PIPELINE,
        manifest,
        fallbackAsOf: latestAsOf(rows, "fetched_at", "as_of_date"),
        staleAfterHours: STALE_AFTER_HOURS,
      }),
    };
    await writeKvJson(env.SHARED_DATA, payload);
    return new Response(
      JSON.stringify(payload),
      { status: 200, headers: headers(DATA_CACHE_CONTROL) }
    );

  } catch (err) {
    console.error("gauges unexpected error", err);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Gauge data is temporarily unavailable.",
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
