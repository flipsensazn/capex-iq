// functions/scoreboard-teaser.js
//
// GET /scoreboard-teaser — a deliberately leak-free public preview of the
// latest Composite Bottleneck Score ranking. Scores and component values never
// cross this response boundary.

const CACHE_KEY = "scoreboardTeaser_v1";
const CACHE_TTL_SECONDS = 600;
const DATA_CACHE_CONTROL = "public, max-age=300, s-maxage=600";
const NO_STORE = "no-store";

const emptyPayload = success => ({
  success,
  asOf: null,
  top: [],
  moverCount: 0,
  totalTracked: 0,
});

function nonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function safeTicker(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function shapeCachedPayload(value) {
  if (!value || typeof value !== "object" || value.success !== true) return null;

  const top = Array.isArray(value.top)
    ? value.top.flatMap(item => {
        const ticker = safeTicker(item?.ticker);
        const rank = positiveInteger(item?.rank);
        return ticker && rank ? [{ ticker, rank }] : [];
      }).slice(0, 3)
    : [];

  return {
    success: true,
    asOf: typeof value.asOf === "string" ? value.asOf : null,
    top,
    moverCount: nonNegativeInteger(value.moverCount),
    totalTracked: nonNegativeInteger(value.totalTracked),
  };
}

function payloadFromRows(rows) {
  if (!rows.length) return emptyPayload(true);

  const first = rows[0];
  return {
    success: true,
    asOf: typeof first.as_of === "string" ? first.as_of : null,
    top: rows.flatMap(row => {
      const ticker = safeTicker(row.ticker);
      const rank = positiveInteger(row.rank);
      return ticker && rank ? [{ ticker, rank }] : [];
    }).slice(0, 3),
    moverCount: nonNegativeInteger(first.mover_count),
    totalTracked: nonNegativeInteger(first.total_tracked),
  };
}

async function readKvJson(kv) {
  if (!kv) return null;
  try {
    return await kv.get(CACHE_KEY, "json");
  } catch (error) {
    console.error("[scoreboard-teaser] KV read failed", error);
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
    console.error("[scoreboard-teaser] KV write failed", error);
  }
}

const TEASER_SQL = `
  WITH snapshots AS (
    SELECT ticker, as_of_date, composite,
           ROW_NUMBER() OVER (
             PARTITION BY ticker
             ORDER BY as_of_date DESC, computed_at DESC
           ) AS snapshot_number
    FROM composite_scores
  ), latest AS (
    SELECT latest_snapshot.ticker,
           latest_snapshot.as_of_date,
           latest_snapshot.composite,
           prior_snapshot.composite AS previous_composite,
           prior_snapshot.ticker IS NOT NULL AS has_previous
    FROM snapshots latest_snapshot
    LEFT JOIN snapshots prior_snapshot
      ON prior_snapshot.ticker = latest_snapshot.ticker
     AND prior_snapshot.snapshot_number = 2
    WHERE latest_snapshot.snapshot_number = 1
      AND latest_snapshot.composite IS NOT NULL
  ), ranked AS (
    SELECT ticker,
           ROW_NUMBER() OVER (
             ORDER BY composite DESC NULLS LAST, ticker
           ) AS rank,
           has_previous
             AND previous_composite IS NOT NULL
             AND composite IS DISTINCT FROM previous_composite AS moved,
           COUNT(*) OVER () AS total_tracked,
           MAX(as_of_date) OVER () AS as_of
    FROM latest
  )
  SELECT ticker, rank,
         COUNT(*) FILTER (WHERE moved) OVER () AS mover_count,
         total_tracked, as_of
  FROM ranked
  ORDER BY rank
  LIMIT 3
`;

export async function onRequest(context) {
  const { request, env } = context;

  const allowedOrigin = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === allowedOrigin ? allowedOrigin : "";
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
    return new Response(JSON.stringify(emptyPayload(false)), {
      status: 405,
      headers: headers(NO_STORE),
    });
  }

  const cached = shapeCachedPayload(await readKvJson(env.SHARED_DATA));
  if (cached) {
    return new Response(JSON.stringify(cached), {
      status: 200,
      headers: headers(DATA_CACHE_CONTROL),
    });
  }

  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    return new Response(JSON.stringify(emptyPayload(false)), {
      status: 500,
      headers: headers(NO_STORE),
    });
  }

  let host;
  try {
    host = new URL(
      databaseUrl
        .replace("postgresql://", "https://")
        .replace("postgres://", "https://")
    ).hostname;
  } catch {
    console.error("[scoreboard-teaser] DATABASE_URL is invalid");
    return new Response(JSON.stringify(emptyPayload(false)), {
      status: 500,
      headers: headers(NO_STORE),
    });
  }

  try {
    const dbResponse = await fetch("https://" + host + "/sql", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Neon-Connection-String": databaseUrl,
      },
      body: JSON.stringify({ query: TEASER_SQL }),
    });
    if (!dbResponse.ok) {
      const detail = await dbResponse.text();
      console.error("[scoreboard-teaser] Neon query failed", {
        status: dbResponse.status,
        detail,
      });
      return new Response(JSON.stringify(emptyPayload(false)), {
        status: 500,
        headers: headers(NO_STORE),
      });
    }

    const rows = (await dbResponse.json()).rows ?? [];
    const payload = payloadFromRows(rows);
    await writeKvJson(env.SHARED_DATA, payload);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: headers(DATA_CACHE_CONTROL),
    });
  } catch (error) {
    console.error("[scoreboard-teaser] unexpected error", error);
    return new Response(JSON.stringify(emptyPayload(false)), {
      status: 500,
      headers: headers(NO_STORE),
    });
  }
}
