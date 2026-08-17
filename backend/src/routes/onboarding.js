import { Router } from 'express';
import crypto from 'crypto';
import { nanoid } from 'nanoid';
import db, { generateUid, generateInviteCode } from '../db/schema.js';
import {
  createFriendSession,
  validateUsername,
  isUsernameTaken,
  hashPassword,
} from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { abuseLimiter } from '../middleware/rate-limit.js';
import { getPlaceholderCycleId } from '../helpers/friend-create.js';

const router = Router();

// Generate a 16-character base64url token for an onboarding link.
function generateLinkToken() {
  return crypto.randomBytes(12).toString('base64url');
}

// ⚠ FUP-T12 — ONE HOME for "what `(req.body.x || '').trim()` used to do", now type-safe.
//
// SEVEN call sites in this file read request text and called a method on it. All seven
// were live 500s — `(123).trim` is `undefined`, `({trim:1}).trim()` is "1 is not a
// function", and (the two found by this row's review) `String({toString:1})` throws
// `Cannot convert object to primitive value` — i.e. a full stack in the log for a
// merely malformed request. FIVE are PUBLIC:
//
//   `POST /onboarding/:token`            name / phone / email / username  ⚠ abuseLimiter
//   `GET  /onboarding/:token/check-username`  `?u=`                       ⚠ NO LIMITER
//   `PATCH /onboarding-links/:id`        note   (requireAdmin)
//   `POST  /onboarding-links`            note   (requireAdmin)
//
// ⚠ AN EARLIER VERSION OF THIS COMMENT CLEARED THE LAST TWO AS "already safe … the
// census is complete", and was wrong on both. `String(x)` and `x.toString()` are NOT
// coercion guards — ToPrimitive calls `toString`, and a non-callable `toString`
// property (`?u[toString]=1`, `{"note":{"toString":1}}`) throws. `guest.js:69-70` and
// `helpers/stock.js:53` already say so; the claim contradicted existing canon. The
// census below is what was PROBED against a running server, shape by shape, not what
// was assumed from reading: all seven sites × the FUP-T12 shape matrix plus
// `{toString:1}`, each measured for status AND bytes appended to the server log.
//
// ⚠ `{toString:1}` is why the matrix alone was not enough — `?u=abc` and `?u[0]=a`
// both answer 200, so only that shape exposes the query-string site.
//
// The two return values are BOTH load-bearing:
//   • falsy (absent / null / '' / 0 / false) ⇒ `''`, preserving the old `|| ''`
//     fallback verbatim, so every "je povinné" refusal below is unchanged.
//   • a non-string ⇒ `null`, which is falsy and therefore refused by each field's
//     OWN existing rule and `field` marker.
// ⚠ A non-string must NEVER become `''`. On the required fields that would still
// refuse, but on the OPTIONAL e-mail it would mean "no e-mail supplied" and the
// registration would be ACCEPTED — turning a refusal into a 201. That is why the
// caller checks `email === null` explicitly.
//
// ⚠ DO NOT "UNIFY" THIS WITH THE OTHER THREE BODY-TEXT HELPERS. There are four in the
// repo and their FALSY semantics differ deliberately, each preserving its own route's
// shipped behaviour — a shared helper could only match one of them:
//   • `guest.js` `asString`        — COERCES numbers/booleans to a string (the money path)
//   • `friends.js` `adminString`   — `null → ''` (clears the column) but `undefined → undefined` (leaves it)
//   • `invitations.js` `registerString` — BOTH `null` and `undefined → undefined`
//   • this `bodyText`              — every falsy value → `''`, mirroring the old `|| ''`
// (`friends.js`'s own comment already records the same "one convention, local copies"
// decision for the bounds constants.)
function bodyText(value) {
  if (!value) return '';
  return typeof value === 'string' ? value.trim() : null;
}

