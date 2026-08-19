import assert from "node:assert/strict";
import test from "node:test";

import {
  getResearchQuota,
  getResearchUsage,
  hasFeature,
  incrementResearchUsage,
  nextMonthResetDate,
  resolveEntitlements,
} from "../functions/entitlements.js";

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
    features: { research: true, radar: true, funds: true, signals: true },
  });
});

test("KV member records grant features independently and override the legacy fallback", async () => {
  const gets = [];
  const env = envWithRecord({ features: { radar: true, signals: true } }, {
    ANALYZE_ALLOWED_EMAILS: "member@example.com",
    SHARED_DATA: {
      get: async (...args) => {
        gets.push(args);
        return { features: { radar: true, signals: true } };
      },
    },
  });

  const result = await resolveEntitlements("MEMBER@example.com", env);

  assert.deepEqual(result, {
    tier: "member",
    features: { radar: true, signals: true },
  });
  assert.equal(Boolean(result.features.research), false);
  assert.deepEqual(gets, [["member:member@example.com", "json"]]);
});

test("KV feature records keep only approved boolean values", async () => {
  const result = await resolveEntitlements("member@example.com", envWithRecord({
    features: {
      research: true,
      radar: "true",
      funds: false,
      signals: true,
      unknown: true,
    },
  }));

  assert.deepEqual(result, {
    tier: "member",
    features: { research: true, funds: false, signals: true },
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
  const env = {
    ADMIN_EMAILS: "admin@example.com",
    ANALYZE_ALLOWED_EMAILS: "other@example.com, MEMBER@EXAMPLE.COM ",
  };
  const result = await resolveEntitlements("member@example.com", env);

  assert.deepEqual(result, {
    tier: "member",
    features: { research: true },
  });
  assert.equal(await hasFeature("member@example.com", env, "signals"), false);
});

test("unentitled identities are visitors", async () => {
  assert.deepEqual(await resolveEntitlements("visitor@example.com", envWithRecord(null)), {
    tier: "visitor",
    features: {},
  });
});

test("hasFeature returns false for unknown feature names", async () => {
  const env = envWithRecord({
    features: { research: true, radar: true, funds: true, signals: true },
  });

  assert.equal(await hasFeature("member@example.com", env, "unknown"), false);
  assert.equal(await hasFeature("member@example.com", env, "toString"), false);
});

test("research quota defaults to 50 when KV or the member record is absent", async () => {
  assert.deepEqual(await getResearchQuota("member@example.com", { ADMIN_EMAILS: "" }), {
    limit: 50,
  });
  assert.deepEqual(await getResearchQuota("member@example.com", envWithRecord(null)), {
    limit: 50,
  });
});

test("research quota honors numeric integer member overrides within bounds", async () => {
  const gets = [];
  const env = envWithRecord({ researchQuota: 275 }, {
    SHARED_DATA: {
      get: async (...args) => {
        gets.push(args);
        return { researchQuota: 275 };
      },
    },
  });

  assert.deepEqual(await getResearchQuota("MEMBER@example.com", env), { limit: 275 });
  assert.deepEqual(gets, [["member:member@example.com", "json"]]);
  assert.deepEqual(await getResearchQuota("member@example.com", envWithRecord({ researchQuota: 1 })), { limit: 1 });
  assert.deepEqual(await getResearchQuota("member@example.com", envWithRecord({ researchQuota: 10000 })), { limit: 10000 });
});

test("research quota rejects out-of-bounds and non-numeric overrides", async () => {
  for (const researchQuota of [0, -1, 1.5, 10001, "200", null, Number.NaN]) {
    assert.deepEqual(
      await getResearchQuota("member@example.com", envWithRecord({ researchQuota })),
      { limit: 50 }
    );
  }
});

test("admins have unmetered research without a KV read", async () => {
  const env = envWithRecord(null, {
    ADMIN_EMAILS: "other@example.com, ADMIN@EXAMPLE.COM",
    SHARED_DATA: { get: async () => { throw new Error("KV should not be read"); } },
  });

  assert.deepEqual(await getResearchQuota("admin@example.com", env), { unmetered: true });
});

test("research usage keys use the lowercased email and UTC month", { concurrency: false }, async () => {
  const NativeDate = globalThis.Date;
  const fixedNow = NativeDate.parse("2026-01-01T00:30:00.000Z");
  let usageKey;
  globalThis.Date = class extends NativeDate {
    constructor(...args) {
      super(...(args.length === 0 ? [fixedNow] : args));
    }

    static now() {
      return fixedNow;
    }
  };

  try {
    const used = await getResearchUsage("MEMBER@example.com", {
      SHARED_DATA: {
        get: async key => {
          usageKey = key;
          return "7";
        },
      },
    });

    assert.equal(used, 7);
    assert.equal(usageKey, "usage:member@example.com:2026-01");
    assert.equal(nextMonthResetDate(), "2026-02-01");
  } finally {
    globalThis.Date = NativeDate;
  }
});

test("incrementResearchUsage snapshots the month and writes the next value with a 62-day TTL", { concurrency: false }, async () => {
  const NativeDate = globalThis.Date;
  const january = NativeDate.parse("2026-01-31T23:59:59.999Z");
  const february = NativeDate.parse("2026-02-01T00:00:00.000Z");
  let clockReads = 0;
  let getKey;
  const puts = [];
  const env = {
    SHARED_DATA: {
      get: async key => {
        getKey = key;
        return "4";
      },
      put: async (...args) => puts.push(args),
    },
  };
  globalThis.Date = class extends NativeDate {
    constructor(...args) {
      super(...(args.length === 0 ? [clockReads++ === 0 ? january : february] : args));
    }
  };

  try {
    assert.equal(await incrementResearchUsage("Member@example.com", env), 5);
    assert.equal(getKey, "usage:member@example.com:2026-01");
    assert.deepEqual(puts, [[
      "usage:member@example.com:2026-01",
      "5",
      { expirationTtl: 62 * 24 * 60 * 60 },
    ]]);
  } finally {
    globalThis.Date = NativeDate;
  }
});

test("research usage reads return zero when absent, malformed, or failed", { concurrency: false }, async () => {
  const originalConsoleError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);

  try {
    for (const value of [null, "", "not-a-number", "-1", "1.5"]) {
      assert.equal(await getResearchUsage("member@example.com", {
        SHARED_DATA: { get: async () => value },
      }), 0);
    }

    const used = await getResearchUsage("member@example.com", {
      SHARED_DATA: { get: async () => { throw new Error("KV unavailable"); } },
    });

    assert.equal(used, 0);
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
});
