import assert from "node:assert/strict";
import test from "node:test";

import { computeQualityScore } from "../functions/quality-score.js";

function fundamentals({
  netMargin = null,
  operatingMargin = null,
  fcfMargin = null,
  revenueCagr = null,
  roe = null,
  currentRatio = null,
  debtToEquity = null,
  netIncome = [],
} = {}) {
  const fiscalYears = netIncome.map((_, index) => 2020 + index);
  if (!fiscalYears.length) fiscalYears.push(2025);
  const latestYear = fiscalYears[fiscalYears.length - 1];
  const series = value => ({ [latestYear]: value });

  return {
    fiscalYears,
    metrics: {
      netMargin: series(netMargin),
      operatingMargin: series(operatingMargin),
      fcfMargin: series(fcfMargin),
      roe: series(roe),
      currentRatio: series(currentRatio),
      debtToEquity: series(debtToEquity),
    },
    growth: { revenueCagr },
    statements: {
      income: {
        netIncome: Object.fromEntries(fiscalYears.map((year, index) => [year, netIncome[index] ?? null])),
      },
    },
  };
}

test("a strong profitable company scores high", () => {
  const result = computeQualityScore(fundamentals({
    netMargin: 25,
    operatingMargin: 30,
    fcfMargin: 20,
    revenueCagr: 30,
    roe: 0.40,
    currentRatio: 2.5,
    debtToEquity: 0.2,
    netIncome: [10, 12, 14, 16, 18, 20],
  }));

  assert.ok(result.score >= 85);
});

test("an Amazon-like profile scores in a defensible band", () => {
  const result = computeQualityScore(fundamentals({
    netMargin: 10.83,
    operatingMargin: 11.16,
    fcfMargin: 1.07,
    revenueCagr: 13.2,
    roe: 0.20,
    currentRatio: 1.05,
    debtToEquity: null,
    netIncome: [10, 12, -2, 18, 24, 30],
  }));

  assert.ok(result.score >= 45 && result.score <= 80);
  assert.ok(result.score >= 20);
});

test("a loss-making company scores low but not null", () => {
  const result = computeQualityScore(fundamentals({
    netMargin: -12,
    operatingMargin: -8,
    fcfMargin: -10,
    revenueCagr: 2,
    roe: -0.30,
    currentRatio: 0.7,
    debtToEquity: 2.5,
    netIncome: [-5, -4, -3, -2],
  }));

  assert.notEqual(result.score, null);
  assert.ok(result.score <= 25);
});

test("missing components are excluded and remaining weights renormalize", () => {
  const result = computeQualityScore(fundamentals({
    netMargin: 18,
    operatingMargin: 22,
    fcfMargin: 14,
    revenueCagr: 20,
    roe: 0.22,
    currentRatio: null,
    debtToEquity: null,
    netIncome: [10, 11, 12, 13, 14, 15],
  }));
  const included = result.components.filter(component => component.score != null);
  const appliedWeight = included.reduce((sum, component) => sum + component.weight, 0);
  const zeroFilledExpectation = Math.round(included.reduce((sum, component) =>
    sum + component.score * component.rawWeight
  , 0));
  const renormalizedExpectation = Math.round(included.reduce((sum, component) =>
    sum + component.score * component.weight
  , 0));

  assert.ok(result.excluded.includes("balanceSheet"));
  assert.ok(Math.abs(appliedWeight - 1) < 1e-12);
  assert.equal(result.score, renormalizedExpectation);
  assert.ok(result.score > zeroFilledExpectation);
});

test("fewer than three components returns an insufficient-data result", () => {
  const result = computeQualityScore(fundamentals({
    netMargin: 15,
    operatingMargin: 20,
    revenueCagr: 10,
  }));

  assert.equal(result.score, null);
  assert.ok(result.note);
});

test("ROE ratio is converted to percentage points before scoring", () => {
  const result = computeQualityScore(fundamentals({
    netMargin: 10,
    operatingMargin: 10,
    revenueCagr: 10,
    roe: 0.40,
  }));
  const returns = result.components.find(component => component.key === "returns");

  assert.equal(returns.score, 100);
});
