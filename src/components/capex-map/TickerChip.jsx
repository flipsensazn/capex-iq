import { memo, useState } from "react";

const TickerChip = memo(function TickerChip({ symbol, changeData, onRemove, onTickerClick }) {
  const [hovered, setHovered] = useState(false);
  const change = changeData?.change ?? changeData;
  const session = changeData?.session;
  const pos = (change ?? 0) >= 0;
  const changeColor = change === undefined ? "var(--ink-500)" : pos ? "var(--pos)" : "var(--down-300)";
  const sessionLabel = session === "POST" || session === "CLOSED" ? "AH" : session === "PRE" ? "PM" : null;

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={e => {
        e.stopPropagation();
        onTickerClick?.(symbol, e.currentTarget.getBoundingClientRect());
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        background: hovered ? "rgba(255,255,255,0.09)" : "rgba(255,255,255,0.05)",
        border: `1px solid ${hovered ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.10)"}`,
        borderRadius: 8,
        cursor: "pointer",
        transition: "background .15s, border-color .15s",
        position: "relative",
      }}
    >
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-050)" }}>{symbol}</span>
      {change !== undefined ? (
        <span style={{ fontSize: 11, fontWeight: 600, color: changeColor }}>
          {pos ? "+" : ""}
          {change}%
        </span>
      ) : (
        <span style={{ fontSize: 11, color: "var(--ink-500)" }}>…</span>
      )}
      {sessionLabel && (
        <span style={{ fontSize: 8, fontWeight: 700, color: "var(--ink-400)", background: "rgba(255,255,255,0.06)", border: "1px solid var(--border-soft)", borderRadius: 2, padding: "1px 3px", letterSpacing: "0.05em" }}>
          {sessionLabel}
        </span>
      )}
      {hovered && onRemove && (
        <button
          onClick={e => {
            e.stopPropagation();
            onRemove();
          }}
          style={{
            position: "absolute",
            top: -6,
            right: -6,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "var(--neg)",
            border: "none",
            color: "#fff",
            fontSize: 10,
            fontWeight: 700,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            lineHeight: 1,
            padding: 0,
            fontFamily: "inherit",
          }}
        >
          ×
        </button>
      )}
    </div>
  );
});

export default TickerChip;
