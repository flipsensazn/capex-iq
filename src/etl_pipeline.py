import requests
import pandas as pd
import numpy as np
import psycopg2
import psycopg2.extras
import yfinance as yf
import time
import random
import os
from datetime import date, timedelta

# --- Credentials from environment variables (GitHub Secrets inject these) ---
DATABASE_URL = os.environ.get('DATABASE_URL')
SEC_HEADERS  = {'User-Agent': 'WizzlesWatchlist flipsensazn@gmail.com'}

# Smaller batch size prevents Yahoo rate-limiting mid-batch.
# 100 tickers per call is the safe sweet spot — still fast, rarely blocked.
YF_BATCH_SIZE = 100

# Pause between batches (seconds). Increase this if rate limits persist.
YF_BATCH_PAUSE = 3

# Fail closed if successful SEC companyfacts responses cover too little of the
# ranked universe. This is response coverage, not field-level GAAP completeness.
# Override with RANKED_ETL_MIN_SEC_RESPONSE_COVERAGE (a decimal from 0 to 1).
DEFAULT_MIN_SEC_RESPONSE_COVERAGE = 0.90


# ── HELPERS ───────────────────────────────────────────────

def minimum_sec_response_coverage():
    """Return the required ratio of successful SEC companyfacts responses."""
    raw = os.environ.get('RANKED_ETL_MIN_SEC_RESPONSE_COVERAGE',
                         str(DEFAULT_MIN_SEC_RESPONSE_COVERAGE))
    try:
        minimum = float(raw)
    except ValueError as e:
        raise ValueError(
            f"RANKED_ETL_MIN_SEC_RESPONSE_COVERAGE must be a decimal from 0 to 1, got {raw!r}"
        ) from e
    if not 0 <= minimum <= 1:
        raise ValueError(
            f"RANKED_ETL_MIN_SEC_RESPONSE_COVERAGE must be between 0 and 1, got {raw!r}"
        )
    return minimum


def enforce_sec_response_coverage(stats, minimum=None):
    """Fail when response success is too sparse; GAAP field presence is separate."""
    minimum = minimum_sec_response_coverage() if minimum is None else minimum
    print(f"SEC minimum required response coverage: {minimum:.1%}")
    if stats['response_coverage'] < minimum:
        raise RuntimeError(
            f"SEC companyfacts response coverage {stats['response_coverage']:.1%} is below "
            f"the required {minimum:.1%} "
            f"(attempted={stats['attempted']} succeeded={stats['succeeded']} "
            f"failed={stats['failed']})"
        )


def yf_download_with_retry(tickers_str, max_retries=4):
    """
    Wraps yf.download() with exponential backoff.
    On a 429 / YFRateLimitError, waits and retries up to max_retries times.
    """
    delay = 30  # start with 30s, doubles each retry: 30 → 60 → 120 → 240
    for attempt in range(max_retries):
        try:
            raw = yf.download(
                tickers_str,
                period="1mo",
                interval="1d",
                group_by="ticker",
                auto_adjust=True,
                progress=False,
                threads=False,   # serial mode — threading makes rate limits worse
            )
            return raw
        except Exception as e:
            err = str(e).lower()
            if "rate" in err or "429" in err or "too many" in err:
                wait = delay + random.uniform(0, 10)
                print(f"    Rate limited — waiting {wait:.0f}s before retry {attempt + 1}/{max_retries}...")
                time.sleep(wait)
                delay *= 2
            else:
                raise  # non-rate-limit error — propagate immediately
    print(f"    Giving up after {max_retries} retries.")
    return None


