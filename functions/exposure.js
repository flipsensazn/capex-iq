// functions/exposure.js
//
// GET /exposure — serves customer-concentration disclosures extracted from
// SEC filings by src/customer_exposure.py (monthly GitHub Actions ETL → Neon).
//
//   { success: true, data: { FN: { topRevenuePct: 35,
//       customers: [{ label, ticker, pct, basis, period, form, quote }] } } }

import { buildDataHealth, fetchLatestManifest, latestAsOf } from "./data-health.js";

const PIPELINE = "customer_exposure";
const STALE_AFTER_HOURS = 40 * 24;
const DATA_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
const NO_STORE = "no-store";
const MAX_SOURCE_PERIOD_AGE_DAYS = 550;
const MAX_FUTURE_SOURCE_PERIOD_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function numberOrNull(value) {
  return value != null && Number.isFinite(Number(value)) ? Number(value) : null;
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

export function normalizeExposureRow(row, now = Date.now()) {
  const scorePeriodExclusions = sourcePeriodExclusions(row.period_end, now);
  return {
    label: row.customer_label,
    ticker: row.customer_ticker,
    pct: numberOrNull(row.pct),
    basis: row.basis,
    period: row.period,
    periodEnd: row.period_end ?? null,
    scorePeriodEligible: scorePeriodExclusions.length === 0,
    scorePeriodExclusions,
    form: row.source_form,
    accession: row.source_accession ?? null,
    statementType: row.statement_type,
    quote: row.quote,
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
    const url  = new URL(DATABASE_URL.replace("postgresql://", "https://").replace("postgres://", "https://"));
    const host = url.hostname;
    const manifestPromise = fetchLatestManifest({
      host,
      databaseUrl: DATABASE_URL,
      pipeline: PIPELINE,
    });

    const sqlQuery = `
      SELECT ticker, customer_label, customer_ticker, pct, basis, period,
             source_form, quote, extracted_at,
             COALESCE(
               to_jsonb(customer_exposure)->>'statement_type',
               'unclassified'
             ) AS statement_type,
             NULLIF(to_jsonb(customer_exposure)->>'period_end', '') AS period_end,
             NULLIF(
               to_jsonb(customer_exposure)->>'source_accession', ''
             ) AS source_accession
      FROM customer_exposure
      WHERE COALESCE(
        to_jsonb(customer_exposure)->>'statement_type',
        'unclassified'
      ) = 'single_customer'
      ORDER BY ticker, pct DESC
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
      console.error("exposure DB query failed", { status: dbRes.status, detail: errText });
      return new Response(
        JSON.stringify({
          success: false,
          message: "Exposure data is temporarily unavailable.",
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
      const entry = (data[row.ticker] ??= {
        topRevenuePct: null,
        customers: [],
        excludedCustomers: [],
      });
      const customer = normalizeExposureRow(row, now);
      if (!customer.scorePeriodEligible) {
        // Preserve the filed row and its exclusion for audit, but keep it out
        // of every scoring collection consumed by the graph.
        entry.excludedCustomers.push(customer);
        continue;
      }
      entry.customers.push(customer);
      if (customer.basis === "revenue" && customer.pct != null) {
        entry.topRevenuePct = Math.max(entry.topRevenuePct ?? 0, customer.pct);
      }
    }

    return new Response(
      JSON.stringify({
        success: true,
        count: Object.keys(data).length,
        data,
        health: buildDataHealth({
          pipeline: PIPELINE,
          manifest,
          fallbackAsOf: latestAsOf(rows, "extracted_at"),
          staleAfterHours: STALE_AFTER_HOURS,
        }),
      }),
      { status: 200, headers: headers(DATA_CACHE_CONTROL) }
    );

  } catch (err) {
    console.error("exposure unexpected error", err);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Exposure data is temporarily unavailable.",
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
