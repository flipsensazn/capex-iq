import { useMemo, useState } from "react";
import {
  GRAPH_NODES, GRAPH_EDGES, LAYERS,
  computeStrength, propagate, reachable, neighbors, enrichEdges,
} from "./supplyGraphData";

// Supply-chain dependency graph. Edges run supplier → customer; nodes light
// up from live signals (transcript stress + XBRL gauges) and stress
// propagates downstream: the bottleneck owner glows red, everything that
// depends on it inherits attenuated risk. Click a node to trace its cone.

const NODE_W = 118, NODE_H = 26, GAP_Y = 10, COL_W = 158, PAD_X = 16, PAD_Y = 46;

// Node pills are data tiles, which the design system renders as SOLID fills
// with a hue-matched border — not translucent glass. Low-alpha hue tints over
// the void read as near-black and lose the heat signal, so each pill blends
// its hue into a raised base and paints the result opaque.
const TILE_BASE = [30, 38, 50];                 // raised slate, just above --void-400
const TILE_BASE_CSS = `rgb(${TILE_BASE.join(",")})`;
function tile(hex, amount) {
  const h = String(hex).replace("#", "");
  if (h.length !== 6) return TILE_BASE_CSS;
  const mix = (i) => Math.round(
    parseInt(h.slice(i * 2, i * 2 + 2), 16) * amount + TILE_BASE[i] * (1 - amount)
  );
  return `rgb(${mix(0)},${mix(1)},${mix(2)})`;
}

// Absolute color scale — used directly only when the chain has too few
// scored nodes for a meaningful distribution (see colorFor in the component).
function nodeColor(strength, risk) {
  if (strength >= 70) return "#ef4444";
  if (strength >= 40) return "#f59e0b";
  if (risk >= 50) return "#fb923c";
  if (risk >= 20) return "#fbbf24";
  return "#334155";
}

