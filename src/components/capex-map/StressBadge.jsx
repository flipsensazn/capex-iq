import { memo } from "react";

// Transcript NLP stress visuals. Data comes from GET /stress (weekly ETL over
// earnings-call transcripts) and is aggregated per subsector in App.jsx:
//   { score, trend, count, companies: [{ ticker, score, delta, direction, summary, quotes, fy, fq }] }

export function stressColor(score) {
  if (score >= 70) return "var(--neg)"; // severe — allocation / sold-out language
  if (score >= 40) return "#f59e0b"; // clear constraint language
  if (score >= 15) return "var(--info)"; // mild tightness
  return "var(--pos)";                  // routine
}

const DIRECTION_LABELS = {
  constrained_supplier: { text: "BOTTLENECK OWNER", color: "var(--neg)", hint: "Cannot make enough of what it sells — pricing power" },
  constrained_buyer:    { text: "INPUT-CONSTRAINED", color: "#f59e0b", hint: "Cannot get enough inputs — downstream of a bottleneck" },
  both:                 { text: "OWNER + CONSTRAINED", color: "var(--frontier-400)", hint: "Supply-limited on both sides" },
};

function TrendArrow({ trend }) {
  if (trend == null) return null;
  if (trend > 5)  return <span style={{ color: "var(--neg)" }} title={`+${trend.toFixed(0)} QoQ`}>↑</span>;
  if (trend < -5) return <span style={{ color: "var(--pos)" }} title={`${trend.toFixed(0)} QoQ`}>↓</span>;
  return <span style={{ color: "var(--ink-400)" }} title="flat QoQ">→</span>;
}

// Compact chip shown in the SubsectorCard header. Live counterpart to the
// hand-curated badge — derived from earnings-call language, not opinion.
const StressBadge = memo(function StressBadge({ stress, onClick, open }) {
  if (!stress || stress.count === 0) return null;
  const color = stressColor(stress.score);
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick?.(); }}
      title={`Transcript stress ${stress.score.toFixed(0)}/100 across ${stress.count} compan${stress.count === 1 ? "y" : "ies"} — click for quotes`}
      style={{
        background: color + "22", border: `1px solid ${color}`, color,
        fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
        padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap",
        cursor: "pointer", fontFamily: "inherit",
        display: "inline-flex", alignItems: "center", gap: 4,
        boxShadow: open ? `0 0 6px ${color}66` : "none",
      }}
    >
      STRESS {stress.score.toFixed(0)} <TrendArrow trend={stress.trend} />
    </button>
  );
});

export default StressBadge;

// ── XBRL GAUGES (GET /gauges — SEC companyfacts ETL) ─────
// Order gap = RPO/backlog YoY growth minus revenue YoY growth, in percentage
// points. Positive and large = orders outrunning shipping capacity.

export function hasGaugeData(tickers = [], gauges = {}) {
  return tickers.some(t => gauges[t] && (gauges[t].orderGap != null || gauges[t].inventoryDays != null));
}

export function gaugeSummary(tickers = [], gauges = {}) {
  const withGap = tickers.map(t => gauges[t]).filter(g => g && g.orderGap != null);
  if (!withGap.length) return null;
  return {
    avgGap: withGap.reduce((s, g) => s + g.orderGap, 0) / withGap.length,
    count: withGap.length,
  };
}

// "BKLG +154pp" chip — shown when the subsector's average order gap is
// meaningfully positive (orders outrunning revenue by >10pp).
export const GaugeChip = memo(function GaugeChip({ tickers, gauges, onClick, open }) {
  const sum = gaugeSummary(tickers, gauges);
  if (!sum || sum.avgGap < 10) return null;
  const color = sum.avgGap >= 50 ? "var(--neg)" : "#f59e0b";
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick?.(); }}
      title={`Backlog growing ${sum.avgGap.toFixed(0)}pp faster than revenue (avg of ${sum.count} compan${sum.count === 1 ? "y" : "ies"}, SEC XBRL) — click for details`}
      style={{
        background: color + "22", border: `1px solid ${color}`, color,
        fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
        padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap",
        cursor: "pointer", fontFamily: "inherit",
        boxShadow: open ? `0 0 6px ${color}66` : "none",
      }}
    >
      BKLG +{sum.avgGap.toFixed(0)}pp
    </button>
  );
});

const fmtPct = v => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`;
const fmtB = v => v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`;

