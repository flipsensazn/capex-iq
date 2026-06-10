"""Trend Join Long evaluation over today's premarket gappers + push to web UI.

Loads the gapper universe from premarket_gappers_YYYY-MM-DD.json if present,
otherwise from the deployed /gap-scanner endpoint (KV) — so intraday reruns
work on stateless cloud runners. Evaluates each gapper against the TJL entry
criteria using Yahoo's chart API:

  daily_breakout    = curr_px > prev daily high  AND  prev close > 200-day SMA
  intraday_breakout = curr_px > premarket high   AND  curr_px > today's HOD
                      (HOD leg is skipped before the regular session opens)

  result: "PASS" | "fail_daily" | "fail_intraday"

Config (env vars win; gap_scanner_config.json is the local fallback):
  GAP_SCANNER_URL, ADMIN_PASSWORD — push target
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID — see telegram_notify.py

Telegram gating (first run of day / new PASS / error) is derived from the
scan previously stored in KV, so it needs no local state and behaves the
same on a laptop or a GitHub Actions runner.

--guarded: exit quietly unless it's a live trading day between 10:00 and
2:00pm ET and a morning scan exists (used by the intraday schedules).
"""
import json
import os
import sys
import time
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

import telegram_notify

HERE = Path(__file__).resolve().parent
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"}


def load_config():
    cfg = {}
    cfg_file = HERE / "gap_scanner_config.json"
    if cfg_file.exists():
        cfg = json.loads(cfg_file.read_text(encoding="utf-8"))
    url = os.environ.get("GAP_SCANNER_URL") or cfg.get("url")
    password = os.environ.get("ADMIN_PASSWORD") or cfg.get("password")
    return url, password


