import { isAdminEmail, isAnalyzeAllowedEmail } from "./access-lib.js";

const FEATURES = ["research", "radar", "funds"];

export async function resolveEntitlements(email, env) {
  if (!email) return { tier: "anonymous", features: {} };

  if (isAdminEmail(email, env)) {
    return {
      tier: "admin",
      features: { research: true, radar: true, funds: true },
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
