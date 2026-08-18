// functions/history.js

import { getAccessPayload, isTrustedOrigin } from "./access-lib.js";
import { hasFeature } from "./entitlements.js";

const CACHE_TTL_SECONDS = 60 * 60;
const TICKER_PATTERN = /^[A-Z0-9^][A-Z0-9.^=-]{0,14}$/;
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers });
}

async function readKvJson(kv, key) {
  if (!kv) return null;
  try {
    return await kv.get(key, "json");
  } catch (err) {
    console.error(`[history] KV read failed for ${key}:`, err);
    return null;
  }
}

async function writeKvJson(kv, key, value) {
  if (!kv) return;
  try {
    await kv.put(key, JSON.stringify(value), { expirationTtl: CACHE_TTL_SECONDS });
  } catch (err) {
    console.error(`[history] KV write failed for ${key}:`, err);
  }
}

export function buildPoints(timestamps, closes, volumes) {
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) return [];

  const points = [];
  for (let index = 0; index < timestamps.length; index += 1) {
    const timestamp = timestamps[index];
    const close = closes[index];
    if (!Number.isFinite(timestamp) || !Number.isFinite(close)) continue;

    points.push({
      date: new Date(timestamp * 1000).toISOString().slice(0, 10),
      close,
      volume: Number.isFinite(volumes?.[index]) ? volumes[index] : null,
    });
  }

  let sum20 = 0;
  let sum50 = 0;
  for (let index = 0; index < points.length; index += 1) {
    const close = points[index].close;
    sum20 += close;
    sum50 += close;
    if (index >= 20) sum20 -= points[index - 20].close;
    if (index >= 50) sum50 -= points[index - 50].close;
    points[index].ma20 = index >= 19 ? sum20 / 20 : null;
    points[index].ma50 = index >= 49 ? sum50 / 50 : null;
  }

  return points;
}

export async function onRequest(context) {
  const { request, env } = context;
  const allowedOrigin = env.ALLOWED_ORIGIN || "";
  const origin = request.headers.get("Origin") || "";
  const corsOrigin = origin === allowedOrigin ? allowedOrigin : "";
  const headers = {
    "Access-Control-Allow-Origin": corsOrigin,
    "Cache-Control": "private, no-store",
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
  const memberKey = accessPayload?.sub || accessPayload?.email?.toLowerCase();
  if (!memberKey) {
    return jsonResponse({ error: "Authentication required" }, 401, headers);
  }
  if (!isTrustedOrigin(request, env)) {
    return jsonResponse({ error: "Forbidden" }, 403, headers);
  }
  const email = accessPayload?.email?.toLowerCase();
  if (!(await hasFeature(email, env, "research"))) {
    return jsonResponse({
      error: "Analysis access is not enabled for this account",
      code: "members_only",
    }, 403, headers);
  }

  const ticker = (new URL(request.url).searchParams.get("ticker") || "").trim().toUpperCase();
  if (!ticker || !TICKER_PATTERN.test(ticker)) {
    return jsonResponse({ error: "Invalid ticker format" }, 400, headers);
  }

  const cacheKey = `history_v1_${ticker}`;
  const cached = await readKvJson(env.SHARED_DATA, cacheKey);
  if (cached) return jsonResponse(cached, 200, headers);

  try {
    const response = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=6mo&interval=1d`,
      { headers: { "User-Agent": USER_AGENT }, signal: request.signal }
    );
    if (!response.ok) throw new Error(`Yahoo returned ${response.status}`);

    const data = await response.json();
    const chart = data?.chart?.result?.[0];
    if (!chart) throw new Error("Yahoo returned no chart data");

    const quote = chart?.indicators?.quote?.[0];
    const points = buildPoints(chart.timestamp, quote?.close, quote?.volume);
    if (!points.length) throw new Error("Yahoo returned no usable price history");

    const result = {
      ticker,
      currency: typeof chart?.meta?.currency === "string" ? chart.meta.currency : null,
      points,
      displayFrom: points[Math.max(0, points.length - 63)].date,
      source: "Yahoo v8 chart",
      retrievedAt: new Date().toISOString(),
    };

    await writeKvJson(env.SHARED_DATA, cacheKey, result);
    return jsonResponse(result, 200, headers);
  } catch (err) {
    console.error("[history] Yahoo fetch failed:", err);
    return jsonResponse({ error: "Unable to retrieve price history" }, 502, headers);
  }
}
