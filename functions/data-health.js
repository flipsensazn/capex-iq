const MANIFEST_STATES = new Set(["running", "success", "degraded", "failure"]);
const RUNNING_LEASE_HOURS = {
  transcript_stress: 3,
  xbrl_gauges: 2,
  customer_exposure: 4,
  composite_score: 1,
  signal_scoreboard: 2,
};

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDetails(value) {
  if (!value) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value;
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

// ETL error text arrives as a raw exception string (etl_health.py stores
// str(error)[:2000]), and these manifests ride along on PUBLIC endpoints. A
// redaction denylist cannot win that race: bare Neon hostnames and
// `for user "..."` fragments slip through untouched. Classify into a fixed set
// of operator-safe categories instead, so nothing provider-authored is ever
// echoed. The raw text stays in the database for debugging.
const ERROR_CATEGORIES = [
  [/rate.?limit|too many requests|429/i, "An upstream provider rate-limited this run."],
  [/timed? ?out|timeout|deadline exceeded/i, "The run timed out before completing."],
  [/coverage|below .{0,20}threshold|minimum required/i, "The run did not meet its minimum data coverage."],
  [/authenticat|authoriz|permission denied|forbidden|credential/i, "An upstream service rejected this run's credentials."],
  [/could not connect|connection (refused|reset|closed)|unreachable|network|dns|getaddrinfo|server at/i, "The run could not reach a required service."],
  [/no such table|relation .* does not exist|column .* does not exist|syntax error/i, "The run hit a database schema error."],
  [/quota|insufficient funds|billing/i, "An upstream provider quota was exhausted."],
];

function publicError(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  for (const [pattern, message] of ERROR_CATEGORIES) {
    if (pattern.test(value)) return message;
  }
  return "The run failed. See operator logs for detail.";
}

export function latestAsOf(rows, ...fields) {
  let latest = null;
  let latestTime = -Infinity;
  for (const row of rows ?? []) {
    for (const field of fields) {
      const value = row?.[field];
      const time = value == null ? NaN : Date.parse(value);
      if (Number.isFinite(time) && time > latestTime) {
        latest = value;
        latestTime = time;
      }
    }
  }
  return latest;
}

export async function fetchLatestManifest({ host, databaseUrl, pipeline }) {
  if (!/^[a-z0-9_]+$/i.test(pipeline)) {
    throw new Error("Invalid ETL pipeline key");
  }

  const query = `
    WITH latest AS (
      SELECT pipeline, run_id, run_date, state, started_at, finished_at,
             data_fresh_at AS run_data_fresh_at,
             expected, attempted, usable, known_no_data,
             transient_failures, degraded, provider_coverage, usable_coverage,
             baseline_usable, error_message, details
      FROM etl_run_manifest
      WHERE pipeline = '${pipeline}'
      ORDER BY started_at DESC
      LIMIT 1
    ), freshness AS (
      SELECT MAX(data_fresh_at) AS last_data_fresh_at
      FROM etl_run_manifest
      WHERE pipeline = '${pipeline}'
        AND COALESCE(
          details->>'limitedRun', details->>'limited_run', 'false'
        ) <> 'true'
    )
    SELECT latest.*, freshness.last_data_fresh_at
    FROM latest CROSS JOIN freshness
  `;

  try {
    const response = await fetch(`https://${host}/sql`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": databaseUrl,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const detail = await response.text();
      if (/42P01|etl_run_manifest[^\n]*does not exist/i.test(detail)) {
        return { available: false, reason: "missing", row: null };
      }
      console.error("ETL manifest query failed", { pipeline, status: response.status });
      return { available: false, reason: "unavailable", row: null };
    }

    const payload = await response.json();
    return { available: true, reason: null, row: payload.rows?.[0] ?? null };
  } catch (error) {
    console.error("ETL manifest request failed", {
      pipeline,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return { available: false, reason: "unavailable", row: null };
  }
}

export function isExpectedBootstrap(manifest) {
  return manifest?.row == null && (
    manifest?.available === true || manifest?.reason === "missing"
  );
}

export function buildDataHealth({
  pipeline,
  manifest,
  fallbackAsOf = null,
  staleAfterHours,
  now = Date.now(),
}) {
  const row = manifest?.row ?? null;
  const details = parseDetails(row?.details);
  const limitedRun = details?.limitedRun === true || details?.limited_run === true;
  const manifestState = row?.state;
  const rawState = MANIFEST_STATES.has(manifestState) ? manifestState : "unknown";
  const startedAtMs = row?.started_at == null ? NaN : Date.parse(row.started_at);
  const runningLeaseMs = (RUNNING_LEASE_HOURS[pipeline] ?? 4) * 60 * 60 * 1000;
  const runningExpired = rawState === "running" && (
    !Number.isFinite(startedAtMs) || now - startedAtMs > runningLeaseMs
  );
  const state = runningExpired ? "failure" : rawState;
  const manifestAsOf = row?.last_data_fresh_at
    ?? (limitedRun ? null : row?.run_data_fresh_at)
    ?? (limitedRun ? null : row?.data_fresh_at)
    ?? null;
  const asOf = manifestAsOf || (limitedRun ? null : fallbackAsOf) || null;
  const parsedAsOf = asOf == null ? NaN : Date.parse(asOf);
  const staleAfterMs = staleAfterHours * 60 * 60 * 1000;
  const stale = !Number.isFinite(parsedAsOf) || now - parsedAsOf > staleAfterMs;

  const counts = row
    ? {
        expected: numberOrNull(row.expected),
        attempted: numberOrNull(row.attempted),
        usable: numberOrNull(row.usable),
        knownNoData: numberOrNull(row.known_no_data),
        transientFailures: numberOrNull(row.transient_failures),
        degraded: numberOrNull(row.degraded),
        baselineUsable: numberOrNull(row.baseline_usable),
      }
    : null;
  const coverage = row
    ? {
        provider: numberOrNull(row.provider_coverage),
        usable: numberOrNull(row.usable_coverage),
      }
    : null;

  return {
    pipeline,
    state,
    source: row ? "manifest" : fallbackAsOf ? "inferred" : "unavailable",
    freshnessSource: manifestAsOf ? "manifest" : fallbackAsOf ? "data" : "unavailable",
    stale,
    asOf,
    dataFreshAt: asOf,
    staleAfterHours,
    runId: row?.run_id ?? null,
    runDate: row?.run_date ?? null,
    startedAt: row?.started_at ?? null,
    finishedAt: row?.finished_at ?? null,
    counts,
    coverage,
    error: publicError(row?.error_message) ?? (
      runningExpired ? "ETL run exceeded its expected execution window." : null
    ),
    limitedRun,
    runningExpired,
  };
}
