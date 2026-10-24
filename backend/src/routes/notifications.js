import { Router } from 'express';
import db from '../db/schema.js';
import { getTemplate, listTemplates, writeTemplate } from '../helpers/templates.js';
import { MAX_BODY_LENGTH, PLACEHOLDERS, isTemplateKey, unknownPlaceholders } from '../helpers/template-render.js';
import { resolveLoginUrl } from '../helpers/credentials-message.js';
import {
  buildSegment, computedSegments, isSegmentKey, parseSegmentKey, segmentForJson, segmentName,
} from '../helpers/segments.js';
import {
  composeSegment, deleteRow, editRowBody, groupCounts, markManualSent, releaseGroup, rerenderGroup, retryGroup,
} from '../helpers/outbox.js';
import { botConnected } from '../helpers/wa-health.js';
import { isDbBusy, sendDbBusy } from '../helpers/db-busy.js';

// Module 21 — the admin's WhatsApp notifications API. WHOLLY ADMIN: a single-audience
// router, so the MOUNT is wrapped in `requireAdmin` (index.js), like
// `/api/guest-waitlist`; every route on it is in `ADMIN_ENDPOINTS`
// (e2e/tests/api-security.spec.js). Later rows (WA-T3 segments, WA-T5 outbox
// compose/release/retry/rerender + the three per-row routes — below) add their routes
// HERE, and each joins that list too.
//
// WA-T2 (21 §UC-WA-004): the templates.
//   GET /api/notifications/templates       ⇒ 200 { templates: [six], placeholders: [eight] }
//   PUT /api/notifications/templates/:key  ⇒ 200 { key, name, body, enabled }
//
// ⚠ PUT contract (decided in WA-T2, learnings 15):
//   • `:key` outside the six ⇒ 404 `unknown_template` — checked FIRST, so an unknown key
//     with any body is a 404 (and never creates a settings row).
//   • the JSON body must be a plain object (express.json already 400s a top-level
//     `true` / `'abc'` / `null` / `42`; an ARRAY — incl. the one-element `[id]` trap —
//     is refused here) ⇒ 400 `invalid_payload`.
//   • neither `body` nor `enabled` present (`{}`, a bodyless PUT, only unknown keys such
//     as `name`, which is NOT editable) ⇒ 400 `nothing_to_change`.
//   • `body`: a string (any other type ⇒ 400 `invalid_body`), ≤ 1000 chars (⇒ 400
//     `body_too_long`), every `{…}` token in the vocabulary (⇒ 400 `unknown_placeholder`
//     with the FIRST offending `token`). Empty is legal (`custom` ships empty, D3).
//     Stored verbatim — no trim, no normalisation.
//   • `enabled`: STRICT boolean — `true`/`false`/`1`/`0` (⇒ else 400 `invalid_enabled`).
//   • All validation happens before the write; a refusal writes nothing.
// Every 400 is `{ error: <Slovak>, reason, field? , token? }` — `reason` is the machine
// code the template editor (WA-T7) keys on.
//
// ⚠ Synchronous handlers (GA-T8): the read-merge-write in `writeTemplate` has no await.

const router = Router();

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function strictBool(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  return null;
}

router.get('/templates', (req, res) => {
  res.json({ templates: listTemplates(), placeholders: PLACEHOLDERS });
});

