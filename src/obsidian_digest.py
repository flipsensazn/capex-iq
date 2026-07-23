# obsidian_digest.py
#
# Weekly Obsidian digest — writes the "what did the system say this week"
# note into the thesis/journal vault so it maintains itself.
#
# Runs LOCALLY (Windows Task Scheduler, Sunday evening after the cloud ETLs
# finish) and reads only the deployed site's public endpoints — no DB
# credentials on this machine:
#   /composite   CBS scores + weekly deltas + component parts
#   /scoreboard  signal-performance stats + recent events
#   /stress      transcript stress (used for the hottest-names table)
#   /candidates  pending scout queue
#
# Output: <vault>/Journal/YYYY-MM-DD Weekly Digest.md with [[TICKER]] links.
# If the note already exists, everything the user wrote under "## My Notes"
# is preserved verbatim across regeneration. Every section degrades
# gracefully — an endpoint that's down or not yet deployed is skipped, never
# fatal. Every run appends to ~/watchlist-digest.log so a silently-dead
# scheduled task is diagnosable (home dir, not %LOCALAPPDATA% — Task
# Scheduler runs get a reduced environment).
#
# Env vars (all optional):
#   OBSIDIAN_VAULT       vault root   (default: the iCloud vault path below)
#   WATCHLIST_BASE_URL   site root    (default: https://wizzles-watchlist.pages.dev)

import os
import sys
import traceback
from datetime import date, datetime, timedelta
from pathlib import Path

import requests

VAULT = Path(os.environ.get(
    "OBSIDIAN_VAULT",
    r"C:\Users\Wizzle\iCloudDrive\iCloud~md~obsidian\AI Hyperscaler Capex"))
BASE_URL = os.environ.get(
    "WATCHLIST_BASE_URL", "https://capex-iq.us").rstrip("/")
LOG_FILE = Path.home() / "watchlist-digest.log"

NOTES_MARKER = "## My Notes"

TYPE_LABELS = {
    "all":             "ALL SIGNALS",
    "cbs_cross_70":    "CBS crossed 70",
    "cbs_jump_15":     "CBS +15 jump",
    "stress_cross_70": "Stress crossed 70",
    "order_gap_50":    "Order gap >=50pp",
    "scout_approved":  "Scout approval",
}


def log(msg):
    line = f"{datetime.now().isoformat(timespec='seconds')}  {msg}"
    print(line)
    try:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass


def get_json(path):
    try:
        res = requests.get(f"{BASE_URL}{path}", timeout=30)
        res.raise_for_status()
        return res.json()
    except Exception as e:
        log(f"WARN {path} unavailable: {e}")
        return None


def t(ticker):
    return f"[[{ticker}]]"


def fmt_delta(d):
    return f"+{d:.0f}" if d >= 0 else f"{d:.0f}"


def fmt_excess(v):
    return "—" if v is None else f"{'+' if v > 0 else ''}{v:.1f}%"


# ── SECTIONS ─────────────────────────────────────────────

def section_movers(composite):
    if not composite:
        return None
    movers = [(tk, e) for tk, e in composite.items()
              if e.get("score") is not None and e.get("delta") is not None
              and abs(e["delta"]) >= 3]
    if not movers:
        return ("## ⬢ CBS Movers\n\n"
                "No meaningful weekly moves (all deltas < 3).\n")
    movers.sort(key=lambda m: -m[1]["delta"])
    lines = ["## ⬢ CBS Movers\n",
             "| Ticker | CBS | Δ wk | transcript / gauge / conc |",
             "|---|---|---|---|"]
    for tk, e in movers[:16]:
        p = e.get("parts") or {}
        parts = " / ".join(
            "—" if p.get(k) is None else f"{p[k]:.0f}"
            for k in ("transcript", "gauge", "concentration"))
        lines.append(f"| {t(tk)} | {e['score']:.0f} | {fmt_delta(e['delta'])} | {parts} |")
    if len(movers) > 16:
        lines.append(f"\n…and {len(movers) - 16} smaller moves.")
    return "\n".join(lines) + "\n"


def section_hottest(composite, stress):
    if not composite:
        return None
    ranked = sorted(
        ((tk, e) for tk, e in composite.items() if e.get("score") is not None),
        key=lambda m: -m[1]["score"])[:10]
    if not ranked:
        return None
    lines = ["## Hottest composite scores\n",
             "| Ticker | ⬢ CBS | direction | latest call evidence |",
             "|---|---|---|---|"]
    for tk, e in ranked:
        latest = ((stress or {}).get(tk) or {}).get("latest") or {}
        summary = (latest.get("summary") or "").replace("|", "/").strip()
        if len(summary) > 110:
            summary = summary[:107] + "…"
        lines.append(f"| {t(tk)} | {e['score']:.0f} | {e.get('direction') or '—'} | {summary or '—'} |")
    return "\n".join(lines) + "\n"


