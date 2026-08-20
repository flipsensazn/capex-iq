const WINDOW_SIZE = 126;
const PIVOT_RADIUS = 2;

function isValidPoint(point) {
  return typeof point?.date === "string"
    && point.date.length > 0
    && Number.isFinite(point.open)
    && Number.isFinite(point.high)
    && Number.isFinite(point.low)
    && Number.isFinite(point.close);
}

function findPivots(series) {
  const pivots = [];

  for (let index = PIVOT_RADIUS; index < series.length - PIVOT_RADIUS; index += 1) {
    const point = series[index];
    let isSwingHigh = true;
    let isSwingLow = true;

    for (let offset = -PIVOT_RADIUS; offset <= PIVOT_RADIUS; offset += 1) {
      if (offset === 0) continue;
      const neighbor = series[index + offset];
      if (point.high <= neighbor.high) isSwingHigh = false;
      if (point.low >= neighbor.low) isSwingLow = false;
    }

    if (isSwingHigh) pivots.push({ price: point.high, date: point.date });
    if (isSwingLow) pivots.push({ price: point.low, date: point.date });
  }

  return pivots;
}

function clusterPivots(pivots, tolerance) {
  const sorted = [...pivots].sort((left, right) => (
    left.price - right.price || left.date.localeCompare(right.date)
  ));
  const clusters = [];

  for (const pivot of sorted) {
    const current = clusters[clusters.length - 1];
    if (!current || pivot.price - current.firstPrice > tolerance) {
      clusters.push({
        firstPrice: pivot.price,
        prices: [pivot.price],
        lastTouch: pivot.date,
      });
      continue;
    }

    current.prices.push(pivot.price);
    if (pivot.date > current.lastTouch) current.lastTouch = pivot.date;
  }

  return clusters;
}

function compareRank(left, right) {
  if (left.touches !== right.touches) return right.touches - left.touches;
  if (left.lastTouch !== right.lastTouch) return left.lastTouch < right.lastTouch ? 1 : -1;
  return left.price - right.price;
}

export function findSupportResistance(points, displayFrom) {
  const allValidPoints = (Array.isArray(points) ? points : []).filter(isValidPoint);
  const pivotWindow = (Array.isArray(points) ? points : [])
    .slice(-WINDOW_SIZE)
    .filter(isValidPoint);
  if (pivotWindow.length < (PIVOT_RADIUS * 2) + 1) return [];

  const lastClose = pivotWindow[pivotWindow.length - 1].close;
  const tolerance = Math.abs(lastClose) * 0.01;
  const displayPoints = allValidPoints.filter(point => (
    typeof displayFrom !== "string" || !displayFrom || point.date >= displayFrom
  ));
  if (!displayPoints.length) return [];

  const displayMin = Math.min(...displayPoints.map(point => point.low)) * 0.97;
  const displayMax = Math.max(...displayPoints.map(point => point.high)) * 1.03;
  const levels = clusterPivots(findPivots(pivotWindow), tolerance)
    .filter(cluster => cluster.prices.length >= 2)
    .map(cluster => {
      const mean = cluster.prices.reduce((sum, price) => sum + price, 0)
        / cluster.prices.length;
      const price = Number(mean.toFixed(2));
      const difference = price - lastClose;
      if (difference === 0) return null;
      return {
        kind: difference < 0 ? "support" : "resistance",
        price,
        touches: cluster.prices.length,
        lastTouch: cluster.lastTouch,
      };
    })
    .filter(level => level && level.price >= displayMin && level.price <= displayMax);

  const supports = levels.filter(level => level.kind === "support")
    .sort(compareRank)
    .slice(0, 2);
  const resistances = levels.filter(level => level.kind === "resistance")
    .sort(compareRank)
    .slice(0, 2);
  return [...supports, ...resistances];
}
