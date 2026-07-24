import { useMemo, useState } from "react";

// Full-month earnings calendar for the tickers on the active capex map.
//
// Data comes free with the existing /prices batch (an earningsDate epoch per
// ticker, preserved through refresh merges) — no extra backend. Note what that
// feed actually is: each ticker's NEXT confirmed report date, not a forward
// schedule. So the current reporting cycle fills in densely and months beyond
// it are legitimately empty until companies publish dates. We show that state
// honestly rather than projecting quarters forward, which would be inventing
// dates the market hasn't announced.
//
// BMO/AMC tags are derived from the call's New York time; mid-day timestamps
// are usually placeholders, so they stay untagged.

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function etHour(epochSeconds) {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "numeric", hour12: false,
  }).format(new Date(epochSeconds * 1000));
  return Number(h);
}

function sessionTag(epochSeconds) {
  const h = etHour(epochSeconds);
  if (h < 10) return { text: "BMO", color: "var(--info)", hint: "Before market open" };
  if (h >= 16) return { text: "AMC", color: "var(--event)", hint: "After market close" };
  return null;
}

const dayKey = d => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export default function EarningsCalendar({ tickers = [], prices = {}, onTickerClick }) {
  const [monthOffset, setMonthOffset] = useState(0);

  // Every known report date, bucketed by calendar day. Built once per data
  // change and reused across month navigation.
  const { byDay, knownCount, horizon } = useMemo(() => {
    const byDay = new Map();
    let knownCount = 0, horizon = null;
    for (const ticker of [...new Set(tickers)]) {
      const entry = prices[ticker];
      const epoch = entry && typeof entry === "object" ? entry.earningsDate : null;
      if (!epoch) continue;
      const date = new Date(epoch * 1000);
      const key = dayKey(date);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push({ ticker, change: entry.change ?? null, session: sessionTag(epoch) });
      knownCount++;
      if (!horizon || date > horizon) horizon = date;
    }
    // BMO first, then untagged, then AMC — matches the trading day.
    const order = { BMO: 0, undefined: 1, AMC: 2 };
    for (const list of byDay.values()) {
      list.sort((a, b) =>
        (order[a.session?.text] ?? 1) - (order[b.session?.text] ?? 1) ||
        a.ticker.localeCompare(b.ticker));
    }
    return { byDay, knownCount, horizon };
  }, [tickers, prices]);

  const today = new Date();
  const todayKey = dayKey(today);

  const { cells, label, monthTotal } = useMemo(() => {
    const view = new Date(today.getFullYear(), today.getMonth() + monthOffset, 1);
    const y = view.getFullYear(), m = view.getMonth();
    const lead = (view.getDay() + 6) % 7;               // Mon-first grid
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cellCount = Math.ceil((lead + daysInMonth) / 7) * 7;

    const cells = [];
    let monthTotal = 0;
    for (let i = 0; i < cellCount; i++) {
      const date = new Date(y, m, i - lead + 1);
      const inMonth = date.getMonth() === m;
      const entries = byDay.get(dayKey(date)) || [];
      if (inMonth) monthTotal += entries.length;
      cells.push({ date, inMonth, entries, key: dayKey(date) });
    }
    return { cells, label: `${MONTHS[m]} ${y}`, monthTotal };
  }, [monthOffset, byDay]);

  const navBtn = {
    background: "rgba(255,255,255,0.04)", border: "1px solid var(--border-soft)",
    borderRadius: "var(--radius-sm)", color: "var(--ink-200)", cursor: "pointer",
    fontFamily: "inherit", fontSize: 13, lineHeight: 1, padding: "6px 11px",
  };

  return (
    <div style={{
      borderRadius: "var(--radius-2xl)", border: "1px solid var(--border-hairline)",
      background: "var(--surface-card)", backdropFilter: "var(--glass-blur)",
      WebkitBackdropFilter: "var(--glass-blur)", boxShadow: "var(--shadow-panel)", padding: 18,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{
            fontSize: 11, color: "var(--ink-300)", letterSpacing: "0.15em",
            textTransform: "uppercase", fontWeight: 700, display: "flex", alignItems: "center", gap: 6,
          }}>
            <span style={{ fontSize: 14 }}>🗓</span> Earnings Calendar
          </span>
          <span style={{
            fontSize: 10, fontWeight: 700, color: monthTotal ? "var(--accent)" : "var(--ink-500)",
            border: `1px solid ${monthTotal ? "var(--border-cyan)" : "var(--border-hairline)"}`,
            background: monthTotal ? "var(--accent-quiet)" : "transparent",
            borderRadius: "var(--radius-chip)", padding: "1px 7px",
          }}>{monthTotal}</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button style={navBtn} onClick={() => setMonthOffset(o => o - 1)} aria-label="Previous month">‹</button>
          <span style={{
            fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 13,
            color: "var(--ink-050)", minWidth: 132, textAlign: "center", letterSpacing: "0.04em",
          }}>{label}</span>
          <button style={navBtn} onClick={() => setMonthOffset(o => o + 1)} aria-label="Next month">›</button>
          {monthOffset !== 0 && (
            <button style={{ ...navBtn, fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}
              onClick={() => setMonthOffset(0)}>Today</button>
          )}
        </div>
      </div>

      <div style={{ fontSize: 10, color: "var(--ink-500)", marginBottom: 10 }}>
        tracked tickers only · <span style={{ color: "var(--info)" }}>BMO</span> before open ·{" "}
        <span style={{ color: "var(--event)" }}>AMC</span> after close
      </div>

      {/* ec-scroll / ec-inner: seven columns can't fit a phone, so the month
          becomes a horizontal swipe row below 900px (see GLOBAL_STYLES). */}
      <div className="ec-scroll">
        <div className="ec-inner">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0,1fr))", gap: 6, marginBottom: 6 }}>
            {DAY_LABELS.map((d, i) => (
              <div key={d} style={{
                fontFamily: "var(--font-condensed)", fontSize: 9, letterSpacing: "0.15em",
                textTransform: "uppercase", color: i > 4 ? "var(--ink-600)" : "var(--text-muted)",
                textAlign: "center", paddingBottom: 2,
              }}>{d}</div>
            ))}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0,1fr))", gap: 6 }}>
            {cells.map(cell => {
              const isToday = cell.key === todayKey;
              const isWeekend = cell.date.getDay() === 0 || cell.date.getDay() === 6;
              const isPast = cell.date < new Date(today.getFullYear(), today.getMonth(), today.getDate());
              return (
                <div key={cell.key} style={{
                  minHeight: 92, borderRadius: "var(--radius-md)", padding: "6px 7px",
                  background: isToday ? "var(--accent-quiet)"
                    : cell.inMonth ? (isWeekend ? "rgba(0,0,0,0.18)" : "var(--surface-inset)")
                    : "transparent",
                  border: `1px solid ${isToday ? "var(--border-cyan)" : cell.inMonth ? "var(--border-hairline)" : "transparent"}`,
                  opacity: cell.inMonth ? (isPast && !isToday ? 0.5 : 1) : 0.25,
                }}>
                  <div style={{
                    fontFamily: "var(--font-mono)", fontSize: 10,
                    color: isToday ? "var(--accent)" : "var(--ink-400)",
                    fontWeight: isToday ? 700 : 400, marginBottom: 4,
                  }}>{cell.date.getDate()}</div>

                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    {cell.entries.map(e => {
                      const up = (e.change ?? 0) >= 0;
                      return (
                        <button key={e.ticker}
                          onClick={ev => onTickerClick?.(e.ticker, ev.currentTarget.getBoundingClientRect())}
                          title={`${e.ticker}${e.session ? ` — ${e.session.hint}` : ""}`}
                          style={{
                            display: "flex", alignItems: "center", gap: 4, width: "100%",
                            background: "rgba(255,255,255,0.04)", border: "1px solid var(--border-hairline)",
                            borderRadius: "var(--radius-chip)", padding: "2px 5px", cursor: "pointer",
                            fontFamily: "var(--font-condensed)", textAlign: "left",
                          }}>
                          <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--ink-100)" }}>{e.ticker}</span>
                          {e.session && (
                            <span style={{ fontSize: 7.5, fontWeight: 700, color: e.session.color }}>{e.session.text}</span>
                          )}
                          {e.change != null && (
                            <span style={{
                              marginLeft: "auto", fontFamily: "var(--font-mono)", fontSize: 8.5,
                              color: up ? "var(--up-500)" : "var(--down-400)",
                            }}>{up ? "+" : ""}{Number(e.change).toFixed(1)}</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {monthTotal === 0 && (
        <div style={{ fontSize: 11, color: "var(--ink-500)", textAlign: "center", marginTop: 12, lineHeight: 1.6 }}>
          No tracked tickers report in {label}.
          {knownCount > 0 && horizon && (
            <><br />
            <span style={{ fontSize: 10, color: "var(--ink-600)" }}>
              The quote feed carries each ticker's next confirmed date — {knownCount} scheduled,
              latest {horizon.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}.
              Later months fill in as companies announce.
            </span></>
          )}
        </div>
      )}
    </div>
  );
}
