# bottleneck_scout.py
#
# AI-agent discovery of NEW supply-chain bottleneck candidates.
#
# Weekly pipeline:
#   1. DISCOVER — Gemini with Google Search grounding hunts recent news
#      (shortages, allocation, lead times, sole-source suppliers, capacity
#      expansions) per capex track and proposes public companies NOT already
#      on the map. US listings preferred; OTC ADRs of international
#      companies accepted.
#   2. VALIDATE — every proposed ticker is identity-checked against Yahoo
#      (name must actually match the claimed company; price/market cap/
#      exchange captured). Hallucinated or mismatched tickers are dropped.
#   3. ENRICH — each surviving candidate gets a one-shot stress snapshot
#      using the SAME signal code the map uses: earnings-call transcript
#      scan (transcript_stress) + XBRL backlog/inventory gauges
#      (xbrl_gauges). The reviewer sees real signals, not just a thesis.
#   4. QUEUE — candidates land in Neon `bottleneck_candidates` with status
#      'pending'. GET /candidates serves the queue; the dashboard's
#      Bottleneck Scout panel is where the human approves (ticker is added
#      to the capex map) or rejects (never suggested again).
#
# Env vars:
#   DATABASE_URL        required
#   GEMINI_API_KEY      required
#   WATCHLIST_BASE_URL  optional  live capex-map tickers for exclusions
#   MAX_NEW_CANDIDATES  optional  cap per run (default 12)

import json
import os
import re
import time

import psycopg2
import psycopg2.extras
import requests
import yfinance as yf

# Reuse the proven signal machinery from the sibling ETLs
from transcript_stress import (
    get_universe, lexicon_scan, lexicon_score, classify_with_gemini,
    defeatbeta_transcripts, defeatbeta_text, connect_db, MIN_TRANSCRIPT_WORDS,
    GEMINI_API_KEY, GEMINI_PAUSE, DEFEATBETA_OK,
)
from xbrl_gauges import get_cik_map, fetch_companyfacts, compute_gauges

DATABASE_URL       = os.environ.get("DATABASE_URL")
MAX_NEW_CANDIDATES = int(os.environ.get("MAX_NEW_CANDIDATES") or 12)
GEMINI_MODEL       = "gemini-2.5-flash"

# Discovery themes — one grounded search per track.
THEMES = [
    ("compute", "Compute & Silicon",
     "AI chips, HBM memory, advanced packaging (CoWoS/SoIC), leading-edge foundry, "
     "semiconductor equipment, photomasks, wafer test, EDA"),
    ("networking", "Networking & Connectivity",
     "datacenter switching, 800G/1.6T optics supply chain, copper/optical cabling, "
     "connectors, network test"),
    ("photonics", "Photonics & Interconnects",
     "optical transceivers, InP/GaAs substrates and epitaxy, silicon photonics, "
     "co-packaged optics, retimers, laser diodes"),
    ("neoclouds", "Neoclouds & Data Centers",
     "AI datacenter construction, GPU cloud operators, AI server ODM/EMS, "
     "datacenter REITs, mechanical/electrical contractors"),
    ("power", "Power & Cooling",
     "grid equipment, transformers, switchgear, UPS, backup power, nuclear/SMR, "
     "liquid cooling, power semiconductors SiC/GaN, MLCC passives"),
    ("frontier", "Frontier / Speculative",
     "critical minerals, rare earths, gallium/germanium/indium supply, quantum, "
     "space infrastructure, robotics for fabs and datacenters"),
]

DISCOVER_PROMPT = """You are a supply-chain analyst hunting for PUBLIC companies exposed to CURRENT bottlenecks in AI infrastructure.

Domain: {label} — {description}

Search recent news (roughly the last 90 days) for: component shortages, products on allocation, extended lead times, sole-source or dominant suppliers, large capacity expansions, and export-control chokepoints in this domain. Identify companies that OWN such a bottleneck or are a critical pure-play link in it.

Rules:
- Publicly traded only. Prefer US exchanges (NYSE/Nasdaq); OTC ADRs of international companies are acceptable.
- EXCLUDE these already-tracked tickers: {exclusions}
- Prefer focused/pure-play companies over diversified giants.
- Only include companies where you found a CONCRETE recent bottleneck angle — no generic "AI beneficiary" picks.

Respond with ONLY a valid JSON array (max 4 entries, fewer is fine, empty array if nothing concrete):
[
  {{
    "ticker": "<symbol as traded in the US>",
    "companyName": "<official name>",
    "chokepoint": "<the specific bottleneck, 3-8 words>",
    "thesis": "<2 sentences max: what they make, the concrete recent evidence>",
    "suggestedSubsector": "<short label for where it belongs on the map>"
  }}
]"""


