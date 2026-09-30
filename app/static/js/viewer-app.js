import { ApiClient } from "./api-client.js";
import {
  debounce,
  escapeHtml,
  formatNumber,
  formatRelativeTime,
  formatSigned,
  sortRows,
  updateSortHeaders,
} from "./shared.js";
import { drawSparkline } from "./sparkline.js";
import * as watchlistStore from "./watchlists.js";

const AVATAR_FALLBACK =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' rx='6' fill='%23283340'/%3E%3C/svg%3E";

export class ViewerApp {
  constructor() {
    this.api = new ApiClient();
    this.worlds = [];

    this.activeTab = "leaderboard";

    // ── Leaderboard tab state ──────────────────────────────────────────
    this.lbMapVersion = 2;
    this.lbWorldId = null;
    this.lbDays = 7;
    this.lbNameFilter = "";
    this.lbMinOutposts = null;
    this.lbMaxOutposts = null;
    this.lbSort = { field: "rank_now", dir: "asc" };
    this.lbRows = [];

    // ── Watchlists tab state ───────────────────────────────────────────
    this.wlDays = 7;
    this.wlSelectedId = watchlistStore.getSelectedId();
    this.wlAddPicked = null; // {username, world, world_name, map_version} once resolved from a global search match
    this.wlSort = { field: "username", dir: "asc" };
    this.wlRows = [];
    this.wlSearchMatches = [];
    this.wlSearchActiveIndex = -1;
    this.wlLoadToken = 0;

    this.ioModalMode = "export"; // "export" | "import"

    // ── History modal (per-player poll-by-poll table) ──────────────────
    this.historyPlayer = null; // {world, worldName, username} of whoever the modal is currently showing
    this.historyDays = 30;

    this.elements = {
      tabButtons: document.querySelectorAll(".tab-button"),
      leaderboardTab: document.getElementById("leaderboard-tab"),
      watchlistsTab: document.getElementById("watchlists-tab"),

      lbMapVersionTabs: document.getElementById("lb-map-version-tabs"),
      lbWorldTabs: document.getElementById("lb-world-tabs"),
      lbRangePills: document.getElementById("lb-range-pills"),
      lbNameFilter: document.getElementById("lb-name-filter"),
      lbMinOutposts: document.getElementById("lb-min-outposts"),
      lbMaxOutposts: document.getElementById("lb-max-outposts"),
      lbStatus: document.getElementById("lb-status"),
      lbTable: document.getElementById("lb-table"),
      lbTbody: document.getElementById("lb-tbody"),
      lbEmpty: document.getElementById("lb-empty"),
      lbThStrongholds: document.getElementById("lb-th-strongholds"),
      lbThDeltaStrongholds: document.getElementById("lb-th-delta-strongholds"),

      watchlistList: document.getElementById("watchlist-list"),
      watchlistNewButton: document.getElementById("watchlist-new-button"),
      watchlistImportButton: document.getElementById("watchlist-import-button"),
      watchlistExportButton: document.getElementById("watchlist-export-button"),
      watchlistTitle: document.getElementById("watchlist-title"),
      watchlistRenameButton: document.getElementById("watchlist-rename-button"),
      watchlistDeleteButton: document.getElementById("watchlist-delete-button"),
      wlRangePills: document.getElementById("wl-range-pills"),

      wlAddNameInput: document.getElementById("wl-add-name-input"),
      wlAddResults: document.getElementById("wl-add-results"),
      wlAddPickedNote: document.getElementById("wl-add-picked-note"),
      wlAddButton: document.getElementById("wl-add-button"),

      wlTable: document.getElementById("wl-table"),
      wlTbody: document.getElementById("wl-tbody"),
      wlEmpty: document.getElementById("wl-empty"),

      newListModal: document.getElementById("new-list-modal"),
      newListNameInput: document.getElementById("new-list-name-input"),
      newListCreateButton: document.getElementById("new-list-create-button"),
      newListCloseButton: document.getElementById("new-list-close-button"),

      renameListModal: document.getElementById("rename-list-modal"),
      renameListNameInput: document.getElementById("rename-list-name-input"),
      renameListSaveButton: document.getElementById("rename-list-save-button"),
      renameListCloseButton: document.getElementById("rename-list-close-button"),

      ioModal: document.getElementById("io-modal"),
      ioModalTitle: document.getElementById("io-modal-title"),
      ioModalTextarea: document.getElementById("io-modal-textarea"),
      ioModalStatus: document.getElementById("io-modal-status"),
      ioModalCopyButton: document.getElementById("io-modal-copy-button"),
      ioModalImportButton: document.getElementById("io-modal-import-button"),
      ioModalCloseButton: document.getElementById("io-modal-close-button"),

      historyModal: document.getElementById("history-modal"),
      historyModalTitle: document.getElementById("history-modal-title"),
      historyModalCloseButton: document.getElementById("history-modal-close-button"),
      historyMoves: document.getElementById("history-moves"),
      historyRangePills: document.getElementById("history-range-pills"),
      historyTbody: document.getElementById("history-tbody"),
      historyEmpty: document.getElementById("history-empty"),
    };
  }

