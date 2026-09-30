// Watchlists live entirely in the browser (localStorage) — this app has no
// accounts, so there's no sensible place to scope a server-side list to one
// visitor. Nothing here ever touches the network.

const STORAGE_KEY = "bym-leaderboard-trends-watchlists";
const SELECTED_KEY = "bym-leaderboard-trends-selected-watchlist";
const EXPORT_VERSION = 1;

function uid() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveAll(lists) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(lists));
}

export function listWatchlists() {
  return loadAll();
}

export function getWatchlist(id) {
  return loadAll().find((w) => w.id === id) || null;
}

export function createWatchlist(name) {
  const lists = loadAll();
  const watchlist = { id: uid(), name: name.trim() || "Untitled list", createdAt: Date.now(), players: [] };
  lists.push(watchlist);
  saveAll(lists);
  return watchlist;
}

export function renameWatchlist(id, name) {
  const lists = loadAll();
  const watchlist = lists.find((w) => w.id === id);
  if (!watchlist) return;
  watchlist.name = name.trim() || watchlist.name;
  saveAll(lists);
}

export function deleteWatchlist(id) {
  saveAll(loadAll().filter((w) => w.id !== id));
  if (getSelectedId() === id) setSelectedId(null);
}

// discordId/discordTag are captured at add-time (from the search result the
// player was picked from) and are what let this entry auto-follow the
// player if they relocate or rename later — see updatePlayerLocation(),
// called automatically on every load by resolveCurrentLocation() in
// viewer-app.js. Every real account is tied to a unique Discord account, so
// both fields end up null only for malformed/very old data — that entry
// just can't be auto-tracked, same as it can't be searched for today.
export function addPlayer(watchlistId, { world, worldName, username, discordId = null, discordTag = null }) {
  const lists = loadAll();
  const watchlist = lists.find((w) => w.id === watchlistId);
  if (!watchlist) return null;

  const exists = watchlist.players.some(
    (p) => p.world === world && p.username.toLowerCase() === username.toLowerCase(),
  );
  if (exists) return watchlist;

  watchlist.players.push({
    id: uid(), world, worldName: worldName || "", username, discordId, discordTag,
    addedAt: Date.now(), locationHistory: [],
  });
  saveAll(lists);
  return watchlist;
}

export function removePlayer(watchlistId, playerId) {
  const lists = loadAll();
  const watchlist = lists.find((w) => w.id === watchlistId);
  if (!watchlist) return;
  watchlist.players = watchlist.players.filter((p) => p.id !== playerId);
  saveAll(lists);
}

// Re-points an existing entry's tracked (world, username) in place — same
// entry id, same position in the list — rather than adding a duplicate row,
// when the player this entry represents has moved worlds and/or renamed.
// Called automatically by resolveCurrentLocation() in viewer-app.js on
// every load, not from any UI action — the entry just always reflects
// wherever that Discord identity is currently ranked. Logs the change into
// the entry's own locationHistory so the trail stays visible (see the
// History modal's "Move history" section in viewer-app.js).
export function updatePlayerLocation(watchlistId, playerId, { world, worldName, username }) {
  const lists = loadAll();
  const watchlist = lists.find((w) => w.id === watchlistId);
  const player = watchlist?.players.find((p) => p.id === playerId);
  if (!player) return;

  if (!Array.isArray(player.locationHistory)) player.locationHistory = [];
  player.locationHistory.push({
    fromWorld: player.world, fromWorldName: player.worldName, fromUsername: player.username,
    toWorld: world, toWorldName: worldName, toUsername: username,
    changedAt: Date.now(),
  });
  player.world = world;
  player.worldName = worldName || "";
  player.username = username;
  saveAll(lists);
}

export function getSelectedId() {
  return localStorage.getItem(SELECTED_KEY);
}

export function setSelectedId(id) {
  if (id) localStorage.setItem(SELECTED_KEY, id);
  else localStorage.removeItem(SELECTED_KEY);
}

export function exportWatchlists(ids = null) {
  const lists = loadAll().filter((w) => !ids || ids.includes(w.id));
  const payload = {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    watchlists: lists.map((w) => ({
      name: w.name,
      players: w.players.map((p) => ({
        world: p.world, worldName: p.worldName, username: p.username,
        discordId: p.discordId || null, discordTag: p.discordTag || null,
      })),
    })),
  };
  return JSON.stringify(payload, null, 2);
}

// Merges into existing storage rather than replacing it — a list whose name
// exactly matches an existing one merges players into it (deduped), a new
// name creates a new list. Returns a summary or throws with a user-facing
// message on malformed input.
export function importWatchlists(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("That doesn't look like valid JSON.");
  }

  const incoming = Array.isArray(parsed?.watchlists) ? parsed.watchlists : null;
  if (!incoming) {
    throw new Error('Expected a {"watchlists": [...]} object — see the Export format.');
  }

  const lists = loadAll();
  let listsCreated = 0;
  let listsMerged = 0;
  let playersAdded = 0;

  for (const entry of incoming) {
    const name = String(entry?.name || "").trim();
    if (!name) continue;
    const players = Array.isArray(entry?.players) ? entry.players : [];

    let watchlist = lists.find((w) => w.name.toLowerCase() === name.toLowerCase());
    if (watchlist) {
      listsMerged += 1;
    } else {
      watchlist = { id: uid(), name, createdAt: Date.now(), players: [] };
      lists.push(watchlist);
      listsCreated += 1;
    }

    for (const p of players) {
      const world = String(p?.world || "").trim();
      const username = String(p?.username || "").trim();
      if (!world || !username) continue;
      const exists = watchlist.players.some(
        (existing) => existing.world === world && existing.username.toLowerCase() === username.toLowerCase(),
      );
      if (exists) continue;
      watchlist.players.push({
        id: uid(), world, worldName: String(p?.worldName || ""), username,
        discordId: p?.discordId ? String(p.discordId) : null,
        discordTag: p?.discordTag ? String(p.discordTag) : null,
        addedAt: Date.now(), locationHistory: [],
      });
      playersAdded += 1;
    }
  }

  saveAll(lists);
  return { listsCreated, listsMerged, playersAdded };
}
