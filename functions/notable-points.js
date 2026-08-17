function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function candidate(id, kind, point, detail) {
  return {
    id,
    kind,
    date: point.date,
    close: point.close,
    detail,
  };
}

export function findNotablePoints(points, displayFrom) {
  const series = (Array.isArray(points) ? points : [])
    .map((point, index) => ({
      ...point,
      close: finiteNumber(point?.close),
      originalIndex: index,
    }))
    .filter(point => typeof point.date === "string" && point.date && point.close != null)
    .sort((left, right) => left.date.localeCompare(right.date) || left.originalIndex - right.originalIndex);
  if (!series.length) return [];

  const firstDisplayDate = typeof displayFrom === "string" && displayFrom
    ? displayFrom
    : series[0].date;
  const displayPoints = series.filter(point => point.date >= firstDisplayDate);
  if (!displayPoints.length) return [];

  let periodHigh = displayPoints[0];
  let periodLow = displayPoints[0];
  for (const point of displayPoints.slice(1)) {
    if (point.close > periodHigh.close) periodHigh = point;
    if (point.close < periodLow.close) periodLow = point;
  }

  let biggestUp = null;
  let biggestDown = null;
  for (let index = 1; index < series.length; index += 1) {
    const point = series[index];
    const previous = series[index - 1];
    if (point.date < firstDisplayDate || previous.close === 0) continue;

    const percentMove = ((point.close - previous.close) / previous.close) * 100;
    if (percentMove > 0 && (biggestUp == null || percentMove > biggestUp.percentMove)) {
      biggestUp = { point, percentMove };
    }
    if (percentMove < 0 && (biggestDown == null || percentMove < biggestDown.percentMove)) {
      biggestDown = { point, percentMove };
    }
  }

  const crossings = [];
  let previousWithAverages = null;
  for (const point of series) {
    const ma20 = finiteNumber(point.ma20);
    const ma50 = finiteNumber(point.ma50);
    if (ma20 == null || ma50 == null) {
      previousWithAverages = null;
      continue;
    }

    if (previousWithAverages && point.date >= firstDisplayDate) {
      const previousDifference = previousWithAverages.ma20 - previousWithAverages.ma50;
      const currentDifference = ma20 - ma50;
      if (previousDifference <= 0 && currentDifference > 0) {
        crossings.push(candidate(
          `cross-${point.date}`,
          "goldenCross",
          point,
          "MA20 crossed above MA50",
        ));
      } else if (previousDifference >= 0 && currentDifference < 0) {
        crossings.push(candidate(
          `cross-${point.date}`,
          "deathCross",
          point,
          "MA20 crossed below MA50",
        ));
      }
    }
    previousWithAverages = { ma20, ma50 };
  }

  const result = [
    candidate("periodHigh", "periodHigh", periodHigh, "Highest close in display window"),
    candidate("periodLow", "periodLow", periodLow, "Lowest close in display window"),
  ];
  if (biggestUp) {
    result.push(candidate(
      "biggestUpDay",
      "biggestUpDay",
      biggestUp.point,
      `Largest up day: +${biggestUp.percentMove.toFixed(2)}%`,
    ));
  }
  if (biggestDown) {
    result.push(candidate(
      "biggestDownDay",
      "biggestDownDay",
      biggestDown.point,
      `Largest down day: ${biggestDown.percentMove.toFixed(2)}%`,
    ));
  }

  return [...result, ...crossings.slice(-3)];
}
