import { Router } from 'express';
import db from '../db/schema.js';

const router = Router();

// Helper: Validate global friends password
function validateFriendsPassword(req) {
  const setting = db.prepare("SELECT value FROM settings WHERE key = 'friends_password'").get();
  if (!setting || !setting.value) {
    return { error: 'Heslo pre priatelov nie je nastavene', status: 400 };
  }

  const password = req.headers['x-friends-password'];
  if (password !== setting.value) {
    return { error: 'Nespravne heslo', status: 401 };
  }

  return { valid: true };
}

// GET /friend/:friendId - Get friend's active subscriptions
router.get('/friend/:friendId', (req, res) => {
  const validation = validateFriendsPassword(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  const subs = db.prepare('SELECT type FROM friend_subscriptions WHERE friend_id = ?').all(req.params.friendId);
  res.json({ types: subs.map(s => s.type) });
});

// PUT /friend/:friendId - Set subscriptions
router.put('/friend/:friendId', (req, res) => {
  const validation = validateFriendsPassword(req);
  if (validation.error) {
    return res.status(validation.status).json({ error: validation.error });
  }

  const { types } = req.body; // ['coffee', 'bakery']
  if (!Array.isArray(types)) {
    return res.status(400).json({ error: 'types musi byt pole' });
  }

  const validTypes = ['coffee', 'bakery'];
  const filtered = types.filter(t => validTypes.includes(t));

  const updateSubs = db.transaction(() => {
    db.prepare('DELETE FROM friend_subscriptions WHERE friend_id = ?').run(req.params.friendId);
    for (const type of filtered) {
      db.prepare('INSERT INTO friend_subscriptions (friend_id, type) VALUES (?, ?)').run(req.params.friendId, type);
    }
  });

  updateSubs();

  res.json({ types: filtered });
});

export default router;