def section_scoreboard(scoreboard):
    if not scoreboard or not scoreboard.get("stats"):
        return None
    lines = ["## ⚖ Scoreboard — median excess vs QQQ\n",
             "| Signal | n | 1w | 1m | 3m |",
             "|---|---|---|---|---|"]
    stats = sorted(scoreboard["stats"], key=lambda s: (s["type"] == "all", -s["n"]))
    for s in stats:
        cells = []
        for h in ("1w", "1m", "3m"):
            hz = (s.get("horizons") or {}).get(h) or {}
            if not hz.get("n"):
                cells.append("—")
            else:
                hit = f" ({hz['hitRate']}% hit, n={hz['n']})" if hz.get("hitRate") is not None else ""
                cells.append(f"{fmt_excess(hz.get('medianExcess'))}{hit}")
        label = TYPE_LABELS.get(s["type"], s["type"])
        if s["type"] == "all":
            label = f"**{label}**"
        lines.append(f"| {label} | {s['n']} | {cells[0]} | {cells[1]} | {cells[2]} |")
    return "\n".join(lines) + "\n"


def section_new_events(scoreboard, since):
    if not scoreboard or not scoreboard.get("events"):
        return None
    fresh = [e for e in scoreboard["events"]
             if e.get("date") and date.fromisoformat(e["date"][:10]) >= since]
    if not fresh:
        return "## New signal events\n\nNo new signals fired this week.\n"
    lines = ["## New signal events\n"]
    for e in fresh:
        score = f" (score {e['score']:.0f})" if e.get("score") is not None else ""
        lines.append(f"- {t(e['ticker'])} — {TYPE_LABELS.get(e['type'], e['type'])}"
                     f" on {e['date'][:10]}{score}")
    return "\n".join(lines) + "\n"


def section_scout(candidates):
    if candidates is None:
        return None
    if not candidates:
        return "## 🔭 Scout queue\n\nNo pending candidates.\n"
    lines = ["## 🔭 Scout queue — pending review\n"]
    for c in candidates[:10]:
        thesis = (c.get("thesis") or "").replace("\n", " ").strip()
        if len(thesis) > 140:
            thesis = thesis[:137] + "…"
        stress = (f", stress {c['stress_score']:.0f}"
                  if c.get("stress_score") is not None else "")
        lines.append(f"- {t(c['ticker'])} ({c.get('view', 'ai')}{stress}) — {thesis}")
    return "\n".join(lines) + "\n"


# ── ASSEMBLY ─────────────────────────────────────────────

def preserved_notes(path):
    """User content under '## My Notes' survives regeneration."""
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8")
    idx = text.find(NOTES_MARKER)
    if idx == -1:
        return None
    body = text[idx + len(NOTES_MARKER):].strip("\n")
    return body if body.strip() else None


def build_digest(today):
    composite_res = get_json("/composite")
    scoreboard_res = get_json("/scoreboard")
    stress_res = get_json("/stress")
    candidates_res = get_json("/candidates")

    composite = (composite_res or {}).get("data") or {}
    scoreboard = scoreboard_res if (scoreboard_res or {}).get("success") else None
    stress = (stress_res or {}).get("data") or {}
    candidates = (candidates_res or {}).get("candidates") if candidates_res else None

    sections = [s for s in (
        section_movers(composite),
        section_hottest(composite, stress),
        section_new_events(scoreboard, today - timedelta(days=8)),
        section_scoreboard(scoreboard),
        section_scout(candidates),
    ) if s]

    if not sections:
        return None  # every endpoint down — don't write an empty note

    head = (f"---\ntags: [digest]\ndate: {today.isoformat()}\n---\n\n"
            f"# Weekly Digest — {today.isoformat()}\n\n"
            f"Auto-generated from [the dashboard]({BASE_URL}) — "
            f"regenerated in place if re-run; notes below the marker survive.\n")
    return head + "\n" + "\n".join(sections)


def main():
    today = date.today()
    journal = VAULT / "Journal"
    journal.mkdir(parents=True, exist_ok=True)
    path = journal / f"{today.isoformat()} Weekly Digest.md"

    body = build_digest(today)
    if body is None:
        log("ERROR all endpoints unavailable — no digest written")
        return 1

    notes = preserved_notes(path)
    body += f"\n{NOTES_MARKER}\n\n" + (notes + "\n" if notes else "")
    path.write_text(body, encoding="utf-8")
    log(f"OK digest written: {path}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        log("ERROR digest crashed:\n" + traceback.format_exc())
        sys.exit(1)
