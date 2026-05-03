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

const router = Router();

// Generate a 16-character base64url token for an onboarding link.
function generateLinkToken() {
  return crypto.randomBytes(12).toString('base64url');
}

// Resolve a placeholder cycle_id for new friends, matching the existing
// global friend creation pattern in routes/friends.js.
function getPlaceholderCycleId() {
  let cycle = db.prepare('SELECT id FROM order_cycles ORDER BY id LIMIT 1').get();
  if (!cycle) {
    const result = db.prepare(
      `INSERT INTO order_cycles (name, status) VALUES ('_placeholder', 'completed')`
    ).run();
    return result.lastInsertRowid;
  }
  return cycle.id;
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
// (admin auth is client-side only, per project convention)
// =====================================================================

// List all onboarding links with registration counts.
router.get('/onboarding-links', (req, res) => {
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
router.post('/onboarding-links', (req, res) => {
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
router.patch('/onboarding-links/:id', (req, res) => {
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
router.post('/onboarding-links/:id/regenerate', (req, res) => {
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
router.delete('/onboarding-links/:id', (req, res) => {
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

export default router;
