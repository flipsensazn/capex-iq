import assert from "node:assert/strict";
import test from "node:test";

import {
  inputVintageAdvanced,
  onRequest as compositeRequest,
} from "../functions/composite.js";
import { buildDataHealth } from "../functions/data-health.js";
import { onRequest as exposureRequest } from "../functions/exposure.js";
import { normalizeGaugeRow, onRequest as gaugesRequest } from "../functions/gauges.js";
import { onRequest as scoreboardRequest } from "../functions/scoreboard.js";
import { onRequest as stressRequest } from "../functions/stress.js";
import {
  buildDashboardDataNotice,
  DASHBOARD_HEALTH_REFRESH_MS,
  DASHBOARD_DATASETS,
  fetchDashboardDataset,
  normalizeDatasetHealth,
  startDashboardRefreshLoop,
} from "../src/hooks/useDashboardData.js";
import { computeStrength } from "../src/components/capex-map/supplyGraphData.js";
import {
  createAccessFixture,
  memberKv,
  warmAccessFixture,
} from "./access-fixture.js";

const MEMBER_EMAIL = "member@example.com";
const access = await createAccessFixture("data-health");
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
const HEALTH_AWARE_DATA_CACHE = "private, max-age=300";
const BOOTSTRAP_CACHE = "private, max-age=300";
const NO_STORE = "no-store";
const ENDPOINTS = [
  [stressRequest, "/stress"],
  [gaugesRequest, "/gauges"],
  [exposureRequest, "/exposure"],
  [compositeRequest, "/composite"],
  [scoreboardRequest, "/scoreboard"],
];

function request(path, method = "GET") {
  return new Request(`https://capex.example${path}`, {
    method,
    headers: {
      Origin: ENV.ALLOWED_ORIGIN,
      Cookie: `CF_Authorization=${memberJwt}`,
    },
  });
}

function queryFrom(init) {
  return JSON.parse(init.body).query;
}

function manifestRow(query, overrides = {}) {
  const pipeline = query.match(/WHERE pipeline = '([^']+)'/)?.[1];
  return {
    pipeline,
    run_id: `${pipeline}-run`,
    run_date: "2099-01-02",
    state: "success",
    started_at: "2099-01-02T10:00:00Z",
    finished_at: "2099-01-02T10:05:00Z",
    run_data_fresh_at: "2099-01-02T10:05:00Z",
    last_data_fresh_at: "2099-01-02T10:05:00Z",
    expected: "10",
    attempted: "10",
    usable: "9",
    known_no_data: "1",
    transient_failures: "0",
    degraded: "0",
    provider_coverage: "1",
    usable_coverage: "1",
    baseline_usable: "9",
    error_message: null,
    details: {},
    ...overrides,
  };
}

test("data health preserves the latest failed state and last good freshness", () => {
  const health = buildDataHealth({
    pipeline: "transcript_stress",
    manifest: {
      available: true,
      row: manifestRow("WHERE pipeline = 'transcript_stress'", {
        state: "failure",
        run_data_fresh_at: null,
        last_data_fresh_at: "2026-08-16T12:00:00Z",
        error_message: "provider https://user:secret@example.test failed token=abc123",
      }),
    },
    fallbackAsOf: "2026-07-01T00:00:00Z",
    staleAfterHours: 9 * 24,
    now: Date.parse("2026-08-17T12:00:00Z"),
  });

  assert.equal(health.state, "failure");
  assert.equal(health.asOf, "2026-08-16T12:00:00Z");
  assert.equal(health.dataFreshAt, health.asOf);
  assert.equal(health.stale, false);
  assert.deepEqual(health.counts, {
    expected: 10,
    attempted: 10,
    usable: 9,
    knownNoData: 1,
    transientFailures: 0,
    degraded: 0,
    baselineUsable: 9,
  });
  // Public manifests must never echo provider-authored text: the error is
  // classified into a fixed category, not redacted in place.
  assert.doesNotMatch(health.error, /user:secret|abc123|example\.test/);
  assert.match(health.error, /See operator logs for detail/);
});

