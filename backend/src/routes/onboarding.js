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
  const note = (req.body?.note || '').trim();
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
    const newNote = String(req.body.note).trim();
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

  const username = (req.query.u || '').toString().toLowerCase();
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

  const name = (req.body.name || '').trim();
  const phone = (req.body.phone || '').trim();
  const email = (req.body.email || '').trim();
  const usernameRaw = (req.body.username || '').toLowerCase().trim();
  const password = req.body.password || '';

  if (!name) return res.status(400).json({ error: 'Meno je povinné', field: 'name' });
  if (!phone) return res.status(400).json({ error: 'Mobil je povinný', field: 'phone' });
  if (email && !email.includes('@')) {
    return res.status(400).json({ error: 'Neplatný email', field: 'email' });
  }

  const usernameError = validateUsername(usernameRaw);
  if (usernameError) {
    return res.status(400).json({ error: usernameError, field: 'username' });
  }
  if (!password || password.length < 8) {
    return res.status(400).json({ error: 'Heslo musí mať aspoň 8 znakov', field: 'password' });
  }
  if (isUsernameTaken(usernameRaw)) {
    return res.status(409).json({ error: 'Užívateľské meno je už obsadené', field: 'username' });
  }

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

  const insertFriendWithBakerySubscription = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO friends
        (cycle_id, name, uid, access_token, invite_code, active,
         phone, email, onboarding_source, username, password_hash)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      cycleId, name, uid, accessToken, inviteCode,
      phone, email || null, link.note, usernameRaw, hashPassword(password)
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

