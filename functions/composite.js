// functions/composite.js
//
// GET /composite — the Composite Bottleneck Score produced weekly by
// src/composite_score.py (transcript stress + XBRL gauges + filed customer
// concentration, blended and snapshotted to Neon).
//
//   { success: true, data: { AXTI: {
//       score, direction, prevScore, delta,
//       parts: { transcript, gauge, concentration },   // component scores
//       history: [{ date, score }, ...]                // oldest → newest, ~12 weeks
//   } } }

import {
  buildDataHealth,
  fetchLatestManifest,
  isExpectedBootstrap,
  latestAsOf,
} from "./data-health.js";

const PIPELINE = "composite_score";
const STALE_AFTER_HOURS = 9 * 24;
const DATA_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
const BOOTSTRAP_CACHE_CONTROL = "public, max-age=60, s-maxage=300";
const NO_STORE = "no-store";

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

function parsedTime(value) {
  const parsed = value == null ? NaN : Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function inputVintageAdvanced(previous, current) {
  if (
    !previous?.methodologySignature
    || previous.methodologySignature !== current?.methodologySignature
    || !previous.inputSignature
    || !current?.inputSignature
    || previous.inputSignature === current.inputSignature
  ) {
    return false;
  }

  const previousParts = previous.components ?? {};
  const currentParts = current.components ?? {};
  const componentKeys = parts => ["transcript", "gauge", "concentration"]
    .filter(name => (
      parts[name]
      && typeof parts[name] === "object"
      && !Array.isArray(parts[name])
    ));
  const previousKeys = componentKeys(previousParts);
  const currentKeys = componentKeys(currentParts);
  if (
    previousKeys.length !== currentKeys.length
    || previousKeys.some((name, index) => name !== currentKeys[index])
  ) {
    // Adding or removing a score-driving component changes the blend itself.
    // Baseline the entire snapshot even if another common input advanced.
    return false;
  }
  for (const name of Object.keys(previousParts)) {
    if (name === "_provenance" || !(name in currentParts)) continue;
    const previousPart = previousParts[name] ?? {};
    const currentPart = currentParts[name] ?? {};
    const previousMethod = previousPart.sourceMethodology;
    const currentMethod = currentPart.sourceMethodology;
    if (!previousMethod || previousMethod !== currentMethod) return false;
    const previousIneligible = previousPart.eligible === false;
    const currentIneligible = currentPart.eligible === false;
    if (previousIneligible && currentIneligible) continue;
    if (previousIneligible !== currentIneligible) return false;
    const previousPeriodEnd = parsedTime(previousPart.sourcePeriodEnd);
    const currentPeriodEnd = parsedTime(currentPart.sourcePeriodEnd);
    if (
      previousPeriodEnd == null
      || currentPeriodEnd == null
      || currentPeriodEnd < previousPeriodEnd
    ) return false;
  }

  const previousComputedAt = parsedTime(previous.computedAt);
  for (const name of ["transcript", "gauge", "concentration"]) {
    const currentPart = currentParts[name] ?? {};
    if (currentPart.eligible === false) continue;
    const currentSignature = currentPart.sourceSignature;
    const currentAvailableAt = parsedTime(currentPart.sourceAvailableAt);
    if (!currentSignature || currentAvailableAt == null) continue;

    const previousPart = previousParts[name];
    if (!previousPart) {
      if (
        parsedTime(currentPart.sourcePeriodEnd) != null
        && previousComputedAt != null
        && currentAvailableAt > previousComputedAt
      ) return true;
      continue;
    }
    const previousAvailableAt = parsedTime(previousPart.sourceAvailableAt);
    const previousPeriodEnd = parsedTime(previousPart.sourcePeriodEnd);
    const currentPeriodEnd = parsedTime(currentPart.sourcePeriodEnd);
    if (
      previousPart.sourceSignature
      && previousPart.sourceSignature !== currentSignature
      && previousAvailableAt != null
      && currentAvailableAt > previousAvailableAt
      && previousPeriodEnd != null
      && currentPeriodEnd != null
      && currentPeriodEnd >= previousPeriodEnd
    ) {
      return true;
    }
  }
  return false;
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
      SELECT cs.ticker, cs.as_of_date, cs.composite,
             cs.transcript_score, cs.transcript_direction,
             cs.gauge_score, cs.concentration_score, cs.components,
             cs.computed_at,
             to_jsonb(cs) ->> 'methodology_version' AS methodology_version,
             to_jsonb(cs) ->> 'methodology_signature' AS methodology_signature,
             to_jsonb(cs) ->> 'input_signature' AS input_signature,
             to_jsonb(cs) ->> 'source_available_at' AS source_available_at
      FROM composite_scores cs
      WHERE as_of_date > now() - interval '90 days'
      ORDER BY ticker, as_of_date ASC
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
      const detail = await dbRes.text();
      let databaseError = null;
      try {
        databaseError = JSON.parse(detail);
      } catch {
        // Preserve the opaque detail for logging below.
      }
      const primaryTableMissing = (
        databaseError?.code === "42P01"
        && /relation\s+"composite_scores"\s+does not exist/i.test(databaseError?.message ?? "")
      );
      // Before the first manifest-backed run, an absent table is an expected
      // bootstrap state. After initialization, the same error is data loss.
      if (primaryTableMissing && isExpectedBootstrap(manifest)) {
        return new Response(JSON.stringify({
          success: true,
          data: {},
          health: buildDataHealth({
            pipeline: PIPELINE,
            manifest,
            staleAfterHours: STALE_AFTER_HOURS,
          }),
        }), { status: 200, headers: headers(BOOTSTRAP_CACHE_CONTROL) });
      }
      console.error("composite DB query failed", { status: dbRes.status, detail });
      const health = buildDataHealth({
        pipeline: PIPELINE,
        manifest,
        staleAfterHours: STALE_AFTER_HOURS,
      });
      return new Response(
        JSON.stringify({
          success: false,
          message: "Composite data is temporarily unavailable.",
          health: primaryTableMissing ? {
            ...health,
            state: "failure",
            stale: true,
            error: "Composite storage is missing after pipeline initialization.",
          } : health,
        }),
        { status: 500, headers: headers(NO_STORE) }
      );
    }

    const rows = (await dbRes.json()).rows ?? [];
    const num = v => (v != null ? Number(v) : null);

    const data = {};
    for (const row of rows) {
      const entry = (data[row.ticker] ??= { history: [], _vintages: [] });
      const score = num(row.composite);
      entry.history.push({ date: row.as_of_date, score });
      // rows arrive oldest → newest, so the last write wins as "latest"
      entry.score = score;
      entry.direction = row.transcript_direction;
      entry.parts = {
        transcript: num(row.transcript_score),
        gauge: num(row.gauge_score),
        concentration: num(row.concentration_score),
      };
      delete entry.components;
      delete entry.provenance;
      const components = jsonObject(row.components);
      if (components) {
        entry.components = components;
      }
      const embedded = components?._provenance ?? {};
      const provenance = {
        methodology: embedded.methodology ?? null,
        methodologyVersion: num(row.methodology_version) ?? num(embedded.methodologyVersion),
        methodologySignature: row.methodology_signature ?? embedded.methodologySignature ?? null,
        inputSignature: row.input_signature ?? embedded.inputSignature ?? null,
        sourceAvailableAt: row.source_available_at ?? embedded.sourceAvailableAt ?? null,
      };
      if (Object.values(provenance).some(value => value != null)) {
        entry.provenance = provenance;
      }
      entry._vintages.push({
        score,
        components: components ?? {},
        methodologySignature: provenance.methodologySignature,
        inputSignature: provenance.inputSignature,
        computedAt: row.computed_at,
      });
    }
    for (const entry of Object.values(data)) {
      const vintages = entry._vintages;
      for (let index = 1; index < entry.history.length; index += 1) {
        const previousPoint = entry.history[index - 1];
        const currentPoint = entry.history[index];
        if (
          previousPoint.score == null
          || currentPoint.score == null
          || !inputVintageAdvanced(vintages[index - 1], vintages[index])
        ) {
          currentPoint.breakBefore = true;
        }
      }
      const comparable = vintages.length >= 2
        && inputVintageAdvanced(vintages[vintages.length - 2], vintages[vintages.length - 1]);
      entry.prevScore = comparable ? vintages[vintages.length - 2].score : null;
      entry.delta = entry.prevScore != null && entry.score != null
        ? +(entry.score - entry.prevScore).toFixed(1) : null;
      delete entry._vintages;
    }

    return new Response(
      JSON.stringify({
        success: true,
        count: Object.keys(data).length,
        data,
        health: buildDataHealth({
          pipeline: PIPELINE,
          manifest,
          fallbackAsOf: latestAsOf(rows, "computed_at", "as_of_date"),
          staleAfterHours: STALE_AFTER_HOURS,
        }),
      }),
      { status: 200, headers: headers(DATA_CACHE_CONTROL) }
    );

  } catch (err) {
    console.error("composite unexpected error", err);
    return new Response(
      JSON.stringify({
        success: false,
        message: "Composite data is temporarily unavailable.",
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
