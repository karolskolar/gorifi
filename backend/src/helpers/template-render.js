import { roundMoney } from './pricing.js';

// 21 §UC-WA-004 (WA-T2) — THE PURE HALF of the WhatsApp templates: the seed table, the
// closed placeholder vocabulary, ONE `renderTemplate()` and its formatters.
//
// ⚠ DEPENDENCY-FREE ON PURPOSE (the `frontend/src/lib/cycle-stages.js` idiom): no DB, no
// Express — its one import, `pricing.js`, is pure too — so `db/schema.js` can import the
// seed table at boot without a circular import, and a Playwright spec can import the
// whole module with plain `node` (this repo has no unit runner; that import IS the unit
// test — `e2e/tests/whatsapp-templates.spec.js` §1). The settings READER/WRITER is the
// other half, `helpers/templates.js`, which imports the DB.
//
// ⚠ ONE HOME for the seed copy and for the `wa_template:` key spelling — a source pin
// greps `backend/src` for both and expects this file alone.
//
// ── THE `{suma}` SEAM (for WA-T3's segments / WA-T4's enqueue) ──────────────────────
// 21 §UC-WA-004 + „PO decisions 2026-09-19" + the orchestrator clarification:
//   friend `{suma}` = the LEDGER balance owed (`-balance` when the balance is < 0),
//   guest  `{suma}` = the sub-order's `total + delivery_fee` while unpaid.
// When NOTHING is owed (friend balance ≥ 0, guest sub-order paid) the caller passes
// `vars.suma = NOTHING_OWED` and `renderTemplate` DROPS the whole sentence holding
// `{suma}` — from the preceding sentence boundary to the next one (see `dropSentences`).
// D4's „už uhradené" substitution is RETIRED. `sumaValue(owed)` is the convenience that
// maps an owed amount to either the formatted string or the marker — and a NUMBER passed
// as `vars.suma` goes through it inside the renderer (`0` ⇒ drop, `31.1` ⇒ `31,10 €`), so
// a raw `31.1` / `0` can never reach a message.
//   ⚠ A SENTENCE BOUNDARY is `.`/`!`/`?` FOLLOWED BY WHITESPACE OR THE END, or a newline.
//   So `12.5 €`, `revolut.me/…`, `podpultovka.biz` never cut a sentence. ⚠ KNOWN LIMIT,
//   pinned as behaviour: an ABBREVIATION followed by a space („(vr. dopravy)", „p. Novák"
//   typed into the TEMPLATE) IS a boundary — the rule cannot tell it from a sentence end,
//   so a `{suma}` sentence holding one is cut at it and the text before it survives. The
//   seeds hold none; the admin sees the preview. (Values are substituted AFTER the drop,
//   so an abbreviation inside a VALUE never matters.)
//   After a drop, 3+ consecutive line breaks collapse to 2 and trailing whitespace goes.
//   ⚠ NOTHING_OWED ≠ „no value". A `{suma}` with no value at all (undefined / '' / a
//   non-finite number) stays LITERAL like every other placeholder (D10), which is what
//   makes WA-T4's release refuse the row — a message is never sent with a silently
//   missing amount. The marker is honoured for `{suma}` ONLY; under any other key it is
//   „no value".
//
// ⚠ VOCABULARY: no seed may say „kolo"/„cyklus" (the „objednávka" register, 21 resolved
// conflict 6); pinned against `e2e/helpers/vocabulary.js BANNED`.

/** The six template keys, in the order every listing uses (21 §UC-WA-004). */
export const TEMPLATE_KEYS = Object.freeze(['pickup', 'packeta', 'host', 'closing', 'waitlist', 'custom']);

/**
 * The seed table, byte for byte from 21 §UC-WA-004 (`enabled` stored as 0|1, the spec's
 * storage shape). D2: pickup/packeta/host on, closing/waitlist off. D3: custom on, empty.
 * D10: the prototype's „Sledovanie: {tracking}" is NOT in the packeta seed.
 */
