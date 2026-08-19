import { getAccessPayload } from "../functions/access-lib.js";

const b64url = value => Buffer.from(value).toString("base64url");

export async function createAccessFixture(prefix = "signals-test") {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const kid = `${prefix}-${crypto.randomUUID()}`;
  const teamDomain = `${prefix}-${crypto.randomUUID()}.example.com`;
  const accessAud = `${prefix}-aud-${crypto.randomUUID()}`;

  const createJwt = async ({ email, sub = `${prefix}-user` }) => {
    const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const payload = b64url(JSON.stringify({
      aud: accessAud,
      email,
      sub,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const input = `${head}.${payload}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(input),
    );
    return `${input}.${Buffer.from(signature).toString("base64url")}`;
  };

  return {
    teamDomain,
    accessAud,
    jwksUrl: `https://${teamDomain}/cdn-cgi/access/certs`,
    jwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
    createJwt,
  };
}

export async function warmAccessFixture(fixture, jwt) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    if (String(url) !== fixture.jwksUrl) {
      throw new Error(`Unexpected Access fixture request: ${url}`);
    }
    return Response.json({ keys: [fixture.jwk] });
  };

  try {
    const payload = await getAccessPayload(new Request("https://example.com/", {
      headers: { Cookie: `CF_Authorization=${jwt}` },
    }), {
      ACCESS_TEAM_DOMAIN: fixture.teamDomain,
      ACCESS_AUD: fixture.accessAud,
    });
    if (!payload) throw new Error("Access fixture failed verification");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

export function memberKv(email, features = { signals: true }) {
  const memberKey = `member:${email.toLowerCase()}`;
  return {
    async get(key, type) {
      if (key !== memberKey) return null;
      const record = { features };
      return type === "json" ? record : JSON.stringify(record);
    },
    async put() {},
  };
}
