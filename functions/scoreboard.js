// functions/scoreboard.js
//
// GET /scoreboard — the Signal Performance Scoreboard, fed weekly by
// src/signal_scoreboard.py. Answers "when this system fires a signal, does
// the stock actually beat the market afterwards?"
//
//   { success: true,
//     stats: [...prospective stats], events: [...prospective events],
//     statsByCohort: { prospective: [...], retrospective: [...] },
//     eventsByCohort: { prospective: [...], retrospective: [...] },
//     methodology: {...} }
//
// Excess = event return minus QQQ over the same window, percentage points.
// Horizon stats only include events whose window has matured.

import {
  buildDataHealth,
  fetchLatestManifest,
  isExpectedBootstrap,
  latestAsOf,
} from "./data-health.js";

const PROSPECTIVE_START = "2026-08-17";
const PIPELINE = "signal_scoreboard";
const STALE_AFTER_HOURS = 9 * 24;
const DATA_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
const BOOTSTRAP_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
const NO_STORE = "no-store";

const METHODOLOGY = Object.freeze({
  version: 2,
  benchmark: "QQQ",
  entry: "First NYSE regular-session close strictly after signal availability (or after event date for reconstructions).",
  horizonAnchor: "Actual entry date",
  horizonCalendarDays: { "1w": 7, "1m": 30, "3m": 91 },
  excessUnit: "percentage_points",
  aggregation: "Median over matured events",
  hitDefinition: "Stock return strictly greater than benchmark return",
  refractoryDays: 90,
  refractoryScope: "ticker, event type, and cohort",
  prospectiveStart: PROSPECTIVE_START,
  initialObservationDisclosure: "A first stored value already above a threshold is labeled initial, not an observed crossing.",
  migrationBaselineDisclosure: "Methodology-rollout baselines are retained for audit but excluded from events, returns, and performance statistics.",
  retrospectiveDisclosure: "Historically reconstructed after the scoring rubric was designed; exploratory, not an out-of-sample track record.",
});

