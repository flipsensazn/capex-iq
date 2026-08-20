import assert from "node:assert/strict";
import test from "node:test";

import { findSupportResistance } from "../functions/support-resistance.js";

function makeSeries({
  length = 32,
  baseClose = 100,
  baseHigh = 105,
  baseLow = 95,
  lastClose = 100,
  highPivots = {},
  lowPivots = {},
  nullIndexes = [],
} = {}) {
  const nulls = new Set(nullIndexes);
  return Array.from({ length }, (_, index) => {
    const date = new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
    if (nulls.has(index)) {
      return { date, open: null, high: null, low: null, close: null, ma20: null, ma200: null };
    }

    const close = index === length - 1 ? lastClose : baseClose;
    const high = index in highPivots ? highPivots[index] : Math.max(baseHigh, close);
    const low = index in lowPivots ? lowPivots[index] : Math.min(baseLow, close);
    return { date, open: close, high, low, close, ma20: null, ma200: null };
  });
}

test("a double top becomes one resistance at the pivot-price mean", () => {
  const points = makeSeries({
    length: 16,
    highPivots: { 4: 120, 10: 121 },
  });

  assert.deepEqual(findSupportResistance(points, points[0].date), [{
    kind: "resistance",
    price: 120.5,
    touches: 2,
    lastTouch: points[10].date,
  }]);
});

test("a double bottom becomes support", () => {
  const points = makeSeries({
    length: 16,
    lowPivots: { 4: 80, 10: 81 },
  });

  assert.deepEqual(findSupportResistance(points, points[0].date), [{
    kind: "support",
    price: 80.5,
    touches: 2,
    lastTouch: points[10].date,
  }]);
});

test("a three-touch level outranks a two-touch level", () => {
  const points = makeSeries({
    length: 28,
    highPivots: {
      3: 120,
      8: 120.4,
      13: 119.8,
      18: 130,
      23: 130.5,
    },
  });
  const resistances = findSupportResistance(points, points[0].date)
    .filter(level => level.kind === "resistance");

  assert.deepEqual(resistances.map(level => [level.price, level.touches]), [
    [120.07, 3],
    [130.25, 2],
  ]);
});

test("pivots 1.5% of the last close apart form separate clusters", () => {
  const points = makeSeries({
    length: 24,
    highPivots: { 3: 120, 8: 120, 13: 121.5, 18: 121.5 },
  });
  const result = findSupportResistance(points, points[0].date);

  assert.deepEqual(result.map(level => [level.price, level.touches]), [
    [121.5, 2],
    [120, 2],
  ]);
});

test("ranking returns no more than two supports and two resistances", () => {
  const points = makeSeries({
    length: 64,
    highPivots: {
      3: 110,
      8: 110,
      13: 120,
      18: 120,
      23: 130,
      28: 130,
    },
    lowPivots: {
      33: 90,
      38: 90,
      43: 80,
      48: 80,
      53: 70,
      58: 70,
    },
  });
  const result = findSupportResistance(points, points[0].date);

  assert.equal(result.length, 4);
  assert.equal(result.filter(level => level.kind === "support").length, 2);
  assert.equal(result.filter(level => level.kind === "resistance").length, 2);
});

test("classification uses the last close rather than the pivot type", () => {
  const swingHighBelowClose = makeSeries({
    length: 16,
    baseClose: 70,
    baseHigh: 80,
    baseLow: 60,
    lastClose: 100,
    highPivots: { 4: 90, 10: 90 },
  });
  const swingLowAboveClose = makeSeries({
    length: 16,
    baseClose: 130,
    baseHigh: 140,
    baseLow: 120,
    lastClose: 100,
    lowPivots: { 4: 110, 10: 110 },
  });
  const levelAtClose = makeSeries({
    length: 16,
    baseClose: 80,
    baseHigh: 90,
    baseLow: 70,
    lastClose: 100,
    highPivots: { 4: 100, 10: 100 },
  });

  assert.equal(findSupportResistance(swingHighBelowClose, swingHighBelowClose[0].date)[0].kind, "support");
  assert.equal(findSupportResistance(swingLowAboveClose, swingLowAboveClose[0].date)[0].kind, "resistance");
  assert.deepEqual(findSupportResistance(levelAtClose, levelAtClose[0].date), []);
});

test("null OHLC bars are skipped without losing valid pivots", () => {
  const points = makeSeries({
    length: 17,
    highPivots: { 4: 120, 11: 120.5 },
    nullIndexes: [7],
  });

  assert.deepEqual(findSupportResistance(points, points[0].date), [{
    kind: "resistance",
    price: 120.25,
    touches: 2,
    lastTouch: points[11].date,
  }]);
});

test("the relevance clamp drops a level outside the display price range", () => {
  const points = makeSeries({
    length: 30,
    highPivots: { 4: 200, 10: 200 },
  });

  assert.deepEqual(findSupportResistance(points, points[15].date), []);
});

test("support and resistance detection is deterministic", () => {
  const points = makeSeries({
    length: 28,
    highPivots: { 3: 120, 8: 120.4, 13: 119.8, 18: 130, 23: 130.5 },
  });

  assert.deepEqual(
    findSupportResistance(points, points[0].date),
    findSupportResistance(points, points[0].date),
  );
});