router.put('/templates/:key', (req, res) => {
  const { key } = req.params;
  if (!isTemplateKey(key)) {
    return res.status(404).json({ error: 'Šablóna neexistuje', reason: 'unknown_template' });
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'Neplatný formát údajov', reason: 'invalid_payload' });
  }
  const hasBody = has(payload, 'body');
  const hasEnabled = has(payload, 'enabled');
  if (!hasBody && !hasEnabled) {
    return res.status(400).json({ error: 'Nie je čo zmeniť', reason: 'nothing_to_change' });
  }

  const patch = {};
  if (hasBody) {
    const body = payload.body;
    if (typeof body !== 'string') {
      return res.status(400).json({ error: 'Text šablóny musí byť text', field: 'body', reason: 'invalid_body' });
    }
    if (body.length > MAX_BODY_LENGTH) {
      return res.status(400).json({
        error: `Text šablóny môže mať najviac ${MAX_BODY_LENGTH} znakov`, field: 'body', reason: 'body_too_long',
      });
    }
    const unknown = unknownPlaceholders(body);
    if (unknown.length) {
      return res.status(400).json({
        error: `Neznámy zástupný symbol ${unknown[0]}`, field: 'body', reason: 'unknown_placeholder', token: unknown[0],
      });
    }
    patch.body = body;
  }
  if (hasEnabled) {
    const enabled = strictBool(payload.enabled);
    if (enabled === null) {
      return res.status(400).json({ error: 'Neplatná hodnota (zapnutá šablóna)', field: 'enabled', reason: 'invalid_enabled' });
    }
    patch.enabled = enabled;
  }

  res.json(writeTemplate(key, patch));
});

// ═════════════════════════════════════════════════════════════════════════════
// WA-T3 (21 §UC-WA-008, the two READ routes; §UC-WA-005 segments).
//
//   GET /api/notifications/segments?cycle_id=N[&segment_key=K]
//     ⇒ 200 { cycle: {id,name,status}, groups: [...], computed: [...], segment? }
//       groups   = the EXISTING outbox rows of the cycle (plus the cycle-less
//                  `all_active` rows), grouped by (segment_key, template_key), with
//                  `counts` per status, `total`, `template_name` and the segment `name`
//                  (null for a key outside 21's grammar — ~~DP-T3's `loc<id>`/`host:<id>`
//                  until WA-T4 moves the hook onto it~~ → WA-T4: the hook writes 21's
//                  grammar and the boot re-keys DP-T3's rows; only the
//                  `legacy_handover:…` fallback stays nameless — learnings 15 §WA-T4);
//       computed = `not_ordered:N`, `waitlist:N`, `all_active` (helpers/segments.js
//                  `computedSegments()`): count / excluded_opt_out / no_phone /
//                  template_enabled / requires_open_cycle;
//       segment  = ONLY with `segment_key`: the built segment's JSON preview
//                  (`segmentForJson()` — `vars.suma: null` = nothing owed, NO `odkaz`,
//                  `odkaz_resolved` instead, no opted-out names). 404 `unknown_segment`
//                  for a grammatical key that is none of the six; 400
//                  `segment_cycle_mismatch` for `not_ordered:/waitlist:<other cycle>`.
//   GET /api/notifications?cycle_id=N&segment_key=K
//     ⇒ 200 { rows: [...] } — the rows of ONE group (`all_active` ⇒ `cycle_id IS NULL`),
//       `name`/`phone` resolved from the recipient's own table. Any grammatical key is
//       readable (an empty group is `[]`). ⚠ `order_token` is never a FIELD here; a guest
//       row's `body` may contain its status URL — the body IS the message (§UC-WA-008).
//
// Validation (both): `cycle_id` = a positive integer string (missing, `abc`, `0`, `1.5`,
// a repeated key, a bracket object ⇒ 400 `invalid_cycle_id`), unknown ⇒ 404
// `unknown_cycle`; `segment_key` = the §UC-WA-008 grammar ≤ 80 (anything else, incl. an
// empty or repeated key ⇒ 400 `invalid_segment_key`). Read-only; synchronous.
// ═════════════════════════════════════════════════════════════════════════════

const STATUSES = ['queued', 'released', 'sent', 'failed', 'skipped'];

function readCycleId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// ⇒ { cycle } or sends the 400/404 and returns null.
function cycleFromQuery(req, res) {
  const cycleId = readCycleId(req.query.cycle_id);
  if (cycleId === null) {
    res.status(400).json({ error: 'Neplatné ID objednávky', field: 'cycle_id', reason: 'invalid_cycle_id' });
    return null;
  }
  const cycle = db.get('SELECT id, name, status FROM order_cycles WHERE id = ?', [cycleId]);
  if (!cycle) {
    res.status(404).json({ error: 'Objednávka neexistuje', reason: 'unknown_cycle' });
    return null;
  }
  return cycle;
}

