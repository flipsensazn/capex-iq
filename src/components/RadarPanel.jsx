import { useEffect, useMemo, useState } from "react";
import { EYEBROW_STYLE, PANEL_STYLE } from "./ResearchPanel";

const PRESETS = [
  { value: "all", label: "All", color: "var(--accent)" },
  { value: "quality", label: "High Quality", color: "var(--up-400)" },
  { value: "momentum", label: "Momentum", color: "var(--info)" },
  { value: "multi", label: "Multi-chain", color: "var(--event)" },
  { value: "uncovered", label: "Not covered", color: "var(--warn)" },
];

const CHAIN_EMOJI = {
  ai: "⚡",
  musk: "🚀",
  robotics: "🤖",
};

const CHAIN_LABEL = {
  ai: "AI",
  musk: "Musk",
  robotics: "Robotics",
};

const COVERAGE_BADGES = {
  no_filings: { label: "No SEC filings", color: "var(--warn)" },
  fund: { label: "Fund", color: "var(--info)" },
};

const STOCK_COLUMNS = "44px 84px minmax(150px,1.2fr) minmax(150px,1.2fr) 70px 150px minmax(100px,0.9fr)";
const FUND_COLUMNS = "44px 84px minmax(150px,1.3fr) minmax(110px,1fr) 80px 80px minmax(150px,1.2fr) 150px";
const STOCK_SORT_KEYS = new Set(["ticker", "quality", "technical", "delta"]);
const FUND_SORT_KEYS = new Set(["ticker", "expense", "aum", "technical"]);

const GRID_CELL_STYLE = {
  minWidth: 0,
  padding: "7px 10px",
};

const STOCK_HEADERS = [
  { label: "#", align: "right" },
  { label: "Ticker", key: "ticker" },
  { label: "Quality", key: "quality" },
  { label: "Technical", key: "technical" },
  { label: "Δwk", key: "delta", align: "right" },
  { label: "12w trend" },
  { label: "Chains" },
];

const FUND_HEADERS = [
  { label: "#", align: "right" },
  { label: "Ticker", key: "ticker" },
  { label: "Theme" },
  { label: "Category" },
  { label: "Expense", key: "expense", align: "right" },
  { label: "AUM", key: "aum", align: "right" },
  { label: "Technical", key: "technical" },
  { label: "12w trend" },
];

