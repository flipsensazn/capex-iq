import { isAdminEmail, isAnalyzeAllowedEmail } from "./access-lib.js";

export const FEATURES = ["research", "radar", "funds", "signals"];
const DEFAULT_RESEARCH_QUOTA = 50;
const MAX_RESEARCH_QUOTA = 10_000;
const RESEARCH_USAGE_TTL_SECONDS = 62 * 24 * 60 * 60;

function researchUsageKey(email) {
  const month = new Date().toISOString().slice(0, 7);
  return `usage:${email.toLowerCase()}:${month}`;
}

async function readResearchUsage(kv, key) {
  if (!kv?.get) return 0;
  try {
    const rawValue = await kv.get(key);
    if (rawValue == null) return 0;
    const value = typeof rawValue === "string" && rawValue.trim() !== ""
      ? Number(rawValue)
      : rawValue;
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch (err) {
    console.error(`[entitlements] Research usage KV read failed for ${key}:`, err);
    return 0;
  }
}

function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;

  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

export function isServiceRequest(request, env) {
  const expectedToken = env?.SIGNALS_SERVICE_TOKEN;
  if (typeof expectedToken !== "string" || expectedToken.length === 0) return false;

  const providedToken = request.headers.get("X-Service-Token");
  if (providedToken === null) return false;
  return timingSafeEqual(providedToken, expectedToken);
}

export async function resolveEntitlements(email, env) {
  if (!email) return { tier: "anonymous", features: {} };

  if (isAdminEmail(email, env)) {
    return {
      tier: "admin",
      features: { research: true, radar: true, funds: true, signals: true },
    };
  }

  if (env.SHARED_DATA?.get) {
    const key = `member:${email.toLowerCase()}`;
    try {
      const record = await env.SHARED_DATA.get(key, "json");
      if (record != null) {
        if (
          typeof record === "object" &&
          !Array.isArray(record) &&
          typeof record.features === "object" &&
          record.features !== null &&
          !Array.isArray(record.features)
        ) {
          const features = {};
          for (const feature of FEATURES) {
            if (Object.hasOwn(record.features, feature) && typeof record.features[feature] === "boolean") {
              features[feature] = record.features[feature];
            }
          }
          return { tier: "member", features };
        }
        console.error(`[entitlements] Malformed KV record for ${key}`);
      }
    } catch (err) {
      console.error(`[entitlements] KV read failed for ${key}:`, err);
    }
  }

  if (isAnalyzeAllowedEmail(email, env)) {
    return { tier: "member", features: { research: true } };
  }

  return { tier: "visitor", features: {} };
}

export async function hasFeature(email, env, feature) {
  const { features } = await resolveEntitlements(email, env);
  return FEATURES.includes(feature) && Boolean(features[feature]);
}

export async function getResearchQuota(email, env) {
  if (isAdminEmail(email, env || {})) return { unmetered: true };
  if (!email || !env?.SHARED_DATA?.get) return { limit: DEFAULT_RESEARCH_QUOTA };

  const key = `member:${email.toLowerCase()}`;
  try {
    const record = await env.SHARED_DATA.get(key, "json");
    const quota = record?.researchQuota;
    if (
      typeof quota === "number" &&
      Number.isInteger(quota) &&
      quota >= 1 &&
      quota <= MAX_RESEARCH_QUOTA
    ) {
      return { limit: quota };
    }
  } catch (err) {
    console.error(`[entitlements] Research quota KV read failed for ${key}:`, err);
  }

  return { limit: DEFAULT_RESEARCH_QUOTA };
}

export async function getResearchUsage(email, env) {
  if (!email) return 0;
  return readResearchUsage(env?.SHARED_DATA, researchUsageKey(email));
}

export async function incrementResearchUsage(email, env) {
  if (!email) return 1;
  const key = researchUsageKey(email);
  const nextUsage = (await readResearchUsage(env?.SHARED_DATA, key)) + 1;
  if (!env?.SHARED_DATA?.put) return nextUsage;

  try {
    await env.SHARED_DATA.put(key, String(nextUsage), {
      expirationTtl: RESEARCH_USAGE_TTL_SECONDS,
    });
  } catch (err) {
    console.error(`[entitlements] Research usage KV write failed for ${key}:`, err);
  }
  return nextUsage;
}

export function nextMonthResetDate() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    .toISOString()
    .slice(0, 10);
}
