import { Router } from 'express';
import { nanoid } from 'nanoid';
import db, { generateUid, generateInviteCode, generateTempPassword } from '../db/schema.js';
import {
  validateFriendAuth,
  validateUsername,
  isUsernameTaken,
  hashPassword,
} from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { abuseLimiter } from '../middleware/rate-limit.js';
import { bindValue } from '../helpers/bind-value.js';
import { getPlaceholderCycleId } from '../helpers/friend-create.js';
import { sendMail } from '../helpers/mailer.js';
import { renderEmail } from '../helpers/email-templates.js';
import {
  CREDENTIALS_EMAIL_SUBJECT,
  credentialsMessage,
  resolveLoginUrl,
} from '../helpers/credentials-message.js';
import { verifyGoogleIdToken } from '../helpers/google-auth.js';

const router = Router();

// ── POST /register input bounds (07 §UC-IA-003) ──────────────────────────────
// LOCAL constants that MIRROR guest.js's checkout bounds by value. They are
// deliberately NOT imported: `validateIdentity` in guest.js is module-private and
// pinned to the GSO-T3 money path (`guest-order.spec.js` is its regression net),
// so exporting it to share three numbers would put this public form on the same
// code path as the guest checkout.
const MAX_NAME_LENGTH = 120;
const MAX_PHONE_LENGTH = 32;
const MAX_EMAIL_LENGTH = 160;

// The fields of POST /register that must be strings when present, with the Slovak
// label used in the type-guard message.
const REGISTER_STRING_FIELDS = [
  ['invite_code', 'kód pozvánky'],
  ['name', 'meno'],
  ['phone', 'telefón'],
  ['email', 'e-mail'],
  ['username', 'prihlasovacie meno'],
];

// Trimmed string, or `undefined` when the field is absent/null.
//
// ⚠ Stricter than guest.js's `asString()`, which COERCES numbers and booleans.
// UC-IA-003 requires a non-string to be rejected outright — that is what fixes the
// recorded `{name: 123} → 500` (a number has no `.trim()`), and rejecting is safe
// here because the only writer is our own form, which always sends strings.
// Returns `null` for "present but not a string" so the caller can 400 with a field
// marker instead of throwing inside the handler.
function registerString(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim();
  return null;
}

// ⚠ ROUTE-LOCAL rejection message for the username, deliberately NOT the string
// `validateUsername` returns. The helper stays the single owner of the DECISION —
// only the user-facing sentence is overridden here — because its own message
// (`Uzivatelske meno musi mat 3-30 znakov`) is wrong for THIS screen in three ways
// at once: it has no diacritics, and it introduces a THIRD name for one field. The
// label directly above the input says "Prihlasovacie meno" and the sibling 409 on
// the same input says "Toto prihlasovacie meno je už obsadené", so the reader would
// see the field called three different things on the app's public first impression.
//
// The wording is the `field-help` under the input verbatim (07 §UC-IA-004's markup
// table), en dash included — the rule and its violation message should read the
// same. The helper's own string is fine at its OTHER call site (onboarding.js),
// which is why it is not edited: that would change a screen this task does not own.
const USERNAME_RULE_MESSAGE =
  'Prihlasovacie meno musí mať 3–30 znakov: malé písmená, čísla, bodka, podčiarknik, pomlčka.';

// Approval has no username-less path (07 §UC-IA-005: "a friend with a login is the
// whole point"), so the empty case gets its own sentence rather than the format rule
// above — the admin who left the field blank has not broken the format.
const USERNAME_REQUIRED_MESSAGE = 'Prihlasovacie meno je povinné.';

// Shared by the register 409 and the approval 409 — one field, one sentence.
const USERNAME_TAKEN_MESSAGE = 'Toto prihlasovacie meno je už obsadené';

// The second layer of `POST /register`'s pending-phone dedupe (10 §UC-GA-008 made
// that handler `async`, so its check and its write are no longer indivisible — see
// the block comment at the attach). `idx_invitations_phone_pending` is the ONLY
// unique index on `invitations`, so a message match alone would already be
// unambiguous; the `code` half follows `friends.js`'s `isGoogleSubConflict` so a
// future index on this table cannot silently start answering 409.
function isPendingPhoneConflict(e) {
  return typeof e?.code === 'string'
    && e.code.startsWith('SQLITE_CONSTRAINT')
    && /UNIQUE constraint failed: invitations\.phone/.test(String(e?.message || ''));
}