test("expired running manifests fail closed while fresh runs remain in progress", () => {
  const now = Date.parse("2026-08-17T12:00:00Z");
  const base = {
    available: true,
    row: manifestRow("WHERE pipeline = 'xbrl_gauges'", {
      state: "running",
      last_data_fresh_at: "2026-08-10T12:00:00Z",
      run_data_fresh_at: null,
      finished_at: null,
    }),
  };
  const fresh = buildDataHealth({
    pipeline: "xbrl_gauges",
    manifest: { ...base, row: { ...base.row, started_at: "2026-08-17T11:00:00Z" } },
    staleAfterHours: 9 * 24,
    now,
  });
  const expired = buildDataHealth({
    pipeline: "xbrl_gauges",
    manifest: { ...base, row: { ...base.row, started_at: "2026-08-17T08:00:00Z" } },
    staleAfterHours: 9 * 24,
    now,
  });

  assert.equal(fresh.state, "running");
  assert.equal(fresh.runningExpired, false);
  assert.equal(expired.state, "failure");
  assert.equal(expired.runningExpired, true);
  assert.equal(expired.asOf, "2026-08-10T12:00:00Z");
  assert.match(expired.error, /exceeded its expected execution window/i);
});

test("limited smoke runs preserve full-run freshness and remain visibly partial", () => {
  const health = buildDataHealth({
    pipeline: "xbrl_gauges",
    manifest: {
      available: true,
      row: manifestRow("WHERE pipeline = 'xbrl_gauges'", {
        run_data_fresh_at: "2026-08-17T12:00:00Z",
        last_data_fresh_at: "2026-08-10T12:00:00Z",
        details: { limitedRun: true },
      }),
    },
    fallbackAsOf: "2026-08-17T12:00:00Z",
    staleAfterHours: 9 * 24,
    now: Date.parse("2026-08-17T13:00:00Z"),
  });
  const normalized = normalizeDatasetHealth(health);
  const healthy = Object.fromEntries(Object.keys(DASHBOARD_DATASETS).map(key => [key, {
    loading: false,
    error: null,
    state: "success",
    stale: false,
    asOf: "2026-08-17T12:00:00Z",
    limitedRun: false,
  }]));
  const notice = buildDashboardDataNotice({
    ...healthy,
    gauges: normalized,
  });

  assert.equal(health.limitedRun, true);
  assert.equal(health.asOf, "2026-08-10T12:00:00Z");
  assert.equal(normalized.limitedRun, true);
  assert.match(notice.message, /limited smoke-test universe/);
  assert.match(notice.message, /last full data 2026-08-10/);
});

test("failed limited runs report the failure before the limited scope", () => {
  const healthy = Object.fromEntries(Object.keys(DASHBOARD_DATASETS).map(key => [key, {
    loading: false,
    error: null,
    state: "success",
    stale: false,
    asOf: "2026-08-17T12:00:00Z",
    limitedRun: false,
  }]));
  const notice = buildDashboardDataNotice({
    ...healthy,
    gauges: {
      ...healthy.gauges,
      state: "failure",
      asOf: "2026-08-10T12:00:00Z",
      limitedRun: true,
    },
  });

  assert.match(notice.message, /gauges refresh failed/i);
  assert.match(notice.message, /last good data 2026-08-10/i);
  assert.match(notice.message, /latest attempt covered only a limited smoke-test universe/i);
});

