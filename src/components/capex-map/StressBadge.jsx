import { memo } from "react";

// Transcript NLP stress visuals. Data comes from GET /stress (weekly ETL over
// earnings-call transcripts) and is aggregated per subsector in App.jsx:
//   { score, trend, count, companies: [{ ticker, score, delta, direction, summary, quotes, fy, fq }] }

export function stressColor(score) {
  if (score >= 70) return "#ef4444"; // severe — allocation / sold-out language
  if (score >= 40) return "#f59e0b"; // clear constraint language
  if (score >= 15) return "#60a5fa"; // mild tightness
  return "#34d399";                  // routine
}

const DIRECTION_LABELS = {
  constrained_supplier: { text: "BOTTLENECK OWNER", color: "#ef4444", hint: "Cannot make enough of what it sells — pricing power" },
  constrained_buyer:    { text: "INPUT-CONSTRAINED", color: "#f59e0b", hint: "Cannot get enough inputs — downstream of a bottleneck" },
  both:                 { text: "OWNER + CONSTRAINED", color: "#f472b6", hint: "Supply-limited on both sides" },
};

function TrendArrow({ trend }) {
  if (trend == null) return null;
  if (trend > 5)  return <span style={{ color: "#ef4444" }} title={`+${trend.toFixed(0)} QoQ`}>↑</span>;
  if (trend < -5) return <span style={{ color: "#34d399" }} title={`${trend.toFixed(0)} QoQ`}>↓</span>;
  return <span style={{ color: "#64748b" }} title="flat QoQ">→</span>;
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

// Drilldown: per-company scores, direction, and the verbatim transcript
// quotes the score is based on. Rendered inside SubsectorCard when the
// badge is toggled open.
export function StressDetail({ stress, onTickerClick }) {
  if (!stress?.companies?.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
      {stress.companies.map(c => {
        const color = stressColor(c.score);
        const dir = DIRECTION_LABELS[c.direction];
        return (
          <div key={c.ticker} style={{ borderRadius: 8, border: `1px solid ${color}33`, background: "rgba(0,0,0,0.25)", padding: "8px 10px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span
                onClick={e => onTickerClick?.(c.ticker, e.currentTarget.getBoundingClientRect())}
                style={{ fontSize: 12, fontWeight: 700, color: "#e2e8f0", cursor: "pointer" }}
              >
                {c.ticker}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color }}>{c.score.toFixed(0)}</span>
              {c.delta != null && (
                <span style={{ fontSize: 10, color: c.delta > 0 ? "#ef4444" : c.delta < 0 ? "#34d399" : "#64748b" }}>
                  {c.delta > 0 ? "+" : ""}{c.delta.toFixed(0)} QoQ
                </span>
              )}
              {dir && (
                <span title={dir.hint} style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color: dir.color, border: `1px solid ${dir.color}55`, background: dir.color + "15", padding: "1px 5px", borderRadius: 3 }}>
                  {dir.text}
                </span>
              )}
              <span style={{ fontSize: 10, color: "#475569", marginLeft: "auto" }}>
                {c.fy}Q{c.fq}
              </span>
            </div>
            {c.summary && (
              <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 5, lineHeight: 1.5 }}>{c.summary}</div>
            )}
            {c.quotes?.length > 0 && (
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
                {c.quotes.map((q, i) => (
                  <div key={i} style={{ fontSize: 10.5, color: "#cbd5e1", borderLeft: `2px solid ${color}66`, paddingLeft: 8, lineHeight: 1.5, fontStyle: "italic" }}>
                    “{q.quote}”
                    {q.signal && <span style={{ color: "#64748b", fontStyle: "normal" }}> — {q.signal}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
      <div style={{ fontSize: 9.5, color: "#475569", lineHeight: 1.4 }}>
        Scores derived from supply-stress language in the latest earnings-call transcripts
        (lexicon scan + AI classification). Quotes are verbatim from the calls.
      </div>
    </div>
  );
}