function badSegmentKey(res) {
  return res.status(400).json({ error: 'Neplatná skupina správ', field: 'segment_key', reason: 'invalid_segment_key' });
}

function outboxGroups(cycleId) {
  const rows = db.all(`
    SELECT segment_key, template_key, status, COUNT(*) AS n, MIN(id) AS first_id
    FROM notifications
    WHERE segment_key IS NOT NULL
      AND (cycle_id = ? OR (cycle_id IS NULL AND segment_key = 'all_active'))
    GROUP BY segment_key, template_key, status
  `, [cycleId]);
  const groups = new Map();
  for (const row of rows) {
    const id = `${row.segment_key}\u0000${row.template_key}`;
    if (!groups.has(id)) {
      groups.set(id, {
        segment_key: row.segment_key,
        name: segmentName(row.segment_key),
        template_key: row.template_key,
        template_name: getTemplate(row.template_key)?.name ?? null,
        counts: Object.fromEntries(STATUSES.map((s) => [s, 0])),
        total: 0,
        first_id: row.first_id,
      });
    }
    const group = groups.get(id);
    if (Object.prototype.hasOwnProperty.call(group.counts, row.status)) group.counts[row.status] += row.n;
    group.total += row.n;
    group.first_id = Math.min(group.first_id, row.first_id);
  }
  return [...groups.values()]
    .sort((a, b) => a.first_id - b.first_id)
    .map(({ first_id, ...group }) => group);
}

router.get('/segments', (req, res) => {
  const cycle = cycleFromQuery(req, res);
  if (!cycle) return undefined;

  const rawKey = req.query.segment_key;
  if (rawKey !== undefined && !isSegmentKey(rawKey)) return badSegmentKey(res);

  const options = { baseUrl: resolveLoginUrl(req) };
  const body = { cycle, groups: outboxGroups(cycle.id), computed: computedSegments(cycle.id, options) };

  if (rawKey !== undefined) {
    const parsed = parseSegmentKey(rawKey);
    if (!parsed) {
      return res.status(404).json({ error: 'Taká skupina správ neexistuje', reason: 'unknown_segment' });
    }
    if (parsed.cycleId !== undefined && parsed.cycleId !== cycle.id) {
      return res.status(400).json({
        error: 'Skupina patrí k inej objednávke', field: 'segment_key', reason: 'segment_cycle_mismatch',
      });
    }
    const segment = buildSegment(cycle.id, rawKey, options);
    if (!segment) {
      return res.status(404).json({ error: 'Taká skupina správ neexistuje', reason: 'unknown_segment' });
    }
    body.segment = segmentForJson(segment);
  }
  return res.json(body);
});

// ⚠ Three LEFT JOINs, each on a primary key AND gated on `recipient_kind`, so a row
// matches at most one recipient table and is never multiplied. Shared by the group list
// and every WA-T5 single-row answer (one published row shape).
// WA-T5: `unresolved` joins the published fields — parsed to an ARRAY (`null` = never
// computed, i.e. a pre-WA-T5 row release refuses) — so the composer can outline exactly
// the rows release would refuse („Doplňte {datum}").
const ROW_SELECT = `
    SELECT n.id, n.template_key, n.recipient_kind, n.recipient_id,
           CASE n.recipient_kind
             WHEN 'friend' THEN f.name WHEN 'guest' THEN g.guest_name WHEN 'waitlist' THEN w.name
           END AS name,
           CASE n.recipient_kind
             WHEN 'friend' THEN f.phone WHEN 'guest' THEN g.guest_phone WHEN 'waitlist' THEN w.phone
           END AS phone,
           n.phone_e164, n.channel, n.status, n.sent_via, n.body, n.unresolved, n.error,
           n.created_at, n.released_at, n.sent_at
    FROM notifications n
    LEFT JOIN friends f ON n.recipient_kind = 'friend' AND f.id = n.recipient_id
    LEFT JOIN guest_orders g ON n.recipient_kind = 'guest' AND g.id = n.recipient_id
    LEFT JOIN guest_waitlist w ON n.recipient_kind = 'waitlist' AND w.id = n.recipient_id
`;

