# BYM Leaderboard Trends

Tracks Backyard Monsters Refitted's Map Room 2 and Map Room 3 player leaderboards
over time. The game itself keeps no leaderboard history — the API is a live,
server-side-cached snapshot that forgets everything the moment it's refreshed —
so this project's own polling is the only place any history exists.

## Status

Working: poller, SQLite storage, a JSON API, and a web UI (Leaderboard tab +
Watchlists tab with relocation/rename detection and a per-player history
view), laid out to work down to a 320px-wide phone screen. Data tables scroll
horizontally within their own panel rather than reflowing into cards — with
up to 10 columns (Watchlists) that's still the more usable option on a phone,
just swipe sideways within the table instead of the whole page.

## Interface

Two tabs, both reusing the same dark panel/table styling as the sibling map
viewers in this project family:

- **Leaderboard** — Map Room and World are both a row of clickable tabs, not
  `<select>` dropdowns — checking several worlds in a row is one click each,
  not an open-then-click every time. Pick a "change over" period
  (24h/7d/30d/90d) alongside them — a true rolling window computed fresh on
  every load (`now - N days`, not aligned to midnight or any fixed clock
  time). The comparison baseline is always **N days old or more recent,
  never older** — it's the oldest poll that's still within the requested
  window, not simply "the closest poll before that cutoff," which could
  otherwise reach arbitrarily far into the past on a quiet world (a 7d
  request has no business silently comparing against an 11-day-old poll
  just because that happened to be the nearest one on the other side of a
  gap). If a world has no poll at all within the requested window — e.g. its
  last real change was further back than that, or the project simply hasn't
  been polling that long yet — there's honestly nothing to compare against
  within that period, same as "no earlier snapshot" today; asking for a
  longer period is what surfaces older data, not this app quietly reaching
  past what was asked for. The table shows current rank, outposts (and
  strongholds for MR3), plus the delta for each over the selected period,
  all in one sortable/filterable table — click any column header to sort,
  filter by player name or a min/max outpost-count range (a player who's
  dropped out of the top-N is excluded from that filter, not matched on
  their old count). A player who dropped out of the top-N during the period
  is tagged **Dropped out** instead of just vanishing; a player with no
  earlier snapshot to compare against is tagged **New**.
  - **If the requested period reaches further back than this world's actual
    poll history** (a 90d comparison when polling has only run 11 days),
    the baseline used is simply the oldest poll that exists — still within
    the requested window by definition, since "11 days ago" is always
    within "90 days ago or more recent." The status line flags this
    explicitly — "comparing to 11d ago (earliest data available)" — so it's
    clear that's the real start of this world's history, not an arbitrary
    shortfall.
