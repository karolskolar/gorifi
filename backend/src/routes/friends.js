import { Router } from 'express';
import { nanoid } from 'nanoid';
import db, { generateUid, generateInviteCode } from '../db/schema.js';
import { validateFriendAuth, requireFriendOwner, createFriendSession, presentedSessionExpiry, presentedSessionVia, invalidateFriendSessions, invalidateLoginTokens, getAuthMode, validateUsername, isUsernameTaken, hashPassword, comparePassword } from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { authLimiter } from '../middleware/rate-limit.js';
import { getPlaceholderCycleId } from '../helpers/friend-create.js';
import { bindValue } from '../helpers/bind-value.js';
// 10 §UC-GA-002. Imported here (rather than only where tokens are verified) so the
// module's ONE boot line prints at server start — it is the only audit signal that the
// `GOOGLE_AUTH_TEST_MODE` seam is off in production.
import { getGoogleClientId, requireGoogleAuthConfigured, verifyGoogleIdToken } from '../helpers/google-auth.js';

const router = Router();

// Remove credential material from a friend row before returning it to any
// client. access_token is a live auth credential; password_hash enables
// offline cracking; invite_code is a shareable secret. None are consumed by
// the frontend from these endpoints. Mutates and returns the object.
// This function stays the ONE home for friend response stripping (11 §UC-FC-005).
function sanitizeFriend(friend) {
  if (!friend) return friend;
  // Google state, derived BEFORE the strip (11 §UC-FC-005). On a pre-module-10 DB
  // the `google_sub` column does not exist, so `friend.google_sub` is undefined ⇒
  // `googleLinked: false` — same code path, no feature flag, no error (the graceful
  // rule UC-FC-002 renders from). `google_email` (display-only) passes through
  // untouched when it exists.
  friend.googleLinked = !!friend.google_sub;
  delete friend.password_hash;
  delete friend.access_token;
  delete friend.invite_code;
  // ⚠ Module 10 seam: the raw Google subject is an identity key, never display
  // data — it never leaves the server. This was a no-op delete when FC-T1 shipped,
  // but GA-T1 has since added `friends.google_sub`, so it now strips a REAL value
  // off every row this function touches (FUP-T17). Module 10's own login/link
  // endpoints INHERIT this strip rule (11 §UC-FC-005 ships it first); it is
  // load-bearing, not dead code.
  delete friend.google_sub;
  return friend;
}

// ── UC-FC-004: type guards + length bounds for the ADMIN write routes ─────────
// (POST / and PATCH /:id — plus, since UC-FC-009, the CONTACT half [phone/email]
// of the friend-owned PATCH /:id/profile, which otherwise keeps module 03's own
// copy/behaviour for name/packeta_address.)
//
// ⚠ LOCAL constants, deliberately NOT imported: guest.js's `validateIdentity` is
// module-private and pinned to the GSO-T3 money path, and invitations.js's
// `registerString` documents the same convention for its own public form. One
// convention (120/32/160), three local copies, zero shared code paths across the
// money / public / admin surfaces. FC-T2's modal `maxlength` attributes mirror
// these numbers (the GSO-T3 mirror convention).
const MAX_NAME_LENGTH = 120;
const MAX_PHONE_LENGTH = 32;
const MAX_EMAIL_LENGTH = 160;
// The admin note (`display_name`) had no precedent bound; 200 matches the modal's
// practical size (11 §UC-FC-004).
const MAX_NOTE_LENGTH = 200;

// Trimmed string; `undefined` when the field is absent; `''` when the field is an
// explicit `null` — the shipped admin UI clears a field by sending `null`
// (AdminFriends.vue's `trim() || null`), and `''` flows through the routes'
// existing `value || null` normalisation and writes NULL, preserving the old
// null-clears-it behaviour verbatim (§UC-FC-004 — the type-guard list deliberately
// excludes `null`). Returns `null` when present but not a string — the caller 400s
// with a `field` marker instead of throwing inside the handler (the recorded
// `POST {email: 123}` → 500: a number has no `.trim()`). Strict on purpose (the
// UC-IA-003 precedent): no number/boolean coercion — the only writer is our own
// admin form, which always sends strings or null.
function adminString(value) {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value === 'string') return value.trim();
  return null;
}

// The admin-writable fields with their Slovak type-guard label and length bound.
const ADMIN_FRIEND_FIELDS = [
  ['name', 'meno a priezvisko', MAX_NAME_LENGTH, `Meno a priezvisko je príliš dlhé (najviac ${MAX_NAME_LENGTH} znakov)`],
  ['display_name', 'poznámka', MAX_NOTE_LENGTH, `Poznámka je príliš dlhá (najviac ${MAX_NOTE_LENGTH} znakov)`],
  ['phone', 'telefón', MAX_PHONE_LENGTH, `Telefónne číslo je príliš dlhé (najviac ${MAX_PHONE_LENGTH} znakov)`],
  ['email', 'e-mail', MAX_EMAIL_LENGTH, `E-mail je príliš dlhý (najviac ${MAX_EMAIL_LENGTH} znakov)`],
];

// Validates + normalises the admin-writable fields of a POST/PATCH body.
// Returns `{ error, field }` on the first violation, else `{ values }` where each
// key is `undefined` when absent from the body, otherwise the trimmed string
// (possibly '' — the per-route required/empty rules stay with the caller).
// Email keeps the deliberate `includes('@')` leniency (accepted decision — real
// deliverability surfaces via module 08's send outcomes, not input validation);
// phone gets NO format validation, length only.
//
// `only` (UC-FC-009): an optional field-name subset. The friend-owned
// PATCH /:id/profile validates ONLY phone/email through here so the Slovak
// messages and `field` markers cannot drift from the admin routes' — name and
// packeta_address on that route keep module 03's own rules (pinned message).
function validateAdminFriendFields(body, only = null) {
  const values = {};
  for (const [field, label, max, tooLong] of ADMIN_FRIEND_FIELDS) {
    if (only && !only.includes(field)) continue;
    const value = adminString(body[field]);
    if (value === null) {
      return { error: `Neplatný formát údajov (${label})`, field };
    }
    if (value !== undefined && value.length > max) {
      return { error: tooLong, field };
    }
    values[field] = value;
  }
  if (values.email && !values.email.includes('@')) {
    return { error: 'Neplatný email', field: 'email' };
  }
  return { values };
}