def yf_ticker_data_with_retry(symbol, max_retries=4):
    """
    Fetches both fast_info (market cap, 52W range) and info (sector, industry,
    company name) for a single ticker with exponential backoff on rate limits.

    Returns a dict: { 'fast_info': <obj>, 'sector': str, 'industry': str, 'name': str }
    or None if all retries fail.

    Why .info and not fast_info for sector/name?
    fast_info only exposes numeric market data. Sector, industry, and company
    name live in the full .info dict — same HTTP call Yahoo would serve anyway.
    We only call this on tickers that passed the volume gate (~500–800 tickers),
    so the extra latency is acceptable.
    """
    delay = 20
    for attempt in range(max_retries):
        try:
            t        = yf.Ticker(symbol)
            fi       = t.fast_info
            info     = t.info  # heavier call — has sector/industry/longName
            return {
                'fast_info': fi,
                'sector':    info.get('sector')   or '',
                'industry':  info.get('industry') or '',
                'name':      info.get('longName') or info.get('shortName') or '',
            }
        except Exception as e:
            err = str(e).lower()
            if "rate" in err or "429" in err or "too many" in err:
                wait = delay + random.uniform(0, 5)
                print(f"    {symbol}: rate limited — waiting {wait:.0f}s (retry {attempt + 1}/{max_retries})...")
                time.sleep(wait)
                delay *= 2
            else:
                return None  # non-rate-limit error — skip this ticker
    return None


# ── PHASE 1: UNIVERSE GATING (yfinance) ──────────────────

def get_us_universe():
    """
    Fetch full US ticker list and CIK map from SEC in a single call.
    Reused by Phase 2 — no duplicate network requests.
    """
    print("Fetching US universe + CIK map from SEC...")
    res = requests.get("https://www.sec.gov/files/company_tickers.json",
                       headers=SEC_HEADERS)
    res.raise_for_status()
    data    = res.json()
    tickers = [v['ticker'] for v in data.values()]
    cik_map = {v['ticker']: str(v['cik_str']).zfill(10) for v in data.values()}
    print(f"Found {len(tickers)} tickers in SEC universe.")
    return tickers, cik_map


def prefilter(symbols):
    """
    Pure string-based filters — zero API calls.
    Cuts raw ~12,000 symbols to ~7,000 before touching Yahoo.
    """
    symbols = [s for s in symbols if '.' not in s]           # no dots (foreign/preferred)
    symbols = [s for s in symbols if len(s) <= 5]            # max 5 chars
    symbols = [s for s in symbols if len(s) >= 3]            # min 3 chars (no indices)
    junk_suffixes = ('W', 'R', 'U', 'Q', 'Z')                # warrants/rights/units/bankrupt
    symbols = [s for s in symbols if not s.endswith(junk_suffixes)]
    print(f"Pre-filtered to {len(symbols)} symbols.")
    return symbols


def batch_download(symbols):
    """
    Download 1-month daily OHLCV in batches of YF_BATCH_SIZE (100).
    Uses serial mode (threads=False) + retry logic to avoid rate limits.
    Returns dict: { ticker -> {'price': float, 'avg_dollar_vol': float} }
    """
    print(f"Batch downloading price/volume for {len(symbols)} symbols "
          f"(batches of {YF_BATCH_SIZE}, ~{len(symbols) // YF_BATCH_SIZE + 1} total)...")
    results = {}
    batches = [symbols[i:i + YF_BATCH_SIZE] for i in range(0, len(symbols), YF_BATCH_SIZE)]
    total   = len(batches)

    for batch_num, batch in enumerate(batches):
        print(f"  Batch {batch_num + 1}/{total} ({len(batch)} symbols)...")

        raw = yf_download_with_retry(" ".join(batch))
        if raw is None or raw.empty:
            print(f"  Batch {batch_num + 1} returned no data, skipping.")
            time.sleep(YF_BATCH_PAUSE)
            continue

        for ticker in batch:
            try:
                if len(batch) == 1:
                    # Single-ticker download has flat (non-MultiIndex) columns
                    close  = raw["Close"].dropna()
                    volume = raw["Volume"].dropna()
                else:
                    if ticker not in raw.columns.get_level_values(0):
                        continue
                    close  = raw[ticker]["Close"].dropna()
                    volume = raw[ticker]["Volume"].dropna()

                if close.empty or volume.empty:
                    continue

                price       = float(close.iloc[-1])
                avg_vol_10d = float(volume.iloc[-10:].mean()) if len(volume) >= 10 else float(volume.mean())
                dollar_vol  = price * avg_vol_10d

                if price >= 2.0:
                    results[ticker] = {
                        'price':          price,
                        'avg_dollar_vol': dollar_vol,
                    }
            except Exception:
                continue

        # Pause between batches — the single most effective rate-limit prevention
        pause = YF_BATCH_PAUSE + random.uniform(0, 2)
        time.sleep(pause)

    print(f"Price/volume data retrieved for {len(results)} symbols.")
    return results


