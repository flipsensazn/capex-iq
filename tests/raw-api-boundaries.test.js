import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeExposureRow,
  onRequest as exposureRequest,
} from "../functions/exposure.js";
import {
  attachStressTrend,
  normalizeStressRow,
  onRequest as stressRequest,
} from "../functions/stress.js";
import {
  comparableStressTrendDelta,
  computeStrength,
  enrichEdges,
} from "../src/components/capex-map/supplyGraphData.js";
import {
  createAccessFixture,
  memberKv,
  warmAccessFixture,
} from "./access-fixture.js";

const NOW = Date.parse("2026-08-17T23:59:59Z");
const MEMBER_EMAIL = "member@example.com";
const access = await createAccessFixture("raw-api-boundaries");
const memberJwt = await access.createJwt({ email: MEMBER_EMAIL });
await warmAccessFixture(access, memberJwt);
const ENV = {
  ACCESS_TEAM_DOMAIN: access.teamDomain,
  ACCESS_AUD: access.accessAud,
  ADMIN_EMAILS: "admin@example.com",
  DATABASE_URL: "postgresql://example.neon.tech/watchlist",
  ALLOWED_ORIGIN: "https://capex.example",
  SHARED_DATA: memberKv(MEMBER_EMAIL),
};

function request(path) {
  return new Request(`https://capex.example${path}`, {
    headers: {
      Origin: ENV.ALLOWED_ORIGIN,
      Cookie: `CF_Authorization=${memberJwt}`,
    },
  });
}

function queryFrom(init) {
  return JSON.parse(init.body).query;
}

function manifestRow(pipeline) {
  return {
    pipeline,
    run_id: `${pipeline}-run`,
    run_date: "2026-08-17",
    state: "success",
    started_at: "2026-08-17T10:00:00Z",
    finished_at: "2026-08-17T10:05:00Z",
    run_data_fresh_at: "2026-08-17T10:05:00Z",
    last_data_fresh_at: "2026-08-17T10:05:00Z",
    expected: "4",
    attempted: "4",
    usable: "4",
    known_no_data: "0",
    transient_failures: "0",
    degraded: "0",
    provider_coverage: "1",
    usable_coverage: "1",
    baseline_usable: "4",
    error_message: null,
    details: {},
  };
}

function stressRow(overrides = {}) {
  return {
    ticker: "TEST",
    fiscal_year: 2026,
    fiscal_quarter: 2,
    call_date: "2026-08-17",
    stress_score: "88",
    lexicon_score: "42",
    lexicon_hits: 7,
    direction: "constrained_supplier",
    summary: "Capacity remains constrained.",
    quotes: ["Capacity remains constrained."],
    provider: "defeatbeta",
    model: "gemini-2.5-flash",
    analyzed_at: "2026-08-17T10:00:00Z",
    rn: "1",
    ...overrides,
  };
}

function exposureRow(overrides = {}) {
  return {
    ticker: "SUP",
    customer_label: "Customer A",
    customer_ticker: "BUY",
    pct: "35",
    basis: "revenue",
    period: "year ended February 13, 2025",
    period_end: "2025-02-13",
    source_form: "10-K",
    source_accession: "0000000000-26-000001",
    statement_type: "single_customer",
    quote: "Customer A represented 35% of revenue.",
    extracted_at: "2026-08-17T10:00:00Z",
    ...overrides,
  };
}

test("stress score periods use UTC calendar boundaries and fail closed", () => {
  const invalid = [
    [null, "missing_source_period_end"],
    ["2026-02-30", "invalid_source_period_end"],
    ["2026-08-17-garbage", "invalid_source_period_end"],
    ["2026-08-17T00:00:00Z", "invalid_source_period_end"],
    ["2026-08-25", "future_source_period"],
    ["2025-08-16", "stale_source_period"],
  ];

  for (const [callDate, code] of invalid) {
    const row = normalizeStressRow(stressRow({ call_date: callDate }), NOW);
    assert.equal(row.scorePeriodEligible, false);
    assert.equal(row.scorePeriodExclusions[0].code, code);
    assert.equal(row.stressScore, null);
    assert.equal(row.lexiconScore, null);
    assert.equal(row.direction, null);
    assert.equal(row.lexiconHits, 7);
    assert.deepEqual(
      computeStrength([{ id: "TEST" }], { TEST: { latest: row } }),
      { TEST: 0 },
    );
  }

  const missingProvider = normalizeStressRow(stressRow({ provider: null }), NOW);
  assert.equal(missingProvider.scorePeriodEligible, false);
  assert.equal(
    missingProvider.scorePeriodExclusions[0].code,
    "missing_source_provider",
  );
  assert.equal(missingProvider.stressScore, null);
  assert.deepEqual(
    computeStrength(
      [{ id: "TEST" }],
      { TEST: { latest: missingProvider } },
    ),
    { TEST: 0 },
  );

  for (const callDate of ["2026-08-24", "2025-08-17"]) {
    const row = normalizeStressRow(stressRow({ call_date: callDate }), NOW);
    assert.equal(row.scorePeriodEligible, true);
    assert.equal(row.stressScore, 88);
    assert.deepEqual(
      computeStrength([{ id: "TEST" }], { TEST: { latest: row } }),
      { TEST: 88 },
    );
  }
});

