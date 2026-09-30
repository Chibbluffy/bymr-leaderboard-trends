"""SQLite storage for polled MR2/MR3 leaderboard snapshots.

- `worlds` — latest known world metadata, overwritten each poll.
- `leaderboard_polls` — one row per successful poll of one world's player
  leaderboard. `leaderboard_entries` denormalizes `map_version`/`polled_at`
  from its parent poll onto every row — a deliberate tradeoff, since poll
  volume is tiny (one row per world every few hours) but the "current
  leaderboard" and "one player's history" queries are the hot path and
  shouldn't need a join.
- A poll is skipped entirely (no new `leaderboard_polls` row) when it's
  identical to the previous one for that world — see poller.py's
  `_entries_match()`. Quiet worlds don't bloat storage.
- The leaderboard API gives no stable per-player id, only `username` — a
  rename starts that player's trend line over under the new name. No way
  around that with this endpoint.
- Watchlists are NOT stored here — they live entirely in the browser
  (localStorage), since this has no accounts/auth to scope a server-side
  list per visitor. See app/static/js/watchlists.js.
"""

from __future__ import annotations

import re
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent / "data" / "leaderboard_trends.sqlite3"

# A player's pic_square is their Discord avatar URL when they've linked Discord
# (a bym-hosted placeholder otherwise) — the numeric segment is their Discord
# snowflake ID, which never changes for a given Discord account, unlike their
# in-game username (renameable) or even discord_tag (Discord lets you change
# your username too, just less often). Far from a perfect account ID — some
# players have no Discord linked at all — but the most stable signal this API
# actually gives us for telling "same player, different name/world" apart from
# "different player, coincidentally similar name".
_DISCORD_AVATAR_ID_RE = re.compile(r"cdn\.discordapp\.com/avatars/(\d+)/")


def extract_discord_id(pic_square: str | None) -> str | None:
    if not pic_square:
        return None
    match = _DISCORD_AVATAR_ID_RE.search(pic_square)
    return match.group(1) if match else None

SCHEMA = """
CREATE TABLE IF NOT EXISTS worlds (
  uuid           TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  map_version    INTEGER NOT NULL,
  player_count   INTEGER NOT NULL DEFAULT 0,
  last_polled_at INTEGER
);

CREATE TABLE IF NOT EXISTS leaderboard_polls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  world_uuid  TEXT NOT NULL REFERENCES worlds(uuid),
  map_version INTEGER NOT NULL,
  polled_at   INTEGER NOT NULL,
  row_count   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_polls_world_time ON leaderboard_polls(world_uuid, polled_at DESC);

-- stronghold_count is NULL for MR2 worlds — that field doesn't exist there.
-- discord_id/discord_tag are both nullable — not every player links Discord.
CREATE TABLE IF NOT EXISTS leaderboard_entries (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  poll_id          INTEGER NOT NULL REFERENCES leaderboard_polls(id) ON DELETE CASCADE,
  world_uuid       TEXT NOT NULL,
  map_version      INTEGER NOT NULL,
  polled_at        INTEGER NOT NULL,
  rank             INTEGER NOT NULL,
  username         TEXT NOT NULL,
  discord_tag      TEXT,
  discord_id       TEXT,
  pic_square       TEXT,
  outpost_count    INTEGER NOT NULL DEFAULT 0,
  stronghold_count INTEGER
);
CREATE INDEX IF NOT EXISTS idx_entries_poll ON leaderboard_entries(poll_id);
CREATE INDEX IF NOT EXISTS idx_entries_world_user_time ON leaderboard_entries(world_uuid, username, polled_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_world_time ON leaderboard_entries(world_uuid, polled_at DESC);
CREATE INDEX IF NOT EXISTS idx_entries_discord_tag ON leaderboard_entries(discord_tag);
"""

# Column additions to an existing DB that CREATE TABLE IF NOT EXISTS can't
# express. Each entry: (table, column, ddl), applied only if the column is
# missing (no-op on a fresh DB, which gets it from SCHEMA directly). Any
# index on a migrated-in column has to be created here too (after the ALTER
# TABLE runs), not in SCHEMA above — executescript(SCHEMA) runs before
# migrations, so an index referencing a not-yet-added column would fail on
# an existing (pre-migration) database.
_MIGRATIONS: list[tuple[str, str, str]] = [
    ("leaderboard_entries", "discord_id", "ALTER TABLE leaderboard_entries ADD COLUMN discord_id TEXT"),
]
_POST_MIGRATION_SQL = [
    "CREATE INDEX IF NOT EXISTS idx_entries_discord_id ON leaderboard_entries(discord_id)",
]


