import assert from "node:assert/strict";
import test from "node:test";

import { hasResolvedQuote } from "../functions/prices.js";
import { changeOf } from "../src/lib/priceChange.js";

test("changeOf returns only finite numeric changes", () => {
  assert.equal(changeOf(1.25), 1.25);
  assert.equal(changeOf(0), 0);
  assert.equal(changeOf(NaN), undefined);
  assert.equal(changeOf(Infinity), undefined);
  assert.equal(changeOf(-Infinity), undefined);

  assert.equal(changeOf({ change: -2.5 }), -2.5);
  assert.equal(changeOf({ change: 0 }), 0);
  assert.equal(changeOf({ change: null }), undefined);
  assert.equal(changeOf({ change: undefined }), undefined);
  assert.equal(changeOf({ change: "1.5" }), undefined);
  assert.equal(changeOf({ change: NaN }), undefined);
  assert.equal(changeOf({ change: Infinity }), undefined);
  assert.equal(changeOf({ chartData: [100, 101], chartTimestamps: [1, 2] }), undefined);

  assert.equal(changeOf(null), undefined);
  assert.equal(changeOf(undefined), undefined);
  assert.equal(changeOf("1.5"), undefined);
  assert.equal(changeOf(true), undefined);
});

test("hasResolvedQuote requires a finite numeric price", () => {
  assert.equal(hasResolvedQuote({ price: 123.45, change: 1.2 }), true);
  assert.equal(hasResolvedQuote({ chartData: [100, 101], chartTimestamps: [1, 2] }), false);
  assert.equal(hasResolvedQuote(undefined), false);
});
