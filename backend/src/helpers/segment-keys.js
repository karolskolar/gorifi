import { bratislavaDay } from './template-render.js';

// ═══════════════════════════════════════════════════════════════════════════
// 21 §UC-WA-005 / §UC-WA-006 — THE SEGMENT-KEY GRAMMAR AND THE HAND-OVER KEY, PURE.
//
// WA-T4 moved these out of `helpers/segments.js` (which re-exports every one of them,
// so its WA-T3 surface is unchanged) for ONE reason: `db/schema.js` must compute the
// SAME key at boot to re-key DP-T3's legacy hook rows (`rekeyLegacyHandOverRows()`),
// and schema.js cannot import segments.js — segments.js imports the DB, i.e. schema.js,
// and a module cycle there would hand schema.js a module whose `db` binding is still in
// its temporal dead zone. This file imports ONLY `template-render.js` (pure, already a
// schema.js import), so the boot re-key and the live hook share one function instead of
// a second spelling of the grammar.
// ═══════════════════════════════════════════════════════════════════════════

/** 21 §UC-WA-008: `segment_key` grammar and bound. */
export const SEGMENT_KEY_MAX = 80;
const SEGMENT_KEY_SHAPE = /^[a-z_]+(:[A-Za-z0-9-]+)*$/;

/** Is `key` a grammatical segment key (a string, ≤ 80, the §UC-WA-008 pattern)? */
export function isSegmentKey(key) {
  return typeof key === 'string' && key.length <= SEGMENT_KEY_MAX && SEGMENT_KEY_SHAPE.test(key);
}

/**
 * The Europe/Bratislava calendar day (`YYYY-MM-DD`) of a SQLite UTC timestamp
 * (`YYYY-MM-DD HH:MM:SS`, `CURRENT_TIMESTAMP`'s shape — a `T`/`Z`/fraction is tolerated),
 * or null for anything that is not one.
 */
export function bratislavaDateOf(stamp) {
  if (typeof stamp !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)Z?$/.exec(stamp.trim());
  if (!m) return null;
  const instant = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(instant.getTime()) ? null : bratislavaDay(instant);
}

/**
 * The group a HANDED-OVER bag belongs to (§UC-WA-006's mapping table), or null when it
 * belongs to none: `in_person` (resolved conflict 4), no usable stamp, or a `via_host`
 * guest without its host id. `delivery` is `helpers/delivery.js deliveryOf()`'s answer.
 */
export function handOverSegmentKey({ delivery, handedOverAt, hostFriendId } = {}) {
  const date = bratislavaDateOf(handedOverAt);
  if (!date || !delivery) return null;
  if (delivery.type === 'pickup') {
    const m = /^loc([1-9]\d*)$/.exec(String(delivery.target_key));
    return m ? `handed_over:pickup:${m[1]}:${date}` : null;
  }
  if (delivery.type === 'packeta') return `handed_over:packeta:${date}`;
  if (delivery.type === 'via_host') {
    return Number.isInteger(hostFriendId) && hostFriendId > 0 ? `host_guests:${hostFriendId}:${date}` : null;
  }
  return null;
}

// ── DP-T3's legacy keys (WA-T4 re-key) ──────────────────────────────────────────
// DP-T3's hook wrote `loc<id>` / `packeta` / `host:<id>` — outside 21's grammar
// (`loc5` has a digit in the kind), so those rows 400 on the validated rows route and
// show as nameless groups (learnings 15 §WA-T3). Each maps onto a pseudo-delivery and
// goes through `handOverSegmentKey()` itself — the frozen TARGET is kept as it was
// written (a `loc<id>` naming a since-deleted pickup point keeps its group and loses
// only its label — FUP-T23's rule), only the DATE is added.
const LEGACY_PICKUP = /^loc([1-9]\d*)$/;
const LEGACY_HOST = /^host:([1-9]\d*)$/;

/** Is `key` one of DP-T3's three legacy hook-key shapes? */
export function isLegacyHandOverKey(key) {
  return typeof key === 'string' && (key === 'packeta' || LEGACY_PICKUP.test(key) || LEGACY_HOST.test(key));
}

/**
 * The 21-grammar key of a legacy DP-T3 row, or null when `segmentKey` is not legacy.
 *
 * `stamps` is an ordered list of candidate timestamps (the caller decides the order —
 * see schema.js `rekeyLegacyHandOverRows()`); the FIRST that yields a Bratislava day wins.
 * When none does, the row still gets a GRAMMATICAL key and keeps its group:
 * `legacy_handover:<old key, ':' → '-'>` — never dropped, never a 400 on the rows route.
 */
export function legacyHandOverSegmentKey(segmentKey, stamps = []) {
  if (!isLegacyHandOverKey(segmentKey)) return null;
  let delivery;
  let hostFriendId;
  const pickup = LEGACY_PICKUP.exec(segmentKey);
  const host = LEGACY_HOST.exec(segmentKey);
  if (pickup) delivery = { type: 'pickup', target_key: segmentKey };
  else if (host) { delivery = { type: 'via_host' }; hostFriendId = Number(host[1]); }
  else delivery = { type: 'packeta', target_key: 'packeta' };

  for (const stamp of Array.isArray(stamps) ? stamps : []) {
    const key = handOverSegmentKey({ delivery, handedOverAt: stamp, hostFriendId });
    if (key) return key;
  }
  return `legacy_handover:${segmentKey.replace(/:/g, '-')}`;
}
