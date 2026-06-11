import { useMemo, useState } from "react";

// Total Investment Flow hero: a Sankey from the five hyperscalers into the
// six capex tracks. Company-side widths come from search-grounded per-company
// guidance (capex-intel byCompany); track-side widths from the live sector
// allocations. Per-company-per-sector mixes aren't disclosed anywhere, so
// each company's spend fans out proportionally to the sector split — labeled
// as such in the footnote.

// Fallback split if the grounded byCompany isn't available yet (rough shares
// of recent hyperscaler guidance) — replaced by live intel on first refresh.
// A different view (e.g. the Musk Galaxy) passes its own companyConfig.
const AI_COMPANIES = [
  { id: "AMZN", share: 0.28, isPublic: true },
  { id: "MSFT", share: 0.26, isPublic: true },
  { id: "GOOG", share: 0.19, isPublic: true },
  { id: "META", share: 0.17, isPublic: true },
  { id: "ORCL", share: 0.10, isPublic: true },
];

const W = 980, BAR_W = 8, LEFT_X = 150, RIGHT_X = 800, FLOW_H = 290, TOP_PAD = 8;

function fmtB(v) {
  return `$${Math.round(v)}B`;
}

function Sparkline({ history }) {
  if (!history || history.length < 2) return null;
  const totals = history.map(h => h.total).filter(t => t != null);
  if (totals.length < 2) return null;
  const min = Math.min(...totals), max = Math.max(...totals);
  const range = max - min || 1;
  const w = 110, h = 28;
  const pts = totals.map((t, i) => `${(i / (totals.length - 1)) * w},${h - 4 - ((t - min) / range) * (h - 8)}`).join(" ");
  const delta = totals[totals.length - 1] - totals[0];
  const days = Math.max(1, Math.round((new Date(history[history.length - 1].fetchedAt) - new Date(history[0].fetchedAt)) / 86400000));
  const color = delta > 0 ? "#34d399" : delta < 0 ? "#ef4444" : "#64748b";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }} title={`${history.length} readings over ${days} day${days > 1 ? "s" : ""}`}>
      <svg width={w} height={h} style={{ display: "block" }}>
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      <span style={{ fontSize: 11, fontWeight: 700, color }}>
        {delta >= 0 ? "+" : ""}{delta}B <span style={{ color: "#64748b", fontWeight: 400 }}>/ {days}d</span>
      </span>
    </div>
  );
}