const emptyPayload = health => ({
  success: true,
  stats: [],
  events: [],
  statsByCohort: { prospective: [], retrospective: [] },
  eventsByCohort: { prospective: [], retrospective: [] },
  methodology: METHODOLOGY,
  health,
});

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

  let host;
  try {
    const url = new URL(DATABASE_URL.replace("postgresql://", "https://").replace("postgres://", "https://"));
    host = url.hostname;
  } catch {
    console.error("scoreboard database URL is invalid");
    return new Response(
      JSON.stringify({
        success: false,
        message: "Scoreboard data is temporarily unavailable.",
        health: buildDataHealth({
          pipeline: PIPELINE,
          manifest: null,
          staleAfterHours: STALE_AFTER_HOURS,
        }),
      }),
      { status: 500, headers: headers(NO_STORE) }
    );
  }
  const manifestPromise = fetchLatestManifest({
    host,
    databaseUrl: DATABASE_URL,
    pipeline: PIPELINE,
  });

  const runQuery = async (query) => {
    const res = await fetch(`https://${host}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": DATABASE_URL,
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      const detail = await res.text();
      const err = new Error(detail);
      let dbError = null;
      try { dbError = JSON.parse(detail); } catch { /* Neon may return plain text. */ }
      const message = dbError?.message || dbError?.error || detail;
      err.missingTable = dbError?.code === "42P01"
        && /relation\s+"?(?:public\.)?signal_events"?\s+does not exist/i.test(message);
      throw err;
    }
    return (await res.json()).rows ?? [];
  };

  const COHORT_SQL = `
    CASE
      WHEN details->>'cohort' IN ('prospective', 'retrospective')
        THEN details->>'cohort'
      ELSE 'retrospective'
    END
  `;

  const STATS_SQL = `
    WITH classified AS (
      SELECT *, ${COHORT_SQL} AS cohort
      FROM signal_events
      WHERE COALESCE(details->>'eventClassification', '') <> 'migration_baseline'
    )
    SELECT cohort, COALESCE(event_type, 'all') AS type,
           MIN(NULLIF(details->>'cohortBoundary', '')) AS cohort_boundary_min,
           MAX(NULLIF(details->>'cohortBoundary', '')) AS cohort_boundary_max,
           COUNT(*) AS n,
           COUNT(*) FILTER (WHERE ret_1w IS NOT NULL AND bench_1w IS NOT NULL) AS n_1w,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ret_1w - bench_1w)
             FILTER (WHERE ret_1w IS NOT NULL AND bench_1w IS NOT NULL) AS med_1w,
           AVG((ret_1w > bench_1w)::int)
             FILTER (WHERE ret_1w IS NOT NULL AND bench_1w IS NOT NULL) AS hit_1w,
           COUNT(*) FILTER (WHERE ret_1m IS NOT NULL AND bench_1m IS NOT NULL) AS n_1m,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ret_1m - bench_1m)
             FILTER (WHERE ret_1m IS NOT NULL AND bench_1m IS NOT NULL) AS med_1m,
           AVG((ret_1m > bench_1m)::int)
             FILTER (WHERE ret_1m IS NOT NULL AND bench_1m IS NOT NULL) AS hit_1m,
           COUNT(*) FILTER (WHERE ret_3m IS NOT NULL AND bench_3m IS NOT NULL) AS n_3m,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY ret_3m - bench_3m)
             FILTER (WHERE ret_3m IS NOT NULL AND bench_3m IS NOT NULL) AS med_3m,
           AVG((ret_3m > bench_3m)::int)
             FILTER (WHERE ret_3m IS NOT NULL AND bench_3m IS NOT NULL) AS hit_3m
    FROM classified
    GROUP BY cohort, ROLLUP(event_type)
    ORDER BY cohort DESC, n DESC
  `;

  const EVENTS_SQL = `
    WITH classified AS (
      SELECT *, ${COHORT_SQL} AS cohort,
             COALESCE(
               NULLIF(details->>'signalAvailableAt', '')::timestamptz,
               created_at,
               event_date::timestamptz
             ) AS observed_at
      FROM signal_events
      WHERE COALESCE(details->>'eventClassification', '') <> 'migration_baseline'
    ), ranked AS (
      SELECT ticker, event_type, event_date, score, cohort, observed_at,
             entry_date, details->>'signalAvailableAt' AS signal_available_at,
             details->'exitDates' AS exit_dates,
             ret_1w, bench_1w, ret_1m, bench_1m, ret_3m, bench_3m,
             ROW_NUMBER() OVER (
               PARTITION BY cohort ORDER BY observed_at DESC, event_date DESC, ticker
             ) AS cohort_rank
      FROM classified
    )
    SELECT ticker, event_type, event_date, score, cohort, observed_at,
           entry_date, signal_available_at, exit_dates,
           ret_1w, bench_1w, ret_1m, bench_1m, ret_3m, bench_3m
    FROM ranked
    WHERE cohort_rank <= 30
    ORDER BY observed_at DESC, event_date DESC, ticker
  `;

  let manifest = null;
  try {
    const [statRows, eventRows, resolvedManifest] = await Promise.all([
      runQuery(STATS_SQL),
      runQuery(EVENTS_SQL),
      manifestPromise,
    ]);
    manifest = resolvedManifest;

    const num = v => (v != null ? Number(v) : null);
    const round1 = v => (v != null ? Math.round(v * 10) / 10 : null);
    const boundaries = new Set(statRows.flatMap(r => [
      r.cohort_boundary_min,
      r.cohort_boundary_max,
    ]).filter(Boolean));
    if (boundaries.size > 1) {
      throw new Error("signal_events contains inconsistent cohort boundaries");
    }
    const prospectiveStart = boundaries.values().next().value || PROSPECTIVE_START;
    const methodology = { ...METHODOLOGY, prospectiveStart };

    const allStats = statRows.map(r => ({
      cohort: r.cohort,
      type: r.type,
      n: num(r.n),
      horizons: Object.fromEntries(["1w", "1m", "3m"].map(h => [h, {
        n: num(r[`n_${h}`]) ?? 0,
        medianExcess: round1(num(r[`med_${h}`])),
        hitRate: r[`hit_${h}`] != null ? Math.round(Number(r[`hit_${h}`]) * 100) : null,
      }])),
    }));

    const allEvents = eventRows.map(r => ({
      ticker: r.ticker,
      type: r.event_type,
      date: r.event_date,
      eventDate: r.event_date,
      observedAt: r.observed_at,
      signalAvailableAt: r.signal_available_at,
      entryDate: r.entry_date,
      exitDates: r.exit_dates ?? {},
      score: num(r.score),
      cohort: r.cohort,
      excess: Object.fromEntries(["1w", "1m", "3m"].map(h => [h,
        r[`ret_${h}`] != null && r[`bench_${h}`] != null
          ? round1(Number(r[`ret_${h}`]) - Number(r[`bench_${h}`]))
          : null,
      ])),
    }));

    const statsByCohort = { prospective: [], retrospective: [] };
    for (const stat of allStats) {
      if (statsByCohort[stat.cohort]) statsByCohort[stat.cohort].push(stat);
    }
    const eventsByCohort = { prospective: [], retrospective: [] };
    for (const event of allEvents) {
      if (eventsByCohort[event.cohort]) eventsByCohort[event.cohort].push(event);
    }

    // Preserve the legacy top-level shape, but make it prospective-only so an
    // older client cannot accidentally present a blended backtest as live edge.
    const stats = statsByCohort.prospective;
    const events = eventsByCohort.prospective;

    return new Response(
      JSON.stringify({
        success: true,
        stats,
        events,
        statsByCohort,
        eventsByCohort,
        methodology,
        health: buildDataHealth({
          pipeline: PIPELINE,
          manifest,
          fallbackAsOf: latestAsOf(eventRows, "observed_at", "event_date"),
          staleAfterHours: STALE_AFTER_HOURS,
        }),
      }),
      { status: 200, headers: headers(DATA_CACHE_CONTROL) }
    );

  } catch (err) {
    manifest ??= await manifestPromise;
    // Before the first manifest-backed run, an absent table is an expected
    // bootstrap state. After initialization, the same error is data loss.
    if (err.missingTable && isExpectedBootstrap(manifest)) {
      return new Response(
        JSON.stringify(emptyPayload(buildDataHealth({
          pipeline: PIPELINE,
          manifest,
          staleAfterHours: STALE_AFTER_HOURS,
        }))),
        { status: 200, headers: headers(BOOTSTRAP_CACHE_CONTROL) }
      );
    }
    console.error("scoreboard query failed", err.message);
    const health = buildDataHealth({
      pipeline: PIPELINE,
      manifest,
      staleAfterHours: STALE_AFTER_HOURS,
    });
    return new Response(
      JSON.stringify({
        success: false,
        message: "Scoreboard data is temporarily unavailable.",
        health: err.missingTable ? {
          ...health,
          state: "failure",
          stale: true,
          error: "Scoreboard storage is missing after pipeline initialization.",
        } : health,
      }),
      { status: 500, headers: headers(NO_STORE) }
    );
  }
}
