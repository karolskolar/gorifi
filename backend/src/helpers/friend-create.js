import db from '../db/schema.js';

// Shared pieces of "create a friend row", extracted so the several creation
// paths cannot drift apart (IA-T1, 07 §UC-IA-002).
//
// `friends.cycle_id` still carries a NOT NULL foreign key from the era when a
// friend belonged to one cycle, so every creation path needs a valid cycle id
// even though the column is meaningless for a global friend. This resolver used
// to exist twice — as a function in routes/onboarding.js and inlined in
// routes/friends.js's admin POST / — with identical behaviour: take the first
// `order_cycles` row by id, or create a completed `_placeholder` cycle when the
// table is empty (a brand-new install). It lives here now so the approval
// endpoint (07 §UC-IA-005) becomes the third consumer rather than a third copy.
// Never re-inline this query.
export function getPlaceholderCycleId() {
  let cycle = db.prepare('SELECT id FROM order_cycles ORDER BY id LIMIT 1').get();
  if (!cycle) {
    const result = db.prepare(
      `INSERT INTO order_cycles (name, status) VALUES ('_placeholder', 'completed')`
    ).run();
    return result.lastInsertRowid;
  }
  return cycle.id;
}
