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

async function responseError(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 403) return "Admin access required";
  if (response.status === 404) return "No SEC filer found for that ticker — US SEC filers only";
  return body?.error || `Request failed (${response.status})`;
}

function StatementTable({ definition, statement, years }) {
  return (
    <section style={{ ...PANEL_STYLE, minWidth: 0, overflow: "hidden" }}>
      <div style={{ padding: "14px 16px 10px" }}>
        <div style={EYEBROW_STYLE}>{definition.title}</div>
      </div>
      <div style={{ overflowX: "auto" }}>
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

function ResearchCases({ cases }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 12 }}>
      {Object.entries(CASE_META).map(([key, meta]) => {
        const scenario = cases?.[key];
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
  const [aiError, setAiError] = useState("");

  async function analyzeTicker(event) {
    event.preventDefault();
    const ticker = tickerInput.trim().toUpperCase();
    setTickerInput(ticker);
    setFundamentals(null);
    setResearch(null);
    setFundamentalsError("");
    setAiError("");
    if (!ticker) return;

    setFundamentalsLoading(true);
    let filedData;
    try {
      const response = await fetch(`/fundamentals?ticker=${encodeURIComponent(ticker)}`);
      if (!response.ok) {
        setFundamentalsError(await responseError(response));
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
      setAiError("Unable to generate the research analysis");
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

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 430px), 1fr))", gap: 14 }}>
            {STATEMENTS.map(definition => (
              <StatementTable key={definition.key} definition={definition} statement={fundamentals.statements?.[definition.key]} years={years} />
            ))}
          </div>
        </>
      )}

      {aiLoading && <div style={{ ...PANEL_STYLE, padding: 18, color: "var(--ink-400)", fontSize: 12 }}>Analyzing the filed figures and checking scenario arithmetic…</div>}
      {aiError && <div style={{ ...PANEL_STYLE, padding: 18, color: "var(--down-400)", fontSize: 12 }}>{aiError}</div>}

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

          <ResearchCases cases={analysis.cases} />

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
