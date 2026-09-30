"""Shared config for poller.py and server.py.

Reads real environment variables first (e.g. set by systemd/a process
manager), then falls back to a local .env file if one exists — a small
hand-rolled loader, not a dependency, so a real env var always wins over
whatever .env has for the same name.
"""

from __future__ import annotations

import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent / ".env"


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


_load_dotenv(ENV_FILE)

# The BYM server this poller talks to. Same default as the map viewers'
# "Stable" server selection. Only public, unauthenticated endpoints are used
# (/api/:v/worlds, /api/:v/leaderboards) — no API key needed.
BYM_BASE_URL = os.environ.get("BYM_BASE_URL", "https://server.bymrefitted.com").rstrip("/")
BYM_API_VERSION = os.environ.get("BYM_API_VERSION", "v1.6.2-beta")

# The leaderboard endpoint is server-side cached for 2 hours (Redis TTL) and
# only recomputed lazily on the first request after that expires — polling
# much faster than that just re-reads the same cached snapshot. Default here
# comfortably clears that TTL so every poll forces a fresh value.
POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", str(2 * 60 * 60)))

# Both leaderboard-related routes share one IP-keyed rate limit bucket
# (30 req/min) with each other. This is a per-request pause, not a budget
# tracker — plenty of headroom for the handful of worlds this polls.
REQUEST_DELAY_SECONDS = float(os.environ.get("REQUEST_DELAY_SECONDS", "1.5"))

# How long polled history is kept before poller.py's maybe_prune() drops it —
# we don't need this data forever, just enough to look back a few months.
RETENTION_DAYS = int(os.environ.get("RETENTION_DAYS", "90"))

# server.py / dev_server.py
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8082"))
STATIC_DIR = os.environ.get("STATIC_DIR", str(Path(__file__).resolve().parent / "app" / "static"))
