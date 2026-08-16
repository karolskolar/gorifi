import { Router } from 'express';
import db from '../db/schema.js';
import { requireAdmin } from '../middleware/admin-auth.js';
import { bindValue } from '../helpers/bind-value.js';
import { requireFriendOwner } from '../middleware/friend-auth.js';

const router = Router();

// ⚠ FUP-T14 — `created_at` on a LEDGER ROW, so this refuses rather than guesses.
//
// `new Date(date).toISOString()` carried TWO bugs, and neither is the FUP-T12
// non-string class (a `typeof === 'string'` guard alone closes neither):
//   (1) it THROWS `RangeError: Invalid time value` for any unparsable value — and
//       `{"date":"garbage"}`, an ordinary well-typed STRING, is enough. That was a
//       500 plus ~1071 B of stack per request on both routes below.
//   (2) it silently ACCEPTED a number: `{"date":12345678}` stored `1970-01-01T…`,
//       and `{"date":true}` stored `1970-01-01T00:00:00.001Z`. A plausible-looking
//       wrong date, in the right column, in the ledger friends' balances are summed
//       from, with no error anywhere. That is the worse of the two.
//
// THE ACCEPTED SURFACE IS "A STRING `Date` CAN PARSE", and that is not a narrowing
// invented here — it is what the only two callers send. `AddPaymentDialog.vue` and
// `EditTransactionDialog.vue` both emit `selectedDate.value.toISOString()`, i.e. a
// full ISO 8601 string, through `api.js` `addPayment` / `updateTransaction`. A
// number is therefore refused deliberately: no caller produces one, so accepting it
// buys nothing and costs a wrong date nobody can see.
//
// ⚠ FALSY IS NOT REFUSED — it keeps its shipped meaning of "no date given", and each
// call site keeps its own default (now on the POST, unchanged on the PATCH). `null`,
// `''` and `0` all took that branch before this row and must keep taking it;
// tightening them would be a behaviour change hiding inside a bug fix. The PATCH's
// `date !== undefined` gate is likewise untouched: a present-but-falsy date still
// enters the branch (200, no-op) rather than falling to `Žiadne údaje na aktualizáciu`.
//
// `Date.parse` and `new Date(str)` are the same algorithm on a string, so every date
// that worked before still stores the exact same value.
function parseDate(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

// The refusal message is REUSED, never invented: `index.js`'s client-error branch
// already answers exactly this on a 400 for these routes (it is what an unparsable
// body gets today). Module 09's copy sign-off is still outstanding, so a
// date-specific sentence would be a new user-visible string. These two routes carry
// no `field` marker in any of their other 400s, so this one does not either.
const BAD_REQUEST = 'Neplatna poziadavka';

// GET /transactions/friend/:friendId - Get all transactions for a friend
// Friend-facing: shown in the friend portal's balance card. Enforces per-friend
// ownership (SEC-A2) — a friend's token may only read their own history.
router.get('/friend/:friendId', (req, res) => {
  const owner = requireFriendOwner(req, req.params.friendId);
  if (owner.error) {
    return res.status(owner.status).json({ error: owner.error });
  }

  const { friendId } = req.params;

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(friendId);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  const transactions = db.prepare(`
    SELECT t.*, o.cycle_id, c.name as cycle_name
    FROM transactions t
    LEFT JOIN orders o ON o.id = t.order_id
    LEFT JOIN order_cycles c ON c.id = o.cycle_id
    WHERE t.friend_id = ?
    ORDER BY t.created_at DESC
  `).all(friendId);

  res.json(transactions);
});

// POST /transactions/payment - Record a payment from friend (admin only)
router.post('/payment', requireAdmin, (req, res) => {
  // ⚠ FUP-T15 — `friend_id`, `order_id` and `amount` all reach binds here, and each
  // lands in a rule this route ALREADY has. The two IDS keep their presence tests on
  // the RAW value (a present-but-unbindable id must still be looked up and answered
  // with the route's 404, not silently treated as "no id given"); only the value
  // that reaches the bind is sanitized. `amount` is the opposite case: "unbindable"
  // genuinely is "no usable amount", so it falls into the route's own required-and-
  // positive 400. No new message anywhere.
  const { friend_id, order_id, note, date } = req.body;
  const friendIdValue = bindValue(friend_id);
  const orderIdValue = bindValue(order_id);
  const amount = bindValue(req.body.amount);

  if (!friend_id) {
    return res.status(400).json({ error: 'friend_id je povinný' });
  }

  if (amount === undefined || amount === null || amount <= 0) {
    return res.status(400).json({ error: 'Suma musí byť kladné číslo' });
  }

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(friendIdValue);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Validate order if provided
  if (order_id) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND friend_id = ?').get(orderIdValue, friendIdValue);
    if (!order) {
      return res.status(404).json({ error: 'Objednávka nebola nájdená alebo nepatrí tomuto priateľovi' });
    }
  }

  // Note max 160 chars.
  // ⚠ FUP-T12: `note` is OPTIONAL here and has no rule of its own, so a non-string is
  // treated as if the key were absent (⇒ NULL on this INSERT) rather than refused with
  // an invented message. `&& note` keeps `''` mapping to NULL exactly as before.
  const truncatedNote = typeof note === 'string' && note ? note.substring(0, 160) : null;

  // Use provided date or default to now (see `parseDate` above — FUP-T14).
  let createdAt = new Date().toISOString();
  if (date) {
    createdAt = parseDate(date);
    if (createdAt === null) {
      return res.status(400).json({ error: BAD_REQUEST });
    }
  }

  const result = db.prepare(`
    INSERT INTO transactions (friend_id, order_id, type, amount, note, created_at)
    VALUES (?, ?, 'payment', ?, ?, ?)
  `).run(friendIdValue, orderIdValue || null, amount, truncatedNote, createdAt);

  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);

  // Calculate new balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(friendIdValue);

  res.status(201).json({
    transaction,
    balance: balanceResult.balance
  });
});

