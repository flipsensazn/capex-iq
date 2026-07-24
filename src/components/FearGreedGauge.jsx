import { useEffect, useState } from "react";

// Compact inline CNN Fear & Greed readout for the fixed dashboard nav row
// (design "1b"): label · gradient bar with marker · score · emoji label.
// Real data from /cnn-fear-greed; renders nothing until it loads so the fixed
// nav row stays clean rather than showing a placeholder box.
export default function FearGreedGauge() {
  const [data, setData] = useState(null);

  useEffect(() => {
    fetch("/cnn-fear-greed")
      .then(res => res.json())
      .then(d => {
        if (!d.error) setData({ score: d.score, label: d.label.replace("_", " ").toUpperCase() });
      })
      .catch(() => {});
  }, []);

  if (!data) return null;
  const { score, label } = data;

  let color, emoji;
  if (score <= 24)      { color = "var(--neg)"; emoji = "😱"; }
  else if (score <= 44) { color = "#f97316"; emoji = "😰"; }
  else if (score <= 55) { color = "var(--star-400)"; emoji = "😐"; }
  else if (score <= 75) { color = "#86efac"; emoji = "😄"; }
  else                  { color = "#22c55e"; emoji = "🤑"; }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "clamp(6px,0.8vw,10px)", flexShrink: 0 }}>
      <span style={{ fontFamily: "var(--font-condensed)", fontSize: 9, fontWeight: 700, letterSpacing: "0.15em", textTransform: "uppercase", color: "var(--ink-500)", whiteSpace: "nowrap" }}>
        CNN Fear &amp; Greed
      </span>
      <div style={{ position: "relative", width: "clamp(64px,8vw,110px)", height: 5, flexShrink: 0, borderRadius: 3, background: "linear-gradient(to right,#EF4444,#F97316,#FACC15,#86EFAC,#22C55E)" }}>
        {[25, 50, 75].map(v => (
          <div key={v} style={{ position: "absolute", left: `${v}%`, top: -2, bottom: -2, width: 1, background: "rgba(0,0,0,0.4)" }} />
        ))}
        <div style={{
          position: "absolute", left: `${score}%`, top: "50%", transform: "translate(-50%,-50%)",
          width: 3, height: 11, background: "#fff", borderRadius: 2,
          boxShadow: `0 0 8px ${color}, 0 0 4px #fff`, transition: "left 1s cubic-bezier(0.4,0,0.2,1)",
        }} />
      </div>
      <span style={{ fontFamily: "var(--font-mono)", fontSize: 15, fontWeight: 800, lineHeight: 1, color, textShadow: `0 0 10px ${color}55` }}>{score}</span>
      <span style={{ fontFamily: "var(--font-condensed)", fontSize: 9.5, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color, whiteSpace: "nowrap" }}>{emoji} {label}</span>
    </div>
  );
}
