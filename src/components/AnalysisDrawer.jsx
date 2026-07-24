// src/components/AnalysisDrawer.jsx
//
// Full-height right-side drawer that renders the multi-agent stock analysis report.
// Opens alongside (not replacing) the CompanyPopup.

import { useEffect, useRef } from "react";

// ── SIMPLE MARKDOWN RENDERER ──────────────────────────────────────────────────
// Handles ## headers, **bold**, bullet lists, horizontal rules, line breaks.
// No external dependency needed for this document shape.
function renderMarkdown(md) {
  if (!md) return [];
  const lines  = md.split("\n");
  const blocks = [];
  let listItems = [];

  function flushList() {
    if (listItems.length) {
      blocks.push({ type: "ul", items: listItems });
      listItems = [];
    }
  }

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith("## ")) {
      flushList();
      blocks.push({ type: "h2", text: line.slice(3) });
    } else if (line.startsWith("### ")) {
      flushList();
      blocks.push({ type: "h3", text: line.slice(4) });
    } else if (/^---+$/.test(line)) {
      flushList();
      blocks.push({ type: "hr" });
    } else if (/^[-*] /.test(line)) {
      listItems.push(line.slice(2));
    } else if (line.trim() === "") {
      flushList();
      blocks.push({ type: "spacer" });
    } else {
      flushList();
      blocks.push({ type: "p", text: line });
    }
  }
  flushList();
  return blocks;
}

function inlineBold(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("**") && p.endsWith("**")
      ? <strong key={i} style={{ color: "var(--ink-100)", fontWeight: 700 }}>{p.slice(2, -2)}</strong>
      : p
  );
}

function MarkdownBody({ md }) {
  const blocks = renderMarkdown(md);
  return (
    <div style={{ fontSize: 13, color: "var(--ink-300)", lineHeight: 1.65, fontFamily: "'Inter', sans-serif" }}>
      {blocks.map((b, i) => {
        if (b.type === "h2") return (
          <h2 key={i} style={{ fontSize: 12, fontWeight: 800, color: "var(--info)", letterSpacing: "0.12em", textTransform: "uppercase", marginTop: 22, marginBottom: 6 }}>{b.text}</h2>
        );
        if (b.type === "h3") return (
          <h3 key={i} style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-300)", letterSpacing: "0.08em", textTransform: "uppercase", marginTop: 14, marginBottom: 4 }}>{b.text}</h3>
        );
        if (b.type === "hr") return (
          <hr key={i} style={{ border: "none", borderTop: "1px solid var(--border-hairline)", margin: "18px 0" }} />
        );
        if (b.type === "ul") return (
          <ul key={i} style={{ margin: "6px 0 10px 0", padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 4 }}>
            {b.items.map((item, j) => (
              <li key={j} style={{ color: "var(--ink-300)", fontSize: 13, lineHeight: 1.55 }}>{inlineBold(item)}</li>
            ))}
          </ul>
        );
        if (b.type === "p") return (
          <p key={i} style={{ margin: "3px 0 8px", color: "var(--ink-300)", fontSize: 13, lineHeight: 1.65 }}>{inlineBold(b.text)}</p>
        );
        if (b.type === "spacer") return <div key={i} style={{ height: 6 }} />;
        return null;
      })}
    </div>
  );
}

