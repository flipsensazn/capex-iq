#!/usr/bin/env bash
# Premarket gappers scanner
# Source: Yahoo Finance day_gainers screener API (JSON backend of
# https://finance.yahoo.com/markets/stocks/gainers/) + Benzinga quote pages
# for news catalysts. NOTE: finance.yahoo.com/quote/{T}/news/ returns 503 —
# do not switch the news source back to Yahoo.
#
# Filters: gap_pct > 5, price > $3, volume > 50000, top 10 by gap_pct.
# Output: ./premarket_gappers_YYYY-MM-DD.json
set -uo pipefail
cd "$(dirname "$0")"

PY=$(command -v python3 || command -v python)
"$PY" - <<'PYEOF'
import json, sys, time, urllib.request
from datetime import date, datetime, timezone
from html import unescape

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36",
      "Accept": "text/html,application/json"}

def fetch(url, timeout=20):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")

# --- 1. Gainers from Yahoo screener API (query1, fall back to query2) ---
quotes = None
for host in ("query1", "query2"):
    url = (f"https://{host}.finance.yahoo.com/v1/finance/screener/"
           "predefined/saved?scrIds=day_gainers&count=100")
    try:
        data = json.loads(fetch(url))
        quotes = data["finance"]["result"][0]["quotes"]
        break
    except Exception as e:
        print(f"warn: {host} screener failed: {e}", file=sys.stderr)
if not quotes:
    print("ERROR: could not fetch Yahoo gainers from either API host", file=sys.stderr)
    sys.exit(1)

rows = []
for q in quotes:
    sym = q.get("symbol")
    price = q.get("regularMarketPrice")
    gap = q.get("preMarketChangePercent") or q.get("regularMarketChangePercent")
    vol = q.get("preMarketVolume") or q.get("regularMarketVolume")
    if not sym or price is None or gap is None or vol is None:
        continue
    if gap > 5 and price > 3 and vol > 50000:
        rows.append({"symbol": sym, "price": round(float(price), 2),
                     "gap_pct": round(float(gap), 2), "premarket_volume": int(vol)})

rows.sort(key=lambda r: r["gap_pct"], reverse=True)
rows = rows[:10]

# --- 2. Catalyst headlines from Benzinga quote pages ---
def benzinga_news(sym):
    # The /quote/{T} page is client-rendered (no headlines in HTML); this
    # internal JSON endpoint returns the same news feed, newest first.
    arts = json.loads(fetch(f"https://www.benzinga.com/api/news?tickers={sym}", timeout=25))
    now = time.time()

    def created_ts(a):
        try:
            return datetime.fromisoformat(a.get("created", "").replace("Z", "+00:00")).timestamp()
        except ValueError:
            return 0

    # Rank by ticker-specificity: a story tagged with 1-2 stocks is about THIS
    # company; market roundups tag 10-200 tickers and make poor catalysts.
    # Recency breaks ties. Articles older than 3 days only as a last resort.
    def rank(a):
        ts = created_ts(a)
        stale = (now - ts) > 3 * 86400
        return (stale, len(a.get("stocks", [])), -ts)

    def title(a):
        return unescape(a.get("title") or a.get("headline") or "").strip()

    heads = []
    for a in sorted(arts, key=rank):
        t = title(a)
        if t and t not in heads:
            heads.append(t)

    # Catalyst must be a FRESH, ticker-specific story (<=5 tagged stocks,
    # <=3 days old). A 16-stock market roundup is not this ticker's catalyst —
    # better to report no catalyst than a misleading one.
    catalyst = None
    for a in sorted(arts, key=rank):
        ts = created_ts(a)
        if (now - ts) <= 3 * 86400 and len(a.get("stocks", [])) <= 5 and title(a):
            catalyst = title(a)
            break
    return catalyst, heads

gappers = []
for i, r in enumerate(rows, 1):
    catalyst, headlines = None, []
    try:
        catalyst, heads = benzinga_news(r["symbol"])
        headlines = heads[:2]
    except Exception as e:
        print(f"warn: catalyst lookup failed for {r['symbol']}: {e}", file=sys.stderr)
    gappers.append({"rank": i, **r, "catalyst": catalyst, "headlines": headlines})
    time.sleep(1)  # be polite to Benzinga

out = {"scanned_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
       "gappers": gappers}
today = date.today().isoformat()
fname = f"premarket_gappers_{today}.json"
with open(fname, "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2)

top = ", ".join(f"{g['symbol']} ({g['gap_pct']}%) — {g['catalyst'] or 'no catalyst found'}"
                for g in gappers[:3])
print(f"Premarket Gappers: {len(gappers)} names. Top: {top}")

# Telegram notification (every run — this scanner fires once per day)
import telegram_notify
lines = [f"\U0001F4CA *Premarket Gappers* — {today}"]
for g in gappers:
    bullet = f"• {g['symbol']} ${g['price']} +{g['gap_pct']}%"
    if g["catalyst"]:
        bullet += f" — {g['catalyst']}"
    lines.append(bullet)
telegram_notify.send("\n".join(lines))
PYEOF
