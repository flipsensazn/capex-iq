// functions/radar.js
//
// GET /radar             — latest Radar screener snapshot
// GET /radar?ticker=NVDA — score components and recent trend for one ticker

import { getAccessPayload, isTrustedOrigin } from "./access-lib.js";
import {
  buildDataHealth,
  fetchLatestManifest,
  isExpectedBootstrap,
  latestAsOf,
} from "./data-health.js";
import { hasFeature } from "./entitlements.js";

const PIPELINE = "radar_scores";
const STALE_AFTER_HOURS = 9 * 24;
const CACHE_KEY = "radarView_v1";
const CACHE_TTL_SECONDS = 60 * 60;
const CACHE_CONTROL = "private, max-age=300";
const TICKER_PATTERN = /^[A-Z0-9^][A-Z0-9.^=-]{0,14}$/;

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Neon normally returns PostgreSQL arrays as JSON arrays. Keep the
    // controlled Radar chain values usable if a driver returns `{a,b}`.
    if (value.startsWith("{") && value.endsWith("}")) {
      const inner = value.slice(1, -1);
      return inner ? inner.split(",").map(item => item.replace(/^"|"$/g, "")) : [];
    }
  }
  return [];
}

function jsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

async function readKvJson(kv) {
  if (!kv) return null;
  try {
    return await kv.get(CACHE_KEY, "json");
  } catch (error) {
    console.error(`[radar] KV read failed for ${CACHE_KEY}:`, error);
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
    console.error(`[radar] KV write failed for ${CACHE_KEY}:`, error);
  }
}

function neonHost(databaseUrl) {
  const url = new URL(
    databaseUrl.replace("postgresql://", "https://").replace("postgres://", "https://")
  );
  return url.hostname;
}

