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
import { getPlaceholderCycleId } from '../helpers/friend-create.js';
import { sendMail } from '../helpers/mailer.js';
import {
  CREDENTIALS_EMAIL_SUBJECT,
  credentialsMessage,
  resolveLoginUrl,
} from '../helpers/credentials-message.js';

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
router.post('/register', abuseLimiter, (req, res) => {
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

    db.run(
      `INSERT INTO invitations (invite_code, invited_by_friend_id, name, phone, email, username)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [inviteCode.toUpperCase(), friend.id, name, phone, email || null, username || null]
    );

    res.status(201).json({ success: true });
  } catch (e) {
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
    const friend = db.get('SELECT invite_code FROM friends WHERE id = ?', [friendId]);
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
router.get('/', requireAdmin, (req, res) => {
  try {
    const { status } = req.query;

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
    // BEFORE the transaction. `hashPassword` is bcrypt cost 10 — ~100 ms of blocking
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
      email = await sendMail({
        to: invitation.email,
        subject: CREDENTIALS_EMAIL_SUBJECT,
        text: message,
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
    const { status, admin_note } = req.body;

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