def fetch_json(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def yahoo_chart(sym, interval, rng, prepost=False):
    for host in ("query1", "query2"):
        try:
            url = (f"https://{host}.finance.yahoo.com/v8/finance/chart/{sym}"
                   f"?interval={interval}&range={rng}"
                   f"&includePrePost={'true' if prepost else 'false'}")
            return fetch_json(url)["chart"]["result"][0]
        except Exception:
            if host == "query2":
                raise
            time.sleep(2)


def spy_session():
    """Return (reg_start, reg_end, gmtoffset) for the current SPY session."""
    meta = yahoo_chart("SPY", "1d", "1d")["meta"]
    p = meta["currentTradingPeriod"]["regular"]
    return p["start"], p["end"], meta.get("gmtoffset", -4 * 3600)


def et_hhmm(gmtoffset):
    return datetime.fromtimestamp(time.time() + gmtoffset, tz=timezone.utc).strftime("%H:%M")


def evaluate_tjl(sym):
    """Return the TJL dict for one symbol, or {'result': 'error', ...}."""
    # Daily leg: 1y of daily bars
    d = yahoo_chart(sym, "1d", "1y")
    meta = d["meta"]
    ts = d["timestamp"]
    q = d["indicators"]["quote"][0]
    rows = [(t, q["high"][i], q["close"][i]) for i, t in enumerate(ts)
            if q["close"][i] is not None and q["high"][i] is not None]

    curr_px = meta.get("regularMarketPrice")
    reg_start = meta["currentTradingPeriod"]["regular"]["start"]
    reg_end = meta["currentTradingPeriod"]["regular"]["end"]
    pre_start = meta["currentTradingPeriod"]["pre"]["start"]

    # Drop today's live bar (daily bar timestamps = session open) so "prev"
    # really is the prior completed session
    completed = [r for r in rows if r[0] < reg_start]
    if len(completed) < 200:
        return {"result": "error", "error": f"only {len(completed)} completed daily bars"}
    prev = completed[-1]
    prev_daily_high, prev_daily_close = prev[1], prev[2]
    sma200 = sum(r[2] for r in completed[-200:]) / 200

    # Intraday leg: today's 1m bars including premarket
    m = yahoo_chart(sym, "1m", "1d", prepost=True)
    mts = m["timestamp"]
    mq = m["indicators"]["quote"][0]
    now = time.time()
    pmh = None
    hod = None
    last_t = mts[-1] if mts else 0
    for i, t in enumerate(mts):
        h = mq["high"][i]
        if h is None:
            continue
        if pre_start <= t < reg_start:
            pmh = h if pmh is None else max(pmh, h)
        elif reg_start <= t < min(now, reg_end) and t != last_t:
            hod = h if hod is None else max(hod, h)

    daily_ok = curr_px is not None and curr_px > prev_daily_high and prev_daily_close > sma200
    intraday_ok = (curr_px is not None and pmh is not None and curr_px > pmh
                   and (hod is None or curr_px > hod))
    result = "PASS" if (daily_ok and intraday_ok) else ("fail_daily" if not daily_ok else "fail_intraday")

    rnd = lambda v: None if v is None else round(float(v), 2)
    return {"result": result, "curr_price": rnd(curr_px),
            "prev_daily_high": rnd(prev_daily_high), "prev_daily_close": rnd(prev_daily_close),
            "sma200": rnd(sma200), "pmh": rnd(pmh), "today_hod": rnd(hod)}


def fetch_stored_scan(url):
    """GET the scan currently in KV, or None."""
    try:
        res = fetch_json(url, timeout=30)
        return res.get("data") if res.get("success") else None
    except Exception as e:
        print(f"warn: could not fetch stored scan: {e}")
        return None


def load_universe(today, url):
    """Today's gappers: local file first, then the deployed KV copy."""
    local = HERE / f"premarket_gappers_{today}.json"
    if local.exists():
        return json.loads(local.read_text(encoding="utf-8")), None
    if url:
        stored = fetch_stored_scan(url)
        if stored and stored.get("scanned_at", "")[:10] == today:
            print("universe: loaded from KV (no local file)")
            # Deep-copy the working scan: each gapper's tjl gets overwritten
            # in place, and the prior snapshot must keep the pre-run PASS
            # set intact for telegram gating.
            return json.loads(json.dumps(stored)), stored
    return None, None


def notify_tjl(gap_scan, prior_scan, gmtoffset, run_error=None):
    """Telegram for Scanner B: first run of day, new PASS, or error.

    Gating state is derived from the scan previously stored in KV: if the
    stored scan has no TJL results for today, this is the first run; PASS
    symbols already stored have already been announced.
    """
    if run_error:
        telegram_notify.send(f"⚠ *TJL Scanner error* — {et_hhmm(gmtoffset)} ET\n{run_error}")
        return

    today = date.today().isoformat()
    first_run = not (prior_scan and prior_scan.get("tjl_evaluated_at", "")[:10] == today)
    prior_hits = set()
    if not first_run:
        prior_hits = {g["symbol"] for g in prior_scan.get("gappers", [])
                      if g.get("tjl", {}).get("result") == "PASS"}

    hits = [g for g in gap_scan.get("gappers", []) if g.get("tjl", {}).get("result") == "PASS"]
    new_hits = [g for g in hits if g["symbol"] not in prior_hits]

    if not first_run and not new_hits:
        print("telegram: no new hits and not first run — skipping")
        return

    lines = [f"\U0001F3AF *TJL Watchlist* — {et_hhmm(gmtoffset)} ET"]
    if not hits:
        lines.append("No TJL hits this run.")
    else:
        for g in hits:
            t = g["tjl"]
            # prev\_high: underscore must be escaped or Telegram Markdown
            # treats it as an italic entity and rejects the message
            lines.append(f"• {g['symbol']} @ ${t['curr_price']} "
                         f"(PMH ${t['pmh']}, prev\\_high ${t['prev_daily_high']}, SMA200 ${t['sma200']})")
    telegram_notify.send("\n".join(lines))


def main():
    today = date.today().isoformat()
    guarded = "--guarded" in sys.argv
    url, password = load_config()

    if guarded:
        # Intraday rerun guard: only 10:00am–2:00pm ET on a live trading day.
        reg_start, reg_end, _ = spy_session()
        now = time.time()
        if not (0 < now - reg_start < 86400):
            print("skip: no live session today (market holiday?)")
            return
        if not (reg_start + 1800 <= now <= reg_start + 16200):
            print("skip: outside 10:00–14:00 ET intraday window")
            return

    gap_scan, prior_from_kv = load_universe(today, url)
    if gap_scan is None:
        if guarded:
            print("skip: no morning gappers scan found (holiday or pipeline failure)")
            return
        print("ERROR: no gappers universe (local file or KV) — run premarket_gappers.sh first")
        sys.exit(1)

    try:
        _, _, gmtoffset = spy_session()
    except Exception:
        gmtoffset = -4 * 3600

    # Snapshot what's already in KV BEFORE we overwrite it (telegram gating)
    prior_scan = prior_from_kv if prior_from_kv is not None else (fetch_stored_scan(url) if url else None)

    for g in gap_scan["gappers"]:
        try:
            g["tjl"] = evaluate_tjl(g["symbol"])
        except Exception as e:
            g["tjl"] = {"result": "error", "error": str(e)}
        badge = g["tjl"]["result"]
        print(f"{g['symbol']}: {badge}"
              + (f" — px {g['tjl'].get('curr_price')} vs prevH {g['tjl'].get('prev_daily_high')}"
                 f" pmh {g['tjl'].get('pmh')} hod {g['tjl'].get('today_hod')}"
                 if badge != "error" else f" — {g['tjl'].get('error')}"))
        time.sleep(1)

    gap_scan["tjl_evaluated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    out = HERE / f"tjl_gap_scan_{today}.json"
    out.write_text(json.dumps(gap_scan, indent=2), encoding="utf-8")
    print(f"saved {out.name}")

    notify_tjl(gap_scan, prior_scan, gmtoffset)

    if not (url and password):
        print("no GAP_SCANNER_URL/ADMIN_PASSWORD config — skipping web push")
        return
    body = json.dumps({"password": password, "scan": gap_scan}).encode()
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={**UA, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        print(f"pushed to {url}: {r.read().decode()}")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        notify_tjl({}, None, -4 * 3600, run_error=str(e))
        raise