function finiteNumber(value) {
  if (value == null || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function rowDelta(row) {
  const quality = finiteNumber(row?.quality);
  const previous = finiteNumber(row?.prevQuality);
  return quality == null || previous == null ? null : quality - previous;
}

function sortValue(row, key) {
  if (key === "ticker") return String(row?.ticker || "");
  if (key === "delta") return rowDelta(row);
  if (key === "expense") return finiteNumber(row?.fundProfile?.expenseRatio);
  if (key === "aum") return finiteNumber(row?.fundProfile?.totalAssets);
  return finiteNumber(row?.[key]);
}

function compareRows(left, right, key, direction, prioritizeCoverage) {
  if (prioritizeCoverage) {
    const leftScored = left.coverage === "scored";
    const rightScored = right.coverage === "scored";
    if (leftScored !== rightScored) return leftScored ? -1 : 1;
  }

  const leftValue = sortValue(left, key);
  const rightValue = sortValue(right, key);
  if (leftValue == null && rightValue != null) return 1;
  if (leftValue != null && rightValue == null) return -1;

  let comparison = 0;
  if (typeof leftValue === "string" && typeof rightValue === "string") {
    comparison = leftValue.localeCompare(rightValue);
  } else if (leftValue != null && rightValue != null) {
    comparison = leftValue - rightValue;
  }
  if (comparison !== 0) return comparison * direction;
  return String(left.ticker).localeCompare(String(right.ticker));
}

function membershipTitle(row) {
  const memberships = row?.memberships && typeof row.memberships === "object"
    ? row.memberships
    : {};
  const groups = Object.entries(memberships).flatMap(([chain, values]) => {
    const names = Array.isArray(values) ? values.filter(Boolean) : [];
    if (!names.length) return [];
    return [`${CHAIN_LABEL[chain] || chain}: ${names.join(", ")}`];
  });
  return groups.length ? groups.join(" · ") : "No chain memberships";
}

function membershipNames(row) {
  const memberships = row?.memberships && typeof row.memberships === "object"
    ? row.memberships
    : {};
  return Object.values(memberships).flatMap(values => (
    Array.isArray(values) ? values.filter(value => typeof value === "string" && value.trim()) : []
  ));
}

function formatFundPercent(value) {
  const number = finiteNumber(value);
  return number == null ? "—" : `${(number * 100).toFixed(2)}%`;
}

function formatFundAssets(value) {
  const number = finiteNumber(value);
  if (number == null) return "—";
  const units = [
    [1e12, "T"],
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "K"],
  ];
  const unit = units.find(([threshold]) => Math.abs(number) >= threshold);
  if (!unit) return `$${number.toFixed(0)}`;
  const scaled = number / unit[0];
  return `$${scaled.toFixed(1).replace(/\.0$/, "")}${unit[1]}`;
}

async function responseError(response) {
  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const message = response.status === 401
    ? "Sign in to view Radar."
    : response.status === 403
      ? body?.code === "members_only"
        ? "Radar is a members feature and is not enabled for this account."
        : "Radar access is unavailable for this account."
      : response.status === 404
        ? "No Radar history was found for that ticker."
        : body?.error || body?.message || `Request failed (${response.status})`;
  return {
    message,
    code: body?.code || null,
    health: body?.health && typeof body.health === "object" ? body.health : null,
  };
}

function CoverageBadge({ coverage }) {
  const badge = COVERAGE_BADGES[coverage] || { label: "Not covered", color: "var(--ink-400)" };
  return (
    <span style={{
      display: "inline-flex",
      color: badge.color,
      background: `color-mix(in srgb, ${badge.color} 9%, transparent)`,
      border: `1px solid color-mix(in srgb, ${badge.color} 33%, transparent)`,
      borderRadius: "var(--radius-pill)",
      padding: "2px 8px",
      fontFamily: "var(--font-condensed)",
      fontSize: 9,
      fontWeight: 800,
      letterSpacing: "0.08em",
      textTransform: "uppercase",
      whiteSpace: "nowrap",
    }}>
      {badge.label}
    </span>
  );
}

function ScoreBar({ value, color }) {
  const score = finiteNumber(value);
  const width = score == null ? 0 : Math.min(100, Math.max(0, score));
  return (
    <div style={{ ...GRID_CELL_STYLE, display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 4, borderRadius: 999, background: "rgba(255,255,255,.06)", overflow: "hidden" }}>
        <div style={{ width: `${width}%`, height: "100%", borderRadius: 999, background: color }} />
      </div>
      <span style={{ color: "var(--ink-100)", fontFamily: "var(--font-mono)", fontSize: 10.5, fontWeight: 700, width: 22, textAlign: "right" }}>
        {score == null ? "—" : score.toFixed(0)}
      </span>
    </div>
  );
}

function TrendSparkline({ trend, technicalOnly = false }) {
  const width = 130;
  const height = 22;
  const padding = 2;
  const points = Array.isArray(trend)
    ? [...trend]
      .sort((left, right) => String(left?.asOf || "").localeCompare(String(right?.asOf || "")))
      .slice(-12)
    : [];
  const denominator = Math.max(1, points.length - 1);
  const seriesPoints = field => points.map((point, index) => {
    const value = finiteNumber(point?.[field]);
    if (value == null) return null;
    const x = padding + (index / denominator) * (width - padding * 2);
    const y = height - padding - (Math.min(100, Math.max(0, value)) / 100) * (height - padding * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).filter(Boolean).join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={technicalOnly ? "Radar technical score trend" : "Radar quality and technical score trend"}>
      <title>{`${points.length} weekly Radar snapshots`}</title>
      {!technicalOnly && (
        <polyline points={seriesPoints("quality")} fill="none" stroke="var(--accent)" strokeWidth="1.2" opacity="0.9" />
      )}
      <polyline points={seriesPoints("technical")} fill="none" stroke="var(--info-400)" strokeWidth="1.2" opacity="0.9" />
    </svg>
  );
}

function GridHeader({ columns, headers, sortKey, sortDir, onSort }) {
  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: columns,
      position: "sticky",
      top: 0,
      zIndex: 10,
      background: "var(--surface-popup)",
      borderBottom: "1px solid var(--border-hairline)",
    }}>
      {headers.map(header => {
        const sortable = Boolean(header.key);
        const active = sortable && sortKey === header.key;
        return (
          <button
            key={header.label}
            type="button"
            aria-disabled={!sortable}
            aria-label={active ? `${header.label}, sorted ${sortDir === -1 ? "descending" : "ascending"}` : undefined}
            onClick={sortable ? () => onSort(header.key) : undefined}
            tabIndex={sortable ? 0 : -1}
            style={{
              appearance: "none",
              minWidth: 0,
              background: "none",
              border: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: header.align === "right" ? "flex-end" : "flex-start",
              gap: 4,
              padding: 10,
              cursor: sortable ? "pointer" : "default",
              color: active ? "var(--accent)" : "var(--ink-500)",
              fontFamily: "var(--font-condensed)",
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: "0.15em",
              textAlign: header.align === "right" ? "right" : "left",
              textTransform: "uppercase",
              whiteSpace: "nowrap",
            }}
          >
            {header.label}
            {active && <span style={{ fontSize: 8 }}>{sortDir === -1 ? "▼" : "▲"}</span>}
          </button>
        );
      })}
    </div>
  );
}

