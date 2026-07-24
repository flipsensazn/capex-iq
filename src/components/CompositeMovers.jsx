import { useMemo } from "react";
import { stressColor, CbsSparkline } from "./capex-map/StressBadge";

// Top Composite Bottleneck Score movers this week for the active view's
// tickers — the "what changed" strip. Heating names (score rising = supply
// tightening) lead; cooling names follow. Hidden until two weekly snapshots
// exist (deltas need history).

const MAX_EACH = 5;

export default function CompositeMovers({ tickers = [], composite = {}, onTickerClick }) {
  const { heating, cooling } = useMemo(() => {
    const scored = [...new Set(tickers)]
      .map(t => ({ ticker: t, ...composite[t] }))
      .filter(c => c.score != null && c.delta != null && Math.abs(c.delta) >= 3);
    return {
      heating: scored.filter(c => c.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, MAX_EACH),
      cooling: scored.filter(c => c.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, MAX_EACH),
    };
  }, [tickers, composite]);

  if (!heating.length && !cooling.length) return null;

  const Chip = ({ c, heat }) => {
    const color = stressColor(c.score);
    return (
      <button
        onClick={e => onTickerClick?.(c.ticker, e.currentTarget.getBoundingClientRect())}
        title={`CBS ${c.score.toFixed(0)} (${c.delta > 0 ? "+" : ""}${c.delta.toFixed(0)} this week) — click for company details`}
        style={{
          display: "inline-flex", alignItems: "center", gap: 7,
          background: "rgba(255,255,255,0.03)", border: `1px solid ${color}55`,
          borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit",
        }}>
        <span style={{ fontSize: 11.5, fontWeight: 800, color: "var(--ink-100)" }}>{c.ticker}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color }}>⬢ {c.score.toFixed(0)}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: heat ? "var(--neg)" : "var(--pos)" }}>
          {c.delta > 0 ? "+" : ""}{c.delta.toFixed(0)}
        </span>
        <CbsSparkline history={c.history} color={color} />
      </button>
    );
  };

  return (
    <div style={{ borderRadius: "var(--radius-2xl)", border: "1px solid var(--border-hairline)", background: "var(--surface-card)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", boxShadow: "var(--shadow-panel)", padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: "var(--ink-300)", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>⬢</span> Bottleneck Score Movers
        </div>
        <div style={{ fontSize: 10, color: "var(--ink-500)" }}>
          composite of transcript + XBRL + concentration · weekly change
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {heating.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--neg)", minWidth: 62 }}>HEATING</span>
            {heating.map(c => <Chip key={c.ticker} c={c} heat />)}
          </div>
        )}
        {cooling.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: "var(--pos)", minWidth: 62 }}>COOLING</span>
            {cooling.map(c => <Chip key={c.ticker} c={c} heat={false} />)}
          </div>
        )}
      </div>
    </div>
  );
}