// GET /friends/auth-mode - Public endpoint to get current auth mode
//
// ⚠ PUBLIC AND UNAUTHENTICATED. Everything added here is published to the world, so
// this handler stays a two-field literal — never a row, never a spread.
//
// `googleClientId` (10 §UC-GA-002, resolved decision #4): the Google OAuth client id is
// SERVED config, not a Vite build-time var — `deploy.sh` builds the frontend locally, so
// a `VITE_*` var would live on the operator's machine and fork the staging/prod
// artifacts. It is public by construction (the browser sends it to Google in the GIS
// flow) and NO CLIENT SECRET EXISTS in this flow, so there is nothing here to leak.
// ⚠ `null` — not absent, not `''` — is the "feature is off" value every frontend Google
// control keys on, so the key must always be present.
router.get('/auth-mode', (req, res) => {
  res.json({ authMode: getAuthMode(), googleClientId: getGoogleClientId() });
});

// POST /friends/auth - Authentication for friends (shared password or personal credentials)
router.post('/auth', authLimiter, (req, res) => {
  const { password, friendId, username } = req.body;
  const authMode = getAuthMode();

  // Personal login: username + password
  if (username) {
    // ⚠ FUP-T12 — the reported site, and the only `.toLowerCase()` on a body field in
    // this file that is NOT already covered by `validateUsername`'s type guard (the
    // other four sit behind it, which is why they are latent). A non-string reached
    // `username.toLowerCase()` and threw a TypeError ⇒ 500 plus a full stack in the
    // log, on a PUBLIC unauthenticated route: 677 bytes per request, i.e. exactly the
    // free remote log-flood the FUP-T3/FUP-T7 rule exists to prevent.
    //
    // ⚠ 401 WITH THIS ROUTE'S EXISTING MESSAGE, not a 400 and not a new sentence.
    // FUP-T11 REMOVED a username-existence oracle from this very endpoint; a distinct
    // status or wording for "your username was not a string" would put a new one back.
    // The reply is byte-identical to the unknown-username 401 three lines below.
    //
    // ⚠ AND IT MUST SIT INSIDE THE BRANCH. `if (username)` is the branch SELECTOR —
    // rewriting it as `typeof username === 'string'` would send a non-string down the
    // SHARED-PASSWORD path instead, so `{username: 123, password: <shared password>}`
    // would authenticate. Falsy values must keep falling through; non-strings must not.
    if (typeof username !== 'string') {
      return res.status(401).json({ error: 'Nesprávne prihlasovacie údaje' });
    }
    const friend = db.prepare('SELECT * FROM friends WHERE username = ? AND active = 1').get(username.toLowerCase());
    if (!friend || !friend.password_hash) {
      return res.status(401).json({ error: 'Nesprávne prihlasovacie údaje' });
    }

    if (!comparePassword(password, friend.password_hash)) {
      return res.status(401).json({ error: 'Nesprávne prihlasovacie údaje' });
    }

    // Remember-me (09 §UC-ML-002): 60 days on an explicit opt-in, 24 h otherwise.
    // ⚠ `=== true`, never a truthy check — the string "false" must not buy 60 days.
    const session = createFriendSession(friend.id, { remember: req.body.remember === true });
    return res.json({
      success: true,
      friend: { id: friend.id, name: friend.name, uid: friend.uid, username: friend.username, packeta_address: friend.packeta_address },
      token: session.token,
      expiresAt: session.expiresAt,
      hasCredentials: true,
      // Forced-change: set when an admin reset this friend's password.
      mustChangePassword: !!friend.must_change_password,
      // ⚠ 10 §UC-GA-003 — ADDITIVE, and they ride on THIS response on purpose.
      // UC-GA-006's post-login link prompt keys on the LOGIN HANDSHAKE, not on an
      // extra request: the prompt has to decide whether to appear before the portal
      // paints, and a second round trip would either delay that or race it. The
      // Google login response below carries the same two fields, so both login
      // paths hand the frontend the same state.
      //
      // ⚠ `google_sub` itself is NEVER published (§UC-GA-003, inheriting 11
      // §UC-FC-005's rule). These are DERIVED booleans, which is why they can be —
      // `googleLinked` says a link exists, never which account it is.
      googleLinked: !!friend.google_sub,
      googlePromptDismissed: !!friend.google_prompt_dismissed
    });
  }

  // Shared password login: password + friendId
  if (authMode === 'modern') {
    return res.status(401).json({ error: 'Spoločné heslo nie je povolené. Prihláste sa menom a heslom.' });
  }

  const setting = db.prepare("SELECT value FROM settings WHERE key = 'friends_password'").get();
  if (!setting || !setting.value) {
    return res.status(400).json({ error: 'Heslo pre priateľov nie je nastavené' });
  }

  if (password !== setting.value) {
    return res.status(401).json({ error: 'Nesprávne heslo' });
  }

  // ⚠ FUP-T15 — PUBLIC (the shared password is the only credential), and `friendId`
  // went straight into this bind: `{"friendId":{}}` was a 500 plus ~770 bytes of
  // stack per request.
  //
  // ⚠ THE TRUTHINESS TEST STAYS ON THE RAW VALUE, deliberately. `bindValue` maps an
  // unbindable value to `undefined`, and gating on THAT would make a present-but-
  // malformed friendId fall out of this branch entirely and answer the bare
  // `{ success: true }` below — a 200 for a login that resolved nobody. Present but
  // unbindable must still ENTER here and be refused as an unknown friend, which is
  // exactly what an unresolvable id has always got.
  if (friendId) {
    const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(bindValue(friendId));
    if (!friend) {
      return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
    }

    // Same remember-me contract as the personal branch above — the legacy
    // shared-password login mints a per-friend session too, so it must honour
    // the opt-in identically (09 §UC-ML-002 mint-site inventory item 1).
    const session = createFriendSession(friend.id, { remember: req.body.remember === true });
    return res.json({
      success: true,
      friend: { id: friend.id, name: friend.name, uid: friend.uid, username: friend.username, packeta_address: friend.packeta_address },
      token: session.token,
      expiresAt: session.expiresAt,
      hasCredentials: !!friend.password_hash,
      // Forced-change: set when an admin reset this friend's password. In the
      // shared-password window the frontend routes this to "set your own login".
      mustChangePassword: !!friend.must_change_password
    });
  }

  res.json({ success: true });
});