function TickerButton({ ticker, onTickerClick }) {
  return (
    <button
      type="button"
      onClick={event => onTickerClick?.(ticker, event.currentTarget.getBoundingClientRect())}
      style={{
        ...GRID_CELL_STYLE,
        appearance: "none",
        background: "none",
        border: 0,
        color: "var(--accent)",
        cursor: "pointer",
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        fontWeight: 800,
        textAlign: "left",
        whiteSpace: "nowrap",
      }}
    >
      {ticker}
    </button>
  );
}

function RankCell({ rank }) {
  return (
    <div style={{ ...GRID_CELL_STYLE, color: "var(--ink-600)", fontFamily: "var(--font-mono)", fontSize: 9.5, textAlign: "right" }}>
      {rank}
    </div>
  );
}

function StockGrid({ rows, sortKey, sortDir, onSort, onTickerClick }) {
  return (
    <div style={{ minWidth: 900, fontSize: 11 }}>
      <GridHeader columns={STOCK_COLUMNS} headers={STOCK_HEADERS} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      {rows.map((row, index) => {
        const delta = rowDelta(row);
        const deltaIsZero = delta != null && Math.abs(delta) < 0.0001;
        const deltaColor = delta == null || deltaIsZero
          ? "var(--ink-500)"
          : delta > 0 ? "var(--up-400)" : "var(--down-400)";
        const deltaText = delta == null
          ? "—"
          : deltaIsZero ? "0.0" : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta).toFixed(1)}`;
        const chains = Array.isArray(row.chains) ? row.chains : [];
        return (
          <div
            key={row.ticker}
            onMouseEnter={event => { event.currentTarget.style.background = "var(--surface-hover)"; }}
            onMouseLeave={event => { event.currentTarget.style.background = ""; }}
            style={{
              display: "grid",
              gridTemplateColumns: STOCK_COLUMNS,
              alignItems: "center",
              borderBottom: "1px solid var(--border-hairline)",
              transition: "background .15s",
            }}
          >
            <RankCell rank={index + 1} />
            <TickerButton ticker={row.ticker} onTickerClick={onTickerClick} />
            {row.coverage === "scored" ? (
              <>
                <ScoreBar value={row.quality} color="var(--accent)" />
                <ScoreBar value={row.technical} color="var(--info-400)" />
              </>
            ) : (
              <div style={{ ...GRID_CELL_STYLE, gridColumn: "span 2", display: "flex", justifyContent: "center" }}>
                <CoverageBadge coverage={row.coverage} />
              </div>
            )}
            <div style={{ ...GRID_CELL_STYLE, color: deltaColor, fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, textAlign: "right" }}>
              {deltaText}
            </div>
            <div style={{ minWidth: 0, padding: "5px 10px" }}>
              <TrendSparkline trend={row.trend} />
            </div>
            <div style={{ ...GRID_CELL_STYLE, color: "var(--ink-300)", whiteSpace: "nowrap" }} title={membershipTitle(row)}>
              {chains.length ? chains.map(chain => CHAIN_EMOJI[chain] || chain).join(" ") : "—"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FundGrid({ rows, sortKey, sortDir, onSort, onTickerClick }) {
  return (
    <div style={{ minWidth: 900, fontSize: 11 }}>
      <GridHeader columns={FUND_COLUMNS} headers={FUND_HEADERS} sortKey={sortKey} sortDir={sortDir} onSort={onSort} />
      {rows.map((row, index) => {
        const profile = row.fundProfile && typeof row.fundProfile === "object" ? row.fundProfile : {};
        const themes = membershipNames(row);
        return (
          <div
            key={row.ticker}
            onMouseEnter={event => { event.currentTarget.style.background = "var(--surface-hover)"; }}
            onMouseLeave={event => { event.currentTarget.style.background = ""; }}
            style={{
              display: "grid",
              gridTemplateColumns: FUND_COLUMNS,
              alignItems: "center",
              borderBottom: "1px solid var(--border-hairline)",
              transition: "background .15s",
            }}
          >
            <RankCell rank={index + 1} />
            <TickerButton ticker={row.ticker} onTickerClick={onTickerClick} />
            <div style={{ ...GRID_CELL_STYLE, color: "var(--ink-300)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={membershipTitle(row)}>
              {themes[0] || "—"}
            </div>
            <div style={{ ...GRID_CELL_STYLE, color: "var(--ink-300)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {typeof profile.category === "string" && profile.category ? profile.category : "—"}
            </div>
            <div style={{ ...GRID_CELL_STYLE, color: "var(--ink-300)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, textAlign: "right", whiteSpace: "nowrap" }}>
              {formatFundPercent(profile.expenseRatio)}
            </div>
            <div style={{ ...GRID_CELL_STYLE, color: "var(--ink-300)", fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, textAlign: "right", whiteSpace: "nowrap" }}>
              {formatFundAssets(profile.totalAssets)}
            </div>
            <ScoreBar value={row.technical} color="var(--info-400)" />
            <div style={{ minWidth: 0, padding: "5px 10px" }}>
              <TrendSparkline trend={row.trend} technicalOnly />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function HeaderStat({ label, value, color }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ color: "var(--ink-500)", fontFamily: "var(--font-condensed)", fontSize: 8.5, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ color, fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, marginTop: 2 }}>
        {value}
      </div>
    </div>
  );
}

function Header({ asOf, bestRiser, biggestFaller }) {
  return (
    <section style={{ ...PANEL_STYLE, padding: 18 }}>
      <div style={EYEBROW_STYLE}>Member Radar</div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 14, marginTop: 7, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: "var(--ink-100)", fontSize: 22, lineHeight: 1.2 }}>Quality and momentum screener</h1>
          <p style={{ margin: "7px 0 0", color: "var(--ink-400)", fontSize: 11 }}>Compare every company across the AI, Musk, and robotics chains.</p>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <HeaderStat label="Best riser" value={bestRiser} color="var(--up-400)" />
          <div style={{ width: 1, height: 26, background: "var(--border-hairline)" }} />
          <HeaderStat label="Biggest faller" value={biggestFaller} color="var(--down-400)" />
          <div style={{ width: 1, height: 26, background: "var(--border-hairline)" }} />
          <div style={{ color: "var(--ink-500)", fontFamily: "var(--font-mono)", fontSize: 9.5 }}>
            Scores as of {asOf ? String(asOf).slice(0, 10) : "—"}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function RadarPanel({ onTickerClick, showFunds = false }) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [subview, setSubview] = useState("stocks");
  const [fundsNotice, setFundsNotice] = useState(false);
  const [preset, setPreset] = useState("all");
  const [filter, setFilter] = useState("");
  const [filterFocused, setFilterFocused] = useState(false);
  const [sortKey, setSortKey] = useState("quality");
  const [sortDir, setSortDir] = useState(-1);

  useEffect(() => {
    const controller = new AbortController();
    async function loadRadar() {
      setLoading(true);
      setError("");
      try {
        const response = await fetch("/radar", { signal: controller.signal });
        if (!response.ok) {
          const requestError = await responseError(response);
          if (!controller.signal.aborted) {
            if (requestError.health) setPayload({ health: requestError.health });
            setError(requestError.message);
          }
          return;
        }
        const data = await response.json();
        if (!controller.signal.aborted) setPayload(data);
      } catch (requestError) {
        if (!controller.signal.aborted) setError("Unable to load Radar right now.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void loadRadar();
    return () => controller.abort();
  }, []);

  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const stockRows = useMemo(() => rows.filter(row => row.coverage !== "fund"), [rows]);
  const fundRows = useMemo(() => rows.filter(row => row.coverage === "fund"), [rows]);
  const visibleRows = useMemo(() => {
    let nextRows = subview === "funds" ? [...fundRows] : [...stockRows];
    if (subview === "stocks") {
      if (preset === "quality" || preset === "momentum") {
        nextRows = nextRows.filter(row => row.coverage === "scored");
      } else if (preset === "multi") {
        nextRows = nextRows.filter(row => finiteNumber(row.chainCount) > 1);
      } else if (preset === "uncovered") {
        nextRows = nextRows.filter(row => row.coverage === "no_filings");
      }
    }

    const tickerFilter = filter.trim().toLowerCase();
    if (tickerFilter) {
      nextRows = nextRows.filter(row => String(row.ticker).toLowerCase().includes(tickerFilter));
    }
    return nextRows.sort((left, right) => compareRows(
      left,
      right,
      sortKey,
      sortDir,
      subview === "stocks"
    ));
  }, [filter, fundRows, preset, sortDir, sortKey, stockRows, subview]);

  const { bestRiser, biggestFaller } = useMemo(() => {
    const changes = stockRows
      .filter(row => row.coverage === "scored")
      .map(row => ({ ticker: row.ticker, delta: rowDelta(row) }))
      .filter(item => item.delta != null);
    const risers = changes
      .filter(item => item.delta > 0)
      .sort((left, right) => right.delta - left.delta || String(left.ticker).localeCompare(String(right.ticker)));
    const fallers = changes
      .filter(item => item.delta < 0)
      .sort((left, right) => left.delta - right.delta || String(left.ticker).localeCompare(String(right.ticker)));
    return {
      bestRiser: risers.length ? `${risers[0].ticker} +${risers[0].delta.toFixed(1)}` : "—",
      biggestFaller: fallers.length ? `${fallers[0].ticker} ${fallers[0].delta.toFixed(1)}` : "—",
    };
  }, [stockRows]);

  const deltas = stockRows.map(rowDelta).filter(delta => delta != null);
  const everyDeltaZero = deltas.length > 0 && deltas.every(delta => Math.abs(delta) < 0.0001);
  const fundDataAvailable = fundRows.some(row => (
    row.fundProfile
    && typeof row.fundProfile === "object"
    && Object.values(row.fundProfile).some(value => value != null && value !== "")
  ));
  const health = payload?.health;
  const healthWarning = health?.stale || health?.state === "failure";

  function selectSubview(nextSubview) {
    if (nextSubview === "funds" && !showFunds) {
      setFundsNotice(true);
      return;
    }
    if (nextSubview !== subview) {
      const validKeys = nextSubview === "funds" ? FUND_SORT_KEYS : STOCK_SORT_KEYS;
      if (!validKeys.has(sortKey)) {
        setSortKey(nextSubview === "funds" ? "technical" : "quality");
        setSortDir(-1);
      }
    }
    setSubview(nextSubview);
    setFundsNotice(false);
  }

  function toggleSort(nextSortKey) {
    setSortDir(sortKey === nextSortKey ? -sortDir : nextSortKey === "ticker" ? 1 : -1);
    setSortKey(nextSortKey);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Header asOf={payload?.asOf} bestRiser={bestRiser} biggestFaller={biggestFaller} />

      {healthWarning && (
        <div role="status" style={{
          padding: "6px 10px",
          color: "var(--warn)",
          background: "color-mix(in srgb, var(--warn) 9%, transparent)",
          border: "1px solid color-mix(in srgb, var(--warn) 30%, transparent)",
          borderRadius: "var(--radius-md)",
          fontSize: 10.5,
        }}>
          Radar data may be out of date{health?.asOf ? ` · last good snapshot ${String(health.asOf).slice(0, 10)}` : ""}.
        </div>
      )}

      {loading ? (
        <div style={{ ...PANEL_STYLE, padding: 18, color: "var(--ink-400)", fontSize: 12 }}>Loading Radar scores…</div>
      ) : error ? (
        <div role="alert" style={{ ...PANEL_STYLE, padding: 18, color: "var(--down-400)", fontSize: 12 }}>{error}</div>
      ) : !rows.length ? (
        <div style={{ ...PANEL_STYLE, padding: 18, color: "var(--ink-400)", fontSize: 12 }}>Radar scores are not available yet.</div>
      ) : (
        <section style={{ ...PANEL_STYLE, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "12px 16px", borderBottom: "1px solid var(--border-hairline)" }}>
            <div aria-label="Radar view" style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {["stocks", "funds"].map(item => {
                const active = subview === item;
                const locked = item === "funds" && !showFunds;
                return (
                  <button
                    key={item}
                    type="button"
                    aria-pressed={active}
                    onClick={() => selectSubview(item)}
                    title={locked ? "Fund Radar is a members feature" : `Show ${item}`}
                    style={{
                      color: active ? "var(--accent)" : "var(--ink-400)",
                      background: active ? "var(--accent-quiet)" : "var(--surface-inset)",
                      border: `1px solid ${active ? "var(--border-cyan)" : "var(--border-hairline)"}`,
                      boxShadow: active ? "var(--ring-accent)" : "none",
                      borderRadius: "var(--radius-pill)",
                      padding: "4px 10px",
                      cursor: "pointer",
                      fontFamily: "var(--font-condensed)",
                      fontSize: 9,
                      fontWeight: 800,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                    }}
                  >
                    {item}
                  </button>
                );
              })}
            </div>
            {fundsNotice && !showFunds && (
              <span role="status" style={{ color: "var(--down-300)", fontSize: 9, lineHeight: 1.3 }}>
                Fund Radar is a members feature.
              </span>
            )}
            <div style={{ width: 1, height: 20, background: "var(--border-hairline)" }} />
            {subview === "stocks" && (
              <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                {PRESETS.map(item => {
                  const active = preset === item.value;
                  return (
                    <button
                      key={item.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setPreset(item.value)}
                      style={{
                        color: item.color,
                        background: `color-mix(in srgb, ${item.color} 9%, transparent)`,
                        border: `1px solid color-mix(in srgb, ${item.color} 33%, transparent)`,
                        boxShadow: active ? `inset 0 0 0 1px ${item.color}` : "none",
                        borderRadius: "var(--radius-pill)",
                        padding: "5px 10px",
                        cursor: "pointer",
                        opacity: active ? 1 : 0.72,
                        fontFamily: "var(--font-condensed)",
                        fontSize: 9.5,
                        fontWeight: 800,
                        letterSpacing: "0.06em",
                      }}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            )}
            <div style={{ flex: 1 }} />
            <div style={{ position: "relative", width: 130, flex: "0 0 130px" }}>
              <input
                type="search"
                aria-label="Filter Radar tickers"
                value={filter}
                onChange={event => setFilter(event.target.value)}
                onFocus={() => setFilterFocused(true)}
                onBlur={() => setFilterFocused(false)}
                style={{
                  boxSizing: "border-box",
                  width: "100%",
                  background: "var(--surface-inset)",
                  border: `1px solid ${filterFocused ? "var(--border-cyan)" : "var(--border-hairline)"}`,
                  borderRadius: "var(--radius-md)",
                  boxShadow: filterFocused ? "var(--ring-accent)" : "none",
                  outline: "none",
                  padding: "5px 10px",
                  color: "var(--ink-100)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                }}
              />
              {!filter && (
                <span aria-hidden="true" style={{
                  position: "absolute",
                  top: "50%",
                  left: 10,
                  color: "var(--ink-500)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 10.5,
                  lineHeight: 1,
                  pointerEvents: "none",
                  transform: "translateY(-50%)",
                }}>
                  Filter tickers…
                </span>
              )}
            </div>
            <div style={{ color: "var(--ink-500)", fontFamily: "var(--font-mono)", fontSize: 9.5, whiteSpace: "nowrap" }}>
              {visibleRows.length} {subview === "funds" ? "funds" : "names"}
            </div>
          </div>

          {subview === "stocks" && everyDeltaZero && (
            <div style={{ padding: "0 16px 12px" }}>
              <div style={{ marginTop: 10, color: "var(--ink-500)", fontSize: 10.5, lineHeight: 1.5 }}>
                No quality score changed this week across {deltas.length} names with history. Fundamentals move when filings land, so quiet weeks are normal.
              </div>
            </div>
          )}

          {subview === "funds" && !fundDataAvailable ? (
            <div style={{ minHeight: 280, padding: 18, color: "var(--ink-400)", fontSize: 12 }}>
              Fund data arrives with the next weekly Radar run
            </div>
          ) : (
            <div style={{ maxHeight: "70vh", minHeight: 280, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
              {subview === "funds" ? (
                <FundGrid rows={visibleRows} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} onTickerClick={onTickerClick} />
              ) : (
                <StockGrid rows={visibleRows} sortKey={sortKey} sortDir={sortDir} onSort={toggleSort} onTickerClick={onTickerClick} />
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