def grounded_gemini(prompt, max_retries=3):
    """Search-grounded Gemini call (grounding is incompatible with JSON mode →
    parse from fence-stripped text, retry on malformed JSON)."""
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}")
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "tools": [{"google_search": {}}],
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": 2048,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    }
    delay = 15
    for attempt in range(max_retries):
        res = requests.post(url, json=body, timeout=90)
        if res.status_code in (429, 500, 503, 529):
            print(f"    Gemini {res.status_code} — waiting {delay}s...")
            time.sleep(delay)
            delay *= 2
            continue
        res.raise_for_status()
        parts = res.json().get("candidates", [{}])[0].get("content", {}).get("parts", [])
        text = "".join(p.get("text", "") for p in parts).strip()
        text = re.sub(r"^```json\s*|^```\s*|```\s*$", "", text, flags=re.I | re.M).strip()
        # grounded responses sometimes wrap the JSON in prose — find the array
        m = re.search(r"\[.*\]", text, re.S)
        if not m:
            return []
        try:
            return json.loads(m.group(0))
        except json.JSONDecodeError as e:
            if attempt < max_retries - 1:
                print(f"    malformed JSON ({e}) — retrying...")
                continue
            raise
    return []


OTC_EXCHANGES = {"PNK", "OTC", "OEM", "OQB", "OQX", "OTCQB", "OTCQX"}


def validate_ticker(ticker, claimed_name):
    """
    Yahoo identity check. Returns dict or None. The claimed company name must
    plausibly match Yahoo's name for the symbol — this is what catches
    hallucinated tickers and identity collisions (COR ≠ CoreSite).
    """
    try:
        info = yf.Ticker(ticker).info
    except Exception:
        return None
    name = info.get("longName") or info.get("shortName") or ""
    if not name or info.get("regularMarketPrice") is None:
        return None

    # loose name match: any significant word from the claimed name appears in Yahoo's
    stop = {"inc", "corp", "corporation", "co", "ltd", "plc", "the", "group", "holdings", "technologies", "technology", "sa", "ag", "nv", "ab"}
    claimed_words = [w for w in re.findall(r"[a-z0-9]+", claimed_name.lower()) if w not in stop and len(w) > 2]
    if claimed_words and not any(w in name.lower() for w in claimed_words):
        print(f"    {ticker}: identity mismatch — claimed '{claimed_name}', Yahoo says '{name}' — dropped")
        return None

    exchange = (info.get("exchange") or "").upper()
    return {
        "name": name,
        "exchange": info.get("fullExchangeName") or exchange,
        "is_otc": exchange in OTC_EXCHANGES or "OTC" in exchange,
        "market_cap": info.get("marketCap"),
        "price": info.get("regularMarketPrice"),
    }


def stress_snapshot(ticker):
    """One-shot transcript stress for a candidate (latest available quarter)."""
    out = {"stress_score": None, "stress_direction": None, "stress_summary": None, "stress_quotes": []}
    if not DEFEATBETA_OK:
        return out
    dbeta = defeatbeta_transcripts(ticker)
    if not dbeta or not dbeta["quarters"]:
        return out
    for fy, fq, _rd in dbeta["quarters"][:3]:
        text = defeatbeta_text(dbeta["obj"], fy, fq)
        if not text or len(text.split()) < MIN_TRANSCRIPT_WORDS:
            continue
        weighted, _raw, excerpt = lexicon_scan(text)
        if not excerpt:
            out["stress_score"] = 0.0
            return out
        ai = classify_with_gemini(ticker, fy, fq, excerpt)
        time.sleep(GEMINI_PAUSE)
        if ai:
            out.update({
                "stress_score": ai["stress_score"], "stress_direction": ai["direction"],
                "stress_summary": ai["summary"], "stress_quotes": ai["quotes"],
            })
        else:
            out["stress_score"] = min(lexicon_score(weighted, len(text.split())), 40.0)
        return out
    return out


def gauge_snapshot(ticker, cik_map):
    """One-shot XBRL gauges for a candidate (None-heavy for foreign/OTC filers)."""
    out = {"order_gap": None, "rpo_yoy": None, "revenue_yoy": None, "inventory_days": None, "backlog_score": None}
    cik = cik_map.get(ticker)
    if not cik:
        return out
    try:
        facts = fetch_companyfacts(cik)
        g = compute_gauges(facts) if facts else None
        if g:
            out.update({
                "order_gap": g["order_gap"], "rpo_yoy": g["rpo_yoy"],
                "revenue_yoy": g["revenue_yoy"], "inventory_days": g["inventory_days"],
                "backlog_score": g["backlog_score"],
            })
    except Exception as e:
        print(f"    {ticker}: gauges error — {e}")
    return out


