// CAPEX-IQ design-system primitives.
//
// Ported from the Claude Design project's component library
// (window.CAPEXIQDesignSystem_bb10bc) into plain React. Styling follows the
// system's documented specs: chips 3px radius over a tint of their own hue,
// buttons 6px, cells 8px, glass panels 18px with blur(12px); neon glow marks
// "live/active" only, never decoration.
//
// Everything reads from src/styles/tokens.css, so colours are never hard-coded
// here beyond the semantic ramps the components need to interpolate.

import { useState } from "react";

// ── Brand ────────────────────────────────────────────────
export function Wordmark({ size = 16, monochrome = false, style }) {
  return (
    <span style={{
      fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: size,
      letterSpacing: "var(--ls-brand)", lineHeight: 1, whiteSpace: "nowrap",
      color: monochrome ? "var(--ink-400)" : "var(--ink-050)", ...style,
    }}>
      CAPEX<span style={{ color: monochrome ? "var(--ink-400)" : "var(--accent)" }}>-IQ</span>
    </span>
  );
}

// ── Core ─────────────────────────────────────────────────
const BTN_SIZES = {
  sm: { fontSize: 12, padding: "7px 15px" },
  md: { fontSize: 13, padding: "9px 18px" },
  lg: { fontSize: 14, padding: "12px 22px" },
};
const BTN_VARIANTS = {
  primary:       { background: "var(--accent)", color: "var(--on-accent)", borderColor: "var(--accent)" },
  ghost:         { background: "transparent", color: "var(--ink-100)", borderColor: "var(--border-soft)" },
  "accent-quiet":{ background: "var(--accent-quiet)", color: "var(--accent)", borderColor: "var(--border-cyan)" },
  danger:        { background: "rgba(239,68,68,0.12)", color: "var(--neg)", borderColor: "rgba(239,68,68,0.45)" },
};

export function Button({
  variant = "ghost", size = "sm", glow = false, as = "button",
  children, style, disabled, ...rest
}) {
  const [hover, setHover] = useState(false);
  const Tag = as;
  return (
    <Tag
      {...rest}
      disabled={Tag === "button" ? disabled : undefined}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6,
        borderRadius: "var(--radius-sm)", fontFamily: "var(--font-ui)", fontWeight: 700,
        border: "1px solid transparent", cursor: disabled ? "default" : "pointer",
        textDecoration: "none", whiteSpace: "nowrap",
        transition: "transform var(--dur-med) var(--ease-out), opacity var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out)",
        ...BTN_SIZES[size], ...BTN_VARIANTS[variant],
        boxShadow: glow ? (hover ? "var(--glow-cyan)" : "var(--glow-cyan-soft)") : undefined,
        transform: hover && !disabled ? "translateY(-1px)" : "none",
        opacity: disabled ? 0.45 : hover ? 0.92 : 1,
        ...style,
      }}
    >
      {children}
    </Tag>
  );
}

const CHIP_TONES = {
  pos:     "var(--pos)",
  neg:     "var(--neg)",
  warn:    "var(--warn)",
  info:    "var(--info)",
  event:   "var(--event)",
  accent:  "var(--accent)",
  neutral: "var(--ink-300)",
};
// Chips paint their own hue at full strength on a low-alpha tint of the same
// hue. `color` accepts a raw hex for data-driven hues (stress ramps etc.).
export function Chip({ tone = "neutral", color, active = false, size = "md", children, style, title }) {
  const hue = color || CHIP_TONES[tone] || CHIP_TONES.neutral;
  const tint = color
    ? `${color}22`
    : tone === "neutral" ? "rgba(255,255,255,0.05)" : `color-mix(in srgb, ${hue} 13%, transparent)`;
  return (
    <span title={title} style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      borderRadius: "var(--radius-chip)", padding: size === "sm" ? "1px 6px" : "2px 7px",
      fontFamily: "var(--font-condensed)", fontWeight: 700,
      fontSize: size === "sm" ? 9.5 : 10, letterSpacing: "var(--ls-wide)",
      textTransform: "uppercase", lineHeight: 1.5, whiteSpace: "nowrap",
      color: hue, border: `1px solid ${hue}`, background: tint,
      boxShadow: active ? `0 0 6px ${color ? `${color}66` : hue}` : undefined,
      ...style,
    }}>
      {children}
    </span>
  );
}

