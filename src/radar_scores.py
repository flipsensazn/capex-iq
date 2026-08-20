"""Weekly Radar quality and technical score snapshots.

The heavy companyfacts payloads are fetched and handed to the Node scorer in
bounded chunks.  JavaScript remains the single implementation of the Research
scoring methodology; this module owns provider orchestration, run health, and
durable Neon snapshots.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import psycopg2
import psycopg2.extras
import requests

from etl_health import (
    CoverageError,
    RunStats,
    begin_run,
    finish_run,
    record_failure_safely,
    ticker_limit_from_env,
)
from transcript_stress import HYPERSCALERS, connect_db, get_universe


DATABASE_URL = os.environ.get("DATABASE_URL")
WATCHLIST_BASE_URL = (os.environ.get("WATCHLIST_BASE_URL") or "").rstrip("/")

SEC_HEADERS = {"User-Agent": "WizzlesWatchlist flipsensazn@gmail.com"}
SEC_PAUSE = 0.15
YAHOO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}
YAHOO_PAUSE = 0.2
FUND_PROFILE_PAUSE = 0.3
FUND_PROFILE_MODULES = "fundProfile,defaultKeyStatistics,summaryDetail"
ETF_NAME_PATTERN = re.compile(r"\bETF\b", re.IGNORECASE)

CHUNK_SIZE = 25
PIPELINE = "radar_scores"
METHODOLOGY_VERSION = "radar-v2"
REPO_ROOT = Path(__file__).resolve().parents[1]
SCORER_PATH = REPO_ROOT / "scripts" / "radar_score.mjs"

MAP_ENDPOINTS = (
    ("ai", "/capex"),
    ("musk", "/musk-capex"),
    ("robotics", "/robotics-capex"),
)


def _map_tickers(capex_data):
    """Flatten one validated live map using transcript_stress's map shape."""
    return [
        ticker
        for track in capex_data.get("tracks", [])
        for subsector in track.get("subsectors", [])
        for ticker in subsector.get("tickers", [])
    ]


def fetch_live_maps(base_url=None):
    """Return all three live map payloads or hard-fail the Radar run."""
    if base_url is None:
        # Read the environment at call time so tests and workflow-dispatch runs
        # cannot accidentally inherit an import-time fallback.
        base_url = (os.environ.get("WATCHLIST_BASE_URL") or "").rstrip("/")
    else:
        base_url = str(base_url).rstrip("/")
    if not base_url:
        raise SystemExit("WATCHLIST_BASE_URL not set; Radar requires live maps.")

    live_maps = {}
    for chain, path in MAP_ENDPOINTS:
        try:
            response = requests.get(f"{base_url}{path}", timeout=20)
            response.raise_for_status()
            capex_data = response.json().get("capexData")
            if not isinstance(capex_data, dict) or not capex_data.get("tracks"):
                raise ValueError("response has no capexData.tracks")
            if not _map_tickers(capex_data):
                raise ValueError("map contains no tickers")
        except Exception as error:
            raise SystemExit(f"{path} live map fetch failed: {error}") from error
        live_maps[chain] = capex_data
    return live_maps