test("dashboard health refresh loop polls visible tabs and aborts on cleanup", async () => {
  const listeners = new Map();
  const documentImpl = {
    hidden: false,
    addEventListener: (name, listener) => listeners.set(name, listener),
    removeEventListener: (name, listener) => {
      if (listeners.get(name) === listener) listeners.delete(name);
    },
  };
  let intervalCallback;
  let intervalMs;
  let cleared = null;
  const signals = [];
  const stop = startDashboardRefreshLoop({
    refresh: async signal => { signals.push(signal); },
    documentImpl,
    setIntervalImpl: (callback, delay) => {
      intervalCallback = callback;
      intervalMs = delay;
      return 17;
    },
    clearIntervalImpl: id => { cleared = id; },
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(signals.length, 1);
  assert.equal(intervalMs, DASHBOARD_HEALTH_REFRESH_MS);
  documentImpl.hidden = true;
  intervalCallback();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals.length, 1);

  documentImpl.hidden = false;
  listeners.get("visibilitychange")();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signals.length, 2);
  stop();
  assert.equal(cleared, 17);
  assert.equal(listeners.has("visibilitychange"), false);

  let activeSignal;
  const stopPending = startDashboardRefreshLoop({
    refresh: signal => new Promise(() => { activeSignal = signal; }),
    documentImpl,
    setIntervalImpl: () => 18,
    clearIntervalImpl: () => {},
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(activeSignal.aborted, false);
  stopPending();
  assert.equal(activeSignal.aborted, true);
});

test("stress remains compatible before the manifest migration and reports inferred health", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    if (query.includes("etl_run_manifest")) {
      return new Response(
        JSON.stringify({ code: "42P01", message: 'relation "etl_run_manifest" does not exist' }),
        { status: 400 }
      );
    }
    assert.match(query, /FROM transcript_stress/);
    return Response.json({ rows: [{
      ticker: "NVDA",
      fiscal_year: 2098,
      fiscal_quarter: 4,
      call_date: "2026-08-16",
      stress_score: "72.5",
      lexicon_score: "31",
      lexicon_hits: 4,
      direction: "constrained_supplier",
      summary: "Lead times remain extended.",
      quotes: ["Lead times remain extended."],
      provider: "defeatbeta",
      model: "gemini-2.5-flash",
      analyzed_at: "2099-01-02T12:00:00Z",
      rn: "1",
    }] });
  };

  const response = await stressRequest({
    request: request("/stress"),
    env: ENV,
    now: Date.parse("2026-08-17T12:00:00Z"),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), HEALTH_AWARE_DATA_CACHE);
  assert.equal(body.success, true);
  assert.equal(body.count, 1);
  assert.equal(body.data.NVDA.latest.stressScore, 72.5);
  assert.equal(body.health.pipeline, "transcript_stress");
  assert.equal(body.health.state, "unknown");
  assert.equal(body.health.source, "inferred");
  assert.equal(body.health.asOf, "2099-01-02T12:00:00Z");
  assert.equal(body.health.stale, false);
});

test("gauge, exposure, and composite responses add manifest health without changing data maps", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    if (query.includes("etl_run_manifest")) {
      return Response.json({ rows: [manifestRow(query)] });
    }
    if (query.includes("xbrl_gauges")) {
      return Response.json({ rows: [{
        ticker: "ANET",
        as_of_date: "2099-01-02",
        latest_quarter_end: "2026-06-30",
        revenue_period_end: "2026-06-30",
        rpo_period_end: "2026-06-30",
        backlog_period_end: "2026-06-30",
        period_provenance: {
          methodology: "xbrl-gauge-score-period-v1",
          scoreDriver: "backlog",
          scorePeriodEnd: "2026-06-30",
        },
        revenue_yoy: "20.5",
        order_gap: "7.5",
        backlog_score: "64",
        fetched_at: "2099-01-02T09:00:00Z",
      }] });
    }
    if (query.includes("customer_exposure")) {
      assert.match(query, /statement_type/);
      assert.match(query, /= 'single_customer'/);
      return Response.json({ rows: [{
        ticker: "FN",
        customer_label: "Customer A",
        customer_ticker: "AMZN",
        pct: "35",
        basis: "revenue",
        period: "six months ended June 30, 2026",
        source_form: "10-K",
        quote: "Customer A represented 35% of revenue.",
        extracted_at: "2099-01-02T09:00:00Z",
        statement_type: "single_customer",
        period_end: "2026-06-30",
        source_accession: "0000000000-99-000001",
      }] });
    }
    assert.match(query, /FROM composite_scores cs/);
    assert.match(query, /to_jsonb\(cs\).*methodology_version/s);
    return Response.json({ rows: [{
      ticker: "AXTI",
      as_of_date: "2099-01-02",
      composite: "75",
      transcript_score: "80",
      transcript_direction: "constrained_supplier",
      gauge_score: "70",
      concentration_score: "60",
      components: JSON.stringify({
        transcript: { score: 80, sourcePeriod: "2098Q4" },
        _provenance: { methodology: "cbs", methodologyVersion: 2, inputSignature: "abc" },
      }),
      methodology_version: "2",
      methodology_signature: "method-abc",
      input_signature: "abc",
      source_available_at: "2099-01-01T12:00:00Z",
      computed_at: "2099-01-02T09:00:00Z",
    }] });
  };

  const cases = [
    [gaugesRequest, "/gauges", "xbrl_gauges", HEALTH_AWARE_DATA_CACHE, body => (
      body.data.ANET.orderGap === 7.5
      && body.data.ANET.backlogPeriodEnd === "2026-06-30"
      && body.data.ANET.periodProvenance.scoreDriver === "backlog"
    )],
    [exposureRequest, "/exposure", "customer_exposure", HEALTH_AWARE_DATA_CACHE, body => (
      body.data.FN.topRevenuePct === 35
      && body.data.FN.customers[0].statementType === "single_customer"
      && body.data.FN.customers[0].periodEnd === "2026-06-30"
    )],
    [compositeRequest, "/composite", "composite_score", HEALTH_AWARE_DATA_CACHE, body => (
      body.data.AXTI.score === 75
      && body.data.AXTI.provenance.methodologyVersion === 2
      && body.data.AXTI.components.transcript.sourcePeriod === "2098Q4"
    )],
  ];

  for (const [handler, path, pipeline, cacheControl, compatible] of cases) {
    const response = await handler({
      request: request(path),
      env: ENV,
      now: Date.parse("2026-08-17T12:00:00Z"),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), cacheControl);
    assert.equal(body.success, true);
    assert.equal(body.health.pipeline, pipeline);
    assert.equal(body.health.state, "success");
    assert.equal(body.health.stale, false);
    assert.equal(compatible(body), true);
  }
});