  async start() {
    this.bindEvents();
    this.renderWatchlistRail();
    this.renderWatchlistMain();

    try {
      this.worlds = (await this.api.getWorlds()) || [];
    } catch (error) {
      this.setLbStatus(error.message || "Failed to load worlds.");
      return;
    }

    this.renderWorldTabs();
    await this.loadLeaderboard();
    this.syncAddPlayerAvailability();
  }

  bindEvents() {
    this.elements.tabButtons.forEach((btn) => {
      btn.addEventListener("click", () => this.switchTab(btn.dataset.tab));
    });

    // ── Leaderboard tab ───────────────────────────────────────────────
    this.elements.lbMapVersionTabs.addEventListener("click", async (event) => {
      const btn = event.target.closest(".pill-button");
      if (!btn || btn.classList.contains("active")) return;
      this.elements.lbMapVersionTabs.querySelectorAll(".pill-button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      this.lbMapVersion = Number(btn.dataset.mapVersion);
      this.renderWorldTabs();
      await this.loadLeaderboard();
    });

    this.elements.lbWorldTabs.addEventListener("click", async (event) => {
      const btn = event.target.closest(".tab-chip");
      if (!btn || btn.classList.contains("active")) return;
      this.lbWorldId = btn.dataset.worldId;
      this.renderWorldTabs();
      await this.loadLeaderboard();
    });

    this.bindPillGroup(this.elements.lbRangePills, async (days) => {
      this.lbDays = days;
      await this.loadLeaderboard();
    });

    const rerenderLb = debounce(() => this.renderLeaderboardTable(), 150);
    this.elements.lbNameFilter.addEventListener("input", () => {
      this.lbNameFilter = this.elements.lbNameFilter.value.trim().toLowerCase();
      rerenderLb();
    });
    this.elements.lbMinOutposts.addEventListener("input", () => {
      this.lbMinOutposts = this.elements.lbMinOutposts.value === "" ? null : Number(this.elements.lbMinOutposts.value);
      rerenderLb();
    });
    this.elements.lbMaxOutposts.addEventListener("input", () => {
      this.lbMaxOutposts = this.elements.lbMaxOutposts.value === "" ? null : Number(this.elements.lbMaxOutposts.value);
      rerenderLb();
    });

    this.elements.lbTable.querySelector("thead").addEventListener("click", (event) => {
      const th = event.target.closest("th[data-sort]");
      if (!th || th.hidden) return;
      this.lbSort = this.nextSort(this.lbSort, th.dataset.sort);
      this.renderLeaderboardTable();
    });

    // ── Watchlists tab ────────────────────────────────────────────────
    this.elements.watchlistList.addEventListener("click", (event) => {
      const item = event.target.closest(".watchlist-item");
      if (!item) return;
      this.selectWatchlist(item.dataset.id);
    });

    this.elements.watchlistNewButton.addEventListener("click", () => {
      this.elements.newListNameInput.value = "";
      this.elements.newListModal.hidden = false;
      this.elements.newListNameInput.focus();
    });
    this.elements.newListCloseButton.addEventListener("click", () => { this.elements.newListModal.hidden = true; });
    this.elements.newListCreateButton.addEventListener("click", () => {
      const name = this.elements.newListNameInput.value.trim();
      if (!name) return;
      const watchlist = watchlistStore.createWatchlist(name);
      this.elements.newListModal.hidden = true;
      this.selectWatchlist(watchlist.id);
    });

    this.elements.watchlistRenameButton.addEventListener("click", () => {
      const watchlist = watchlistStore.getWatchlist(this.wlSelectedId);
      if (!watchlist) return;
      this.elements.renameListNameInput.value = watchlist.name;
      this.elements.renameListModal.hidden = false;
      this.elements.renameListNameInput.focus();
    });
    this.elements.renameListCloseButton.addEventListener("click", () => { this.elements.renameListModal.hidden = true; });
    this.elements.renameListSaveButton.addEventListener("click", () => {
      const name = this.elements.renameListNameInput.value.trim();
      if (!name || !this.wlSelectedId) return;
      watchlistStore.renameWatchlist(this.wlSelectedId, name);
      this.elements.renameListModal.hidden = true;
      this.renderWatchlistRail();
      this.renderWatchlistMain();
    });

    this.elements.watchlistDeleteButton.addEventListener("click", () => {
      const watchlist = watchlistStore.getWatchlist(this.wlSelectedId);
      if (!watchlist) return;
      if (!window.confirm(`Delete "${watchlist.name}"? This can't be undone.`)) return;
      watchlistStore.deleteWatchlist(watchlist.id);
      this.wlSelectedId = null;
      this.renderWatchlistRail();
      this.renderWatchlistMain();
    });

    this.bindPillGroup(this.elements.wlRangePills, async (days) => {
      this.wlDays = days;
      await this.loadWatchlistPlayers();
    });

    const debouncedSearch = debounce(() => this.searchAddPlayerCandidates(), 200);
    this.elements.wlAddNameInput.addEventListener("input", () => {
      // Editing after a pick invalidates it immediately, rather than silently
      // keeping the stale world attached to whatever's now typed.
      this.wlAddPicked = null;
      this.syncAddPlayerAvailability();
      debouncedSearch();
    });
    this.elements.wlAddNameInput.addEventListener("keydown", (event) => this.handleAddNameKeyDown(event));
    this.elements.wlAddNameInput.addEventListener("blur", () => {
      // Typing an exact name and tabbing away without clicking a suggestion
      // should still resolve it — but only when it's unambiguous (exactly one
      // world has that exact username); with more than one match, force an
      // explicit pick instead of silently guessing which world was meant.
      const query = this.elements.wlAddNameInput.value.trim().toLowerCase();
      if (query && !this.wlAddPicked) {
        const exact = this.wlSearchMatches.filter((m) => m.username.toLowerCase() === query);
        if (exact.length === 1) this.pickAddCandidate(exact[0]);
      }
      window.setTimeout(() => { this.elements.wlAddResults.hidden = true; }, 150);
    });
    this.elements.wlAddButton.addEventListener("click", () => this.addPlayerToWatchlist());

    this.elements.wlTable.querySelector("thead").addEventListener("click", (event) => {
      const th = event.target.closest("th[data-sort]");
      if (!th) return;
      this.wlSort = this.nextSort(this.wlSort, th.dataset.sort);
      this.renderWatchlistTable();
    });
    this.elements.wlTbody.addEventListener("click", (event) => {
      const removeBtn = event.target.closest("[data-remove-player-id]");
      if (removeBtn) {
        watchlistStore.removePlayer(this.wlSelectedId, removeBtn.dataset.removePlayerId);
        this.loadWatchlistPlayers();
        return;
      }

      const historyBtn = event.target.closest("[data-history-player-id]");
      if (historyBtn) {
        const row = this.wlRows.find((r) => r.player.id === historyBtn.dataset.historyPlayerId);
        if (row) this.openHistoryModal(row.player);
      }
    });

    this.elements.watchlistImportButton.addEventListener("click", () => this.openIoModal("import"));
    this.elements.watchlistExportButton.addEventListener("click", () => this.openIoModal("export"));
    this.elements.ioModalCloseButton.addEventListener("click", () => { this.elements.ioModal.hidden = true; });
    this.elements.ioModalCopyButton.addEventListener("click", () => this.copyIoModalText());
    this.elements.ioModalImportButton.addEventListener("click", () => this.runImport());

    this.elements.historyModalCloseButton.addEventListener("click", () => { this.elements.historyModal.hidden = true; });
    this.bindPillGroup(this.elements.historyRangePills, async (days) => {
      this.historyDays = days;
      await this.loadHistoryModal();
    });
  }

  // ─── Shared helpers ────────────────────────────────────────────────────

  switchTab(tab) {
    if (!tab || tab === this.activeTab) return;
    this.activeTab = tab;
    this.elements.tabButtons.forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
    this.elements.leaderboardTab.hidden = tab !== "leaderboard";
    this.elements.watchlistsTab.hidden = tab !== "watchlists";
  }

  bindPillGroup(container, onChange) {
    container.addEventListener("click", async (event) => {
      const btn = event.target.closest(".pill-button");
      if (!btn || btn.classList.contains("active")) return;
      container.querySelectorAll(".pill-button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      await onChange(Number(btn.dataset.days));
    });
  }

  nextSort(current, field) {
    if (current.field === field) {
      return { field, dir: current.dir === "asc" ? "desc" : "asc" };
    }
    // Rank-like fields default to ascending (lower is better); everything else descending.
    const ascByDefault = field === "rank_now" || field === "username";
    return { field, dir: ascByDefault ? "asc" : "desc" };
  }

  // World picker for the Leaderboard tab — a row of clickable chips (see
  // .tab-strip/.tab-chip in styles.css) instead of a <select>, so checking
  // several worlds in a row is one click each rather than open-dropdown-then-
  // click every time.
  renderWorldTabs() {
    const worlds = this.worlds.filter((w) => Number(w.map_version) === this.lbMapVersion);
    const container = this.elements.lbWorldTabs;

    if (!worlds.length) {
      container.innerHTML = '<span class="muted">No worlds polled yet.</span>';
      this.lbWorldId = null;
      return;
    }

    if (!this.lbWorldId || !worlds.some((w) => w.uuid === this.lbWorldId)) {
      this.lbWorldId = worlds[0].uuid;
    }

    container.innerHTML = worlds
      .map((w) => `<button type="button" class="tab-chip${w.uuid === this.lbWorldId ? " active" : ""}" data-world-id="${escapeHtml(w.uuid)}">${escapeHtml(w.name)}</button>`)
      .join("");
  }

  getWorldName(worldUuid, fallback = "") {
    return this.worlds.find((w) => w.uuid === worldUuid)?.name || fallback || worldUuid;
  }

  setLbStatus(msg) {
    this.elements.lbStatus.textContent = msg || "";
  }

  // ─── Leaderboard tab ───────────────────────────────────────────────────

  async loadLeaderboard() {
    if (!this.lbWorldId) {
      this.lbRows = [];
      this.renderLeaderboardTable();
      return;
    }

    const isMr3 = this.lbMapVersion === 3;
    this.elements.lbThStrongholds.hidden = !isMr3;
    this.elements.lbThDeltaStrongholds.hidden = !isMr3;

    this.setLbStatus("Loading…");
    try {
      const data = await this.api.getLeaderboardDeltas(this.lbWorldId, this.lbDays);
      this.lbRows = data.players || [];
      const asOf = data.current_polled_at ? `Updated ${formatRelativeTime(data.current_polled_at)}` : "No data yet";
      // The baseline is always <= lbDays old (see resolve_baseline_poll in
      // db.py) — it never reaches further back than what was requested.
      // baseline_hit_start_of_history just means that baseline also happens
      // to be this world's very first poll ever, i.e. there isn't more
      // history to have used even if the request allowed it — worth saying
      // plainly rather than leaving it looking like an arbitrary shortfall.
      let baseline = ", no earlier snapshot within this range yet";
      if (data.baseline_polled_at) {
        baseline = data.baseline_hit_start_of_history
          ? `, comparing to ${formatRelativeTime(data.baseline_polled_at)} (earliest data available)`
          : `, comparing to ${formatRelativeTime(data.baseline_polled_at)}`;
      }
      this.setLbStatus(`${asOf}${data.current_polled_at ? baseline : ""}`);
    } catch (error) {
      this.lbRows = [];
      this.setLbStatus(error.message || "Failed to load leaderboard.");
    }
    this.renderLeaderboardTable();
  }

  applyLeaderboardFilters(rows) {
    return rows.filter((row) => {
      if (this.lbNameFilter && !row.username.toLowerCase().includes(this.lbNameFilter)) return false;
      // outpost_count_now only, no fallback to outpost_count_then — a
      // dropped-out player's baseline count is old, possibly-inflated data
      // (see the watchlist "Stale" fix); filtering by a live threshold
      // shouldn't be able to match someone on a number that's no longer
      // theirs. A dropped-out player (outposts === null here) is correctly
      // excluded whenever a min/max filter is actually set.
      const outposts = row.outpost_count_now;
      if (this.lbMinOutposts !== null && (outposts === null || outposts < this.lbMinOutposts)) return false;
      if (this.lbMaxOutposts !== null && (outposts === null || outposts > this.lbMaxOutposts)) return false;
      return true;
    });
  }

  renderLeaderboardTable() {
    const filtered = this.applyLeaderboardFilters(this.lbRows);
    const sorted = sortRows(filtered, this.lbSort);
    updateSortHeaders(this.elements.lbTable, this.lbSort);

    this.elements.lbTbody.replaceChildren();
    this.elements.lbEmpty.hidden = sorted.length > 0;
    if (!sorted.length) return;

    const isMr3 = this.lbMapVersion === 3;
    for (const row of sorted) {
      this.elements.lbTbody.appendChild(this.buildLeaderboardRow(row, isMr3));
    }
  }

  buildLeaderboardRow(row, isMr3) {
    const tr = document.createElement("tr");
    const droppedOut = row.rank_now === null && row.rank_then !== null;
    const isNew = row.rank_then === null && row.rank_now !== null;
    const rankDelta = formatSigned(row.delta_rank);
    const outpostsDelta = formatSigned(row.delta_outposts);
    const strongholdsDelta = formatSigned(row.delta_strongholds);

    tr.innerHTML = `
      <td>${row.rank_now !== null ? `#${row.rank_now}` : droppedOut ? `<span class="tag">Dropped out</span>` : "—"}</td>
      <td class="${rankDelta.cls}">${rankDelta.text}</td>
      <td class="col-left">
        <div class="player-cell">
          <img class="player-avatar" src="${escapeHtml(row.pic_square || AVATAR_FALLBACK)}" alt="" loading="lazy">
          <span class="player-name">${escapeHtml(row.username)}</span>
          ${isNew ? `<span class="tag">New</span>` : ""}
        </div>
      </td>
      <td>${formatNumber(row.outpost_count_now)}</td>
      <td class="${outpostsDelta.cls}">${outpostsDelta.text}</td>
      ${isMr3 ? `<td>${formatNumber(row.stronghold_count_now)}</td>` : ""}
      ${isMr3 ? `<td class="${strongholdsDelta.cls}">${strongholdsDelta.text}</td>` : ""}
    `;
    this.wireAvatarFallback(tr);
    return tr;
  }

  // Wired via JS rather than an inline onerror="..." attribute — a fallback
  // data: URI with literal quotes inside it (e.g. an SVG's xmlns='...') can
  // break out of that attribute's own quoting depending on which quote style
  // wraps it, so building the handler as an HTML string is fragile no matter
  // how careful the escaping is. addEventListener sidesteps the whole class
  // of bug.
  wireAvatarFallback(root) {
    root.querySelectorAll("img.player-avatar").forEach((img) => {
      img.addEventListener("error", () => { img.src = AVATAR_FALLBACK; }, { once: true });
    });
  }

  // ─── Watchlists tab ────────────────────────────────────────────────────

  renderWatchlistRail() {
    const lists = watchlistStore.listWatchlists();
    this.elements.watchlistList.replaceChildren();

    if (!lists.length) {
      const p = document.createElement("p");
      p.className = "muted";
      p.style.padding = "6px 4px";
      p.textContent = "No lists yet.";
      this.elements.watchlistList.appendChild(p);
      return;
    }

    for (const watchlist of lists) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `watchlist-item${watchlist.id === this.wlSelectedId ? " active" : ""}`;
      btn.dataset.id = watchlist.id;
      btn.innerHTML = `
        <span class="player-name">${escapeHtml(watchlist.name)}</span>
        <span class="watchlist-item-count">${watchlist.players.length}</span>
      `;
      this.elements.watchlistList.appendChild(btn);
    }
  }

  selectWatchlist(id) {
    this.wlSelectedId = id;
    watchlistStore.setSelectedId(id);
    this.renderWatchlistRail();
    this.renderWatchlistMain();
  }

  renderWatchlistMain() {
    const watchlist = watchlistStore.getWatchlist(this.wlSelectedId);
    const hasSelection = !!watchlist;
    this.elements.watchlistTitle.textContent = watchlist ? watchlist.name : "No list selected";
    this.elements.watchlistRenameButton.disabled = !hasSelection;
    this.elements.watchlistDeleteButton.disabled = !hasSelection;

    if (!hasSelection) {
      this.wlRows = [];
      this.elements.wlTbody.replaceChildren();
      this.elements.wlEmpty.hidden = false;
      this.elements.wlEmpty.textContent = "Select or create a watchlist to get started.";
      this.syncAddPlayerAvailability();
      return;
    }

    this.loadWatchlistPlayers();
  }

  syncAddPlayerAvailability() {
    this.elements.wlAddButton.disabled = !(this.wlSelectedId && this.wlAddPicked);
    if (this.wlAddPicked) {
      this.elements.wlAddPickedNote.hidden = false;
      this.elements.wlAddPickedNote.textContent =
        `Will add on ${this.wlAddPicked.world_name} (MR${this.wlAddPicked.map_version})`;
    } else {
      this.elements.wlAddPickedNote.hidden = true;
    }
  }

  async loadWatchlistPlayers() {
    const watchlist = watchlistStore.getWatchlist(this.wlSelectedId);
    if (!watchlist) return;

    this.syncAddPlayerAvailability();

    const token = ++this.wlLoadToken;
    this.elements.wlEmpty.hidden = watchlist.players.length > 0;
    this.elements.wlEmpty.textContent = "No players in this list yet — add one above.";
    if (!watchlist.players.length) {
      this.wlRows = [];
      this.elements.wlTbody.replaceChildren();
      return;
    }

    const rows = await Promise.all(
      watchlist.players.map(async (playerSnapshot) => {
        try {
          // Reconcile against the player's real current location BEFORE
          // fetching stats — see resolveCurrentLocation(). It may rewrite
          // this entry's stored world/username as a side effect, so re-read
          // the authoritative record from storage afterward rather than
          // trusting the snapshot taken at the top of this map(): storage
          // updates go through a freshly-deserialized copy (see
          // updatePlayerLocation in watchlists.js), not this object, so
          // `playerSnapshot` itself never reflects a change made this cycle.
          await this.resolveCurrentLocation(playerSnapshot);
          const player = watchlistStore.getWatchlist(this.wlSelectedId)?.players.find((p) => p.id === playerSnapshot.id) || playerSnapshot;

          const [deltas, history] = await Promise.all([
            this.api.getPlayerDeltas(player.world, player.username, this.wlDays),
            this.api.getPlayerHistory(player.world, player.username, this.wlDays),
          ]);
          return { player, deltas, history, error: null };
        } catch (error) {
          return { player: playerSnapshot, deltas: null, history: [], error: error.message || "Failed to load." };
        }
      }),
    );

    if (token !== this.wlLoadToken) return; // superseded by a newer load (list/range switch)
    this.wlRows = rows;
    this.renderWatchlistTable();
  }

  // Runs on every load, for every player — not just ones already flagged
  // stale — so a relocation/rename is reflected the moment it happens
  // rather than requiring a human to notice a "Stale" tag and confirm a
  // suggestion. Every player account is uniquely tied to one Discord
  // account, so discordId/discordTag (captured at add-time from the search
  // result) is a dependable way to ask "where does this identity currently
  // rank, across every world?" — find_current_sightings() already prefers
  // discordId when available and only falls back to discordTag when it
  // isn't (e.g. a player with no custom Discord avatar has no parseable
  // discordId, but still has a discordTag). A no-op if nothing's changed,
  // or if this entry somehow has neither identity field (very old/malformed
  // data — search always captures at least one for a live search result).
  async resolveCurrentLocation(player) {
    if (!player.discordId && !player.discordTag) return;

    let sightings;
    try {
      sightings = await this.api.locatePlayer({ discordId: player.discordId, discordTag: player.discordTag });
    } catch {
      return; // best-effort — leave the last-known location in place on a failed lookup
    }
    if (!sightings.length) return; // not currently ranked anywhere — keep the last-known pin, shows as Stale

    const current = sightings[0]; // most-recently-polled sighting, if the identity somehow shows up in more than one world at once
    if (current.world === player.world && current.username === player.username) return; // unchanged

    watchlistStore.updatePlayerLocation(this.wlSelectedId, player.id, {
      world: current.world, worldName: current.world_name, username: current.username,
    });
  }

  renderWatchlistTable() {
    // Same is_current gating as the display in buildWatchlistRow() — a stale
    // entry's "now"/delta fields are really "as of last_seen_polled_at",
    // shown as "—" rather than a live number, so they must also sort as
    // missing (sinks to the bottom via sortRows) rather than by that hidden
    // stale value.
    const sortable = this.wlRows.map((r) => {
      const current = r.deltas?.is_current;
      return {
        ...r,
        username: r.player.username,
        rank_now: current ? r.deltas.rank_now : null,
        delta_rank: current ? r.deltas.delta_rank : null,
        outpost_count_now: current ? r.deltas.outpost_count_now : null,
        delta_outposts: current ? r.deltas.delta_outposts : null,
        stronghold_count_now: current ? r.deltas.stronghold_count_now : null,
        delta_strongholds: current ? r.deltas.delta_strongholds : null,
      };
    });
    const sorted = sortRows(sortable, this.wlSort);
    updateSortHeaders(this.elements.wlTable, this.wlSort);

    this.elements.wlTbody.replaceChildren();
    this.elements.wlEmpty.hidden = sorted.length > 0;
    if (!sorted.length) return;

    for (const row of sorted) {
      this.elements.wlTbody.appendChild(this.buildWatchlistRow(row));
    }
  }

  buildWatchlistRow(row) {
    const { player, deltas, history, error } = row;
    const tr = document.createElement("tr");

    if (error || !deltas) {
      tr.innerHTML = `
        <td class="col-left"><div class="player-cell"><span class="player-name">${escapeHtml(player.username)}</span></div></td>
        <td class="col-left">${escapeHtml(this.getWorldName(player.world, player.worldName))}</td>
        <td colspan="7" class="muted">${escapeHtml(error || "No data.")}</td>
      `;
      const removeTd = document.createElement("td");
      removeTd.innerHTML = `<button class="icon-button" type="button" data-remove-player-id="${escapeHtml(player.id)}" aria-label="Remove">×</button>`;
      tr.appendChild(removeTd);
      return tr;
    }

    // deltas.outpost_count_now etc. are the player's stats as of
    // last_seen_polled_at, which can be long before this world's actual
    // latest poll once they've dropped out of the top-N (see
    // get_player_deltas() in db.py) — real numbers, but stale ones. Gating
    // every "now"/delta column on is_current, the same way the rank column
    // already was, stops a recycled/relocated player's old outpost count
    // from being displayed as if it were their current one.
    const rankDelta = deltas.is_current ? formatSigned(deltas.delta_rank) : { text: "—", cls: "neutral" };
    const outpostsDelta = deltas.is_current ? formatSigned(deltas.delta_outposts) : { text: "—", cls: "neutral" };
    const strongholdsDelta = deltas.is_current ? formatSigned(deltas.delta_strongholds) : { text: "—", cls: "neutral" };

    // resolveCurrentLocation() already reconciled this entry against its
    // live Discord identity before this render — reaching "Stale" here
    // means the identity genuinely isn't ranked in ANY tracked world right
    // now (not just moved), so there's nothing left to suggest or update.
    let staleNote = "";
    if (!deltas.is_current) {
      const lastSeen = `Last seen ${formatRelativeTime(deltas.last_seen_polled_at)}${deltas.rank_now !== null ? ` at #${deltas.rank_now}` : ""}`;
      staleNote = `<div class="last-seen-note">${lastSeen}</div>`;
      if (!player.discordId && !player.discordTag) {
        staleNote += `<div class="last-seen-note">No linked Discord on this entry — can't auto-track if they move.</div>`;
      }
    }

    tr.innerHTML = `
      <td class="col-left">
        <div class="player-cell">
          <img class="player-avatar" src="${escapeHtml(deltas.pic_square || AVATAR_FALLBACK)}" alt="" loading="lazy">
          <div>
            <span class="player-name">${escapeHtml(player.username)}</span>
            ${!deltas.is_current ? `<span class="tag">Stale</span>` : ""}
            ${staleNote}
          </div>
        </div>
      </td>
      <td class="col-left">${escapeHtml(this.getWorldName(player.world, player.worldName))}</td>
      <td>${deltas.is_current && deltas.rank_now !== null ? `#${deltas.rank_now}` : "—"}</td>
      <td class="${rankDelta.cls}">${rankDelta.text}</td>
      <td>${deltas.is_current ? formatNumber(deltas.outpost_count_now) : "—"}</td>
      <td class="${outpostsDelta.cls}">${outpostsDelta.text}</td>
      <td>${deltas.is_current ? formatNumber(deltas.stronghold_count_now) : "—"}</td>
      <td class="${strongholdsDelta.cls}">${strongholdsDelta.text}</td>
      <td class="col-left">
        <div class="trend-cell">
          <canvas class="sparkline"></canvas>
          <button type="button" class="icon-button" data-history-player-id="${escapeHtml(player.id)}" aria-label="View history" title="View full history">▤</button>
        </div>
      </td>
      <td><button class="icon-button" type="button" data-remove-player-id="${escapeHtml(player.id)}" aria-label="Remove">×</button></td>
    `;

    const canvas = tr.querySelector("canvas.sparkline");
    const nowSec = Math.floor(Date.now() / 1000);
    window.requestAnimationFrame(() => {
      drawSparkline(canvas, history, { rangeStartSec: nowSec - this.wlDays * 86400, rangeEndSec: nowSec });
    });

    this.wireAvatarFallback(tr);
    return tr;
  }

  // ─── History modal — full poll-by-poll table for one player ────────────
  // Reuses the same /api/players/history the sparkline already pulls from,
  // just rendered as a full table instead of a 96px canvas.

  async openHistoryModal(player) {
    this.historyPlayer = player;
    this.elements.historyModalTitle.textContent =
      `${player.username} — ${this.getWorldName(player.world, player.worldName)}`;
    this.renderMoveHistory(player);
    this.elements.historyModal.hidden = false;
    await this.loadHistoryModal();
  }

  // Every auto-resolved relocation/rename (see resolveCurrentLocation())
  // gets logged into the entry's own locationHistory — shown here,
  // most-recent move first, independent of the poll-history range pills
  // since it's metadata about the entry itself, not a per-poll data point.
  renderMoveHistory(player) {
    const moves = Array.isArray(player.locationHistory) ? player.locationHistory : [];
    const el = this.elements.historyMoves;
    if (!moves.length) {
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    el.hidden = false;
    el.innerHTML = `
      <p class="eyebrow">Move history</p>
      ${[...moves].reverse().map((m) => `
        <div class="history-move-row">
          <span>${escapeHtml(new Date(m.changedAt).toLocaleDateString())}:</span>
          ${escapeHtml(m.fromUsername)} on ${escapeHtml(m.fromWorldName || m.fromWorld)}
          → <strong>${escapeHtml(m.toUsername)}</strong> on ${escapeHtml(m.toWorldName || m.toWorld)}
        </div>
      `).join("")}
    `;
  }

  async loadHistoryModal() {
    if (!this.historyPlayer) return;
    this.elements.historyTbody.replaceChildren();
    this.elements.historyEmpty.hidden = true;

    try {
      const rows = await this.api.getPlayerHistory(this.historyPlayer.world, this.historyPlayer.username, this.historyDays);
      this.renderHistoryTable(rows);
    } catch (error) {
      this.elements.historyEmpty.hidden = false;
      this.elements.historyEmpty.textContent = error.message || "Failed to load history.";
    }
  }

  // Poll-by-poll, most recent first — each row's Δ is against the PREVIOUS
  // poll chronologically (bank-statement style: every row shows that poll's
  // own change, not a change against "now"), computed here since the API
  // returns raw polls, not deltas between them.
  renderHistoryTable(rows) {
    this.elements.historyEmpty.hidden = rows.length > 0;
    if (!rows.length) {
      this.elements.historyEmpty.textContent = "No polls in this range yet.";
      return;
    }

    const chronological = [...rows].sort((a, b) => a.polled_at - b.polled_at);
    const withDeltas = chronological.map((row, i) => {
      const prev = chronological[i - 1];
      return {
        ...row,
        delta_outposts: prev ? row.outpost_count - prev.outpost_count : null,
        delta_strongholds: prev && row.stronghold_count !== null && prev.stronghold_count !== null
          ? row.stronghold_count - prev.stronghold_count
          : null,
      };
    });

    this.elements.historyTbody.replaceChildren();
    for (const row of [...withDeltas].reverse()) {
      const outpostsDelta = formatSigned(row.delta_outposts);
      const strongholdsDelta = formatSigned(row.delta_strongholds);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(new Date(row.polled_at * 1000).toLocaleString())}</td>
        <td>#${row.rank}</td>
        <td>${formatNumber(row.outpost_count)}</td>
        <td class="${outpostsDelta.cls}">${outpostsDelta.text}</td>
        <td>${row.stronghold_count !== null ? formatNumber(row.stronghold_count) : "—"}</td>
        <td class="${strongholdsDelta.cls}">${row.stronghold_count !== null ? strongholdsDelta.text : "—"}</td>
      `;
      this.elements.historyTbody.appendChild(tr);
    }
  }

  // ─── Add-player autocomplete ────────────────────────────────────────────
  // Searches every polled world at once (no world/map-room picker needed) —
  // each match already carries which world it was found on, so picking one
  // auto-detects the world instead of asking for it up front.

  async searchAddPlayerCandidates() {
    const term = this.elements.wlAddNameInput.value.trim();
    if (!term) {
      this.wlSearchMatches = [];
      this.elements.wlAddResults.hidden = true;
      return;
    }

    try {
      const matches = await this.api.searchPlayers(term, 25);
      this.wlSearchMatches = matches || [];
    } catch {
      this.wlSearchMatches = [];
    }
    this.wlSearchActiveIndex = this.wlSearchMatches.length ? 0 : -1;
    this.renderAddPlayerResults();
  }

  renderAddPlayerResults() {
    const el = this.elements.wlAddResults;
    if (!this.wlSearchMatches.length) {
      el.hidden = true;
      el.replaceChildren();
      return;
    }
    el.innerHTML = this.wlSearchMatches
      .map((m, i) => `<button type="button" class="search-result-item${i === this.wlSearchActiveIndex ? " active" : ""}" data-index="${i}">${escapeHtml(m.username)} <span class="muted">— ${escapeHtml(m.world_name)} (MR${m.map_version})</span></button>`)
      .join("");
    el.hidden = false;
    el.querySelectorAll(".search-result-item").forEach((btn) => {
      btn.addEventListener("mousedown", (event) => {
        event.preventDefault();
        this.pickAddCandidate(this.wlSearchMatches[Number(btn.dataset.index)]);
      });
    });
  }

  pickAddCandidate(candidate) {
    this.wlAddPicked = candidate;
    this.elements.wlAddNameInput.value = candidate.username;
    this.elements.wlAddResults.hidden = true;
    this.syncAddPlayerAvailability();
  }

  handleAddNameKeyDown(event) {
    if (event.key === "ArrowDown" && this.wlSearchMatches.length) {
      event.preventDefault();
      this.wlSearchActiveIndex = (this.wlSearchActiveIndex + 1) % this.wlSearchMatches.length;
      this.renderAddPlayerResults();
    } else if (event.key === "ArrowUp" && this.wlSearchMatches.length) {
      event.preventDefault();
      this.wlSearchActiveIndex = (this.wlSearchActiveIndex - 1 + this.wlSearchMatches.length) % this.wlSearchMatches.length;
      this.renderAddPlayerResults();
    } else if (event.key === "Enter" && this.wlSearchActiveIndex >= 0) {
      event.preventDefault();
      this.pickAddCandidate(this.wlSearchMatches[this.wlSearchActiveIndex]);
    }
  }

  addPlayerToWatchlist() {
    if (!this.wlAddPicked || !this.wlSelectedId) return;

    watchlistStore.addPlayer(this.wlSelectedId, {
      world: this.wlAddPicked.world,
      worldName: this.wlAddPicked.world_name,
      username: this.wlAddPicked.username,
      discordId: this.wlAddPicked.discord_id || null,
      discordTag: this.wlAddPicked.discord_tag || null,
    });

    this.elements.wlAddNameInput.value = "";
    this.elements.wlAddResults.hidden = true;
    this.wlAddPicked = null;
    this.syncAddPlayerAvailability();
    this.renderWatchlistRail();
    this.loadWatchlistPlayers();
  }

  // ─── Import / export ─────────────────────────────────────────────────

  openIoModal(mode) {
    this.ioModalMode = mode;
    this.elements.ioModalStatus.textContent = "";
    if (mode === "export") {
      this.elements.ioModalTitle.textContent = "Export watchlists";
      this.elements.ioModalTextarea.value = watchlistStore.exportWatchlists();
      this.elements.ioModalTextarea.readOnly = true;
      this.elements.ioModalCopyButton.hidden = false;
      this.elements.ioModalImportButton.hidden = true;
    } else {
      this.elements.ioModalTitle.textContent = "Import watchlists";
      this.elements.ioModalTextarea.value = "";
      this.elements.ioModalTextarea.readOnly = false;
      this.elements.ioModalTextarea.placeholder = "Paste exported watchlist JSON here…";
      this.elements.ioModalCopyButton.hidden = true;
      this.elements.ioModalImportButton.hidden = false;
    }
    this.elements.ioModal.hidden = false;
    this.elements.ioModalTextarea.focus();
  }

  async copyIoModalText() {
    try {
      await navigator.clipboard.writeText(this.elements.ioModalTextarea.value);
      this.elements.ioModalStatus.textContent = "Copied.";
    } catch {
      this.elements.ioModalStatus.textContent = "Couldn't copy automatically — select the text and copy manually.";
    }
  }

  runImport() {
    try {
      const summary = watchlistStore.importWatchlists(this.elements.ioModalTextarea.value);
      this.elements.ioModalStatus.textContent =
        `Imported: ${summary.listsCreated} new list(s), ${summary.listsMerged} merged, ${summary.playersAdded} player(s) added.`;
      this.renderWatchlistRail();
      this.renderWatchlistMain();
    } catch (error) {
      this.elements.ioModalStatus.textContent = error.message || "Import failed.";
    }
  }
}