def authoritative_universe(live_maps, ticker_limit=0, base_url=None):
    """Run the shared universe builder against the maps already hard-validated.

    ``transcript_stress.get_universe`` normally performs a second network fetch
    and silently falls back on failure.  Temporarily binding its map reader to
    these payloads preserves the shared dedupe/order logic while making the
    validated live maps authoritative.  Radar applies its own limit exactly
    once after that full universe is built.
    """
    provider_globals = getattr(get_universe, "__globals__", None)
    if provider_globals is None or "_map_tickers" not in provider_globals:
        # Keeps the helper straightforward to unit-test when get_universe is a
        # mock, while production always takes the guarded branch below.
        universe = list(get_universe())
    else:
        originals = {
            name: provider_globals.get(name)
            for name in ("_map_tickers", "WATCHLIST_BASE_URL", "TICKER_LIMIT")
        }
        chain_by_path = {path: chain for chain, path in MAP_ENDPOINTS}

        def from_validated_map(path):
            return list(_map_tickers(live_maps[chain_by_path[path]]))

        try:
            provider_globals["_map_tickers"] = from_validated_map
            provider_globals["WATCHLIST_BASE_URL"] = base_url or "radar-live-maps"
            provider_globals["TICKER_LIMIT"] = 0
            universe = list(get_universe())
        finally:
            provider_globals.update(originals)

    universe = list(dict.fromkeys(
        str(ticker).strip().upper() for ticker in universe if str(ticker).strip()
    ))
    if ticker_limit > 0:
        universe = universe[:ticker_limit]
        print(f"TICKER_LIMIT={ticker_limit} - restricting Radar run to {universe}")
    return universe


def build_universe_metadata(universe, live_maps):
    """Build ordered chain and ``Track / Subsector`` membership per ticker."""
    metadata = {
        ticker: {"chains": [], "chain_count": 0, "memberships": {}}
        for ticker in universe
    }

    for chain, _path in MAP_ENDPOINTS:
        capex_data = live_maps[chain]
        for track in capex_data.get("tracks", []):
            track_label = str(track.get("label") or track.get("id") or "").strip()
            for subsector in track.get("subsectors", []):
                subsector_label = str(
                    subsector.get("label") or subsector.get("id") or ""
                ).strip()
                membership = f"{track_label} / {subsector_label}"
                for raw_ticker in subsector.get("tickers", []):
                    ticker = str(raw_ticker).strip().upper()
                    entry = metadata.get(ticker)
                    if entry is None:
                        continue
                    if chain not in entry["chains"]:
                        entry["chains"].append(chain)
                    memberships = entry["memberships"].setdefault(chain, [])
                    if membership not in memberships:
                        memberships.append(membership)

    for raw_ticker in HYPERSCALERS:
        ticker = str(raw_ticker).strip().upper()
        entry = metadata.get(ticker)
        if entry is None:
            continue
        if "ai" not in entry["chains"]:
            entry["chains"].insert(0, "ai")
        if not entry["memberships"].get("ai"):
            entry["memberships"]["ai"] = ["Hyperscalers / Hyperscalers"]

    chain_order = {chain: index for index, (chain, _path) in enumerate(MAP_ENDPOINTS)}
    for entry in metadata.values():
        entry["chains"].sort(key=chain_order.__getitem__)
        entry["chain_count"] = len(entry["chains"])
    return metadata


def get_cik_map():
    response = requests.get(
        "https://www.sec.gov/files/company_tickers.json",
        headers=SEC_HEADERS,
        timeout=30,
    )
    response.raise_for_status()
    return {
        str(value["ticker"]).upper(): str(value["cik_str"]).zfill(10)
        for value in response.json().values()
    }


def fetch_companyfacts(cik):
    response = requests.get(
        f"https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json",
        headers=SEC_HEADERS,
        timeout=60,
    )
    if response.status_code == 404:
        return None
    response.raise_for_status()
    return response.json()


def _fetch_chart_with_meta(ticker):
    encoded_ticker = quote(ticker, safe="")
    response = requests.get(
        "https://query1.finance.yahoo.com/v8/finance/chart/"
        f"{encoded_ticker}?range=2y&interval=1d",
        headers=YAHOO_HEADERS,
        timeout=30,
    )
    response.raise_for_status()
    payload = response.json().get("chart") or {}
    results = payload.get("result") or []
    if not results:
        raise ValueError(payload.get("error") or "Yahoo chart has no result")
    result = results[0]
    meta = result.get("meta") or {}
    instrument_type = meta.get("instrumentType")
    short_name = meta.get("shortName")
    long_name = meta.get("longName")
    quotes = ((result.get("indicators") or {}).get("quote") or [])
    if not quotes:
        return None, instrument_type, short_name, long_name
    timestamps = result.get("timestamp") or []
    quote_data = quotes[0]
    closes = quote_data.get("close") or []
    if not timestamps or not closes:
        return None, instrument_type, short_name, long_name
    return (
        {"timestamps": timestamps, "quote": quote_data},
        instrument_type,
        short_name,
        long_name,
    )