def apply_gates(symbols):
    """
    Two-stage gate:
      Gate 1 (batched yf.download): price >= $2 AND dollar volume >= $250K
      Gate 2 (per-ticker fast_info): $25M <= market cap <= $2B

    Gate 2 is only called on price/volume survivors (~500–800 tickers),
    keeping total fast_info calls manageable.
    """
    symbols = prefilter(symbols)

    # Gate 1 — batched price/volume
    price_vol  = batch_download(symbols)
    vol_passed = [s for s, v in price_vol.items() if v['avg_dollar_vol'] >= 250_000]
    print(f"{len(vol_passed)} symbols passed price/volume gate.")

    # Gate 2 — market cap, 52W range, sector, industry, name per surviving ticker
    candidates = []
    print(f"Fetching market cap, sector, and name for {len(vol_passed)} survivors...")

    for i, symbol in enumerate(vol_passed):
        ticker_data = yf_ticker_data_with_retry(symbol)
        if ticker_data is None:
            continue

        try:
            fi          = ticker_data['fast_info']
            cap_m       = (fi.market_cap or 0) / 1_000_000
            week52_low  = fi.year_low  or 0
            week52_high = fi.year_high or 0
            price       = price_vol[symbol]['price']
            dollar_vol  = price_vol[symbol]['avg_dollar_vol']

            pct_above_52w_low = (
                round((price - week52_low) / week52_low * 100, 2)
                if week52_low > 0 else None
            )

            if 25 <= cap_m <= 2000:
                print(f"  PASSED: {symbol} | ${price:.2f} | ${cap_m:.0f}M | {ticker_data['sector'] or 'n/a'}")
                candidates.append({
                    'ticker':             symbol,
                    'company_name':       ticker_data['name'],
                    'sector':             ticker_data['sector'],
                    'industry':           ticker_data['industry'],
                    'price':              price,
                    'market_cap':         cap_m,
                    'avg_dollar_vol_20d': dollar_vol,
                    'week52_low':         week52_low,
                    'week52_high':        week52_high,
                    'pct_above_52w_low':  pct_above_52w_low,
                })
        except Exception as e:
            print(f"  Error processing {symbol}: {e}")
            continue

        # Pause every 25 ticker calls — Yahoo's per-connection limit is low
        if i > 0 and i % 25 == 0:
            pause = 5 + random.uniform(0, 3)
            print(f"  ({i}/{len(vol_passed)}) Pausing {pause:.1f}s...")
            time.sleep(pause)

    print(f"\n{len(candidates)} candidates passed all gates.")
    return pd.DataFrame(candidates)


# ── PHASE 2: SEC FUNDAMENTALS ────────────────────────────

ANNUAL_DURATION_DAYS = (330, 380)
FILED_FORMS = ('10-Q', '10-Q/A', '10-K', '10-K/A', '20-F', '20-F/A')
ANNUAL_FORMS = ('10-K', '10-K/A', '20-F', '20-F/A')


def _sec_date(value):
    try:
        return date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def annual_gaap_pair(facts, tags):
    """Latest and prior comparable annual values for the freshest matching tag.

    Companyfacts carries quarterly and year-to-date facts inside 10-K filings,
    so form alone does not establish an annual period. Require an annual
    duration and dedupe repeated/restated periods by keeping the newest filing.
    """
    gaap = facts.get('facts', {}).get('us-gaap', {})
    candidates = []

    for tag_order, tag in enumerate(tags):
        units = gaap.get(tag, {}).get('units', {}).get('USD', [])
        periods = {}
        for unit in units:
            if unit.get('form') not in ANNUAL_FORMS or unit.get('val') is None:
                continue
            start = _sec_date(unit.get('start'))
            end = _sec_date(unit.get('end'))
            if not start or not end:
                continue
            duration = (end - start).days
            if not (ANNUAL_DURATION_DAYS[0] <= duration <= ANNUAL_DURATION_DAYS[1]):
                continue

            filed = unit.get('filed') or ''
            if end not in periods or filed > periods[end][1]:
                periods[end] = (unit['val'], filed)

        if periods:
            ordered = sorted((end, value) for end, (value, _) in periods.items())
            candidates.append((ordered[-1][0], len(ordered), -tag_order, ordered))

    if not candidates:
        return np.nan, np.nan

    ordered = max(candidates, key=lambda candidate: candidate[:3])[3]
    latest_end, latest = ordered[-1]
    prior_target = latest_end - timedelta(days=365)
    prior_candidates = [
        (abs((end - prior_target).days), value)
        for end, value in ordered[:-1]
        if abs((end - prior_target).days) <= 45
    ]
    previous = min(prior_candidates, default=(None, np.nan), key=lambda item: item[0])[1]
    return latest, previous


