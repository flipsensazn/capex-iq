import { useEffect, useRef, useState } from "react";
import { Wordmark } from "./ds";

const TOP_BAR_TICKERS = [
  { ticker: "^GSPC", label: "S&P 500", color: "var(--info-400)" },
  { ticker: "^DJI", label: "DOW", color: "var(--up-400)" },
  { ticker: "^IXIC", label: "NASDAQ", color: "var(--event-400)" },
  { ticker: "BTC-USD", label: "BTC", color: "var(--amber-400)" },
  { ticker: "ETH-USD", label: "ETH", color: "var(--info-400)" },
  { ticker: "XRP-USD", label: "XRP", color: "var(--up-400)" },
];

// NYSE holiday calendar, currently covering 2025–2027. Extend this set before
// the last listed year lapses, or market-state logic will treat new holidays as
// regular trading days. Source: NYSE holiday calendar.
const NYSE_HOLIDAYS_2025_2027 = new Set([
  "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18",
  "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01",
  "2025-11-27", "2025-12-25",
  "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03",
  "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
  "2026-11-26", "2026-12-25",
  "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26",
  "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06",
  "2027-11-25", "2027-12-24",
]);

function getNYTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = type => parts.find(p => p.type === type)?.value;
  const h = parseInt(get("hour"));
  const m = parseInt(get("minute"));
  const s = parseInt(get("second"));
  const dow = get("weekday");
  const month = get("month");
  const day = get("day");
  const year = get("year");
  const dateStr = `${year}-${month}-${day}`;
  return { h, m, s, dow, dateStr };
}

function getMarketState(date = new Date()) {
  const { h, m, dow, dateStr } = getNYTime(date);
  const isWeekend = dow === "Sat" || dow === "Sun";
  const isHoliday = NYSE_HOLIDAYS_2025_2027.has(dateStr);
  const totalMins = h * 60 + m;

  if (isWeekend || isHoliday) return { state: "closed", session: "weekend" };
  if (totalMins < 4 * 60) return { state: "closed", session: "overnight" };
  if (totalMins < 9 * 60 + 30) return { state: "pre", session: "premarket" };
  if (totalMins < 16 * 60) return { state: "open", session: "regular" };
  if (totalMins < 20 * 60) return { state: "post", session: "afterhours" };
  return { state: "closed", session: "overnight" };
}

function secsUntilNextEvent(date = new Date()) {
  const { h, m, s, dow, dateStr } = getNYTime(date);
  const totalSecs = h * 3600 + m * 60 + s;
  const { state } = getMarketState(date);

  if (state === "pre") return 9 * 3600 + 30 * 60 - totalSecs;
  if (state === "open") return 16 * 3600 - totalSecs;
  if (state === "post") return 20 * 3600 - totalSecs;

  const openSecs = 9 * 3600 + 30 * 60;
  const isWeekend = dow === "Sat" || dow === "Sun";
  const isHoliday = NYSE_HOLIDAYS_2025_2027.has(dateStr);
  if (!isWeekend && !isHoliday && totalSecs < openSecs) {
    return openSecs - totalSecs;
  }

  for (let d = 1; d <= 7; d++) {
    const candidate = new Date(date.getTime() + d * 86400000);
    const cny = getNYTime(candidate);
    if (cny.dow !== "Sat" && cny.dow !== "Sun" && !NYSE_HOLIDAYS_2025_2027.has(cny.dateStr)) {
      const secsLeftToday = 86400 - totalSecs;
      return secsLeftToday + (d - 1) * 86400 + openSecs;
    }
  }
  return 0;
}

