import { useState } from "react";
import { stressColor } from "./capex-map/StressBadge";

// Bottleneck Scout review queue. The weekly agent (src/bottleneck_scout.py)
// proposes identity-verified candidates with a one-shot stress snapshot;
// the human approves (ticker joins the capex map + all weekly signal scans)
// or rejects (never suggested again). GET/POST /candidates.

const TRACK_LABELS = {
  ai: {
    compute: "Compute & Silicon", networking: "Networking & Connectivity",
    photonics: "Photonics & Interconnects", neoclouds: "Neoclouds & Data Centers",
    power: "Power & Cooling", frontier: "Frontier / Speculative",
  },
  musk: {
    ai: "AI & Compute (xAI · Dojo · Terafab)", vehicles: "Vehicles & Autonomy (Tesla)",
    space: "Launch & Starlink (SpaceX)", energy: "Energy & Storage",
    infra: "Build-out, Power & Tunnels", frontier: "Neuralink & Robotics",
  },
  robotics: {
    brain: "Brain & Edge AI", sensors: "Sensors & Perception",
    motors: "Motors & Motion", joints: "Joints & Precision Motion",
    power: "Power Electronics", materials: "Rare Earth & Energy",
  },
};

// Per-view chip shown on candidate cards (AI candidates get no chip).
const VIEW_CHIP = {
  musk:     { text: "🚀 MUSK",     color: "var(--event)", hint: "Musk Galaxy supply-chain candidate" },
  robotics: { text: "🦾 ROBOTICS", color: "var(--pos)", hint: "Humanoid-robotics supply-chain candidate" },
};

const DIR_LABELS = {
  constrained_supplier: { text: "BOTTLENECK OWNER", color: "var(--neg)" },
  constrained_buyer:    { text: "INPUT-CONSTRAINED", color: "#f59e0b" },
  both:                 { text: "OWNER + CONSTRAINED", color: "var(--frontier-400)" },
};

function fmtCap(n) {
  if (n == null) return "—";
  if (n >= 1e12) return "$" + (n / 1e12).toFixed(2) + "T";
  if (n >= 1e9)  return "$" + (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6)  return "$" + (n / 1e6).toFixed(0) + "M";
  return "$" + Math.round(n).toLocaleString();
}