def instant_gaap_pair(facts, tags):
    """Latest balance-sheet value and the comparable prior-year instant."""
    gaap = facts.get('facts', {}).get('us-gaap', {})
    candidates = []

    for tag_order, tag in enumerate(tags):
        units = gaap.get(tag, {}).get('units', {}).get('USD', [])
        periods = {}
        for unit in units:
            if unit.get('form') not in FILED_FORMS or unit.get('val') is None:
                continue
            end = _sec_date(unit.get('end'))
            if not end:
                continue
            filed = unit.get('filed') or ''
            if end not in periods or filed > periods[end][1]:
                periods[end] = (unit['val'], filed)

        if periods:
            ordered = sorted((end, value) for end, (value, _) in periods.items())
            candidates.append((ordered[-1][0], len(ordered), -tag_order, ordered))

    if not candidates:
        return np.nan, np.nan

    ordered = max(candidates, key=lambda candidate: candidate[:3])[3]
    latest_end, latest = ordered[-1]
    prior_target = latest_end - timedelta(days=365)
    prior_candidates = [
        (abs((end - prior_target).days), value)
        for end, value in ordered[:-1]
        if abs((end - prior_target).days) <= 45
    ]
    previous = min(prior_candidates, default=(None, np.nan), key=lambda item: item[0])[1]
    return latest, previous