test("gauges prefer the newest filed source period over a later regressed run", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const queries = [];
  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    queries.push(query);
    if (query.includes("etl_run_manifest")) {
      return Response.json({ rows: [manifestRow(query)] });
    }
    return Response.json({ rows: [] });
  };

  const response = await gaugesRequest({ request: request("/gauges"), env: ENV });
  assert.equal(response.status, 200);
  const dataQuery = queries.find(query => query.includes("FROM xbrl_gauges"));
  assert.match(
    dataQuery,
    /ORDER BY latest_quarter_end DESC NULLS LAST,\s*as_of_date DESC/,
  );
});

test("unverified, stale, or future gauge periods cannot propagate graph bottleneck strength", () => {
  const base = {
    ticker: "LEGACY",
    as_of_date: "2026-08-17",
    latest_quarter_end: "2026-06-30",
    backlog_score: "99",
    order_gap: "80",
    inventory_days: "120",
  };
  const legacy = normalizeGaugeRow(base, Date.parse("2026-08-17T12:00:00Z"));
  const stale = normalizeGaugeRow({
    ...base,
    latest_quarter_end: "2024-06-30",
    period_provenance: {
      methodology: "xbrl-gauge-score-period-v1",
      scorePeriodEnd: "2024-06-30",
      scoreDriver: "backlog",
    },
  }, Date.parse("2026-08-17T12:00:00Z"));
  const future = normalizeGaugeRow({
    ...base,
    latest_quarter_end: "2026-09-01",
    period_provenance: {
      methodology: "xbrl-gauge-score-period-v1",
      scorePeriodEnd: "2026-09-01",
      scoreDriver: "backlog",
    },
  }, Date.parse("2026-08-17T12:00:00Z"));
  const trailingJunk = ["2026-06-30-garbage", "2026-06-30T00:00:00Z"].map(
    scorePeriodEnd => normalizeGaugeRow({
      ...base,
      period_provenance: {
        methodology: "xbrl-gauge-score-period-v1",
        scorePeriodEnd,
        scoreDriver: "backlog",
      },
    }, Date.parse("2026-08-17T12:00:00Z")),
  );

  for (const gauge of [legacy, stale, future, ...trailingJunk]) {
    assert.equal(gauge.scorePeriodEligible, false);
    assert.equal(gauge.backlogScore, null);
    assert.equal(gauge.orderGap, null);
    assert.equal(gauge.inventoryDays, null);
    assert.deepEqual(
      computeStrength([{ id: "LEGACY" }], {}, { LEGACY: gauge }),
      { LEGACY: 0 },
    );
  }
  assert.equal(future.scorePeriodExclusions[0].code, "future_source_period");

  const exactly365DaysOld = normalizeGaugeRow({
    ...base,
    latest_quarter_end: "2025-08-17",
    period_provenance: {
      methodology: "xbrl-gauge-score-period-v1",
      scorePeriodEnd: "2025-08-17",
      scoreDriver: "backlog",
    },
  }, Date.parse("2026-08-17T23:59:59Z"));
  assert.equal(exactly365DaysOld.scorePeriodEligible, true);
  assert.equal(exactly365DaysOld.backlogScore, 99);
});

test("scoreboard successful payload uses the private dataset cache", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    if (query.includes("etl_run_manifest")) {
      return Response.json({ rows: [manifestRow(query)] });
    }
    assert.match(query, /FROM signal_events/);
    return Response.json({ rows: [] });
  };

  const response = await scoreboardRequest({
    request: request("/scoreboard"),
    env: ENV,
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), HEALTH_AWARE_DATA_CACHE);
  assert.equal(body.success, true);
  assert.equal(body.health.state, "success");
});