// GET /code/:code — Validate invite code (public, rate-limited against enumeration)
router.get('/code/:code', abuseLimiter, (req, res) => {
  try {
    const { code } = req.params;
    const friend = db.get(
      'SELECT id, name FROM friends WHERE invite_code = ? AND active = 1',
      [code.toUpperCase()]
    );

    if (!friend) {
      return res.status(404).json({ error: 'Neplatný kód pozvánky' });
    }

    res.json({ valid: true, inviterName: friend.name });
  } catch (e) {
    console.error('Error validating invite code:', e.message);
    res.status(500).json({ error: 'Chyba servera' });
  }
});

// POST /register — Submit invitation registration (public, rate-limited)
//
// The body is public, unauthenticated input, so nothing in it is trusted: every
// field is type-guarded before it is touched, bounded after trim, and the 400s
// carry a `field` marker so the form can point at the offending input (the
// guest.js contract). 07 §UC-IA-003.
//
// ⚠⚠ THIS HANDLER IS `async` (10 §UC-GA-008's optional Google attach), AND THE
// TRY/CATCH AROUND ITS WHOLE BODY IS THEREFORE LOAD-BEARING — the module-10 pattern,
// inherited verbatim from `friends.js`'s `POST /auth/google`. **Express 4 does not
// forward a rejected handler promise to the error middleware**, and the process runs
// under Node 20's default `--unhandled-rejections=throw`. So a throw ANYWHERE AFTER
// THE `await` — the two dedupe SELECTs, the INSERT under `SQLITE_BUSY` — would leave
// the client with NO RESPONSE AT ALL **and kill the process**, on a PUBLIC
// unauthenticated endpoint. The catch below already wrapped everything; what changed
// is that it now also has to.
router.post('/register', abuseLimiter, async (req, res) => {
  try {
    const body = req.body || {};

    // Type guards FIRST — before any `.trim()`, `.toUpperCase()` or length read.
    const values = {};
    for (const [field, label] of REGISTER_STRING_FIELDS) {
      const value = registerString(body[field]);
      if (value === null) {
        return res.status(400).json({ error: `Neplatný formát údajov (${label})`, field });
      }
      values[field] = value;
    }

    const inviteCode = values.invite_code || '';
    const name = values.name || '';
    const phone = values.phone || '';
    const email = values.email || '';

    if (!inviteCode || !name || !phone) {
      return res.status(400).json({ error: 'Meno a telefón sú povinné' });
    }

    // Bounds after trim, mirroring the guest checkout's wording.
    if (name.length > MAX_NAME_LENGTH) {
      return res.status(400).json({
        error: `Meno je príliš dlhé (najviac ${MAX_NAME_LENGTH} znakov)`,
        field: 'name',
      });
    }
    if (phone.length > MAX_PHONE_LENGTH) {
      return res.status(400).json({
        error: `Telefónne číslo je príliš dlhé (najviac ${MAX_PHONE_LENGTH} znakov)`,
        field: 'phone',
      });
    }
    if (email.length > MAX_EMAIL_LENGTH) {
      return res.status(400).json({
        error: `E-mail je príliš dlhý (najviac ${MAX_EMAIL_LENGTH} znakov)`,
        field: 'email',
      });
    }

    const friend = db.get(
      'SELECT id FROM friends WHERE invite_code = ? AND active = 1',
      [inviteCode.toUpperCase()]
    );

    if (!friend) {
      return res.status(400).json({ error: 'Neplatný kód pozvánky' });
    }

    // Optional username. ⚠ Lowercase + trim FIRST, and validate ONLY when the
    // result is non-empty: `validateUsername` returns "povinné" on an empty value,
    // so calling it unconditionally would 400 the shipped username-less happy path.
    // Empty/absent ⇒ stored as NULL.
    //
    // Deliberately AFTER the invite-code lookup: `isUsernameTaken` is a yes/no
    // answer about an existing friend, and gating it behind a valid code keeps this
    // public route from becoming a username-enumeration oracle for anyone with no
    // invitation at all.
    const username = (values.username || '').toLowerCase();
    if (username) {
      // The helper decides; the message is ours (see USERNAME_RULE_MESSAGE).
      if (validateUsername(username)) {
        return res.status(400).json({ error: USERNAME_RULE_MESSAGE, field: 'username' });
      }
      // A courtesy check only — approval (UC-IA-005) is the authoritative one, and
      // a name taken now may be free (or replaced by the admin) by then.
      if (isUsernameTaken(username)) {
        return res.status(409).json({ error: USERNAME_TAKEN_MESSAGE, field: 'username' });
      }
    }

    // Check for existing pending invitation with same phone
    const existing = db.get(
      "SELECT id FROM invitations WHERE phone = ? AND status = 'pending'",
      [phone]
    );

    if (existing) {
      return res.status(409).json({ error: 'Registrácia s týmto číslom už existuje' });
    }

    // ── The optional Google attach (10 §UC-GA-008) ──────────────────────────
    //
    // ⚠ NO NEW ENDPOINT AND NO NEW BUCKET (§UC-GA-013): the credential rides THIS
    // public route, on the `abuseLimiter` it already sat on. One endpoint, one
    // bucket — moving it to `authLimiter` would let a registration spammer behind
    // the office NAT lock colleagues out of password login.
    //
    // ⚠ IT SITS HERE, LAST, ON PURPOSE. Every check above is module 07's and runs
    // in module 07's order, so an absent/empty token leaves this handler's whole
    // decision sequence — and its 201 body — byte-identical to what it shipped.
    // It is also the only step that costs a network round trip, so nothing pays
    // for it until everything cheap has passed.
    //
    // ⚠⚠ BUT THE RESPONSE AND THE ROW ARE NOT THE ONLY THINGS THAT COULD MOVE, AND
    // ONE THING DID: **ATOMICITY**. The phone dedupe at the top of this block and the
    // INSERT at the bottom used to be separated by nothing — this whole handler was
    // synchronous, so under `instances: 1` no request could interleave between them.
    // The `await` below is **the first place in this repo where the standing
    // "handlers are fully synchronous" assumption stops holding**: request A carrying
    // a token yields at the verifier for the duration of a JWKS round trip, and
    // request B for the SAME phone can arrive, pass the dedupe and insert inside that
    // window. A's INSERT then hits `idx_invitations_phone_pending` and — before the
    // two guards below — fell into the generic catch as a **500 on a public endpoint
    // whose contract for that state is a 409**. No bad data was ever written (the
    // partial unique index is what holds), which is why this is narrow, not severe.
    //
    // Closed at BOTH layers, the GSO-T10 / friends.js pattern:
    //   1. the phone SELECT is re-run inside the token branch, immediately before the
    //      INSERT — so the window shrinks to nothing on a single process, and the
    //      no-token path (which never yields) keeps exactly one check, as before;
    //   2. `isPendingPhoneConflict()` in the catch translates the constraint to the
    //      SAME 409, which is the layer that survives the PM2-cluster scenario the
    //      standing concurrency caveat warns about — there, layer 1 can still lose.
    //
    // ⚠ NO AUTH-MODE GATE, deliberately (see §UC-GA-005/007): the surfaces that
    // require modern mode do so because `PUT /:id/google-link` answers 409 in
    // legacy. This path has no such refusal — it writes only a NEW invitation row,
    // approval mints a username + temp password regardless of mode, and the
    // attached identity is a frozen record for §UC-GA-009 to copy. GA-T5's legacy
    // hazard (planting an alternative credential on an EXISTING friend row, which
    // the shared office password makes reachable for anyone) has no analogue here.
    let googleSub = null;
    let googleEmail = null;
    const googleToken = body.google_id_token;
    // Absent / null / '' ⇒ today's flow, untouched. Anything else — including a
    // non-string — goes to the helper, which owns the type and length guard.
    if (googleToken !== undefined && googleToken !== null && googleToken !== '') {
      // ⚠ NETWORK I/O — MUST stay outside any db.transaction (helpers/google-auth.js,
      // the IA-T3 structural rule). There is no transaction on this path, so the
      // rule is restated rather than enforced by anything: keep it that way, and if
      // this handler ever grows one, verify FIRST and open it with `sub` in hand.
      // ⚠ The result is ALWAYS TRUTHY — branch on `.error`, never on falsiness.
      const v = await verifyGoogleIdToken(googleToken, { field: 'google_id_token' });
      if (v.error) {
        // ⚠ 400, NOT 401, for a token that did not verify. Registration is not a
        // login: a bad token is a bad FIELD, so the form keeps everything the
        // applicant typed and points at the one control that failed. The other
        // reasons keep the helper's own status (400 bad_request with the
        // `google_id_token` marker, 503 unavailable, 503 not_configured).
        if (v.reason === 'invalid') {
          return res.status(400).json({ error: 'Overenie Google účtu zlyhalo, skúste to znova', field: 'google' });
        }
        return res.status(v.status).json({ error: v.error, ...(v.field && { field: v.field }) });
      }

      googleSub = v.identity.sub;
      googleEmail = v.identity.email;

      // Courtesy dedupe (the UC-IA-003 convention). The AUTHORITATIVE check is the
      // `idx_friends_google_sub` UNIQUE index at approval (§UC-GA-009); these two
      // exist so the applicant learns now rather than after an admin's approval
      // fails. ⚠ NOT scoped to `active` — that index is not either, so a courtesy
      // check that ignored deactivated holders would wave through a registration
      // that can never be approved.
      const linkedFriend = db.get('SELECT id FROM friends WHERE google_sub = ?', [googleSub]);
      if (linkedFriend) {
        // ⚠ Names no friend (the §UC-GA-004 rule): a public form must not become a
        // "whose Google account is this?" directory.
        //
        // ⚠ ACCEPTED RISK, recorded (it is copy, not logic — the sentence is
        // product-owner-signed in §UC-GA-008 and must not be reworded here): on a
        // CONFIGURED but LEGACY deployment "Prihláste sa cez Google" is advice the
        // friend cannot take yet, because `POST /friends/auth/google` answers the
        // resolved-decision-#2 409 until the mode flips. Same class as the block's
        // "Po schválení sa budete môcť prihlásiť svojím Google účtom". Neither is a
        // dead end — module 07's approval always mints a username + temp password,
        // and the attach activates at the flip — but the honest operator note is:
        // ⚠ SET `GOOGLE_CLIENT_ID` AT OR AFTER THE MODERN FLIP, not before.
        return res.status(409).json({
          error: 'Tento Google účet je už prepojený s existujúcim účtom. Prihláste sa cez Google.',
          field: 'google'
        });
      }
      // ⚠ PENDING only — the phone-dedupe precedent, and an app check only (there
      // is no partial index on `invitations`, by design: the row is a frozen
      // historical record, so a processed or rejected registration must not block
      // the same person from registering again).
      const pendingWithSub = db.get(
        "SELECT id FROM invitations WHERE google_sub = ? AND status = 'pending'",
        [googleSub]
      );
      if (pendingWithSub) {
        // A DIFFERENT sentence from the one above: "you already have an account"
        // and "your registration is already queued" are different facts.
        return res.status(409).json({ error: 'Registrácia s týmto Google účtom už existuje', field: 'google' });
      }

      // ⚠ LAYER 1 OF THE RACE FIX (see the block comment above). Re-read the phone
      // dedupe now that the `await` has resolved: on a single process nothing can
      // interleave between here and the INSERT, so this closes the window the
      // verifier opened. Byte-identical 409 to the one at the top — same status,
      // same sentence, no `field` — because it is the same fact, just observed
      // later. The no-token path never reaches this line and still runs exactly
      // one phone check.
      const raced = db.get(
        "SELECT id FROM invitations WHERE phone = ? AND status = 'pending'",
        [phone]
      );
      if (raced) {
        return res.status(409).json({ error: 'Registrácia s týmto číslom už existuje' });
      }
    }

    db.run(
      `INSERT INTO invitations (invite_code, invited_by_friend_id, name, phone, email, username, google_sub, google_email)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [inviteCode.toUpperCase(), friend.id, name, phone, email || null, username || null, googleSub, googleEmail]
    );

    res.status(201).json({ success: true });
  } catch (e) {
    // ⚠ LAYER 2 OF THE RACE FIX. `idx_invitations_phone_pending` is the only unique
    // index on this table, and it states exactly the rule the two SELECTs above
    // check — so a constraint failure here is a lost race, not a server fault, and
    // the caller's state really is "already registered". A 500 would both be wrong
    // and leak a SQLite message into a public 500 log line on every retry.
    if (isPendingPhoneConflict(e)) {
      return res.status(409).json({ error: 'Registrácia s týmto číslom už existuje' });
    }
    console.error('Error registering invitation:', e.message);
    res.status(500).json({ error: 'Chyba pri registrácii' });
  }
});

// GET /my-code — Get authenticated friend's invite code
router.get('/my-code', (req, res) => {
  const validation = validateFriendAuth(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  // friendId comes from Bearer token session, or from query param in legacy mode
  const friendId = validation.friendId || req.query.friendId;
  if (!friendId) {
    return res.status(400).json({ error: 'Chýba identifikácia priateľa' });
  }

  try {
    // ⚠ FUP-T15 — `?friendId[a]=1` was bound here and threw. The catch below logs
    // `e.message` only, so this site never cost a stack — but it still answered 500
    // `Chyba servera` for a malformed query string. Unbindable ⇒ `undefined` ⇒ binds
    // as NULL ⇒ no friend ⇒ this route's own 404. The presence test above stays on
    // the raw value, so a missing id keeps its own 400.
    const friend = db.get('SELECT invite_code FROM friends WHERE id = ?', [bindValue(friendId)]);
    if (!friend) {
      return res.status(404).json({ error: 'Priateľ nebol nájdený' });
    }

    res.json({ inviteCode: friend.invite_code });
  } catch (e) {
    console.error('Error fetching invite code:', e.message);
    res.status(500).json({ error: 'Chyba servera' });
  }
});

// GET / — List invitations (admin)
//
// ⚠ `SELECT i.*` NOW SHIPS `invitations.google_sub` TO THE ADMIN CLIENT, AND THAT IS
// A DELIBERATE DECISION, NOT AN INHERITANCE (10 §UC-GA-008; GA-T1's review carried
// this forward for GA-T8 to settle). It is KEPT, on three grounds:
//   1. This route is `requireAdmin`. §UC-GA-013's strip rule — and 11 §UC-FC-005's,
//      which it inherits — names the FRIEND login response, the link/unlink
//      responses, the approve 201 and the allowlist GET. Every one of those is
//      reachable by the identity the key belongs to or by the public; this one is
//      not, and `GET /api/invitations` already returns the applicant's phone and
//      e-mail, which are more sensitive than an opaque Google subject id.
//   2. A `sub` is an OPAQUE PAIRWISE IDENTIFIER, not a credential: possessing it
//      authenticates nobody (only a signed token from Google does), and it is
//      per-OAuth-client, so it is not even a cross-site handle.
//   3. GA-T9 needs to know a link EXISTS in order to render the approval dialog's
//      Google line and to offer `drop_google_link` on a collision — and it must be
//      able to tell "linked" from "not linked" when `google_email` IS NULL, which
//      happens whenever Google reported the address unverified (§UC-GA-002).
// ⚠ The rejected alternative, recorded so a later row need not re-derive it:
// stripping the sub and publishing `google_email` alone would break case 3 exactly
// in the NULL-e-mail case. If it is ever stripped, replace it with a DERIVED
// `googleLinked` boolean (the §UC-GA-003 pattern) — never with the e-mail alone.
router.get('/', requireAdmin, (req, res) => {
  try {
    // ⚠ FUP-T15 — a query-string filter is client-shaped (`?status[a]=1` is an
    // object). Unbindable ⇒ `undefined` ⇒ falsy ⇒ the filter is not applied, which
    // is what an absent `?status` already does.
    const status = bindValue(req.query.status);

    let sql = `
      SELECT i.*, f.name as inviter_name, f.uid as inviter_uid
      FROM invitations i
      LEFT JOIN friends f ON f.id = i.invited_by_friend_id
    `;
    const params = [];

    if (status) {
      sql += ' WHERE i.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY i.created_at DESC';

    const invitations = db.all(sql, params);
    res.json(invitations);
  } catch (e) {
    console.error('Error fetching invitations:', e.message);
    res.status(500).json({ error: 'Chyba pri načítaní pozvánok' });
  }
});

// POST /:id/approve — Turn a pending invitation into a friend WITH WORKING
// CREDENTIALS, atomically (07 §UC-IA-005).
//
// ⚠ `requireAdmin` is PER ROUTE. This router is a MIXED mount: `GET /code/:code` and
// `POST /register` are public (the applicant has no account yet — that is the point),
// so wrapping the whole mount in `requireAdmin` would 401 the public registration
// flow. Every admin route here carries its own guard; this one mints credentials, so
// it is the least forgiving place to get that wrong. The anonymous-401 sweep lives in
// `e2e/tests/api-security.spec.js` (`ADMIN_ENDPOINTS`, 07 §UC-IA-008 item 1).
//
// Contract:
//   404 — unknown invitation id
//   409 — the invitation is not `pending` (body carries `created_friend_id` when the
//         row has one, so the dialog can name the friend that already exists)
//   400 — `username`/`note` present but not a string; no username resolvable; the
//         username fails the format rule. All with a `field` marker.
//   409 — the username is taken (`field: 'username'`)
//   201 — `{ friend: { id, name, uid, username }, username, tempPassword,
//           login_url, credentials_message, email }` — the last three added by
//         07 §UC-IA-009 (Mailgun delivery); see the send block at the bottom.
router.post('/:id/approve', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};

    const invitation = db.get('SELECT * FROM invitations WHERE id = ?', [req.params.id]);
    if (!invitation) {
      return res.status(404).json({ error: 'Pozvánka nenájdená' });
    }
    if (invitation.status !== 'pending') {
      // The dialog turns `created_friend_id` into "tento priateľ už existuje".
      // It is an informational back-link with no FK (UC-IA-001), so it may be NULL
      // (a rejected invitation) or dangle (the friend was hard-deleted) — nothing
      // here gates on it resolving.
      return res.status(409).json({
        error: invitation.status === 'rejected'
          ? 'Táto pozvánka bola zamietnutá'
          : 'Táto pozvánka už bola spracovaná',
        reason: 'not_pending',
        status: invitation.status,
        created_friend_id: invitation.created_friend_id ?? null,
      });
    }

    // Type guards before any `.trim()`/`.toLowerCase()`. Same reasoning as the public
    // register above (`registerString` is reused verbatim, not copied): an admin body
    // is still JSON from a client, and `{username: 123}` must be a 400, not a 500.
    const usernameFromBody = registerString(body.username);
    if (usernameFromBody === null) {
      return res.status(400).json({
        error: 'Neplatný formát údajov (prihlasovacie meno)',
        field: 'username',
      });
    }
    const note = registerString(body.note);
    if (note === null) {
      return res.status(400).json({ error: 'Neplatný formát údajov (poznámka)', field: 'note' });
    }

    // Resolution order (UC-IA-005): the admin's override, else what the applicant
    // asked for. `??` and not `||` deliberately — an admin who CLEARED the field is
    // saying "not this one", which is a 400 they can see and fix, not a silent
    // fallback to a username they just deleted. (`registerString` already trimmed, so
    // a whitespace-only override arrives here as `''`.)
    const username = (usernameFromBody ?? invitation.username ?? '').toLowerCase().trim();
    if (!username) {
      return res.status(400).json({ error: USERNAME_REQUIRED_MESSAGE, field: 'username' });
    }
    // The helper decides the format; the sentence is ours (see USERNAME_RULE_MESSAGE).
    if (validateUsername(username)) {
      return res.status(400).json({ error: USERNAME_RULE_MESSAGE, field: 'username' });
    }
    // THE authoritative uniqueness check (register's is a courtesy — UC-IA-003). Two
    // pending invitations may request the same name; first approval wins and the
    // second admin gets this 409 inline, with the field still editable.
    if (isUsernameTaken(username)) {
      return res.status(409).json({ error: USERNAME_TAKEN_MESSAGE, field: 'username' });
    }

    // ⚠ ORDERING RULE (UC-IA-005): bcrypt and the two collision-retry loops run
    // BEFORE the transaction. `hashPassword` is bcrypt cost 10 — ~62 ms of blocking
    // CPU — and better-sqlite3 transactions are synchronous, so hashing inside one
    // would hold the write lock for the whole time. Everything below the transaction
    // boundary is pure SQL.
    const tempPassword = generateTempPassword();
    const passwordHash = hashPassword(tempPassword);

    let uid = generateUid();
    while (db.prepare('SELECT id FROM friends WHERE uid = ?').get(uid)) {
      uid = generateUid();
    }
    let inviteCode = generateInviteCode();
    while (db.prepare('SELECT id FROM friends WHERE invite_code = ?').get(inviteCode)) {
      inviteCode = generateInviteCode();
    }
    const accessToken = nanoid(12);
    // `friends.cycle_id` still carries a NOT NULL FK; one home for the resolver
    // (UC-IA-002) — this is its third consumer. It may INSERT the placeholder cycle,
    // which is why it stays outside the transaction below: that transaction holds
    // EXACTLY the two writes the spec names.
    const cycleId = getPlaceholderCycleId();

    // Provenance (closes the GSO-T10 follow-up): a lead that arrived through a guest
    // sub-order stays distinguishable from a referral invitation after the invitation
    // row is deleted. Only the one known guest value is honoured — any other value of
    // the free-text `source` column becomes a plain 'invitation'.
    const onboardingSource = invitation.source === 'guest_order' ? 'guest_order' : 'invitation';

    // The note is the admin's label for this person: it becomes the friend's
    // display_name, and `note ?? existing` on the invitation means an ABSENT note
    // keeps whatever the admin wrote there earlier through the status PATCH.
    const displayName = note || null;
    const adminNote = note !== undefined ? note : (invitation.admin_note ?? null);

    // ONE transaction, EXACTLY TWO WRITES. better-sqlite3 rolls back on throw, so a
    // failure anywhere inside leaves neither the friend nor the invitation touched —
    // there is no state in which credentials exist but the invitation still reads
    // pending, or vice versa.
    //
    // DELIBERATE NON-WRITES, each a rule with a reason:
    //   • NO friend_subscriptions row — no rows means "sees everything"
    //     (friends.js / live-cycle.js). An invited friend starts UNFILTERED; this
    //     diverges on purpose from onboarding's bakery auto-subscribe.
    //   • NO session mint — the friend logs in themselves with the temp password.
    //   • NO transactions row — creating an account is not a financial event (the
    //     GSO-T6 lesson: a stray ledger row corrupts a real balance).
    //   • NO `invalidateLoginTokens` — and this one is an EXPLICIT EXEMPTION from
    //     09 §UC-ML-009 rule 2, recorded here so nobody "fixes" the omission. That rule
    //     makes every write to `friends.password_hash` delete the friend's outstanding
    //     magic links; the INSERT below writes `password_hash` too, but it CREATES the
    //     friend row, so `lastInsertRowid` is a brand-new id that no `login_tokens` row
    //     can reference yet (they are keyed on `friend_id` with an FK to a friend that
    //     did not exist a statement ago). The delete would be a guaranteed no-op, and
    //     adding it would put a third write inside a transaction the IA-T3 invariant
    //     pins at EXACTLY TWO.
    const approveInvitation = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO friends
          (cycle_id, name, display_name, uid, access_token, invite_code, active,
           phone, email, username, password_hash, must_change_password, onboarding_source)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?)
      `).run(
        cycleId, invitation.name, displayName, uid, accessToken, inviteCode,
        invitation.phone, invitation.email || null, username, passwordHash, onboardingSource
      );
      const newFriendId = result.lastInsertRowid;

      db.prepare(`
        UPDATE invitations
        SET status = 'processed', processed_at = CURRENT_TIMESTAMP,
            admin_note = ?, created_friend_id = ?
        WHERE id = ?
      `).run(adminNote, newFriendId, invitation.id);

      return newFriendId;
    });

    let friendId;
    try {
      friendId = approveInvitation();
    } catch (e) {
      // `idx_friends_username` is a partial UNIQUE index, so the app-level
      // `isUsernameTaken` above has a constraint behind it. Under `instances: 1` plus
      // synchronous better-sqlite3 the app check is the load-bearing one (check and
      // insert cannot be interleaved in-process), but the translation stays for the
      // PM2-cluster scenario — the same dual layer as GSO-T10's pending-phone rule.
      // Scoped to the username: a uid/invite_code collision is a real server fault
      // (the retry loops above just failed) and must not be reported as a conflict.
      const message = e?.message || '';
      if (/UNIQUE/i.test(message) && /username/i.test(message)) {
        return res.status(409).json({ error: USERNAME_TAKEN_MESSAGE, field: 'username' });
      }
      throw e;
    }

    // ── E-MAIL DELIVERY (07 §UC-IA-009) ───────────────────────────────────────
    // ⚠ AFTER THE TRANSACTION, NEVER INSIDE IT. The IA-T3 invariant is that the
    // transaction holds exactly two synchronous writes; better-sqlite3 transactions
    // are synchronous, so a network round trip inside one would hold the write lock
    // for the whole flight of an HTTP request to Mailgun.
    //
    // The message is rendered ONCE, on the server (helpers/credentials-message.js):
    // the same string is mailed and returned as `credentials_message`, which is what
    // the dialog's copy button writes. One renderer ⇒ the mail and the clipboard
    // cannot drift, and the admin pastes exactly what the friend received.
    const loginUrl = resolveLoginUrl(req);
    const message = credentialsMessage({ loginUrl, username, tempPassword });

    // ⚠ A MAIL FAILURE MUST NEVER FAIL THE APPROVAL (product decision). The friend
    // already exists, the invitation already reads `processed`, and the plaintext is
    // in the response below — a 500 here would tell the admin the approval failed
    // while it had in fact succeeded, and destroy the only copy of the password.
    // `sendMail` is written not to throw; this catch is the second layer, so even a
    // programming error in the mailer degrades to "send it by hand".
    let email;
    try {
      // 08 §UC-EM-003: the branded HTML part — a THIRD presentation of the same three
      // variables (loginUrl, username, tempPassword), composed FROM them, never parsed
      // out of the sentence, and never part of the clipboard. Content is fragments of
      // the product-owner-signed sentence ONLY plus the URL-as-label button default —
      // a real button label / footer / preheader would be new unsigned Slovak copy
      // (the recorded §UC-EM-003 OPEN item).
      //
      // ⚠ The render sits INSIDE this try/catch on purpose (§UC-EM-002): renderEmail
      // may throw, and a template bug must degrade to `email:{sent:false,error:
      // 'network'}` and the dialog's "send it by hand" warning — never a failed
      // approval, never a lost plaintext. The text part stays `message` VERBATIM
      // (renderEmail passes it through `===`-identical), so the mail's text and the
      // clipboard's `credentials_message` remain byte-identical by construction.
      const { html } = renderEmail({
        text: message,
        blocks: [
          { type: 'paragraph', text: 'Ahoj, tvoj účet je pripravený.' },
          {
            type: 'kv',
            rows: [
              { label: 'Užívateľské meno', value: username },
              { label: 'Dočasné heslo', value: tempPassword },
            ],
          },
          { type: 'paragraph', text: 'Prihlás sa na:' },
          { type: 'button', url: loginUrl },
          { type: 'paragraph', text: 'Po prvom prihlásení si nastav vlastné heslo.' },
        ],
      });
      email = await sendMail({
        to: invitation.email,
        subject: CREDENTIALS_EMAIL_SUBJECT,
        text: message,
        html,
      });
    } catch (e) {
      // No key material can reach here (it never leaves the mailer), but stay terse:
      // status/message only, per §UC-IA-009.
      console.error('[approve] credentials e-mail threw unexpectedly:', e?.message || e?.name);
      email = { sent: false, error: 'network' };
    }

    // The plaintext temp password exists in THIS RESPONSE AND NOWHERE ELSE: it is
    // never persisted (only its bcrypt digest is), never logged, and no other
    // endpoint returns it. (§UC-IA-009 mails it too, deliberately — bounded by
    // `must_change_password = 1` making it single-use.) Once the admin closes the
    // dialog it is unrecoverable by design — the recovery path is the existing
    // per-friend password reset.
    //
    // The friend object is HAND-PICKED — never `sanitizeFriend` (module-local to
    // friends.js, and a delete-list is the wrong default here) and never `SELECT *`,
    // so `invite_code` / `access_token` / `password_hash` cannot reach a client by
    // someone later adding a column. `email` is the mailer's own result object, whose
    // failure codes are a fixed vocabulary — never server text, never the API key.
    res.status(201).json({
      friend: { id: friendId, name: invitation.name, uid, username },
      username,
      tempPassword,
      login_url: loginUrl,
      credentials_message: message,
      email,
    });
  } catch (e) {
    console.error('Error approving invitation:', e.message);
    res.status(500).json({ error: 'Pozvánku sa nepodarilo schváliť' });
  }
});

// PATCH /:id — Update invitation status (admin)
router.patch('/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    // ⚠ FUP-T15 — both fields were pushed into `params` and bound. Unbindable ⇒
    // `undefined`, which for `status` is falsy (the column is left out of the SET
    // list) and for `admin_note` fails the shipped `!== undefined` gate — so a
    // malformed body updates NOTHING and falls to this route's own "Žiadne zmeny"
    // 400, instead of 500-ing or, worse, wiping a recorded admin note.
    //
    // ⚠ This guards the BIND, not the value space: `status: 'bogus'` is a perfectly
    // bindable string that the table's CHECK constraint still refuses exactly as it
    // always has. Inventing a status enum here would be a behaviour change hiding
    // inside a bug fix.
    const status = bindValue(req.body.status);
    const admin_note = bindValue(req.body.admin_note);

    const invitation = db.get('SELECT * FROM invitations WHERE id = ?', [id]);
    if (!invitation) {
      return res.status(404).json({ error: 'Pozvánka nenájdená' });
    }

    const updates = [];
    const params = [];

    if (status) {
      updates.push('status = ?');
      params.push(status);
      if (status !== 'pending' && !invitation.processed_at) {
        updates.push('processed_at = CURRENT_TIMESTAMP');
      }
    }

    if (admin_note !== undefined) {
      updates.push('admin_note = ?');
      params.push(admin_note);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'Žiadne zmeny' });
    }

    params.push(id);
    db.run(`UPDATE invitations SET ${updates.join(', ')} WHERE id = ?`, params);

    res.json({ success: true });
  } catch (e) {
    console.error('Error updating invitation:', e.message);
    res.status(500).json({ error: 'Chyba pri aktualizácii' });
  }
});

// DELETE /:id — Delete invitation (admin)
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const { id } = req.params;
    const invitation = db.get('SELECT id FROM invitations WHERE id = ?', [id]);
    if (!invitation) {
      return res.status(404).json({ error: 'Pozvánka nenájdená' });
    }

    db.run('DELETE FROM invitations WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (e) {
    console.error('Error deleting invitation:', e.message);
    res.status(500).json({ error: 'Chyba pri mazaní' });
  }
});

export default router;