// ── COMPOSITE BOTTLENECK SCORE (GET /composite — weekly blend of transcript
// stress, XBRL gauges and filed customer concentration) ──

export function compositeSummary(tickers = [], composite = {}) {
  const scored = tickers.map(t => composite[t]).filter(c => c && c.score != null);
  if (!scored.length) return null;
  const deltas = scored.filter(c => c.delta != null);
  return {
    avg: scored.reduce((s, c) => s + c.score, 0) / scored.length,
    trend: deltas.length ? deltas.reduce((s, c) => s + c.delta, 0) / deltas.length : null,
    count: scored.length,
  };
}

// "⬢ 74 ↑" chip — the subsector's average Composite Bottleneck Score.
export const CompositeChip = memo(function CompositeChip({ tickers, composite, onClick, open }) {
  const sum = compositeSummary(tickers, composite);
  if (!sum) return null;
  const color = stressColor(sum.avg);
  const arrow = sum.trend == null ? "" : sum.trend > 3 ? " ↑" : sum.trend < -3 ? " ↓" : "";
  return (
    <button
      onClick={e => { e.stopPropagation(); onClick?.(); }}
      title={`Composite Bottleneck Score ${sum.avg.toFixed(0)}/100 (avg of ${sum.count} — transcript + XBRL + concentration, weekly) — click for breakdown`}
      style={{
        background: color + "22", border: `1px solid ${color}`, color,
        fontSize: 10, fontWeight: 700, letterSpacing: "0.1em",
        padding: "2px 7px", borderRadius: 3, whiteSpace: "nowrap",
        cursor: "pointer", fontFamily: "inherit",
        boxShadow: open ? `0 0 6px ${color}66` : "none",
      }}
    >
      ⬢ {sum.avg.toFixed(0)}{arrow}
    </button>
  );
});