// The signature glass module surface, with the standard eyebrow/note header.
export function Panel({ eyebrow, icon, note, actions, children, padding = "18px 20px", style }) {
  return (
    <div style={{
      background: "var(--surface-card)", backdropFilter: "var(--glass-blur)",
      WebkitBackdropFilter: "var(--glass-blur)", border: "1px solid var(--border-hairline)",
      borderRadius: "var(--radius-2xl)", boxShadow: "var(--shadow-panel)", padding,
      ...style,
    }}>
      {(eyebrow || note || actions) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          gap: 12, marginBottom: 14, flexWrap: "wrap",
        }}>
          {eyebrow && (
            <span style={{
              fontFamily: "var(--font-condensed)", fontSize: 9, letterSpacing: "var(--ls-eyebrow)",
              textTransform: "uppercase", color: "var(--text-muted)",
              display: "inline-flex", alignItems: "center", gap: 6,
            }}>
              {icon && <span style={{ fontSize: 12 }}>{icon}</span>}{eyebrow}
            </span>
          )}
          {(note || actions) && (
            <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
              {note && <span style={{ fontSize: 9.5, color: "var(--text-faint)", textAlign: "right" }}>{note}</span>}
              {actions}
            </span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

export function Input({ invalid = false, style, ...rest }) {
  const [focus, setFocus] = useState(false);
  return (
    <input
      {...rest}
      onFocus={e => { setFocus(true); rest.onFocus?.(e); }}
      onBlur={e => { setFocus(false); rest.onBlur?.(e); }}
      style={{
        background: "var(--surface-inset)",
        border: `1px solid ${invalid ? "var(--neg)" : focus ? "var(--accent)" : "var(--border-soft)"}`,
        borderRadius: "var(--radius-sm)", padding: "9px 12px", color: "var(--ink-100)",
        fontFamily: "var(--font-ui)", fontSize: 13, outline: "none",
        boxShadow: focus ? "var(--ring-accent)" : undefined,
        transition: "border-color var(--dur-med) var(--ease-out), box-shadow var(--dur-med) var(--ease-out)",
        ...style,
      }}
    />
  );
}

export function SegmentedToggle({ options = [], value, onChange, style }) {
  return (
    <div style={{
      display: "inline-flex", gap: 2, padding: 2, borderRadius: "var(--radius-sm)",
      background: "var(--surface-inset)", border: "1px solid var(--border-hairline)", ...style,
    }}>
      {options.map(opt => {
        const val = typeof opt === "string" ? opt : opt.value;
        const label = typeof opt === "string" ? opt : opt.label;
        const on = val === value;
        return (
          <button key={val} onClick={() => onChange?.(val)} style={{
            border: "none", cursor: "pointer", borderRadius: 4, padding: "3px 9px",
            fontFamily: "var(--font-ui)", fontSize: 10, fontWeight: 700,
            letterSpacing: "var(--ls-wide)",
            background: on ? "var(--accent-quiet)" : "transparent",
            color: on ? "var(--accent)" : "var(--text-muted)",
            transition: "background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out)",
          }}>{label}</button>
        );
      })}
    </div>
  );
}

const BANNER_TONES = {
  success: ["var(--pos)", "rgba(52,211,153,0.10)"],
  error:   ["var(--neg)", "rgba(239,68,68,0.10)"],
  warn:    ["var(--warn)", "rgba(245,158,11,0.10)"],
  info:    ["var(--info)", "rgba(96,165,250,0.10)"],
};
export function StatusBanner({ type = "info", message, onDismiss, style }) {
  const [hue, tint] = BANNER_TONES[type] || BANNER_TONES.info;
  return (
    <div role="status" style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
      background: tint, border: `1px solid ${hue}55`, borderRadius: "var(--radius-md)",
      padding: "10px 14px", animation: "fadeSlideIn .18s var(--ease-out)", ...style,
    }}>
      <span style={{ fontSize: 12, color: hue, fontWeight: 600 }}>{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss" style={{
          background: "none", border: "none", color: hue, cursor: "pointer",
          fontSize: 15, lineHeight: 1, padding: 0, opacity: 0.7,
        }}>×</button>
      )}
    </div>
  );
}