// POST /transactions/adjustment - Add credit/adjustment for a friend (admin only)
router.post('/adjustment', requireAdmin, (req, res) => {
  // ⚠ FUP-T15 — see the payment route above: the two IDs keep their presence tests
  // on the RAW value and are sanitized only where they reach a bind; an unbindable
  // `amount` falls into this route's own required-and-non-zero 400.
  const { friend_id, order_id, note } = req.body;
  const friendIdValue = bindValue(friend_id);
  const orderIdValue = bindValue(order_id);
  const amount = bindValue(req.body.amount);

  if (!friend_id) {
    return res.status(400).json({ error: 'friend_id je povinný' });
  }

  if (amount === undefined || amount === null || amount === 0) {
    return res.status(400).json({ error: 'Suma je povinná a nemôže byť nula' });
  }

  // ⚠ FUP-T12: folded into the existing required rule — same status, same message.
  // (An adjustment's reason IS required, unlike the payment note above.)
  if (typeof note !== 'string' || !note.trim()) {
    return res.status(400).json({ error: 'Dôvod (poznámka) je povinný' });
  }

  const friend = db.prepare('SELECT * FROM friends WHERE id = ?').get(friendIdValue);
  if (!friend) {
    return res.status(404).json({ error: 'Priateľ nebol nájdený' });
  }

  // Validate order if provided
  if (order_id) {
    const order = db.prepare('SELECT * FROM orders WHERE id = ? AND friend_id = ?').get(orderIdValue, friendIdValue);
    if (!order) {
      return res.status(404).json({ error: 'Objednávka nebola nájdená alebo nepatrí tomuto priateľovi' });
    }
  }

  // Note max 160 chars
  const truncatedNote = note.trim().substring(0, 160);

  const result = db.prepare(`
    INSERT INTO transactions (friend_id, order_id, type, amount, note)
    VALUES (?, ?, 'adjustment', ?, ?)
  `).run(friendIdValue, orderIdValue || null, amount, truncatedNote);

  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(result.lastInsertRowid);

  // Calculate new balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(friendIdValue);

  res.status(201).json({
    transaction,
    balance: balanceResult.balance
  });
});

