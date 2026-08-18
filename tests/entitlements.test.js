import assert from "node:assert/strict";
import test from "node:test";

import { hasFeature, resolveEntitlements } from "../functions/entitlements.js";

function envWithRecord(record, overrides = {}) {
  return {
    ADMIN_EMAILS: "",
    ANALYZE_ALLOWED_EMAILS: "",
    SHARED_DATA: { get: async () => record },
    ...overrides,
  };
}

test("anonymous identities have no entitlements", async () => {
  const env = envWithRecord({ features: { research: true } });

  assert.deepEqual(await resolveEntitlements(null, env), {
    tier: "anonymous",
    features: {},
  });
  assert.deepEqual(await resolveEntitlements("", env), {
    tier: "anonymous",
    features: {},
  });
});

test("admins implicitly receive every feature", async () => {
  const env = envWithRecord(null, {
    ADMIN_EMAILS: "other@example.com, ADMIN@EXAMPLE.COM ",
    SHARED_DATA: { get: async () => { throw new Error("KV should not be read"); } },
  });

  assert.deepEqual(await resolveEntitlements("admin@example.com", env), {
    tier: "admin",
    features: { research: true, radar: true, funds: true },
  });
});

test("KV member records grant features independently and override the legacy fallback", async () => {
  const gets = [];
  const env = envWithRecord({ features: { radar: true } }, {
    ANALYZE_ALLOWED_EMAILS: "member@example.com",
    SHARED_DATA: {
      get: async (...args) => {
        gets.push(args);
        return { features: { radar: true } };
      },
    },
  });

  const result = await resolveEntitlements("MEMBER@example.com", env);

  assert.deepEqual(result, { tier: "member", features: { radar: true } });
  assert.equal(Boolean(result.features.research), false);
  assert.deepEqual(gets, [["member:member@example.com", "json"]]);
});

test("KV feature records keep only approved boolean values", async () => {
  const result = await resolveEntitlements("member@example.com", envWithRecord({
    features: {
      research: true,
      radar: "true",
      funds: false,
      unknown: true,
    },
  }));

  assert.deepEqual(result, {
    tier: "member",
    features: { research: true, funds: false },
  });
});

test("malformed KV string records log once and fall through to the legacy fallback", { concurrency: false }, async () => {
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);

  try {
    const result = await resolveEntitlements("member@example.com", envWithRecord(
      '{"features":',
      { ANALYZE_ALLOWED_EMAILS: "member@example.com" }
    ));

    assert.deepEqual(result, {
      tier: "member",
      features: { research: true },
    });
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
});

test("KV read errors log once and fall through without crashing", { concurrency: false }, async () => {
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);

  try {
    const result = await resolveEntitlements("member@example.com", envWithRecord(null, {
      ANALYZE_ALLOWED_EMAILS: "member@example.com",
      SHARED_DATA: { get: async () => { throw new Error("KV unavailable"); } },
    }));

    assert.deepEqual(result, {
      tier: "member",
      features: { research: true },
    });
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
});

test("legacy allow-list members receive research only when KV is unavailable", async () => {
  const result = await resolveEntitlements("member@example.com", {
    ADMIN_EMAILS: "admin@example.com",
    ANALYZE_ALLOWED_EMAILS: "other@example.com, MEMBER@EXAMPLE.COM ",
  });

  assert.deepEqual(result, {
    tier: "member",
    features: { research: true },
  });
});

test("unentitled identities are visitors", async () => {
  assert.deepEqual(await resolveEntitlements("visitor@example.com", envWithRecord(null)), {
    tier: "visitor",
    features: {},
  });
});

test("hasFeature returns false for unknown feature names", async () => {
  const env = envWithRecord({ features: { research: true, radar: true, funds: true } });

  assert.equal(await hasFeature("member@example.com", env, "unknown"), false);
  assert.equal(await hasFeature("member@example.com", env, "toString"), false);
});
