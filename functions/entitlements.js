import { isAdminEmail, isAnalyzeAllowedEmail } from "./access-lib.js";

const FEATURES = ["research", "radar", "funds", "signals"];

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