// POST /friends/auth/google - Google sign-in for a friend who has LINKED their
// Google account (10 §UC-GA-003). Public, `authLimiter`.
//
// ⚠ `authLimiter`, NOT a new bucket (§UC-GA-013): this endpoint accepts an ID token
// for verification, i.e. it performs the credential-check step, so forged-token
// probing is credential guessing and belongs in the strict 20/window bucket beside
// `/friends/auth` and `/admin/login`. The four-bucket set and its NAT'd-office
// reasoning are untouched.
//
// ⚠⚠ THE ORDER OF THE FOUR CHECKS BELOW IS NORMATIVE (§UC-GA-003), because each one
// that runs early leaks a fact the one before it was supposed to withhold:
//   1. config    — an unconfigured deployment says "the feature is off" and stops.
//   2. auth mode — a legacy deployment refuses BEFORE verification, so an attacker
//                  cannot use it as a free "is this token valid?" oracle on a
//                  deployment where Google login is switched off.
//   3. verify    — 401 for an invalid token, 503 for a Google outage (never a 401:
//                  an outage must not read as "wrong credentials").
//   4. lookup    — and only then does the row exist to talk about.
// Moving 3 above 2, or folding the two-step lookup in 4 into one query, each turns a
// deliberate silence into an answer.
//
// ⚠⚠ THE TRY/CATCH IS THE MODULE-10 PATTERN — GA-T5/T8/T10 INHERIT IT VERBATIM.
// This is the first `async` handler in this file, and the asymmetry with the
// synchronous `/auth` beside it is not cosmetic: **Express 4 does not forward a
// rejected handler promise to the error middleware**, and the process runs under
// Node 20's default `--unhandled-rejections=throw`. So on this route — unlike every
// synchronous one around it — a throw ANYWHERE AFTER THE `await` (the SELECT, the
// `google_email` UPDATE, `createFriendSession`'s INSERT under `SQLITE_BUSY`) would
// leave the client with NO RESPONSE AT ALL **and kill the process**. On a public,
// unauthenticated endpoint.
//
// No attacker-reachable throw exists today — `verifyGoogleIdToken` returns on every
// path and `v.identity.sub` is a guaranteed non-empty string on both the seam and the
// real path — so this is infrastructure-fault-only. It is here because "no reachable
// throw" is a property of code four other rows are about to extend, not a property of
// the route. Follows `invitations.js:287`'s precedent. Module 10 adds five async
// handlers, one of them on the public `POST /invitations/register`: every one of them
// gets this wrapper.
router.post('/auth/google', authLimiter, async (req, res) => {
  try {
    // 1. The uniform feature-off guard (§UC-GA-002) — one decision, one place.
    const notConfigured = requireGoogleAuthConfigured();
    if (notConfigured) {
      return res.status(notConfigured.status).json({ error: notConfigured.error });
    }

    // 2. Modern mode only (resolved decision #2, consistent with module 09's magic
    //    link). The legacy shared password and a per-person Google identity are
    //    contradictory models; a friend on a shared-password deployment has no personal
    //    account for Google to be an alternative credential FOR.
    if (getAuthMode() !== 'modern') {
      return res.status(409).json({
        error: 'Prihlásenie cez Google je dostupné až po prechode na osobné prihlasovanie',
        field: 'auth_mode'
      });
    }

    // 3. ⚠ network I/O — MUST stay outside any db.transaction (helpers/google-auth.js).
    //    The IA-T3 structural rule: better-sqlite3 transactions are synchronous, and a
    //    JWKS fetch inside one would hold the write lock across a network round trip.
    //    Verify FIRST, then touch the database with the resolved `sub` in hand.
    //    ⚠ The result is ALWAYS TRUTHY — branch on `.error`, never on falsiness.
    const v = await verifyGoogleIdToken(req.body?.id_token);
    if (v.error) {
      return res.status(v.status).json({ error: v.error, ...(v.field && { field: v.field }) });
    }

    // 4. ⚠ TWO STEPS, AND NO `active` FILTER — deliberately (§UC-GA-003). A single
    //    `WHERE google_sub = ? AND active = 1` would collapse the two cases below into
    //    one message: a deactivated friend (or anyone holding their Google account)
    //    would be told "not linked", which is both false and an inactive-account oracle
    //    in the other direction. The linked/unlinked hint is a recorded, accepted
    //    disclosure for accounts that exist and are usable; the state of a DEACTIVATED
    //    account is not.
    const friend = db.prepare('SELECT * FROM friends WHERE google_sub = ?').get(v.identity.sub);
    if (!friend) {
      return res.status(401).json({
        error: 'Tento Google účet nie je prepojený so žiadnym účtom. Prihláste sa menom a heslom a prepojte ho v profile.',
        code: 'not_linked'
      });
    }
    if (!friend.active) {
      // The same generic message password login gives, byte for byte, and with no
      // `code`: an inactive friend must neither log in nor learn their linked state.
      return res.status(401).json({ error: 'Nesprávne prihlasovacie údaje' });
    }

    // `google_email` is a DISPLAY-ONLY column (§UC-GA-001) — never a matching key — so
    // refreshing it here is free of identity consequences. `sub` is what identity is,
    // and a login never rewrites it. ⚠ AFTER the active check, so a refused login
    // writes nothing at all.
    if (v.identity.email && v.identity.email !== friend.google_email) {
      db.prepare('UPDATE friends SET google_email = ? WHERE id = ?').run(v.identity.email, friend.id);
    }

    // Same remember-me contract as both password branches above (module 09
    // §UC-ML-002): `=== true`, never a truthy check — the string "false" must not buy 60
    // days. (`?.` where the password branches use a bare `req.body`: unreachable with an
    // absent body, since `verifyGoogleIdToken(undefined)` 400s above, but this is a
    // PUBLIC unauthenticated route and the FUP-T13/T15 family is exactly about the
    // dereference nobody thought was reachable.)
    const session = createFriendSession(friend.id, { remember: req.body?.remember === true });

    // ⚠ HAND-PICKED, NEVER A `SELECT *` SPREAD. `friend` above is a full row and holds
    // `password_hash`, `access_token`, `invite_code` and `google_sub`; every one of them
    // is a credential or an identity key. This literal is byte-compatible with the
    // personal branch of `POST /friends/auth` plus the two additive Google fields — the
    // frontend takes the EXACT post-login path of a password login, so any divergence
    // here is a divergence in that path.
    return res.json({
      success: true,
      friend: { id: friend.id, name: friend.name, uid: friend.uid, username: friend.username, packeta_address: friend.packeta_address },
      token: session.token,
      expiresAt: session.expiresAt,
      // ⚠ NOT the hardcoded `true` the password branch can afford: a friend created by
      // a Google-attached registration may have no password at all.
      //
      // ⚠ AND THE OBVIOUS CONSUMER DOES NOT EXIST YET — do not assume it does.
      // `FriendPortalSession.vue:1416` uses `hasCredentials` to gate the CHANGE-password
      // fold, which is HIDDEN when false, and `needsCredentialSetup` only fires in
      // transition mode. So a friend with no `password_hash` currently has **no
      // on-screen path to set one at all** (`PUT /:id/change-password` 400s for them).
      // The value here is right and stays; GA-T7 is specced to key its profile-modal
      // "set a password" affordance on it and will find that affordance missing —
      // building it is GA-T7's work, not an assumption this line can make.
      hasCredentials: !!friend.password_hash,
      // Resolved decision #1 — a Google login honours the forced-change gate exactly
      // like a password login. The flag means an ADMIN-KNOWN password exists on the
      // row; a login path that bypassed the gate would leave it valid indefinitely.
      mustChangePassword: !!friend.must_change_password,
      googleLinked: true,
      googlePromptDismissed: !!friend.google_prompt_dismissed
    });
  } catch (e) {
    // The token is never logged (it is a live credential); `e.message` only, the
    // FUP-T3/FUP-T7 bounded-log rule for public routes.
    console.error(`[friends] google login failed: ${String(e?.message || e).slice(0, 300)}`);
    return res.status(500).json({ error: 'Prihlásenie zlyhalo' });
  }
});