- **Watchlists** — named lists of specific players to track (e.g. one for
  alliance members, another for scouting targets), saved only in this
  browser's `localStorage` — there are no accounts, so nothing is shared
  between visitors or devices. Adding a player is a single search box with
  live autocomplete across **every** polled world at once — no need to know
  or pick which world/Map Room they're on first; picking a suggestion
  auto-detects it (shown as "Will add on <world> (MRx)" before you confirm),
  so one watchlist can freely mix MR2 and MR3 players from different worlds.
  Typing an exact name and tabbing away resolves it the same way, as long as
  that name is unambiguous across worlds — if more than one world has a
  player by that exact name, you're prompted to pick from the dropdown
  instead of it guessing. Each row shows the same current+delta figures as
  the main leaderboard, plus a small trend sparkline — a real line graph
  (canvas-drawn, not just an icon) that moves up and down with the player's
  actual outpost count, not just trending one direction. Points are placed
  by their *actual* poll time within the selected range rather than evenly
  spaced by index, so a player who only has a couple of data points in a
  90-day window shows a short line positioned where those polls actually
  landed, with the rest of the range left visibly blank — a quiet stretch
  reads as a quiet stretch, not stretched out into a smooth-looking 90-day
  trend that never happened.
  - **Stale entries show `—`, not their last-known numbers.** Once a
    watchlisted player drops out of a world's top-N, their rank/outposts/
    strongholds and every delta column show `—` rather than freezing on
    whatever they were the last time that player was actually ranked — a
    recycled or relocated player's old outpost count could otherwise sit on
    the page for weeks looking like a live, current figure.
  - **Relocation/rename tracking is fully automatic — no button, no
    banner.** Every player account is uniquely tied to one Discord account,
    so a watchlist entry's `discordId`/`discordTag` (captured at add-time
    from the search result) is used on *every* load to re-resolve "where is
    this identity currently ranked, across every world?" — not just once an
    entry has already gone stale. If they've moved worlds and/or renamed
    since the last check, the entry is silently re-pointed to wherever
    they're ranked now (same row, same list position, never a duplicate)
    *before* its stats are even fetched, so the row just shows their current
    name/world/stats directly. Every re-point is logged into the entry's own
    move history, viewable in that player's History modal, for anyone who
    wants to see where they've been. **Stale** (with a "Last seen Xd ago at
    #N" note) now means exactly one thing: the identity isn't ranked in
    *any* tracked world's current top-N at all — not "maybe moved, unclear,"
    since a real move would have already been resolved automatically. The
    rare entry with neither identity field (very old/malformed data — a live
    search result always captures at least one) can't auto-track and says so.
  - **History** — a small icon next to the sparkline opens a full
    poll-by-poll table for that player (bank-statement style: most recent
    poll first, each row's Δ against the *previous* poll), over a 7d/30d/90d
    range, plus a move-history list at the top (every relocation/rename
    logged via the Update button above) when that entry has any.
  - **Import…**/**Export…** round-trip all lists as JSON (a
    `{"watchlists": [...]}` object, including each player's captured Discord
    identity) — export for backup or to hand to someone else, import merges
    into whatever's already saved (a list with a matching name merges players
    into it; a new name creates a new list).

## How it works

`poller.py` runs forever, polling the BYM server's public leaderboard API
(`GET /api/:apiVersion/leaderboards`, no API key needed — unauthenticated,
IP-rate-limited) for every MR2 and MR3 world, on a configurable interval
(`POLL_INTERVAL_SECONDS`, default 2 hours — matches the leaderboard
endpoint's own 2-hour server-side cache TTL, so every poll gets a fresh
value without hammering it faster than that cache ever changes). A poll is
skipped entirely if the
result is identical to the previous one for that world, so quiet worlds don't
bloat storage. A brand-new world (one that didn't exist on the last poll)
needs no code change or restart to pick up — the world list itself is
re-fetched fresh every cycle, not cached. One caveat: the *frontend* only
loads the world list once per page load, so a world created mid-session won't
show up in the Leaderboard tabs / watchlist search until the page is
reloaded.

**Data retention:** polled history older than `RETENTION_DAYS` (default 90)
is dropped once a day, right after a poll cycle — we don't need this data
forever, just enough to look back a few months. `poller.py`'s `maybe_prune()`
deletes old `leaderboard_polls` rows (cascading to their `leaderboard_entries`
via the foreign key) and runs `VACUUM` afterward to reclaim the freed space.

**Player identity.** Each polled row carries `username` (renameable),
`discord_tag`, and `pic_square` (their Discord avatar URL, when linked).
`pic_square` usually looks like `.../avatars/<snowflake-id>/....png` — that
numeric ID never changes for a given Discord account, so it's stored as its
own `discord_id` column (parsed at poll time, with a one-time backfill for
rows written before this existed) and used as the **exclusive** signal for
"same player, different name/world" whenever it's known. `discord_tag` is
only consulted as a fallback when a player has no `discord_id` at all —
Discord usernames are freely reusable once abandoned, so treating a stale
`discord_tag` as equally trustworthy as a known `discord_id` risks matching
a completely different player who's since claimed that old tag for
themselves. `username` is the most volatile of the three (changeable at will
in-game) and is never used for identity matching, only for display. A player
who's never linked Discord has no `discord_id`/`discord_tag` at all — there's
nothing more stable to go on for them than the in-game name, which is why
their stale entries can't auto-detect a relocation (see Interface above).
Discord profile pictures change independently of any in-game stat — a poll
where only `pic_square` changed still counts as a real change worth storing,
not skipped as "unchanged," so a watchlisted player's shown avatar doesn't
go stale for weeks waiting on an outpost count to move too.

**Important limitation:** the leaderboard endpoint only returns the top 25
players for MR3 (ranked by outposts + strongholds) and the top 100 for MR2
(ranked by outposts) — it is not a full per-player lookup, and there's no way
to fetch a specific player's stats directly. A tracked/watchlisted player who
falls out of that range simply has no *current* data point for that poll —
the UI surfaces this explicitly (see Interface above) rather than showing a
misleadingly blank or stale-looking row. There's also no stable per-player ID
in the response, only `username` — a rename starts that player's history over
under the new name.

`server.py` serves the static frontend plus a JSON API backed by the SQLite
database the poller fills. Watchlists are **not** part of this API — they're
entirely client-side (see `app/static/js/watchlists.js`).

Every frontend API call goes through `fetchJson()` (`app/static/js/shared.js`)
with a 15s timeout — `server.py` is same-origin and reads local SQLite, so it
should never legitimately be slow, but `fetch()` has no timeout of its own,
and a visitor on a flaky mobile connection (or the rare stall from a big
prune's `VACUUM`) would otherwise be stuck on "Loading…" forever with no way
out but a manual reload.

- `GET /api/worlds` — every known MR2/MR3 world
- `GET /api/leaderboard/current?world=<uuid>` — latest poll for a world
- `GET /api/leaderboard/deltas?world=<uuid>&days=<N>` — every player who
  appeared in the current or N-days-ago snapshot, with rank/outpost/stronghold
  deltas between them
- `GET /api/players/history?world=<uuid>&username=<name>&days=<N>` — one
  player's poll history (used for the watchlist sparkline)
- `GET /api/players/deltas?world=<uuid>&username=<name>&days=<N>` — same
  current+delta shape as one row of `/api/leaderboard/deltas`, but for a
  single named player regardless of whether they're currently top-N — used by
  the Watchlists tab, since a watchlist can include players who've since
  fallen out of range. Also reports `is_current` (did they appear in the
  world's *latest* poll) and `last_seen_polled_at` (the most recent poll
  where they appeared at all, which can be older than the latest poll if
  they've dropped out) so a stale entry can say so.
- `GET /api/players/search?term=<text>&world=<uuid>&limit=<n>` — username
  autocomplete, prefix match, default `limit` 25. `world` is optional — omit
  it to search every polled world at once (each match reports its own
  `world`/`world_name`/`map_version`/`discord_id`/`discord_tag`), which is
  what the Watchlists "add player" flow uses so it can add someone without
  asking which world they're on first; pass it to scope the search to one
  world instead. Results rank players currently on a world's *latest* poll
  ahead of names only seen historically, so a common prefix (searched across
  17 worlds' full history) doesn't bury someone who's actively on the
  leaderboard today under long-inactive matches.
- `GET /api/players/locate?discord_id=<id>&discord_tag=<tag>&exclude_world=<uuid>` —
  every world where that identity currently sits in the top-N (at least one
  of `discord_id`/`discord_tag` required, both may be passed; `discord_id`
  is used exclusively when present, `discord_tag` only as a fallback — see
  Player identity below). Called on every Watchlists load, for every entry,
  to auto-resolve its current location before fetching stats — see
  Relocation/rename tracking above. `exclude_world` is unused by that call
  (nothing to exclude when resolving from scratch) but is kept for any other
  caller that wants "somewhere *other than* their current world."

## Running it locally

Needs Python 3, no external dependencies.

Start the poller (long-running, keeps SQLite updated):

```bash
python3 poller.py
```

Start the API/static server in a separate process:

```bash
python3 server.py
```

Then open `http://localhost:8082`. Or, for frontend-only work without the
API, `dev_server.py` serves just the static files (map/leaderboard data won't
load without `server.py` running too).

**Deploying to a real server** (systemd units + an nginx reverse-proxy
config, running at `bymr-leaderboard.chibbluffy.fyi`) — see
[`deploy/README.md`](deploy/README.md).

## Config

Environment variables (or a local `.env` file), all optional:

- `BYM_BASE_URL` default: `https://server.bymrefitted.com`
- `BYM_API_VERSION` default: `v1.6.2-beta`
- `POLL_INTERVAL_SECONDS` default: `7200` (2 hours) — matches the leaderboard
  endpoint's own server-side cache TTL, so polling much faster than that just
  re-reads the same snapshot
- `REQUEST_DELAY_SECONDS` default: `1.5` — pause between per-world requests
  within one poll cycle
- `RETENTION_DAYS` default: `90` — how long polled history is kept before
  `poller.py` drops it
- `HOST` default: `0.0.0.0`
- `PORT` default: `8082`
- `STATIC_DIR` default: `app/static`

**Restarting after a code update:** both `poller.py` and `server.py` are
long-running processes that don't hot-reload — after pulling in code changes,
stop and restart both (`Ctrl+C` then re-run) to actually pick them up. A
`server.py` that's been running since before a change will keep serving the
old behavior (including 404ing on any newly-added route) until restarted.

**Restarting `poller.py` doesn't lose or duplicate data.** Everything it's
recorded lives in SQLite, not in the process — a restart only resets two bits
of in-memory state: it immediately runs one poll cycle on startup rather than
waiting out whatever was left of the old interval (harmless — a poll that
finds no change since the last one just skips storing anything, so restarting
often doesn't inflate storage), and it forgets when it last pruned old data,
which only delays the next `maybe_prune()` run by up to a day, never further
than that. Changing `POLL_INTERVAL_SECONDS` (e.g. down to every 2–4h) is
picked up the moment it's restarted — no data implications either way, it
just changes how often that skip-if-unchanged check runs.

## Planned

- Re-fetch the world list periodically (or add a manual refresh) so a
  brand-new world shows up without a full page reload
- Alliance leaderboards, once the game server exposes an alliance endpoint —
  the schema is left room to add `alliance_*` tables alongside the existing
  player tables without touching them