function publishRow(row) {
  let unresolved = null;
  if (typeof row.unresolved === 'string') {
    try {
      const parsed = JSON.parse(row.unresolved);
      unresolved = Array.isArray(parsed) ? parsed : null;
    } catch (e) {
      unresolved = null;
    }
  }
  return { ...row, unresolved };
}

function readRow(id) {
  const row = db.get(`${ROW_SELECT} WHERE n.id = ?`, [id]);
  return row ? publishRow(row) : null;
}

router.get('/', (req, res) => {
  const cycle = cycleFromQuery(req, res);
  if (!cycle) return undefined;
  const key = req.query.segment_key;
  if (!isSegmentKey(key)) return badSegmentKey(res);

  const rows = db.all(`
    ${ROW_SELECT}
    WHERE n.segment_key = ?
      AND ${key === 'all_active' ? 'n.cycle_id IS NULL' : 'n.cycle_id = ?'}
    ORDER BY n.id
  `, key === 'all_active' ? [key] : [key, cycle.id]);
  return res.json({ rows: rows.map(publishRow) });
});

// ═════════════════════════════════════════════════════════════════════════════
// WA-T5 (21 §UC-WA-008, §UC-WA-007 compose + release) — the WRITE routes. Every write
// statement lives in `helpers/outbox.js` (the one `notifications` writer in the API); these
// handlers validate, call one helper, and READ THE ROWS BACK (no optimistic echo).
//
//   POST   /compose              { cycle_id, segment_key } ⇒ 200 { …counts, counts }
//   POST   /release              { cycle_id, segment_key } ⇒ 200 { released, whatsapp, email, skipped, counts }
//                                                            409 unresolved_placeholders { ids }
//   POST   /retry                { cycle_id, segment_key } ⇒ 200 { released, whatsapp, email, skipped, counts }
//                                                            409 unresolved_placeholders { ids } (WA-T8 review)
//   POST   /rerender             { cycle_id, segment_key } ⇒ 200 { rerendered, unchanged, counts }
//                                 (`queued` rows — and since WA-T8 `failed` ones, status kept: the
//                                 repair door before a retry, learnings 15 §WA-T8)
//   PATCH  /:id/body             { body }                  ⇒ 200 row · 409 not_queued (queued AND, since the
//                                                            WA-T8 review, failed rows — status kept)
//   PATCH  /:id/manual-sent      { sent: true }            ⇒ 200 row · 409 bot_active / not_pending / not_waiting
//   DELETE /:id                                            ⇒ 200 { deleted: true, id } · 409 not_queued
//
// Group body validation (all four POSTs): a plain JSON object (an array — incl. the
// one-element `[1]` trap — ⇒ 400 `invalid_payload`; express.json already 400s a
// top-level `true`/`'abc'`); `segment_key` the §UC-WA-008 grammar ≤ 80 (⇒ 400
// `invalid_segment_key`); `cycle_id` a positive integer NUMBER (⇒ 400
// `invalid_cycle_id`), NULL/absent allowed ONLY for `all_active` (whose rows are
// cycle-less whatever is sent); an unknown cycle ⇒ 404 `unknown_cycle`; a
// `not_ordered:<N>` / `waitlist:<N>` key naming another cycle ⇒ 400
// `segment_cycle_mismatch`.
// ═════════════════════════════════════════════════════════════════════════════

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const positiveInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

function badPayload(res) {
  return res.status(400).json({ error: 'Neplatný formát údajov', reason: 'invalid_payload' });
}

