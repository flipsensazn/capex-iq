import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { buildFundamentalsFromCompanyFacts } from "../functions/fundamentals.js";
import { buildPoints } from "../functions/history.js";
import { findRefPrices, pctFrom } from "../functions/prices.js";
import {
  methodologySignature,
  scoreRadarRecord,
} from "../scripts/radar_score.mjs";

const execFileAsync = promisify(execFile);
const FIXED_NOW_MS = Date.parse("2026-08-18T12:00:00Z");
const FIXED_NOW_SECONDS = FIXED_NOW_MS / 1000;
const DAY_SECONDS = 86_400;

function withFixedDate(action) {
  const OriginalDate = globalThis.Date;
  class FixedDate extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [FIXED_NOW_MS]));
    }

    static now() {
      return FIXED_NOW_MS;
    }
  }

  globalThis.Date = FixedDate;
  try {
    return action();
  } finally {
    globalThis.Date = OriginalDate;
  }
}

function fact(val, fy, end = `${fy}-12-31`) {
  return { start: `${fy - 1}-01-01`, end, val, fy, fp: "FY", form: "10-K" };
}

function concept(unit, valuesByYear) {
  return {
    units: {
      [unit]: Object.entries(valuesByYear).map(([year, value]) => fact(value, Number(year))),
    },
  };
}

function existingFundamentalsFixture() {
  return {
    entityName: "MICROSOFT CORP",
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", {
          2024: 1000,
          2025: 1200,
        }),
        NetIncomeLoss: concept("USD", { 2024: 200, 2025: 300 }),
        WeightedAverageNumberOfDilutedSharesOutstanding: concept("shares", {
          2024: 100,
          2025: 100,
        }),
        NetCashProvidedByUsedInOperatingActivities: concept("USD", {
          2024: 350,
          2025: 400,
        }),
        PaymentsToAcquirePropertyPlantAndEquipment: concept("USD", {
          2024: 100,
          2025: 125,
        }),
      },
      dei: {
        EntityCommonStockSharesOutstanding: {
          units: {
            shares: [
              { end: "2025-07-25", val: 75_000_000 },
              { end: "2026-08-03", val: 84_569_237 },
            ],
          },
        },
      },
    },
  };
}

function scoringCompanyFactsFixture() {
  return {
    entityName: "UNIT REGRESSION CORP",
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: concept("USD", {
          2020: 100,
          2021: 110,
          2022: 120,
          2023: 140,
          2024: 160,
          2025: 200,
        }),
        OperatingIncomeLoss: concept("USD", { 2025: 30 }),
        NetIncomeLoss: concept("USD", {
          2020: 5,
          2021: -2,
          2022: 8,
          2023: 10,
          2024: 12,
          2025: 18,
        }),
        StockholdersEquity: concept("USD", { 2025: 120 }),
        AssetsCurrent: concept("USD", { 2025: 150 }),
        LiabilitiesCurrent: concept("USD", { 2025: 100 }),
        LongTermDebtNoncurrent: concept("USD", { 2025: 60 }),
        NetCashProvidedByUsedInOperatingActivities: concept("USD", { 2025: 35 }),
        PaymentsToAcquirePropertyPlantAndEquipment: concept("USD", { 2025: 15 }),
      },
      dei: {
        EntityCommonStockSharesOutstanding: {
          units: { shares: [{ end: "2026-08-03", val: 1000 }] },
        },
      },
    },
  };
}

function scoringChartFixture() {
  return {
    timestamps: Array.from(
      { length: 400 },
      (_, index) => FIXED_NOW_SECONDS - (399 - index) * DAY_SECONDS,
    ),
    closes: Array.from({ length: 400 }, (_, index) => 100 + index * 0.25),
  };
}

function scoredInput(overrides = {}) {
  return {
    ticker: "UNIT",
    companyfacts: scoringCompanyFactsFixture(),
    chart: scoringChartFixture(),
    chains: ["ai", "musk"],
    memberships: {
      ai: ["Compute / Accelerators"],
      musk: ["Space / Launch"],
    },
    instrumentType: "EQUITY",
    ...overrides,
  };
}

