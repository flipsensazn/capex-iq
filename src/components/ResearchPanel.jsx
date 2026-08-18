import { useCallback, useEffect, useRef, useState } from "react";

export const PANEL_STYLE = {
  background: "var(--surface-card)",
  border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-2xl)",
  boxShadow: "var(--shadow-panel)",
};

export const EYEBROW_STYLE = {
  color: "var(--ink-400)",
  fontFamily: "var(--font-condensed)",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.15em",
  textTransform: "uppercase",
};

const STATEMENTS = [
  {
    key: "income",
    title: "Income Statement",
    chartRows: [
      ["revenue", "Revenue", "var(--accent)"],
      ["grossProfit", "Gross profit", "var(--info-400)"],
      ["operatingIncome", "Operating income", "var(--event-400)"],
      ["netIncome", "Net income", "var(--up-400)"],
    ],
    rows: [
      ["revenue", "Revenue", "currency"],
      ["grossProfit", "Gross profit", "currency"],
      ["operatingIncome", "Operating income", "currency"],
      ["netIncome", "Net income", "currency"],
      ["epsDiluted", "Diluted EPS", "eps"],
      ["researchDevelopment", "R&D", "currency"],
      ["sharesDiluted", "Diluted shares", "shares"],
    ],
  },
  {
    key: "balance",
    title: "Balance Sheet",
    chartRows: [
      ["totalAssets", "Total assets", "var(--accent)"],
      ["totalLiabilities", "Total liabilities", "var(--info-400)"],
      ["equity", "Equity", "var(--up-400)"],
    ],
    rows: [
      ["totalAssets", "Total assets", "currency"],
      ["totalLiabilities", "Total liabilities", "currency"],
      ["equity", "Equity", "currency"],
      ["cash", "Cash", "currency"],
      ["currentAssets", "Current assets", "currency"],
      ["currentLiabilities", "Current liabilities", "currency"],
      ["longTermDebt", "Long-term debt", "currency"],
    ],
  },
  {
    key: "cashFlow",
    title: "Cash Flow",
    chartRows: [
      ["operatingCashFlow", "Operating cash flow", "var(--accent)"],
      ["capex", "Capital expenditures", "var(--event-400)"],
      ["freeCashFlow", "Free cash flow", "var(--up-400)"],
    ],
    rows: [
      ["operatingCashFlow", "Operating cash flow", "currency"],
      ["capex", "Capital expenditures", "currency"],
      ["freeCashFlow", "Free cash flow", "currency"],
      ["dividendsPaid", "Dividends paid", "currency"],
      ["buybacks", "Share repurchases", "currency"],
    ],
  },
];

const METRICS = [
  ["grossMargin", "Gross margin", "percent"],
  ["operatingMargin", "Operating margin", "percent"],
  ["netMargin", "Net margin", "percent"],
  ["fcfMargin", "FCF margin", "percent"],
  ["roe", "ROE", "roe"],
  ["debtToEquity", "Debt / equity", "ratio"],
  ["currentRatio", "Current ratio", "ratio"],
  ["revenueCagr", "Revenue CAGR", "percent"],
];

const CASE_META = {
  bear: { label: "Bear", color: "var(--down-400)" },
  base: { label: "Base", color: "var(--accent)" },
  bull: { label: "Bull", color: "var(--pos)" },
};

function decimalsFor(scaled) {
  return Math.abs(scaled) >= 100 ? 1 : 2;
}