def _run_migrations(conn: sqlite3.Connection) -> None:
    for table, column, ddl in _MIGRATIONS:
        cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            conn.execute(ddl)
            conn.commit()
    for stmt in _POST_MIGRATION_SQL:
        conn.execute(stmt)
    conn.commit()


# One-time backfill for rows written before discord_id existed. The
# `pic_square LIKE` clause matters: a row from a player with no Discord
# linked has discord_id permanently NULL with a non-NULL (placeholder)
# pic_square — without that clause this query would re-match and re-attempt
# those same rows on every single connect() forever, since they can never
# "graduate" out of a plain `discord_id IS NULL` filter. Restricting to URLs
# that could plausibly contain a Discord snowflake makes this genuinely
# converge to zero once the real backfill is done.
def _backfill_discord_ids(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT id, pic_square FROM leaderboard_entries "
        "WHERE discord_id IS NULL AND pic_square LIKE '%cdn.discordapp.com%'"
    ).fetchall()
    updates = [
        (extract_discord_id(row["pic_square"]), row["id"])
        for row in rows
        if extract_discord_id(row["pic_square"])
    ]
    if updates:
        conn.executemany("UPDATE leaderboard_entries SET discord_id = ? WHERE id = ?", updates)
        conn.commit()


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=30000")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA)
    _run_migrations(conn)
    _backfill_discord_ids(conn)
    return conn


@contextmanager
def session():
    """Connection that actually closes on exit (sqlite3's own context manager only commits/rolls back)."""
    conn = connect()
    try:
        yield conn
    finally:
        conn.close()


def now() -> int:
    return int(time.time())


# ─── Worlds ──────────────────────────────────────────────────────────────

def upsert_world(conn: sqlite3.Connection, uuid: str, name: str, map_version: int, player_count: int) -> None:
    conn.execute(
        """
        INSERT INTO worlds (uuid, name, map_version, player_count, last_polled_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(uuid) DO UPDATE SET
          name = excluded.name,
          map_version = excluded.map_version,
          player_count = excluded.player_count,
          last_polled_at = excluded.last_polled_at
        """,
        (uuid, name, map_version, player_count, now()),
    )


def list_worlds(conn: sqlite3.Connection, map_version: int | None = None) -> list[sqlite3.Row]:
    if map_version is None:
        return conn.execute("SELECT * FROM worlds ORDER BY map_version, name").fetchall()
    return conn.execute(
        "SELECT * FROM worlds WHERE map_version = ? ORDER BY name", (map_version,)
    ).fetchall()


def get_world(conn: sqlite3.Connection, uuid: str) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM worlds WHERE uuid = ?", (uuid,)).fetchone()


# ─── Leaderboard polls ───────────────────────────────────────────────────

def get_latest_poll(conn: sqlite3.Connection, world_uuid: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM leaderboard_polls WHERE world_uuid = ? ORDER BY polled_at DESC LIMIT 1",
        (world_uuid,),
    ).fetchone()


def get_poll_entries(conn: sqlite3.Connection, poll_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM leaderboard_entries WHERE poll_id = ? ORDER BY rank", (poll_id,)
    ).fetchall()


def get_latest_entries(conn: sqlite3.Connection, world_uuid: str) -> list[sqlite3.Row]:
    poll = get_latest_poll(conn, world_uuid)
    if poll is None:
        return []
    return get_poll_entries(conn, poll["id"])


def get_earliest_poll(conn: sqlite3.Connection, world_uuid: str) -> sqlite3.Row | None:
    return conn.execute(
        "SELECT * FROM leaderboard_polls WHERE world_uuid = ? ORDER BY polled_at ASC LIMIT 1",
        (world_uuid,),
    ).fetchone()


