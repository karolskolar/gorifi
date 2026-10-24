import { Router } from 'express';
import { listTemplates, writeTemplate } from '../helpers/templates.js';
import { MAX_BODY_LENGTH, PLACEHOLDERS, isTemplateKey, unknownPlaceholders } from '../helpers/template-render.js';

// Module 21 — the admin's WhatsApp notifications API. WHOLLY ADMIN: a single-audience
// router, so the MOUNT is wrapped in `requireAdmin` (index.js), like
// `/api/guest-waitlist`; every route on it is in `ADMIN_ENDPOINTS`
// (e2e/tests/api-security.spec.js). Later rows (WA-T3 segments, WA-T5 outbox
// compose/release/retry) add their routes HERE, and each joins that list too.
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

export default router;