test("preflight, method errors, and database misconfiguration are never cached", { concurrency: false }, async t => {
  const originalConsoleError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalConsoleError; });

  for (const [handler, path] of ENDPOINTS) {
    const optionsResponse = await handler({
      request: request(path, "OPTIONS"),
      env: ENV,
    });
    assert.equal(optionsResponse.status, 204);
    assert.equal(optionsResponse.headers.get("Cache-Control"), NO_STORE);

    const methodResponse = await handler({
      request: request(path, "POST"),
      env: ENV,
    });
    assert.equal(methodResponse.status, 405);
    assert.equal(methodResponse.headers.get("Cache-Control"), NO_STORE);

    const missingConfigResponse = await handler({
      request: request(path),
      env: { ...ENV, DATABASE_URL: undefined },
    });
    assert.equal(missingConfigResponse.status, 500);
    assert.equal(missingConfigResponse.headers.get("Cache-Control"), NO_STORE);

    const invalidConfigResponse = await handler({
      request: request(path),
      env: { ...ENV, DATABASE_URL: "not-a-database-url" },
    });
    assert.equal(invalidConfigResponse.status, 500);
    assert.equal(invalidConfigResponse.headers.get("Cache-Control"), NO_STORE);
  }
});

test("unexpected endpoint failures are never cached", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  globalThis.fetch = async () => { throw new Error("network unavailable"); };
  console.error = () => {};
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });

  for (const [handler, path] of ENDPOINTS) {
    const response = await handler({ request: request(path), env: ENV });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("Cache-Control"), NO_STORE);
    assert.equal(body.success, false);
  }
});

test("missing bootstrap tables use a short cache while health is unknown", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    if (query.includes("etl_run_manifest")) {
      return Response.json({ rows: [] });
    }
    if (query.includes("composite_scores")) {
      return Response.json(
        { code: "42P01", message: 'relation "composite_scores" does not exist' },
        { status: 400 }
      );
    }
    assert.match(query, /FROM signal_events/);
    return Response.json(
      { code: "42P01", message: 'relation "signal_events" does not exist' },
      { status: 400 }
    );
  };

  for (const [handler, path] of [
    [compositeRequest, "/composite"],
    [scoreboardRequest, "/scoreboard"],
  ]) {
    const response = await handler({ request: request(path), env: ENV });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), BOOTSTRAP_CACHE);
    assert.equal(body.success, true);
    assert.equal(body.health.state, "unknown");
  }
});

test("missing primary tables after a successful run fail closed", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });
  console.error = () => {};
  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    if (query.includes("etl_run_manifest")) {
      return Response.json({ rows: [manifestRow(query)] });
    }
    if (query.includes("composite_scores")) {
      return Response.json(
        { code: "42P01", message: 'relation "composite_scores" does not exist' },
        { status: 400 },
      );
    }
    assert.match(query, /FROM signal_events/);
    return Response.json(
      { code: "42P01", message: 'relation "signal_events" does not exist' },
      { status: 400 },
    );
  };

  for (const [handler, path] of [
    [compositeRequest, "/composite"],
    [scoreboardRequest, "/scoreboard"],
  ]) {
    const response = await handler({ request: request(path), env: ENV });
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("Cache-Control"), NO_STORE);
    assert.equal(body.success, false);
    assert.equal(body.health.state, "failure");
    assert.equal(body.health.stale, true);
  }
});

test("missing primary tables fail closed when manifest status is unavailable", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });
  console.error = () => {};
  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    if (query.includes("etl_run_manifest")) {
      return Response.json({ message: "manifest lookup failed" }, { status: 503 });
    }
    const relation = query.includes("composite_scores")
      ? "composite_scores"
      : "signal_events";
    return Response.json(
      { code: "42P01", message: `relation "${relation}" does not exist` },
      { status: 400 },
    );
  };

  for (const [handler, path] of [
    [compositeRequest, "/composite"],
    [scoreboardRequest, "/scoreboard"],
  ]) {
    const response = await handler({ request: request(path), env: ENV });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("Cache-Control"), NO_STORE);
    assert.equal((await response.json()).success, false);
  }
});