export const TEMPLATE_SEEDS = Object.freeze({
  pickup: Object.freeze({
    name: 'Doručené na odberné miesto',
    body: 'Ahoj {meno}, vaša káva z Podpultovky je na odbernom mieste {miesto}. Môžete si ju vyzdvihnúť. Suma na úhradu: {suma}. Ďakujeme!',
    enabled: 1,
  }),
  packeta: Object.freeze({
    name: 'Odovzdané Packete',
    body: 'Ahoj {meno}, váš balík z Podpultovky sme odovzdali Packete ({miesto}). Packeta vám pošle správu, keď bude pripravený na výdaj. Suma na úhradu: {suma}.',
    enabled: 1,
  }),
  host: Object.freeze({
    name: 'Odovzdané priateľovi',
    body: 'Ahoj {meno}, vaša objednávka z Podpultovky je pripravená — má ju pri sebe {host}. Prevzatie si dohodnite priamo. Suma na úhradu: {suma}.',
    enabled: 1,
  }),
  closing: Object.freeze({
    name: 'Objednávky sa čoskoro zatvárajú',
    body: 'Ahoj {meno}, objednávka kávy z Podpultovky sa zatvára {datum}. Ak chcete, ešte stihnete objednať: {odkaz}',
    enabled: 0,
  }),
  waitlist: Object.freeze({
    name: 'Objednávka otvorená (čakajúci hostia)',
    body: 'Ahoj {meno}, {host} vám otvoril objednávku kávy z Podpultovky. Objednávajte tu: {odkaz}',
    enabled: 0,
  }),
  custom: Object.freeze({
    name: 'Vlastná správa',
    body: '',
    enabled: 1,
  }),
});

/** Is `key` one of the six? Own-property safe (`__proto__`, `constructor` are not keys). */
export function isTemplateKey(key) {
  return typeof key === 'string' && TEMPLATE_KEYS.includes(key);
}

/** `pickup` ⇒ `wa_template:pickup` — the `settings` row (21 §UC-WA-001). */
export function templateSettingKey(key) {
  return `wa_template:${key}`;
}

/** The stored JSON of a seed row: `{"name":…,"body":…,"enabled":0|1}`, key order fixed. */
export function seedSettingValue(key) {
  const s = TEMPLATE_SEEDS[key];
  return JSON.stringify({ name: s.name, body: s.body, enabled: s.enabled });
}

/** The longest template body (and `notifications.body`) — 21 §UC-WA-001/004. */
export const MAX_BODY_LENGTH = 1000;

/** The closed vocabulary (21 §UC-WA-004). `{objednávka}` is NFC; see `tokenName()`. */
export const PLACEHOLDERS = Object.freeze([
  '{meno}', '{objednávka}', '{miesto}', '{suma}', '{odkaz}', '{host}', '{datum}', '{tracking}',
]);
const NAMES = new Set(PLACEHOLDERS.map((p) => p.slice(1, -1)));

/**
 * „Nothing is owed" — pass as `vars.suma` to drop the `{suma}` sentence. A registered
 * symbol, so it is distinct from every string AND survives the module being loaded under
 * two URLs (a spec's file:// import vs the server's).
 */
export const NOTHING_OWED = Symbol.for('gorifi.wa.nothing_owed');

// A TOKEN is any brace PAIR with no brace inside — `{menoo}`, `{}`, `{ meno }` are all
// tokens (and all unknown); an unpaired `{` or `}` is plain text.
const TOKEN = /\{[^{}]*\}/gu;

// ⚠ NFC, because an admin typing on a Mac can produce `a` + U+0301 for the `á` of
// `{objednávka}`; the token is the same placeholder whichever way it was typed.
const tokenName = (token) => token.slice(1, -1).normalize('NFC');

/** Every `{…}` token of `text` that is NOT in the vocabulary, in order (the PUT's 400). */
export function unknownPlaceholders(text) {
  if (typeof text !== 'string') return [];
  return (text.match(TOKEN) || []).filter((t) => !NAMES.has(tokenName(t)));
}