# The baseline poll for a "change over N days" comparison (since_ts = now -
# N days) — the OLDEST poll at or after since_ts, i.e. as close to N days
# ago as this world's actual poll history allows WITHOUT ever exceeding the
# requested window. Deliberately does NOT fall back to something older than
# since_ts just because nothing newer exists in the window — a 7d comparison
# quietly reaching back 11 days (because that's the closest poll before the
# cutoff, and this world had a gap in between) would overstate the real
# change and mislabel the period it's describing. "7 days or fewer, never
# longer" is the whole point.
#
# If the only poll at or after since_ts is the world's current/latest poll
# itself, there's nothing earlier within the window to compare against, so
# this returns None (shown as "no earlier snapshot") — same as when the
# window is empty entirely. That can genuinely happen for a short range on a
# quiet world (e.g. 24h when the last actual change was 30h ago); it does
# NOT mean broaden the search, it means there's honestly nothing to compare.
#
# `hit_start_of_history` tells the caller whether the baseline it got is
# this world's very first poll ever — useful context for "comparing to 11d
# ago" on a 90d request: that's not a random gap, it's literally all the
# history that exists yet.
def resolve_baseline_poll(conn: sqlite3.Connection, world_uuid: str, since_ts: int) -> tuple[sqlite3.Row | None, bool]:
    current = get_latest_poll(conn, world_uuid)
    poll = conn.execute(
        """
        SELECT * FROM leaderboard_polls
        WHERE world_uuid = ? AND polled_at >= ?
        ORDER BY polled_at ASC LIMIT 1
        """,
        (world_uuid, since_ts),
    ).fetchone()
    if poll is None or (current and poll["id"] == current["id"]):
        return None, False
    earliest = get_earliest_poll(conn, world_uuid)
    return poll, bool(earliest and poll["id"] == earliest["id"])


