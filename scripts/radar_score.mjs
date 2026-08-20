import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { buildFundamentalsFromCompanyFacts } from "../functions/fundamentals.js";
import { buildPoints } from "../functions/history.js";
import { findRefPrices, pctFrom } from "../functions/prices.js";
import { computeQualityScore } from "../functions/quality-score.js";
import { computeTechnicalScore } from "../functions/technical-score.js";

const METHODOLOGY_VERSION = "radar-v2";
const FUND_INSTRUMENT_TYPES = new Set(["ETF", "MUTUALFUND"]);

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function stableSignature(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function readComponentTable(moduleUrl) {
  const source = readFileSync(fileURLToPath(moduleUrl), "utf8");
  const table = source.match(/const COMPONENTS\s*=\s*\[([\s\S]*?)\];/);
  if (!table) throw new Error(`Unable to find COMPONENTS in ${moduleUrl.pathname}`);

  const componentPattern = /\{\s*key:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*rawWeight:\s*([0-9]+(?:\.[0-9]+)?)\s*\}/g;
  const components = [...table[1].matchAll(componentPattern)].map(match => ({
    key: match[1],
    label: match[2],
    rawWeight: Number(match[3]),
  }));
  const unparsed = table[1].replace(componentPattern, "").replace(/[\s,]/g, "");
  if (!components.length || unparsed) {
    throw new Error(`Unable to parse COMPONENTS in ${moduleUrl.pathname}`);
  }
  return components;
}

const METHODOLOGY_COMPONENTS = {
  quality: readComponentTable(new URL("../functions/quality-score.js", import.meta.url)),
  technical: readComponentTable(new URL("../functions/technical-score.js", import.meta.url)),
};

const METHODOLOGY_DEFINITION = {
  version: METHODOLOGY_VERSION,
  technicalTrend: ["close>ma200", "ma20>ma200"],
  components: METHODOLOGY_COMPONENTS,
};

export const methodologySignature = stableSignature(METHODOLOGY_DEFINITION);

function chartInputs(chart) {
  const timestamps = chart?.timestamps;
  const quote = chart?.quote;
  const closes = quote?.close;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) return null;

  const finalClose = closes.at(-1);
  const finalTimestamp = timestamps.at(-1);
  const price = Number.isFinite(finalClose) ? finalClose : null;
  const refs = findRefPrices(timestamps, closes);
  const trailingCloses = closes.slice(-252).filter(Number.isFinite);
  const week52Low = trailingCloses.length ? Math.min(...trailingCloses) : null;
  const week52High = trailingCloses.length ? Math.max(...trailingCloses) : null;

  return {
    priceContext: {
      price,
      change1M: pctFrom(refs.r1M, price),
      change6M: pctFrom(refs.r6M, price),
      change1Y: pctFrom(refs.r1Y, price),
      week52Low,
      week52High,
    },
    history: { points: buildPoints(timestamps, quote) },
    lastChartTimestamp: Number.isFinite(finalTimestamp) ? finalTimestamp : null,
  };
}

function latestFiscalYear(fundamentals) {
  const fiscalYears = Array.isArray(fundamentals?.fiscalYears)
    ? fundamentals.fiscalYears.filter(Number.isFinite)
    : [];
  return fiscalYears.length ? Math.max(...fiscalYears) : null;
}

export function scoreRadarRecord(input) {
  const ticker = input?.ticker ?? null;
  const chains = Array.isArray(input?.chains) ? input.chains : [];
  const memberships = input?.memberships && typeof input.memberships === "object"
    ? input.memberships
    : {};
  const instrumentType = typeof input?.instrumentType === "string"
    ? input.instrumentType.toUpperCase()
    : null;
  const coverage = FUND_INSTRUMENT_TYPES.has(instrumentType)
    ? "fund"
    : input?.companyfacts == null
      ? "no_filings"
      : "scored";

  const chart = chartInputs(input?.chart);
  const technicalScore = chart
    ? computeTechnicalScore(chart.priceContext, chart.history)
    : null;
  const fundamentals = input?.companyfacts != null
    ? buildFundamentalsFromCompanyFacts(input.companyfacts)
    : null;
  const qualityScore = coverage === "scored"
    ? computeQualityScore(fundamentals)
    : null;
  const price = chart?.priceContext.price ?? null;
  const sharesOutstanding = fundamentals?.sharesOutstanding?.value;
  const marketCap = Number.isFinite(price) && Number.isFinite(sharesOutstanding)
    ? price * sharesOutstanding
    : null;
  const fiscalYearBasis = latestFiscalYear(fundamentals);
  const inputSignature = stableSignature({
    fiscalYearBasis,
    lastChartTimestamp: chart?.lastChartTimestamp ?? null,
  });

  return {
    ticker,
    coverage,
    qualityScore,
    technicalScore,
    price,
    marketCap,
    fiscalYearBasis,
    chainCount: chains.length,
    chains,
    memberships,
    methodologyVersion: METHODOLOGY_VERSION,
    methodologySignature,
    inputSignature,
  };
}

export async function scoreJsonlFile(inputPath, outputPath) {
  const input = createReadStream(inputPath, { encoding: "utf8" });
  const output = createWriteStream(outputPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      output.write(`${JSON.stringify(scoreRadarRecord(JSON.parse(line)))}\n`);
    }
  } finally {
    output.end();
    await finished(output);
  }
}

const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;

if (invokedUrl === import.meta.url) {
  const [inputPath, outputPath, ...extra] = process.argv.slice(2);
  if (!inputPath || !outputPath || extra.length) {
    console.error("Usage: node scripts/radar_score.mjs <input.jsonl> <output.jsonl>");
    process.exitCode = 2;
  } else {
    try {
      await scoreJsonlFile(inputPath, outputPath);
    } catch (error) {
      console.error(`[radar_score] ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}