test("the pure fundamentals export preserves the existing SEC fixture derivations", () => {
  const result = buildFundamentalsFromCompanyFacts(existingFundamentalsFixture());

  assert.deepEqual(Object.keys(result), [
    "fiscalYears",
    "statements",
    "metrics",
    "growth",
    "sharesOutstanding",
  ]);
  assert.deepEqual(result.fiscalYears, [2024, 2025]);
  assert.deepEqual(result.statements.income.revenue, { 2024: 1000, 2025: 1200 });
  assert.deepEqual(result.statements.income.netIncome, { 2024: 200, 2025: 300 });
  assert.deepEqual(result.metrics.netMargin, { 2024: 20, 2025: 25 });
  assert.deepEqual(result.statements.cashFlow.freeCashFlow, { 2024: 250, 2025: 275 });
  assert.deepEqual(result.sharesOutstanding, { value: 84_569_237, asOf: "2026-08-03" });
});

test("the pure history and price exports preserve rolling and reference semantics", { concurrency: false }, () => {
  const timestamps = Array.from(
    { length: 50 },
    (_, index) => Date.UTC(2026, 0, index + 1) / 1000,
  );
  const closes = Array.from({ length: 50 }, (_, index) => index + 1);
  const points = buildPoints(timestamps, closes);

  assert.deepEqual(points[0], {
    date: "2026-01-01",
    close: 1,
    volume: null,
    ma20: null,
    ma50: null,
  });
  assert.equal(points[19].ma20, 10.5);
  assert.deepEqual(points[49], {
    date: "2026-02-19",
    close: 50,
    volume: null,
    ma20: 40.5,
    ma50: 25.5,
  });

  withFixedDate(() => {
    const referenceTimestamps = [
      FIXED_NOW_SECONDS - 365 * DAY_SECONDS,
      Date.parse("2026-01-01T00:00:00Z") / 1000,
      FIXED_NOW_SECONDS - 182 * DAY_SECONDS,
      FIXED_NOW_SECONDS - 30 * DAY_SECONDS,
      FIXED_NOW_SECONDS - 7 * DAY_SECONDS,
    ];
    assert.deepEqual(findRefPrices(referenceTimestamps, [50, 70, 60, 80, 90]), {
      r5D: 90,
      r1M: 80,
      r6M: 60,
      rYTD: 70,
      r1Y: 50,
    });
  });
  assert.equal(pctFrom(80, 100), 25);
  assert.equal(pctFrom(null, 100), null);
});

test("the Radar regression vector pins percent units and exact module scores", { concurrency: false }, () => {
  const result = withFixedDate(() => scoreRadarRecord(scoredInput()));

  assert.equal(result.coverage, "scored");
  assert.equal(result.qualityScore.score, 61);
  assert.equal(result.qualityScore.basis, "FY2025");
  assert.deepEqual(
    result.qualityScore.components.map(({ key, score }) => [key, score]),
    [
      ["profitability", 52.5],
      ["cashGeneration", 66.66666666666666],
      ["growth", 59.479341998814036],
      ["returns", 60],
      ["balanceSheet", 58.088235294117645],
      ["consistency", 83.33333333333334],
    ],
  );
  assert.equal(
    result.qualityScore.components.find(component => component.key === "returns").detail,
    "ROE 15.0%",
  );
  assert.equal(result.technicalScore.score, 94);
  assert.equal(result.technicalScore.basis, "3-month daily series");
  assert.deepEqual(
    result.technicalScore.components.map(({ key, score }) => [key, score]),
    [
      ["momentum", 87.3888888888889],
      ["rangePosition", 100],
      ["trend", 100],
    ],
  );
  assert.equal(
    result.technicalScore.components.find(component => component.key === "momentum").detail,
    "1M 3.9% · 6M 29.5% · 1Y 84.1%",
  );
  assert.equal(result.price, 199.75);
  assert.equal(result.marketCap, 199_750);
  assert.equal(result.fiscalYearBasis, 2025);
  assert.equal(result.methodologyVersion, "radar-v1");
  assert.equal(result.methodologySignature, "71a7dda167667be56b4cfa7a9ac204c17cadc2daf3c42826e7ae7c757e194d53");
  assert.equal(result.inputSignature, "b9c55ce720bf773e504f5328d69aaaeb6d028b9f73abcb07a7ef429324d0c8b4");
});

