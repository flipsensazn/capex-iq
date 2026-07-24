import { useState } from "react";
import TickerChip from "./TickerChip";
import StressBadge, { StressDetail, GaugeChip, CompositeChip, hasGaugeData, compositeSummary } from "./StressBadge";

export default function SubsectorCard({
  sub,
  prices,
  stress,
  gauges = {},
  composite = {},
  isAdmin,
  onAddTicker,
  onRemoveTicker,
  onTickerClick,
  onRemoveSubsector,
  onRenameSubsector,
  EditableLabel,
}) {
  const [open, setOpen] = useState(false);
  const [stressOpen, setStressOpen] = useState(false);
  const [addingTicker, setAddingTicker] = useState(false);
  const [newTicker, setNewTicker] = useState("");
  // Card styling is purely data-driven: live transcript/XBRL stress only
  const stressScore = stress?.score ?? 0;
  const isBottleneck = stressScore >= 70;
  const isHot = stressScore >= 40 && stressScore < 70;

  function handleAdd() {
    if (newTicker.trim()) {
      onAddTicker(newTicker.trim());
      setNewTicker("");
      setAddingTicker(false);
    }
  }

  return (
    <div
      style={{
        borderRadius: 12,
        border: `1px solid ${isBottleneck ? "rgba(239,68,68,.35)" : isHot ? "rgba(245,158,11,.25)" : "rgba(255,255,255,0.07)"}`,
        background: isBottleneck ? "rgba(239,68,68,0.06)" : "rgba(255,255,255,0.03)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <EditableLabel
          text={sub.label}
          isAdmin={isAdmin}
          onSave={onRenameSubsector}
          style={{ flex: 1 }}
          textStyles={{ fontSize: 12, fontWeight: 600, color: "var(--ink-200)", lineHeight: 1.4 }}
        />
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <CompositeChip tickers={sub.tickers} composite={composite} open={stressOpen} onClick={() => setStressOpen(v => !v)} />
          <StressBadge stress={stress} open={stressOpen} onClick={() => setStressOpen(v => !v)} />
          <GaugeChip tickers={sub.tickers} gauges={gauges} open={stressOpen} onClick={() => setStressOpen(v => !v)} />
          {isAdmin && (
            <button
              onClick={e => {
                e.stopPropagation();
                onRemoveSubsector();
              }}
              title="Remove Sub-sector"
              style={{ background: "none", border: "none", color: "var(--neg)", fontSize: 14, cursor: "pointer", padding: "0 2px", lineHeight: 1, fontFamily: "inherit" }}
            >
              ×
            </button>
          )}
        </div>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {sub.tickers.map(ticker => (
          <TickerChip
            key={ticker}
            symbol={ticker}
            changeData={prices[ticker]}
            onRemove={isAdmin ? () => onRemoveTicker(ticker) : undefined}
            onTickerClick={onTickerClick}
          />
        ))}
      </div>
      {sub.materials?.length > 0 && (
        <div>
          <button onClick={() => setOpen(v => !v)} style={{ background: "none", border: "none", color: "var(--ink-400)", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, padding: 0, fontFamily: "inherit" }}>
            <span style={{ display: "inline-block", transition: "transform .2s", transform: open ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
            Raw Materials ({sub.materials.length})
          </button>
          {open && (
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6 }}>
              {sub.materials.map((material, i) =>
                typeof material === "string" ? (
                  <span key={i} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, background: "rgba(255,255,255,0.04)", border: "1px solid var(--border-hairline)", color: "var(--ink-300)" }}>
                    {material}
                  </span>
                ) : (
                  <span key={i} title={material.constraint} style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, background: material.color + "15", border: `1px solid ${material.color}55`, color: material.color, fontWeight: 600 }}>
                    ⚠ {material.name}
                  </span>
                ),
              )}
            </div>
          )}
        </div>
      )}

      {(stress || hasGaugeData(sub.tickers, gauges) || compositeSummary(sub.tickers, composite)) && (
        <div>
          <button onClick={() => setStressOpen(v => !v)} style={{ background: "none", border: "none", color: "var(--ink-400)", fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, padding: 0, fontFamily: "inherit" }}>
            <span style={{ display: "inline-block", transition: "transform .2s", transform: stressOpen ? "rotate(90deg)" : "rotate(0deg)" }}>▶</span>
            Stress Signals
          </button>
          {stressOpen && <StressDetail stress={stress} tickers={sub.tickers} gauges={gauges} composite={composite} onTickerClick={onTickerClick} />}
        </div>
      )}

      <div style={{ marginTop: 2 }}>
        {isAdmin &&
          (!addingTicker ? (
            <button
              onClick={() => setAddingTicker(true)}
              style={{ background: "none", border: "1px dashed rgba(255,255,255,0.1)", borderRadius: 6, color: "var(--ink-600)", fontSize: 11, padding: "4px 10px", cursor: "pointer", width: "100%", fontFamily: "inherit", transition: "all .15s" }}
              onMouseEnter={e => {
                e.currentTarget.style.borderColor = "rgba(255,255,255,0.25)";
                e.currentTarget.style.color = "var(--ink-400)";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = "rgba(255,255,255,0.1)";
                e.currentTarget.style.color = "var(--ink-600)";
              }}
            >
              + add ticker
            </button>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <input
                autoFocus
                value={newTicker}
                onChange={e => setNewTicker(e.target.value.toUpperCase())}
                onKeyDown={e => {
                  if (e.key === "Enter") handleAdd();
                  if (e.key === "Escape") {
                    setAddingTicker(false);
                    setNewTicker("");
                  }
                }}
                placeholder="e.g. NVDA"
                style={{ flex: 1, background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.15)", borderRadius: 6, padding: "5px 8px", color: "var(--ink-100)", fontSize: 12, fontFamily: "inherit", outline: "none" }}
              />
              <button onClick={handleAdd} style={{ background: "rgba(96,165,250,0.15)", border: "1px solid rgba(96,165,250,0.3)", color: "var(--info)", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
                ✓
              </button>
              <button onClick={() => {
                setAddingTicker(false);
                setNewTicker("");
              }} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid var(--border-hairline)", color: "var(--ink-400)", borderRadius: 6, padding: "5px 10px", cursor: "pointer", fontSize: 11, fontFamily: "inherit" }}>
                ✕
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}