function queryNeon(host, databaseUrl, query, params) {
  return fetch(`https://${host}/sql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Neon-Connection-String": databaseUrl,
    },
    body: JSON.stringify(params ? { query, params } : { query }),
  });
}

function radarTableMissing(detail) {
  let databaseError = null;
  try {
    databaseError = JSON.parse(detail);
  } catch {
    return false;
  }
  return databaseError?.code === "42P01"
    && /relation\s+"radar_scores"\s+does not exist/i.test(databaseError?.message ?? "");
}

function compareDatesDescending(left, right) {
  const leftTime = Date.parse(left);
  const rightTime = Date.parse(right);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) return rightTime - leftTime;
  return String(right).localeCompare(String(left));
}

function buildScreenerPayload(rows, manifest) {
  const dates = [...new Set(
    rows.map(row => row.as_of_date).filter(value => value != null).map(String)
  )].sort(compareDatesDescending).slice(0, 2);
  const [latestDate = null, previousDate = null] = dates;
  const latestRows = new Map();
  const previousRows = new Map();

  for (const row of rows) {
    const asOf = row.as_of_date == null ? null : String(row.as_of_date);
    if (asOf === latestDate && !latestRows.has(row.ticker)) latestRows.set(row.ticker, row);
    if (asOf === previousDate && !previousRows.has(row.ticker)) previousRows.set(row.ticker, row);
  }

  const screenerRows = [...latestRows.values()].map(row => {
    const previous = previousRows.get(row.ticker);
    return {
      ticker: row.ticker,
      coverage: row.coverage,
      quality: numberOrNull(row.quality_score),
      technical: numberOrNull(row.technical_score),
      prevQuality: numberOrNull(previous?.quality_score),
      prevTechnical: numberOrNull(previous?.technical_score),
      chainCount: numberOrNull(row.chain_count) ?? 0,
      chains: jsonArray(row.chains),
      memberships: jsonObject(row.memberships),
      price: numberOrNull(row.price),
      marketCap: numberOrNull(row.market_cap),
      asOf: latestDate,
    };
  });

  return {
    success: true,
    asOf: latestDate,
    rows: screenerRows,
    health: buildDataHealth({
      pipeline: PIPELINE,
      manifest,
      fallbackAsOf: latestAsOf(rows, "computed_at", "as_of_date"),
      staleAfterHours: STALE_AFTER_HOURS,
    }),
  };
}

async function serveScreener(env, headers) {
  const cached = await readKvJson(env.SHARED_DATA);
  if (cached) return jsonResponse(cached, 200, headers);

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    return jsonResponse({
      success: false,
      message: "Radar data is temporarily unavailable.",
      health: buildDataHealth({
        pipeline: PIPELINE,
        manifest: null,
        staleAfterHours: STALE_AFTER_HOURS,
      }),
    }, 500, headers);
  }

  try {
    const host = neonHost(databaseUrl);
    const manifestPromise = fetchLatestManifest({
      host,
      databaseUrl,
      pipeline: PIPELINE,
    });
    const sqlQuery = `
      WITH recent_dates AS (
        SELECT DISTINCT as_of_date
        FROM radar_scores
        ORDER BY as_of_date DESC
        LIMIT 2
      )
      SELECT ticker, as_of_date, coverage,
             quality_score, technical_score,
             chain_count, chains, memberships,
             price, market_cap, computed_at
      FROM radar_scores
      WHERE as_of_date IN (SELECT as_of_date FROM recent_dates)
      ORDER BY as_of_date DESC, ticker
    `;

    const [databaseResponse, manifest] = await Promise.all([
      queryNeon(host, databaseUrl, sqlQuery),
      manifestPromise,
    ]);

    if (!databaseResponse.ok) {
      const detail = await databaseResponse.text();
      const primaryTableMissing = radarTableMissing(detail);
      if (primaryTableMissing && isExpectedBootstrap(manifest)) {
        return jsonResponse(buildScreenerPayload([], manifest), 200, headers);
      }
      console.error("radar DB query failed", {
        status: databaseResponse.status,
        detail,
      });
      const health = buildDataHealth({
        pipeline: PIPELINE,
        manifest,
        staleAfterHours: STALE_AFTER_HOURS,
      });
      return jsonResponse({
        success: false,
        message: "Radar data is temporarily unavailable.",
        health: primaryTableMissing ? {
          ...health,
          state: "failure",
          stale: true,
          error: "Radar storage is missing after pipeline initialization.",
        } : health,
      }, 500, headers);
    }

    const rows = (await databaseResponse.json()).rows ?? [];
    const payload = buildScreenerPayload(rows, manifest);
    await writeKvJson(env.SHARED_DATA, payload);
    return jsonResponse(payload, 200, headers);
  } catch (error) {
    console.error("radar unexpected error", error);
    return jsonResponse({
      success: false,
      message: "Radar data is temporarily unavailable.",
      health: buildDataHealth({
        pipeline: PIPELINE,
        manifest: null,
        staleAfterHours: STALE_AFTER_HOURS,
      }),
    }, 500, headers);
  }
}

async function serveDetail(env, headers, ticker) {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    return jsonResponse({ error: "Radar data is temporarily unavailable" }, 500, headers);
  }

  try {
    const host = neonHost(databaseUrl);
    const sqlQuery = `
      SELECT ticker, as_of_date, coverage,
             quality_score, quality_components,
             technical_score, technical_components,
             fiscal_year_basis
      FROM radar_scores
      WHERE ticker = $1
      ORDER BY as_of_date DESC
      LIMIT 12
    `;
    const databaseResponse = await queryNeon(host, databaseUrl, sqlQuery, [ticker]);
    if (!databaseResponse.ok) {
      const detail = await databaseResponse.text();
      console.error("radar detail DB query failed", {
        status: databaseResponse.status,
        detail,
      });
      return jsonResponse({ error: "Radar data is temporarily unavailable" }, 500, headers);
    }

    const rows = (await databaseResponse.json()).rows ?? [];
    const latest = rows[0];
    if (!latest) {
      return jsonResponse({ error: "Unknown ticker", code: "not_found" }, 404, headers);
    }

    return jsonResponse({
      success: true,
      ticker: latest.ticker,
      coverage: latest.coverage,
      quality: numberOrNull(latest.quality_score),
      technical: numberOrNull(latest.technical_score),
      qualityComponents: jsonArray(latest.quality_components),
      technicalComponents: jsonArray(latest.technical_components),
      fiscalYearBasis: numberOrNull(latest.fiscal_year_basis),
      asOf: latest.as_of_date == null ? null : String(latest.as_of_date),
      trend: rows.slice(0, 12).map(row => ({
        asOf: row.as_of_date == null ? null : String(row.as_of_date),
        quality: numberOrNull(row.quality_score),
        technical: numberOrNull(row.technical_score),
      })),
    }, 200, headers);
  } catch (error) {
    console.error("radar detail unexpected error", error);
    return jsonResponse({ error: "Radar data is temporarily unavailable" }, 500, headers);
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  const allowedOrigin = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === allowedOrigin ? allowedOrigin : "";
  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Cache-Control": CACHE_CONTROL,
    "Content-Type": "application/json",
    "Vary": "Origin",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...headers,
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "GET") {
    return jsonResponse({ error: "Method Not Allowed" }, 405, headers);
  }

  const accessPayload = await getAccessPayload(request, env);
  const email = accessPayload?.email?.toLowerCase();
  if (!email) {
    return jsonResponse({ error: "Authentication required" }, 401, headers);
  }
  if (!isTrustedOrigin(request, env)) {
    return jsonResponse({ error: "Forbidden" }, 403, headers);
  }
  if (!(await hasFeature(email, env, "radar"))) {
    return jsonResponse({
      error: "Radar access is not enabled for this account",
      code: "members_only",
    }, 403, headers);
  }

  const url = new URL(request.url);
  if (!url.searchParams.has("ticker")) return serveScreener(env, headers);

  const ticker = (url.searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker || !TICKER_PATTERN.test(ticker)) {
    return jsonResponse({ error: "Invalid ticker format" }, 400, headers);
  }
  return serveDetail(env, headers, ticker);
}
