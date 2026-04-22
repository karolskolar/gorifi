import { Router } from 'express';
import db from '../db/schema.js';
import { validateFriendAuth } from '../middleware/friend-auth.js';

const router = Router();

// GET /code/:code — Validate invite code (public)
router.get('/code/:code', (req, res) => {
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

// POST /register — Submit invitation registration (public)
router.post('/register', (req, res) => {
  try {
    const { invite_code, name, phone, email } = req.body;

    if (!invite_code || !name?.trim() || !phone?.trim()) {
      return res.status(400).json({ error: 'Meno a telefón sú povinné' });
    }

    const friend = db.get(
      'SELECT id FROM friends WHERE invite_code = ? AND active = 1',
      [invite_code.toUpperCase()]
    );

    if (!friend) {
      return res.status(400).json({ error: 'Neplatný kód pozvánky' });
    }

    // Check for existing pending invitation with same phone
    const existing = db.get(
      "SELECT id FROM invitations WHERE phone = ? AND status = 'pending'",
      [phone.trim()]
    );

    if (existing) {
      return res.status(409).json({ error: 'Registrácia s týmto číslom už existuje' });
    }

    db.run(
      `INSERT INTO invitations (invite_code, invited_by_friend_id, name, phone, email)
       VALUES (?, ?, ?, ?, ?)`,
      [invite_code.toUpperCase(), friend.id, name.trim(), phone.trim(), email?.trim() || null]
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
router.get('/', (req, res) => {
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
router.patch('/:id', (req, res) => {
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
router.delete('/:id', (req, res) => {
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