// GET /friends/login-list - Public minimal list for the legacy/transition login
// dropdown: id + name + hasCredentials only (no contact data, balances or
// usernames — the full list at GET / stays admin-only, SEC-P1). In modern mode
// the dropdown doesn't exist, so don't expose names at all.
router.get('/login-list', (req, res) => {
  if (getAuthMode() === 'modern') {
    return res.json([]);
  }
  const rows = db.prepare('SELECT id, name, password_hash FROM friends WHERE active = 1 ORDER BY name').all();
  res.json(rows.map(f => ({ id: f.id, name: f.name, hasCredentials: !!f.password_hash })));
});

// GET /friends/:id/profile - Own full profile (owner token required). Used to
// hydrate the portal after login/session-restore now that the login page no
// longer receives the admin-only friends list.
router.get('/:id/profile', (req, res) => {
  const owner = requireFriendOwner(req, req.params.id);
  if (owner.error) {
    return res.status(owner.status).json({ error: owner.error });
  }

  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(req.params.id);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }
  friend.hasCredentials = !!friend.password_hash;
  res.json(sanitizeFriend(friend));
});

// POST /friends/:id/setup-credentials - Set username + password for first time
router.post('/:id/setup-credentials', (req, res) => {
  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  const friendId = req.params.id;

  // If authenticated via token, verify the token owner matches the requested friend
  if (validation.friendId && String(validation.friendId) !== String(friendId)) {
    return res.status(403).json({ error: 'Nemáte oprávnenie upravovať iného používateľa' });
  }

  const { username, password } = req.body;

  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // First-time only — if credentials already set, use change-password instead
  if (friend.password_hash && friend.username) {
    return res.status(409).json({ error: 'Prihlasovacie údaje sú už nastavené. Použite zmenu hesla.' });
  }

  // Validate username
  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }

  if (isUsernameTaken(username.toLowerCase(), friendId)) {
    return res.status(409).json({ error: 'Užívateľské meno je už obsadené' });
  }

  // ⚠ Type-guard BEFORE `hashPassword` (FUP-T11), the HASH half of the split — see
  // the note on `hashPassword` in `middleware/friend-auth.js` for why this rule lives
  // at the route rather than in the helper. `!password || password.length < 8` read
  // `.length` off whatever the body carried, so `{"password":{"length":12}}` cleared
  // it — and so did a number and `true`, whose `.length` is `undefined` and
  // `undefined < 8` is `false`. All of them reached `bcrypt.hashSync`, which throws
  // `Illegal arguments` ⇒ 500 plus a stack log for a merely malformed body. This
  // route is reachable with the shared friends password, so that stack was cheap to
  // trigger. Nothing is loosened: the status and the message are unchanged, a short
  // string and an absent one still 400s — only non-strings move 500 → 400.
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Heslo musí mať aspoň 8 znakov' });
  }

  // ⚠ bcrypt runs ABOVE the transaction (the IA-T3 invariant: better-sqlite3
  // transactions are synchronous, so a ~62 ms hash inside one holds the write lock for
  // its whole duration). Everything below the boundary is pure SQL.
  const passwordHash = hashPassword(password);

  // §UC-ML-009 rule 2 — a `password_hash` write and the magic-link delete are ONE
  // transaction, so no state exists in which the new password is live while a link
  // mailed before it is still redeemable. Conservative hygiene only: §UC-ML-005's own
  // `active`/`password_hash` checks remain the load-bearing gate (see
  // `invalidateLoginTokens`).
  db.transaction(() => {
    db.prepare('UPDATE friends SET username = ?, password_hash = ?, must_change_password = 0 WHERE id = ?')
      .run(username.toLowerCase(), passwordHash, friendId);
    invalidateLoginTokens(friendId);
  })();

  // Create new session with credentials.
  // ⚠ Read the presenting session's expiry BEFORE invalidating — that call
  // deletes the very row we are reading. Carrying it over is what stops a friend
  // who opted into 60 days being silently dropped to 24 h just because they set
  // their own login mid-session (09 §UC-ML-002 item 2). Null (shared-password
  // caller, no session row) falls through to the 24 h default.
  const carryExpiry = presentedSessionExpiry(req);
  invalidateFriendSessions(friendId);
  // ⚠ `via` is deliberately NOT carried over — see change-password below.
  const session = createFriendSession(friendId, { expiresAt: carryExpiry });

  const updated = db.prepare('SELECT id, name, uid, username FROM friends WHERE id = ?').get(friendId);
  res.json({ success: true, friend: updated, token: session.token, expiresAt: session.expiresAt });
});

