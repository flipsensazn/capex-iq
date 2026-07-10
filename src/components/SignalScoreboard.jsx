// Signal Performance Scoreboard — the feedback loop. Every signal the system
// fires (CBS crossings/jumps, transcript-stress crossings, order-gap breaches,
// scout approvals) is logged with its price, and this panel shows the median
// excess return vs QQQ and hit rate per signal type as the 1w/1m/3m windows
// mature. Fed weekly by src/signal_scoreboard.py via GET /scoreboard.

const TYPE_LABELS = {
  cbs_cross_70:    "⬢ CBS crossed 70",
  cbs_jump_15:     "⬢ CBS +15 jump",
  stress_cross_70: "🎙 Stress crossed 70",
  order_gap_50:    "📦 Order gap ≥50pp",
  scout_approved:  "🔭 Scout approval",
};

const HORIZONS = ["1w", "1m", "3m"];

const excessColor = v => (v == null ? "#475569" : v > 0 ? "#34d399" : v < 0 ? "#ef4444" : "#94a3b8");
const fmtExcess = v => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);

function HorizonCell({ h }) {
  if (!h || !h.n) {
    return <div style={{ textAlign: "center", color: "#334155", fontSize: 12 }}>—</div>;
  }
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: excessColor(h.medianExcess) }}>
        {fmtExcess(h.medianExcess)}
      </div>
      <div style={{ fontSize: 9.5, color: "#64748b", marginTop: 1 }}>
        {h.hitRate != null ? `${h.hitRate}% hit` : ""} · n={h.n}
      </div>
    </div>
  );
}

export default function SignalScoreboard({ data, onTickerClick }) {
  const stats = data?.stats ?? [];
  const events = data?.events ?? [];
  const typed = stats.filter(s => s.type !== "all").sort((a, b) => b.n - a.n);
  const all = stats.find(s => s.type === "all");

  const gridCols = "minmax(150px, 1.6fr) 0.5fr 1fr 1fr 1fr";
  const headStyle = { fontSize: 9.5, letterSpacing: "0.12em", color: "#64748b", fontWeight: 700, textTransform: "uppercase", textAlign: "center" };

  return (
    <div style={{ borderRadius: 18, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(24,24,24,0.92)", padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>⚖</span> Signal Scoreboard
        </div>
        <div style={{ fontSize: 10, color: "#475569" }}>
          median excess return vs QQQ after each signal · hit = % beating QQQ
        </div>
      </div>

      {!typed.length ? (
        <div style={{ fontSize: 12, color: "#64748b", padding: "6px 0" }}>
          Logging signal events — returns appear as 1w / 1m / 3m windows mature
          after each weekly run.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <div style={{ minWidth: 480 }}>
            <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 6, padding: "2px 0 8px" }}>
              <div style={{ ...headStyle, textAlign: "left" }}>Signal</div>
              <div style={headStyle}>Events</div>
              {HORIZONS.map(h => <div key={h} style={headStyle}>{h}</div>)}
            </div>
            {typed.map(s => (
              <div key={s.type} style={{ display: "grid", gridTemplateColumns: gridCols, gap: 6, alignItems: "center", padding: "7px 0", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#cbd5e1" }}>
                  {TYPE_LABELS[s.type] ?? s.type}
                </div>
                <div style={{ textAlign: "center", fontSize: 12, fontWeight: 700, color: "#94a3b8" }}>{s.n}</div>
                {HORIZONS.map(h => <HorizonCell key={h} h={s.horizons?.[h]} />)}
              </div>
            ))}
            {all && (
              <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 6, alignItems: "center", padding: "8px 0 2px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
                <div style={{ fontSize: 11.5, fontWeight: 800, color: "#e2e8f0", letterSpacing: "0.08em" }}>ALL SIGNALS</div>
                <div style={{ textAlign: "center", fontSize: 12, fontWeight: 800, color: "#e2e8f0" }}>{all.n}</div>
                {HORIZONS.map(h => <HorizonCell key={h} h={all.horizons?.[h]} />)}
              </div>
            )}
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
          <div style={{ fontSize: 9.5, letterSpacing: "0.12em", color: "#64748b", fontWeight: 700, textTransform: "uppercase", marginBottom: 7 }}>
            Recent signals
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {events.slice(0, 8).map(ev => {
              // Show the longest matured excess for this event
              const matured = [...HORIZONS].reverse().map(h => [h, ev.excess?.[h]]).find(([, v]) => v != null);
              return (
                <button
                  key={`${ev.ticker}-${ev.type}-${ev.date}`}
                  onClick={e => onTickerClick?.(ev.ticker, e.currentTarget.getBoundingClientRect())}
                  title={`${TYPE_LABELS[ev.type] ?? ev.type} on ${ev.date}${ev.score != null ? ` (score ${ev.score.toFixed(0)})` : ""} — click for company details`}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 7,
                    background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit",
                  }}>
                  <span style={{ fontSize: 11.5, fontWeight: 800, color: "#e2e8f0" }}>{ev.ticker}</span>
                  <span style={{ fontSize: 10, color: "#64748b" }}>
                    {(TYPE_LABELS[ev.type] ?? ev.type).replace(/^\S+\s/, "")}
                  </span>
                  <span style={{ fontSize: 9.5, color: "#475569" }}>{ev.date}</span>
                  {matured ? (
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: excessColor(matured[1]) }}>
                      {fmtExcess(matured[1])} {matured[0]}
                    </span>
                  ) : (
                    <span style={{ fontSize: 9.5, color: "#475569" }}>maturing…</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div style={{ marginTop: 10, fontSize: 9.5, color: "#475569" }}>
        entry = first close after the signal · transcript events backfilled to call
        dates · scoreboard spans all three views
      </div>
    </div>
  );
}