test("composite schema errors do not masquerade as an empty bootstrap", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  const originalConsoleError = console.error;
  t.after(() => {
    globalThis.fetch = originalFetch;
    console.error = originalConsoleError;
  });
  console.error = () => {};
  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    if (query.includes("etl_run_manifest")) {
      return Response.json({ rows: [] });
    }
    return Response.json(
      { code: "42703", message: 'column "computed_at" does not exist' },
      { status: 400 },
    );
  };

  const response = await compositeRequest({ request: request("/composite"), env: ENV });
  const body = await response.json();
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Cache-Control"), NO_STORE);
  assert.equal(body.success, false);
});

test("composite suppresses rollout deltas and only compares an advanced input vintage", { concurrency: false }, async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const component = (
    signature,
    availableAt,
    methodology = "stress-v1",
    sourcePeriodEnd = String(availableAt).slice(0, 10),
  ) => ({
    score: 70,
    eligible: true,
    sourceSignature: signature,
    sourceAvailableAt: availableAt,
    sourceMethodology: methodology,
    sourcePeriodEnd,
  });
  const row = (ticker, date, score, methodSignature, inputSignature, transcript) => ({
    ticker,
    as_of_date: date,
    composite: score == null ? null : String(score),
    transcript_score: "70",
    transcript_direction: "neutral",
    gauge_score: null,
    concentration_score: null,
    components: JSON.stringify({ transcript }),
    methodology_version: methodSignature ? "2" : null,
    methodology_signature: methodSignature,
    input_signature: inputSignature,
    source_available_at: transcript.sourceAvailableAt,
    computed_at: `${date}T12:00:00Z`,
  });
  const rows = [
    row("LEGACY", "2099-01-01", 40, null, null, component("old", "2098-12-31T12:00:00Z")),
    row("LEGACY", "2099-01-08", 75, "cbs-v2", "new", component("new", "2099-01-07T12:00:00Z")),
    row("ADV", "2099-01-01", 50, "cbs-v2", "input-a", component("source-a", "2098-12-31T12:00:00Z")),
    row("ADV", "2099-01-08", 65, "cbs-v2", "input-b", component("source-b", "2099-01-07T12:00:00Z")),
    row("REGRESS", "2099-01-01", 45, "cbs-v2", "regress-a", component("regress-a", "2099-01-01T12:00:00Z", "stress-v1", "2098-12-31")),
    row("REGRESS", "2099-01-08", 80, "cbs-v2", "regress-b", component("regress-b", "2099-01-07T12:00:00Z", "stress-v1", "2098-09-30")),
    row("GAP", "2099-01-01", 50, "cbs-v2", "gap-a", component("gap-a", "2099-01-01T12:00:00Z")),
    row("GAP", "2099-01-08", null, "cbs-v2", "gap-b", component("gap-b", "2099-01-07T12:00:00Z")),
    row("GAP", "2099-01-15", 80, "cbs-v2", "gap-c", component("gap-c", "2099-01-14T12:00:00Z")),
  ];

  globalThis.fetch = async (_url, init) => {
    const query = queryFrom(init);
    if (query.includes("etl_run_manifest")) {
      return Response.json({ rows: [manifestRow(query)] });
    }
    return Response.json({ rows });
  };

  const response = await compositeRequest({ request: request("/composite"), env: ENV });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.LEGACY.prevScore, null);
  assert.equal(body.data.LEGACY.delta, null);
  assert.equal(body.data.ADV.prevScore, 50);
  assert.equal(body.data.ADV.delta, 15);
  assert.equal(body.data.REGRESS.prevScore, null);
  assert.equal(body.data.REGRESS.delta, null);
  assert.equal(body.data.LEGACY.history[1].breakBefore, true);
  assert.equal(body.data.GAP.history[1].breakBefore, true);
  assert.equal(body.data.GAP.history[2].breakBefore, true);
  assert.equal("_vintages" in body.data.ADV, false);
});

test("composite baselines the whole delta when one component period regresses", () => {
  const part = (signature, availableAt, periodEnd) => ({
    eligible: true,
    sourceSignature: signature,
    sourceAvailableAt: availableAt,
    sourcePeriodEnd: periodEnd,
    sourceMethodology: "source-v1",
  });
  const previous = {
    methodologySignature: "cbs-v2",
    inputSignature: "input-a",
    computedAt: "2099-01-02T12:00:00Z",
    components: {
      transcript: part("transcript-a", "2099-01-01T12:00:00Z", "2098-12-31"),
      gauge: part("gauge-a", "2099-01-01T12:00:00Z", "2098-12-31"),
    },
  };
  const current = {
    methodologySignature: "cbs-v2",
    inputSignature: "input-b",
    computedAt: "2099-01-09T12:00:00Z",
    components: {
      transcript: part("transcript-b", "2099-01-08T12:00:00Z", "2099-03-31"),
      gauge: part("gauge-b", "2099-01-08T12:00:00Z", "2098-09-30"),
    },
  };

  assert.equal(inputVintageAdvanced(previous, current), false);
});

