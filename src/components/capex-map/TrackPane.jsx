import SubsectorCard from "./SubsectorCard";

export default function TrackPane({
  track,
  prices,
  stressBySub = {},
  gauges = {},
  isAdmin,
  onAddTicker,
  onRemoveTicker,
  onTickerClick,
  onAddSubsector,
  onRemoveSubsector,
  onRenameSubsector,
  onRenameSector,
  onClose,
  EditableLabel,
}) {
  return (
    <div style={{ borderRadius: 18, border: `1px solid ${track.borderColor}44`, background: "rgba(24,24,24,0.92)", padding: 22, marginTop: 8, animation: "fadeSlideIn .25s ease-out" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: track.color, boxShadow: `0 0 8px ${track.color}` }} />
          {/* Sector renaming moved here from the removed track cards */}
          <h3 style={{ fontSize: 15, fontWeight: 700, color: track.color }}>
            {isAdmin && EditableLabel && onRenameSector
              ? <EditableLabel text={track.label} isAdmin={isAdmin} onSave={onRenameSector} textStyles={{ fontSize: 15, fontWeight: 700, color: track.color }} />
              : track.label}
          </h3>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 11, color: "#475569", letterSpacing: "0.1em", textTransform: "uppercase" }}>
            {track.subsectors.length} sub-sectors · {track.subsectors.flatMap(s => s.tickers).length} tickers
          </span>
          {onClose && (
            <button onClick={onClose} title="Collapse track"
              style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, color: "#64748b", width: 24, height: 24, cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
              ×
            </button>
          )}
        </div>
      </div>
      <div className="subsector-grid" style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(track.subsectors.length + (isAdmin ? 1 : 0), 4)}, minmax(0,1fr))`, gap: 12 }}>
        {track.subsectors.map(sub => (
          <SubsectorCard
            key={sub.id}
            sub={sub}
            prices={prices}
            stress={stressBySub[`${track.id}:${sub.id}`]}
            gauges={gauges}
            isAdmin={isAdmin}
            onAddTicker={ticker => onAddTicker(track.id, sub.id, ticker)}
            onRemoveTicker={ticker => onRemoveTicker(track.id, sub.id, ticker)}
            onTickerClick={onTickerClick}
            onRemoveSubsector={() => onRemoveSubsector(track.id, sub.id)}
            onRenameSubsector={newName => onRenameSubsector(track.id, sub.id, newName)}
            EditableLabel={EditableLabel}
          />
        ))}

        {isAdmin && (
          <div
            onClick={() => onAddSubsector(track.id)}
            style={{ borderRadius: 12, border: "1px dashed rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.02)", display: "flex", alignItems: "center", justifyContent: "center", minHeight: 120, cursor: "pointer", color: "#64748b", fontSize: 12, fontWeight: 600, transition: "all .15s" }}
            onMouseEnter={e => {
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.3)";
              e.currentTarget.style.color = "#94a3b8";
            }}
            onMouseLeave={e => {
              e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
              e.currentTarget.style.color = "#64748b";
            }}
          >
            + Add Sub-Sector
          </div>
        )}
      </div>
    </div>
  );
}