// ⇒ { cycleId (null for all_active), segmentKey } or sends the 400/404 and returns null.
function groupFromBody(req, res) {
  const payload = req.body;
  if (!isPlainObject(payload)) { badPayload(res); return null; }
  const segmentKey = payload.segment_key;
  if (!isSegmentKey(segmentKey)) { badSegmentKey(res); return null; }
  const rawCycle = payload.cycle_id;
  const allActive = segmentKey === 'all_active';
  let cycleId = null;
  if (!(allActive && (rawCycle === undefined || rawCycle === null))) {
    cycleId = positiveInt(rawCycle);
    if (cycleId === null) {
      res.status(400).json({ error: 'Neplatné ID objednávky', field: 'cycle_id', reason: 'invalid_cycle_id' });
      return null;
    }
    if (!db.get('SELECT id FROM order_cycles WHERE id = ?', [cycleId])) {
      res.status(404).json({ error: 'Objednávka neexistuje', reason: 'unknown_cycle' });
      return null;
    }
  }
  const parsed = parseSegmentKey(segmentKey);
  if (parsed?.cycleId !== undefined && parsed.cycleId !== cycleId) {
    res.status(400).json({ error: 'Skupina patrí k inej objednávke', field: 'segment_key', reason: 'segment_cycle_mismatch' });
    return null;
  }
  return { cycleId: allActive ? null : cycleId, segmentKey };
}

const REFUSALS = {
  unknown_segment: [404, 'Taká skupina správ neexistuje'],
  not_composable: [400, 'Táto skupina vzniká odovzdaním balíčkov, nepripravuje sa ručne'],
  template_disabled: [409, 'Šablóna je vypnutá — zapnite ju v Nastaveniach'],
  template_empty: [409, 'Šablóna je prázdna — najprv napíšte text správy'],
  cycle_not_open: [409, 'Objednávka nie je otvorená'],
  unresolved_placeholders: [409, 'Niektoré správy majú nevyplnené údaje — doplňte ich a skúste znova'],
  not_found: [404, 'Správa neexistuje'],
  not_queued: [409, 'Správa už nie je vo fronte'],
  not_pending: [409, 'Správa už nečaká na odoslanie'],
  bot_active: [409, 'Bot je pripojený — správu pošle bot'],
  not_waiting: [409, 'Hosť už nečaká na túto správu — riadok je preskočený'],
};

function refuse(res, reason, extra = {}) {
  const [status, error] = REFUSALS[reason] || [409, 'Akciu nie je možné vykonať'];
  return res.status(status).json({ error, reason, ...extra });
}

router.post('/compose', (req, res) => {
  const group = groupFromBody(req, res);
  if (!group) return undefined;
  const result = composeSegment({ ...group, baseUrl: resolveLoginUrl(req) });
  if (result.refused) return refuse(res, result.refused);
  return res.json({ ...result, counts: groupCounts(result.segment_key, result.cycle_id) });
});

router.post('/release', (req, res) => {
  const group = groupFromBody(req, res);
  if (!group) return undefined;
  const result = releaseGroup({ ...group, baseUrl: resolveLoginUrl(req) });
  if (result.refused) return refuse(res, result.refused, { ids: result.ids });
  return res.json({ ...result, counts: groupCounts(group.segmentKey, group.cycleId) });
});

router.post('/retry', (req, res) => {
  const group = groupFromBody(req, res);
  if (!group) return undefined;
  const result = retryGroup(group);
  // WA-T8 review: the release's all-or-nothing gate (a rerendered failed row may carry a
  // literal) — 409 `unresolved_placeholders` { ids }, nothing written.
  if (result.refused) return refuse(res, result.refused, { ids: result.ids });
  return res.json({ ...result, counts: groupCounts(group.segmentKey, group.cycleId) });
});

router.post('/rerender', (req, res) => {
  const group = groupFromBody(req, res);
  if (!group) return undefined;
  const result = rerenderGroup({ ...group, baseUrl: resolveLoginUrl(req) });
  if (result.refused) return refuse(res, result.refused);
  return res.json({ ...result, counts: groupCounts(group.segmentKey, group.cycleId) });
});

