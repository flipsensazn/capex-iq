import { useEffect, useState } from "react";

export default function FearGreedGauge() {
  const [cnnData, setCnnData] = useState(null);

  useEffect(() => {
    fetch("/cnn-fear-greed")
      .then(res => res.json())
      .then(data => {
        if (!data.error) {
          setCnnData({
            score: data.score,
            label: data.label.replace("_", " ").toUpperCase(),
          });
        }
      })
      .catch(() => {});
  }, []);

  if (!cnnData) {
    return (
      <div style={{
        width: 260,
        padding: "8px 12px",
        background: "#262626",
        border: "1px solid var(--border-hairline)",
        borderRadius: 12, display: "flex", alignItems: "center",
        justifyContent: "center", fontSize: 11, color: "var(--ink-600)",
        minHeight: 56,
      }}>
        Loading CNN Index…
      </div>
    );
  }

  const { score, label } = cnnData;

  let color, emoji;
  if (score <= 24)      { color = "var(--neg)"; emoji = "😱"; }
  else if (score <= 44) { color = "#f97316"; emoji = "😰"; }
  else if (score <= 55) { color = "var(--star-400)"; emoji = "😐"; }
  else if (score <= 75) { color = "#86efac"; emoji = "😄"; }
  else                  { color = "#22c55e"; emoji = "🤑"; }

  return (
    <div style={{
      padding: "8px 12px",
      background: "#262626",
      border: "1px solid var(--border-hairline)",
      borderRadius: 12,
      flexShrink: 0,
      width: 260,
      display: "flex",
      flexDirection: "column",
      gap: 6,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}>
        <div style={{ fontSize: 9, fontWeight: 700, color: "var(--ink-500)", letterSpacing: "0.15em", textTransform: "uppercase" }}>
          CNN Fear & Greed
        </div>
        <div style={{ fontSize: 18, fontWeight: 800, color, lineHeight: 1, textShadow: `0 0 10px ${color}55` }}>
          {score}
        </div>
      </div>

      <div style={{ position: "relative", height: 6, borderRadius: 3, background: "linear-gradient(to right, #ef4444, #f97316, #facc15, #86efac, #22c55e)" }}>
        {[0, 25, 50, 75, 100].map(v => (
          <div key={v} style={{
            position: "absolute",
            left: `${v}%`,
            top: -2,
            bottom: -2,
            width: 1,
            background: "rgba(0,0,0,0.4)",
            zIndex: 1,
          }} />
        ))}

        <div style={{
          position: "absolute",
          left: `${score}%`,
          top: "50%",
          transform: "translate(-50%, -50%)",
          width: 3,
          height: 12,
          background: "#fff",
          borderRadius: 2,
          boxShadow: `0 0 8px ${color}, 0 0 4px #fff`,
          zIndex: 2,
          transition: "left 1s cubic-bezier(0.4, 0, 0.2, 1)",
        }} />
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ fontSize: 9, color: "var(--ink-400)", fontWeight: 700, letterSpacing: "0.05em" }}>FEAR</span>
        <span style={{ fontSize: 10, color, fontWeight: 800, letterSpacing: "0.05em" }}>
          {emoji} {label}
        </span>
        <span style={{ fontSize: 9, color: "var(--ink-400)", fontWeight: 700, letterSpacing: "0.05em" }}>GREED</span>
      </div>
    </div>
  );
}