// PUT /friends/:id/change-password - Change own password (requires token auth)
router.put('/:id/change-password', (req, res) => {
  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // Must be authenticated via token and match the friend ID
  if (!validation.friendId || String(validation.friendId) !== String(req.params.id)) {
    return res.status(403).json({ error: 'Nemáte oprávnenie meniť heslo iného používateľa' });
  }

  const friendId = req.params.id;
  const { currentPassword, newPassword } = req.body;

  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend || !friend.password_hash) {
    return res.status(400).json({ error: 'Nemáte nastavené osobné heslo' });
  }

  // ⚠ THE WAIVER, read from the SESSION ROW and from nowhere else (09 §UC-ML-008,
  // resolved conflict #5). `presentedSessionVia` resolves `friend_sessions.via` for the
  // token this request presented; a `via`/`viaMagicLink` in the BODY is ignored, and
  // must stay ignored — honouring one would let any friend session skip password proof.
  // The ownership check above (`validation.friendId` vs `req.params.id`) is unchanged,
  // so the waiver relaxes exactly one check and confines it to the caller's own account.
  //
  // Justification is the one the `must_change_password` branch already states below:
  // the valid session token proves the friend just authenticated — here it proves
  // control of the account's e-mail, which is the recovery trust anchor.
  //
  // ⚠ It is short-lived BY CONSTRUCTION, in two ways, and neither is incidental:
  //   1. the re-mint at the bottom of this handler deliberately writes NULL `via`, so
  //      ONE successful change puts the account back on password proof;
  //   2. `presentedSessionVia` filters on `expires_at > now`, and a magic-link session
  //      is a fixed 24 h (§UC-ML-005) with no remember-me opt-in.
  // The residual 24 h window is a RECORDED ACCEPTED RISK (§UC-ML-008 / §Accepted
  // risks) — inherent to the trust model, since holding the mailbox already grants
  // exactly this power via a fresh link. Do not "harden" it with a re-authentication
  // prompt; that would make the recovery flow a dead end again.
  const viaMagicLink = presentedSessionVia(req) === 'magic_link';

  // Normal change requires the current password. But when an admin reset the
  // password (must_change_password), the valid session token already proves the
  // friend just authenticated with the admin-issued password, so skip the
  // re-entry and let them pick their own password directly (forced-change #3).
  if (!friend.must_change_password && !viaMagicLink) {
    // ⚠ Type-guard BEFORE `comparePassword`: bcryptjs THROWS on a non-string, so an
    // absent `currentPassword` used to leave this route on the 500 path — an
    // unhandled-exception shape for what is simply a failed proof. Refusing it as the
    // 401 it always was cannot loosen anything (a non-string could never have matched
    // a hash), and it is what makes the body-flag bypass test assert ONE clean status.
    if (typeof currentPassword !== 'string' ||
        !comparePassword(currentPassword, friend.password_hash)) {
      return res.status(401).json({ error: 'Aktuálne heslo nie je správne' });
    }
  }

  // ⚠ Type-guard, the SYMMETRIC CASE to `currentPassword` above (ML-T6 review).
  // `!newPassword || newPassword.length < 8` let any object with a `length` ≥ 8 —
  // `{"newPassword":{"length":12}}` — through to `hashPassword`, which throws
  // `Illegal arguments: object, string` ⇒ 500 `Nieco sa pokazilo` plus a server-log
  // entry, for what is simply a malformed body. The §UC-ML-008 waiver above made that
  // path reachable WITHOUT password proof (own account only, so log noise and a wrong
  // status rather than an authz hole), which is what promoted it from latent to worth
  // fixing. Nothing is loosened: the message and status are unchanged, a short string
  // still 400s and a valid string still succeeds — only non-strings move 500 → 400.
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return res.status(400).json({ error: 'Nové heslo musí mať aspoň 8 znakov' });
  }

  // ⚠ bcrypt ABOVE the transaction (the IA-T3 invariant — see setup-credentials).
  const newHash = hashPassword(newPassword);

  // §UC-ML-009 rule 2, and this is the call site the rule was written for: the friend
  // who just recovered by e-mail sets their own password here, and the link that got
  // them in — plus any other outstanding one — dies with the same write. Conservative
  // hygiene only (see `invalidateLoginTokens`).
  db.transaction(() => {
    db.prepare('UPDATE friends SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, friendId);
    invalidateLoginTokens(friendId);
  })();

  // Invalidate all sessions and create a new one.
  // ⚠ Capture the presenting session's expiry BEFORE invalidating (that call
  // deletes the row). A remembered friend who changes their password keeps the
  // 60-day horizon they opted into — never extended, never silently shortened
  // to 24 h (09 §UC-ML-002 item 2).
  const carryExpiry = presentedSessionExpiry(req);
  invalidateFriendSessions(friendId);
  // ⚠ `via` is deliberately NOT carried over, and this is load-bearing: the
  // re-minted session proves a FRESH password, so its NULL `via` is exactly what
  // retires the §UC-ML-008 `currentPassword` waiver. Carrying 'magic_link'
  // across a password change would keep the waiver alive indefinitely.
  const session = createFriendSession(friendId, { expiresAt: carryExpiry });

  res.json({ success: true, token: session.token, expiresAt: session.expiresAt });
});

// GET /friends/check-username/:username - Public check if username is available
router.get('/check-username/:username', (req, res) => {
  const username = req.params.username.toLowerCase();
  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.json({ available: false, error: usernameError });
  }
  const taken = isUsernameTaken(username);
  res.json({ available: !taken });
});

// GET /friends/cycles - List cycles for authenticated friend
router.get('/cycles', (req, res) => {
  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // ⚠ FUP-T15 — `?friendId[a]=1` on a query string reaches two binds below (the
  // per-friend order lookup and the subscription filter) and was a 500 + ~1 KB of
  // stack. Here "unbindable ⇒ absent" is the right branch and needs no extra gate:
  // both consumers are already `if (friendId)`, and an absent `?friendId` is the
  // shipped "list the cycles, carry no per-friend order" answer.
  const friendId = bindValue(req.query.friendId);

  // Get all cycles (open, locked, completed) with stored total_friends
  const cycles = db.prepare(`
    SELECT c.id, c.name, c.status, c.created_at, c.total_friends, c.expected_date, c.type, c.plan_note
    FROM order_cycles c
    WHERE c.name != '_placeholder'
    ORDER BY c.created_at DESC
  `).all();

  // Add friend's order status to each cycle
  const cyclesWithOrders = cycles.map(cycle => {
    let hasOrder = false;
    let orderTotal = 0;
    let orderStatus = null;
    let orderKilos = 0;
    let orderItemCount = 0;
    let orderPickupName = null;
    let orderPacketa = false;

    if (friendId) {
      const order = db.prepare(`
        SELECT o.id, o.status, o.total, o.delivery_fee, o.packeta_address,
               o.pickup_location_id, o.pickup_location_note, pl.name as pickup_location_name
        FROM orders o
        LEFT JOIN pickup_locations pl ON pl.id = o.pickup_location_id
        WHERE o.cycle_id = ? AND o.friend_id = ? AND o.status = 'submitted'
      `).get(cycle.id, friendId);

      if (order) {
        hasOrder = true;
        orderTotal = (order.total || 0) + (order.delivery_fee || 0);
        orderStatus = order.status;

        // Calculate kilos for this friend's order only
        const friendKilosResult = db.prepare(`
          SELECT COALESCE(SUM(
            CASE
              WHEN oi.variant = '150g' THEN oi.quantity * 0.15
              WHEN oi.variant = '200g' THEN oi.quantity * 0.2
              WHEN oi.variant = '250g' THEN oi.quantity * 0.25
              WHEN oi.variant = '1kg' THEN oi.quantity * 1.0
              WHEN oi.variant = '20pc5g' THEN oi.quantity * 0.1
              WHEN oi.variant = 'unit' THEN oi.quantity * COALESCE(p.weight_grams, 0) / 1000.0
              ELSE 0
            END
          ), 0) as orderKilos
          FROM order_items oi
          LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ?
        `).get(order.id);
        orderKilos = friendKilosResult.orderKilos;

        // Calculate total item count (useful for bakery)
        const itemCountResult = db.prepare(`
          SELECT COALESCE(SUM(oi.quantity), 0) as itemCount
          FROM order_items oi
          WHERE oi.order_id = ?
        `).get(order.id);
        orderItemCount = itemCountResult.itemCount;
        orderPickupName = order.pickup_location_name || order.pickup_location_note || null;
        orderPacketa = !!order.packeta_address;
      }
    }

    return {
      ...cycle,
      hasOrder,
      orderTotal,
      orderStatus,
      orderKilos,
      orderItemCount,
      orderPickupName,
      orderPacketa
    };
  });

  // Filter by friend's subscriptions (if they have any)
  let filteredCycles = cyclesWithOrders;
  if (friendId) {
    const subs = db.prepare('SELECT type FROM friend_subscriptions WHERE friend_id = ?').all(friendId);
    if (subs.length > 0) {
      const subscribedTypes = subs.map(s => s.type);
      filteredCycles = cyclesWithOrders.filter(c => {
        // Always show cycles where friend has an existing order
        if (c.hasOrder) return true;
        // Filter by subscription type
        return subscribedTypes.includes(c.type || 'coffee');
      });
    }
  }

  res.json(filteredCycles);
});

