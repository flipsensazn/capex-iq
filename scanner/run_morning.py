"""Morning pipeline orchestrator for GitHub Actions.

GitHub cron is UTC and can't follow US daylight saving, so the workflow
fires at both 12:30 and 13:30 UTC; this guard runs the pipeline only for
the fire that lands in the 8:00–9:15am ET window, and only on live trading
days (Yahoo's SPY calendar knows the holidays).

Then: premarket gappers scan -> TJL evaluation -> KV push + Telegram.
"""
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tjl_scan import spy_session  # noqa: E402


def guards_pass():
    if os.environ.get("FORCE_RUN"):
        print("FORCE_RUN set — skipping window/holiday guards")
        return True
    reg_start, _, gmtoffset = spy_session()
    now = time.time()

    # Holiday check: the next regular session must start within 2 hours
    # (at 8:30am ET, today's 9:30 open is 1h away; on a holiday the next
    # session is at least a day out, and after the open this is negative).
    if not (0 < reg_start - now < 2 * 3600):
        print("skip: not in the pre-open window of a live trading day "
              f"(reg_start={reg_start}, now={int(now)})")
        return False

    # DST disambiguation: of the two UTC fires, run only the 8:00-9:15am ET one
    et_seconds = (int(now) + gmtoffset) % 86400
    if not (8 * 3600 <= et_seconds <= 9 * 3600 + 15 * 60):
        print(f"skip: wrong DST fire (ET seconds-of-day {et_seconds})")
        return False
    return True


def main():
    if not guards_pass():
        return

    print("running premarket gappers scan...")
    res = subprocess.run(["bash", str(HERE / "premarket_gappers.sh")], cwd=str(HERE))
    if res.returncode != 0:
        print(f"ERROR: gappers scan failed (exit {res.returncode})")
        sys.exit(1)

    print("running TJL evaluation...")
    res = subprocess.run([sys.executable, str(HERE / "tjl_scan.py")], cwd=str(HERE))
    sys.exit(res.returncode)


if __name__ == "__main__":
    main()
