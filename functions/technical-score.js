const COMPONENTS = [
  { key: "momentum", label: "Momentum", rawWeight: 0.50 },
  { key: "rangePosition", label: "52-week position", rawWeight: 0.25 },
  { key: "trend", label: "Trend", rawWeight: 0.25 },
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

function formatNumber(value) {
  return value == null ? "—" : value.toFixed(2);
}

function latestTrendPoint(history) {
  const points = Array.isArray(history?.points) ? history.points : [];
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    const close = finiteNumber(point?.close);
    const ma20 = finiteNumber(point?.ma20);
    const ma200 = finiteNumber(point?.ma200);
    if (close != null && ma20 != null && ma200 != null) {
      return { close, ma20, ma200 };
    }
  }
  return null;
}

export function computeTechnicalScore(priceContext, history) {
  const change1M = finiteNumber(priceContext?.change1M);
  const change6M = finiteNumber(priceContext?.change6M);
  const change1Y = finiteNumber(priceContext?.change1Y);
  const price = finiteNumber(priceContext?.price);
  const week52Low = finiteNumber(priceContext?.week52Low);
  const week52High = finiteNumber(priceContext?.week52High);
  const pctOfRange = price != null && week52Low != null && week52High != null && week52High > week52Low
    ? ((price - week52Low) / (week52High - week52Low)) * 100
    : null;
  const trendPoint = latestTrendPoint(history);

  const componentValues = {
    momentum: {
      score: meanAvailable([
        scoreLinear(change1M, -15, 15),
        scoreLinear(change6M, -30, 30),
        scoreLinear(change1Y, -50, 50),
      ]),
      detail: `1M ${formatPercent(change1M)} · 6M ${formatPercent(change6M)} · 1Y ${formatPercent(change1Y)}`,
    },
    rangePosition: {
      score: scoreLinear(pctOfRange, 0, 100),
      detail: pctOfRange == null
        ? "—"
        : `${formatPercent(pctOfRange)} of 52-week range`,
    },
    trend: {
      score: trendPoint == null
        ? null
        : meanAvailable([
          trendPoint.close > trendPoint.ma200 ? 100 : 0,
          trendPoint.ma20 > trendPoint.ma200 ? 100 : 0,
        ]),
      detail: trendPoint == null
        ? "—"
        : `close ${formatNumber(trendPoint.close)} · MA20 ${formatNumber(trendPoint.ma20)} · MA200 ${formatNumber(trendPoint.ma200)}`,
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
  const insufficient = included.length < 2;
  const weightedScore = included.reduce((sum, component) =>
    sum + component.score * component.weight
  , 0);

  return {
    score: insufficient || !Number.isFinite(weightedScore) ? null : Math.round(weightedScore),
    basis: trendPoint == null ? null : "3-month daily series",
    components,
    excluded,
    note: insufficient ? "Insufficient data to score (fewer than 2 components available)" : null,
  };
}