// A value „has a value" when it is a non-blank string or a finite number. Everything
// else — undefined, null, '', '   ', NaN, an object, a boolean, NOTHING_OWED outside
// `{suma}` — is „no value" and leaves the placeholder literal (D10).
function valueOf(vars, name) {
  if (!vars || typeof vars !== 'object' || !Object.prototype.hasOwnProperty.call(vars, name)) return null;
  const v = vars[name];
  if (typeof v === 'string') return v.trim() ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

const SENTENCE_END = /[.!?]/u;

// `.`/`!`/`?` at `i` ends a sentence only when WHITESPACE or the END follows it — a
// decimal (`12.5`), a URL (`revolut.me/x`), a mid-word dot never does. (An abbreviation
// followed by a space does: the documented limit in the header.)
const endsSentence = (s, i) => SENTENCE_END.test(s[i]) && (i + 1 >= s.length || /\s/u.test(s[i + 1]));

// Drop every sentence holding a `{suma}` token. A sentence runs from just after the
// previous boundary/newline (or the start) to the next boundary INCLUSIVE, or up to (not
// including) the next newline, or the end. Run on the TEMPLATE, before any value is
// substituted, so a `.` inside a value („Nám. SNP") can never move a boundary. Then 3+
// line breaks collapse to 2 and trailing whitespace is trimmed.
function dropSentences(body) {
  let out = body;
  for (;;) {
    const at = out.search(/\{suma\}/u);
    if (at < 0) break;
    let start = 0;
    for (let i = at - 1; i >= 0; i--) {
      if (out[i] === '\n' || endsSentence(out, i)) { start = i + 1; break; }
    }
    let end = out.length;
    for (let i = at + '{suma}'.length; i < out.length; i++) {
      if (endsSentence(out, i)) { end = i + 1; break; }
      if (out[i] === '\n') { end = i; break; }
    }
    const before = out.slice(0, start);
    let after = out.slice(end);
    if (before === '' || before.endsWith('\n')) {
      // The sentence began a line: take the gap after it, and its line break with it.
      after = after.replace(/^[ \t]+/u, '');
      if (after.startsWith('\n')) after = after.slice(1);
    }
    out = before + after;
  }
  return out.replace(/(?:[ \t]*\n){3,}/gu, '\n\n').replace(/\s+$/u, '');
}

// The ONE resolution both exports below share: the template after the `{suma}` drop, and
// the value (or `null` = stays literal) of each placeholder name.
function resolve(body, vars) {
  const v = vars && typeof vars === 'object' ? vars : {};
  let suma = Object.prototype.hasOwnProperty.call(v, 'suma') ? v.suma : undefined;
  if (typeof suma === 'number') suma = sumaValue(suma); // never a raw `31.1` / `0`
  const text = suma === NOTHING_OWED ? dropSentences(body) : body;
  const valueFor = (name) => (name === 'suma'
    ? (typeof suma === 'string' && suma.trim() ? suma : null)
    : valueOf(v, name));
  return { text, valueFor };
}

/**
 * THE ONE RENDERER (21 §UC-WA-004). Replaces each vocabulary placeholder that has a
 * value in `vars` (keyed by the bare name: `meno`, `objednávka`, `miesto`, `suma`,
 * `odkaz`, `host`, `datum`, `tracking`); a placeholder with NO value is left LITERAL
 * (D10) so the admin sees it in the preview and release refuses the row. Unknown tokens
 * are left as they are. `vars.suma === NOTHING_OWED` (or a number ≤ 0) drops the `{suma}`
 * sentence first. Substitution is ONE pass, so a value that looks like a placeholder is
 * never expanded.
 */
export function renderTemplate(body, vars = {}) {
  if (typeof body !== 'string') return '';
  const { text, valueFor } = resolve(body, vars);
  return text.replace(TOKEN, (token) => {
    const name = tokenName(token);
    if (!NAMES.has(name)) return token;
    const value = valueFor(name);
    return value === null ? token : value;
  });
}

/**
 * The vocabulary placeholders `renderTemplate(body, vars)` leaves LITERAL, in order —
 * computed from the TEMPLATE + VARS, never by rescanning the rendered text, so braces that
 * arrive through a VALUE (a guest named „{suma}") can neither block nor pass a row. THIS is
 * the release gate's question (WA-T4/T5: compute it at render time, alongside the body).
 */
export function unresolvedFor(body, vars = {}) {
  if (typeof body !== 'string') return [];
  const { text, valueFor } = resolve(body, vars);
  return (text.match(TOKEN) || []).filter((t) => {
    const name = tokenName(t);
    return NAMES.has(name) && valueFor(name) === null;
  });
}

// ── Formatters (pure) ──────────────────────────────────────────────────────────────

/**
 * `31.1` ⇒ `31,10 €` — comma decimal, two places, an ORDINARY space before `€` (CLAUDE.md
 * text rule). Rounded through `pricing.js roundMoney`, the one 2-decimal home. Anything
 * but a finite number ⇒ `''` (so the placeholder stays literal).
 */
export function formatMoney(amount) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '';
  const rounded = roundMoney(amount);
  return `${(Object.is(rounded, -0) ? 0 : rounded).toFixed(2).replace('.', ',')} €`;
}