// Count of friends created via a given link's note. Free-text snapshot
// (not an FK) so the count is computed on demand.
function getRegistrationCount(note) {
  const row = db.prepare(
    'SELECT COUNT(*) AS c FROM friends WHERE onboarding_source = ?'
  ).get(note);
  return row ? row.c : 0;
}

// =====================================================================
// ADMIN ROUTES — mounted at /api/onboarding-links
// Gated with requireAdmin (server-side admin token enforcement).
// =====================================================================

// List all onboarding links with registration counts.
router.get('/onboarding-links', requireAdmin, (req, res) => {
  const links = db.prepare(
    'SELECT id, token, note, active, created_at FROM onboarding_links ORDER BY created_at DESC'
  ).all();
  const withCounts = links.map(l => ({
    ...l,
    registration_count: getRegistrationCount(l.note),
  }));
  res.json(withCounts);
});

// Create a new onboarding link. Body: { note }.
router.post('/onboarding-links', requireAdmin, (req, res) => {
  // FUP-T12: a non-string arrives as `null` and is refused by this route's own rule.
  const note = bodyText(req.body?.note);
  if (!note) {
    return res.status(400).json({ error: 'Popis je povinný' });
  }

  // Generate a unique token (collision-retry, just in case).
  let token = generateLinkToken();
  while (db.prepare('SELECT id FROM onboarding_links WHERE token = ?').get(token)) {
    token = generateLinkToken();
  }

  const result = db.prepare(
    'INSERT INTO onboarding_links (token, note, active) VALUES (?, ?, 1)'
  ).run(token, note);

  const link = db.prepare(
    'SELECT id, token, note, active, created_at FROM onboarding_links WHERE id = ?'
  ).get(result.lastInsertRowid);

  res.status(201).json({ ...link, registration_count: 0 });
});