def record_leaderboard_poll(
    conn: sqlite3.Connection,
    world_uuid: str,
    map_version: int,
    polled_at: int,
    entries: list[dict],
) -> int:
    cur = conn.execute(
        "INSERT INTO leaderboard_polls (world_uuid, map_version, polled_at, row_count) VALUES (?, ?, ?, ?)",
        (world_uuid, map_version, polled_at, len(entries)),
    )
    poll_id = cur.lastrowid
    conn.executemany(
        """
        INSERT INTO leaderboard_entries
          (poll_id, world_uuid, map_version, polled_at, rank, username, discord_tag, discord_id, pic_square,
           outpost_count, stronghold_count)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                poll_id, world_uuid, map_version, polled_at, e["rank"], e["username"],
                e.get("discord_tag"), e.get("discord_id") or extract_discord_id(e.get("pic_square")),
                e.get("pic_square"), e["outpost_count"], e.get("stronghold_count"),
            )
            for e in entries
        ],
    )
    return poll_id


# Retention — see poller.py's maybe_prune(). Deletes whole polls, which
# cascades to their entries via the FK's ON DELETE CASCADE.
def prune_old_polls(conn: sqlite3.Connection, before_ts: int) -> int:
    cur = conn.execute("DELETE FROM leaderboard_polls WHERE polled_at < ?", (before_ts,))
    return cur.rowcount


# Every player who appeared in either snapshot, with their rank/count at each
# end and the deltas between them. Players missing from one side (fell out of
# the top-N, or newly entered it) have None for that side's fields.
def compute_deltas(conn: sqlite3.Connection, world_uuid: str, since_ts: int) -> list[dict]:
    current_poll = get_latest_poll(conn, world_uuid)
    baseline_poll, baseline_hit_start_of_history = resolve_baseline_poll(conn, world_uuid, since_ts)

    current_by_name = {row["username"]: row for row in (get_poll_entries(conn, current_poll["id"]) if current_poll else [])}
    baseline_by_name = {row["username"]: row for row in (get_poll_entries(conn, baseline_poll["id"]) if baseline_poll else [])}

    results = []
    for username in set(current_by_name) | set(baseline_by_name):
        cur_row = current_by_name.get(username)
        base_row = baseline_by_name.get(username)
        cur_outposts = cur_row["outpost_count"] if cur_row else None
        base_outposts = base_row["outpost_count"] if base_row else None
        cur_strongholds = cur_row["stronghold_count"] if cur_row else None
        base_strongholds = base_row["stronghold_count"] if base_row else None

        results.append({
            "username": username,
            "discord_tag": (cur_row or base_row)["discord_tag"],
            "discord_id": (cur_row or base_row)["discord_id"],
            "pic_square": (cur_row or base_row)["pic_square"],
            "rank_now": cur_row["rank"] if cur_row else None,
            "rank_then": base_row["rank"] if base_row else None,
            "outpost_count_now": cur_outposts,
            "outpost_count_then": base_outposts,
            "stronghold_count_now": cur_strongholds,
            "stronghold_count_then": base_strongholds,
            "delta_outposts": (cur_outposts - base_outposts) if cur_outposts is not None and base_outposts is not None else None,
            "delta_strongholds": (cur_strongholds - base_strongholds) if cur_strongholds is not None and base_strongholds is not None else None,
            "delta_rank": (base_row["rank"] - cur_row["rank"]) if cur_row and base_row else None,
        })

    return {
        "current_polled_at": current_poll["polled_at"] if current_poll else None,
        "baseline_polled_at": baseline_poll["polled_at"] if baseline_poll else None,
        "baseline_hit_start_of_history": baseline_hit_start_of_history,
        "players": results,
    }


def get_player_current(conn: sqlite3.Connection, world_uuid: str, username: str) -> sqlite3.Row | None:
    return conn.execute(
        """
        SELECT * FROM leaderboard_entries
        WHERE world_uuid = ? AND username = ?
        ORDER BY polled_at DESC LIMIT 1
        """,
        (world_uuid, username),
    ).fetchone()


# Player's row (if any — they may not have been top-N that poll) from the
# baseline poll for since_ts, i.e. the "N days ago" snapshot for one player —
# falls back the same way resolve_baseline_poll() does when no poll reaches
# back that far.
def get_player_baseline(conn: sqlite3.Connection, world_uuid: str, username: str, since_ts: int) -> sqlite3.Row | None:
    poll, _ = resolve_baseline_poll(conn, world_uuid, since_ts)
    if poll is None:
        return None
    return conn.execute(
        "SELECT * FROM leaderboard_entries WHERE poll_id = ? AND username = ?",
        (poll["id"], username),
    ).fetchone()


# Single-player version of compute_deltas() — for a watchlist row, where the
# caller already knows which (world, username) it wants rather than every
# player in a world's leaderboard. None fields mean "wasn't top-N that poll",
# same convention as compute_deltas().
#
# cur_row is the most recent poll where this player appeared AT ALL, which
# may be older than the world's actual latest poll if they've since fallen
# out of the top-N — `is_current` distinguishes "currently ranked" from
# "last seen N polls ago", so a stale watchlist entry can say so instead of
# just going blank the moment someone drops out of range.
def get_player_deltas(conn: sqlite3.Connection, world_uuid: str, username: str, since_ts: int) -> dict:
    cur_row = get_player_current(conn, world_uuid, username)
    baseline_poll, baseline_hit_start_of_history = resolve_baseline_poll(conn, world_uuid, since_ts)
    base_row = (
        conn.execute(
            "SELECT * FROM leaderboard_entries WHERE poll_id = ? AND username = ?",
            (baseline_poll["id"], username),
        ).fetchone()
        if baseline_poll
        else None
    )
    latest_poll = get_latest_poll(conn, world_uuid)

    is_current = bool(cur_row and latest_poll and cur_row["poll_id"] == latest_poll["id"])
    cur_outposts = cur_row["outpost_count"] if cur_row else None
    base_outposts = base_row["outpost_count"] if base_row else None
    cur_strongholds = cur_row["stronghold_count"] if cur_row else None
    base_strongholds = base_row["stronghold_count"] if base_row else None

    return {
        "username": username,
        "world_uuid": world_uuid,
        "found": cur_row is not None,
        "is_current": is_current,
        "discord_tag": (cur_row or base_row)["discord_tag"] if (cur_row or base_row) else None,
        "discord_id": (cur_row or base_row)["discord_id"] if (cur_row or base_row) else None,
        "pic_square": (cur_row or base_row)["pic_square"] if (cur_row or base_row) else None,
        "last_seen_polled_at": cur_row["polled_at"] if cur_row else None,
        "current_polled_at": latest_poll["polled_at"] if latest_poll else None,
        "baseline_polled_at": baseline_poll["polled_at"] if baseline_poll else None,
        "baseline_hit_start_of_history": baseline_hit_start_of_history,
        "rank_now": cur_row["rank"] if cur_row else None,
        "rank_then": base_row["rank"] if base_row else None,
        "outpost_count_now": cur_outposts,
        "outpost_count_then": base_outposts,
        "stronghold_count_now": cur_strongholds,
        "stronghold_count_then": base_strongholds,
        "delta_outposts": (cur_outposts - base_outposts) if cur_outposts is not None and base_outposts is not None else None,
        "delta_strongholds": (cur_strongholds - base_strongholds) if cur_strongholds is not None and base_strongholds is not None else None,
        "delta_rank": (base_row["rank"] - cur_row["rank"]) if cur_row and base_row else None,
    }


def get_player_history(conn: sqlite3.Connection, world_uuid: str, username: str, since_ts: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT * FROM leaderboard_entries
        WHERE world_uuid = ? AND username = ? AND polled_at >= ?
        ORDER BY polled_at
        """,
        (world_uuid, username, since_ts),
    ).fetchall()


