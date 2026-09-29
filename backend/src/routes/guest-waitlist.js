import { Router } from 'express';
import { listWaitlist, deleteWaitlistRow } from '../helpers/guest-waitlist.js';

// 19 §UC-GL-009 — the admin's read + delete of `guest_waitlist` („to the admin in
// full; deletable"). ADMIN-ONLY THROUGHOUT: a single-audience router, so the MOUNT is
// wrapped in `requireAdmin` (index.js) — unlike the MIXED `/api/guest-orders` and
// `/api/invitations` routers. Both routes are in `ADMIN_ENDPOINTS`
// (e2e/tests/api-security.spec.js).
//
// ⚠ No admin CREATE and no admin write of `notified_at` (module 21 owns it). The
// public writer is `POST /api/guest/:token/waitlist` (routes/guest.js); every
// statement that writes the table lives in helpers/guest-waitlist.js.
// ⚠ Synchronous handlers (the GA-T8 rule, as everywhere else).

const router = Router();

// A positive integer out of a query/param value, or null. A repeated query key
// arrives as an array and is ignored like any other non-integer.
function positiveInt(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

// GET /api/guest-waitlist[?host_friend_id=N] — `{ rows: [...] }`, grouped-order by
// host name (NOCASE), newest signup first within a host.
router.get('/', (req, res) => {
  res.json({ rows: listWaitlist(positiveInt(req.query.host_friend_id)) });
});

// DELETE /api/guest-waitlist/:id — the manual third purge path (§UC-GL-005 rule 3).
router.delete('/:id', (req, res) => {
  const id = positiveInt(req.params.id);
  if (id === null || !deleteWaitlistRow(id)) {
    return res.status(404).json({ error: 'Záznam nebol nájdený' });
  }
  res.json({ success: true });
});

export default router;