test("composite baselines missing-period provenance before a valid refresh", () => {
  const previous = {
    methodologySignature: "cbs-v2",
    inputSignature: "input-a",
    computedAt: "2099-01-02T12:00:00Z",
    components: {
      transcript: {
        eligible: false,
        sourceSignature: "source-a",
        sourceAvailableAt: "2099-01-01T12:00:00Z",
        sourcePeriodEnd: null,
        sourceMethodology: "stress-v1",
      },
    },
  };
  const current = {
    methodologySignature: "cbs-v2",
    inputSignature: "input-b",
    computedAt: "2099-01-09T12:00:00Z",
    components: {
      transcript: {
        eligible: true,
        sourceSignature: "source-b",
        sourceAvailableAt: "2099-01-08T12:00:00Z",
        sourcePeriodEnd: "2098-12-31",
        sourceMethodology: "stress-v1",
      },
    },
  };

  assert.equal(inputVintageAdvanced(previous, current), false);
});

test("one common missing-period component baselines another component advance", () => {
  const part = (signature, periodEnd) => ({
    eligible: true,
    sourceSignature: signature,
    sourceAvailableAt: signature.endsWith("b")
      ? "2099-01-08T12:00:00Z"
      : "2099-01-01T12:00:00Z",
    sourcePeriodEnd: periodEnd,
    sourceMethodology: "source-v1",
  });
  const previous = {
    methodologySignature: "cbs-v2",
    inputSignature: "input-a",
    computedAt: "2099-01-02T12:00:00Z",
    components: {
      transcript: part("transcript-a", null),
      gauge: part("gauge-a", "2098-12-31"),
    },
  };
  const current = {
    methodologySignature: "cbs-v2",
    inputSignature: "input-b",
    computedAt: "2099-01-09T12:00:00Z",
    components: {
      transcript: part("transcript-a", "2098-12-31"),
      gauge: part("gauge-b", "2098-12-31"),
    },
  };

  assert.equal(inputVintageAdvanced(previous, current), false);
});

test("a common component eligibility transition baselines another component advance", () => {
  const part = (signature, eligible) => ({
    eligible,
    sourceSignature: signature,
    sourceAvailableAt: signature.endsWith("b")
      ? "2099-01-08T12:00:00Z"
      : "2099-01-01T12:00:00Z",
    sourcePeriodEnd: "2098-12-31",
    sourceMethodology: "source-v1",
  });
  const snapshot = (inputSignature, transcript, gauge) => ({
    methodologySignature: "cbs-v2",
    inputSignature,
    computedAt: inputSignature === "input-b"
      ? "2099-01-09T12:00:00Z"
      : "2099-01-02T12:00:00Z",
    components: { transcript, gauge },
  });
  const advancingTranscript = part("transcript-b", true);

  for (const [previousGauge, currentGauge] of [
    [part("gauge-a", true), part("gauge-a", false)],
    [part("gauge-a", false), part("gauge-b", true)],
  ]) {
    const previous = snapshot(
      "input-a", part("transcript-a", true), previousGauge,
    );
    const current = snapshot("input-b", advancingTranscript, currentGauge);
    assert.equal(inputVintageAdvanced(previous, current), false);
  }

  const bothExcludedPrevious = snapshot(
    "input-a", part("transcript-a", true), part("gauge-a", false),
  );
  const bothExcludedCurrent = snapshot(
    "input-b", advancingTranscript, part("gauge-a", false),
  );
  assert.equal(
    inputVintageAdvanced(bothExcludedPrevious, bothExcludedCurrent),
    true,
  );

  const changedExcludedMethod = snapshot(
    "input-b", advancingTranscript, {
      ...part("gauge-a", false),
      sourceMethodology: "source-v2",
    },
  );
  assert.equal(
    inputVintageAdvanced(bothExcludedPrevious, changedExcludedMethod),
    false,
  );
});