// Update an onboarding link's active flag and/or note. Body: { active?, note? }.
router.patch('/onboarding-links/:id', requireAdmin, (req, res) => {
  const link = db.prepare('SELECT * FROM onboarding_links WHERE id = ?').get(req.params.id);
  if (!link) {
    return res.status(404).json({ error: 'Link nenájdený' });
  }

  const updates = [];
  const params = [];

  if (req.body.active !== undefined) {
    updates.push('active = ?');
    params.push(req.body.active ? 1 : 0);
  }
  if (req.body.note !== undefined) {
    // ⚠ FUP-T12 (review MAJOR) — `String(x)` DOES NOT make this safe, and it failed in
    // BOTH directions. ToPrimitive calls `toString`, so `{"note":{"toString":1}}` fell
    // through to `valueOf` and threw `TypeError: Cannot convert object to primitive
    // value` ⇒ 500 + a 10-frame stack. And every OTHER non-string was silently
    // ACCEPTED and stringified into the row: `{}` and `{trim:1}` both stored the
    // literal `"[object Object]"`, `["a","b"]` stored `"a,b"`, `true` stored `"true"`.
    //
    // ⚠ The write half is the worse one. `note` is the onboarding PROVENANCE label —
    // `getRegistrationCount()` matches it against `friends.onboarding_source`, and the
    // guard three lines below exists to stop exactly that audit trail being broken. A
    // link renamed to `"[object Object]"` orphans every registration it ever sourced.
    //
    // `bodyText` refuses both halves through this route's OWN existing message, and
    // matches the sibling `POST /onboarding-links` guard so the two ends of one
    // resource agree. Behaviour shift, recorded: a non-string note used to 200 and
    // write garbage, and now 400s — a tightening, never a loosening; a string note is
    // trimmed and stored exactly as before.
    const newNote = bodyText(req.body.note);
    if (!newNote) {
      return res.status(400).json({ error: 'Popis nemôže byť prázdny' });
    }
    if (newNote !== link.note && getRegistrationCount(link.note) > 0) {
      return res.status(400).json({
        error: 'Link má registrácie, popis nemôže byť zmenený — audit pôvodu by bol narušený.',
      });
    }
    updates.push('note = ?');
    params.push(newNote);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Žiadne zmeny' });
  }

  params.push(req.params.id);
  db.prepare(`UPDATE onboarding_links SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  const updated = db.prepare(
    'SELECT id, token, note, active, created_at FROM onboarding_links WHERE id = ?'
  ).get(req.params.id);
  res.json({ ...updated, registration_count: getRegistrationCount(updated.note) });
});

// Regenerate the token (kills the old URL immediately).
router.post('/onboarding-links/:id/regenerate', requireAdmin, (req, res) => {
  const link = db.prepare('SELECT * FROM onboarding_links WHERE id = ?').get(req.params.id);
  if (!link) {
    return res.status(404).json({ error: 'Link nenájdený' });
  }

  let token = generateLinkToken();
  while (db.prepare('SELECT id FROM onboarding_links WHERE token = ?').get(token)) {
    token = generateLinkToken();
  }
  db.prepare('UPDATE onboarding_links SET token = ? WHERE id = ?').run(token, req.params.id);

  const updated = db.prepare(
    'SELECT id, token, note, active, created_at FROM onboarding_links WHERE id = ?'
  ).get(req.params.id);
  res.json({ ...updated, registration_count: getRegistrationCount(updated.note) });
});

// Delete a link. Blocked if it has any registrations — admin should
// deactivate instead so the audit trail (onboarding_source on friends) stays
// understandable.
router.delete('/onboarding-links/:id', requireAdmin, (req, res) => {
  const link = db.prepare('SELECT * FROM onboarding_links WHERE id = ?').get(req.params.id);
  if (!link) {
    return res.status(404).json({ error: 'Link nenájdený' });
  }

  const count = getRegistrationCount(link.note);
  if (count > 0) {
    return res.status(400).json({
      error: `Link už má ${count} registrácií, nemôže byť vymazaný — deaktivuj ho namiesto toho.`,
    });
  }

  db.prepare('DELETE FROM onboarding_links WHERE id = ?').run(req.params.id);
  res.status(204).send();
});

// =====================================================================
// PUBLIC ROUTES — mounted at /api/onboarding
// =====================================================================

// Get info about an onboarding link (used by the public page on mount).
router.get('/onboarding/:token', (req, res) => {
  const link = db.prepare(
    'SELECT note, active FROM onboarding_links WHERE token = ?'
  ).get(req.params.token);

  if (!link) {
    return res.status(404).json({ error: 'Odkaz neexistuje' });
  }
  res.json({ active: !!link.active, note: link.note });
});

// Username availability check, gated by an active onboarding token so it
// can't be used as a general user enumeration endpoint.
router.get('/onboarding/:token/check-username', (req, res) => {
  const link = db.prepare('SELECT active FROM onboarding_links WHERE token = ?').get(req.params.token);
  if (!link) {
    return res.status(404).json({ error: 'Odkaz neexistuje' });
  }
  if (!link.active) {
    return res.status(403).json({ error: 'Tento odkaz už nie je aktívny' });
  }

  // ⚠ FUP-T12 (review BLOCKER) — `(req.query.u || '').toString()` is NOT a coercion
  // guard. Express's extended query parser turns `?u[toString]=1` into the OBJECT
  // `{toString: '1'}`, whose `toString` is a STRING, not a function — so the call
  // threw `TypeError: … .toString is not a function` ⇒ 500 plus a 10-frame stack.
  //
  // ⚠ THIS IS THE CHEAPEST LOG-FLOOD IN THE APP, cheaper than the instance this row
  // was opened for: the route is PUBLIC and — unlike `POST /onboarding/:token`
  // (`abuseLimiter`) and `POST /friends/auth` (`authLimiter`) — it carries NO rate
  // limiter at all (bare mount, index.js). 1156 bytes per unauthenticated GET.
  //
  // A non-string becomes `''`, which `validateUsername` already refuses with its own
  // `Uzivatelske meno je povinne` — so the shipped `200 {available:false, reason}`
  // contract is preserved and no new string is introduced. ⚠ `available` can never
  // come back `true` from a malformed query, because `''` always fails validation.
  const rawUsername = req.query.u;
  const username = typeof rawUsername === 'string' ? rawUsername.toLowerCase() : '';
  const formatError = validateUsername(username);
  if (formatError) {
    return res.json({ available: false, reason: formatError });
  }

  return res.json({ available: !isUsernameTaken(username) });
});

// Submit the onboarding form. Creates a friend, subscribes them to bakery,
// mints a session token, and returns it for auto-login. Rate-limited against
// automated mass account creation.
router.post('/onboarding/:token', abuseLimiter, (req, res) => {
  const link = db.prepare(
    'SELECT id, note, active FROM onboarding_links WHERE token = ?'
  ).get(req.params.token);
  if (!link) {
    return res.status(404).json({ error: 'Neplatný odkaz' });
  }
  if (!link.active) {
    return res.status(403).json({ error: 'Tento odkaz už nie je aktívny' });
  }

  // FUP-T12: `bodyText` keeps the old `|| ''` fallback and hands back `null` for a
  // non-string, so each field's own rule below does the refusing — one message and
  // one `field` marker per input, exactly as the form renders them today. (A single
  // shared "malformed" reply was rejected for the FUP-T11 reason: it would collapse
  // four distinct 400s into one and the form would no longer know which input to
  // redden.)
  const name = bodyText(req.body.name);
  const phone = bodyText(req.body.phone);
  const email = bodyText(req.body.email);
  const usernameText = bodyText(req.body.username);
  const usernameRaw = usernameText === null ? null : usernameText.toLowerCase();
  const password = req.body.password || '';

  if (!name) return res.status(400).json({ error: 'Meno je povinné', field: 'name' });
  if (!phone) return res.status(400).json({ error: 'Mobil je povinný', field: 'phone' });
  // ⚠ `email === null` is the non-string case and it must land HERE. E-mail is
  // OPTIONAL, so flattening a non-string to `''` would read as "no e-mail" and let
  // the registration through — the one place in this handler where the malformed
  // value would have been ACCEPTED rather than refused.
  if (email === null || (email && !email.includes('@'))) {
    return res.status(400).json({ error: 'Neplatný email', field: 'email' });
  }

  const usernameError = validateUsername(usernameRaw);
  if (usernameError) {
    return res.status(400).json({ error: usernameError, field: 'username' });
  }
  // ⚠ Type-guard BEFORE `hashPassword` — the THIRD instance of one defect class, not
  // a third coincidence (ML-T6 fixed the same shape twice on `friends.js`:
  // `currentPassword`, then `newPassword` one line below it). `!password ||
  // password.length < 8` read `.length` off whatever the body carried, so any object
  // with a `length` ≥ 8 — `{"password":{"length":12}}` — was truthy, cleared the
  // comparison and reached `hashPassword`, which is `bcrypt.hashSync` and THROWS
  // `Illegal arguments: object, string` on a non-string ⇒ 500 plus a full stack in the
  // server log, for a merely malformed body.
  //
  // ⚠ AND THIS SITE IS THE PUBLIC, UNAUTHENTICATED ONE. ML-T6's two both sat behind a
  // friend session; this handler is reachable by anyone holding the shared onboarding
  // link, so the stack-log half was REMOTELY TRIGGERABLE — a free remote log-flood,
  // which is exactly what the FUP-T3/FUP-T7 rule ("no stack on a client-triggerable
  // branch") exists to prevent. The wrong status was the bug; the stack was the abuse
  // surface, and it is the reason this was worth fixing rather than tidying.
  //
  // Nothing is loosened: the status, the message and the `field` marker are unchanged,
  // a short string still 400s, an absent password still arrives as `''` through the
  // `|| ''` fallback above and still 400s — only non-strings move 500 → 400.
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Heslo musí mať aspoň 8 znakov', field: 'password' });
  }
  if (isUsernameTaken(usernameRaw)) {
    return res.status(409).json({ error: 'Užívateľské meno je už obsadené', field: 'username' });
  }

  // ⚠ ORDERING RULE (the IA-T3 invariant): bcrypt and the two collision-retry loops
  // run BEFORE the transaction. `hashPassword` is bcrypt cost 10 — ~62 ms of blocking
  // CPU — and better-sqlite3 transactions are synchronous, so hashing inside one would
  // hold the write lock for that whole time (measured against a 0.13–0.21 ms
  // transaction, i.e. ~400× longer than needed). Load-bearing, not stylistic: no test
  // in this repo can catch the regression. Everything below the transaction boundary
  // is pure SQL.
  const passwordHash = hashPassword(password);

  // Generate unique uid + invite_code (collision-retry, mirrors friends.js).
  let uid = generateUid();
  while (db.prepare('SELECT id FROM friends WHERE uid = ?').get(uid)) {
    uid = generateUid();
  }
  let inviteCode = generateInviteCode();
  while (db.prepare('SELECT id FROM friends WHERE invite_code = ?').get(inviteCode)) {
    inviteCode = generateInviteCode();
  }
  const accessToken = nanoid(12);
  const cycleId = getPlaceholderCycleId();

  // DELIBERATE NON-WRITE:
  //   • NO `invalidateLoginTokens` — an EXPLICIT EXEMPTION from 09 §UC-ML-009 rule 2,
  //     recorded here so nobody "fixes" the omission (same ground as 07's approve).
  //     That rule makes every write to `friends.password_hash` delete the friend's
  //     outstanding magic links; the INSERT below writes `password_hash` too, but it
  //     CREATES the friend row, so `lastInsertRowid` is a brand-new id that no
  //     `login_tokens` row can reference yet (they are keyed on `friend_id`, and
  //     `friends.id` is AUTOINCREMENT so ids are never reused). The delete would be a
  //     guaranteed no-op, and adding it would put a third write inside this
  //     transaction.
  const insertFriendWithBakerySubscription = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO friends
        (cycle_id, name, uid, access_token, invite_code, active,
         phone, email, onboarding_source, username, password_hash)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      cycleId, name, uid, accessToken, inviteCode,
      phone, email || null, link.note, usernameRaw, passwordHash
    );
    const newId = result.lastInsertRowid;
    db.prepare(
      "INSERT INTO friend_subscriptions (friend_id, type) VALUES (?, 'bakery')"
    ).run(newId);
    return newId;
  });
  const friendId = insertFriendWithBakerySubscription();

  // Mint session for auto-login.
  //
  // ⚠ FIFTH mint site — NOT in 09 §UC-ML-002's checklist, which names only
  // /friends/auth (both branches), setup-credentials and change-password. It
  // takes the 24 h default, deliberately, and the decision is recorded here
  // because "it just fell through" is indistinguishable from "nobody looked":
  // the registration form offers no "keep me signed in" control, so there is no
  // opt-in to honour, and 09's whole premise is that 60 days is something the
  // friend ASKS for. Assuming it on their behalf — on a form that may well be
  // filled in on a shared machine at the office — is the one outcome the split
  // exists to prevent. Consequence, accepted: a friend who registers and does
  // not return within 24 h logs in again, exactly like any other
  // non-remembering login.
  //
  // Seam: if registration ever grows the checkbox, it passes
  // `{ remember: req.body.remember === true }` here — the primitive already
  // supports it and nothing else needs to change.
  const session = createFriendSession(friendId);

  res.status(201).json({
    token: session.token,
    expiresAt: session.expiresAt,
    friendId,
    friendName: name,
  });
});

export default router;

