import assert from "node:assert/strict";
import test from "node:test";

import siteWorker from "../workers/site/index.js";

test("GET /auth serves a no-store handoff that redirects to /app", async () => {
  const response = await siteWorker.fetch(
    new Request("https://capex-iq.us/auth"),
    {
      ASSETS: {
        fetch: async () => {
          throw new Error("/auth unexpectedly fell through to static assets");
        },
      },
    },
    { waitUntil() {} }
  );
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
  assert.ok(html.includes('<meta http-equiv="refresh" content="0;url=/app">'));
  assert.ok(html.includes('location.replace("/app")'));
  assert.ok(html.includes('<a href="/app">Continuing to CAPEX-IQ…</a>'));
});