function fmtChange(v) {
  if (v == null || isNaN(v)) return null;
  const n = Number(v);
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

const DIR_LABEL = {
  constrained_supplier: "bottleneck owner",
  constrained_buyer: "input-constrained",
  both: "constrained both sides",
};

export default function SupplyGraph({
  stressData = {}, gaugesData = {}, exposureData = {}, compositeData = {}, prices = {}, onTickerClick,
  // Dataset props — default to the AI hyperscaler graph; the Musk Galaxy
  // view passes its own nodes/edges/layers.
  graphNodes = GRAPH_NODES, graphEdges = GRAPH_EDGES, layers = LAYERS,
  title = "Supply Chain Dependency Graph",
}) {
  const [selected, setSelected] = useState(null);

  // Edges upgraded with filed customer-concentration percentages where a
  // disclosed, named customer matches — these carry "(filed)" facts in the
  // UI and override curated criticality in the propagation weight.
  const edges = useMemo(() => enrichEdges(graphEdges, exposureData), [graphEdges, exposureData]);

  const { positions, width, height } = useMemo(() => {
    const byLayer = layers.map(() => []);
    for (const n of graphNodes) byLayer[n.layer].push(n);
    const maxRows = Math.max(...byLayer.map(l => l.length));
    const h = PAD_Y + maxRows * (NODE_H + GAP_Y) + 8;
    const pos = {};
    byLayer.forEach((layerNodes, li) => {
      // center shorter columns vertically
      const y0 = PAD_Y + ((maxRows - layerNodes.length) * (NODE_H + GAP_Y)) / 2;
      layerNodes.forEach((n, i) => {
        pos[n.id] = { x: PAD_X + li * COL_W, y: y0 + i * (NODE_H + GAP_Y) };
      });
    });
    return { positions: pos, width: PAD_X * 2 + layers.length * COL_W - (COL_W - NODE_W), height: h };
  }, [graphNodes, layers]);

  const strength = useMemo(() => computeStrength(graphNodes, stressData, gaugesData), [graphNodes, stressData, gaugesData]);
  const risk = useMemo(() => propagate(graphNodes, edges, strength), [graphNodes, edges, strength]);

  // Relative color scale. When the whole chain runs hot (every transcript
  // says "sold out"), absolute thresholds paint everything red and the graph
  // stops discriminating. Color by each node's heat RELATIVE to this chain's
  // distribution instead, with absolute floors so a cool chain never shows
  // fake red. Falls back to the absolute scale when too few nodes are scored.
  const colorFor = useMemo(() => {
    const heats = graphNodes
      .map(n => Math.max(strength[n.id] ?? 0, risk[n.id]?.score ?? 0))
      .filter(h => h > 0)
      .sort((a, b) => a - b);
    if (heats.length < 8) return nodeColor;
    const pct = p => heats[Math.min(heats.length - 1, Math.floor(p * heats.length))];
    const p85 = pct(0.85), p60 = pct(0.60), p35 = pct(0.35);
    return (s, r) => {
      const heat = Math.max(s, r);
      const own = s >= r; // own bottleneck vs inherited risk → warm vs yellow-orange
      if (heat >= Math.max(p85, 60)) return own ? "#ef4444" : "#fb923c";
      if (heat >= Math.max(p60, 40)) return own ? "#f59e0b" : "#fbbf24";
      if (heat >= Math.max(p35, 15)) return "#60a5fa";
      return "#334155";
    };
  }, [graphNodes, strength, risk]);

  const highlight = useMemo(() => {
    if (!selected) return null;
    return {
      down: reachable(edges, selected, "down"),
      up: reachable(edges, selected, "up"),
    };
  }, [edges, selected]);

  const topBottlenecks = useMemo(() =>
    graphNodes
      .map(n => ({ id: n.id, s: strength[n.id] ?? 0 }))
      .filter(x => x.s >= 40)
      .sort((a, b) => b.s - a.s)
      .slice(0, 6),
    [graphNodes, strength]);

  const selNode = graphNodes.find(n => n.id === selected);
  const selNbrs = selected ? neighbors(edges, selected) : null;
  const selExposure = selected ? exposureData[selected] : null;

  function edgeState(e) {
    if (!selected) return "idle";
    if (e.from === selected || e.to === selected) return "active";
    const onDownPath = highlight.down.has(e.to) && (highlight.down.has(e.from) || e.from === selected);
    const onUpPath = highlight.up.has(e.from) && (highlight.up.has(e.to) || e.to === selected);
    if (onDownPath) return "down";
    if (onUpPath) return "up";
    return "dim";
  }

  function nodeOpacity(id) {
    if (!selected) return 1;
    if (id === selected || highlight.down.has(id) || highlight.up.has(id)) return 1;
    return 0.22;
  }

  return (
    <div style={{ borderRadius: "var(--radius-2xl)", border: "1px solid var(--border-hairline)", background: "var(--surface-card)", backdropFilter: "var(--glass-blur)", WebkitBackdropFilter: "var(--glass-blur)", boxShadow: "var(--shadow-panel)", padding: 18, marginTop: 8 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: "var(--ink-300)", letterSpacing: "0.15em", textTransform: "uppercase", fontWeight: 700, display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 14 }}>🕸</span> {title}
        </div>
        <div style={{ fontSize: 10, color: "var(--ink-500)" }}>
          supplier → customer · click a node to trace its cone · {graphNodes.length} nodes / {edges.length} edges
          {edges.some(e => e.exposurePct != null) && ` · ${edges.filter(e => e.exposurePct != null).length} with filed exposure`}
        </div>
      </div>

      {topBottlenecks.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10, alignItems: "center" }}>
          <span style={{ fontSize: 10, color: "var(--ink-400)", fontWeight: 700, letterSpacing: "0.1em" }}>RADIATING:</span>
          {topBottlenecks.map(({ id, s }) => {
            const c = colorFor(s, 0);
            return (
              <button key={id} onClick={() => setSelected(p => p === id ? null : id)}
                style={{ background: tile(c, 0.30), border: `1px solid ${c}`, color: c, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 3, cursor: "pointer", fontFamily: "inherit", boxShadow: selected === id ? `0 0 6px ${c}88` : "none" }}>
                {id} {s.toFixed(0)}
              </button>
            );
          })}
        </div>
      )}

      <div style={{ overflowX: "auto", paddingBottom: 4 }}>
        <svg viewBox={`0 0 ${width} ${height}`} style={{ minWidth: width, width: "100%", display: "block" }}>
          {/* layer headers */}
          {layers.map((label, i) => (
            <text key={label} x={PAD_X + i * COL_W + NODE_W / 2} y={18} textAnchor="middle"
              style={{ fill: "var(--ink-500)", fontSize: 9.5, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
              {label}
            </text>
          ))}

          {/* edges under nodes */}
          {edges.map((e, i) => {
            const a = positions[e.from], b = positions[e.to];
            if (!a || !b) return null;
            const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2;
            const x2 = b.x, y2 = b.y + NODE_H / 2;
            const mx = (x1 + x2) / 2;
            const state = edgeState(e);
            const filed = e.exposurePct != null;
            const stroke =
              state === "active" ? "var(--ink-100)" :
              state === "down" ? "var(--neg)" :
              state === "up" ? "var(--info)" :
              filed ? "rgba(125,211,252,0.22)" : "rgba(148,163,184,0.10)";
            const w = state === "idle" ? (filed ? 1.1 : 0.8) : state === "dim" ? 0.4 : e.criticality * 0.7 + 0.6;
            return (
              <path key={i} d={`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`}
                fill="none" stroke={state === "dim" ? "rgba(148,163,184,0.04)" : stroke} strokeWidth={w}>
                <title>{`${e.from} → ${e.to}: ${e.what} (criticality ${e.criticality})` +
                  (filed ? `\nFILED: ${e.exposurePct}% of ${e.from} revenue (${e.exposurePeriod || e.exposureForm})` : "")}</title>
              </path>
            );
          })}

          {/* nodes */}
          {graphNodes.map(n => {
            const p = positions[n.id];
            const s = strength[n.id] ?? 0;
            const r = risk[n.id]?.score ?? 0;
            const c = colorFor(s, r);
            const isBottleneck = s >= 40;
            const isSel = selected === n.id;
            const chg = n.type !== "external" ? fmtChange(prices[n.id]?.change ?? prices[n.id]) : null;
            return (
              <g key={n.id} opacity={nodeOpacity(n.id)} style={{ cursor: "pointer" }}
                onClick={() => setSelected(prev => prev === n.id ? null : n.id)}>
                <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={6}
                  fill={isBottleneck ? tile(c, 0.42) : r >= 20 ? tile(c, 0.28) : TILE_BASE_CSS}
                  stroke={isSel ? "var(--ink-100)" : isBottleneck ? c : r >= 20 ? c + "99" : "rgba(255,255,255,0.18)"}
                  strokeWidth={isSel ? 1.6 : 1}
                  strokeDasharray={!isBottleneck && r >= 20 ? "3,2" : "none"} />
                <text x={p.x + 8} y={p.y + 17} style={{ fill: n.type === "external" ? "var(--ink-300)" : "var(--ink-100)", fontSize: 10.5, fontWeight: 700 }}>
                  {n.id.length > 12 ? n.id.slice(0, 12) : n.id}
                </text>
                {(isBottleneck || r >= 20) && (
                  <text x={p.x + NODE_W - 8} y={p.y + 17} textAnchor="end" style={{ fill: c, fontSize: 9.5, fontWeight: 700 }}>
                    {isBottleneck ? `●${s.toFixed(0)}` : `⚠${r.toFixed(0)}`}
                  </text>
                )}
                {!isBottleneck && r < 20 && chg && (
                  <text x={p.x + NODE_W - 8} y={p.y + 17} textAnchor="end"
                    style={{ fill: chg.startsWith("+") ? "var(--pos)" : "var(--down-300)", fontSize: 9 }}>
                    {chg}
                  </text>
                )}
                <title>{`${n.label}${n.note ? ` — ${n.note}` : ""}\nbottleneck strength ${s.toFixed(0)} · inherited risk ${r.toFixed(0)}`}</title>
              </g>
            );
          })}
        </svg>
      </div>

      {/* legend */}
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 9.5, color: "var(--ink-400)", marginTop: 6 }}>
        <span><span style={{ color: "var(--neg)" }}>●</span> bottleneck (radiates downstream)</span>
        <span><span style={{ color: "#fbbf24" }}>⚠</span> inherited supply risk</span>
        <span><span style={{ color: "var(--neg)" }}>━</span> downstream of selection</span>
        <span><span style={{ color: "var(--info)" }}>━</span> upstream suppliers</span>
        <span><span style={{ color: "#7dd3fc" }}>━</span> filed revenue exposure (10-K/10-Q)</span>
        <span style={{ color: "var(--ink-500)" }}>· colors scale to this chain's heat distribution — red = hottest relative to peers</span>
      </div>

      {/* detail panel */}
      {selNode && (
        <div style={{ marginTop: 12, borderRadius: 12, border: "1px solid var(--border-soft)", background: "rgba(0,0,0,0.25)", padding: 14, animation: "fadeSlideIn .2s ease-out" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span
              onClick={e => selNode.type !== "external" && onTickerClick?.(selNode.id, e.currentTarget.getBoundingClientRect())}
              style={{ fontSize: 14, fontWeight: 800, color: "var(--ink-100)", cursor: selNode.type !== "external" ? "pointer" : "default" }}>
              {selNode.label}
            </span>
            <span style={{ fontSize: 10, color: "var(--ink-400)", textTransform: "uppercase", letterSpacing: "0.1em" }}>{layers[selNode.layer]}</span>
            {(strength[selected] ?? 0) >= 40 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: colorFor(strength[selected], 0), border: `1px solid ${colorFor(strength[selected], 0)}`, background: colorFor(strength[selected], 0) + "1c", padding: "1px 7px", borderRadius: 3 }}>
                BOTTLENECK {strength[selected].toFixed(0)}
              </span>
            )}
            {(risk[selected]?.score ?? 0) >= 20 && (
              <span style={{ fontSize: 10, fontWeight: 700, color: "#fbbf24", border: "1px solid #fbbf2488", background: "#fbbf241a", padding: "1px 7px", borderRadius: 3 }}>
                SUPPLY RISK {risk[selected].score.toFixed(0)}
              </span>
            )}
            <button onClick={() => setSelected(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--ink-400)", fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>×</button>
          </div>

          {/* intrinsic signals */}
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "var(--ink-300)", lineHeight: 1.5 }}>
            {selNode.note && <div>{selNode.note}</div>}
            {compositeData[selected]?.score != null && (
              <div>
                ⬢ Composite Bottleneck Score: <span style={{ color: "var(--ink-100)", fontWeight: 700 }}>{compositeData[selected].score.toFixed(0)}</span>
                {compositeData[selected].delta != null && (
                  <span style={{ color: compositeData[selected].delta > 0 ? "var(--neg)" : "var(--pos)" }}>
                    {" "}({compositeData[selected].delta > 0 ? "+" : ""}{compositeData[selected].delta.toFixed(0)} this week)
                  </span>
                )}
              </div>
            )}
            {stressData[selected]?.latest && (
              <div>
                Transcript: <span style={{ color: "var(--ink-100)", fontWeight: 700 }}>{stressData[selected].latest.stressScore?.toFixed(0)}</span>
                {stressData[selected].latest.direction && <> · {DIR_LABEL[stressData[selected].latest.direction] ?? stressData[selected].latest.direction}</>}
                {stressData[selected].latest.summary && <> — {stressData[selected].latest.summary}</>}
              </div>
            )}
            {gaugesData[selected] && (gaugesData[selected].orderGap != null || gaugesData[selected].inventoryDays != null) && (
              <div style={{ color: "#7dd3fc" }}>
                XBRL:
                {gaugesData[selected].rpoYoy != null && <> backlog {gaugesData[selected].rpoYoy >= 0 ? "+" : ""}{gaugesData[selected].rpoYoy.toFixed(0)}% YoY</>}
                {gaugesData[selected].orderGap != null && <> · order gap {gaugesData[selected].orderGap >= 0 ? "+" : ""}{gaugesData[selected].orderGap.toFixed(0)}pp</>}
                {gaugesData[selected].inventoryDays != null && <> · inv days {gaugesData[selected].inventoryDays.toFixed(0)}</>}
              </div>
            )}
            {selExposure?.customers?.length > 0 && (
              <div style={{ color: "#7dd3fc" }}>
                Filed concentration:{" "}
                {selExposure.customers.filter(c => c.basis === "revenue").slice(0, 5).map((c, i) => (
                  <span key={i} title={c.quote || ""}>
                    {i > 0 && " · "}
                    {c.ticker ? (
                      <span onClick={() => setSelected(c.ticker)} style={{ fontWeight: 700, cursor: "pointer" }}>{c.ticker}</span>
                    ) : (
                      <span style={{ color: "var(--ink-300)" }}>{c.label}</span>
                    )}
                    {" "}{c.pct.toFixed(0)}% of rev{c.period ? ` (${c.period})` : ""}
                  </span>
                ))}
              </div>
            )}
            {risk[selected]?.contributors?.length > 0 && (
              <div>
                At risk via:{" "}
                {risk[selected].contributors.slice(0, 4).map((c, i) => (
                  <span key={c.source}>
                    {i > 0 && " · "}
                    <span onClick={() => setSelected(c.source)} style={{ color: "#fbbf24", cursor: "pointer", fontWeight: 700 }}>{c.source}</span>
                    <span style={{ color: "var(--ink-400)" }}> ({c.score.toFixed(0)} via {c.what}{c.hops > 1 ? `, ${c.hops} hops` : ""})</span>
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* neighbors */}
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap", marginTop: 10 }}>
            {[["Supplied by", selNbrs.suppliers, e => e.from], ["Supplies", selNbrs.customers, e => e.to]].map(([title, list, pick]) => (
              <div key={title} style={{ minWidth: 200, flex: 1 }}>
                <div style={{ fontSize: 9.5, color: "var(--ink-500)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 4 }}>{title} ({list.length})</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {list.sort((a, b) => (b.exposurePct ?? 0) - (a.exposurePct ?? 0) || b.criticality - a.criticality).map((e, i) => {
                    const other = pick(e);
                    const oc = colorFor(strength[other] ?? 0, risk[other]?.score ?? 0);
                    return (
                      <div key={i} style={{ fontSize: 10.5, color: "var(--ink-300)" }}>
                        <span onClick={() => setSelected(other)} style={{ color: oc === "var(--ink-600)" ? "var(--ink-200)" : oc, fontWeight: 700, cursor: "pointer" }}>{other}</span>
                        <span style={{ color: "var(--ink-400)" }}> — {e.what}</span>
                        {e.exposurePct != null && (
                          <span title={`${e.exposureQuote || ""}\n(${e.exposureForm}${e.exposurePeriod ? `, ${e.exposurePeriod}` : ""})`}
                            style={{ color: "#7dd3fc", fontWeight: 700 }}> {e.exposurePct.toFixed(0)}% of {e.from} rev (filed)</span>
                        )}
                        {e.exposurePct == null && e.criticality === 3 && <span style={{ color: "var(--neg)" }}> ●●●</span>}
                        {e.exposurePct == null && e.criticality === 2 && <span style={{ color: "#f59e0b" }}> ●●</span>}
                      </div>
                    );
                  })}
                  {!list.length && <div style={{ fontSize: 10.5, color: "var(--ink-500)" }}>none mapped</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
