import { fetchJson } from "./shared.js";

export class ApiClient {
  async getWorlds() {
    return fetchJson("/api/worlds");
  }

  async getLeaderboardDeltas(world, days) {
    return fetchJson(`/api/leaderboard/deltas?world=${encodeURIComponent(world)}&days=${days}`);
  }

  async getPlayerDeltas(world, username, days) {
    return fetchJson(
      `/api/players/deltas?world=${encodeURIComponent(world)}&username=${encodeURIComponent(username)}&days=${days}`,
    );
  }

  async getPlayerHistory(world, username, days) {
    return fetchJson(
      `/api/players/history?world=${encodeURIComponent(world)}&username=${encodeURIComponent(username)}&days=${days}`,
    );
  }

  // world omitted (null/undefined) searches every polled world at once —
  // used by the watchlist "add player" flow, which auto-detects the world
  // from whichever match gets picked instead of asking for it up front.
  async searchPlayers(term, limit = 25, world = null) {
    const params = new URLSearchParams({ term, limit: String(limit) });
    if (world) params.set("world", world);
    return fetchJson(`/api/players/search?${params.toString()}`);
  }

  // Every world where this discord identity currently sits in the top-N —
  // used to detect a watchlisted player who's relocated and/or renamed.
  // Needs at least one of discordId/discordTag; both may be passed.
  async locatePlayer({ discordId, discordTag, excludeWorld } = {}) {
    const params = new URLSearchParams();
    if (discordId) params.set("discord_id", discordId);
    if (discordTag) params.set("discord_tag", discordTag);
    if (excludeWorld) params.set("exclude_world", excludeWorld);
    return fetchJson(`/api/players/locate?${params.toString()}`);
  }
}