# ── DATABASE ──────────────────────────────────────────────

BOOTSTRAP_SQL = """
    CREATE TABLE IF NOT EXISTS bottleneck_candidates (
        ticker              TEXT PRIMARY KEY,
        company_name        TEXT,
        exchange            TEXT,
        is_otc              BOOLEAN DEFAULT false,
        market_cap          DOUBLE PRECISION,
        price               DOUBLE PRECISION,
        track_id            TEXT,
        suggested_subsector TEXT,
        chokepoint          TEXT,
        thesis              TEXT,
        stress_score        DOUBLE PRECISION,
        stress_direction    TEXT,
        stress_summary      TEXT,
        stress_quotes       JSONB,
        order_gap           DOUBLE PRECISION,
        rpo_yoy             DOUBLE PRECISION,
        revenue_yoy         DOUBLE PRECISION,
        inventory_days      DOUBLE PRECISION,
        backlog_score       DOUBLE PRECISION,
        status              TEXT DEFAULT 'pending',
        discovered_at       TIMESTAMPTZ DEFAULT now(),
        reviewed_at         TIMESTAMPTZ
    );
"""

INSERT_SQL = """
    INSERT INTO bottleneck_candidates
        (ticker, company_name, exchange, is_otc, market_cap, price, track_id,
         suggested_subsector, chokepoint, thesis, stress_score, stress_direction,
         stress_summary, stress_quotes, order_gap, rpo_yoy, revenue_yoy,
         inventory_days, backlog_score)
    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
    ON CONFLICT (ticker) DO NOTHING;
"""


# ── MAIN ─────────────────────────────────────────────────

if __name__ == "__main__":
    print("=== Bottleneck Scout ===")
    if not DATABASE_URL:
        raise SystemExit("DATABASE_URL not set.")
    if not GEMINI_API_KEY:
        raise SystemExit("GEMINI_API_KEY not set — discovery requires it.")

    conn = connect_db(DATABASE_URL)
    try:
        with conn.cursor() as cur:
            cur.execute(BOOTSTRAP_SQL)
        conn.commit()

        # Exclusions: everything on the live map + every candidate ever
        # suggested (pending, approved, or rejected — never re-pitch).
        exclusions = set(get_universe())
        with conn.cursor() as cur:
            cur.execute("SELECT ticker FROM bottleneck_candidates")
            exclusions |= {t for (t,) in cur.fetchall()}
        print(f"{len(exclusions)} tickers excluded from discovery.")

        cik_map = get_cik_map()
        added = 0

        for track_id, label, description in THEMES:
            if added >= MAX_NEW_CANDIDATES:
                break
            print(f"\n[{label}] searching...")
            try:
                proposals = grounded_gemini(DISCOVER_PROMPT.format(
                    label=label, description=description,
                    exclusions=", ".join(sorted(exclusions))))
            except Exception as e:
                print(f"  discovery failed — {e}")
                continue
            time.sleep(GEMINI_PAUSE)

            for p in proposals:
                if added >= MAX_NEW_CANDIDATES:
                    break
                if not isinstance(p, dict):
                    continue
                ticker = str(p.get("ticker") or "").strip().upper()
                claimed = str(p.get("companyName") or "").strip()
                if not ticker or not claimed or ticker in exclusions:
                    continue

                v = validate_ticker(ticker, claimed)
                time.sleep(1.0)  # Yahoo politeness
                if not v:
                    print(f"  {ticker}: failed validation — dropped")
                    continue

                print(f"  {ticker} ({v['name']}): validated — enriching signals...")
                s = stress_snapshot(ticker)
                g = gauge_snapshot(ticker, cik_map)

                with conn.cursor() as cur:
                    cur.execute(INSERT_SQL, (
                        ticker, v["name"], v["exchange"], v["is_otc"],
                        v["market_cap"], v["price"], track_id,
                        str(p.get("suggestedSubsector") or "")[:80],
                        str(p.get("chokepoint") or "")[:120],
                        str(p.get("thesis") or "")[:600],
                        s["stress_score"], s["stress_direction"], s["stress_summary"],
                        psycopg2.extras.Json(s["stress_quotes"]),
                        g["order_gap"], g["rpo_yoy"], g["revenue_yoy"],
                        g["inventory_days"], g["backlog_score"],
                    ))
                conn.commit()
                exclusions.add(ticker)
                added += 1
                print(f"  {ticker}: queued (stress={s['stress_score']}, gap={g['order_gap']})")
    finally:
        conn.close()

    print(f"\n=== Bottleneck Scout complete: {added} new candidates queued ===")
