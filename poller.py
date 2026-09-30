"""Polls the BYM public leaderboard API for every MR2 and MR3 world and keeps
SQLite in sync. No API key needed — /api/:v/worlds and /api/:v/leaderboards
are public, unauthenticated, IP-rate-limited routes (30 req/min, shared
between the two).

Runs forever: every POLL_INTERVAL_SECONDS, refreshes the world list, then
polls each world's player leaderboard (MR2: top 100 by outposts, MR3: top 25
by outposts+strongholds — the API caps both) and stores a new poll batch,
skipped if identical to the last stored batch for that world so quiet worlds
don't bloat storage.

The leaderboard endpoint itself is server-side cached for 2 hours (Redis
TTL) and only recomputed lazily on the first request after that expires —
polling much faster than that just re-reads the same cached snapshot.
"""

from __future__ import annotations

import gzip
import json
import time
import traceback
import urllib.error
import urllib.request
from datetime import datetime, timezone

import db
from config import BYM_BASE_URL, BYM_API_VERSION, POLL_INTERVAL_SECONDS, REQUEST_DELAY_SECONDS, RETENTION_DAYS

SUPPORTED_MAP_VERSIONS = (2, 3)

# Deleting old polls churns leaderboard_entries' free pages (SQLite doesn't
# reclaim them on its own) — VACUUM afterward keeps the file size in check.
# Both run at most once per interval, right after a poll cycle, so they never
# compete with an in-progress poll's writes.
PRUNE_INTERVAL_SECONDS = 24 * 60 * 60
_last_prune_at = 0.0


def log(msg: str) -> None:
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
    print(f"[{stamp}] {msg}", flush=True)


def _fetch(path: str, query: str) -> dict:
    url = f"{BYM_BASE_URL}{path}?{query}"
    req = urllib.request.Request(
        url,
        headers={
            "Accept-Encoding": "gzip",
            # Cloudflare blocks urllib's default "Python-urllib/x.y" UA with a
            # 403 before the request reaches the app; any identifying UA works.
            "User-Agent": "bymr-leaderboard-trends-poller/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
        headers = {k.lower(): v for k, v in resp.getheaders()}
    if headers.get("content-encoding") == "gzip":
        raw = gzip.decompress(raw)
    return json.loads(raw)


def fetch_worlds() -> list[dict]:
    data = _fetch(f"/api/{BYM_API_VERSION}/worlds", "")
    return data.get("worlds") or []


def fetch_leaderboard(world_uuid: str, map_version: int) -> list[dict]:
    query = f"worldid={world_uuid}&mapversion={map_version}"
    data = _fetch(f"/api/{BYM_API_VERSION}/leaderboards", query)
    return data.get("leaderboard") or []


# Rank is the entry's position in the returned (already-sorted) list — the
# API doesn't include an explicit rank field. Counts arrive as strings
# (Postgres COUNT() returns bigint, serialized as text) — cast to int here
# so every downstream consumer can rely on real numbers.
def normalize_entries(raw_entries: list[dict]) -> list[dict]:
    entries = []
    for index, raw in enumerate(raw_entries):
        stronghold_count = raw.get("stronghold_count")
        entries.append({
            "rank": index + 1,
            "username": raw.get("username") or "",
            "discord_tag": raw.get("discord_tag"),
            "pic_square": raw.get("pic_square"),
            "outpost_count": int(raw.get("outpost_count") or 0),
            "stronghold_count": int(stronghold_count) if stronghold_count is not None else None,
        })
    return entries


def _entries_match(previous: list, current: list[dict]) -> bool:
    if len(previous) != len(current):
        return False
    for prev_row, cur in zip(previous, current):
        if (
            prev_row["rank"] != cur["rank"]
            or prev_row["username"] != cur["username"]
            or prev_row["outpost_count"] != cur["outpost_count"]
            or prev_row["stronghold_count"] != cur["stronghold_count"]
            # Discord profile pictures change independently of any in-game
            # stat — without this, a player who updates their avatar but
            # doesn't move in the standings would keep showing their old
            # picture until some other field happened to change too.
            or prev_row["pic_square"] != cur["pic_square"]
        ):
            return False
    return True


def poll_world_leaderboard(world_uuid: str, map_version: int) -> str:
    """Returns a short status for the caller to log: 'unchanged' or
    'recorded (N players)'."""
    raw_entries = fetch_leaderboard(world_uuid, map_version)
    entries = normalize_entries(raw_entries)

    with db.session() as conn:
        previous = db.get_latest_entries(conn, world_uuid)
        if _entries_match(previous, entries):
            return "unchanged"
        db.record_leaderboard_poll(conn, world_uuid, map_version, db.now(), entries)
        conn.commit()
    return f"recorded ({len(entries)} players)"


def poll_once() -> None:
    worlds = fetch_worlds()
    with db.session() as conn:
        for world in worlds:
            db.upsert_world(
                conn, world["uuid"], world.get("name", "Unnamed World"),
                int(world["map_version"]), int(world.get("playerCount") or 0),
            )
        conn.commit()

    pollable = [w for w in worlds if int(w.get("map_version") or 0) in SUPPORTED_MAP_VERSIONS]
    log(f"Polling leaderboards for {len(pollable)} worlds...")

    # Logged before AND after each world (not just on failure) so a stalled
    # cycle points at exactly which world it's stuck on, instead of leaving
    # all of them as suspects.
    recorded = unchanged = failed = 0
    for i, world in enumerate(pollable, 1):
        name = world.get("name", "Unnamed World")
        tag = f"[{i}/{len(pollable)}] {name} (MR{world['map_version']})"
        log(f"  {tag}...")
        try:
            status = poll_world_leaderboard(world["uuid"], int(world["map_version"]))
            log(f"  {tag}: {status}")
            if status == "unchanged":
                unchanged += 1
            else:
                recorded += 1
        except urllib.error.HTTPError as e:
            log(f"  {tag}: HTTP {e.code} — {e}")
            failed += 1
        except Exception:
            log(f"  {tag}: failed —")
            traceback.print_exc()
            failed += 1
        time.sleep(REQUEST_DELAY_SECONDS)

    log(f"Poll cycle complete: {recorded} recorded, {unchanged} unchanged, {failed} failed.")


def maybe_prune() -> None:
    """Drops polls (and their entries, via ON DELETE CASCADE) older than
    RETENTION_DAYS, then reclaims the freed space. At most once per
    PRUNE_INTERVAL_SECONDS, independent of how often poll_once() runs."""
    global _last_prune_at
    now = time.monotonic()
    if now - _last_prune_at < PRUNE_INTERVAL_SECONDS:
        return

    cutoff = db.now() - RETENTION_DAYS * 86400
    with db.session() as conn:
        deleted = db.prune_old_polls(conn, cutoff)
        conn.commit()
        if deleted:
            conn.execute("VACUUM")
    _last_prune_at = now
    if deleted:
        log(f"Pruned {deleted} poll(s) older than {RETENTION_DAYS} days.")


def main() -> None:
    log(f"Starting leaderboard poller — every {POLL_INTERVAL_SECONDS}s, target {BYM_BASE_URL}")
    global _last_prune_at
    _last_prune_at = time.monotonic()  # skip pruning on the first cycle after a restart

    while True:
        try:
            poll_once()
            maybe_prune()
        except Exception:
            log("Poll cycle failed:")
            traceback.print_exc()
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
