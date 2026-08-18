import { memo } from "react";

const PALETTES = {
  error: { fg: "#fecaca", bg: "rgba(127,29,29,0.4)", border: "rgba(248,113,113,0.35)" },
  warning: { fg: "#fde68a", bg: "rgba(120,53,15,0.36)", border: "rgba(245,158,11,0.4)" },
  info: { fg: "#bae6fd", bg: "rgba(7,89,133,0.3)", border: "rgba(56,189,248,0.35)" },
  success: { fg: "#bbf7d0", bg: "rgba(20,83,45,0.35)", border: "rgba(52,211,153,0.3)" },
};

const StatusBanner = memo(function StatusBanner({ notice, onDismiss }) {
  if (!notice?.message) return null;

  const palette = PALETTES[notice.type] ?? PALETTES.success;

  return (
    <div
      role={notice.type === "error" ? "alert" : "status"}
      aria-live={notice.type === "error" ? "assertive" : "polite"}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        margin: "12px 16px 0",
        padding: "10px 14px",
        borderRadius: 10,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        color: palette.fg,
        fontSize: 12,
        lineHeight: 1.45,
      }}
    >
      <span>{notice.message}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            background: "transparent",
            border: "none",
            color: palette.fg,
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            padding: 0,
          }}
          aria-label="Dismiss message"
        >
          ×
        </button>
      )}
    </div>
  );
});

export default StatusBanner;