function formatMagnitude(value, kind) {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  const prefix = kind === "currency" || kind === "eps" ? "$" : "";

  if (kind === "eps") return `${sign}${prefix}${absolute.toFixed(2)}`;
  if (absolute >= 1e9) {
    const scaled = absolute / 1e9;
    return `${sign}${prefix}${scaled.toFixed(decimalsFor(scaled))}B`;
  }
  if (absolute >= 1e6) {
    const scaled = absolute / 1e6;
    return `${sign}${prefix}${scaled.toFixed(decimalsFor(scaled))}M`;
  }
  return `${sign}${prefix}${absolute.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}

function formatRatio(value) {
  return Number.isFinite(value) ? `${value.toFixed(2)}×` : "—";
}

function formatPrice(value) {
  return Number.isFinite(value) && value >= 0 ? `$${value.toFixed(2)}` : "—";
}

function formatSignedPercent(value) {
  if (!Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

async function responseError(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const message = response.status === 403
    ? body?.code === "members_only"
      ? "Full financial research is a members feature."
      : "Admin access required"
    : response.status === 404
      ? "No SEC filer found for that ticker — US SEC filers only"
      : body?.error || `Request failed (${response.status})`;
  return {
    message,
    detail: typeof body?.detail === "string" ? body.detail : "",
  };
}

function StatementTable({ definition, statement, years }) {
  return (
    <div style={{ width: "100%", maxWidth: "100%", minWidth: 0, overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 560, borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...EYEBROW_STYLE, position: "sticky", left: 0, zIndex: 1, background: "var(--void-500)", textAlign: "left", padding: "9px 16px", borderTop: "1px solid var(--border-hairline)" }}>Filed figures</th>
            {years.map(year => (
              <th key={year} style={{ ...EYEBROW_STYLE, textAlign: "right", padding: "9px 14px", borderTop: "1px solid var(--border-hairline)" }}>{year}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {definition.rows.map(([key, label, kind]) => (
            <tr key={key}>
              <td style={{ position: "sticky", left: 0, zIndex: 1, background: "var(--void-500)", color: "var(--ink-300)", fontSize: 11, padding: "9px 16px", borderTop: "1px solid var(--border-hairline)", whiteSpace: "nowrap" }}>{label}</td>
              {years.map(year => {
                const value = statement?.[key]?.[year];
                return (
                  <td
                    key={year}
                    style={{
                      color: Number.isFinite(value) && value < 0 ? "var(--down-400)" : "var(--ink-100)",
                      fontFamily: "var(--font-mono)",
                      fontSize: 11,
                      padding: "9px 14px",
                      textAlign: "right",
                      borderTop: "1px solid var(--border-hairline)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatMagnitude(value, kind)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SeriesChart({ title, series, years, formatValue }) {
  const width = 420;
  const height = 320;
  const margin = { top: 14, right: 10, bottom: 30, left: 52 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const values = series.flatMap(item => years
    .map(year => item.values?.[year])
    .filter(Number.isFinite));
  const hasData = values.length > 0;
  const dataMin = hasData ? Math.min(...values) : 0;
  const dataMax = hasData ? Math.max(...values) : 0;
  const domainMin = Math.min(0, dataMin);
  const naturalMax = Math.max(0, dataMax);
  const domainMax = naturalMax === domainMin ? domainMin + 1 : naturalMax;
  const domainRange = domainMax - domainMin;
  const yFor = value => margin.top + ((domainMax - value) / domainRange) * plotHeight;
  const zeroY = yFor(0);
  const ticks = [domainMax, (domainMax + domainMin) / 2, domainMin];
  const yearWidth = years.length ? plotWidth / years.length : plotWidth;
  const groupWidth = yearWidth * 0.72;
  const barGap = 2;
  const barWidth = Math.max(2, (groupWidth - barGap * Math.max(0, series.length - 1)) / Math.max(1, series.length));

  return (
    <>
      <div style={{ padding: "14px 16px 4px" }}>
        <div style={EYEBROW_STYLE}>{title}</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 10px", marginTop: 9 }}>
          {series.map(item => (
            <div key={item.label} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--ink-300)", fontSize: 9 }}>
              <span style={{ width: 6, height: 6, flex: "0 0 6px", borderRadius: 2, background: item.color }} />
              {item.label}
            </div>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${title} grouped bar chart`}
        style={{ display: "block", width: "100%", height: "auto" }}
      >
        {ticks.map((tick, index) => {
          const y = yFor(tick);
          return (
            <g key={`${tick}-${index}`}>
              <line x1={margin.left} x2={width - margin.right} y1={y} y2={y} stroke="var(--border-hairline)" />
              <text x={margin.left - 7} y={y + 3} textAnchor="end" fill="var(--ink-500)" fontFamily="var(--font-mono)" fontSize="8">
                {hasData ? formatValue(tick) : "—"}
              </text>
            </g>
          );
        })}
        <line x1={margin.left} x2={width - margin.right} y1={zeroY} y2={zeroY} stroke="var(--border-soft)" />
        {years.map((year, yearIndex) => {
          const groupX = margin.left + yearIndex * yearWidth + (yearWidth - groupWidth) / 2;
          return (
            <g key={year}>
              {series.map((item, seriesIndex) => {
                const value = item.values?.[year];
                if (!Number.isFinite(value)) return null;
                const valueY = yFor(value);
                return (
                  <rect
                    key={item.label}
                    x={groupX + seriesIndex * (barWidth + barGap)}
                    y={Math.min(valueY, zeroY)}
                    width={barWidth}
                    height={Math.abs(valueY - zeroY)}
                    rx="1.5"
                    fill={value < 0 ? "var(--down-400)" : item.color}
                  >
                    <title>{`${item.label} · FY ${year} · ${formatValue(value)}`}</title>
                  </rect>
                );
              })}
              <text x={margin.left + yearIndex * yearWidth + yearWidth / 2} y={height - 11} textAnchor="middle" fill="var(--ink-400)" fontFamily="var(--font-mono)" fontSize="9">
                {year}
              </text>
            </g>
          );
        })}
        {!hasData && (
          <text x={margin.left + plotWidth / 2} y={margin.top + plotHeight / 2} textAnchor="middle" fill="var(--ink-500)" fontSize="11">
            No filed data
          </text>
        )}
      </svg>
    </>
  );
}

function StatementChart({ definition, statement, years }) {
  const [showFigures, setShowFigures] = useState(false);
  const series = definition.chartRows.map(([key, label, color]) => ({
    label,
    values: statement?.[key] ?? {},
    color,
  }));

  return (
    <section style={{ ...PANEL_STYLE, minWidth: 0, overflow: "hidden" }}>
      <SeriesChart
        title={definition.title}
        series={series}
        years={years}
        formatValue={value => formatMagnitude(value, "currency")}
      />
      <div style={{ padding: "0 16px 14px" }}>
        <button
          type="button"
          aria-expanded={showFigures}
          onClick={() => setShowFigures(value => !value)}
          style={{ background: "none", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-sm)", color: "var(--ink-400)", padding: "5px 8px", fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", cursor: "pointer" }}
        >
          {showFigures ? "Hide figures" : "Show figures"}
        </button>
      </div>
      {showFigures && <StatementTable definition={definition} statement={statement} years={years} />}
    </section>
  );
}

function MetricsStrip({ data, latestYear }) {
  return (
    <section style={{ ...PANEL_STYLE, padding: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8 }}>
      {METRICS.map(([key, label, kind]) => {
        const value = key === "revenueCagr"
          ? data.growth?.revenueCagr
          : data.metrics?.[key]?.[latestYear];
        const displayValue = kind === "roe"
          ? formatPercent(Number.isFinite(value) ? value * 100 : null)
          : kind === "ratio"
            ? formatRatio(value)
            : formatPercent(value);
        return (
          <div key={key} style={{ padding: "9px 10px", borderRadius: 10, border: "1px solid var(--border-hairline)", background: "rgba(255,255,255,0.02)" }}>
            <div style={EYEBROW_STYLE}>{label}</div>
            <div style={{ marginTop: 5, color: Number.isFinite(value) && value < 0 ? "var(--down-400)" : "var(--ink-100)", fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 700 }}>{displayValue}</div>
          </div>
        );
      })}
    </section>
  );
}

