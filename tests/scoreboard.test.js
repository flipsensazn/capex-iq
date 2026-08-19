import assert from "node:assert/strict";
import test from "node:test";

import { onRequest as scoreboard } from "../functions/scoreboard.js";
import {
  createAccessFixture,
  memberKv,
  warmAccessFixture,
} from "./access-fixture.js";

const ORIGIN = "https://capex-iq.us";
const MEMBER_EMAIL = "member@example.com";
const access = await createAccessFixture("scoreboard");
const memberJwt = await access.createJwt({ email: MEMBER_EMAIL });
await warmAccessFixture(access, memberJwt);

async function withFetch(stub, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const context = () => ({
  request: new Request(`${ORIGIN}/scoreboard`, {
    method: "GET",
    headers: {
      Origin: ORIGIN,
      Cookie: `CF_Authorization=${memberJwt}`,
    },
  }),
  env: {
    ACCESS_TEAM_DOMAIN: access.teamDomain,
    ACCESS_AUD: access.accessAud,
    ADMIN_EMAILS: "admin@example.com",
    DATABASE_URL: "postgresql://user:pass@example.neon.tech/db",
    ALLOWED_ORIGIN: ORIGIN,
    SHARED_DATA: memberKv(MEMBER_EMAIL),
  },
});

const manifestRow = {
  pipeline: "signal_scoreboard",
  run_id: "scoreboard-run",
  run_date: "2026-08-18",
  state: "success",
  started_at: "2026-08-18T16:00:00Z",
  finished_at: "2026-08-18T16:05:00Z",
  run_data_fresh_at: "2026-08-18T16:05:00Z",
  last_data_fresh_at: "2026-08-18T16:05:00Z",
  expected: "1",
  attempted: "1",
  usable: "1",
  known_no_data: "0",
  transient_failures: "0",
  degraded: "0",
  provider_coverage: "1",
  usable_coverage: "1",
  baseline_usable: "1",
  error_message: null,
  details: {},
};

test("scoreboard keeps prospective and reconstructed results separate", { concurrency: false }, async () => {
  const statRows = [
    { cohort: "prospective", type: "all", cohort_boundary_min: "2026-08-18", cohort_boundary_max: "2026-08-18", n: "2", n_1w: "1", med_1w: "1.25", hit_1w: "1", n_1m: "0", med_1m: null, hit_1m: null, n_3m: "0", med_3m: null, hit_3m: null },
    { cohort: "prospective", type: "cbs_cross_70", n: "2", n_1w: "1", med_1w: "1.25", hit_1w: "1", n_1m: "0", med_1m: null, hit_1m: null, n_3m: "0", med_3m: null, hit_3m: null },
    { cohort: "retrospective", type: "all", n: "100", n_1w: "99", med_1w: "-0.6", hit_1w: "0.48", n_1m: "90", med_1m: "-1.1", hit_1m: "0.47", n_3m: "80", med_3m: "7.3", hit_3m: "0.59" },
    { cohort: "retrospective", type: "stress_cross_70", n: "100", n_1w: "99", med_1w: "-0.6", hit_1w: "0.48", n_1m: "90", med_1m: "-1.1", hit_1m: "0.47", n_3m: "80", med_3m: "7.3", hit_3m: "0.59" },
  ];
  const eventRows = [
    { ticker: "NEW", event_type: "cbs_cross_70", event_date: "2026-08-17", observed_at: "2026-08-17T15:00:00Z", signal_available_at: "2026-08-17T15:00:00Z", entry_date: "2026-08-18", exit_dates: {}, score: "71", cohort: "prospective", ret_1w: null, bench_1w: null, ret_1m: null, bench_1m: null, ret_3m: null, bench_3m: null },
    { ticker: "OLD", event_type: "stress_cross_70", event_date: "2025-05-01", observed_at: "2026-08-17T16:00:00Z", signal_available_at: null, entry_date: "2025-05-02", exit_dates: { "1w": "2025-05-09" }, score: "75", cohort: "retrospective", ret_1w: "5", bench_1w: "2", ret_1m: null, bench_1m: null, ret_3m: null, bench_3m: null },
  ];
  const queries = [];

  await withFetch(async (_url, options) => {
    const query = JSON.parse(options.body).query;
    queries.push(query);
    const rows = query.includes("etl_run_manifest")
      ? [manifestRow]
      : query.includes("GROUP BY cohort") ? statRows : eventRows;
    return new Response(JSON.stringify({ rows }), { status: 200 });
  }, async () => {
    const response = await scoreboard(context());
    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.success, true);
    assert.deepEqual(body.stats.map(row => row.cohort), ["prospective", "prospective"]);
    assert.deepEqual(body.events.map(row => row.ticker), ["NEW"]);
    assert.equal(body.statsByCohort.prospective.find(row => row.type === "all").n, 2);
    assert.equal(body.statsByCohort.retrospective.find(row => row.type === "all").n, 100);
    assert.deepEqual(body.eventsByCohort.retrospective.map(row => row.ticker), ["OLD"]);
    assert.equal(body.eventsByCohort.retrospective[0].excess["1w"], 3);
    assert.equal(body.eventsByCohort.prospective[0].observedAt, "2026-08-17T15:00:00Z");
    assert.equal(body.eventsByCohort.prospective[0].entryDate, "2026-08-18");
    assert.deepEqual(body.eventsByCohort.retrospective[0].exitDates, { "1w": "2025-05-09" });
    assert.equal(body.methodology.prospectiveStart, "2026-08-18");
    assert.equal(body.methodology.horizonAnchor, "Actual entry date");
    assert.equal(body.health.pipeline, "signal_scoreboard");
    assert.equal(body.health.state, "success");
  });

  assert.equal(queries.length, 3);
  for (const query of queries.filter(query => !query.includes("etl_run_manifest"))) {
    assert.match(query, /details->>'cohort'/);
    assert.match(query, /eventClassification/);
    assert.match(query, /migration_baseline/);
    assert.doesNotMatch(query, /event_date >= DATE/);
  }
});

