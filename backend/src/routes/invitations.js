import { Router } from 'express';
import db from '../db/schema.js';
import { validateFriendAuth, validateUsername, isUsernameTaken } from '../middleware/friend-auth.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { abuseLimiter } from '../middleware/rate-limit.js';

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
        return res.status(409).json({
          error: 'Toto prihlasovacie meno je už obsadené',
          field: 'username',
        });
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
