import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { EYEBROW_STYLE, PANEL_STYLE, ScoreBreakdown } from "./ResearchPanel";

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

const CELL_STYLE = {
  padding: "11px 12px",
  whiteSpace: "nowrap",
};

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

function scoreComparator(field) {
  return (left, right) => {
    const leftScored = left.coverage === "scored";
    const rightScored = right.coverage === "scored";
    if (leftScored !== rightScored) return leftScored ? -1 : 1;

    const leftScore = finiteNumber(left[field]);
    const rightScore = finiteNumber(right[field]);
    if (leftScore == null && rightScore != null) return 1;
    if (leftScore != null && rightScore == null) return -1;
    if (leftScore !== rightScore) return (rightScore ?? 0) - (leftScore ?? 0);
    return String(left.ticker).localeCompare(String(right.ticker));
  };
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

function TrendSparkline({ trend, technicalOnly = false }) {
  const points = Array.isArray(trend)
    ? [...trend].sort((left, right) => String(left?.asOf || "").localeCompare(String(right?.asOf || "")))
    : [];
  if (!points.length) return <span style={{ color: "var(--ink-500)", fontSize: 10 }}>No trend history yet.</span>;

  const width = 120;
  const height = 28;
  const padding = 2;
  const denominator = Math.max(1, points.length - 1);
  const seriesPoints = field => points.map((point, index) => {
    const value = finiteNumber(point?.[field]);
    if (value == null) return null;
    return {
      x: padding + (index / denominator) * (width - padding * 2),
      y: height - padding - (Math.min(100, Math.max(0, value)) / 100) * (height - padding * 2),
    };
  }).filter(Boolean);
  const qualityPoints = technicalOnly ? [] : seriesPoints("quality");
  const technicalPoints = seriesPoints("technical");

  const Series = ({ values, color }) => values.length > 1 ? (
    <polyline
      points={values.map(point => `${point.x},${point.y}`).join(" ")}
      fill="none"
      stroke={color}
      strokeWidth="1.5"
      vectorEffect="non-scaling-stroke"
    />
  ) : values.length === 1 ? (
    <circle cx={values[0].x} cy={values[0].y} r="1.5" fill={color} />
  ) : null;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={technicalOnly ? "Radar technical score trend" : "Radar score trend"}>
        <title>{`${points.length} weekly Radar snapshots`}</title>
        {!technicalOnly && <Series values={qualityPoints} color="var(--accent)" />}
        <Series values={technicalPoints} color="var(--info)" />
      </svg>
      <div style={{ display: "flex", gap: 8, color: "var(--ink-500)", fontSize: 9 }}>
        {!technicalOnly && <span><span style={{ color: "var(--accent)" }}>●</span> Quality</span>}
        <span><span style={{ color: "var(--info)" }}>●</span> Technical</span>
      </div>
    </div>
  );
}