test("adding or removing a scoring component baselines another component advance", () => {
  const part = (signature, availableAt = "2099-01-01T12:00:00Z") => ({
    eligible: true,
    sourceSignature: signature,
    sourceAvailableAt: availableAt,
    sourcePeriodEnd: "2098-12-31",
    sourceMethodology: "source-v1",
  });
  const snapshot = (inputSignature, components) => ({
    methodologySignature: "cbs-v2",
    inputSignature,
    computedAt: inputSignature === "input-b"
      ? "2099-01-09T12:00:00Z"
      : "2099-01-02T12:00:00Z",
    components,
  });
  const previousCommon = {
    transcript: part("transcript-a"),
    gauge: part("gauge-a"),
  };
  const currentCommon = {
    transcript: part("transcript-b", "2099-01-08T12:00:00Z"),
    gauge: part("gauge-a"),
  };

  const added = inputVintageAdvanced(
    snapshot("input-a", previousCommon),
    snapshot("input-b", {
      ...currentCommon,
      concentration: part("concentration-a", "2099-01-08T12:00:00Z"),
    }),
  );
  const removed = inputVintageAdvanced(
    snapshot("input-a", {
      ...previousCommon,
      concentration: part("concentration-a"),
    }),
    snapshot("input-b", currentCommon),
  );

  assert.equal(added, false);
  assert.equal(removed, false);

  // Snapshot metadata may be introduced independently and does not alter the
  // score-driving component set.
  assert.equal(
    inputVintageAdvanced(
      snapshot("input-a", {
        ...previousCommon,
        _provenance: { methodology: "cbs-v2" },
      }),
      snapshot("input-b", currentCommon),
    ),
    true,
  );
});

test("dashboard dataset fetches reject non-OK and logically failed responses", async () => {
  await assert.rejects(
    fetchDashboardDataset("/stress", async () => Response.json({
      success: true,
      data: { NVDA: {} },
      message: "Upstream unavailable",
      health: { state: "failure", stale: true, asOf: "2026-08-01" },
    }, { status: 503 })),
    /Upstream unavailable/
  );

  await assert.rejects(
    fetchDashboardDataset("/stress", async () => Response.json({ success: false, data: {} })),
    /returned no usable data/
  );

  const result = await fetchDashboardDataset("/stress", async () => Response.json({
    success: true,
    data: {},
  }));
  assert.deepEqual(result.data, {});
  assert.equal(result.health.state, "unknown");
  assert.equal(result.health.stale, true);
});

test("dashboard health notice distinguishes loading, healthy, and partial data", () => {
  const loading = Object.fromEntries(Object.keys(DASHBOARD_DATASETS).map(key => [key, {
    loading: true,
    error: null,
    stale: null,
    asOf: null,
    state: "unknown",
  }]));
  assert.deepEqual(buildDashboardDataNotice(loading), {
    type: "info",
    message: "Loading live supply-chain datasets: Transcript stress, XBRL gauges, Customer exposure, Composite scores.",
  });

  const healthy = Object.fromEntries(Object.keys(DASHBOARD_DATASETS).map(key => [key, {
    loading: false,
    error: null,
    stale: false,
    asOf: "2099-01-02T10:05:00Z",
    state: "success",
  }]));
  assert.equal(buildDashboardDataNotice(healthy), null);

  const partial = {
    ...healthy,
    stress: { ...healthy.stress, state: "failure", asOf: "2026-08-16" },
    gauges: { ...healthy.gauges, stale: true, asOf: "2026-07-01" },
    exposure: { ...healthy.exposure, state: "unknown" },
    composite: { ...healthy.composite, error: "HTTP 500" },
  };
  const notice = buildDashboardDataNotice(partial);
  assert.deepEqual(notice, {
    type: "warning",
    message: "Partial/degraded data: Transcript stress refresh failed; last good data 2026-08-16; XBRL gauges stale, as of 2026-07-01; Customer exposure freshness unverified, as of 2099-01-02; Composite scores unavailable. Affected signals may be missing; displayed values are stored snapshots, not confirmed live.",
  });
});

test("dashboard health notice excludes locked datasets from the loading scope", () => {
  const health = Object.fromEntries(Object.keys(DASHBOARD_DATASETS).map(key => [key, {
    loading: true,
    locked: key === "stress" || key === "composite",
  }]));

  assert.deepEqual(buildDashboardDataNotice(health), {
    type: "info",
    message: "Loading live supply-chain datasets: XBRL gauges, Customer exposure.",
  });
});

test("dashboard health notice is absent when every dataset is locked", () => {
  const health = Object.fromEntries(Object.keys(DASHBOARD_DATASETS).map(key => [key, {
    loading: true,
    locked: true,
  }]));

  assert.equal(buildDashboardDataNotice(health), null);
});