test("missing scoreboard table returns the complete empty cohort contract", { concurrency: false }, async () => {
  await withFetch(async (_url, options) => {
    const query = JSON.parse(options.body).query;
    if (query.includes("etl_run_manifest")) {
      return new Response(JSON.stringify({ rows: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      code: "42P01",
      message: 'relation "signal_events" does not exist',
    }), { status: 400 });
  }, async () => {
    const response = await scoreboard(context());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.stats, []);
    assert.deepEqual(body.events, []);
    assert.deepEqual(body.statsByCohort, { prospective: [], retrospective: [] });
    assert.deepEqual(body.eventsByCohort, { prospective: [], retrospective: [] });
    assert.equal(body.methodology.version, 2);
    assert.equal(body.health.pipeline, "signal_scoreboard");
    assert.equal(body.health.state, "unknown");
  });
});

test("other schema errors fail instead of masquerading as an empty scoreboard", { concurrency: false }, async () => {
  await withFetch(async () => new Response(
    'column "created_at" does not exist',
    { status: 400 }
  ), async () => {
    const response = await scoreboard(context());
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.success, false);
  });
});

test("inconsistent persisted cohort boundaries fail closed", { concurrency: false }, async () => {
  await withFetch(async (_url, options) => {
    const query = JSON.parse(options.body).query;
    const rows = query.includes("GROUP BY cohort")
      ? [{
          cohort: "prospective",
          type: "all",
          cohort_boundary_min: "2026-08-17",
          cohort_boundary_max: "2026-08-18",
          n: "1",
        }]
      : [];
    return new Response(JSON.stringify({ rows }), { status: 200 });
  }, async () => {
    const response = await scoreboard(context());
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.equal(body.success, false);
  });
});