// Get all friends (global, optionally filter by active status) with balance (admin)
router.get('/', requireAdmin, (req, res) => {
  const activeOnly = req.query.active === 'true';
  const sql = activeOnly
    ? `SELECT f.*, COALESCE(SUM(t.amount), 0) as balance
       FROM friends f
       LEFT JOIN transactions t ON t.friend_id = f.id
       WHERE f.active = 1
       GROUP BY f.id
       ORDER BY f.name`
    : `SELECT f.*, COALESCE(SUM(t.amount), 0) as balance
       FROM friends f
       LEFT JOIN transactions t ON t.friend_id = f.id
       GROUP BY f.id
       ORDER BY f.name`;
  const friends = db.prepare(sql).all();

  // Attach subscriptions and credential info to each friend
  const allSubs = db.prepare('SELECT friend_id, type FROM friend_subscriptions').all();
  const subsMap = {};
  for (const s of allSubs) {
    if (!subsMap[s.friend_id]) subsMap[s.friend_id] = [];
    subsMap[s.friend_id].push(s.type);
  }
  for (const f of friends) {
    f.subscriptions = subsMap[f.id] || [];
    f.hasCredentials = !!f.password_hash;
    // Don't expose credential material to clients
    sanitizeFriend(f);
  }

  res.json(friends);
});

// Get friend balance and recent transactions (for friend portal, requires friend auth)
router.get('/:id/balance', (req, res) => {
  const owner = requireFriendOwner(req, req.params.id);
  if (owner.error) {
    return res.status(owner.status).json({ error: owner.error });
  }

  const friendId = req.params.id;

  const friend = db.prepare(`
    SELECT f.id, f.name, COALESCE(SUM(t.amount), 0) as balance
    FROM friends f
    LEFT JOIN transactions t ON t.friend_id = f.id
    WHERE f.id = ?
    GROUP BY f.id
  `).get(friendId);

  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Get last 5 transactions
  const transactions = db.prepare(`
    SELECT t.id, t.type, t.amount, t.note, t.created_at, c.name as cycle_name
    FROM transactions t
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN order_cycles c ON c.id = o.cycle_id
    WHERE t.friend_id = ?
    ORDER BY t.created_at DESC
    LIMIT 5
  `).all(friendId);

  res.json({
    balance: friend.balance,
    transactions
  });
});

// Get friend detail with balance, transactions, and orders (admin)
router.get('/:id/detail', requireAdmin, (req, res) => {
  const friendId = req.params.id;

  const friend = db.prepare(`
    SELECT f.*, COALESCE(SUM(t.amount), 0) as balance
    FROM friends f
    LEFT JOIN transactions t ON t.friend_id = f.id
    WHERE f.id = ?
    GROUP BY f.id
  `).get(friendId);

  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Get all transactions for this friend
  const transactions = db.prepare(`
    SELECT t.*, o.cycle_id, c.name as cycle_name
    FROM transactions t
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN order_cycles c ON c.id = o.cycle_id
    WHERE t.friend_id = ?
    ORDER BY t.created_at DESC
  `).all(friendId);

  // Get all orders for this friend
  const orders = db.prepare(`
    SELECT o.*, c.name as cycle_name
    FROM orders o
    JOIN order_cycles c ON c.id = o.cycle_id
    WHERE o.friend_id = ? AND o.status = 'submitted'
    ORDER BY o.submitted_at DESC
  `).all(friendId);

  res.json({
    friend: sanitizeFriend(friend),
    transactions,
    orders
  });
});

// Create new friend (global, no cycle_id required) (admin)
router.post('/', requireAdmin, (req, res) => {
  const check = validateAdminFriendFields(req.body || {});
  if (check.error) {
    return res.status(400).json({ error: check.error, field: check.field });
  }
  const { name, display_name, phone, email } = check.values;

  if (!name) {
    // Relabelled from 'Prihlasovacie meno je povinné' (11 §UC-FC-004) — `name` is a
    // display label and never was a login (07 §UC-IA-007 history). The module-03
    // PATCH /:id/profile message below deliberately keeps the OLD copy.
    return res.status(400).json({ error: 'Meno a priezvisko je povinné', field: 'name' });
  }

  // Generate unique access token (kept for backwards compatibility)
  const access_token = nanoid(12);

  // Generate unique UID (8 alphanumeric characters)
  let uid = generateUid();
  while (db.prepare('SELECT id FROM friends WHERE uid = ?').get(uid)) {
    uid = generateUid();
  }

  // Generate unique invite code (5 characters)
  let invite_code = generateInviteCode();
  while (db.prepare('SELECT id FROM friends WHERE invite_code = ?').get(invite_code)) {
    invite_code = generateInviteCode();
  }

  // cycle_id column still has foreign key constraint, so we need a valid cycle_id
  // Use the first available cycle, or create a placeholder cycle if none exist
  // (shared with onboarding + approval — see helpers/friend-create.js, 07 §UC-IA-002)
  const cycleId = getPlaceholderCycleId();

  // Values are trimmed by validateAdminFriendFields; optional fields fall to NULL.
  // Still sets NO credentials — approval (07) and the per-row actions are the only
  // credential mints (11 §UC-FC-004: a rule, not an omission).
  const result = db.prepare(`
    INSERT INTO friends (cycle_id, name, display_name, uid, access_token, invite_code, active, phone, email)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(cycleId, name, display_name || null, uid, access_token, invite_code, phone || null, email || null);

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(sanitizeFriend(friend));
});

// Update friend (name, display_name, and/or active status) - Admin endpoint
router.patch('/:id', requireAdmin, (req, res) => {
  const body = req.body || {};
  // Deliberate: body validation runs BEFORE the existence lookup, so a malformed
  // body on a nonexistent id 400s rather than 404s (fail-fast on the request
  // shape; differs from the GSO-T5 existence-first convention, admin-only route).
  const check = validateAdminFriendFields(body);
  if (check.error) {
    return res.status(400).json({ error: check.error, field: check.field });
  }
  const { name, display_name, phone, email } = check.values;
  // `active` keeps its existing truthy coercion (11 §UC-FC-004) — 0/false/1/true
  // are all in live use by shipped specs.
  const { active } = body;

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);

  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // `name` present but blank after trim used to silently write '' — blanking the
  // display name in every list the friend appears in (11 §UC-FC-004). Absent stays
  // "untouched", as before.
  if (name !== undefined && !name) {
    return res.status(400).json({ error: 'Meno a priezvisko je povinné', field: 'name' });
  }

  const updates = [];
  const values = [];

  if (name !== undefined) {
    updates.push('name = ?');
    values.push(name);
  }
  if (display_name !== undefined) {
    updates.push('display_name = ?');
    values.push(display_name || null);
  }
  // ⚠ The invalidations MOVED down into the write transaction below (ML-T7). They used
  // to run here, while the `updates` array was still being built — i.e. BEFORE the
  // `active = 0` write they belong to, and outside any transaction. Same end state
  // (both calls are synchronous with nothing between them), but now a failed UPDATE
  // rolls the invalidations back with it instead of logging everyone out for a write
  // that never happened.
  let deactivating = false;
  if (active !== undefined) {
    updates.push('active = ?');
    values.push(active ? 1 : 0);
    if (!active) {
      deactivating = true;
    }
  }
  if (phone !== undefined) {
    updates.push('phone = ?');
    values.push(phone || null);
  }
  if (email !== undefined) {
    updates.push('email = ?');
    values.push(email || null);
  }

  if (updates.length > 0) {
    values.push(req.params.id);
    db.transaction(() => {
      db.prepare(`UPDATE friends SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      // §UC-ML-009 rule 3 — deactivation additionally deletes the friend's outstanding
      // magic links, in the same statement group as the `active = 0` write.
      // ⚠ Belt-and-braces: redemption's own `active = 1` check (§UC-ML-005) already
      // refuses an inactive friend, and §UC-ML-003's match refuses to mail them a new
      // one — those are the load-bearing gates and this delete is not a licence to
      // weaken them. `deactivating` can only be true when `updates` is non-empty (it
      // pushes `active = ?` itself), so nothing was lost by moving it in here.
      if (deactivating) {
        invalidateFriendSessions(req.params.id);
        invalidateLoginTokens(req.params.id);
      }
    })();
  }

  const updated = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);
  res.json(sanitizeFriend(updated));
});