// Tiny inline history sparkline for the drilldown rows.
export function CbsSparkline({ history, color = "var(--ink-300)" }) {
  if (!history || history.length < 2) return null;
  const scores = history.map(h => h.score).filter(s => s != null);
  if (scores.length < 2) return null;
  const w = 64, h = 16;
  const min = Math.min(...scores), max = Math.max(...scores);
  const range = max - min || 1;
  const pts = scores.map((s, i) =>
    `${(i / (scores.length - 1)) * w},${h - 2 - ((s - min) / range) * (h - 4)}`).join(" ");
  return (
    <svg width={w} height={h} style={{ display: "inline-block", verticalAlign: "middle" }}
      title={`${scores.length} weekly snapshots`}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}

// Per-company CBS line for the drilldown: score, weekly delta, sparkline,
// and the component breakdown so the number stays auditable.
export function CompositeLine({ c }) {
  if (!c || c.score == null) return null;
  const color = stressColor(c.score);
  const parts = [];
  if (c.parts?.transcript != null) parts.push(`call ${c.parts.transcript.toFixed(0)}`);
  if (c.parts?.gauge != null) parts.push(`xbrl ${c.parts.gauge.toFixed(0)}`);
  if (c.parts?.concentration != null) parts.push(`conc ${c.parts.concentration.toFixed(0)}`);
  return (
    <div style={{ fontSize: 10.5, marginTop: 5, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      <span style={{ color, fontWeight: 700 }}>⬢ CBS {c.score.toFixed(0)}</span>
      {c.delta != null && (
        <span style={{ color: c.delta > 0 ? "var(--neg)" : c.delta < 0 ? "var(--pos)" : "var(--ink-400)" }}>
          {c.delta > 0 ? "+" : ""}{c.delta.toFixed(0)} wk
        </span>
      )}
      <CbsSparkline history={c.history} color={color} />
      {parts.length > 0 && <span style={{ color: "var(--ink-500)" }}>({parts.join(" · ")})</span>}
    </div>
  );
}

function GaugeLine({ g }) {
  if (!g) return null;
  const hasBacklog = g.rpoYoy != null;
  const hasInv = g.inventoryDays != null;
  if (!hasBacklog && !hasInv) return null;
  const gapColor = g.orderGap > 50 ? "var(--neg)" : g.orderGap > 10 ? "#f59e0b" : "var(--ink-400)";
  return (
    <div style={{ fontSize: 10.5, color: "#7dd3fc", marginTop: 5, display: "flex", gap: 12, flexWrap: "wrap" }}>
      {hasBacklog && (
        <span>
          Backlog {g.rpo != null ? fmtB(g.rpo) + " " : ""}{fmtPct(g.rpoYoy)} YoY
          {g.revenueYoy != null && <> vs rev {fmtPct(g.revenueYoy)}</>}
          {g.orderGap != null && <span style={{ color: gapColor, fontWeight: 700 }}> → gap {g.orderGap >= 0 ? "+" : ""}{g.orderGap.toFixed(0)}pp</span>}
        </span>
      )}
      {hasInv && (
        <span>
          Inv days {g.inventoryDays.toFixed(0)}
          {g.inventoryDaysYoy != null && <span style={{ color: g.inventoryDaysYoy > 15 ? "#f59e0b" : "var(--ink-400)" }}> ({g.inventoryDaysYoy >= 0 ? "+" : ""}{g.inventoryDaysYoy.toFixed(0)} YoY)</span>}
        </span>
      )}
    </div>
  );
}

// Drilldown: one row per company, merging the transcript signal (score,
// direction, verbatim quotes) with the SEC XBRL gauges. Companies with only
// one of the two signals still get a row.
export function StressDetail({ stress, tickers = [], gauges = {}, composite = {}, onTickerClick }) {
  const byTicker = {};
  for (const c of stress?.companies ?? []) byTicker[c.ticker] = c;
  const order = (stress?.companies ?? []).map(c => c.ticker);
  for (const t of tickers) {
    if (!byTicker[t] && !order.includes(t) &&
        ((gauges[t] && (gauges[t].orderGap != null || gauges[t].inventoryDays != null)) ||
         composite[t]?.score != null)) {
      order.push(t);
    }
  }
  if (!order.length) return null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      {order.map(ticker => {
        const c = byTicker[ticker];
        const g = gauges[ticker];
        const color = c ? stressColor(c.score) : "var(--ink-500)";
        const dir = c ? DIRECTION_LABELS[c.direction] : null;
        return (
          <div key={ticker} style={{ borderRadius: 8, border: `1px solid ${color}33`, background: "rgba(0,0,0,0.25)", padding: "8px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span
                onClick={e => onTickerClick?.(ticker, e.currentTarget.getBoundingClientRect())}
                style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-100)", cursor: "pointer" }}
              >
                {ticker}
              </span>
              {c && <span style={{ fontSize: 11, fontWeight: 700, color }}>{c.score.toFixed(0)}</span>}
              {c?.delta != null && (
                <span style={{ fontSize: 10, color: c.delta > 0 ? "var(--neg)" : c.delta < 0 ? "var(--pos)" : "var(--ink-400)" }}>
                  {c.delta > 0 ? "+" : ""}{c.delta.toFixed(0)} QoQ
                </span>
              )}
              {dir && (
                <span title={dir.hint} style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: dir.color, border: `1px solid ${dir.color}55`, background: dir.color + "15", padding: "1px 5px", borderRadius: 3 }}>
                  {dir.text}
                </span>
              )}
              <span style={{ fontSize: 10, color: "var(--ink-500)", marginLeft: "auto" }}>
                {c ? `${c.fy}Q${c.fq}` : g?.latestQuarterEnd ? `Q end ${g.latestQuarterEnd}` : ""}
              </span>
            </div>
            {c?.summary && (
              <div style={{ fontSize: 11, color: "var(--ink-300)", marginTop: 5, lineHeight: 1.5 }}>{c.summary}</div>
            )}
            <CompositeLine c={composite[ticker]} />
            <GaugeLine g={g} />
            {c?.quotes?.length > 0 && (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {c.quotes.map((q, i) => (
                  <div key={i} style={{ fontSize: 10.5, color: "var(--ink-200)", borderLeft: `2px solid ${color}66`, paddingLeft: 8, lineHeight: 1.5, fontStyle: "italic" }}>
                    “{q.quote}”
                    {q.signal && <span style={{ color: "var(--ink-400)", fontStyle: "normal" }}> — {q.signal}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ fontSize: 9.5, color: "var(--ink-500)", lineHeight: 1.4 }}>
        Transcript scores from supply-stress language in the latest earnings calls
        (lexicon scan + AI classification; quotes verbatim). Backlog/inventory gauges
        from SEC XBRL filings — order gap is backlog growth minus revenue growth, YoY.
      </div>
    </div>
  );
}
