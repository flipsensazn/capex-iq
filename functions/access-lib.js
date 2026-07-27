// functions/access-lib.js
//
// Cloudflare Access (Zero Trust) JWT verification, shared by /me and the
// admin-gated endpoints. NOT a routed endpoint — the site Worker's router
// only maps files listed in its ROUTES table.
//
// How auth works here:
//   - Cloudflare Access protects capex-iq.us/app at the EDGE (One-time PIN
//     to emails in the Members/Admins groups). Users who pass get a
//     CF_Authorization cookie scoped to the whole domain.
//   - API endpoints are NOT edge-protected (the prewarm Worker and local
//     digest need public reads), so anything trusting an identity must
//     verify the JWT itself: signature against the team's public JWKS,
//     audience against the Access app's AUD, and expiry.
//   - env.ACCESS_TEAM_DOMAIN / env.ACCESS_AUD unset → verification is
//     disabled and every helper degrades to "no identity".

const b64urlToBytes = (s) => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};

const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

// JWKS cached per-isolate; Access rotates keys rarely.
let jwksCache = { teamDomain: null, keys: null, fetchedAt: 0 };
const JWKS_TTL_MS = 6 * 60 * 60 * 1000;

async function getJwks(teamDomain) {
  const now = Date.now();
  if (jwksCache.keys && jwksCache.teamDomain === teamDomain && now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) return null;
  const { keys } = await res.json();
  jwksCache = { teamDomain, keys, fetchedAt: now };
  return keys;
}

function extractToken(request) {
  // Header is present on edge-protected paths; the cookie rides along on
  // every same-domain request once the user has authenticated anywhere.
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) return header;
  const cookies = request.headers.get("Cookie") || "";
  const m = cookies.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? m[1] : null;
}

// Verify the Access JWT on this request → payload ({email, aud, exp, ...})
// or null. Never throws.
export async function getAccessPayload(request, env) {
  try {
    const teamDomain = env.ACCESS_TEAM_DOMAIN;
    const aud = env.ACCESS_AUD;
    if (!teamDomain || !aud) return null;

    const token = extractToken(request);
    if (!token) return null;

    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headB64, payloadB64, sigB64] = parts;
    const head = b64urlToJson(headB64);
    const payload = b64urlToJson(payloadB64);

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(aud)) return null;
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;

    const keys = await getJwks(teamDomain);
    const jwk = keys?.find(k => k.kid === head.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5", key,
      b64urlToBytes(sigB64),
      new TextEncoder().encode(`${headB64}.${payloadB64}`));

    return valid ? payload : null;
  } catch (err) {
    return null;
  }
}

export function isAdminEmail(email, env) {
  if (!email || !env.ADMIN_EMAILS) return false;
  return env.ADMIN_EMAILS.split(",").map(e => e.trim().toLowerCase()).filter(Boolean)
    .includes(email.toLowerCase());
}

// True when the request came from the configured browser origin. When
// ALLOWED_ORIGIN is unset, preserve the handlers' existing local-dev/CORS
// degradation and allow the request.
export function isTrustedOrigin(request, env) {
  if (!env.ALLOWED_ORIGIN) return true;

  const origin = request.headers.get("Origin");
  if (origin) return origin === env.ALLOWED_ORIGIN;

  const referer = request.headers.get("Referer");
  if (referer) {
    try {
      return new URL(referer).origin === env.ALLOWED_ORIGIN;
    } catch {
      return false;
    }
  }

  return false;
}

// Compare the supplied password without short-circuiting on differing bytes.
export function verifyAdminPassword(provided, env) {
  if (!env.ADMIN_PASSWORD || typeof provided !== "string") return false;

  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(env.ADMIN_PASSWORD);
  if (providedBytes.length !== expectedBytes.length) return false;

  let diff = 0;
  for (let i = 0; i < expectedBytes.length; i++) {
    diff |= providedBytes[i] ^ expectedBytes[i];
  }
  return diff === 0;
}

// True when this request carries a valid Access JWT for an admin email.
// Used as the passwordless alternative in the admin-gated endpoints.
export async function isAdminRequest(request, env) {
  const payload = await getAccessPayload(request, env);
  return isAdminEmail(payload?.email, env);
}

// Password clients are headless and do not need browser-origin checks. Access
// cookie/JWT clients use ambient credentials, so require a trusted origin.
export async function isAuthorizedAdmin(request, env, providedPassword) {
  if (verifyAdminPassword(providedPassword, env)) return true;
  if (!isTrustedOrigin(request, env)) return false;
  return await isAdminRequest(request, env);
}