// ── Data ─────────────────────────────────────────────────
export function Sparkline({ data = [], color = "var(--accent)", width = 64, height = 16, fill = false, style }) {
  const pts = (data || []).filter(v => v != null && isFinite(v));
  if (pts.length < 2) return <span style={{ display: "inline-block", width, height, ...style }} />;
  const min = Math.min(...pts), max = Math.max(...pts), rng = (max - min) || 1;
  const coords = pts.map((v, i) => [
    (i / (pts.length - 1)) * width,
    height - ((v - min) / rng) * (height - 2) - 1,
  ]);
  const line = coords.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ display: "block", ...style }} aria-hidden="true">
      {fill && <path d={`${line}L${width},${height}L0,${height}Z`} fill={color} opacity="0.14" />}
      <path d={line} fill="none" stroke={color} strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

// Top-bar index/crypto tile.
export function MarketPill({ label, labelColor, price, change, session, spark, style }) {
  const up = (change ?? 0) >= 0;
  const hue = up ? "var(--pos)" : "var(--neg)";
  return (
    <div style={{
      background: "var(--surface-inset)", border: "1px solid var(--border-hairline)",
      borderRadius: "var(--radius-md)", padding: "6px 10px", minWidth: 0, ...style,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span style={{
          fontFamily: "var(--font-condensed)", fontWeight: 700, fontSize: 10,
          letterSpacing: "var(--ls-wide)", color: labelColor || "var(--ink-200)",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>{label}</span>
        {session && session !== "REGULAR" && (
          <span style={{ fontSize: 7.5, fontWeight: 700, color: "var(--warn)", letterSpacing: "0.1em" }}>
            {session === "PRE" ? "PM" : session === "POST" ? "AH" : ""}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 2 }}>
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, fontWeight: 500, color: "var(--ink-050)" }}>
          {price != null ? Number(price).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—"}
        </span>
        {change != null && (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: hue }}>
            {up ? "+" : ""}{Number(change).toFixed(2)}%
          </span>
        )}
        {spark?.length > 1 && <Sparkline data={spark} color={hue} width={38} height={12} style={{ marginLeft: "auto" }} />}
      </div>
    </div>
  );
}

// Heat-map cell. Fill intensity tracks magnitude; glow marks 52w extremes.
export function TickerCell({ ticker, change, state, session, earnings, onClick, style }) {
  const [hover, setHover] = useState(false);
  const v = change;
  const has = v != null && isFinite(v);
  const mag = has ? Math.min(Math.abs(v) / 5, 1) : 0;
  const bg = !has
    ? "var(--void-400)"
    : v >= 0
      ? `color-mix(in srgb, var(--up-900) ${20 + mag * 80}%, var(--void-400))`
      : `color-mix(in srgb, var(--down-900) ${20 + mag * 80}%, var(--void-400))`;
  const hue = !has ? "var(--ink-500)" : v >= 0 ? "var(--up-100)" : "var(--down-100)";
  const extreme = state === "high" || state === "low";
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      title={`${ticker}${has ? ` ${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : ""}`}
      style={{
        position: "relative", minWidth: 64, padding: "8px 10px", cursor: "pointer",
        borderRadius: "var(--radius-chip)", background: bg,
        border: `1px solid ${extreme ? (state === "high" ? "var(--pos)" : "var(--neg)") : "var(--border-hairline)"}`,
        boxShadow: extreme ? (state === "high" ? "var(--glow-pos)" : "var(--glow-neg)") : undefined,
        transform: hover ? "scale(1.06)" : "none",
        filter: hover ? "brightness(1.4)" : undefined,
        transition: "transform var(--dur-fast) var(--ease-out), filter var(--dur-fast) var(--ease-out)",
        fontFamily: "var(--font-condensed)", textAlign: "left", ...style,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ fontWeight: 700, fontSize: 11, color: "var(--ink-050)" }}>{ticker}</span>
        {earnings && <span style={{ fontSize: 8, color: "var(--event)", fontWeight: 700 }}>E</span>}
        {state === "high" && <span style={{ fontSize: 7.5, color: "var(--pos)" }}>▲</span>}
        {state === "low" && <span style={{ fontSize: 7.5, color: "var(--neg)" }}>▼</span>}
      </div>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: hue, marginTop: 1 }}>
        {has ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "—"}
        {session && session !== "REGULAR" && (
          <span style={{ fontSize: 7, color: "var(--warn)", marginLeft: 3 }}>
            {session === "PRE" ? "PM" : session === "POST" ? "AH" : ""}
          </span>
        )}
      </div>
    </button>
  );
}

export function MetricStat({ label, value, delta, hint, color, style }) {
  return (
    <div style={style}>
      <div style={{
        fontFamily: "var(--font-condensed)", fontSize: 9, letterSpacing: "var(--ls-eyebrow)",
        textTransform: "uppercase", color: "var(--text-muted)",
      }}>{label}</div>
      <div style={{
        fontFamily: "var(--font-mono)", fontWeight: 800, fontSize: 18,
        color: color || "var(--ink-050)", marginTop: 3,
      }}>{value}</div>
      {delta != null && (
        <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, marginTop: 2, color: delta >= 0 ? "var(--pos)" : "var(--neg)" }}>
          {delta >= 0 ? "+" : ""}{delta}
        </div>
      )}
      {hint && <div style={{ fontSize: 9.5, color: "var(--text-faint)", marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

// Horizontal gauge with an eased marker (Fear & Greed and friends).
export function Gauge({ label, value, markerColor, leftLabel, rightLabel, status, style }) {
  const pct = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div style={{
      background: "var(--surface-card)", backdropFilter: "var(--glass-blur)",
      WebkitBackdropFilter: "var(--glass-blur)", border: "1px solid var(--border-hairline)",
      borderRadius: "var(--radius-lg)", padding: "8px 12px", ...style,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <span style={{
          fontFamily: "var(--font-condensed)", fontSize: 9, letterSpacing: "var(--ls-eyebrow)",
          textTransform: "uppercase", color: "var(--text-muted)",
        }}>{label}</span>
        {status && <span style={{ fontSize: 10, fontWeight: 700, color: markerColor || "var(--ink-100)" }}>{status}</span>}
      </div>
      <div style={{
        position: "relative", height: 5, marginTop: 8, borderRadius: 3,
        background: "linear-gradient(90deg, var(--down-400), var(--amber-400), var(--up-400))",
      }}>
        <div style={{
          position: "absolute", top: -3, left: `${pct}%`, width: 3, height: 11,
          borderRadius: 2, background: markerColor || "var(--ink-050)",
          boxShadow: `0 0 6px ${markerColor || "#fff"}`, transform: "translateX(-50%)",
          transition: "left 1s var(--ease-out)",
        }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 5, fontSize: 8.5, color: "var(--text-faint)", letterSpacing: "var(--ls-wide)" }}>
        <span>{leftLabel}</span><span>{rightLabel}</span>
      </div>
    </div>
  );
}

// ── Nav ──────────────────────────────────────────────────
export function TabNav({ value, onChange, tabs = [], style }) {
  return (
    <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", ...style }}>
      {tabs.map(t => {
        const on = t.value === value;
        return (
          <button key={t.value} onClick={() => onChange?.(t.value)} style={{
            display: "inline-flex", alignItems: "center", gap: 7,
            padding: "8px 16px", borderRadius: "var(--radius-md)", cursor: "pointer",
            fontFamily: "var(--font-ui)", fontSize: 12, fontWeight: 700,
            letterSpacing: "var(--ls-wide)", textTransform: "uppercase",
            background: on ? "var(--accent-quiet)" : "rgba(255,255,255,0.03)",
            border: `1px solid ${on ? "var(--border-cyan)" : "var(--border-hairline)"}`,
            color: on ? "var(--accent)" : "var(--text-muted)",
            boxShadow: on ? "var(--glow-cyan-soft)" : undefined,
            transition: "all var(--dur-med) var(--ease-out)",
          }}>
            {t.icon && <span style={{ fontSize: 13 }}>{t.icon}</span>}{t.label}
          </button>
        );
      })}
    </div>
  );
}