// ⇒ the row id, or sends the 400 and returns null.
function rowIdFrom(req, res) {
  const raw = req.params.id;
  const id = typeof raw === 'string' && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
  if (id === null || !Number.isSafeInteger(id)) {
    res.status(400).json({ error: 'Neplatné ID správy', field: 'id', reason: 'invalid_id' });
    return null;
  }
  return id;
}

router.patch('/:id/body', (req, res) => {
  const id = rowIdFrom(req, res);
  if (id === null) return undefined;
  const payload = req.body;
  if (!isPlainObject(payload)) return badPayload(res);
  const { body } = payload;
  if (typeof body !== 'string') {
    return res.status(400).json({ error: 'Text správy musí byť text', field: 'body', reason: 'invalid_body' });
  }
  if (body.length > MAX_BODY_LENGTH) {
    return res.status(400).json({
      error: `Text správy môže mať najviac ${MAX_BODY_LENGTH} znakov`, field: 'body', reason: 'body_too_long',
    });
  }
  if (!body.trim()) {
    return res.status(400).json({ error: 'Text správy nemôže byť prázdny', field: 'body', reason: 'empty_body' });
  }
  const result = editRowBody(id, body);
  if (result.refused) return refuse(res, result.refused);
  return res.json(readRow(id));
});

// ⚠ The ONE async handler on this router. The health fetch is an `await` between the
// status read and the write, so the write is `markManualSent()`'s CONDITIONAL UPDATE
// (`WHERE status = 'released'`) — a row the bot moved to `sent` during the await is
// refused `not_pending`, never overwritten (GA-T8: re-check after the await).
router.patch('/:id/manual-sent', async (req, res) => {
  try {
    const id = rowIdFrom(req, res);
    if (id === null) return undefined;
    const payload = req.body;
    if (!isPlainObject(payload)) return badPayload(res);
    if (payload.sent !== true) {
      return res.status(400).json({ error: 'Neplatná hodnota (odoslané)', field: 'sent', reason: 'invalid_sent' });
    }
    const row = db.get('SELECT status, channel FROM notifications WHERE id = ?', [id]);
    if (!row) return refuse(res, 'not_found');
    if (row.status === 'queued') {
      const result = markManualSent(id, ['queued']);
      if (result.refused) return refuse(res, result.refused);
      return res.json(readRow(id));
    }
    if (row.status !== 'released') return refuse(res, 'not_pending');

    // 21 §UC-WA-008: on a RELEASED row the tick is allowed only while the bot is NOT
    // connected (2 s timeout; unreachable counts as not connected) — a duplicate-send guard.
    // ⚠ WA-T6 review: a WhatsApp guard only. The WA process never drains an `email` row
    // (21 §UC-WA-011 step 1), so for one the guard protected nothing and turned a stuck
    // e-mail send into a row no door could move — an e-mail row skips the health fetch.
    // The conditional write below still loses to the mailer's own `.then` (and vice versa).
    if (row.channel !== 'email' && await botConnected()) return refuse(res, 'bot_active');
    const result = markManualSent(id, ['released']);
    if (result.refused) return refuse(res, result.refused);
    return res.json(readRow(id));
  } catch (e) {
    // WA-T9: this handler catches its own throws, so the `db_busy` 503 is applied here too.
    if (isDbBusy(e)) return sendDbBusy(req, res, e);
    console.error(`[notifications] manual-sent failed: ${String(e?.message || e).slice(0, 200)}`);
    return res.status(500).json({ error: 'Chyba servera' });
  }
});

router.delete('/:id', (req, res) => {
  const id = rowIdFrom(req, res);
  if (id === null) return undefined;
  const result = deleteRow(id);
  if (result.refused) return refuse(res, result.refused);
  return res.json({ deleted: true, id, row: readRow(id) });
});

export default router;