function MarketContextStrip({ research }) {
  const context = research?.marketContext;
  const shareCount = Number.isFinite(research?.shareCount)
    ? formatMagnitude(research.shareCount, "shares")
    : "—";
  const shareBasis = research?.shareCountBasis === "current_outstanding"
    ? `current outstanding${research.shareCountAsOf ? `, as of ${research.shareCountAsOf}` : ""}`
    : research?.shareCountBasis === "weighted_average_diluted"
      ? "FY weighted-average diluted"
      : "basis unavailable";

  return (
    <div style={{ marginBottom: 14, padding: "12px 14px", border: "1px solid var(--border-hairline)", borderRadius: 12, background: "rgba(255,255,255,0.02)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
        {[
          ["Current price", formatPrice(research?.currentPrice)],
          ["Market cap", formatMagnitude(context?.marketCap, "currency")],
          ["Current P/S", formatRatio(context?.currentPs)],
          ["Current P/E", formatRatio(context?.currentPe)],
        ].map(([label, value]) => (
          <div key={label}>
            <div style={EYEBROW_STYLE}>{label}</div>
            <div style={{ marginTop: 4, color: "var(--ink-100)", fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 10, paddingTop: 9, borderTop: "1px solid var(--border-hairline)", color: "var(--ink-300)", fontFamily: "var(--font-mono)", fontSize: 10.5 }}>
        {shareCount} shares ({shareBasis})
      </div>
    </div>
  );
}

function priceChangeColor(value) {
  if (Number.isFinite(value) && value > 0) return "var(--up-400)";
  if (Number.isFinite(value) && value < 0) return "var(--down-400)";
  return "var(--ink-300)";
}

function formatChartDate(date) {
  if (typeof date !== "string") return "—";
  const [year, month, day] = date.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return date;
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function annotationColor(kind) {
  if (["periodHigh", "goldenCross", "biggestUpDay"].includes(kind)) return "var(--up-400)";
  if (["periodLow", "deathCross", "biggestDownDay"].includes(kind)) return "var(--down-400)";
  return "var(--accent)";
}

function PriceChart({ history, annotations }) {
  if (!history || !Array.isArray(history.points)) return null;

  const startIndex = typeof history.displayFrom === "string"
    ? history.points.findIndex(point => typeof point?.date === "string" && point.date >= history.displayFrom)
    : 0;
  const points = (startIndex >= 0 ? history.points.slice(startIndex) : [])
    .filter(point => typeof point?.date === "string" && Number.isFinite(point.close));
  if (points.length < 2) return null;

  const width = 760;
  const height = 300;
  const margin = { top: 40, right: 14, bottom: 30, left: 56 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const plotBottom = height - margin.bottom;
  const values = points.flatMap(point => [point.close, point.ma20, point.ma50].filter(Number.isFinite));
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const naturalRange = dataMax - dataMin;
  const domainPadding = naturalRange > 0 ? naturalRange * 0.08 : Math.max(Math.abs(dataMax) * 0.02, 1);
  const domainMin = dataMin - domainPadding;
  const domainMax = dataMax + domainPadding;
  const domainRange = domainMax - domainMin;
  const xFor = index => margin.left + (index / (points.length - 1)) * plotWidth;
  const yFor = value => margin.top + ((domainMax - value) / domainRange) * plotHeight;
  const yTicks = [domainMax, (domainMax + domainMin) / 2, domainMin];
  const xTickCount = Math.min(5, points.length);
  const xTickIndexes = [...new Set(Array.from(
    { length: xTickCount },
    (_, index) => Math.round((index / Math.max(1, xTickCount - 1)) * (points.length - 1)),
  ))];

  function segmentsFor(key) {
    const segments = [];
    let segment = [];
    points.forEach((point, index) => {
      const value = point[key];
      if (Number.isFinite(value)) {
        segment.push([xFor(index), yFor(value)]);
      } else if (segment.length) {
        segments.push(segment);
        segment = [];
      }
    });
    if (segment.length) segments.push(segment);
    return segments.filter(item => item.length > 1);
  }

  const lineSeries = [
    { key: "close", label: "Close", color: "var(--accent)", strokeWidth: 1.6, dasharray: null },
    { key: "ma20", label: "MA20", color: "var(--info-400)", strokeWidth: 1.1, dasharray: "3 3" },
    { key: "ma50", label: "MA50", color: "var(--event-400)", strokeWidth: 1.1, dasharray: "8 4" },
  ].map(series => ({ ...series, segments: segmentsFor(series.key) }));

  const pointByDate = new Map(points.map((point, index) => [point.date, { point, index }]));
  const labelHeight = 15;
  const chartBottom = height - 20;
  const placedLabels = [];
  const annotationLayouts = (Array.isArray(annotations) ? annotations : [])
    .map((annotation, originalIndex) => {
      const match = pointByDate.get(annotation?.date);
      const label = typeof annotation?.label === "string" ? annotation.label.trim() : "";
      if (!match || !label || !Number.isFinite(match.point.close)) return null;
      return { annotation, label, originalIndex, ...match };
    })
    .filter(Boolean)
    .sort((left, right) => left.index - right.index || left.originalIndex - right.originalIndex)
    .map(item => {
      const markerX = xFor(item.index);
      const markerY = yFor(item.point.close);
      const labelWidth = Math.min(width - 8, Math.max(34, item.label.length * 5.3 + 10));
      const desiredX = markerX - labelWidth / 2;
      const rectX = Math.min(width - labelWidth - 3, Math.max(3, desiredX));
      const horizontalOverlaps = placedLabels.filter(label =>
        rectX < label.x + label.width + 3 && rectX + labelWidth + 3 > label.x
      );
      const lastOverlap = horizontalOverlaps[horizontalOverlaps.length - 1];
      const preferredSide = lastOverlap?.side === "above" ? "below" : "above";
      const sideOrder = [preferredSide, preferredSide === "above" ? "below" : "above"];
      const candidates = [];

      for (let gap = 9; gap <= 117; gap += 18) {
        sideOrder.forEach(side => {
          const y = side === "above" ? markerY - gap - labelHeight : markerY + gap;
          if (y >= 3 && y + labelHeight <= chartBottom) candidates.push({ y, side });
        });
      }

      let placement = candidates.find(candidate => !placedLabels.some(label =>
        rectX < label.x + label.width + 3
        && rectX + labelWidth + 3 > label.x
        && candidate.y < label.y + labelHeight + 3
        && candidate.y + labelHeight + 3 > label.y
      ));

      if (!placement) {
        for (let y = 3; y + labelHeight <= chartBottom; y += labelHeight + 3) {
          const overlaps = placedLabels.some(label =>
            rectX < label.x + label.width + 3
            && rectX + labelWidth + 3 > label.x
            && y < label.y + labelHeight + 3
            && y + labelHeight + 3 > label.y
          );
          if (!overlaps) {
            placement = { y, side: y + labelHeight / 2 < markerY ? "above" : "below" };
            break;
          }
        }
      }

      if (!placement) {
        const side = preferredSide;
        placement = {
          side,
          y: Math.min(chartBottom - labelHeight, Math.max(3, side === "above" ? markerY - 24 : markerY + 9)),
        };
      }

      const nearLeft = desiredX < 3;
      const nearRight = desiredX > width - labelWidth - 3;
      const textAnchor = nearLeft ? "start" : nearRight ? "end" : "middle";
      const textX = nearLeft ? rectX + 5 : nearRight ? rectX + labelWidth - 5 : rectX + labelWidth / 2;
      const layout = {
        ...item,
        markerX,
        markerY,
        x: rectX,
        y: placement.y,
        width: labelWidth,
        side: placement.side,
        textAnchor,
        textX,
      };
      placedLabels.push(layout);
      return layout;
    });

  return (
    <div style={{ width: "100%", maxWidth: "100%", minWidth: 0, marginTop: 10, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "6px 12px", padding: "0 2px 5px" }}>
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: "6px 11px" }}>
          {lineSeries.map(series => (
            <div key={series.key} style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "var(--ink-300)", fontSize: 9 }}>
              <svg width="18" height="6" aria-hidden="true" style={{ flex: "0 0 auto" }}>
                <line x1="0" x2="18" y1="3" y2="3" stroke={series.color} strokeWidth={series.strokeWidth} strokeDasharray={series.dasharray || undefined} />
              </svg>
              {series.label}
            </div>
          ))}
        </div>
        <div style={{ color: "var(--ink-500)", fontFamily: "var(--font-mono)", fontSize: 9 }}>
          {formatChartDate(points[0].date)} – {formatChartDate(points[points.length - 1].date)}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${history.ticker || "Ticker"} three-month closing price with moving averages`}
        style={{ display: "block", width: "100%", maxWidth: "100%", height: "auto" }}
      >
        {yTicks.map((tick, index) => {
          const y = yFor(tick);
          return (
            <g key={`${tick}-${index}`}>
              <line x1={margin.left} x2={width - margin.right} y1={y} y2={y} stroke="var(--border-hairline)" />
              <text x={margin.left - 7} y={y + 3} textAnchor="end" fill="var(--ink-500)" fontFamily="var(--font-mono)" fontSize="8.5">
                {formatPrice(tick)}
              </text>
            </g>
          );
        })}
        <line x1={margin.left} x2={width - margin.right} y1={plotBottom} y2={plotBottom} stroke="var(--border-hairline)" />
        {lineSeries.map(series => series.segments.map((segment, index) => (
          <path
            key={`${series.key}-${index}`}
            d={segment.map(([x, y], pointIndex) => `${pointIndex ? "L" : "M"} ${x.toFixed(2)} ${y.toFixed(2)}`).join(" ")}
            fill="none"
            stroke={series.color}
            strokeWidth={series.strokeWidth}
            strokeDasharray={series.dasharray || undefined}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )))}
        {xTickIndexes.map(index => {
          const x = xFor(index);
          const textAnchor = index === 0 ? "start" : index === points.length - 1 ? "end" : "middle";
          return (
            <text key={points[index].date} x={x} y={height - 10} textAnchor={textAnchor} fill="var(--ink-500)" fontFamily="var(--font-mono)" fontSize="9">
              {formatChartDate(points[index].date)}
            </text>
          );
        })}
        {annotationLayouts.map(layout => {
          const color = annotationColor(layout.annotation.kind);
          const leaderEndX = Math.min(layout.x + layout.width - 4, Math.max(layout.x + 4, layout.markerX));
          const leaderEndY = layout.side === "above" ? layout.y + labelHeight : layout.y;
          return (
            <g key={`${layout.annotation.id || layout.annotation.date}-${layout.originalIndex}`}>
              <line
                x1={layout.markerX}
                x2={leaderEndX}
                y1={layout.markerY + (layout.side === "above" ? -4 : 4)}
                y2={leaderEndY}
                stroke={color}
                strokeWidth="0.8"
                opacity="0.8"
              />
              <rect x={layout.x} y={layout.y} width={layout.width} height={labelHeight} rx="2.5" fill="var(--surface-card)" fillOpacity="0.9" stroke="var(--border-hairline)" />
              <text x={layout.textX} y={layout.y + 10.5} textAnchor={layout.textAnchor} fill="var(--ink-200)" fontFamily="var(--font-mono)" fontSize="8.5">
                {layout.label}
              </text>
              <circle cx={layout.markerX} cy={layout.markerY} r="3.5" fill={color}>
                <title>{`${layout.label} · ${layout.annotation.date} · ${formatPrice(layout.point.close)}`}</title>
              </circle>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function PriceContextStrip({ priceContext }) {
  const items = [
    ["Price", formatPrice(priceContext?.price), "var(--ink-100)"],
    ["5D", formatSignedPercent(priceContext?.change5D), priceChangeColor(priceContext?.change5D)],
    ["1M", formatSignedPercent(priceContext?.change1M), priceChangeColor(priceContext?.change1M)],
    ["6M", formatSignedPercent(priceContext?.change6M), priceChangeColor(priceContext?.change6M)],
    ["YTD", formatSignedPercent(priceContext?.changeYTD), priceChangeColor(priceContext?.changeYTD)],
    ["1Y", formatSignedPercent(priceContext?.change1Y), priceChangeColor(priceContext?.change1Y)],
    ["52-week range", `${formatPrice(priceContext?.week52Low)} – ${formatPrice(priceContext?.week52High)}`, "var(--ink-100)"],
  ];

  return (
    <div style={{ marginTop: 12, padding: "10px 11px", border: "1px solid var(--border-hairline)", borderRadius: 10, background: "rgba(255,255,255,0.02)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(82px, 1fr))", gap: 10 }}>
        {items.map(([label, value, color]) => (
          <div key={label} style={{ minWidth: 0 }}>
            <div style={EYEBROW_STYLE}>{label}</div>
            <div style={{ marginTop: 4, color, fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, whiteSpace: "nowrap" }}>{value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function hasLensContent(lens) {
  const hasRead = typeof lens?.read === "string" && lens.read.trim();
  const hasPoints = Array.isArray(lens?.points) && lens.points.some(point => typeof point === "string" && point.trim());
  return Boolean(hasRead || hasPoints);
}

function AnalysisLens({ eyebrow, lens, beforeRead, children }) {
  const read = typeof lens?.read === "string" ? lens.read.trim() : "";
  const points = Array.isArray(lens?.points)
    ? lens.points.filter(point => typeof point === "string" && point.trim()).map(point => point.trim())
    : [];
  if (!read && !points.length && !beforeRead && !children) return null;

  return (
    <article style={{ minWidth: 0, border: "1px solid var(--border-hairline)", borderRadius: 12, padding: 14, background: "rgba(255,255,255,0.02)" }}>
      <div style={EYEBROW_STYLE}>{eyebrow}</div>
      {beforeRead}
      {read && <p style={{ margin: "8px 0 0", color: "var(--ink-200)", fontSize: 11.5, lineHeight: 1.6 }}>{read}</p>}
      {points.length > 0 && (
        <ul style={{ margin: "10px 0 0", paddingLeft: 17, color: "var(--ink-300)", fontSize: 11, lineHeight: 1.55 }}>
          {points.map((point, index) => <li key={`${eyebrow}-${index}`} style={{ marginBottom: 5 }}>{point}</li>)}
        </ul>
      )}
      {children}
    </article>
  );
}

export function ScoreBreakdown({ title, scoreObject }) {
  const components = Array.isArray(scoreObject?.components) ? scoreObject.components : [];
  if (!components.length) return null;

  return (
    <div style={{ marginTop: 13, padding: "11px 12px", border: "1px solid var(--border-hairline)", borderRadius: 10, background: "rgba(255,255,255,0.015)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 9 }}>
        <div style={EYEBROW_STYLE}>{title}</div>
        <div style={{ color: "var(--ink-500)", fontFamily: "var(--font-mono)", fontSize: 9.5 }}>{scoreObject.basis || "No fiscal-year basis"}</div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: "9px 18px" }}>
        {components.map(component => {
          const included = Number.isFinite(component?.score);
          const barWidth = included ? Math.min(100, Math.max(0, component.score)) : 0;
          return (
            <div key={component.key} style={{ opacity: included ? 1 : 0.48 }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
                <span style={{ color: included ? "var(--ink-300)" : "var(--ink-500)", fontSize: 10.5 }}>{component.label}</span>
                <span style={{ color: included ? "var(--ink-200)" : "var(--ink-500)", fontFamily: "var(--font-mono)", fontSize: 10 }}>
                  {included ? `${component.score.toFixed(0)}/100 · ${(component.weight * 100).toFixed(1)}% weight` : "— · excluded (no filed data)"}
                </span>
              </div>
              <div style={{ height: 3, marginTop: 5, overflow: "hidden", borderRadius: 999, background: "rgba(255,255,255,.06)" }}>
                <div style={{ width: `${barWidth}%`, height: "100%", borderRadius: 999, background: included ? "var(--accent)" : "transparent" }} />
              </div>
              <div style={{ marginTop: 4, color: "var(--ink-500)", fontSize: 9.5 }}>{component.detail}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CompositeSummary({ composite }) {
  if (!composite || typeof composite !== "object") return null;

  const score = Number.isFinite(composite.score) ? `${composite.score.toFixed(0)}/100` : "—";
  const verdict = ["BUY", "HOLD", "SELL"].includes(composite.verdict) ? composite.verdict : null;
  const verdictColor = verdict === "BUY"
    ? "var(--up-400)"
    : verdict === "HOLD"
      ? "var(--warn)"
      : "var(--down-400)";
  const lenses = Array.isArray(composite.lenses) ? composite.lenses : [];

  return (
    <div style={{ marginTop: 14, padding: "13px 14px", border: "1px solid var(--border-hairline)", borderRadius: 12, background: "rgba(255,255,255,0.02)" }}>
      <div style={EYEBROW_STYLE}>Composite score</div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginTop: 4, flexWrap: "wrap" }}>
        <span style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 27, fontWeight: 800 }}>{score}</span>
        {verdict && (
          <span style={{ color: verdictColor, background: `color-mix(in srgb, ${verdictColor} 12%, transparent)`, border: `1px solid color-mix(in srgb, ${verdictColor} 42%, var(--border-hairline))`, borderRadius: 999, padding: "4px 8px", fontFamily: "var(--font-condensed)", fontSize: 9, fontWeight: 800, letterSpacing: "0.13em", textTransform: "uppercase" }}>
            {verdict}
          </span>
        )}
      </div>
      <div style={{ marginTop: 4, color: "var(--ink-500)", fontSize: 9.5, lineHeight: 1.45 }}>
        Model-assisted composite from filed figures and price data — not investment advice.
      </div>
      {!Number.isFinite(composite.score) && composite.note && (
        <div style={{ marginTop: 5, color: "var(--ink-400)", fontSize: 10 }}>{composite.note}</div>
      )}
      {lenses.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8, marginTop: 12 }}>
          {lenses.map(lens => {
            const scored = Number.isFinite(lens?.score);
            const qualitative = lens?.unscored === true;
            const weight = Number.isFinite(lens?.weight) ? `${(lens.weight * 100).toFixed(1)}% applied` : "— applied";
            return (
              <div key={lens.key} style={{ minWidth: 0, padding: "9px 10px", border: "1px solid var(--border-hairline)", borderRadius: 9, opacity: qualitative || !scored ? 0.55 : 1 }}>
                <div style={{ ...EYEBROW_STYLE, color: scored ? "var(--ink-400)" : "var(--ink-500)" }}>{lens.label}</div>
                <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6, marginTop: 5, flexWrap: "wrap" }}>
                  <span style={{ color: scored ? "var(--ink-100)" : "var(--ink-500)", fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 700 }}>
                    {scored ? `${lens.score.toFixed(0)}/100` : "—"}
                  </span>
                  <span style={{ color: "var(--ink-500)", fontFamily: "var(--font-mono)", fontSize: 9 }}>{weight}</span>
                </div>
                {qualitative && <div style={{ marginTop: 3, color: "var(--ink-500)", fontSize: 9.5 }}>qualitative</div>}
                {lens.note && <div style={{ marginTop: 4, color: "var(--ink-500)", fontSize: 9.5, lineHeight: 1.4 }}>{lens.note}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ResearchCases({ cases, currentPrice }) {
  const multipleUnit = cases?.multipleType === "pe"
    ? "P/E"
    : cases?.multipleType === "ps"
      ? "P/S"
      : null;

  return (
    <div>
      {multipleUnit && <div style={{ ...EYEBROW_STYLE, marginBottom: 10 }}>Valued on {multipleUnit}</div>}
      {cases?.ordering?.valid === false && (
        <div
          role="alert"
          style={{ marginBottom: 12, padding: "11px 12px", color: "var(--down-400)", background: "color-mix(in srgb, var(--down-400) 12%, transparent)", border: "1px solid var(--down-400)", borderRadius: 10, fontSize: 11, fontWeight: 700, lineHeight: 1.5 }}
        >
          <div style={{ ...EYEBROW_STYLE, color: "var(--down-400)", marginBottom: 3 }}>Scenario ordering error</div>
          {cases.ordering.message}
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
        {Object.entries(CASE_META).map(([key, meta]) => {
          const scenario = cases?.[key];
          const vsCurrent = Number.isFinite(scenario?.impliedPrice) && Number.isFinite(currentPrice) && currentPrice > 0
            ? ((scenario.impliedPrice / currentPrice) - 1) * 100
            : null;
          const vsCurrentColor = vsCurrent > 0
            ? "var(--up-400)"
            : vsCurrent < 0
              ? "var(--down-400)"
              : "var(--ink-300)";
          const exitMultiple = multipleUnit
            ? `${formatRatio(scenario?.multipleValue)} ${multipleUnit}`
            : formatRatio(scenario?.multipleValue);
          const impliedPs = Number.isFinite(scenario?.impliedPs)
            ? `${formatRatio(scenario.impliedPs)}${Number.isFinite(cases?.currentPs) ? ` (now ${formatRatio(cases.currentPs)})` : ""}`
            : "—";
          return (
            <article key={key} style={{ border: `1px solid color-mix(in srgb, ${meta.color} 30%, var(--border-hairline))`, borderRadius: 14, padding: 14, background: "rgba(255,255,255,0.02)" }}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ ...EYEBROW_STYLE, color: meta.color }}>{meta.label} case</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "7px 12px", alignItems: "baseline" }}>
                <span style={{ color: "var(--ink-400)", fontSize: 10 }}>Revenue CAGR</span>
                <span style={{ color: "var(--ink-100)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{formatPercent(scenario?.revenueCagr)}</span>
                <span style={{ color: "var(--ink-400)", fontSize: 10 }}>Exit net margin</span>
                <span style={{ color: "var(--ink-100)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{formatPercent(scenario?.exitNetMargin)}</span>
                <span style={{ color: "var(--ink-400)", fontSize: 10 }}>Exit multiple</span>
                <span style={{ color: "var(--ink-100)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{exitMultiple}</span>
                <span style={{ color: "var(--ink-400)", fontSize: 10 }}>Projected FY revenue</span>
                <span style={{ color: "var(--ink-200)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{formatMagnitude(scenario?.projectedRevenue, "currency")}</span>
                <span style={{ color: "var(--ink-400)", fontSize: 10 }}>Implied P/S</span>
                <span style={{ color: "var(--ink-200)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{impliedPs}</span>
                <span style={{ color: "var(--ink-300)", fontSize: 10, fontWeight: 700 }}>Implied price</span>
                <span style={{ textAlign: "right" }}>
                  <span style={{ color: meta.color, fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800 }}>{formatPrice(scenario?.impliedPrice)}</span>
                  {scenario?.impliedPrice == null && scenario?.methodError && (
                    <span style={{ display: "block", maxWidth: 170, marginTop: 3, color: "var(--ink-400)", fontSize: 10, lineHeight: 1.35 }}>{scenario.methodError}</span>
                  )}
                </span>
                <span style={{ color: "var(--ink-400)", fontSize: 10 }}>vs current</span>
                <span style={{ color: vsCurrentColor, fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, textAlign: "right" }}>{formatSignedPercent(vsCurrent)}</span>
              </div>
              {scenario?.rationale && <p style={{ margin: "12px 0 0", color: "var(--ink-300)", fontSize: 11, lineHeight: 1.55 }}>{scenario.rationale}</p>}
            </article>
          );
        })}
      </div>
    </div>
  );
}

export default function ResearchPanel({ initialTicker }) {
  const [tickerInput, setTickerInput] = useState("");
  const [fundamentals, setFundamentals] = useState(null);
  const [research, setResearch] = useState(null);
  const [fundamentalsLoading, setFundamentalsLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [fundamentalsError, setFundamentalsError] = useState("");
  const [aiError, setAiError] = useState(null);
  const lastAutoRunTicker = useRef(null);
  const requestControllerRef = useRef(null);

  const runResearch = useCallback(async tickerValue => {
    const ticker = typeof tickerValue === "string" ? tickerValue.trim().toUpperCase() : "";
    setTickerInput(ticker);
    setFundamentals(null);
    setResearch(null);
    setFundamentalsError("");
    setAiError(null);
    if (!ticker) return;

    requestControllerRef.current?.abort();
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const isCurrentRequest = () => requestControllerRef.current === controller;

    setAiLoading(false);
    setFundamentalsLoading(true);
    let fundamentalsLoaded = false;
    let fundamentalsTimedOut = false;
    const fundamentalsTimeout = setTimeout(() => {
      fundamentalsTimedOut = true;
      controller.abort();
    }, 25_000);
    try {
      const response = await fetch(`/fundamentals?ticker=${encodeURIComponent(ticker)}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await responseError(response);
        if (isCurrentRequest()) setFundamentalsError(error.message);
      } else {
        const filedData = await response.json();
        if (isCurrentRequest()) {
          setFundamentals(filedData);
          fundamentalsLoaded = true;
        }
      }
    } catch (error) {
      if (isCurrentRequest()) {
        setFundamentalsError(
          fundamentalsTimedOut
            ? "SEC fundamentals request timed out"
            : "Unable to retrieve SEC fundamentals"
        );
      }
    } finally {
      clearTimeout(fundamentalsTimeout);
      if (isCurrentRequest()) setFundamentalsLoading(false);
    }

    if (!fundamentalsLoaded || !isCurrentRequest() || controller.signal.aborted) {
      if (isCurrentRequest()) requestControllerRef.current = null;
      return;
    }

    setAiLoading(true);
    let researchTimedOut = false;
    const researchTimeout = setTimeout(() => {
      researchTimedOut = true;
      controller.abort();
    }, 65_000);
    try {
      const response = await fetch("/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const error = await responseError(response);
        if (isCurrentRequest()) setAiError(error);
        return;
      }
      const result = await response.json();
      if (isCurrentRequest()) setResearch(result);
    } catch (error) {
      if (isCurrentRequest()) {
        setAiError({
          message: researchTimedOut
            ? "Research analysis timed out — please try again"
            : "Unable to generate the research analysis",
          detail: "",
        });
      }
    } finally {
      clearTimeout(researchTimeout);
      if (isCurrentRequest()) {
        setAiLoading(false);
        requestControllerRef.current = null;
      }
    }
  }, []);

  useEffect(() => () => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
  }, []);

  function analyzeTicker(event) {
    event.preventDefault();
    void runResearch(tickerInput);
  }

  useEffect(() => {
    const ticker = typeof initialTicker === "string" ? initialTicker.trim().toUpperCase() : "";
    if (!ticker) {
      lastAutoRunTicker.current = null;
      return;
    }
    if (lastAutoRunTicker.current === ticker) return;

    const loadedTicker = typeof (research?.ticker || fundamentals?.ticker) === "string"
      ? (research?.ticker || fundamentals?.ticker).trim().toUpperCase()
      : "";
    lastAutoRunTicker.current = ticker;
    if (ticker === loadedTicker) return;
    void runResearch(ticker);
  }, [initialTicker, fundamentals?.ticker, research?.ticker, runResearch]);

  const years = [...(fundamentals?.fiscalYears ?? [])].sort((a, b) => a - b);
  const latestYear = years.length ? years[years.length - 1] : null;
  const analysis = research?.analysis;
  const busy = fundamentalsLoading || aiLoading;
  const hasTechnical = hasLensContent(analysis?.technical)
    || Boolean(research?.history)
    || (Array.isArray(research?.technicalScore?.components) && research.technicalScore.components.length > 0);
  const hasMacro = hasLensContent(analysis?.macro);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <style>{`
        .rp-chart-grid {
          display: grid;
          grid-template-columns: minmax(0, 1fr);
          gap: 13px;
          min-width: 0;
        }

        @media (min-width: 700px) {
          .rp-chart-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
        }

        @media (min-width: 1100px) {
          .rp-chart-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
          }
        }
      `}</style>
      <section style={{ ...PANEL_STYLE, padding: 18 }}>
        <div style={EYEBROW_STYLE}>SEC-filed equity research</div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", marginTop: 8 }}>
          <div>
            <h1 style={{ margin: 0, color: "var(--ink-100)", fontSize: 22, lineHeight: 1.2 }}>Financial trajectory &amp; three-year cases</h1>
            <p style={{ margin: "7px 0 0", color: "var(--ink-400)", fontSize: 11 }}>Filed SEC figures first; model analysis follows when ready.</p>
          </div>
          <form onSubmit={analyzeTicker} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <span style={EYEBROW_STYLE}>Ticker</span>
              <input
                value={tickerInput}
                onChange={event => setTickerInput(event.target.value)}
                placeholder="MSFT"
                maxLength={15}
                autoComplete="off"
                spellCheck={false}
                style={{ width: 150, boxSizing: "border-box", color: "var(--ink-100)", background: "rgba(255,255,255,0.035)", border: "1px solid var(--border-soft)", borderRadius: 9, padding: "9px 11px", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none", textTransform: "uppercase" }}
              />
            </label>
            <button
              type="submit"
              disabled={busy || !tickerInput.trim()}
              style={{ alignSelf: "flex-end", color: busy ? "var(--ink-500)" : "var(--void-900)", background: busy ? "var(--ink-700)" : "var(--accent)", border: 0, borderRadius: 9, padding: "10px 16px", fontFamily: "var(--font-condensed)", fontSize: 10, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", cursor: busy ? "wait" : "pointer" }}
            >
              {fundamentalsLoading ? "Loading filings…" : aiLoading ? "Analyzing…" : "Analyze"}
            </button>
          </form>
        </div>
      </section>

      {!fundamentals && !fundamentalsLoading && !fundamentalsError && (
        <div style={{ ...PANEL_STYLE, padding: 18, color: "var(--ink-400)", fontSize: 12 }}>Enter a US SEC filer ticker to begin.</div>
      )}
      {fundamentalsError && <div style={{ ...PANEL_STYLE, padding: 18, color: "var(--down-400)", fontSize: 12 }}>{fundamentalsError}</div>}

      {fundamentals && (
        <>
          <section style={{ ...PANEL_STYLE, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={EYEBROW_STYLE}>{fundamentals.ticker} · latest filing year {latestYear ?? "—"}</div>
              <div style={{ marginTop: 4, color: "var(--ink-100)", fontSize: 16, fontWeight: 700 }}>{fundamentals.entityName || fundamentals.ticker}</div>
            </div>
            <div style={{ color: "var(--ink-500)", fontSize: 9.5 }}>Source: {fundamentals.source}</div>
          </section>

          <MetricsStrip data={fundamentals} latestYear={latestYear} />

          <div className="rp-chart-grid">
            {STATEMENTS.map(definition => (
              <StatementChart key={definition.key} definition={definition} statement={fundamentals.statements?.[definition.key]} years={years} />
            ))}
          </div>
        </>
      )}

      {aiLoading && <div style={{ ...PANEL_STYLE, padding: 18, color: "var(--ink-400)", fontSize: 12 }}>Analyzing the filed figures and checking scenario arithmetic…</div>}
      {aiError && (
        <div style={{ ...PANEL_STYLE, padding: 18, color: "var(--down-400)", fontSize: 12 }}>
          <div>{aiError.message}</div>
          {aiError.detail && (
            <div style={{ marginTop: 7, maxHeight: 120, overflow: "auto", color: "var(--ink-400)", fontFamily: "var(--font-mono)", fontSize: 10.5, lineHeight: 1.45, wordBreak: "break-word" }}>
              {aiError.detail}
            </div>
          )}
        </div>
      )}

      {analysis && (
        <section style={{ ...PANEL_STYLE, padding: 18 }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
            <div>
              <div style={EYEBROW_STYLE}>Model analysis · {research.model}</div>
              <h2 style={{ margin: "6px 0 0", color: "var(--ink-100)", fontSize: 18 }}>Three-year scenario analysis</h2>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={EYEBROW_STYLE}>Quality score</div>
              <div style={{ color: "var(--accent)", fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 800 }}>{Number.isFinite(analysis.quality?.score) ? `${analysis.quality.score}/100` : "—"}</div>
            </div>
          </div>

          <CompositeSummary composite={research.composite} />

          <p style={{ margin: "14px 0 0", color: "var(--ink-200)", fontSize: 12, lineHeight: 1.65 }}>{analysis.summary}</p>
          {analysis.quality?.rationale && <p style={{ margin: "7px 0 0", color: "var(--ink-400)", fontSize: 10.5 }}>{analysis.quality.rationale}</p>}
          {analysis.quality?.note && <p style={{ margin: "7px 0 0", color: "var(--ink-400)", fontSize: 10.5 }}>{analysis.quality.note}</p>}
          <ScoreBreakdown title="Score components" scoreObject={analysis.quality} />

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, marginTop: 16, marginBottom: 18 }}>
            {[
              ["Strengths", analysis.strengths, "var(--pos)"],
              ["Risks", analysis.risks, "var(--down-400)"],
            ].map(([label, items, color]) => (
              <div key={label} style={{ borderTop: `1px solid ${color}`, paddingTop: 10 }}>
                <div style={{ ...EYEBROW_STYLE, color }}>{label}</div>
                <ul style={{ margin: "8px 0 0", paddingLeft: 17, color: "var(--ink-300)", fontSize: 11, lineHeight: 1.55 }}>
                  {(Array.isArray(items) ? items : []).map((item, index) => <li key={`${label}-${index}`} style={{ marginBottom: 5 }}>{item}</li>)}
                </ul>
              </div>
            ))}
          </div>

          {(hasTechnical || hasMacro) && (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 14, marginBottom: 18 }}>
              {hasTechnical && (
                <AnalysisLens
                  eyebrow="Technical read"
                  lens={analysis.technical}
                  beforeRead={(
                    <>
                      <PriceChart history={research.history} annotations={analysis.technical?.annotations} />
                      <PriceContextStrip priceContext={research.priceContext} />
                    </>
                  )}
                >
                  <ScoreBreakdown title="Technical score components" scoreObject={research.technicalScore} />
                </AnalysisLens>
              )}
              {hasMacro && <AnalysisLens eyebrow="Macro & competitive" lens={analysis.macro} />}
            </div>
          )}

          <MarketContextStrip research={research} />
          <ResearchCases cases={analysis.cases} currentPrice={research.currentPrice} />

          {Array.isArray(analysis.dataGaps) && analysis.dataGaps.length > 0 && (
            <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border-hairline)" }}>
              <div style={EYEBROW_STYLE}>Data gaps</div>
              <div style={{ marginTop: 6, color: "var(--ink-400)", fontSize: 10.5 }}>{analysis.dataGaps.join(" · ")}</div>
            </div>
          )}

          <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--border-hairline)", color: "var(--ink-500)", fontSize: 9.5 }}>{research.disclaimer}</div>
        </section>
      )}
    </div>
  );
}