function FundProfilePanel({ profile }) {
  const fundProfile = profile && typeof profile === "object" ? profile : {};
  const fields = [
    ["Category", typeof fundProfile.category === "string" && fundProfile.category ? fundProfile.category : "—"],
    ["Expense ratio", formatFundPercent(fundProfile.expenseRatio)],
    ["AUM", formatFundAssets(fundProfile.totalAssets)],
    ["Legal type", typeof fundProfile.legalType === "string" && fundProfile.legalType ? fundProfile.legalType : "—"],
  ];
  if (finiteNumber(fundProfile.yield) != null) fields.push(["Yield", formatFundPercent(fundProfile.yield)]);

  return (
    <section style={{ ...PANEL_STYLE, padding: 14 }}>
      <div style={{ ...EYEBROW_STYLE, marginBottom: 10 }}>Fund profile</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "10px 14px" }}>
        {fields.map(([label, value]) => (
          <div key={label}>
            <div style={{ color: "var(--ink-500)", fontSize: 9, marginBottom: 3 }}>{label}</div>
            <div style={{ color: "var(--ink-100)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function DetailSection({ ticker, state, onOpenResearch, isFund = false, fundProfile = null }) {
  if (!state || state.status === "loading") {
    return <div style={{ padding: "14px 2px", color: "var(--ink-400)", fontSize: 11 }}>Loading score details…</div>;
  }
  if (state.status === "error") {
    return <div style={{ padding: "14px 2px", color: "var(--down-400)", fontSize: 11 }}>{state.message}</div>;
  }

  const detail = state.data || {};
  const qualityScoreObject = {
    basis: detail.fiscalYearBasis == null ? null : `FY${detail.fiscalYearBasis}`,
    components: Array.isArray(detail.qualityComponents) ? detail.qualityComponents : [],
  };
  const technicalScoreObject = {
    basis: "3-month daily series",
    components: Array.isArray(detail.technicalComponents) ? detail.technicalComponents : [],
  };

  return (
    <div style={{ padding: "2px 2px 14px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
        {!isFund && <ScoreBreakdown title="Quality" scoreObject={qualityScoreObject} />}
        <ScoreBreakdown title="Technical" scoreObject={technicalScoreObject} />
        {isFund && <FundProfilePanel profile={detail.fundProfile ?? fundProfile} />}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, marginTop: 14, flexWrap: "wrap" }}>
        <div>
          <div style={{ ...EYEBROW_STYLE, marginBottom: 5 }}>12-week trend</div>
          <TrendSparkline trend={detail.trend} technicalOnly={isFund} />
        </div>
        {!isFund && <button
          type="button"
          onClick={() => onOpenResearch?.(ticker)}
          style={{
            color: "var(--void-900)",
            background: "var(--accent)",
            border: 0,
            borderRadius: "var(--radius-md)",
            padding: "8px 12px",
            cursor: "pointer",
            fontFamily: "var(--font-condensed)",
            fontSize: 10,
            fontWeight: 800,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          Open in Research →
        </button>}
      </div>
    </div>
  );
}

function Header({ asOf }) {
  return (
    <section style={{ ...PANEL_STYLE, padding: 18 }}>
      <div style={EYEBROW_STYLE}>Member Radar</div>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 14, marginTop: 7, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, color: "var(--ink-100)", fontSize: 22, lineHeight: 1.2 }}>Quality and momentum screener</h1>
          <p style={{ margin: "7px 0 0", color: "var(--ink-400)", fontSize: 11 }}>Compare every company across the AI, Musk, and robotics chains.</p>
        </div>
        {asOf && <div style={{ color: "var(--ink-500)", fontFamily: "var(--font-mono)", fontSize: 9.5 }}>Scores as of {String(asOf).slice(0, 10)}</div>}
      </div>
    </section>
  );
}

export default function RadarPanel({ onTickerClick, onOpenResearch, showFunds = false }) {
  const [payload, setPayload] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [subview, setSubview] = useState("stocks");
  const [fundsNotice, setFundsNotice] = useState(false);
  const [preset, setPreset] = useState("all");
  const [expandedTicker, setExpandedTicker] = useState(null);
  const [details, setDetails] = useState({});
  const detailControllers = useRef(new Map());

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

  useEffect(() => () => {
    detailControllers.current.forEach(controller => controller.abort());
    detailControllers.current.clear();
  }, []);

  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const stockRows = useMemo(() => rows.filter(row => row.coverage !== "fund"), [rows]);
  const fundRows = useMemo(() => rows.filter(row => row.coverage === "fund"), [rows]);
  const visibleRows = useMemo(() => {
    if (subview === "funds") return [...fundRows].sort(scoreComparator("technical"));
    if (preset === "quality") {
      return stockRows.filter(row => row.coverage === "scored").sort(scoreComparator("quality"));
    }
    if (preset === "momentum") {
      return stockRows.filter(row => row.coverage === "scored").sort(scoreComparator("technical"));
    }
    if (preset === "multi") {
      return stockRows.filter(row => finiteNumber(row.chainCount) > 1).sort(scoreComparator("quality"));
    }
    if (preset === "uncovered") {
      return stockRows.filter(row => row.coverage === "no_filings").sort((left, right) => String(left.ticker).localeCompare(String(right.ticker)));
    }
    return [...stockRows].sort(scoreComparator("quality"));
  }, [fundRows, preset, stockRows, subview]);

  const deltas = stockRows.map(rowDelta).filter(delta => delta != null);
  const everyDeltaZero = deltas.length > 0 && deltas.every(delta => Math.abs(delta) < 0.0001);
  const fundDataAvailable = fundRows.some(row => (
    row.fundProfile
    && typeof row.fundProfile === "object"
    && Object.values(row.fundProfile).some(value => value != null && value !== "")
  ));
  const health = payload?.health;
  const healthWarning = health?.stale || health?.state === "failure";

  async function loadDetail(ticker) {
    if (details[ticker]?.status === "ready" || detailControllers.current.has(ticker)) return;
    const controller = new AbortController();
    detailControllers.current.set(ticker, controller);
    setDetails(current => ({ ...current, [ticker]: { status: "loading" } }));
    try {
      const response = await fetch(`/radar?ticker=${encodeURIComponent(ticker)}`, { signal: controller.signal });
      if (!response.ok) {
        const requestError = await responseError(response);
        if (!controller.signal.aborted) {
          setDetails(current => ({ ...current, [ticker]: { status: "error", message: requestError.message } }));
        }
        return;
      }
      const data = await response.json();
      if (!controller.signal.aborted) {
        setDetails(current => ({ ...current, [ticker]: { status: "ready", data } }));
      }
    } catch (requestError) {
      if (!controller.signal.aborted) {
        setDetails(current => ({ ...current, [ticker]: { status: "error", message: "Unable to load score details." } }));
      }
    } finally {
      if (detailControllers.current.get(ticker) === controller) detailControllers.current.delete(ticker);
    }
  }

  function toggleRow(ticker) {
    const opening = expandedTicker !== ticker;
    setExpandedTicker(opening ? ticker : null);
    if (opening) void loadDetail(ticker);
  }

  function selectSubview(nextSubview) {
    if (nextSubview === "funds" && !showFunds) {
      setFundsNotice(true);
      return;
    }
    setSubview(nextSubview);
    setFundsNotice(false);
    setExpandedTicker(null);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <Header asOf={payload?.asOf} />

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
          <div style={{ padding: "14px 16px 12px", borderBottom: "1px solid var(--border-hairline)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: subview === "stocks" ? 13 : 0 }}>
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
            </div>

            {subview === "stocks" && (
              <>
                <div style={{ ...EYEBROW_STYLE, marginBottom: 8 }}>Presets</div>
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
                {everyDeltaZero && (
                  <div style={{ marginTop: 10, color: "var(--ink-500)", fontSize: 10.5, lineHeight: 1.5 }}>
                    No quality score changed this week across {deltas.length} names with history. Fundamentals move when filings land, so quiet weeks are normal.
                  </div>
                )}
              </>
            )}
          </div>

          {subview === "funds" && !fundDataAvailable ? (
            <div style={{ minHeight: 280, padding: 18, color: "var(--ink-400)", fontSize: 12 }}>
              Fund data arrives with the next weekly Radar run
            </div>
          ) : (
            <div style={{ maxHeight: "70vh", minHeight: 280, overflow: "auto", WebkitOverflowScrolling: "touch" }}>
              <table style={{ width: "100%", minWidth: subview === "funds" ? 880 : 620, borderCollapse: "collapse", textAlign: "left", fontSize: 11 }}>
                <thead style={{ ...EYEBROW_STYLE, position: "sticky", top: 0, zIndex: 10, color: "var(--ink-500)", background: "var(--surface-popup)" }}>
                  <tr style={{ borderBottom: "1px solid var(--border-hairline)" }}>
                    <th style={CELL_STYLE}>Ticker</th>
                    {subview === "funds" ? (
                      <>
                        <th style={CELL_STYLE}>Theme</th>
                        <th style={CELL_STYLE}>Category</th>
                        <th style={{ ...CELL_STYLE, textAlign: "right" }}>Expense</th>
                        <th style={{ ...CELL_STYLE, textAlign: "right" }}>AUM</th>
                        <th style={{ ...CELL_STYLE, textAlign: "right" }}>Technical</th>
                        <th style={CELL_STYLE}>Chains</th>
                      </>
                    ) : (
                      <>
                        <th style={{ ...CELL_STYLE, textAlign: "right" }}>Quality</th>
                        <th style={{ ...CELL_STYLE, textAlign: "right" }}>Technical</th>
                        <th style={{ ...CELL_STYLE, textAlign: "right" }}>Δwk</th>
                        <th style={CELL_STYLE}>Chains</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visibleRows.map(row => {
                    const expanded = expandedTicker === row.ticker;
                    const quality = finiteNumber(row.quality);
                    const technical = finiteNumber(row.technical);
                    const delta = rowDelta(row);
                    const deltaColor = delta == null || Math.abs(delta) < 0.0001
                      ? "var(--ink-500)"
                      : delta > 0 ? "var(--up-400)" : "var(--down-400)";
                    const chains = Array.isArray(row.chains) ? row.chains : [];
                    const themes = membershipNames(row);
                    const profile = row.fundProfile && typeof row.fundProfile === "object" ? row.fundProfile : {};
                    return (
                      <Fragment key={row.ticker}>
                        <tr
                          aria-expanded={expanded}
                          onClick={() => toggleRow(row.ticker)}
                          onKeyDown={event => {
                            if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) return;
                            event.preventDefault();
                            toggleRow(row.ticker);
                          }}
                          onMouseEnter={event => { event.currentTarget.style.background = "var(--surface-hover)"; }}
                          onMouseLeave={event => { event.currentTarget.style.background = ""; }}
                          tabIndex={0}
                          style={{ borderBottom: "1px solid var(--border-hairline)", cursor: "pointer", transition: "background .15s" }}
                        >
                          <td
                            onClick={event => {
                              event.stopPropagation();
                              onTickerClick?.(row.ticker, event.currentTarget.getBoundingClientRect());
                            }}
                            onKeyDown={event => {
                              if (!["Enter", " "].includes(event.key)) return;
                              event.preventDefault();
                              event.stopPropagation();
                              onTickerClick?.(row.ticker, event.currentTarget.getBoundingClientRect());
                            }}
                            role="button"
                            tabIndex={0}
                            style={{ ...CELL_STYLE, color: "var(--accent)", fontFamily: "var(--font-mono)", fontWeight: 800, cursor: "pointer" }}
                          >
                            {row.ticker}
                          </td>
                          {subview === "funds" ? (
                            <>
                              <td style={{ ...CELL_STYLE, color: "var(--ink-300)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis" }}>
                                <span title={membershipTitle(row)}>{themes[0] || "—"}</span>
                              </td>
                              <td style={{ ...CELL_STYLE, color: "var(--ink-300)" }}>
                                {typeof profile.category === "string" && profile.category ? profile.category : "—"}
                              </td>
                              <td style={{ ...CELL_STYLE, color: "var(--ink-300)", fontFamily: "var(--font-mono)", fontWeight: 700, textAlign: "right" }}>
                                {formatFundPercent(profile.expenseRatio)}
                              </td>
                              <td style={{ ...CELL_STYLE, color: "var(--ink-300)", fontFamily: "var(--font-mono)", fontWeight: 700, textAlign: "right" }}>
                                {formatFundAssets(profile.totalAssets)}
                              </td>
                              <td style={{ ...CELL_STYLE, color: technical == null ? "var(--ink-500)" : "var(--accent)", fontFamily: "var(--font-mono)", fontWeight: 700, textAlign: "right" }}>
                                {technical == null ? "—" : `${technical.toFixed(0)}/100`}
                              </td>
                              <td style={{ ...CELL_STYLE, color: "var(--ink-300)" }}>
                                <span title={membershipTitle(row)}>{chains.length ? chains.map(chain => CHAIN_EMOJI[chain] || chain).join(" ") : "—"}</span>
                              </td>
                            </>
                          ) : (
                            <>
                              {row.coverage === "scored" ? (
                                <>
                                  <td style={{ ...CELL_STYLE, color: quality == null ? "var(--ink-500)" : "var(--accent)", fontFamily: "var(--font-mono)", fontWeight: 700, textAlign: "right" }}>
                                    {quality == null ? "—" : `${quality.toFixed(0)}/100`}
                                  </td>
                                  <td style={{ ...CELL_STYLE, color: technical == null ? "var(--ink-500)" : "var(--accent)", fontFamily: "var(--font-mono)", fontWeight: 700, textAlign: "right" }}>
                                    {technical == null ? "—" : `${technical.toFixed(0)}/100`}
                                  </td>
                                </>
                              ) : (
                                <td colSpan={2} style={{ ...CELL_STYLE, textAlign: "center" }}><CoverageBadge coverage={row.coverage} /></td>
                              )}
                              <td style={{ ...CELL_STYLE, color: deltaColor, fontFamily: "var(--font-mono)", fontWeight: 700, textAlign: "right" }}>
                                {delta == null ? "—" : Math.abs(delta) < 0.0001 ? "0.0" : `${delta > 0 ? "+" : ""}${delta.toFixed(1)}`}
                              </td>
                              <td style={{ ...CELL_STYLE, color: "var(--ink-300)" }}>
                                <span title={membershipTitle(row)}>{chains.length ? chains.map(chain => CHAIN_EMOJI[chain] || chain).join(" ") : "—"}</span>
                              </td>
                            </>
                          )}
                        </tr>
                        {expanded && (
                          <tr style={{ borderBottom: "1px solid var(--border-hairline)", background: "var(--surface-inset)" }}>
                            <td colSpan={subview === "funds" ? 7 : 5} style={{ padding: "0 12px" }}>
                              <DetailSection
                                ticker={row.ticker}
                                state={details[row.ticker]}
                                onOpenResearch={onOpenResearch}
                                isFund={subview === "funds"}
                                fundProfile={row.fundProfile}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