// ── SCORE GAUGE ───────────────────────────────────────────────────────────────
function ScoreBar({ label, score, color }) {
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 10, color: "var(--ink-400)", letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontSize: 11, fontWeight: 700, color }}>{score}</span>
      </div>
      <div style={{ height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${score}%`, background: `linear-gradient(90deg, ${color}88, ${color})`, borderRadius: 2, transition: "width 0.8s cubic-bezier(.4,0,.2,1)" }} />
      </div>
    </div>
  );
}

// ── PROJECTION TABLE ──────────────────────────────────────────────────────────
function ProjectionTable({ projection }) {
  if (!projection?.current) return null;
  const fmt = n => n != null ? "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
  const pct  = (target) => projection.current && target
    ? ((target - projection.current) / projection.current * 100).toFixed(1) + "%"
    : "—";

  const rows = [
    { label: "Bear Case",  value: projection.bear, color: "var(--down-300)" },
    { label: "Base Case",  value: projection.base, color: "#fbbf24" },
    { label: "Bull Case",  value: projection.bull, color: "var(--pos)" },
  ];

  return (
    <div style={{ marginTop: 8, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border-hairline)" }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", background: "rgba(255,255,255,0.03)", padding: "6px 12px", borderBottom: "1px solid var(--border-hairline)" }}>
        <span style={{ fontSize: 9, color: "var(--ink-500)", letterSpacing: "0.1em", textTransform: "uppercase" }}>Scenario</span>
        <span style={{ fontSize: 9, color: "var(--ink-500)", letterSpacing: "0.1em", textTransform: "uppercase", textAlign: "center" }}>3Y Target</span>
        <span style={{ fontSize: 9, color: "var(--ink-500)", letterSpacing: "0.1em", textTransform: "uppercase", textAlign: "right" }}>Return</span>
      </div>
      {rows.map(({ label, value, color }) => (
        <div key={label} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
          <span style={{ fontSize: 12, color: "var(--ink-200)", fontWeight: 600 }}>{label}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color, textAlign: "center" }}>{fmt(value)}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color, textAlign: "right" }}>
            {value ? (value >= projection.current ? "+" : "") + pct(value) : "—"}
          </span>
        </div>
      ))}
      <div style={{ padding: "6px 12px" }}>
        <span style={{ fontSize: 9, color: "var(--ink-600)", fontStyle: "italic" }}>{projection.assumptions}</span>
      </div>
    </div>
  );
}

// ── PILL BADGE ────────────────────────────────────────────────────────────────
function Pill({ label, color }) {
  return (
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em", color, background: color + "18", border: `1px solid ${color}44`, borderRadius: 4, padding: "2px 7px", textTransform: "uppercase", whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

// ── MAIN DRAWER ───────────────────────────────────────────────────────────────
export default function AnalysisDrawer({ ticker, analysis, onClose }) {
  const drawerRef = useRef(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  if (!analysis) return null;

  const { fundamentals: F, technical: T, macro: M, report, weightedScore, verdict, projection, disclaimer, generatedAt, fromCache } = analysis;

  const verdictColor = verdict === "BUY" ? "var(--pos)" : verdict === "HOLD" ? "#fbbf24" : "var(--down-300)";
  const agentAge = generatedAt
    ? (() => {
        const diff = Math.floor((Date.now() - generatedAt) / 60000);
        return diff < 1 ? "just now" : diff < 60 ? `${diff}m ago` : `${Math.floor(diff / 60)}h ago`;
      })()
    : null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 3500 }}
      />

      {/* Drawer */}
      <div
        ref={drawerRef}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(520px, 100vw)",
          zIndex: 3600,
          background: "rgba(13,13,17,0.98)",
          borderLeft: `1px solid ${verdictColor}28`,
          boxShadow: `-8px 0 48px rgba(0,0,0,0.85), 0 0 40px ${verdictColor}10`,
          display: "flex",
          flexDirection: "column",
          fontFamily: "'Inter', sans-serif",
          animation: "drawerSlideIn 0.22s cubic-bezier(.4,0,.2,1)",
          overflowY: "auto",
        }}
      >
        <style>{`
          @keyframes drawerSlideIn {
            from { transform: translateX(100%); opacity: 0; }
            to   { transform: translateX(0);    opacity: 1; }
          }
        `}</style>

        {/* ── HEADER ── */}
        <div style={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          background: "rgba(13,13,17,0.98)",
          borderBottom: "1px solid var(--border-hairline)",
          padding: "16px 20px 14px",
          backdropFilter: "blur(10px)",
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}>
                <span style={{ fontSize: 18, fontWeight: 800, color: "var(--ink-050)", fontFamily: "'DM Mono', monospace", letterSpacing: "0.04em" }}>{ticker}</span>
                <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.05em", color: "var(--info)" }}>DEEP ANALYSIS</span>
              </div>
              <div style={{ fontSize: 10, color: "var(--ink-600)" }}>
                {agentAge && <span>{fromCache ? "Cached" : "Generated"} {agentAge} · </span>}
                <span>3-agent AI research · Not financial advice</span>
              </div>
            </div>
            <button onClick={onClose} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid var(--border-soft)", borderRadius: 6, color: "var(--ink-400)", width: 28, height: 28, cursor: "pointer", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>×</button>
          </div>

          {/* Verdict + Composite Score */}
          <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", background: verdictColor + "10", border: `1px solid ${verdictColor}30`, borderRadius: 10 }}>
            <div style={{ textAlign: "center", minWidth: 52 }}>
              <div style={{ fontSize: 24, fontWeight: 900, color: verdictColor, letterSpacing: "0.04em", lineHeight: 1 }}>{verdict}</div>
              <div style={{ fontSize: 9, color: "var(--ink-500)", letterSpacing: "0.1em", marginTop: 2 }}>VERDICT</div>
            </div>
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span style={{ fontSize: 10, color: "var(--ink-400)", letterSpacing: "0.08em" }}>COMPOSITE SCORE</span>
                <span style={{ fontSize: 13, fontWeight: 800, color: verdictColor }}>{weightedScore}<span style={{ fontSize: 9, color: "var(--ink-500)", fontWeight: 400 }}>/100</span></span>
              </div>
              <div style={{ height: 6, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${weightedScore}%`, background: `linear-gradient(90deg, ${verdictColor}66, ${verdictColor})`, borderRadius: 3, transition: "width 1s cubic-bezier(.4,0,.2,1)" }} />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <Pill label={`F: ${F?.score ?? "—"}`} color="var(--info)" />
                <Pill label={`T: ${T?.score ?? "—"}`} color="var(--event)" />
                <Pill label={`M: ${M?.score ?? "—"}`} color="#f59e0b" />
              </div>
            </div>
          </div>
        </div>

        {/* ── BODY ── */}
        <div style={{ padding: "16px 20px 32px", display: "flex", flexDirection: "column", gap: 18 }}>

          {/* Agent score bars */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "12px 14px", background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-hairline)", borderRadius: 8 }}>
            <div style={{ fontSize: 9, color: "var(--ink-500)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4, fontWeight: 700 }}>Agent Scores · Weighted 40/30/30</div>
            {F && <ScoreBar label="Fundamentals (40%)" score={F.score} color="var(--info)" />}
            {T && <ScoreBar label="Technical (30%)"    score={T.score} color="var(--event)" />}
            {M && <ScoreBar label="Macro / Qual (30%)" score={M.score} color="#f59e0b" />}
          </div>

          {/* Quick-glance tags */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {F?.financial_health && <Pill label={`Health: ${F.financial_health}`} color="var(--info)" />}
            {F?.valuation_signal && <Pill label={`Val: ${F.valuation_signal}`}    color="var(--info)" />}
            {F?.capex_trend      && <Pill label={`CapEx: ${F.capex_trend}`}       color="var(--info)" />}
            {T?.trend            && <Pill label={T.trend}                          color="var(--event)" />}
            {T?.rsi_signal       && <Pill label={`RSI: ${T.rsi_signal}`}          color="var(--event)" />}
            {T?.macd_signal      && <Pill label={`MACD: ${T.macd_signal}`}        color="var(--event)" />}
            {M?.ai_capex_exposure && <Pill label={M.ai_capex_exposure.replace("_", " ")} color="#f59e0b" />}
            {M?.competitive_moat && <Pill label={`Moat: ${M.competitive_moat}`}  color="#f59e0b" />}
            {M?.sector_tailwind  && <Pill label={`Sector: ${M.sector_tailwind}`} color="#f59e0b" />}
          </div>

          {/* Markdown report */}
          <div>
            <MarkdownBody md={report} />
          </div>

          {/* 3-Year Projection */}
          {projection && (
            <div>
              <div style={{ fontSize: 12, fontWeight: 800, color: "var(--info)", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 8 }}>3-Year Price Projection</div>
              <ProjectionTable projection={projection} />
            </div>
          )}

          {/* CapEx note */}
          {F?.capex_note && (
            <div style={{ padding: "10px 12px", background: "rgba(96,165,250,0.05)", border: "1px solid rgba(96,165,250,0.15)", borderRadius: 7 }}>
              <div style={{ fontSize: 9, color: "var(--info)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>CapEx Strategy Note</div>
              <div style={{ fontSize: 12, color: "var(--ink-300)", lineHeight: 1.5 }}>{F.capex_note}</div>
            </div>
          )}

          {/* Supply chain risks */}
          {M?.supply_chain_risks?.length > 0 && (
            <div style={{ padding: "10px 12px", background: "rgba(245,158,11,0.05)", border: "1px solid rgba(245,158,11,0.15)", borderRadius: 7 }}>
              <div style={{ fontSize: 9, color: "#f59e0b", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Supply Chain Risks</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {M.supply_chain_risks.map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: "var(--ink-300)", display: "flex", gap: 6 }}>
                    <span style={{ color: "#f59e0b", flexShrink: 0 }}>▸</span>{r}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sector catalysts */}
          {M?.sector_catalysts?.length > 0 && (
            <div style={{ padding: "10px 12px", background: "rgba(52,211,153,0.05)", border: "1px solid rgba(52,211,153,0.15)", borderRadius: 7 }}>
              <div style={{ fontSize: 9, color: "var(--pos)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>Near-Term Catalysts</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                {M.sector_catalysts.map((c, i) => (
                  <div key={i} style={{ fontSize: 12, color: "var(--ink-300)", display: "flex", gap: 6 }}>
                    <span style={{ color: "var(--pos)", flexShrink: 0 }}>▸</span>{c}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Support / Resistance */}
          {T?.estimated_support && T?.estimated_resistance && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              <div style={{ padding: "8px 12px", background: "rgba(52,211,153,0.06)", border: "1px solid rgba(52,211,153,0.15)", borderRadius: 7, textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "var(--pos)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 3 }}>Est. Support</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--pos)" }}>${T.estimated_support}</div>
              </div>
              <div style={{ padding: "8px 12px", background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.15)", borderRadius: 7, textAlign: "center" }}>
                <div style={{ fontSize: 9, color: "var(--down-300)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 3 }}>Est. Resistance</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: "var(--down-300)" }}>${T.estimated_resistance}</div>
              </div>
            </div>
          )}

          {/* Disclaimer */}
          <div style={{ padding: "10px 12px", background: "rgba(255,255,255,0.02)", border: "1px solid var(--border-hairline)", borderRadius: 7 }}>
            <div style={{ fontSize: 10, color: "var(--ink-600)", lineHeight: 1.5 }}>⚠ {disclaimer}</div>
          </div>

        </div>
      </div>
    </>
  );
}