// Update own profile (name, packeta address and — since UC-FC-009 — the friend's
// own contact data) - requires friends password
// Note: display_name is admin-only and cannot be changed by friends
router.patch('/:id/profile', (req, res) => {
  const owner = requireFriendOwner(req, req.params.id);
  if (owner.error) {
    return res.status(owner.status).json({ error: owner.error });
  }

  const { name, packeta_address } = req.body;
  const friendId = req.params.id;

  // ⚠ UC-FC-009 CONTACT GATE — deliberately NARROWER than requireFriendOwner.
  //
  // requireFriendOwner resolves `friendId: null` for bare shared-password auth
  // while auth_mode is 'legacy' (its migration window), which means ANY friend
  // who knows the shared password can PATCH ANY other friend's row on this
  // route. That is tolerable for `name` / `packeta_address` (module 03's shipped
  // behaviour, cosmetic and self-correcting), but NOT for the contact half:
  // module 09 resolves a recovery request by a case-insensitive, trimmed e-mail
  // match with "exactly one active match" (ML-T2 normalises both sides in JS —
  // do not restore the SQL spelling this comment used to name; see
  // `routes/magic-link.js`), so an address planted on a victim who has none of their
  // own SURVIVES the flip to auth_mode 'modern' and becomes an account-takeover
  // seam. The blast radius outlives the migration window, so the window does not
  // get to cover it.
  //
  // Costs real users nothing: POST /friends/auth mints a per-friend session
  // token in BOTH login modes (see the requireHost comment in
  // middleware/friend-auth.js), so every friend who logged in through the portal
  // has a resolved identity. Same 401 message requireFriendOwner uses for the
  // no-identity case, so the client sees one consistent instruction.
  const touchesContact = req.body.phone !== undefined || req.body.email !== undefined;
  if (touchesContact && owner.friendId == null) {
    return res.status(401).json({ error: 'Prihláste sa svojím menom a heslom' });
  }

  const friend = db.prepare('SELECT * FROM friends WHERE id = ? AND active = 1').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený alebo je neaktívny' });
  }

  // Module 03's own name rule — this message is pinned (friends-consolidation
  // "module-03 pin"); UC-FC-004's relabel deliberately did not reach it.
  //
  // ⚠ FUP-T12: the type guard is FOLDED INTO the existing rule, exactly as ML-T6 /
  // FUP-T10 / FUP-T11 folded theirs into a length rule — same status, same message,
  // no new branch. `!name.trim()` threw on every non-string AND on an explicit
  // `null` (`null !== undefined` is true), so `{name: null}` was a 500 too.
  if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
    return res.status(400).json({ error: 'Prihlasovacie meno je povinné' });
  }

  // UC-FC-009: phone/email self-edit with UC-FC-004's exact bounds/type guards
  // ({error, field} 400s, trim, `@` leniency, null → '' → clears). Validated
  // BEFORE any write so a rejected field leaves the whole row unchanged.
  // Last write wins with the admin route — same as packeta_address today.
  const contact = validateAdminFriendFields(req.body, ['phone', 'email']);
  if (contact.error) {
    return res.status(400).json({ error: contact.error, field: contact.field });
  }
  const { phone, email } = contact.values;

  if (name !== undefined) {
    db.prepare('UPDATE friends SET name = ? WHERE id = ?').run(name.trim(), friendId);
  }

  // ⚠ FUP-T12 — the OPTIONAL-FREE-TEXT case, and it is fixed differently from the
  // required fields on purpose. `packeta_address` has NO rule of its own on this
  // route, so there is no existing message to refuse a non-string with and the row
  // forbids inventing one. A non-string is therefore treated as if the KEY WERE
  // ABSENT: the write is skipped and the rest of the PATCH still applies.
  //
  // ⚠ NOT `typeof x === 'string' ? x.trim() : null` — that answers 200 while silently
  // WIPING a real delivery address, which is strictly worse than the 500 it replaces.
  // `null` stays in, because clearing by null is the shipped convention this route
  // (and AdminFriends.vue's `trim() || null`) depends on.
  if (packeta_address !== undefined && (packeta_address === null || typeof packeta_address === 'string')) {
    db.prepare('UPDATE friends SET packeta_address = ? WHERE id = ?')
      .run(packeta_address?.trim() || null, friendId);
  }

  if (phone !== undefined) {
    db.prepare('UPDATE friends SET phone = ? WHERE id = ?').run(phone || null, friendId);
  }

  if (email !== undefined) {
    db.prepare('UPDATE friends SET email = ? WHERE id = ?').run(email || null, friendId);
  }

  const updated = db.prepare('SELECT id, name, uid, packeta_address, phone, email FROM friends WHERE id = ?').get(friendId);
  res.json(updated);
});