// PATCH /transactions/:id - Update a transaction (admin only)
router.patch('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;
  const { note, date } = req.body;
  // ⚠ FUP-T15 — THE SHARPEST STORED-VALUE CASE IN THIS ROW. `amount` was bound
  // unchecked, and a ONE-ELEMENT ARRAY spreads to exactly the arity the built
  // statement wants — so `{"amount":["abc"]}` answered a clean **200** and REPLACED
  // a real 42.50 EUR adjustment with the text "abc", which `SUM(amount)` then reads
  // as 0. `bindValue` yields `undefined`, and the gate below is `!== undefined`, so
  // the column is left out of the SET list and the recorded amount survives — the
  // "treat as absent, never coerce" rule, on the ledger. An explicit `null` still
  // takes the shipped "not an update to amount" branch, exactly as before.
  const amount = bindValue(req.body.amount);

  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!transaction) {
    return res.status(404).json({ error: 'Transakcia nebola nájdená' });
  }

  // Only allow editing payment and adjustment transactions (not charges)
  if (transaction.type === 'charge') {
    return res.status(400).json({ error: 'Účtovacie transakcie nie je možné upravovať' });
  }

  // Build update query dynamically
  const updates = [];
  const values = [];

  if (amount !== undefined && amount !== null) {
    if (transaction.type === 'payment' && amount <= 0) {
      return res.status(400).json({ error: 'Suma platby musí byť kladné číslo' });
    }
    updates.push('amount = ?');
    values.push(amount);
  }

  // ⚠ FUP-T12 — the optional-free-text shape on an UPDATE: a non-string is treated as
  // if the key were absent and the column is left out of the SET list. It may NOT be
  // coerced to NULL — that would answer 200 while erasing an admin's recorded reason.
  // A request carrying ONLY a malformed note therefore builds no updates and falls
  // through to this route's own `Žiadne údaje na aktualizáciu` 400.
  if (note !== undefined && (note === null || typeof note === 'string')) {
    const truncatedNote = note ? note.substring(0, 160) : null;
    updates.push('note = ?');
    values.push(truncatedNote);
  }

  // ⚠ FUP-T14 — see `parseDate` above. The `date !== undefined` gate is UNCHANGED:
  // a present-but-falsy date still enters here and writes `created_at` back to
  // itself, so it stays a 200 no-op rather than falling to the "nothing to update"
  // 400 below. The refusal returns from inside this block, which is safe precisely
  // because the UPDATE is executed only after every field has been collected — so a
  // rejected date cannot leave a half-applied `amount`/`note` behind.
  if (date !== undefined) {
    let createdAt = transaction.created_at;
    if (date) {
      createdAt = parseDate(date);
      if (createdAt === null) {
        return res.status(400).json({ error: BAD_REQUEST });
      }
    }
    updates.push('created_at = ?');
    values.push(createdAt);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'Žiadne údaje na aktualizáciu' });
  }

  values.push(id);
  db.prepare(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const updated = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);

  // Calculate new balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(transaction.friend_id);

  res.json({
    transaction: updated,
    balance: balanceResult.balance
  });
});

// DELETE /transactions/:id - Delete a transaction (admin only)
router.delete('/:id', requireAdmin, (req, res) => {
  const { id } = req.params;

  const transaction = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!transaction) {
    return res.status(404).json({ error: 'Transakcia nebola nájdená' });
  }

  // Only allow deleting payment and adjustment transactions (not charges)
  if (transaction.type === 'charge') {
    return res.status(400).json({ error: 'Účtovacie transakcie nie je možné vymazať' });
  }

  db.prepare('DELETE FROM transactions WHERE id = ?').run(id);

  // Calculate new balance
  const balanceResult = db.prepare(`
    SELECT COALESCE(SUM(amount), 0) as balance FROM transactions WHERE friend_id = ?
  `).get(transaction.friend_id);

  res.json({ balance: balanceResult.balance });
});

export default router;
