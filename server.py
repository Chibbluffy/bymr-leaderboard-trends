"""Serves the app's static files, plus a small JSON API backed by the SQLite
database poller.py keeps populated. Replaces dev_server.py in production.

Nothing here ever calls the real BYM API — that's poller.py's job. Static
files and the API share one process, so requests are same-origin and there's
no CORS to configure.
"""

from __future__ import annotations

import json
import re
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from functools import partial
from urllib.parse import urlsplit, parse_qs

import db
from config import HOST, PORT, STATIC_DIR

DEFAULT_DAYS = 7


class ApiError(Exception):
    def __init__(self, message: str, status: HTTPStatus):
        super().__init__(message)
        self.message = message
        self.status = status


def _require(value: str | None, label: str) -> str:
    if not value:
        raise ApiError(f"Missing {label} query param", HTTPStatus.BAD_REQUEST)
    return value


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, format: str, *args: object) -> None:
        print(f"{self.address_string()} - {format % args}")

    # ─── HTTP method entry points ───────────────────────────────────────

    def do_GET(self) -> None:
        path = urlsplit(self.path).path
        if path.startswith("/api/"):
            self._dispatch("GET", path)
            return
        super().do_GET()

    def do_POST(self) -> None:
        self._dispatch("POST", urlsplit(self.path).path)

    def do_DELETE(self) -> None:
        self._dispatch("DELETE", urlsplit(self.path).path)

    # ─── Routing ─────────────────────────────────────────────────────────

    def _dispatch(self, method: str, path: str) -> None:
        query = {k: v[0] for k, v in parse_qs(urlsplit(self.path).query).items()}
        try:
            for pattern, route_method, fn in ROUTES:
                if route_method != method:
                    continue
                match = pattern.fullmatch(path)
                if match:
                    body = self._read_json_body() if method in ("POST",) else None
                    result = fn(self, match, query, body)
                    self._json(result if result is not None else {"ok": True})
                    return
            self._json({"error": "Not found"}, status=HTTPStatus.NOT_FOUND)
        except ApiError as e:
            self._json({"error": e.message}, status=e.status)
        except Exception as e:
            self._json({"error": "Internal error"}, status=HTTPStatus.INTERNAL_SERVER_ERROR)
            print(f"API error on {method} {path}: {e!r}")

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            raise ApiError("Malformed JSON body", HTTPStatus.BAD_REQUEST)

    def _json(self, payload, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


# ─── Route handlers ─────────────────────────────────────────────────────
# Each handler takes (handler_instance, regex_match, query_dict, json_body)
# and returns a JSON-serializable value (or None for a bare {"ok": true}).

def _route_worlds(self, match, query, body):
    with db.session() as conn:
        return [dict(row) for row in db.list_worlds(conn)]


def _route_leaderboard_current(self, match, query, body):
    world = _require(query.get("world"), "world")
    with db.session() as conn:
        entries = db.get_latest_entries(conn, world)
        poll = db.get_latest_poll(conn, world)
    return {
        "polled_at": poll["polled_at"] if poll else None,
        "entries": [dict(row) for row in entries],
    }


def _route_leaderboard_deltas(self, match, query, body):
    world = _require(query.get("world"), "world")
    days = int(query.get("days") or DEFAULT_DAYS)
    since_ts = db.now() - days * 86400
    with db.session() as conn:
        return db.compute_deltas(conn, world, since_ts)


def _route_player_history(self, match, query, body):
    world = _require(query.get("world"), "world")
    username = _require(query.get("username"), "username")
    days = int(query.get("days") or DEFAULT_DAYS)
    since_ts = db.now() - days * 86400
    with db.session() as conn:
        rows = db.get_player_history(conn, world, username, since_ts)
    return [dict(row) for row in rows]


def _route_player_deltas(self, match, query, body):
    world = _require(query.get("world"), "world")
    username = _require(query.get("username"), "username")
    days = int(query.get("days") or DEFAULT_DAYS)
    since_ts = db.now() - days * 86400
    with db.session() as conn:
        return db.get_player_deltas(conn, world, username, since_ts)


def _route_player_search(self, match, query, body):
    term = _require(query.get("term"), "term")
    limit = int(query.get("limit") or 25)
    world = query.get("world")  # optional — omitted means search every world
    with db.session() as conn:
        return db.search_usernames(conn, term, limit, world_uuid=world)


# Powers the watchlist's "possibly moved" check — given the identity captured
# when a player was added (discord_id and/or discord_tag), find every world
# where that identity currently sits in the top-N, so a relocated/renamed
# player can be re-pointed to their new spot instead of just going stale.
def _route_player_locate(self, match, query, body):
    discord_id = query.get("discord_id")
    discord_tag = query.get("discord_tag")
    if not discord_id and not discord_tag:
        raise ApiError("Missing discord_id or discord_tag query param", HTTPStatus.BAD_REQUEST)
    exclude_world = query.get("exclude_world")
    with db.session() as conn:
        return db.find_current_sightings(conn, discord_id, discord_tag, exclude_world)


ROUTES: list[tuple[re.Pattern, str, callable]] = [
    (re.compile(r"/api/worlds"), "GET", _route_worlds),
    (re.compile(r"/api/leaderboard/current"), "GET", _route_leaderboard_current),
    (re.compile(r"/api/leaderboard/deltas"), "GET", _route_leaderboard_deltas),
    (re.compile(r"/api/players/history"), "GET", _route_player_history),
    (re.compile(r"/api/players/deltas"), "GET", _route_player_deltas),
    (re.compile(r"/api/players/search"), "GET", _route_player_search),
    (re.compile(r"/api/players/locate"), "GET", _route_player_locate),
]


def main() -> None:
    handler = partial(Handler, directory=STATIC_DIR)
    server = ThreadingHTTPServer((HOST, PORT), handler)
    print(f"Serving BYM Leaderboard Trends at http://{HOST}:{PORT}")
    print(f"Static root: {STATIC_DIR}")
    print(f"Database: {db.DB_PATH}")
    server.serve_forever()


if __name__ == "__main__":
    main()
