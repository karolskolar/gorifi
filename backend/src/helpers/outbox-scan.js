// 21 §UC-WA-008 (WA-T5) — the release gate's RESCAN, for the two places where no
// template + vars exist to ask `template-render.js unresolvedFor()`:
//
//   • the admin's per-row body edit (`PATCH /api/notifications/:id/body`) — the text is
//     the admin's own, so there is nothing to resolve it against;
//   • the one-time boot back-fill of `notifications.unresolved` for rows written before
//     the column existed (`db/schema.js backfillNotificationUnresolved()`).
//
// ⚠ NEVER USE THIS ON A BODY THE RENDERER JUST PRODUCED. A value can carry braces (a
// guest named „{suma}"): a rescan of a rendered body would block that row for nothing,
// and only `unresolvedFor(template, vars)` knows which literal came from the TEMPLATE
// (learnings 15 §WA-T2 — the first cut's `unresolvedPlaceholders(text)` export was
// deleted from template-render.js for exactly this reason, and a spec pins its absence).
// Every writer that renders (enqueue, compose, rerender) stores `unresolvedFor()`'s
// answer; only the two cases above store this one.
//
// The rescan can only OVER-block, never under-block: every literal placeholder a
// template left in a text is still in it, and this regex (the spec's own,
// `/\{[^{}\s]{1,40}\}/`) matches each of the eight vocabulary names. What it adds is
// any OTHER brace pair without whitespace — `{tracking}` the admin forgot, but also a
// stray `{x}` the admin typed on purpose; that row stays blocked until the admin edits
// it again. Recorded, accepted (the admin sees the warning outline in the composer).
//
// PURE — no DB import: `db/schema.js` imports it at boot.

export const RELEASE_PLACEHOLDER = /\{[^{}\s]{1,40}\}/gu;

/** The distinct literal placeholder tokens in `text`, in first-seen order ([] for a non-string). */
export function scanPlaceholders(text) {
  if (typeof text !== 'string') return [];
  return [...new Set(text.match(RELEASE_PLACEHOLDER) || [])];
}

/** The stored form of `notifications.unresolved`: a JSON array of distinct tokens (`'[]'` = resolved). */
export function unresolvedColumn(tokens) {
  return JSON.stringify([...new Set(Array.isArray(tokens) ? tokens.filter((t) => typeof t === 'string') : [])]);
}