function fmtCountdown(secs) {
  if (secs <= 0) return "00:00:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function BloombergChart({ data, timestamps, color }) {
  if (!data || !timestamps || data.length < 2) {
    return (
      <div style={{ height: 24, marginTop: 4, display: "flex", alignItems: "center", justifyContent: "center", borderTop: "1px dashed rgba(255,255,255,0.2)" }}>
        <span style={{ fontSize: 8, color: "var(--ink-500)" }}>NO CHART DATA</span>
      </div>
    );
  }

  const vbWidth = 160;
  const height = 24;
  let splitIndex = -1;
  let maxGap = 0;

  for (let i = 1; i < timestamps.length; i++) {
    const gap = timestamps[i] - timestamps[i - 1];
    if (gap > maxGap) {
      maxGap = gap;
      splitIndex = i;
    }
  }

  if (maxGap < 4 * 3600) {
    const dayAgo = timestamps[timestamps.length - 1] - 24 * 3600;
    splitIndex = timestamps.findIndex(t => t >= dayAgo);
  }
  if (splitIndex <= 0) splitIndex = Math.floor(data.length / 2);

  const validData = [];
  for (let i = 0; i < data.length; i++) {
    if (data[i] != null) validData.push({ val: data[i], idx: i });
  }
  if (validData.length < 2) return null;

  const min = Math.min(...validData.map(d => d.val));
  const max = Math.max(...validData.map(d => d.val));
  const yRange = max - min || 1;
  const yMin = min - yRange * 0.1;
  const yMax = max + yRange * 0.1;
  const scaleY = yMax - yMin;

  const getX = idx => (idx / (data.length - 1)) * vbWidth;
  const getY = val => height - ((val - yMin) / scaleY) * height;

  const part1 = validData.filter(d => d.idx <= splitIndex);
  const part2 = validData.filter(d => d.idx >= splitIndex);
  const path1 = part1.map((d, i) => `${i === 0 ? "M" : "L"}${getX(d.idx)},${getY(d.val)}`).join(" ");
  const path2 = part2.map((d, i) => `${i === 0 ? "M" : "L"}${getX(d.idx)},${getY(d.val)}`).join(" ");
  const splitX = getX(splitIndex);

  return (
    <div style={{ height, marginTop: 4, position: "relative", zIndex: 0, overflow: "hidden" }}>
      <svg width="100%" height={height} viewBox={`0 0 ${vbWidth} ${height}`} preserveAspectRatio="none" style={{ overflow: "hidden", display: "block" }}>
        <defs>
          <clipPath id="bloomberg-clip">
            <rect x="0" y="0" width={vbWidth} height={height} />
          </clipPath>
        </defs>
        <g clipPath="url(#bloomberg-clip)">
          <line x1={splitX} y1={0} x2={splitX} y2={height} stroke="rgba(255,255,255,0.4)" strokeWidth="1" strokeDasharray="2,2" />
          {path1 && <path d={path1} fill="none" stroke="var(--ink-050)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />}
          {path2 && <path d={path2} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />}
        </g>
      </svg>
    </div>
  );
}

function MarketClock() {
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const now = new Date(tick);
  const { state } = getMarketState(now);
  const secsLeft = secsUntilNextEvent(now);
  const countdown = fmtCountdown(secsLeft);
  const { h, m, s } = getNYTime(now);
  const etTime = `${String(h % 12 || 12).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"} ET`;

  const isOpen = state === "open";
  const isPre = state === "pre";
  const isPost = state === "post";
  const isExtended = isPre || isPost;

  const dotColor = isOpen ? "var(--pos)" : isExtended ? "var(--warn)" : "var(--ink-500)";
  const labelColor = isOpen ? "var(--pos)" : isExtended ? "var(--warn)" : "var(--ink-400)";
  const label = isOpen ? "MARKET OPEN" : isPre ? "PRE-MARKET" : isPost ? "AFTER HOURS" : "MARKET CLOSED";
  const subLabel = isOpen ? "closes in" : isExtended ? (isPre ? "opens in" : "closes in") : "opens in";

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: dotColor,
            display: "inline-block",
            boxShadow: isOpen ? `0 0 6px ${dotColor}` : "none",
            animation: isOpen ? "pulseDot 2s infinite" : "none",
          }}
        />
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.18em", color: labelColor, textTransform: "uppercase" }}>{label}</span>
      </div>

      <div style={{ fontFamily: "var(--font-mono)" }}>
        <span style={{ fontSize: 10, color: "var(--ink-600)", letterSpacing: "0.05em" }}>{subLabel} </span>
        <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: "0.08em", color: isOpen ? "var(--pos)" : isExtended ? "var(--warn)" : "var(--ink-500)" }}>
          {countdown}
        </span>
      </div>

      <div style={{ fontSize: 9, color: "var(--ink-700)", fontFamily: "var(--font-mono)", letterSpacing: "0.05em" }}>{etTime}</div>
    </div>
  );
}

