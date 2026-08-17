import assert from "node:assert/strict";
import test from "node:test";

import siteWorker from "../workers/site/index.js";

const SECURITY_HEADERS = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-src https://challenges.cloudflare.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};

const ctx = { waitUntil() {} };

function assetEnv(contentType) {
  return {
    ASSETS: {
      fetch: async () => new Response("<html></html>", {
        status: 203,
        statusText: "Non-Authoritative Information",
        headers: { "Content-Type": contentType },
      }),
    },
  };
}

function assertSecurityHeaders(response) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), value);
  }
}

test("GET /app adds security headers and preserves asset headers", async () => {
  const response = await siteWorker.fetch(
    new Request("https://capex-iq.us/app"),
    assetEnv("text/html"),
    ctx
  );

  assertSecurityHeaders(response);
  assert.equal(response.status, 203);
  assert.equal(response.statusText, "Non-Authoritative Information");
  assert.equal(response.headers.get("Content-Type"), "text/html");
  assert.equal(await response.text(), "<html></html>");
});

test("static assets receive security headers", async () => {
  const response = await siteWorker.fetch(
    new Request("https://capex-iq.us/assets/index-abc123.js"),
    assetEnv("text/javascript"),
    ctx
  );

  assertSecurityHeaders(response);
});

test("API responses are not decorated with static-asset security headers", async () => {
  const response = await siteWorker.fetch(
    new Request("https://capex-iq.us/prices?tickers=bad%20ticker"),
    {
      ASSETS: {
        fetch: async () => {
          throw new Error("API route unexpectedly fell through to assets");
        },
      },
    },
    ctx
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "Invalid ticker format");
  for (const name of Object.keys(SECURITY_HEADERS)) {
    assert.equal(response.headers.get(name), null);
  }
});