def fetch_chart(ticker):
    chart, instrument_type, _short_name, _long_name = _fetch_chart_with_meta(
        ticker
    )
    return chart, instrument_type


def get_yahoo_session():
    """Create one cookie-and-crumb Yahoo session for fund profile requests."""
    session = requests.Session()
    session.headers.update(YAHOO_HEADERS)
    # Yahoo commonly returns a non-success status here while still setting the
    # cookies needed by getcrumb, so intentionally do not raise on this response.
    session.get("https://fc.yahoo.com", timeout=30)
    crumb_response = session.get(
        "https://query1.finance.yahoo.com/v1/test/getcrumb",
        timeout=30,
    )
    crumb_response.raise_for_status()
    crumb = crumb_response.text.strip()
    if not crumb:
        raise ValueError("Yahoo returned an empty crumb")
    return session, crumb


def _yahoo_raw(value):
    """Unwrap Yahoo's numeric ``{raw, fmt}`` shape."""
    if isinstance(value, dict):
        return value.get("raw")
    return value


def fetch_fund_profile(ticker, session, crumb):
    """Fetch the requested Yahoo quoteSummary fields for one fund."""
    encoded_ticker = quote(ticker, safe="")
    response = session.get(
        "https://query1.finance.yahoo.com/v10/finance/quoteSummary/"
        f"{encoded_ticker}",
        params={"modules": FUND_PROFILE_MODULES, "crumb": crumb},
        timeout=30,
    )
    response.raise_for_status()
    quote_summary = response.json().get("quoteSummary") or {}
    if quote_summary.get("error"):
        raise ValueError(f"Yahoo quoteSummary error: {quote_summary['error']}")
    results = quote_summary.get("result") or []
    if not results or not isinstance(results[0], dict):
        raise ValueError("Yahoo quoteSummary has no result")

    result = results[0]
    fund_profile = result.get("fundProfile") or {}
    fees = fund_profile.get("feesExpensesInvestment") or {}
    key_statistics = result.get("defaultKeyStatistics") or {}
    summary_detail = result.get("summaryDetail") or {}

    expense_ratio = _yahoo_raw(fees.get("annualReportExpenseRatio"))
    if expense_ratio is None:
        expense_ratio = _yahoo_raw(
            key_statistics.get("annualReportExpenseRatio")
        )
    return {
        "expenseRatio": expense_ratio,
        "totalAssets": _yahoo_raw(summary_detail.get("totalAssets")),
        "category": fund_profile.get("categoryName"),
        "yield": _yahoo_raw(summary_detail.get("yield")),
        "legalType": fund_profile.get("legalType"),
    }


def _has_etf_name(result):
    for key in ("shortName", "longName"):
        name = result.get(key)
        if isinstance(name, str) and ETF_NAME_PATTERN.search(name):
            return True
    return False