// Admin: Reset friend password
router.put('/:id/reset-password', requireAdmin, (req, res) => {
  const { password } = req.body;
  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);

  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // ⚠ Type-guard BEFORE `hashPassword` (FUP-T11) — the same rule and the same reason
  // as `setup-credentials` above; requireAdmin bounds the exposure but not the class.
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Heslo musí mať aspoň 8 znakov' });
  }

  // ⚠ bcrypt ABOVE the transaction (the IA-T3 invariant — see setup-credentials).
  const passwordHash = hashPassword(password);

  // Set the password AND flag it must be changed: on next login the friend is
  // forced to choose their own password (SEC-A3 migration + forced-change #3).
  //
  // §UC-ML-009 rule 2 — the delete shares the `password_hash` write's transaction.
  // An admin reset is the "this account is being recovered/secured" event, so a link
  // mailed beforehand must not survive it. Conservative hygiene only (see
  // `invalidateLoginTokens`).
  db.transaction(() => {
    db.prepare('UPDATE friends SET password_hash = ?, must_change_password = 1 WHERE id = ?').run(passwordHash, req.params.id);
    invalidateLoginTokens(req.params.id);
  })();
  invalidateFriendSessions(req.params.id);

  res.json({ success: true });
});

// Admin: Set/change friend username
router.put('/:id/admin-username', requireAdmin, (req, res) => {
  const { username } = req.body;
  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);

  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }

  if (isUsernameTaken(username.toLowerCase(), friend.id)) {
    return res.status(409).json({ error: 'Užívateľské meno je už obsadené' });
  }

  // ⚠ NO `invalidateLoginTokens` HERE, DELIBERATELY (09 §UC-ML-009 rule 2, ML-T7 —
  // the FIFTH `invalidateFriendSessions` call site, which the spec's inventory does not
  // name). Rule 2 is scoped to writes of `friends.password_hash`; this route writes
  // `username` and nothing else, so the rationale behind it — "a password change is the
  // 'I have secured my account' event" — simply does not apply. Nor is the link at
  // stake: a magic link is keyed on `friend_id` and anchored on `friends.email`, so a
  // renamed login identifier neither invalidates it nor makes it point anywhere new.
  // The session invalidation below is here for its own, older reason (the credential
  // the friend logs in with just changed), not as a security event.
  //
  // The practical argument runs the same way: a friend whose username an admin just
  // changed is precisely someone who may be locked out, and killing their outstanding
  // recovery link would take away the way back in. Do not "fix" this omission without
  // a spec change.
  db.prepare('UPDATE friends SET username = ? WHERE id = ?').run(username.toLowerCase(), req.params.id);
  invalidateFriendSessions(req.params.id);
  const updated = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);
  res.json(sanitizeFriend(updated));
});

// Admin: sever a friend's Google link (11 §UC-FC-006).
//
// Support cases: the friend lost the Google account, the wrong account got linked,
// or they are being offboarded. The FRIEND-side link/unlink UX is module 10's
// (§UC-GA-007) — ⚠ that one is a DIFFERENT route on a DIFFERENT auth boundary
// (`DELETE /:id/google-link`, friend-owned). The two are deliberately separate paths
// and must never be multiplexed into one handler: an admin acting on somebody else's
// row and a friend acting on their own are not the same authorization question.
//
// Status codes:
//   404 — no such friend (checked before any write)
//   200 — unlinked, or already unlinked (idempotent, see below)
router.delete('/:id/google', requireAdmin, (req, res) => {
  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Already unlinked ⇒ 200, never 409 (the GSO-T5 `DELETE /guest-orders/:id`
  // precedent): a DELETE converges on the requested END STATE, and here that state is
  // simply already current. A double click, a retry or a second admin tab must not be
  // answered with an error nobody can act on. The UPDATE below is itself idempotent,
  // so there is no branch to take — it is written unconditionally.
  //
  // ⚠ THE UPDATE NAMES `google_sub` AND `google_email` ONLY, and the request BODY is
  // NEVER spread into it (the GSO-T5 single-owner-per-flag rule — a body-driven update
  // on a route whose name says "google" would be an arbitrary-column write).
  //
  // ⚠ `google_prompt_dismissed` is DELIBERATELY untouched (module 10 §Resolved
  // decisions #3, restated in 11 §UC-FC-006): the friend switched the "prepojiť Google"
  // prompt off themselves, and an admin support action on the LINK does not get to
  // re-enable the nagging. Their way back is module 10's manual link in the profile
  // modal (§UC-GA-007).
  db.prepare('UPDATE friends SET google_sub = NULL, google_email = NULL WHERE id = ?').run(req.params.id);

  // ⚠ NO `invalidateFriendSessions` HERE, DELIBERATELY. A Google link is a login
  // METHOD, not the session: password auth is untouched by this write, so an existing
  // `friend_sessions` row still points at a credential that works. This is a deliberate
  // asymmetry with `PUT /:id/admin-username` above, which DOES invalidate — a username
  // change orphans the very credential the session was minted against, an unlink does
  // not. Do not "harmonise" the two without a spec change.
  const updated = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);
  res.json(sanitizeFriend(updated));
});

// Delete friend (blocked if balance is non-zero) (admin)
router.delete('/:id', requireAdmin, (req, res) => {
  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(req.params.id);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Check balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(req.params.id);

  // Use small epsilon for floating point comparison
  if (Math.abs(balanceResult.balance) > 0.01) {
    return res.status(400).json({
      error: `Priateľ má nenulový zostatok (${balanceResult.balance.toFixed(2)} EUR). Pred vymazaním vyrovnajte zostatok.`
    });
  }

  // ⚠ `friends.root_friend_id` was added by a bare ALTER TABLE, so it has NO foreign
  // key: deleting a group's root used to leave every member pointing at a row that no
  // longer exists. Such a member belongs to no group and is not unassigned either, so
  // they dropped out of the rewards report entirely — a routine delete silently zeroed
  // their whole reward volume (own kilos and the guest kilos GSO-T9 credits them).
  // `rewards.js` now treats an unresolvable pointer as unassigned as well; this clears
  // the pointer so the broken state is not created in the first place. One
  // transaction: a half-applied delete would leave exactly the dangling rows this
  // prevents.
  const removeFriend = db.transaction(() => {
    db.run('UPDATE friends SET root_friend_id = NULL WHERE root_friend_id = ?', [req.params.id]);
    db.run('DELETE FROM friends WHERE id = ?', [req.params.id]);
  });
  removeFriend();

  res.status(204).send();
});

export default router;