const pct = v => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`;

function CandidateCard({ c, isAdmin, onReview, onTickerClick }) {
  const [busy, setBusy] = useState(false);
  const decided = c.status !== "pending";
  const sColor = c.stressScore != null ? stressColor(c.stressScore) : "var(--ink-500)";
  const dir = DIR_LABELS[c.stressDirection];

  async function review(action) {
    setBusy(true);
    await onReview(c, action);
    setBusy(false);
  }

  return (
    <div style={{
      borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 8,
      border: `1px solid ${decided ? "rgba(255,255,255,0.06)" : c.stressScore >= 70 ? "rgba(239,68,68,.35)" : "rgba(255,255,255,0.1)"}`,
      background: decided ? "rgba(255,255,255,0.015)" : "rgba(255,255,255,0.035)",
      opacity: decided ? 0.55 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span
          onClick={e => onTickerClick?.(c.ticker, e.currentTarget.getBoundingClientRect())}
          style={{ fontSize: 14, fontWeight: 800, color: "var(--ink-100)", cursor: "pointer" }}>
          {c.ticker}
        </span>
        <span style={{ fontSize: 11, color: "var(--ink-300)" }}>{c.name}</span>
        {c.isOtc && (
          <span style={{ fontSize: 9, fontWeight: 800, color: "#fbbf24", border: "1px solid #fbbf2466", background: "#fbbf2414", borderRadius: 3, padding: "1px 5px" }}>OTC</span>
        )}
        {VIEW_CHIP[c.view] && (
          <span title={VIEW_CHIP[c.view].hint} style={{ fontSize: 9, fontWeight: 800, color: VIEW_CHIP[c.view].color, border: `1px solid ${VIEW_CHIP[c.view].color}66`, background: VIEW_CHIP[c.view].color + "14", borderRadius: 3, padding: "1px 5px" }}>{VIEW_CHIP[c.view].text}</span>
        )}
        <span style={{ fontSize: 10, color: "var(--ink-500)", marginLeft: "auto" }}>
          {fmtCap(c.marketCap)}{c.price != null && ` · $${c.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}`}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: "var(--down-300)", border: "1px solid #f8717155", background: "#f8717112", borderRadius: 3, padding: "1px 7px", textTransform: "uppercase" }}>
          {c.chokepoint || "bottleneck candidate"}
        </span>
        <span style={{ fontSize: 10, color: "var(--ink-400)" }}>
          → {(TRACK_LABELS[c.view] || TRACK_LABELS.ai)[c.trackId] || c.trackId}{c.suggestedSubsector ? ` · ${c.suggestedSubsector}` : ""}
        </span>
      </div>

      {c.thesis && <div style={{ fontSize: 11.5, color: "var(--ink-200)", lineHeight: 1.5 }}>{c.thesis}</div>}

      {/* stress snapshot — same signals the map runs on */}
      <div style={{ borderTop: "1px solid var(--border-hairline)", paddingTop: 8, display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {c.stressScore != null ? (
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.08em", color: sColor, border: `1px solid ${sColor}`, background: sColor + "1c", borderRadius: 3, padding: "1px 7px" }}>
              STRESS {c.stressScore.toFixed(0)}
            </span>
          ) : (
            <span style={{ fontSize: 10, color: "var(--ink-500)" }}>no transcript data</span>
          )}
          {dir && <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.08em", color: dir.color }}>{dir.text}</span>}
          {(c.orderGap != null || c.inventoryDays != null) ? (
            <span style={{ fontSize: 10.5, color: "#7dd3fc" }}>
              {c.rpoYoy != null && <>backlog {pct(c.rpoYoy)}</>}
              {c.revenueYoy != null && <> vs rev {pct(c.revenueYoy)}</>}
              {c.orderGap != null && <> → gap {c.orderGap >= 0 ? "+" : ""}{c.orderGap.toFixed(0)}pp</>}
              {c.inventoryDays != null && <> · inv days {c.inventoryDays.toFixed(0)}</>}
            </span>
          ) : (
            <span style={{ fontSize: 10, color: "var(--ink-500)" }}>no XBRL data</span>
          )}
        </div>
        {c.stressSummary && <div style={{ fontSize: 10.5, color: "var(--ink-300)", lineHeight: 1.45 }}>{c.stressSummary}</div>}
        {c.stressQuotes?.slice(0, 2).map((q, i) => (
          <div key={i} style={{ fontSize: 10, color: "var(--ink-200)", borderLeft: `2px solid ${sColor}66`, paddingLeft: 7, fontStyle: "italic", lineHeight: 1.4 }}>
            “{q.quote}”
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
        {decided ? (
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", color: c.status === "approved" ? "var(--pos)" : "var(--ink-400)", textTransform: "uppercase" }}>
            {c.status}
          </span>
        ) : isAdmin ? (
          <>
            <button disabled={busy} onClick={() => review("approved")}
              style={{ background: "rgba(52,211,153,0.14)", border: "1px solid rgba(52,211,153,0.4)", color: "var(--pos)", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", opacity: busy ? 0.5 : 1 }}>
              ✓ Add to map
            </button>
            <button disabled={busy} onClick={() => review("rejected")}
              style={{ background: "rgba(239,68,68,0.10)", border: "1px solid rgba(239,68,68,0.35)", color: "var(--down-300)", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontSize: 11, fontWeight: 700, fontFamily: "inherit", opacity: busy ? 0.5 : 1 }}>
              ✕ Reject
            </button>
          </>
        ) : (
          <span style={{ fontSize: 10, color: "var(--ink-500)" }}>unlock admin to review</span>
        )}
        <span style={{ fontSize: 9.5, color: "var(--ink-600)", marginLeft: "auto" }}>
          found {c.discoveredAt ? new Date(c.discoveredAt).toLocaleDateString() : ""}
        </span>
      </div>
    </div>
  );
}

export default function BottleneckScout({ candidates = [], isAdmin, onReview, onTickerClick }) {
  const pending = candidates.filter(c => c.status === "pending");
  const decided = candidates.filter(c => c.status !== "pending");
  if (!candidates.length) return null;

  return (
    <div style={{ borderRadius: "var(--radius-2xl)", border: "1px solid var(--border-hairline)", background: "var(--surface-card)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", boxShadow: "var(--shadow-panel)", padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
        <div style={{ fontSize: 11, color: "var(--ink-300)", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>🔭</span> Bottleneck Scout
          {pending.length > 0 && (
            <span style={{ fontSize: 10, fontWeight: 800, color: "#fbbf24", border: "1px solid #fbbf24", borderRadius: 8, padding: "0 7px" }}>{pending.length} pending</span>
          )}
        </div>
        <div style={{ fontSize: 10, color: "var(--ink-500)" }}>
          AI-scouted candidates, identity-verified · approve to add to the map + weekly signal scans
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 12 }}>
        {pending.map(c => (
          <CandidateCard key={c.ticker} c={c} isAdmin={isAdmin} onReview={onReview} onTickerClick={onTickerClick} />
        ))}
        {decided.map(c => (
          <CandidateCard key={c.ticker} c={c} isAdmin={isAdmin} onReview={onReview} onTickerClick={onTickerClick} />
        ))}
      </div>
    </div>
  );
}