export default function CapexSankey({
  total, live, byCompany, tracks, marketData, history, onTrackClick,
  companyConfig = AI_COMPANIES,
  subtitle = "Hyperscaler AI Capex",
}) {
  const [hover, setHover] = useState(null); // company id | track id | null

  const { companies, trackNodes, ribbons, height } = useMemo(() => {
    const companyCapex = companyConfig.map(cfg => ({
      ...cfg,
      capex: byCompany?.[cfg.id] ?? cfg.share * total,
    }));
    const companyTotal = companyCapex.reduce((s, c) => s + c.capex, 0) || 1;

    const trackTotal = tracks.reduce((s, t) => s + (t.capex || 0), 0) || 1;

    const cGap = 12, tGap = 10;
    const cScale = (FLOW_H - cGap * (companyCapex.length - 1)) / companyTotal;
    const tScale = (FLOW_H - tGap * (tracks.length - 1)) / trackTotal;

    let y = TOP_PAD;
    const companies = companyCapex.map(c => {
      const h = c.capex * cScale;
      const node = { ...c, y, h };
      y += h + cGap;
      return node;
    });

    y = TOP_PAD;
    const trackNodes = tracks.map(t => {
      const h = (t.capex || 0) * tScale;
      const node = { id: t.id, label: t.label, value: t.value, capex: t.capex || 0, color: t.color, y, h };
      y += h + tGap;
      return node;
    });

    // ribbons: company i → track j, thickness ∝ companyShare × trackShare
    const srcOff = companies.map(() => 0);
    const dstOff = trackNodes.map(() => 0);
    const ribbons = [];
    companies.forEach((c, i) => {
      trackNodes.forEach((t, j) => {
        const frac = t.capex / trackTotal;
        const sh = c.h * frac;             // thickness at the company side
        const dh = t.h * (c.capex / companyTotal); // thickness at the track side
        if (sh < 0.5 && dh < 0.5) return;
        const sy = c.y + srcOff[i];
        const dy = t.y + dstOff[j];
        srcOff[i] += sh;
        dstOff[j] += dh;
        ribbons.push({ company: c.id, track: t.id, color: t.color, sy, sh, dy, dh, dollars: c.capex * frac });
      });
    });

    return { companies, trackNodes, ribbons, height: TOP_PAD + FLOW_H + 12 };
  }, [byCompany, total, tracks, companyConfig]);

  const x1 = LEFT_X + BAR_W, x2 = RIGHT_X, mx = (x1 + x2) / 2;

  function ribbonOpacity(r) {
    if (!hover) return 0.32;
    return r.company === hover || r.track === hover ? 0.7 : 0.07;
  }

  return (
    <div style={{
      width: "100%", borderRadius: 4, padding: "22px 26px", boxSizing: "border-box",
      background: "linear-gradient(to bottom, #1c1917, #0a0a0a)",
      border: "1px solid #27272a", borderTop: "3px solid #fbbf24",
      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05), 0 4px 12px rgba(0,0,0,0.6)",
    }}>
      {/* header: total + live badge + guidance trend */}
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <div>
          <div style={{ fontSize: 11, color: "#94a3b8", letterSpacing: "0.3em", textTransform: "uppercase", marginBottom: 6, fontFamily: "'Roboto Condensed', sans-serif" }}>
            Total Investment Flow
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <span className="capex-number" style={{ fontSize: 56, fontWeight: 800, color: "#fbbf24", lineHeight: 1, textShadow: "0 2px 4px rgba(0,0,0,0.5)" }}>
              ~${total}B{live ? "" : "+"}
            </span>
            <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase", color: live ? "#34d399" : "#d97706" }}>
              {subtitle} {live ? "(live, search-grounded)" : "(2026 est.)"}
            </span>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <div style={{ fontSize: 9.5, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase", fontWeight: 700 }}>Guidance trend</div>
          {history?.length >= 2
            ? <Sparkline history={history} />
            : <span style={{ fontSize: 10, color: "#475569" }}>building history…</span>}
        </div>
      </div>

      {/* sankey */}
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${height}`} style={{ minWidth: 760, width: "100%", display: "block" }}>
          {ribbons.map((r, i) => (
            <path key={i}
              d={`M ${x1} ${r.sy} C ${mx} ${r.sy}, ${mx} ${r.dy}, ${x2} ${r.dy}
                  L ${x2} ${r.dy + r.dh} C ${mx} ${r.dy + r.dh}, ${mx} ${r.sy + r.sh}, ${x1} ${r.sy + r.sh} Z`}
              fill={r.color} opacity={ribbonOpacity(r)} style={{ transition: "opacity .15s" }}
              onMouseEnter={() => setHover(r.company)} onMouseLeave={() => setHover(null)}>
              <title>{`${r.company} → ${r.track}: ~${fmtB(r.dollars)} (proportional split)`}</title>
            </path>
          ))}

          {/* company nodes */}
          {companies.map(c => {
            const entry = c.isPublic !== false ? marketData?.[c.id] : null;
            const pos = (entry?.change ?? 0) >= 0;
            return (
              <g key={c.id} style={{ cursor: "default" }}
                onMouseEnter={() => setHover(c.id)} onMouseLeave={() => setHover(null)}
                opacity={hover && hover !== c.id && !ribbons.some(r => r.track === hover) ? 0.45 : 1}>
                <rect x={LEFT_X} y={c.y} width={BAR_W} height={Math.max(c.h, 2)} rx={2} fill="#fbbf24" opacity={0.85} />
                <text x={LEFT_X - 10} y={c.y + c.h / 2 - 8} textAnchor="end" style={{ fill: "#f8fafc", fontSize: 13, fontWeight: 800 }}>{c.label || c.id}</text>
                <text x={LEFT_X - 10} y={c.y + c.h / 2 + 6} textAnchor="end" style={{ fill: "#fbbf24", fontSize: 11, fontWeight: 700 }}>{fmtB(c.capex)}</text>
                {entry ? (
                  <text x={LEFT_X - 10} y={c.y + c.h / 2 + 19} textAnchor="end"
                    style={{ fill: entry?.change != null ? (pos ? "#10b981" : "#ef4444") : "#475569", fontSize: 10, fontWeight: 700 }}>
                    {entry?.price ? `$${entry.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} ` : ""}
                    {entry?.change != null ? `${pos ? "+" : ""}${entry.change.toFixed(2)}%` : ""}
                  </text>
                ) : c.isPublic === false ? (
                  <text x={LEFT_X - 10} y={c.y + c.h / 2 + 19} textAnchor="end"
                    style={{ fill: "#475569", fontSize: 9, fontWeight: 700, letterSpacing: "0.08em" }}>
                    PRIVATE
                  </text>
                ) : null}
                <title>{`${c.label || c.id}: ~${fmtB(c.capex)} capex${byCompany ? " (grounded intel)" : " (est. split)"}`}</title>
              </g>
            );
          })}

          {/* track nodes */}
          {trackNodes.map(t => (
            <g key={t.id} style={{ cursor: "pointer" }}
              onClick={() => onTrackClick?.(t.id)}
              onMouseEnter={() => setHover(t.id)} onMouseLeave={() => setHover(null)}
              opacity={hover && hover !== t.id && !ribbons.some(r => r.company === hover) ? 0.45 : 1}>
              <rect x={RIGHT_X} y={t.y} width={BAR_W} height={Math.max(t.h, 2)} rx={2} fill={t.color} />
              <text x={RIGHT_X + BAR_W + 10} y={t.y + t.h / 2 - 2} style={{ fill: t.color, fontSize: 12, fontWeight: 700 }}>{t.label}</text>
              <text x={RIGHT_X + BAR_W + 10} y={t.y + t.h / 2 + 12} style={{ fill: "#94a3b8", fontSize: 10.5, fontWeight: 700 }}>{t.value || fmtB(t.capex)}</text>
              <title>{`${t.label}: ${t.value || fmtB(t.capex)} — click to open track`}</title>
            </g>
          ))}
        </svg>
      </div>

      <div style={{ fontSize: 9.5, color: "#475569", marginTop: 8, lineHeight: 1.4 }}>
        Company totals from search-grounded intel (refreshed ~6h); sector split from live allocations.
        Per-company sector mix is not publicly disclosed — ribbons fan out proportionally. Click a sector to open its track.
      </div>
    </div>
  );
}