function MarketClockCompact() {
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const now = new Date(tick);
  const { state } = getMarketState(now);
  const secsLeft = secsUntilNextEvent(now);
  const countdown = fmtCountdown(secsLeft);
  const { h, m, s } = getNYTime(now);
  const etTime = `${String(h % 12 || 12).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"} ET`;

  const isOpen = state === "open";
  const isPre = state === "pre";
  const isPost = state === "post";
  const isExt = isPre || isPost;
  const dotColor = isOpen ? "var(--pos)" : isExt ? "var(--warn)" : "var(--ink-500)";
  const label = isOpen ? "OPEN" : isPre ? "PRE" : isPost ? "AH" : "CLOSED";
  const labelColor = isOpen ? "var(--pos)" : isExt ? "var(--warn)" : "var(--ink-400)";
  const subLabel = isOpen ? "closes" : isExt ? (isPre ? "opens" : "closes") : "opens";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--font-mono)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ width: 5, height: 5, borderRadius: "50%", background: dotColor, display: "inline-block", boxShadow: isOpen ? `0 0 5px ${dotColor}` : "none", animation: isOpen ? "pulseDot 2s infinite" : "none" }} />
        <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.15em", color: labelColor }}>{label}</span>
      </div>
      <span style={{ fontSize: 9, color: "var(--ink-600)" }}>{subLabel} in</span>
      <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.06em", color: isOpen ? "var(--pos)" : isExt ? "var(--warn)" : "var(--ink-500)" }}>{countdown}</span>
      <span style={{ fontSize: 9, color: "var(--ink-700)", letterSpacing: "0.04em" }}>{etTime}</span>
    </div>
  );
}

