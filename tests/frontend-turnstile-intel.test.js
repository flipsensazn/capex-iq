import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { intelEndpointForView } from "../src/hooks/useDashboardData.js";

const landingPath = new URL("../index.html", import.meta.url);

test("intel endpoint selection is limited to the active map view", () => {
  assert.equal(intelEndpointForView("ai"), "/capex-intel");
  assert.equal(intelEndpointForView("musk"), "/musk-intel");
  assert.equal(intelEndpointForView("robotics"), "/robotics-intel");
  for (const view of ["research", "earnings", "scanner", "unknown", null]) {
    assert.equal(intelEndpointForView(view), null);
  }
});

test("public registration requires the server-configured Turnstile challenge", async () => {
  const html = await readFile(landingPath, "utf8");

  assert.match(html, /https:\/\/challenges\.cloudflare\.com\/turnstile\/v0\/api\.js\?render=explicit/);
  assert.match(html, /data-action="turnstile-spin-v1"/);
  assert.match(html, /action:\s*"turnstile-spin-v1"/);
  assert.match(html, /fetchJsonWithTimeout\("\/register",\s*\{\s*headers:/);
  assert.match(html, /function fetchJsonWithTimeout[\s\S]*response\.json\(\)[\s\S]*clearTimeout\(timer\)/);
  assert.match(html, /JSON\.stringify\(\{ email: email, turnstileToken: turnstileToken \}\)/);
  assert.match(html, /turnstile\.reset\(turnstileWidgetId\)/);
  assert.doesNotMatch(html, /TURNSTILE_SECRET_KEY/);
  assert.doesNotMatch(html, /1x00000000000000000000AA/);
});

test("public registration success points to the free dashboard immediately", async () => {
  const html = await readFile(landingPath, "utf8");

  assert.ok(html.includes("Enter your email to join the list — the free dashboard is open to everyone, and membership unlocks the full signal stack."));
  assert.match(html, /<a class="btn btn-primary glow" href="\/app"[^>]*>Explore the free dashboard →<\/a>/);
  assert.match(html, /Already a member\? <a href="\/auth">Sign in<\/a>/);
  assert.match(html, /function showRegistrationSuccess\(message\)[\s\S]*activateMsg\.textContent = message;/);
  assert.match(html, /showRegistrationSuccess\(r\.data\.message\)/);
  assert.doesNotMatch(html, /countdown|60[- ]seconds?|setInterval|startActivation|armSignIn|regSignIn|activating your access/i);
  assert.doesNotMatch(html, /Click Sign In to continue with Google/);
});
