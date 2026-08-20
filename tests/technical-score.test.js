import assert from "node:assert/strict";
import test from "node:test";

import { findNotablePoints } from "../functions/notable-points.js";
import { computeTechnicalScore } from "../functions/technical-score.js";

function historyPoint({
  date = "2026-08-14",
  close = 100,
  ma20 = 95,
  ma200 = 90,
} = {}) {
  return { date, close, volume: null, ma20, ma200 };
}

test("a strong uptrend scores high", () => {
  const result = computeTechnicalScore({
    change1M: 12,
    change6M: 40,
    change1Y: 80,
    price: 195,
    week52Low: 100,
    week52High: 200,
  }, { points: [historyPoint({ close: 195, ma20: 185, ma200: 175 })] });
  const trend = result.components.find(component => component.key === "trend");

  assert.equal(result.score, 97);
  assert.equal(trend.score, 100);
  assert.equal(trend.detail, "close 195.00 · MA20 185.00 · MA200 175.00");
});

test("a downtrend scores low but not null", () => {
  const result = computeTechnicalScore({
    change1M: -15,
    change6M: -30,
    change1Y: -50,
    price: 105,
    week52Low: 100,
    week52High: 200,
  }, { points: [historyPoint({ close: 105, ma20: 115, ma200: 120 })] });
  const trend = result.components.find(component => component.key === "trend");

  assert.equal(result.score, 1);
  assert.equal(trend.score, 0);
  assert.equal(trend.detail, "close 105.00 · MA20 115.00 · MA200 120.00");
});

test("missing 52-week bounds excludes range position and renormalizes", () => {
  const result = computeTechnicalScore({
    change1M: 6,
    change6M: 12,
    change1Y: 20,
    price: 150,
    week52Low: null,
    week52High: null,
  }, { points: [historyPoint({ close: 150, ma20: 145, ma200: 140 })] });
  const included = result.components.filter(component => component.score != null);
  const appliedWeight = included.reduce((sum, component) => sum + component.weight, 0);
  const zeroFilledExpectation = Math.round(included.reduce((sum, component) =>
    sum + component.score * component.rawWeight
  , 0));
  const renormalizedExpectation = Math.round(included.reduce((sum, component) =>
    sum + component.score * component.weight
  , 0));

  assert.ok(result.excluded.includes("rangePosition"));
  assert.ok(Math.abs(appliedWeight - 1) < 1e-12);
  assert.equal(result.score, renormalizedExpectation);
  assert.equal(result.score, 80);
  assert.ok(result.score > zeroFilledExpectation);
});

test("fewer than two components returns an insufficient-data result", () => {
  const result = computeTechnicalScore(
    { change1M: 10 },
    { points: [historyPoint({ ma200: null })] },
  );

  assert.equal(result.score, null);
  assert.ok(result.excluded.includes("trend"));
  assert.ok(result.note);
});

test("notable points find the true high, low, and 20/200 crosses", () => {
  const points = [
    historyPoint({ date: "2026-04-30", close: 90, ma20: 95, ma200: 100 }),
    historyPoint({ date: "2026-05-01", close: 100, ma20: 99, ma200: 100 }),
    historyPoint({ date: "2026-05-04", close: 105, ma20: 101, ma200: 100 }),
    historyPoint({ date: "2026-05-05", close: 80, ma20: 102, ma200: 100 }),
    historyPoint({ date: "2026-05-06", close: 85, ma20: 99, ma200: 100 }),
  ];
  const result = findNotablePoints(points, "2026-05-01");

  assert.deepEqual(
    result.find(point => point.kind === "periodHigh"),
    {
      id: "periodHigh",
      kind: "periodHigh",
      date: "2026-05-04",
      close: 105,
      detail: "Highest close in display window",
    },
  );
  assert.equal(result.find(point => point.kind === "periodLow")?.date, "2026-05-05");
  assert.deepEqual(
    result.filter(point => ["goldenCross", "deathCross"].includes(point.kind))
      .map(point => [point.kind, point.date, point.detail]),
    [
      ["goldenCross", "2026-05-04", "MA20 crossed above MA200"],
      ["deathCross", "2026-05-06", "MA20 crossed below MA200"],
    ],
  );
});

test("notable points restrict highs to the display window", () => {
  const points = [
    historyPoint({ date: "2026-04-30", close: 500 }),
    historyPoint({ date: "2026-05-01", close: 100 }),
    historyPoint({ date: "2026-05-04", close: 120 }),
    historyPoint({ date: "2026-05-05", close: 110 }),
  ];
  const result = findNotablePoints(points, "2026-05-01");
  const periodHigh = result.find(point => point.kind === "periodHigh");

  assert.equal(periodHigh.date, "2026-05-04");
  assert.equal(periodHigh.close, 120);
});
