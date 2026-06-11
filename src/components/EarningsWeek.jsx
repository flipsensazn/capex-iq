import { useMemo } from "react";

// This week's earnings calls for the tickers on the active capex map.
// Data comes free with the existing /prices batch (earningsDate epoch per
// ticker, already preserved through refresh merges) — no extra backend.
// Days run Monday–Friday of the CURRENT week; today is highlighted, past
// days dimmed. BMO/AMC tags are derived from the call's New York time.

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri"];

function mondayOfCurrentWeek() {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (d.getDay() + 6) % 7; // Mon=0 … Sun=6
  d.setDate(d.getDate() - dow);
  return d;
}

function etHour(epochSeconds) {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false,
  }).format(new Date(epochSeconds * 1000));
  return Number(h);
}

function sessionTag(epochSeconds) {
  const h = etHour(epochSeconds);
  if (h < 10) return { text: "BMO", color: "#60a5fa", hint: "Before market open" };
  if (h >= 16) return { text: "AMC", color: "#c084fc", hint: "After market close" };
  return null; // mid-day timestamps are usually placeholder times — no tag
}

export default function EarningsWeek({ tickers = [], prices = {}, onTickerClick }) {
  const { days, total } = useMemo(() => {
    const monday = mondayOfCurrentWeek();
    const days = DAY_LABELS.map((label, i) => {
      const date = new Date(monday);
      date.setDate(monday.getDate() + i);
      return { label, date, entries: [] };
    });
    const weekStart = monday.getTime();
    const weekEnd = weekStart + 5 * 86400000; // through Friday 23:59

    let total = 0;
    for (const ticker of [...new Set(tickers)]) {
      const entry = prices[ticker];
      const epoch = entry && typeof entry === "object" ? entry.earningsDate : null;
      if (!epoch) continue;
      const t = epoch * 1000;
      if (t < weekStart || t >= weekEnd) continue;
      const dayIdx = Math.floor((t - weekStart) / 86400000);
      days[dayIdx].entries.push({
        ticker,
        change: entry.change ?? null,
        session: sessionTag(epoch),
      });
      total++;
    }
    // BMO first, then untagged, then AMC — matches the trading day
    const order = { BMO: 0, undefined: 1, AMC: 2 };
    for (const d of days) {
      d.entries.sort((a, b) => (order[a.session?.text] ?? 1) - (order[b.session?.text] ?? 1) || a.ticker.localeCompare(b.ticker));
    }
    return { days, total };
  }, [tickers, prices]);

  const todayKey = new Date().toDateString();

  return (
    <div style={{ borderRadius: 18, border: "1px solid rgba(255,255,255,0.08)", background: "rgba(24,24,24,0.92)", padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>🗓</span> Earnings This Week
          {total > 0 && (
            <span style={{ fontSize: 10, fontWeight: 800, color: "#fbbf24", border: "1px solid #fbbf24", borderRadius: 8, padding: "0 7px" }}>{total}</span>
          )}
        </div>
        <div style={{ fontSize: 10, color: "#475569" }}>
          tracked tickers only · <span style={{ color: "#60a5fa" }}>BMO</span> before open · <span style={{ color: "#c084fc" }}>AMC</span> after close
        </div>
      </div>

      <div className="earnings-week-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0,1fr))", gap: 10 }}>
        {days.map(day => {
          const isToday = day.date.toDateString() === todayKey;
          const isPast = !isToday && day.date < new Date(todayKey);
          return (
            <div key={day.label} style={{
              borderRadius: 12, padding: 10, minHeight: 86,
              border: `1px solid ${isToday ? "rgba(251,191,36,0.45)" : "rgba(255,255,255,0.07)"}`,
              background: isToday ? "rgba(251,191,36,0.05)" : "rgba(255,255,255,0.02)",
              opacity: isPast ? 0.55 : 1,
            }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.1em", color: isToday ? "#fbbf24" : "#94a3b8", textTransform: "uppercase" }}>
                  {day.label}{isToday ? " · today" : ""}
                </span>
                <span style={{ fontSize: 10, color: "#475569" }}>
                  {day.date.toLocaleDateString("en-US", { month: "numeric", day: "numeric" })}
                </span>
              </div>
              {day.entries.length === 0 ? (
                <div style={{ fontSize: 10, color: "#334155", textAlign: "center", paddingTop: 12 }}>—</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                  {day.entries.map(e => {
                    const pos = (e.change ?? 0) >= 0;
                    return (
                      <div key={e.ticker}
                        onClick={ev => onTickerClick?.(e.ticker, ev.currentTarget.getBoundingClientRect())}
                        style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 8px", borderRadius: 6, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", cursor: "pointer" }}>
                        <span style={{ fontSize: 11.5, fontWeight: 800, color: "#e2e8f0" }}>{e.ticker}</span>
                        {e.session && (
                          <span title={e.session.hint} style={{ fontSize: 8.5, fontWeight: 800, color: e.session.color, border: `1px solid ${e.session.color}55`, borderRadius: 3, padding: "0 4px", letterSpacing: "0.05em" }}>
                            {e.session.text}
                          </span>
                        )}
                        {e.change != null && (
                          <span style={{ fontSize: 10, fontWeight: 700, color: pos ? "#34d399" : "#f87171", marginLeft: "auto" }}>
                            {pos ? "+" : ""}{Number(e.change).toFixed(1)}%
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {total === 0 && (
        <div style={{ fontSize: 11, color: "#475569", textAlign: "center", marginTop: 10 }}>
          No earnings calls this week from tracked tickers.
        </div>
      )}
    </div>
  );
}
