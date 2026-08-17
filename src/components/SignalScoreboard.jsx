// Signal Performance Scoreboard — prospective evidence is kept separate from
// historical reconstructions. Fed weekly by src/signal_scoreboard.py.

const TYPE_LABELS = {
  cbs_cross_70:    "⬢ CBS crossed 70",
  cbs_jump_15:     "⬢ CBS +15 jump",
  stress_cross_70: "🎙 Stress crossed 70",
  order_gap_50:    "📦 Order gap ≥50pp",
  scout_approved:  "🔭 Scout approval",
};

const HORIZONS = ["1w", "1m", "3m"];

const excessColor = v => (v == null ? "var(--ink-500)" : v > 0 ? "var(--pos)" : v < 0 ? "var(--neg)" : "var(--ink-300)");
const fmtExcess = v => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}pp`);

function HorizonCell({ h }) {
  if (!h || !h.n) {
    return <div style={{ textAlign: "center", color: "var(--ink-600)", fontSize: 12 }}>—</div>;
  }
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: excessColor(h.medianExcess) }}>
        {fmtExcess(h.medianExcess)}
      </div>
      <div style={{ fontSize: 9.5, color: "var(--ink-400)", marginTop: 1 }}>
        {h.hitRate != null ? `${h.hitRate}% hit` : ""} · n={h.n}
      </div>
    </div>
  );
}

function ScoreTable({ stats, emptyMessage }) {
  const typed = stats.filter(s => s.type !== "all").sort((a, b) => b.n - a.n);
  const all = stats.find(s => s.type === "all");
  const gridCols = "minmax(150px, 1.6fr) 0.5fr 1fr 1fr 1fr";
  const headStyle = { fontSize: 9.5, letterSpacing: "0.12em", color: "var(--ink-400)", fontWeight: 700, textTransform: "uppercase", textAlign: "center" };

  if (!typed.length) {
    return <div style={{ fontSize: 12, color: "var(--ink-400)", padding: "6px 0" }}>{emptyMessage}</div>;
  }

  return (
    <div style={{ overflowX: "auto" }}>
      <div style={{ minWidth: 480 }}>
        <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 6, padding: "2px 0 8px" }}>
          <div style={{ ...headStyle, textAlign: "left" }}>Signal</div>
          <div style={headStyle}>Events</div>
          {HORIZONS.map(h => <div key={h} style={headStyle}>{h}</div>)}
        </div>
        {typed.map(s => (
          <div key={s.type} style={{ display: "grid", gridTemplateColumns: gridCols, gap: 6, alignItems: "center", padding: "7px 0", borderTop: "1px solid rgba(255,255,255,0.05)" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--ink-200)" }}>
              {TYPE_LABELS[s.type] ?? s.type}
            </div>
            <div style={{ textAlign: "center", fontSize: 12, fontWeight: 700, color: "var(--ink-300)" }}>{s.n}</div>
            {HORIZONS.map(h => <HorizonCell key={h} h={s.horizons?.[h]} />)}
          </div>
        ))}
        {all && (
          <div style={{ display: "grid", gridTemplateColumns: gridCols, gap: 6, alignItems: "center", padding: "8px 0 2px", borderTop: "1px solid rgba(255,255,255,0.12)" }}>
            <div style={{ fontSize: 11.5, fontWeight: 800, color: "var(--ink-100)", letterSpacing: "0.08em" }}>ALL SIGNALS</div>
            <div style={{ textAlign: "center", fontSize: 12, fontWeight: 800, color: "var(--ink-100)" }}>{all.n}</div>
            {HORIZONS.map(h => <HorizonCell key={h} h={all.horizons?.[h]} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function EventChips({ events, onTickerClick, label }) {
  if (!events.length) return null;
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.05)" }}>
      <div style={{ fontSize: 9.5, letterSpacing: "0.12em", color: "var(--ink-400)", fontWeight: 700, textTransform: "uppercase", marginBottom: 7 }}>
        {label}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {events.slice(0, 8).map(ev => {
          const matured = [...HORIZONS].reverse().map(h => [h, ev.excess?.[h]]).find(([, v]) => v != null);
          const eventDate = ev.eventDate ?? ev.date;
          const observedDate = ev.observedAt ? String(ev.observedAt).slice(0, 10) : null;
          return (
            <button
              key={`${ev.cohort ?? "legacy"}-${ev.ticker}-${ev.type}-${ev.date}`}
              onClick={e => onTickerClick?.(ev.ticker, e.currentTarget.getBoundingClientRect())}
              title={`${TYPE_LABELS[ev.type] ?? ev.type} · event ${eventDate}${observedDate ? ` · observed ${observedDate}` : ""}${ev.entryDate ? ` · entry ${ev.entryDate}` : ""}${ev.score != null ? ` · score ${ev.score.toFixed(0)}` : ""} — click for company details`}
              style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "rgba(255,255,255,0.03)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: "5px 10px", cursor: "pointer", fontFamily: "inherit" }}>
              <span style={{ fontSize: 11.5, fontWeight: 800, color: "var(--ink-100)" }}>{ev.ticker}</span>
              <span style={{ fontSize: 10, color: "var(--ink-400)" }}>{(TYPE_LABELS[ev.type] ?? ev.type).replace(/^\S+\s/, "")}</span>
              <span style={{ fontSize: 9.5, color: "var(--ink-500)" }}>event {eventDate}</span>
              {observedDate && observedDate !== eventDate && (
                <span style={{ fontSize: 9.5, color: "var(--ink-500)" }}>seen {observedDate}</span>
              )}
              {matured ? (
                <span style={{ fontSize: 10.5, fontWeight: 700, color: excessColor(matured[1]) }}>
                  {fmtExcess(matured[1])} {matured[0]}
                </span>
              ) : (
                <span style={{ fontSize: 9.5, color: "var(--ink-500)" }}>maturing…</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function SignalScoreboard({ data, onTickerClick }) {
  const isVersioned = Number(data?.methodology?.version) >= 2;
  const prospectiveStats = isVersioned ? data?.statsByCohort?.prospective ?? [] : [];
  const retrospectiveStats = isVersioned ? data?.statsByCohort?.retrospective ?? [] : [];
  const prospectiveEvents = isVersioned ? data?.eventsByCohort?.prospective ?? [] : [];
  const retrospectiveEvents = isVersioned ? data?.eventsByCohort?.retrospective ?? [] : [];
  const prospectiveStart = data?.methodology?.prospectiveStart;
  const emptyMessage = data?.error
    ? "Scoreboard data is temporarily unavailable."
    : data == null
      ? "Loading the versioned scoreboard…"
      : isVersioned
        ? `Forward-observed tracking began ${prospectiveStart || "at the methodology-v2 launch"}; results appear as its 1w / 1m / 3m windows mature.`
        : "Awaiting versioned cohort data; legacy blended results are intentionally hidden.";

  return (
    <div style={{ borderRadius: "var(--radius-2xl)", border: "1px solid var(--border-hairline)", background: "var(--surface-card)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", boxShadow: "var(--shadow-panel)", padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 10 }}>
        <div style={{ fontSize: 11, color: "var(--ink-300)", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>⚖</span> Signal Scoreboard
        </div>
        <div style={{ fontSize: 10, color: "var(--ink-500)" }}>
          median excess return vs QQQ · pp = percentage points
        </div>
      </div>

      <div style={{ fontSize: 10, color: "var(--pos)", fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 7 }}>
        Prospective · forward observed
      </div>
      <ScoreTable
        stats={prospectiveStats}
        emptyMessage={emptyMessage}
      />
      <EventChips events={prospectiveEvents} onTickerClick={onTickerClick} label="Recent forward-observed signals" />

      {(retrospectiveStats.length > 0 || retrospectiveEvents.length > 0) && (
        <details style={{ marginTop: 14, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
          <summary style={{ cursor: "pointer", fontSize: 10.5, fontWeight: 800, color: "var(--ink-300)", letterSpacing: "0.08em", textTransform: "uppercase" }}>
            Historical reconstruction · backfilled, exploratory
          </summary>
          <div style={{ fontSize: 10.5, color: "var(--ink-500)", margin: "8px 0" }}>
            Reconstructed after the scoring rubric was designed; shown for research, not as an out-of-sample track record.
          </div>
          <ScoreTable stats={retrospectiveStats} emptyMessage="No reconstructed events." />
          <EventChips events={retrospectiveEvents} onTickerClick={onTickerClick} label="Recent reconstructed signals" />
        </details>
      )}

      <div style={{ marginTop: 10, fontSize: 9.5, color: "var(--ink-500)" }}>
        entry = first NYSE close after signal availability · stock and QQQ use identical dates · horizons = 7 / 30 / 91 calendar days from actual entry
      </div>
    </div>
  );
}
