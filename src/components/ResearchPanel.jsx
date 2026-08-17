import { useState } from "react";

const PANEL_STYLE = {
  background: "var(--surface-card)",
  border: "1px solid var(--border-hairline)",
  borderRadius: "var(--radius-2xl)",
  boxShadow: "var(--shadow-panel)",
};

const EYEBROW_STYLE = {
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
    ? "Admin access required"
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

function ResearchCases({ cases, currentPrice }) {
  return (
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
              <span style={{ color: "var(--ink-400)", fontSize: 10 }}>
                {scenario?.multipleType === "pe" ? "Exit P/E" : scenario?.multipleType === "ps" ? "Exit P/S" : "Exit multiple"}
              </span>
              <span style={{ color: "var(--ink-100)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{formatRatio(scenario?.multipleValue)}</span>
              <span style={{ color: "var(--ink-400)", fontSize: 10 }}>Projected FY revenue</span>
              <span style={{ color: "var(--ink-200)", fontFamily: "var(--font-mono)", fontSize: 11 }}>{formatMagnitude(scenario?.projectedRevenue, "currency")}</span>
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
  );
}

export default function ResearchPanel() {
  const [tickerInput, setTickerInput] = useState("");
  const [fundamentals, setFundamentals] = useState(null);
  const [research, setResearch] = useState(null);
  const [fundamentalsLoading, setFundamentalsLoading] = useState(false);
  const [aiLoading, setAiLoading] = useState(false);
  const [fundamentalsError, setFundamentalsError] = useState("");
  const [aiError, setAiError] = useState(null);

  async function analyzeTicker(event) {
    event.preventDefault();
    const ticker = tickerInput.trim().toUpperCase();
    setTickerInput(ticker);
    setFundamentals(null);
    setResearch(null);
    setFundamentalsError("");
    setAiError(null);
    if (!ticker) return;

    setFundamentalsLoading(true);
    let filedData;
    try {
      const response = await fetch(`/fundamentals?ticker=${encodeURIComponent(ticker)}`);
      if (!response.ok) {
        const error = await responseError(response);
        setFundamentalsError(error.message);
        return;
      }
      filedData = await response.json();
      setFundamentals(filedData);
    } catch {
      setFundamentalsError("Unable to retrieve SEC fundamentals");
      return;
    } finally {
      setFundamentalsLoading(false);
    }

    setAiLoading(true);
    try {
      const response = await fetch("/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });
      if (!response.ok) {
        setAiError(await responseError(response));
        return;
      }
      setResearch(await response.json());
    } catch {
      setAiError({ message: "Unable to generate the research analysis", detail: "" });
    } finally {
      setAiLoading(false);
    }
  }

  const years = [...(fundamentals?.fiscalYears ?? [])].sort((a, b) => a - b);
  const latestYear = years.length ? years[years.length - 1] : null;
  const analysis = research?.analysis;
  const busy = fundamentalsLoading || aiLoading;

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

          <p style={{ margin: "14px 0 0", color: "var(--ink-200)", fontSize: 12, lineHeight: 1.65 }}>{analysis.summary}</p>
          {analysis.quality?.rationale && <p style={{ margin: "7px 0 0", color: "var(--ink-400)", fontSize: 10.5 }}>{analysis.quality.rationale}</p>}

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