# Username autocomplete, prefix match, case-insensitive. Global across every
# world's polled leaderboard history unless world_uuid narrows it to one — the
# watchlist "add player" flow searches globally so it can add someone from any
# world without asking which one first, and auto-detects their world from
# whichever match gets picked. One row per (world, username) ever seen — using
# each pair's MOST RECENT row (highest id), so a stale/earlier discord_id from
# before a re-link, if that ever happens, doesn't win over the current one.
#
# A common prefix (e.g. "nu") can easily match more distinct (world, username)
# pairs than `limit` once 17 worlds' full history is searched — ordering
# currently-ranked players first, before falling back to alphabetical, means
# the cutoff drops long-inactive historical names rather than someone who's
# sitting on today's leaderboard right now.
def search_usernames(conn: sqlite3.Connection, term: str, limit: int = 25, world_uuid: str | None = None) -> list[dict]:
    inner_where = ["username LIKE ? ESCAPE '\\'"]
    inner_params: list = [_like_prefix(term)]
    if world_uuid:
        inner_where.append("world_uuid = ?")
        inner_params.append(world_uuid)

    rows = conn.execute(
        f"""
        SELECT le.world_uuid, w.name AS world_name, w.map_version, le.username, le.discord_id, le.discord_tag,
               (le.poll_id = (
                   SELECT id FROM leaderboard_polls
                   WHERE world_uuid = le.world_uuid ORDER BY polled_at DESC LIMIT 1
               )) AS is_current
        FROM leaderboard_entries le
        JOIN worlds w ON w.uuid = le.world_uuid
        WHERE le.id IN (
            SELECT MAX(id) FROM leaderboard_entries
            WHERE {' AND '.join(inner_where)}
            GROUP BY world_uuid, username
        )
        ORDER BY is_current DESC, le.username COLLATE NOCASE
        LIMIT ?
        """,
        [*inner_params, limit],
    ).fetchall()
    return [
        {
            "username": row["username"],
            "world": row["world_uuid"],
            "world_name": row["world_name"],
            "map_version": row["map_version"],
            "discord_id": row["discord_id"],
            "discord_tag": row["discord_tag"],
        }
        for row in rows
    ]


# For the watchlist's "possibly moved" check — every world where this identity
# currently appears in THAT WORLD'S OWN latest poll, i.e. genuinely-current
# sightings, not just anywhere in history. Excludes exclude_world so a still-
# current player on their own pinned world doesn't show up as a "new"
# sighting of themselves.
#
# discord_id (the Discord snowflake) never changes for a given account, so
# when it's known it's used EXCLUSIVELY — discord_tag is only consulted when
# discord_id isn't available at all. Discord usernames are freely reusable
# once abandoned, so OR-ing a known discord_id together with a discord_tag
# risks matching a completely different player who's since claimed that old
# tag for themselves.
def find_current_sightings(
    conn: sqlite3.Connection,
    discord_id: str | None,
    discord_tag: str | None,
    exclude_world: str | None = None,
) -> list[dict]:
    if not discord_id and not discord_tag:
        return []

    if discord_id:
        identity_where = ["le.discord_id = ?"]
        params: list = [discord_id]
    else:
        identity_where = ["le.discord_tag = ?"]
        params = [discord_tag]

    query = f"""
        SELECT le.world_uuid, w.name AS world_name, w.map_version, le.username,
               le.rank, le.outpost_count, le.stronghold_count, le.polled_at
        FROM leaderboard_entries le
        JOIN worlds w ON w.uuid = le.world_uuid
        JOIN leaderboard_polls lp ON lp.id = le.poll_id
        WHERE ({' OR '.join(identity_where)})
          AND lp.id = (
            SELECT id FROM leaderboard_polls
            WHERE world_uuid = le.world_uuid
            ORDER BY polled_at DESC LIMIT 1
          )
    """
    if exclude_world:
        query += " AND le.world_uuid != ?"
        params.append(exclude_world)
    query += " ORDER BY le.polled_at DESC"

    rows = conn.execute(query, params).fetchall()
    return [
        {
            "world": row["world_uuid"],
            "world_name": row["world_name"],
            "map_version": row["map_version"],
            "username": row["username"],
            "rank": row["rank"],
            "outpost_count": row["outpost_count"],
            "stronghold_count": row["stronghold_count"],
            "polled_at": row["polled_at"],
        }
        for row in rows
    ]


def _like_prefix(term: str) -> str:
    escaped = term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"{escaped}%"