/**
 * What `{suma}` gets for an amount OWED: a positive amount (after rounding) ⇒ the
 * formatted string; zero or less ⇒ `NOTHING_OWED` (the sentence is dropped); not a finite
 * number ⇒ `''` (literal — release refuses it). The caller computes `owed`: a friend's
 * `-balance`, a guest's `total + delivery_fee` (or 0 once paid).
 */
export function sumaValue(owed) {
  if (typeof owed !== 'number' || !Number.isFinite(owed)) return '';
  return roundMoney(owed) > 0 ? formatMoney(owed) : NOTHING_OWED;
}

// „v piatok", „vo štvrtok" — the accusative after „v" (indexed by getUTCDay, 0 = Sunday).
// ⚠ Not derived from ICU: `weekday:'long'` gives the nominative, and the preposition
// itself changes before „štvrtok". Spelled out, like `frontend/src/lib/dates.js` does
// for its genitive set (never imported from there — no frontend code in the backend).
const WEEKDAY_WITH_PREPOSITION = Object.freeze([
  'v nedeľu', 'v pondelok', 'v utorok', 'v stredu', 'vo štvrtok', 'v piatok', 'v sobotu',
]);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;

// A Date instant ⇒ its calendar day in Europe/Bratislava (`YYYY-MM-DD`), whatever the
// server's own TZ (21 §Accepted risks: grouping/dates are Bratislava dates in JS).
function bratislavaDay(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(date).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * `{datum}`: `'2025-09-12'` ⇒ `v piatok 12. 9.` (weekday with its preposition + `d. m.`).
 *
 * ⚠ NO TIMEZONE for a `YYYY-MM-DD` string — `order_cycles.closes_at` is a CALENDAR DATE
 * (17 §UC-CS-002), so it is read as one (UTC arithmetic, which never shifts a day). Only
 * a `Date` instant is converted, to its Europe/Bratislava day. An impossible day
 * (`2026-02-31`), any other shape, or a non-string ⇒ `''` (the placeholder stays literal).
 */
export function formatDatum(value) {
  let iso = value;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    iso = bratislavaDay(value);
  }
  if (typeof iso !== 'string') return '';
  const m = ISO_DATE.exec(iso);
  if (!m) return '';
  const utc = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(utc.getTime()) || utc.toISOString().slice(0, 10) !== iso) return '';
  return `${WEEKDAY_WITH_PREPOSITION[utc.getUTCDay()]} ${utc.getUTCDate()}. ${utc.getUTCMonth() + 1}.`;
}

/**
 * `{meno}` / `{host}`: the first whitespace token of a full name, trimmed — „Ivet a Peto"
 * ⇒ „Ivet" (21 §Accepted risks: the admin sees it in the preview). Non-string ⇒ `''`.
 */
export function firstName(full) {
  if (typeof full !== 'string') return '';
  const trimmed = full.trim();
  return trimmed ? trimmed.split(/\s+/u)[0] : '';
}