test("coverage routing distinguishes funds, missing filings, and scored issuers", () => {
  const fund = scoreRadarRecord(scoredInput({
    instrumentType: "ETF",
    chart: { timestamps: [FIXED_NOW_SECONDS], closes: [12.5] },
  }));
  const noFilings = scoreRadarRecord(scoredInput({ companyfacts: null, chart: null }));
  const scored = scoreRadarRecord(scoredInput({ chart: null }));

  assert.equal(fund.coverage, "fund");
  assert.equal(fund.qualityScore, null);
  assert.equal(fund.marketCap, 12_500);
  assert.equal(fund.fiscalYearBasis, 2025);
  assert.equal(noFilings.coverage, "no_filings");
  assert.equal(noFilings.qualityScore, null);
  assert.equal(scored.coverage, "scored");
  assert.notEqual(scored.qualityScore, null);
});

test("a chart-null issuer still receives its quality score", () => {
  const result = scoreRadarRecord(scoredInput({ chart: null }));

  assert.equal(result.coverage, "scored");
  assert.equal(result.qualityScore.score, 61);
  assert.equal(result.technicalScore, null);
  assert.equal(result.price, null);
  assert.equal(result.marketCap, null);
});

test("market capitalization is the chart price times current shares outstanding", () => {
  const result = scoreRadarRecord(scoredInput({
    chart: { timestamps: [FIXED_NOW_SECONDS], closes: [12.5] },
  }));

  assert.equal(result.price, 12.5);
  assert.equal(result.marketCap, 12_500);
});

test("the final chart slots remain authoritative when the last close is null", () => {
  const result = scoreRadarRecord(scoredInput({
    chart: {
      timestamps: [FIXED_NOW_SECONDS - DAY_SECONDS, FIXED_NOW_SECONDS],
      closes: [12.5, null],
    },
  }));

  assert.equal(result.price, null);
  assert.equal(result.marketCap, null);
  assert.notEqual(result.technicalScore, null);
  assert.equal(result.technicalScore.score, null);
  assert.equal(result.inputSignature, "b9c55ce720bf773e504f5328d69aaaeb6d028b9f73abcb07a7ef429324d0c8b4");
});

test("the CLI reads and writes ordered JSONL files", async () => {
  const scriptPath = fileURLToPath(new URL("../scripts/radar_score.mjs", import.meta.url));
  const tempDirectory = await mkdtemp(join(tmpdir(), "radar-score-"));
  const inputPath = join(tempDirectory, "input.jsonl");
  const outputPath = join(tempDirectory, "output.jsonl");
  const inputs = [
    {
      ticker: "NOSEC",
      companyfacts: null,
      chart: null,
      chains: ["ai"],
      memberships: { ai: ["Track / Subsector"] },
      instrumentType: "EQUITY",
    },
    {
      ticker: "FUND",
      companyfacts: null,
      chart: null,
      chains: ["robotics"],
      memberships: { robotics: ["Automation / Industrial"] },
      instrumentType: "MUTUALFUND",
    },
  ];

  try {
    await writeFile(inputPath, `${inputs.map(JSON.stringify).join("\n")}\n`, "utf8");
    await execFileAsync(process.execPath, [scriptPath, inputPath, outputPath], {
      cwd: dirname(scriptPath),
    });
    const output = (await readFile(outputPath, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map(JSON.parse);

    assert.deepEqual(output.map(row => row.ticker), ["NOSEC", "FUND"]);
    assert.deepEqual(output.map(row => row.coverage), ["no_filings", "fund"]);
    assert.deepEqual(output.map(row => row.chainCount), [1, 1]);
    assert.ok(output.every(row => row.methodologySignature === methodologySignature));
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
});
