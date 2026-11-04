import db from '../db/schema.js';
import {
  MAX_BODY_LENGTH,
  TEMPLATE_KEYS,
  TEMPLATE_SEEDS,
  isTemplateKey,
  templateSettingKey,
  unknownPlaceholders,
} from './template-render.js';

// 21 §UC-WA-004 (WA-T2) — THE SETTINGS HALF of the WhatsApp templates: ONE reader
// (`getTemplate` / `listTemplates`) and ONE writer (`writeTemplate`) of the six
// `wa_template:<key>` rows. The seed table, the vocabulary and the renderer live in the
// pure `helpers/template-render.js` (no DB import there, so `db/schema.js` seeds from it
// at boot and a spec imports it with plain node).
//
// Storage: `settings.value` = JSON `{"name": string, "body": string, "enabled": 0|1}`.
// Published shape: `{ key, name, body, enabled: boolean }`.
//
// ⚠ FAILS CLOSED AND FAILS QUIET (the `routes/admin.js readAdminGoogleSubs` idiom): a
// hand-edited / truncated / wrongly-typed row must not 500 the settings page or the
// composer, and must not put an unvetted body in front of a recipient. A row is VALID
// only if it is exactly what `PUT /api/notifications/templates/:key` could have written
// — an object with a string `name`, a string `body` of ≤ 1000 chars whose every `{…}`
// token is in the vocabulary, and `enabled` ∈ {0, 1, true, false}. Anything else reads
// as the SEED default and logs ONE bounded line per read. A MISSING row reads as the
// seed silently (the next boot re-seeds it — `db/schema.js`).
//
// ⚠ SYNCHRONOUS (GA-T8): the PUT's read-merge-write has no `await` between the read and
// the write, so `instances: 1` keeps it atomic.

const CORRUPT_EXCERPT = 200;
const excerpt = (value) => JSON.stringify(String(value).slice(0, CORRUPT_EXCERPT));

function seedTemplate(key) {
  const s = TEMPLATE_SEEDS[key];
  return { key, name: s.name, body: s.body, enabled: s.enabled === 1 };
}

// `null` when the parsed value is not what the PUT could have written.
function validStored(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const { name, body, enabled } = parsed;
  if (typeof name !== 'string' || !name) return null;
  if (typeof body !== 'string' || body.length > MAX_BODY_LENGTH) return null;
  if (unknownPlaceholders(body).length) return null;
  if (enabled !== 0 && enabled !== 1 && enabled !== true && enabled !== false) return null;
  return { name, body, enabled: enabled === 1 || enabled === true };
}

// The read of one KNOWN key (callers have already checked `isTemplateKey`).
function readKnown(key) {
  const settingKey = templateSettingKey(key);
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(settingKey);
  if (!row) return seedTemplate(key);
  let parsed;
  try {
    parsed = JSON.parse(row.value);
  } catch (e) {
    parsed = undefined;
  }
  const valid = validStored(parsed);
  if (!valid) {
    // ⚠ BOUNDED EXCERPT, never the whole blob (the FUP-T3/FUP-T7 log rule) — this runs on
    // every read of a bad row, i.e. on every settings-page / composer load.
    console.error(`[templates] ${settingKey} is not a valid template — reading the SEED default instead. value[0..${CORRUPT_EXCERPT}] of ${String(row.value).length} chars: ${excerpt(row.value)}`);
    return seedTemplate(key);
  }
  return { key, ...valid };
}

/** One template by key, or `null` for a key outside the six. Never throws. */
export function getTemplate(key) {
  return isTemplateKey(key) ? readKnown(key) : null;
}

/** All six, in `TEMPLATE_KEYS` order. Never throws. */
export function listTemplates() {
  return TEMPLATE_KEYS.map(readKnown);
}

/**
 * THE ONE WRITER of a `wa_template:<key>` row (the boot seed in `db/schema.js` only
 * INSERTs a missing row). `patch` = `{ body?: string, enabled?: boolean }`, already
 * validated by the route. The merge base is the CURRENT READ — so a corrupt row is
 * rebuilt from the seed default (its excerpt was logged by that read) — and the whole
 * row is rewritten as valid JSON. `name` is never patched. Returns the template.
 */
export function writeTemplate(key, patch) {
  if (!isTemplateKey(key)) return null;
  const current = readKnown(key);
  const next = {
    name: current.name,
    body: patch.body !== undefined ? patch.body : current.body,
    enabled: (patch.enabled !== undefined ? patch.enabled : current.enabled) ? 1 : 0,
  };
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(templateSettingKey(key), JSON.stringify(next));
  return { key, name: next.name, body: next.body, enabled: next.enabled === 1 };
}