def enrich_fund_profiles(results, stats):
    """Detect no-CIK funds and attach profiles without dropping a row."""
    profile_requests = []
    for result in results:
        result["fund_profile"] = None
        if result.get("error"):
            continue
        if result.get("coverage") == "fund":
            profile_requests.append((result, True))
        elif (
            result.get("coverage") == "no_filings"
            and result.get("hasCik") is False
        ):
            profile_requests.append((result, False))
    if not profile_requests:
        return results

    try:
        session, crumb = get_yahoo_session()
    except Exception as error:
        for result, known_fund in profile_requests:
            if not known_fund and _has_etf_name(result):
                result["coverage"] = "fund"
            stats.degraded += 1
            print(
                f"{result.get('ticker')}: Yahoo fund profile unavailable "
                f"({error})"
            )
        return results

    for index, (result, known_fund) in enumerate(profile_requests):
        if index:
            time.sleep(FUND_PROFILE_PAUSE)
        try:
            profile = fetch_fund_profile(
                result["ticker"], session, crumb
            )
        except Exception as error:
            if not known_fund and _has_etf_name(result):
                result["coverage"] = "fund"
            stats.degraded += 1
            print(
                f"{result.get('ticker')}: Yahoo fund profile unavailable "
                f"({error})"
            )
            continue

        if known_fund:
            result["fund_profile"] = profile
        elif isinstance(profile, dict) and (
            profile.get("legalType") or profile.get("category")
        ):
            result["coverage"] = "fund"
            result["fund_profile"] = profile
        elif _has_etf_name(result):
            result["coverage"] = "fund"
            stats.degraded += 1
            print(
                f"{result.get('ticker')}: Yahoo fund profile unavailable "
                "(missing legalType/category)"
            )
    return results


def build_scorer_input(ticker, metadata, cik_map):
    """Fetch one ticker's provider inputs; SEC failures remain fatal per row."""
    companyfacts = None
    cik = cik_map.get(ticker)
    if cik:
        try:
            companyfacts = fetch_companyfacts(cik)
        finally:
            time.sleep(SEC_PAUSE)

    chart = None
    instrument_type = None
    short_name = None
    long_name = None
    try:
        chart, instrument_type, short_name, long_name = (
            _fetch_chart_with_meta(ticker)
        )
    except Exception as error:
        # Chart absence is an allowed partial input: quality can still score and
        # the JavaScript module will renormalize technical components.
        print(f"{ticker}: Yahoo chart unavailable ({error}) - quality only")
    finally:
        time.sleep(YAHOO_PAUSE)

    entry = metadata[ticker]
    return {
        "ticker": ticker,
        "companyfacts": companyfacts,
        "chart": chart,
        "chains": list(entry["chains"]),
        "memberships": {
            chain: list(memberships)
            for chain, memberships in entry["memberships"].items()
        },
        "instrumentType": instrument_type,
        "hasCik": bool(cik),
        "shortName": short_name,
        "longName": long_name,
    }