test("stress trend deltas require the same stable model/provider methodology", () => {
  const latest = normalizeStressRow(stressRow({ stress_score: 80 }), NOW);
  const same = normalizeStressRow(stressRow({
    fiscal_quarter: 1,
    stress_score: 50,
  }), NOW);
  const changedModel = normalizeStressRow(stressRow({
    fiscal_quarter: 1,
    stress_score: 50,
    model: "gemini-3-flash",
  }), NOW);
  const changedProvider = normalizeStressRow(stressRow({
    fiscal_quarter: 1,
    stress_score: 50,
    provider: "api-ninjas",
  }), NOW);
  const missingProvider = normalizeStressRow(stressRow({
    fiscal_quarter: 1,
    stress_score: 50,
    provider: null,
  }), NOW);

  assert.match(latest.sourceMethodology, /model=gemini-2.5-flash/);
  assert.match(latest.sourceMethodology, /provider=defeatbeta/);
  assert.deepEqual(
    attachStressTrend({ latest, prev: same }),
    { latest, prev: same, trendComparable: true, trendDelta: 30 },
  );
  for (const prev of [changedModel, changedProvider, missingProvider]) {
    const snapshot = attachStressTrend({ latest, prev });
    assert.equal(snapshot.trendComparable, false);
    assert.equal(snapshot.trendDelta, null);
    assert.equal(comparableStressTrendDelta(snapshot), null);
  }
  assert.equal(
    comparableStressTrendDelta({
      latest: { stressScore: 80 },
      prev: { stressScore: 50 },
    }),
    null,
  );
  assert.equal(comparableStressTrendDelta({ trendDelta: 30 }), 30);
});

test("the stress endpoint cannot feed missing, future, or stale scores into the graph", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const rows = [
    stressRow({ ticker: "MISSING", call_date: null }),
    stressRow({ ticker: "FUTURE", call_date: "2026-08-25" }),
    stressRow({ ticker: "STALE", call_date: "2025-08-16" }),
    stressRow({ ticker: "VALID", call_date: "2026-08-17" }),
    stressRow({ ticker: "CHANGE", call_date: "2026-08-17", stress_score: "80" }),
    stressRow({
      ticker: "CHANGE",
      call_date: "2026-05-01",
      fiscal_quarter: 1,
      stress_score: "40",
      model: "gemini-3-flash",
      rn: "2",
    }),
  ];
  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    if (query.includes("etl_run_manifest")) {
      return Response.json({ rows: [manifestRow("transcript_stress")] });
    }
    assert.match(query, /provider/);
    assert.match(query, /model/);
    return Response.json({ rows });
  };

  const response = await stressRequest({
    request: request("/stress"),
    env: ENV,
    now: NOW,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.CHANGE.trendComparable, false);
  assert.equal(body.data.CHANGE.trendDelta, null);
  assert.equal(body.data.STALE.latest.scorePeriodExclusions[0].code, "stale_source_period");
  assert.deepEqual(
    computeStrength(
      ["MISSING", "FUTURE", "STALE", "VALID"].map(id => ({ id })),
      body.data,
    ),
    { MISSING: 0, FUTURE: 0, STALE: 0, VALID: 88 },
  );
});

test("exposure periods use UTC calendar boundaries and retain excluded audit rows", () => {
  const valid = normalizeExposureRow(exposureRow(), NOW);
  const toleratedFuture = normalizeExposureRow(
    exposureRow({ period_end: "2026-08-24" }), NOW,
  );
  assert.equal(valid.scorePeriodEligible, true);
  assert.equal(toleratedFuture.scorePeriodEligible, true);

  for (const [periodEnd, code] of [
    [null, "missing_source_period_end"],
    ["2026-02-30", "invalid_source_period_end"],
    ["2026-08-17-garbage", "invalid_source_period_end"],
    ["2026-08-17T00:00:00Z", "invalid_source_period_end"],
    ["2026-08-25", "future_source_period"],
    ["2025-02-12", "stale_source_period"],
  ]) {
    const row = normalizeExposureRow(exposureRow({ period_end: periodEnd }), NOW);
    assert.equal(row.scorePeriodEligible, false);
    assert.equal(row.scorePeriodExclusions[0].code, code);
  }
});

test("the exposure endpoint excludes ineligible rows from scoring and graph weights", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const rows = [
    exposureRow({ ticker: "VALID" }),
    exposureRow({ ticker: "MISSING", period_end: null }),
    exposureRow({ ticker: "FUTURE", period_end: "2026-08-25" }),
    exposureRow({ ticker: "STALE", period_end: "2025-02-12" }),
  ];
  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    if (query.includes("etl_run_manifest")) {
      return Response.json({ rows: [manifestRow("customer_exposure")] });
    }
    assert.match(query, /= 'single_customer'/);
    return Response.json({ rows });
  };

  const response = await exposureRequest({
    request: request("/exposure"),
    env: ENV,
    now: NOW,
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.data.VALID.topRevenuePct, 35);
  assert.equal(body.data.VALID.customers.length, 1);

  const edges = ["VALID", "MISSING", "FUTURE", "STALE"].map(from => ({
    from,
    to: "BUY",
    what: "capacity",
    criticality: 1,
  }));
  const enriched = enrichEdges(edges, body.data);
  assert.equal(enriched[0].exposurePct, 35);
  for (const [index, ticker] of ["MISSING", "FUTURE", "STALE"].entries()) {
    const exposure = body.data[ticker];
    assert.equal(exposure.topRevenuePct, null);
    assert.deepEqual(exposure.customers, []);
    assert.equal(exposure.excludedCustomers.length, 1);
    assert.equal(enriched[index + 1].exposurePct, undefined);
  }

  const legacy = enrichEdges([edges[0]], {
    VALID: {
      customers: [{ ticker: "BUY", basis: "revenue", pct: 99 }],
    },
  });
  assert.equal(legacy[0].exposurePct, undefined);
});
