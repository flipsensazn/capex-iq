// Signal Performance Scoreboard — prospective evidence is kept separate from
// historical reconstructions. Fed weekly by src/signal_scoreboard.py.

import { useEffect, useState } from "react";

const TYPE_LABELS = {
  cbs_cross_70:    "⬢ CBS crossed 70",
  cbs_jump_15:     "⬢ CBS +15 jump",
  stress_cross_70: "🎙 Stress crossed 70",
  order_gap_50:    "📦 Order gap ≥50pp",
  scout_approved:  "🔭 Scout approval",
};

const HORIZONS = ["1w", "1m", "3m"];
// Decorative only: these fixed rank-derived widths never use API score data.
const TEASER_BAR_WIDTHS = { 1: "88%", 2: "72%", 3: "58%" };

const teaserBarWidth = rank => TEASER_BAR_WIDTHS[Number(rank)] ?? "64%";

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

export default function SignalScoreboard({ data, locked = false, onTickerClick }) {
  const effectiveLocked = locked || Boolean(data?.locked);
  const [teaser, setTeaser] = useState(null);

  useEffect(() => {
    if (!effectiveLocked) {
      setTeaser(null);
      return undefined;
    }

    const controller = new AbortController();
    setTeaser(null);
    fetch("/scoreboard-teaser", { signal: controller.signal })
      .then(response => {
        if (!response.ok) throw new Error("Scoreboard teaser unavailable");
        return response.json();
      })
      .then(payload => {
        if (!payload?.success || !Array.isArray(payload.top)) {
          throw new Error("Invalid scoreboard teaser payload");
        }
        if (!controller.signal.aborted) setTeaser(payload);
      })
      .catch(error => {
        if (error.name !== "AbortError") setTeaser(null);
      });

    return () => controller.abort();
  }, [effectiveLocked]);

  const isVersioned = Number(data?.methodology?.version) >= 2;
  const prospectiveStats = isVersioned ? data?.statsByCohort?.prospective ?? [] : [];
  const retrospectiveStats = isVersioned ? data?.statsByCohort?.retrospective ?? [] : [];
  const prospectiveEvents = isVersioned ? data?.eventsByCohort?.prospective ?? [] : [];
  const retrospectiveEvents = isVersioned ? data?.eventsByCohort?.retrospective ?? [] : [];
  const prospectiveStart = data?.methodology?.prospectiveStart;
  const health = data == null
    ? null
    : data.health ?? { state: "unknown", stale: true, limitedRun: false };
  const healthAsOf = health?.asOf ? String(health.asOf).slice(0, 10) : null;
  const limitedContext = health?.limitedRun
    ? " The latest attempt covered only a limited smoke-test universe."
    : "";
  const healthMessage = data?.error
    ? null
    : health?.state === "failure"
      ? `Latest scoreboard refresh failed${healthAsOf ? `; last good data is from ${healthAsOf}` : ""}.${limitedContext}`
      : health?.state === "degraded"
        ? `Latest scoreboard refresh completed with degraded coverage${healthAsOf ? ` (${healthAsOf})` : ""}.${limitedContext}`
        : health?.state === "running"
          ? `Scoreboard refresh is currently in progress; displayed results are the prior snapshot.${limitedContext}`
          : health?.state === "unknown"
            ? `Scoreboard freshness is not yet verified by the run manifest.${limitedContext}`
            : health?.limitedRun
              ? `Latest scoreboard refresh was a limited smoke run${healthAsOf ? `; last full data is from ${healthAsOf}` : ""}.`
            : health?.stale
              ? `Scoreboard snapshot is stale${healthAsOf ? ` (last refreshed ${healthAsOf})` : ""}.`
              : null;
  const emptyMessage = data?.error
    ? "Scoreboard data is temporarily unavailable."
    : data == null
      ? "Loading the versioned scoreboard…"
      : isVersioned
        ? `Forward-observed tracking began ${prospectiveStart || "at the methodology-v2 launch"}; results appear as its 1w / 1m / 3m windows mature.`
        : "Awaiting versioned cohort data; legacy blended results are intentionally hidden.";

  if (effectiveLocked && !teaser) {
    return <div style={{ fontFamily: "var(--font-condensed)", fontSize: 9, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-500)" }}>🔒 Members</div>;
  }

  if (effectiveLocked) {
    return (
      <div style={{ borderRadius: "var(--radius-2xl)", border: "1px solid var(--border-hairline)", background: "var(--surface-card)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", boxShadow: "var(--shadow-panel)", padding: "14px 18px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: "var(--ink-300)", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ fontSize: 14 }}>⚖</span> Signal Scoreboard
          </div>
          <div style={{ fontSize: 10, color: "var(--ink-500)" }}>Weekly composite leadership</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {teaser.top.slice(0, 3).map(item => (
            <div key={`${item.ticker}-${item.rank}`} style={{ display: "grid", gridTemplateColumns: "30px minmax(54px, 72px) minmax(110px, 1fr)", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--ink-500)" }}>#{item.rank}</span>
              <span style={{ fontFamily: "var(--font-condensed)", fontSize: 12, fontWeight: 800, color: "var(--ink-100)", letterSpacing: "0.06em" }}>{item.ticker}</span>
              <span aria-hidden="true" style={{ height: 9, borderRadius: "var(--radius-pill)", background: "var(--surface-inset)", border: "1px solid var(--border-hairline)", overflow: "hidden" }}>
                <span style={{ display: "block", width: teaserBarWidth(item.rank), height: "100%", borderRadius: "var(--radius-pill)", background: "linear-gradient(90deg, var(--accent), var(--pos), var(--event))", filter: "blur(5px)" }} />
              </span>
            </div>
          ))}
        </div>

        <div style={{ marginTop: 12, fontSize: 11, color: "var(--ink-400)" }}>
          {teaser.moverCount} signals moved this week across {teaser.totalTracked} tracked names
        </div>

        <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--border-hairline)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-300)" }}>Members see the full scoreboard</span>
          <a href="/#register" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", borderRadius: "var(--radius-pill)", padding: "6px 12px", background: "var(--accent)", border: "1px solid var(--accent)", boxShadow: "var(--glow-cyan-soft)", color: "var(--on-accent)", fontFamily: "var(--font-condensed)", fontSize: 9.5, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", textDecoration: "none" }}>
            Join free
          </a>
        </div>
      </div>
    );
  }

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

      {healthMessage && (
        <div role="status" style={{ marginBottom: 10, padding: "7px 9px", borderRadius: 7, border: "1px solid rgba(245,158,11,0.35)", background: "rgba(120,53,15,0.24)", color: "#fde68a", fontSize: 10.5, lineHeight: 1.45 }}>
          {healthMessage} Stored results remain visible for context.
        </div>
      )}

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
