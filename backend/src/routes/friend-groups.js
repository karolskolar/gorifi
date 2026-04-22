import { Router } from 'express';
import db from '../db/schema.js';

const router = Router();

// GET /api/friend-groups — all groups with members + unassigned
router.get('/', (req, res) => {
  try {
    // Get all root friends with their siblings
    const rootFriends = db.all(
      `SELECT id, name, display_name, uid, active FROM friends WHERE is_root = 1 ORDER BY name`
    );

    const groups = rootFriends.map(root => {
      const siblings = db.all(
        `SELECT id, name, display_name, uid, active FROM friends WHERE root_friend_id = ? ORDER BY name`,
        [root.id]
      );
      return { rootFriend: root, siblings };
    });

    // Unassigned: not root and not assigned to any root
    const unassigned = db.all(
      `SELECT id, name, display_name, uid, active FROM friends WHERE is_root = 0 AND root_friend_id IS NULL ORDER BY name`
    );

    res.json({ groups, unassigned });
  } catch (e) {
    console.error('Error fetching friend groups:', e.message);
    res.status(500).json({ error: 'Chyba pri načítaní skupín' });
  }
});

// PATCH /api/friend-groups/:id/root-status — toggle root status
router.patch('/:id/root-status', (req, res) => {
  try {
    const { id } = req.params;
    const { isRoot } = req.body;

    const friend = db.get('SELECT id, is_root, root_friend_id FROM friends WHERE id = ?', [id]);
    if (!friend) {
      return res.status(404).json({ error: 'Priateľ nebol nájdený' });
    }

    if (isRoot) {
      // Make root: clear any root_friend_id assignment
      db.run('UPDATE friends SET is_root = 1, root_friend_id = NULL WHERE id = ?', [id]);
    } else {
      // Remove root status
      const siblings = db.all('SELECT id FROM friends WHERE root_friend_id = ?', [id]);
      if (siblings.length > 0 && req.query.force !== 'true') {
        return res.status(400).json({
          error: 'Tento priateľ má priradených členov. Použite ?force=true na potvrdenie.',
          siblingCount: siblings.length
        });
      }
      // Unassign all siblings
      db.run('UPDATE friends SET root_friend_id = NULL WHERE root_friend_id = ?', [id]);
      db.run('UPDATE friends SET is_root = 0 WHERE id = ?', [id]);
    }

    res.json({ success: true });
  } catch (e) {
    console.error('Error updating root status:', e.message);
    res.status(500).json({ error: 'Chyba pri aktualizácii' });
  }
});

// PATCH /api/friend-groups/batch-assign — assign multiple friends to a root
router.patch('/batch-assign', (req, res) => {
  try {
    const { friendIds, rootFriendId } = req.body;

    if (!Array.isArray(friendIds) || friendIds.length === 0) {
      return res.status(400).json({ error: 'Zoznam priateľov je prázdny' });
    }

    if (rootFriendId !== null && rootFriendId !== undefined) {
      const root = db.get('SELECT id, is_root FROM friends WHERE id = ?', [rootFriendId]);
      if (!root || !root.is_root) {
        return res.status(400).json({ error: 'Cieľový priateľ nie je hlavný priateľ' });
      }
    }

    const runBatch = db.transaction(() => {
      for (const friendId of friendIds) {
        const friend = db.get('SELECT id, is_root FROM friends WHERE id = ?', [friendId]);
        if (!friend || friend.is_root) continue;
        db.run('UPDATE friends SET root_friend_id = ? WHERE id = ?', [rootFriendId || null, friendId]);
      }
    });
    runBatch();

    res.json({ success: true });
  } catch (e) {
    console.error('Error batch assigning:', e.message);
    res.status(500).json({ error: 'Chyba pri priraďovaní' });
  }
});

// PATCH /api/friend-groups/:id/assign-root — assign sibling to root friend
router.patch('/:id/assign-root', (req, res) => {
  try {
    const { id } = req.params;
    const { rootFriendId } = req.body;

    const friend = db.get('SELECT id, is_root FROM friends WHERE id = ?', [id]);
    if (!friend) {
      return res.status(404).json({ error: 'Priateľ nebol nájdený' });
    }

    if (friend.is_root) {
      return res.status(400).json({ error: 'Hlavný priateľ nemôže byť priradený do skupiny' });
    }

    if (rootFriendId !== null && rootFriendId !== undefined) {
      const root = db.get('SELECT id, is_root FROM friends WHERE id = ?', [rootFriendId]);
      if (!root || !root.is_root) {
        return res.status(400).json({ error: 'Cieľový priateľ nie je hlavný priateľ' });
      }
    }

    db.run('UPDATE friends SET root_friend_id = ? WHERE id = ?', [rootFriendId || null, id]);

    res.json({ success: true });
  } catch (e) {
    console.error('Error assigning root:', e.message);
    res.status(500).json({ error: 'Chyba pri priraďovaní' });
  }
});

export default router;