def fetch_sec_fundamentals(df_candidates, cik_map):
    """
    Fetch XBRL fundamentals from SEC EDGAR for each candidate.
    cik_map reused from get_us_universe() — no second SEC fetch needed.
    """
    rows      = []
    tickers   = df_candidates['ticker'].tolist()
    attempted = len(tickers)
    succeeded = 0
    print(f"Fetching SEC fundamentals for {len(tickers)} candidates...")

    for ticker in tickers:
        cik = cik_map.get(ticker)
        if not cik:
            print(f"  No CIK for {ticker}, skipping.")
            continue
        try:
            res = requests.get(
                f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
                headers=SEC_HEADERS)
            if res.status_code != 200:
                print(f"  SEC error {ticker}: HTTP {res.status_code}")
                continue
            facts = res.json()

            cfo, _            = annual_gaap_pair(facts, ['NetCashProvidedByUsedInOperatingActivities'])
            capex, _          = annual_gaap_pair(facts, ['PaymentsToAcquirePropertyPlantAndEquipment',
                                                         'PaymentsToAcquireProductiveAssets'])
            net_income, _     = annual_gaap_pair(facts, ['NetIncomeLoss'])
            total_assets, total_assets_prev = instant_gaap_pair(facts, ['Assets'])
            book_equity, _    = instant_gaap_pair(facts, ['StockholdersEquity', 'AssetsNet'])
            total_debt, _     = instant_gaap_pair(facts, ['LongTermDebt',
                                                          'LongTermDebtAndCapitalLeaseObligation',
                                                          'DebtAndCapitalLeaseObligations'])
            rev_tags = [
                'RevenueFromContractWithCustomerExcludingAssessedTax',
                'Revenues',
                'SalesRevenueNet',
                'RevenueFromContractWithCustomerIncludingAssessedTax',
            ]
            revenue_current, revenue_prev = annual_gaap_pair(facts, rev_tags)
            # Fetch Operating Income (Proxy for EBITDA)
            op_tags = ['OperatingIncomeLoss', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndExtraordinaryItems']
            op_inc_current, op_inc_prev = annual_gaap_pair(facts, op_tags)

            rows.append({
                'ticker':            ticker,
                'cfo':               cfo,
                'capex':             capex,
                'net_income':        net_income,
                'total_assets':      total_assets,
                'total_assets_prev': total_assets_prev,
                'book_equity':       book_equity,
                'total_debt':        total_debt,
                'revenue_current':   revenue_current,
                'revenue_prev':      revenue_prev,
                'op_inc_current':    op_inc_current, # <-- NEW
                'op_inc_prev':       op_inc_prev,    # <-- NEW
            })
            succeeded += 1
        except Exception as e:
            print(f"  SEC error {ticker}: {e}")

        time.sleep(0.15)  # SEC rate limit: 10 req/sec

    failed = attempted - succeeded
    response_coverage = succeeded / attempted if attempted else 0.0
    stats = {
        'attempted': attempted,
        'succeeded': succeeded,
        'failed': failed,
        'response_coverage': response_coverage,
        'rows_loaded': 0,
    }
    print(f"SEC fundamentals: attempted={attempted} succeeded={succeeded} "
          f"failed={failed} response_coverage={response_coverage:.1%}")
    return pd.DataFrame(rows), stats


# ── PHASE 3: SCORING ─────────────────────────────────────

def score(df):
    df['fcf']            = df['cfo'] - df['capex'].abs()
    df['fcf_yield']      = df['fcf'] / (df['market_cap'] * 1_000_000)
    df['book_to_market'] = df['book_equity'] / (df['market_cap'] * 1_000_000)
    df['roa']            = df['net_income'] / df['total_assets']

    df['asset_growth_yoy'] = np.where(
        df['total_assets_prev'].notna() & (df['total_assets_prev'] != 0),
        (df['total_assets'] - df['total_assets_prev']) / df['total_assets_prev'].abs(),
        0.0
    )
    # Revenue growth YoY (Existing)
    df['revenue_growth'] = np.where(
        df['revenue_prev'].notna() & (df['revenue_prev'] != 0),
        (df['revenue_current'] - df['revenue_prev']) / df['revenue_prev'].abs(),
        np.nan
    )
    # EBITDA Proxy Growth YoY (NEW)
    df['ebitda_growth'] = np.where(
        df['op_inc_prev'].notna() & (df['op_inc_prev'] != 0),
        (df['op_inc_current'] - df['op_inc_prev']) / df['op_inc_prev'].abs(),
        np.nan
    )
    # Relaxed ROA gate: allow down to -5%
    df = df[
        (df['fcf_yield'] > 0) &
        (df['book_to_market'] > 0) &
        (df['roa'] >= -0.05)
    ].copy()

    if df.empty:
        print("No candidates survived the scoring gates.")
        return df

    # Winsorize + percentile rank all 5 factors
    factors = ['fcf_yield', 'book_to_market', 'roa', 'asset_growth_yoy', 'revenue_growth']
    for factor in factors:
        col = df[factor].copy()
        if factor == 'revenue_growth':
            col = col.fillna(col.median())
        lo         = col.quantile(0.05)
        hi         = col.quantile(0.95)
        winsorized = col.clip(lower=lo, upper=hi)
        df[f'{factor}_rank_pct'] = winsorized.rank(pct=True)

    # Composite: FCF(35%) B/M(20%) ROA(15%) AssetGrowth(15%) RevGrowth(15%)
    df['composite_score'] = (
        0.35 * df['fcf_yield_rank_pct']        +
        0.20 * df['book_to_market_rank_pct']   +
        0.15 * df['roa_rank_pct']              +
        0.15 * df['asset_growth_yoy_rank_pct'] +
        0.15 * df['revenue_growth_rank_pct']
    )

    # Quality penalties
    df['quality_penalty'] = 0

    if 'total_debt' in df.columns:
        high_debt = (
            df['total_debt'].notna() &
            df['book_equity'].notna() &
            (df['book_equity'].abs() > 0) &
            (df['total_debt'] / df['book_equity'].abs() > 2.0)
        )
        df.loc[high_debt, 'quality_penalty'] += 1
        if high_debt.sum() > 0:
            print(f"  Quality penalty (high debt D/E>2): {high_debt.sum()} stocks")

    asset_bloat = (df['asset_growth_yoy'] > 0.20) & (df['fcf_yield'] < 0.03)
    df.loc[asset_bloat, 'quality_penalty'] += 1
    if asset_bloat.sum() > 0:
        print(f"  Quality penalty (asset bloat): {asset_bloat.sum()} stocks")

    microcap = df['market_cap'] < 30
    df.loc[microcap, 'quality_penalty'] += 1
    if microcap.sum() > 0:
        print(f"  Quality penalty (micro-cap <$30M): {microcap.sum()} stocks")

    # NEW FLAG: Overbought (Price within 5% of 52-week high)
    near_high = (df['price'].notna()) & (df['week52_high'].notna()) & (df['price'] >= df['week52_high'] * 0.95)
    df.loc[near_high, 'quality_penalty'] += 1
    if near_high.sum() > 0:
        print(f"  Quality penalty (near 52w high): {near_high.sum()} stocks")

    # NEW FLAG: Investment (Asset Growth) > EBITDA Growth
    inv_exc_ebitda = (df['asset_growth_yoy'].notna()) & (df['ebitda_growth'].notna()) & (df['asset_growth_yoy'] > df['ebitda_growth'])
    df.loc[inv_exc_ebitda, 'quality_penalty'] += 1
    if inv_exc_ebitda.sum() > 0:
        print(f"  Quality penalty (Inv > EBITDA growth): {inv_exc_ebitda.sum()} stocks")

    df['composite_score'] = (df['composite_score'] - (df['quality_penalty'] * 0.05)).clip(lower=0)

    df['rank_overall'] = df['composite_score'].rank(ascending=False, method='min').astype(int)
    return df.sort_values('rank_overall')


# ── PHASE 4: DATABASE LOAD ───────────────────────────────

RUN_MANIFEST_SQL = """
    CREATE TABLE IF NOT EXISTS ranked_etl_runs (
        run_date DATE PRIMARY KEY,
        state TEXT NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        data_fresh_at TIMESTAMPTZ,
        attempted INTEGER NOT NULL DEFAULT 0,
        succeeded INTEGER NOT NULL DEFAULT 0,
        failed INTEGER NOT NULL DEFAULT 0,
        sec_response_coverage DOUBLE PRECISION,
        rows_loaded INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
"""

RUN_MANIFEST_UPSERT_SQL = """
    INSERT INTO ranked_etl_runs (
        run_date, state, started_at, finished_at, data_fresh_at,
        attempted, succeeded, failed, sec_response_coverage, rows_loaded,
        error_message, updated_at
    )
    VALUES (
        %s, %s, NOW(),
        CASE WHEN %s = 'running' THEN NULL ELSE NOW() END,
        CASE WHEN %s = 'success' THEN NOW() ELSE NULL END,
        %s, %s, %s, %s, %s, %s, NOW()
    )
    ON CONFLICT (run_date) DO UPDATE SET
        state = EXCLUDED.state,
        started_at = CASE
            WHEN EXCLUDED.state = 'running' THEN NOW()
            ELSE ranked_etl_runs.started_at
        END,
        finished_at = EXCLUDED.finished_at,
        data_fresh_at = COALESCE(
            EXCLUDED.data_fresh_at,
            ranked_etl_runs.data_fresh_at
        ),
        attempted = EXCLUDED.attempted,
        succeeded = EXCLUDED.succeeded,
        failed = EXCLUDED.failed,
        sec_response_coverage = EXCLUDED.sec_response_coverage,
        rows_loaded = EXCLUDED.rows_loaded,
        error_message = EXCLUDED.error_message,
        updated_at = NOW();
"""


def record_run_manifest(state, stats=None, error=None):
    """Upsert the idempotent latest state/freshness record for today's run."""
    if state not in ('running', 'success', 'failure'):
        raise ValueError(f"invalid ranked ETL state: {state}")
    if not DATABASE_URL:
        raise RuntimeError("DATABASE_URL is required for ranked ETL")

    stats = stats or {}
    attempted = int(stats.get('attempted', 0))
    succeeded = int(stats.get('succeeded', 0))
    failed = int(stats.get('failed', 0))
    response_coverage = float(stats.get('response_coverage', 0.0))
    rows_loaded = int(stats.get('rows_loaded', 0))
    error_message = str(error)[:2000] if error is not None else None

    conn = None
    committed = False
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cur = conn.cursor()
        cur.execute(RUN_MANIFEST_SQL)
        cur.execute(
            RUN_MANIFEST_UPSERT_SQL,
            (
                date.today(), state, state, state,
                attempted, succeeded, failed, response_coverage, rows_loaded,
                error_message,
            ),
        )
        conn.commit()
        committed = True
    except Exception:
        if conn:
            try:
                conn.rollback()
            except Exception as rollback_error:
                print(f"Could not roll back ETL manifest write: {rollback_error}")
        raise
    finally:
        if conn:
            if committed:
                conn.close()
            else:
                try:
                    conn.close()
                except Exception as close_error:
                    print(f"Could not close failed ETL manifest connection: {close_error}")

    print(f"ETL manifest: state={state} attempted={attempted} "
          f"succeeded={succeeded} failed={failed} "
          f"response_coverage={response_coverage:.1%} rows_loaded={rows_loaded}")


def load_to_db(df):
    print(f"Loading {len(df)} rows into Neon PostgreSQL...")

    bootstrap_sql = """
        CREATE TABLE IF NOT EXISTS ranked_candidates (
            as_of_date DATE NOT NULL,
            ticker TEXT NOT NULL,
            company_name TEXT,
            sector TEXT,
            industry TEXT,
            market_cap DOUBLE PRECISION,
            price DOUBLE PRECISION,
            avg_dollar_vol_20d DOUBLE PRECISION,
            cfo_ttm DOUBLE PRECISION,
            capex_ttm DOUBLE PRECISION,
            fcf_ttm DOUBLE PRECISION,
            net_income_ttm DOUBLE PRECISION,
            total_assets_latest DOUBLE PRECISION,
            book_equity_latest DOUBLE PRECISION,
            fcf_yield DOUBLE PRECISION,
            book_to_market DOUBLE PRECISION,
            roa DOUBLE PRECISION,
            asset_growth_yoy DOUBLE PRECISION,
            fcf_rank_pct DOUBLE PRECISION,
            bm_rank_pct DOUBLE PRECISION,
            roa_rank_pct DOUBLE PRECISION,
            asset_growth_rank_pct DOUBLE PRECISION,
            composite_score DOUBLE PRECISION,
            rank_overall INTEGER,
            quality_penalty INTEGER DEFAULT 0,
            revenue_growth DOUBLE PRECISION,
            pct_above_52w_low DOUBLE PRECISION,
            week52_low DOUBLE PRECISION,
            week52_high DOUBLE PRECISION,
            total_debt DOUBLE PRECISION,
            PRIMARY KEY (as_of_date, ticker)
        );
    """

    migration_sql = """
        ALTER TABLE ranked_candidates
            ADD COLUMN IF NOT EXISTS quality_penalty     INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS revenue_growth      DOUBLE PRECISION,
            ADD COLUMN IF NOT EXISTS pct_above_52w_low   DOUBLE PRECISION,
            ADD COLUMN IF NOT EXISTS week52_low          DOUBLE PRECISION,
            ADD COLUMN IF NOT EXISTS week52_high         DOUBLE PRECISION,
            ADD COLUMN IF NOT EXISTS total_debt          DOUBLE PRECISION,
            ADD COLUMN IF NOT EXISTS company_name        TEXT,
            ADD COLUMN IF NOT EXISTS sector              TEXT,
            ADD COLUMN IF NOT EXISTS industry            TEXT;
    """

    df['as_of_date'] = date.today()
    df_clean = df.replace({np.nan: None})

    col_map = [
        ('as_of_date',               'as_of_date'),
        ('ticker',                   'ticker'),
        ('company_name',             'company_name'),
        ('sector',                   'sector'),
        ('industry',                 'industry'),
        ('market_cap',               'market_cap'),
        ('price',                    'price'),
        ('avg_dollar_vol_20d',       'avg_dollar_vol_20d'),
        ('cfo',                      'cfo_ttm'),
        ('capex',                    'capex_ttm'),
        ('fcf',                      'fcf_ttm'),
        ('net_income',               'net_income_ttm'),
        ('total_assets',             'total_assets_latest'),
        ('book_equity',              'book_equity_latest'),
        ('fcf_yield',                'fcf_yield'),
        ('book_to_market',           'book_to_market'),
        ('roa',                      'roa'),
        ('asset_growth_yoy',         'asset_growth_yoy'),
        ('fcf_yield_rank_pct',       'fcf_rank_pct'),
        ('book_to_market_rank_pct',  'bm_rank_pct'),
        ('roa_rank_pct',             'roa_rank_pct'),
        ('asset_growth_yoy_rank_pct','asset_growth_rank_pct'),
        ('composite_score',          'composite_score'),
        ('rank_overall',             'rank_overall'),
        ('quality_penalty',          'quality_penalty'),
        ('revenue_growth',           'revenue_growth'),
        ('pct_above_52w_low',        'pct_above_52w_low'),
        ('week52_low',               'week52_low'),
        ('week52_high',              'week52_high'),
        ('total_debt',               'total_debt'),
    ]

    active     = [(py, db) for py, db in col_map if py in df_clean.columns]
    py_cols    = [py for py, _ in active]
    db_cols    = [db for _, db in active]
    records    = [tuple(x) for x in df_clean[py_cols].to_numpy()]
    attempted  = len(records)
    col_str    = ', '.join(db_cols)
    update_set = ', '.join([f"{db} = EXCLUDED.{db}"
                            for db in db_cols if db not in ('as_of_date', 'ticker')])

    insert_sql = f"""
        INSERT INTO ranked_candidates ({col_str})
        VALUES %s
        ON CONFLICT (as_of_date, ticker) DO UPDATE SET {update_set};
    """

    conn = None
    load_committed = False
    try:
        conn = psycopg2.connect(DATABASE_URL)
        cur  = conn.cursor()
        cur.execute(bootstrap_sql)
        cur.execute(migration_sql)
        conn.commit()
        print("Schema bootstrap + migration complete.")
        psycopg2.extras.execute_values(cur, insert_sql, records, page_size=500)
        conn.commit()
        load_committed = True
        print(f"Ranked DB load: attempted={attempted} succeeded={attempted} "
              f"failed=0 coverage={1.0 if attempted else 0.0:.1%}")
    except Exception as e:
        print(f"DB error: {e}")
        print(f"Ranked DB load: attempted={attempted} succeeded=0 "
              f"failed={attempted} coverage=0.0%")
        if conn:
            try:
                conn.rollback()
            except Exception as rollback_error:
                print(f"Could not roll back ranked DB load: {rollback_error}")
        raise
    finally:
        if conn:
            if load_committed:
                conn.close()
            else:
                try:
                    conn.close()
                except Exception as close_error:
                    print(f"Could not close failed ranked DB connection: {close_error}")
    return attempted


# ── MAIN ─────────────────────────────────────────────────

def main():
    print("=== Starting Weekly ETL ===")
    stats = {
        'attempted': 0,
        'succeeded': 0,
        'failed': 0,
        'response_coverage': 0.0,
        'rows_loaded': 0,
    }

    try:
        record_run_manifest('running', stats)

        raw_symbols, cik_map = get_us_universe()
        candidates = apply_gates(raw_symbols)

        if candidates.empty:
            raise RuntimeError("No candidates passed gates")

        sec_data, stats = fetch_sec_fundamentals(candidates, cik_map)
        enforce_sec_response_coverage(stats)
        merged = pd.merge(candidates, sec_data, on='ticker', how='inner')

        ranked = score(merged)

        if ranked.empty:
            raise RuntimeError("No candidates survived scoring")

        print(f"\nTop 10 ranked:")
        print(ranked[['ticker', 'rank_overall', 'composite_score',
                      'fcf_yield', 'revenue_growth',
                      'quality_penalty', 'pct_above_52w_low']].head(10).to_string())

        stats['rows_loaded'] = load_to_db(ranked)
        record_run_manifest('success', stats)
        print("=== ETL Complete ===")
    except Exception as original_error:
        try:
            record_run_manifest('failure', stats, error=original_error)
        except Exception as manifest_error:
            print(f"Could not persist ETL failure manifest: {manifest_error}")
        raise


if __name__ == "__main__":
    main()
