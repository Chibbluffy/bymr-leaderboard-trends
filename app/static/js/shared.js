const DEFAULT_TIMEOUT_MS = 15000;

// server.py is same-origin and backed by local SQLite reads, so it should
// never legitimately take long — but fetch() has no timeout of its own, and
// a client on a flaky mobile connection (or the rare stall from a big
// prune's VACUUM) would otherwise sit on "Loading…" forever with no way out
// but a manual reload. This aborts and surfaces a clear error instead.
export async function fetchJson(url, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Request timed out — the server may be unreachable. Try again.");
    }
    throw new Error(error?.message ? `Network error: ${error.message}` : "Network error.");
  } finally {
    window.clearTimeout(timer);
  }

  const rawBody = await response.text();
  const payload = parseJsonPayload(rawBody);

  if (!response.ok) {
    throw new Error((payload && payload.error) || response.statusText || "Request failed");
  }

  return payload;
}

export function parseJsonPayload(rawBody) {
  const text = String(rawBody || "").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[ch]);
}

export function formatNumber(value) {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-US").format(Number(value) || 0);
}

// "+42" / "-7" / "±0", colour-coded via the returned class name.
export function formatSigned(value) {
  if (value === null || value === undefined) return { text: "—", cls: "neutral" };
  const n = Number(value) || 0;
  if (n === 0) return { text: "±0", cls: "neutral" };
  return { text: `${n > 0 ? "+" : ""}${formatNumber(n)}`, cls: n > 0 ? "gain" : "loss" };
}

// Rank deltas read backwards from a raw numeric delta — a SMALLER rank number
// is better, so "rank improved by 3" is rank_then(10) - rank_now(7) = +3, and
// should still render as a gain (green), which formatSigned already does
// correctly since the caller passes that pre-computed difference straight in.
export function formatRankDelta(value) {
  return formatSigned(value);
}

export function formatRelativeTime(unixSeconds) {
  if (!unixSeconds) return "never";
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

export function debounce(fn, waitMs) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), waitMs);
  };
}

/** Reflects a table's sort state onto its <th data-sort> elements (arrow via CSS ::after). */
export function updateSortHeaders(table, { field, dir }) {
  if (!table) return;
  table.querySelectorAll("th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === field;
    th.toggleAttribute("data-sort-active", active);
    th.dataset.sortDir = active ? (dir === "asc" ? "▲" : "▼") : "";
  });
}

// Generic sort for the data tables here — {field, dir}. Missing/null values
// (e.g. a player who fell out of the top-N this period) always sink to the
// bottom regardless of direction, rather than jumping to the top on a
// descending sort the way a naive numeric comparison would treat them.
export function sortRows(rows, { field, dir }) {
  const mul = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a[field];
    const bv = b[field];
    const aMissing = av === null || av === undefined;
    const bMissing = bv === null || bv === undefined;
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof av === "string" || typeof bv === "string") {
      return mul * String(av).localeCompare(String(bv));
    }
    return mul * (Number(av) - Number(bv));
  });
}