export default function TopBar({ marketData }) {
  const barRef = useRef(null);
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => {
      setIsMobile(window.innerWidth < 768);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  function formatPrice(price, ticker) {
    if (price == null) return "—";
    if (ticker === "BTC-USD" || ticker === "ETH-USD") {
      return price.toLocaleString("en-US", { maximumFractionDigits: 0, useGrouping: true });
    }
    if (ticker === "XRP-USD") return price.toFixed(4);
    return price.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: true,
    });
  }

  if (isMobile) {
    return (
      <div
        ref={barRef}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
          background: "var(--bg-chrome)",
          borderBottom: "1px solid var(--border-hairline)",
          backdropFilter: "var(--glass-blur)",
          boxShadow: "var(--shadow-chrome)",
        }}
      >
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 3, padding: "4px 4px 0" }}>
          {TOP_BAR_TICKERS.map(({ ticker, label, color }) => {
            const entry = marketData[ticker] || {};
            const price = entry.price;
            const changePct = entry.change;
            const pos = (changePct ?? 0) >= 0;
            const changeColor = changePct == null ? "var(--ink-500)" : pos ? "var(--up-500)" : "var(--neg)";
            const sessionLabel = entry?.session === "POST" || entry?.session === "CLOSED" ? "AH" : entry?.session === "PRE" ? "PM" : null;
            let absChange = "—";
            if (price != null && changePct != null) {
              const diff = price - price / (1 + changePct / 100);
              absChange = `${diff >= 0 ? "+" : ""}${diff.toFixed(2)}`;
            }

            return (
              <div key={ticker} style={{ background: "var(--surface-inset)", border: "1px solid var(--border-hairline)", borderRadius: "var(--radius-md)", padding: "5px 7px 3px", fontFamily: "var(--font-condensed)", minWidth: 0 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color, letterSpacing: "0.03em", whiteSpace: "nowrap" }}>{label}</span>
                    {sessionLabel && <span style={{ fontSize: 6, fontWeight: 800, color: "var(--ink-300)", background: "rgba(255,255,255,0.05)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-chip)", padding: "0px 2px" }}>{sessionLabel}</span>}
                  </div>
                  <span style={{ fontSize: 9, fontWeight: 700, color: changeColor, whiteSpace: "nowrap" }}>{absChange}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-050)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{formatPrice(price, ticker)}</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: changeColor, whiteSpace: "nowrap", flexShrink: 0, marginLeft: 2 }}>
                    {changePct != null ? `${pos ? "+" : ""}${changePct.toFixed(2)}%` : "—"}
                  </span>
                </div>
                <BloombergChart data={entry.chartData} timestamps={entry.chartTimestamps} color={changeColor} />
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "3px 8px 4px", gap: 10, borderTop: "1px solid var(--border-hairline)" }}>
          <MarketClockCompact />
        </div>
      </div>
    );
  }

  return (
    <div
      ref={barRef}
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        padding: "0 16px",
        height: 72,
        background: "var(--bg-chrome)",
        borderBottom: "1px solid var(--border-hairline)",
        backdropFilter: "var(--glass-blur)",
        boxShadow: "var(--shadow-chrome)",
        overflow: "hidden",
      }}
    >
      <div style={{ flexShrink: 0, paddingRight: 14 }}>
        <Wordmark size={16} />
      </div>
      {/* The pills flex to fill whatever room is left between the wordmark and
          the clock. They used to also carry a scaleX() transform, which shrank
          them a second time and left the gap before the clock. */}
      <div
        style={{
          display: "flex",
          alignItems: "stretch",
          gap: 5,
          flex: "1 1 0",
          minWidth: 0,
        }}
      >
        {TOP_BAR_TICKERS.map(({ ticker, label, color }) => {
          const entry = marketData[ticker] || {};
          const price = entry.price;
          const changePct = entry.change;
          const pos = (changePct ?? 0) >= 0;
          const changeColor = changePct == null ? "var(--ink-500)" : pos ? "var(--up-500)" : "var(--neg)";
          const sessionLabel = entry?.session === "POST" || entry?.session === "CLOSED" ? "AH" : entry?.session === "PRE" ? "PM" : null;
          let absChange = "—";
          if (price != null && changePct != null) {
            const diff = price - price / (1 + changePct / 100);
            absChange = `${diff >= 0 ? "+" : ""}${diff.toFixed(2)}`;
          }

          return (
            <div
              key={ticker}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                padding: "6px 10px 4px",
                borderRadius: "var(--radius-md)",
                background: "var(--surface-inset)",
                border: "1px solid var(--border-hairline)",
                fontFamily: "var(--font-condensed)",
                flex: "1 1 0",
                minWidth: 0,
                boxSizing: "border-box",
                overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color, letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{label}</span>
                  {sessionLabel && <span style={{ fontSize: 7, fontWeight: 800, color: "var(--ink-300)", background: "rgba(255,255,255,0.05)", border: "1px solid var(--border-soft)", borderRadius: "var(--radius-chip)", padding: "1px 3px", flexShrink: 0 }}>{sessionLabel}</span>}
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: changeColor, whiteSpace: "nowrap", flexShrink: 0 }}>{absChange}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 2, gap: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-050)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{formatPrice(price, ticker)}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: changeColor, whiteSpace: "nowrap", flexShrink: 0 }}>
                  {changePct != null ? `${pos ? "+" : ""}${changePct.toFixed(2)}%` : "—"}
                </span>
              </div>
              <BloombergChart data={entry.chartData} timestamps={entry.chartTimestamps} color={changeColor} />
            </div>
          );
        })}
      </div>
      <div style={{ flexShrink: 0, marginLeft: 14, display: "flex", alignItems: "center", gap: 16 }}>
        <MarketClock />
      </div>
    </div>
  );
}