def score_chunk(records):
    """Run the dependency-free Node scorer for one bounded JSONL chunk."""
    if not records:
        return []
    with tempfile.TemporaryDirectory(prefix="radar-score-") as temp_dir:
        input_path = Path(temp_dir) / "input.jsonl"
        output_path = Path(temp_dir) / "output.jsonl"
        with input_path.open("w", encoding="utf-8", newline="\n") as input_file:
            for record in records:
                json.dump(
                    record,
                    input_file,
                    separators=(",", ":"),
                    ensure_ascii=False,
                )
                input_file.write("\n")
        subprocess.run(
            ["node", str(SCORER_PATH), str(input_path), str(output_path)],
            check=True,
            capture_output=True,
            text=True,
            timeout=300,
        )
        output_lines = [
            line for line in output_path.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    if len(output_lines) != len(records):
        raise RuntimeError(
            f"Radar scorer returned {len(output_lines)} rows for {len(records)} inputs"
        )
    results = [json.loads(line) for line in output_lines]
    for record, result in zip(records, results):
        if result.get("ticker") != record.get("ticker"):
            raise RuntimeError(
                "Radar scorer output order/ticker mismatch: "
                f"expected {record.get('ticker')}, got {result.get('ticker')}"
            )
    return results


def _chunks(values, size):
    batch = []
    for value in values:
        batch.append(value)
        if len(batch) == size:
            yield batch
            batch = []
    if batch:
        yield batch


def score_records_in_chunks(records, chunk_size=CHUNK_SIZE, on_chunk_error=None):
    """Score an iterable while retaining at most ``chunk_size`` input rows."""
    results = []
    for batch in _chunks(records, chunk_size):
        try:
            batch_results = score_chunk(batch)
            for record, result in zip(batch, batch_results):
                for key in ("hasCik", "shortName", "longName"):
                    if key in record:
                        result[key] = record[key]
            results.extend(batch_results)
        except Exception as error:
            if on_chunk_error is None:
                raise
            on_chunk_error(batch, error)
    return results


def scorer_inputs(universe, metadata, cik_map, stats):
    """Yield provider inputs lazily so completed chunks release companyfacts."""
    for index, ticker in enumerate(universe, 1):
        stats.attempted += 1
        try:
            yield build_scorer_input(ticker, metadata, cik_map)
        except Exception as error:
            stats.transient_failures += 1
            print(f"[{index}/{len(universe)}] {ticker}: SEC fetch error - {error}")


def apply_result_stats(stats, results):
    """Map scorer coverage states into the shared ETL-health counters."""
    valid_results = []
    coverage_counts = {"scored": 0, "no_filings": 0, "fund": 0, "error": 0}
    for result in results:
        coverage = result.get("coverage")
        if result.get("error") or coverage not in {"scored", "no_filings", "fund"}:
            stats.transient_failures += 1
            coverage_counts["error"] += 1
            continue
        valid_results.append(result)
        coverage_counts[coverage] += 1
        if coverage == "scored":
            stats.usable += 1
        else:
            stats.known_no_data += 1
    stats.details["coverage"] = coverage_counts
    return valid_results


def radar_row(result, as_of_date):
    quality = result.get("qualityScore")
    technical = result.get("technicalScore")
    return (
        result["ticker"],
        as_of_date,
        result["coverage"],
        quality.get("score") if quality else None,
        psycopg2.extras.Json(quality.get("components")) if quality else None,
        technical.get("score") if technical else None,
        psycopg2.extras.Json(technical.get("components")) if technical else None,
        int(result.get("chainCount") or 0),
        list(result.get("chains") or []),
        psycopg2.extras.Json(result.get("memberships") or {}),
        (
            psycopg2.extras.Json(result["fund_profile"])
            if result.get("fund_profile") is not None
            else None
        ),
        result.get("price"),
        result.get("marketCap"),
        result.get("fiscalYearBasis"),
        result.get("methodologyVersion"),
        result.get("methodologySignature"),
        result.get("inputSignature"),
    )


BOOTSTRAP_SQL = """
    CREATE TABLE IF NOT EXISTS radar_scores (
        ticker TEXT NOT NULL, as_of_date DATE NOT NULL,
        coverage TEXT NOT NULL,
        quality_score NUMERIC, quality_components JSONB,
        technical_score NUMERIC, technical_components JSONB,
        chain_count INTEGER NOT NULL, chains TEXT[] NOT NULL, memberships JSONB,
        fund_profile JSONB,
        price NUMERIC, market_cap NUMERIC, fiscal_year_basis INTEGER,
        methodology_version TEXT, methodology_signature TEXT, input_signature TEXT,
        computed_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (ticker, as_of_date)
    );
"""


MIGRATION_SQL = """
    ALTER TABLE radar_scores
        ADD COLUMN IF NOT EXISTS fund_profile JSONB;
"""


UPSERT_SQL = """
    INSERT INTO radar_scores
        (ticker, as_of_date, coverage,
         quality_score, quality_components,
         technical_score, technical_components,
         chain_count, chains, memberships,
         fund_profile,
         price, market_cap, fiscal_year_basis,
         methodology_version, methodology_signature, input_signature)
    VALUES %s
    ON CONFLICT (ticker, as_of_date) DO UPDATE SET
        coverage = EXCLUDED.coverage,
        quality_score = EXCLUDED.quality_score,
        quality_components = EXCLUDED.quality_components,
        technical_score = EXCLUDED.technical_score,
        technical_components = EXCLUDED.technical_components,
        chain_count = EXCLUDED.chain_count,
        chains = EXCLUDED.chains,
        memberships = EXCLUDED.memberships,
        fund_profile = EXCLUDED.fund_profile,
        price = EXCLUDED.price,
        market_cap = EXCLUDED.market_cap,
        fiscal_year_basis = EXCLUDED.fiscal_year_basis,
        methodology_version = EXCLUDED.methodology_version,
        methodology_signature = EXCLUDED.methodology_signature,
        input_signature = EXCLUDED.input_signature,
        computed_at = now()
    WHERE radar_scores.methodology_signature IS NOT DISTINCT FROM
              EXCLUDED.methodology_signature
       OR radar_scores.input_signature IS DISTINCT FROM EXCLUDED.input_signature
    RETURNING ticker;
"""


def persist_radar_rows(conn, rows):
    """Persist candidates and return only tickers written by the guarded UPSERT."""
    if not rows:
        return []
    with conn.cursor() as cursor:
        persisted = psycopg2.extras.execute_values(
            cursor,
            UPSERT_SQL,
            rows,
            page_size=200,
            fetch=True,
        )
    conn.commit()
    return persisted or []


def main():
    print("=== Radar Scores ETL ===")
    # This happens before get_universe or any DB writes: Radar never starts from
    # transcript_stress's embedded fallback ticker lists.
    live_maps = fetch_live_maps()
    database_url = os.environ.get("DATABASE_URL") or DATABASE_URL
    if not database_url:
        raise SystemExit("DATABASE_URL not set.")
    ticker_limit = ticker_limit_from_env(os.environ)
    base_url = (os.environ.get("WATCHLIST_BASE_URL") or "").rstrip("/")
    universe = authoritative_universe(
        live_maps, ticker_limit=ticker_limit, base_url=base_url
    )
    metadata = build_universe_metadata(universe, live_maps)
    as_of_date = datetime.now(timezone.utc).date()
    stats = RunStats(expected=len(universe))
    context = None

    conn = connect_db(database_url)
    try:
        with conn.cursor() as cursor:
            cursor.execute(BOOTSTRAP_SQL)
            cursor.execute(MIGRATION_SQL)
        conn.commit()
        context = begin_run(
            conn,
            PIPELINE,
            expected=len(universe),
            details={
                "limitedRun": ticker_limit > 0,
                "methodology": METHODOLOGY_VERSION,
            },
        )

        try:
            cik_map = get_cik_map()
        except Exception:
            stats.attempted = len(universe)
            stats.transient_failures = len(universe)
            raise

        def chunk_failed(batch, error):
            stats.transient_failures += len(batch)
            tickers = ", ".join(record["ticker"] for record in batch)
            print(f"Radar scorer failed for [{tickers}]: {error}")

        results = score_records_in_chunks(
            scorer_inputs(universe, metadata, cik_map, stats),
            on_chunk_error=chunk_failed,
        )
        enrich_fund_profiles(results, stats)
        valid_results = apply_result_stats(stats, results)
        rows = [radar_row(result, as_of_date) for result in valid_results]
        persisted = persist_radar_rows(conn, rows)
        stats.details.update({
            "rowsAttempted": len(rows),
            "rowsWritten": len(persisted),
            "sameDayGuardedRows": len(rows) - len(persisted),
        })
        print(
            f"{len(persisted)}/{len(rows)} Radar snapshots written for "
            f"{as_of_date.isoformat()}."
        )
        finish_run(
            conn,
            context,
            stats,
            limited_run=ticker_limit > 0,
        )
    except CoverageError:
        raise
    except Exception as error:
        if stats.transient_failures == 0:
            stats.transient_failures = 1
        record_failure_safely(conn, context, stats, error)
        raise
    finally:
        conn.close()

    print("=== Radar Scores ETL complete ===")
    return stats


if __name__ == "__main__":
    main()
