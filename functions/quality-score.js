const COMPONENTS = [
  { key: "profitability", label: "Profitability", rawWeight: 0.25 },
  { key: "cashGeneration", label: "Cash generation", rawWeight: 0.20 },
  { key: "growth", label: "Growth", rawWeight: 0.20 },
  { key: "returns", label: "Returns", rawWeight: 0.15 },
  { key: "balanceSheet", label: "Balance sheet", rawWeight: 0.10 },
  { key: "consistency", label: "Consistency", rawWeight: 0.10 },
];

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scoreLinear(value, atZero, atHundred) {
  const numericValue = finiteNumber(value);
  if (numericValue == null) return null;

  const score = ((numericValue - atZero) / (atHundred - atZero)) * 100;
  return Math.min(100, Math.max(0, score));
}

function meanAvailable(values) {
  const available = values.filter(value => value != null);
  if (!available.length) return null;
  return available.reduce((sum, value) => sum + value, 0) / available.length;
}

function formatPercent(value) {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}

function formatRatio(value) {
  return value == null ? "—" : `${value.toFixed(2)}x`;
}

function latestMetricBasis(fundamentals) {
  const fiscalYears = Array.isArray(fundamentals?.fiscalYears)
    ? [...fundamentals.fiscalYears].sort((left, right) => Number(right) - Number(left))
    : [];
  const metricKeys = ["netMargin", "operatingMargin", "fcfMargin", "roe", "currentRatio", "debtToEquity"];

  for (const fiscalYear of fiscalYears) {
    if (metricKeys.some(key => finiteNumber(fundamentals?.metrics?.[key]?.[fiscalYear]) != null)) {
      return fiscalYear;
    }
  }
  return null;
}

export function computeQualityScore(fundamentals) {
  const basisYear = latestMetricBasis(fundamentals);
  const metrics = fundamentals?.metrics || {};
  const atBasis = key => basisYear == null ? null : finiteNumber(metrics?.[key]?.[basisYear]);
  const netMargin = atBasis("netMargin");
  const operatingMargin = atBasis("operatingMargin");
  const fcfMargin = atBasis("fcfMargin");
  const roe = atBasis("roe");
  const currentRatio = atBasis("currentRatio");
  const debtToEquity = atBasis("debtToEquity");
  const revenueCagr = finiteNumber(fundamentals?.growth?.revenueCagr);

  const fiscalYears = Array.isArray(fundamentals?.fiscalYears) ? fundamentals.fiscalYears : [];
  const netIncomeValues = fiscalYears
    .map(fiscalYear => finiteNumber(fundamentals?.statements?.income?.netIncome?.[fiscalYear]))
    .filter(value => value != null);
  const profitableYears = netIncomeValues.filter(value => value > 0).length;
  const consistencyScore = netIncomeValues.length
    ? (profitableYears / netIncomeValues.length) * 100
    : null;

  const componentValues = {
    profitability: {
      score: meanAvailable([
        scoreLinear(netMargin, 0, 20),
        scoreLinear(operatingMargin, 0, 25),
      ]),
      detail: `net ${formatPercent(netMargin)} · op ${formatPercent(operatingMargin)}`,
    },
    cashGeneration: {
      score: scoreLinear(fcfMargin, 0, 15),
      detail: `FCF ${formatPercent(fcfMargin)}`,
    },
    growth: {
      score: scoreLinear(revenueCagr, 0, 25),
      detail: `revenue CAGR ${formatPercent(revenueCagr)}`,
    },
    returns: {
      score: scoreLinear(roe == null ? null : roe * 100, 0, 25),
      detail: `ROE ${formatPercent(roe == null ? null : roe * 100)}`,
    },
    balanceSheet: {
      score: meanAvailable([
        scoreLinear(currentRatio, 0.8, 2.5),
        scoreLinear(debtToEquity, 2.0, 0.0),
      ]),
      detail: `current ${formatRatio(currentRatio)} · debt/equity ${formatRatio(debtToEquity)}`,
    },
    consistency: {
      score: consistencyScore,
      detail: netIncomeValues.length
        ? `${profitableYears}/${netIncomeValues.length} profitable years`
        : "—",
    },
  };

  const availableRawWeight = COMPONENTS.reduce((sum, component) =>
    componentValues[component.key].score == null ? sum : sum + component.rawWeight
  , 0);
  const components = COMPONENTS.map(component => {
    const value = componentValues[component.key];
    const included = value.score != null;
    return {
      key: component.key,
      label: component.label,
      weight: included && availableRawWeight > 0 ? component.rawWeight / availableRawWeight : 0,
      rawWeight: component.rawWeight,
      score: value.score,
      detail: value.detail,
    };
  });
  const included = components.filter(component => component.score != null);
  const excluded = components
    .filter(component => component.score == null)
    .map(component => component.key);
  const insufficient = included.length < 3;
  const weightedScore = included.reduce((sum, component) =>
    sum + component.score * component.weight
  , 0);

  return {
    score: insufficient || !Number.isFinite(weightedScore) ? null : Math.round(weightedScore),
    basis: basisYear == null ? null : `FY${basisYear}`,
    components,
    excluded,
    note: insufficient ? "Insufficient data to score (fewer than 3 components available)" : null,
  };
}
