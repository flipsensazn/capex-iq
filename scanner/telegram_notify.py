"""Telegram notification helper for the scanner pipeline.

Reads TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID from .env next to this file
and sends messages via curl. Never raises and never prints the token —
a delivery failure is logged to stdout and swallowed so a notification
problem can't break a scan.
"""
import os
import subprocess
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def _load_env():
    # Real environment variables win (GitHub Actions secrets); .env file is
    # the fallback for local runs.
    creds = {}
    env_file = HERE / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                creds[k.strip()] = v.strip().strip('"').strip("'")
    for k in ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"):
        if os.environ.get(k):
            creds[k] = os.environ[k]
    return creds


def send(text):
    """Send a Markdown message to the configured Telegram chat. Returns True on success."""
    creds = _load_env()
    token = creds.get("TELEGRAM_BOT_TOKEN")
    chat_id = creds.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        print("telegram: missing TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID in .env — skipping")
        return False
    tmp_path = None
    try:
        # Windows curl takes argv in the local codepage, so emoji/Unicode in
        # the message body get mangled. Pass the text via a UTF-8 file instead.
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", suffix=".txt",
                                         delete=False) as tmp:
            tmp.write(text)
            tmp_path = tmp.name
        res = subprocess.run(
            ["curl", "-s", f"https://api.telegram.org/bot{token}/sendMessage",
             "-d", f"chat_id={chat_id}",
             "--data-urlencode", f"text@{tmp_path}",
             "-d", "parse_mode=Markdown"],
            capture_output=True, text=True, timeout=30)
        if res.returncode == 0 and '"ok":true' in res.stdout:
            print("telegram: sent")
            return True
        # Telegram's error response doesn't include the token; safe to log
        print(f"telegram: send failed (exit={res.returncode}): {res.stdout[:200]}")
        return False
    except Exception as e:
        print(f"telegram: send failed: {e}")
        return False
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
