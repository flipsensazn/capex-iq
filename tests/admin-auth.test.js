import assert from "node:assert/strict";
import test from "node:test";

import {
  isAuthorizedAdmin,
  isTrustedOrigin,
  verifyAdminPassword,
} from "../functions/access-lib.js";
import { onRequest as capex } from "../functions/capex.js";

const b64url = value => Buffer.from(value).toString("base64url");

const jsonRequest = (url, body, headers = {}) => new Request(url, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function createAccessJwt({ aud, email, sub }) {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const kid = `test-${crypto.randomUUID()}`;
  const head = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    aud,
    email,
    sub,
    exp: Math.floor(Date.now() / 1000) + 3600,
  }));
  const input = `${head}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(input)
  );
  return {
    jwt: `${input}.${Buffer.from(signature).toString("base64url")}`,
    jwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
  };
}

test("verifyAdminPassword accepts only the complete correct password", () => {
  const env = { ADMIN_PASSWORD: "correct-password" };

  assert.equal(verifyAdminPassword("correct-password", env), true);
  assert.equal(verifyAdminPassword("wrong-password", env), false);
  assert.equal(verifyAdminPassword("correct-pass", env), false);
  assert.equal(verifyAdminPassword("correct-passwore", env), false);
});

test("verifyAdminPassword rejects missing configuration and non-string input", () => {
  assert.equal(verifyAdminPassword("anything", {}), false);
  assert.equal(verifyAdminPassword("anything", { ADMIN_PASSWORD: "" }), false);

  const env = { ADMIN_PASSWORD: "correct-password" };
  assert.equal(verifyAdminPassword(undefined, env), false);
  assert.equal(verifyAdminPassword(null, env), false);
  assert.equal(verifyAdminPassword(123, env), false);
});

test("isTrustedOrigin validates Origin and Referer with local-dev degradation", () => {
  const env = { ALLOWED_ORIGIN: "https://capex-iq.us" };

  assert.equal(isTrustedOrigin(
    new Request("https://capex-iq.us/capex", { headers: { Origin: "https://capex-iq.us" } }),
    env
  ), true);
  assert.equal(isTrustedOrigin(
    new Request("https://capex-iq.us/capex", { headers: { Origin: "https://evil.example" } }),
    env
  ), false);
  assert.equal(isTrustedOrigin(
    new Request("https://capex-iq.us/capex", { headers: { Referer: "https://capex-iq.us/app" } }),
    env
  ), true);
  assert.equal(isTrustedOrigin(
    new Request("https://capex-iq.us/capex", { headers: { Referer: "not a URL" } }),
    env
  ), false);
  assert.equal(isTrustedOrigin(new Request("https://capex-iq.us/capex"), env), false);
  assert.equal(isTrustedOrigin(new Request("http://localhost/capex"), {}), true);
});

test("isAuthorizedAdmin preserves the headless scanner password path without Origin", async () => {
  const request = jsonRequest("https://capex-iq.us/gap-scanner", {
    password: "correct-password",
  });

  assert.equal(await isAuthorizedAdmin(
    request,
    {
      ADMIN_PASSWORD: "correct-password",
      ALLOWED_ORIGIN: "https://capex-iq.us",
    },
    "correct-password"
  ), true);
});

test("isAuthorizedAdmin rejects a valid admin JWT only when its Origin is foreign", { concurrency: false }, async () => {
  const teamDomain = `admin-auth-${crypto.randomUUID()}.example.com`;
  const accessAud = "admin-auth-audience";
  const { jwt, jwk } = await createAccessJwt({
    aud: accessAud,
    email: "admin@example.com",
    sub: "admin-123",
  });
  const env = {
    ACCESS_TEAM_DOMAIN: teamDomain,
    ACCESS_AUD: accessAud,
    ADMIN_EMAILS: "admin@example.com",
    ALLOWED_ORIGIN: "https://capex-iq.us",
  };
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async url => {
    assert.equal(String(url), `https://${teamDomain}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  };

  try {
    const attackerRequest = jsonRequest(
      "https://capex-iq.us/capex",
      { capexData: {} },
      {
        Cookie: `CF_Authorization=${jwt}`,
        Origin: "https://evil.example",
      }
    );
    const trustedRequest = jsonRequest(
      "https://capex-iq.us/capex",
      { capexData: {} },
      {
        Cookie: `CF_Authorization=${jwt}`,
        Origin: "https://capex-iq.us",
      }
    );

    assert.equal(await isAuthorizedAdmin(attackerRequest, env, undefined), false);
    assert.equal(await isAuthorizedAdmin(trustedRequest, env, undefined), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("POST /capex rejects a valid admin JWT from an attacker Origin without a KV write", { concurrency: false }, async () => {
  const teamDomain = `capex-csrf-${crypto.randomUUID()}.example.com`;
  const accessAud = "capex-csrf-audience";
  const { jwt, jwk } = await createAccessJwt({
    aud: accessAud,
    email: "admin@example.com",
    sub: "admin-456",
  });
  let putCalls = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async url => {
    assert.equal(String(url), `https://${teamDomain}/cdn-cgi/access/certs`);
    return Response.json({ keys: [jwk] });
  };

  try {
    const response = await capex({
      request: jsonRequest(
        "https://capex-iq.us/capex",
        { capexData: { version: 1 } },
        {
          Cookie: `CF_Authorization=${jwt}`,
          Origin: "https://evil.example",
        }
      ),
      env: {
        ACCESS_TEAM_DOMAIN: teamDomain,
        ACCESS_AUD: accessAud,
        ADMIN_EMAILS: "admin@example.com",
        ADMIN_PASSWORD: "configured-password",
        ALLOWED_ORIGIN: "https://capex-iq.us",
        SHARED_DATA: {
          put: async () => {
            putCalls += 1;
          },
        },
      },
    });

    assert.equal(response.status, 401);
    assert.equal(putCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
