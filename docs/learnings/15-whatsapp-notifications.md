# 15 — WhatsApp notifications (module 21)

Spec: `docs/specification/21-whatsapp-notifications.md`. Tests: `e2e/tests/whatsapp-schema.spec.js`
(WA-T1). The later rows' obligations live in `whatsapp-outbox.spec.js` / `whatsapp-composer.spec.js`
(21 §UC-WA-014), which this row deliberately did NOT create, so the two never fight over a name.

## WA-T1 — outbox schema completion, `phone_e164`, `whatsapp_opt_in` (2026-10-22)

### What shipped

- **`notifications`** (DP-T1's table) gains `sent_via TEXT CHECK IN ('bot','wa_me','email')` and
  `email TEXT`. Both columns are appended after `error`, and they arrive the same way on both paths. A
  fresh database gets them in the CREATE. A deployed one gets them from try/catch ALTERs. The
  `recipient_kind` CHECK widens to `('friend','guest','waitlist','admin')`. There are three new
  indexes: `idx_notifications_status`, `idx_notifications_group (cycle_id, segment_key)`, and the
  PARTIAL UNIQUE `idx_notifications_queued_once (template_key, recipient_kind, recipient_id, cycle_id)
  WHERE status = 'queued'`.
- **`friends.phone_e164`**, **`friends.whatsapp_opt_in INTEGER DEFAULT 1`**, and
  **`guest_orders.phone_e164`**. A one-time JS back-fill (`schema.js backfillPhoneE164()`) runs after
  both tables' ALTERs.
- `helpers/phone.js toE164()` is adopted UNCHANGED at every writer in 21 §UC-WA-002's table:
  - admin `POST /api/friends`
  - admin `PATCH /:id` (the phone and its twin are pushed together, and a cleared phone clears both)
  - friend `PATCH /:id/profile` (ONE statement `SET phone = ?, phone_e164 = ?`)
  - invitations approve
  - onboarding
  - guest checkout `POST /api/guest/:token/orders`

  The waitlist already used it (GL-T3). `grep -rn parsePhoneNumber backend/src` hits
  `helpers/phone.js` only, and the spec pins this by walking the tree.
- `whatsapp_opt_in` is written EXPLICITLY at every friend creation. Admin POST writes **1** (PO
  2026-09-19, which overturned UC-WA-003's default). Approve and onboarding write **0**. The DEFAULT 1
  is the migration's tool for existing rows only.
- Both PATCH routes accept `whatsapp_opt_in` as a STRICT boolean: `true`, `false`, `1` or `0`. Anything
  else returns 400 `{error:'Neplatný formát údajov (súhlas so správami cez WhatsApp)', field:'whatsapp_opt_in'}`,
  and nothing is written. An absent key leaves the column untouched. One helper, `parseWhatsappOptIn`
  in `routes/friends.js`, serves both routes. The profile PATCH answer now also carries `phone_e164` and
  `whatsapp_opt_in`. This is needed because `FriendPortal.vue onProfileSaved` MERGES that answer into
  `currentFriend`, so a missing key would seed the next modal open from a stale value.
- Settings seeds `whatsapp_test_phone = ''` and `whatsapp_paused = '0'` are added only when missing
  (the `rewards_threshold_kg` idiom). The `wa_template:*` seeds are WA-T2's.
- UI:
  - The profile modal's MODULE 21 SLOT now renders the opt-in row, using `NeoCheckbox` in the
    remember-me row pattern. It shows module 21's label and its privacy `.field-help`.
  - The guest checkout carries the D6 sentence as `data-testid="guest-phone-help"`, inside the Mobil
    wrapper.

### Orchestrator decisions on DP-T1's three non-ALTER differences (recorded at the point of statement in `schema.js` too)

1. **CHECK widening ⇒ a guarded table RECREATE.**
   - It runs only when the STORED `sqlite_master.sql` lacks `'admin'`, so it is a no-op on every
     later boot.
   - It is one transaction: copy into `notifications_new`, DROP, RENAME.
   - Every row and id is preserved.
   - ⚠ **The AUTOINCREMENT mark is carried over by hand.** The copy only knows the highest SURVIVING
     id. `cancelForUnHandOver` deletes rows, so without the carry-over the deleted top id would be
     re-issued. The spec proves this: it deletes id 5, reboots, and checks that the next insert is 6.
   - The table's ONE definition is `notificationsTableSql(target)`. Both the fresh CREATE and the
     recreate use it, so they cannot drift.
2. **`segment_key` and `body` STAY NULLABLE.** Module 16 writes `body = NULL` rows. Module 21's own
   writers (WA-T4 onwards) enforce non-NULL themselves.
3. **NO FOREIGN KEYS, permanently.** `DELETE /cycles/:id` exists, and an FK would either block it or
   CASCADE away outbox history. `recipient_id` is polymorphic in any case.

### Traps found

- **The ordering trap, inverted.** The recreate copies a HARD-CODED column list
  (`NOTIFICATION_COLUMNS`), so every column in that list must already exist on the old table when the
  recreate fires. That is why the `sent_via`/`email` ALTERs sit ABOVE the recreate. A future column
  needs three things: it goes into `notificationsTableSql`, into `NOTIFICATION_COLUMNS`, and into an
  ALTER placed above the recreate. This is the mirror image of `order_cycles`'s `_check_test` lesson,
  where columns had to go AFTER.
- **`DROP TABLE` drops the indexes.** They are (re)created after the recreate, each in its own logged
  try/catch.
- **DP-T3's enqueue vs the new partial index.** `enqueueForHandOver`'s pre-check SELECT keys on
  (template, recipient, BAG). The index keys on (template, recipient, CYCLE). The two disagree only for
  a friend holding TWO orders in one cycle, because `orders` has no `UNIQUE(friend_id, cycle_id)`. In
  that case the second INSERT would throw INSIDE the hand-over transaction, and the throw would 500 the
  admin's button and roll back the stamp.
  - The fix is `outbox.js isQueuedOnceConflict(e)`, the GA-T8 idiom: code `SQLITE_CONSTRAINT*` plus
    the column-specific message.
  - ⚠ better-sqlite3 names the index COLUMNS in the error message, not the index name.
  - The conflict is caught per row and counted as „already queued". SQLite aborts only the failing
    STATEMENT, so the enclosing transaction carries on, and the spec proves the stamps commit.
  - WA-T4 replaces the pre-check with the index itself.
- **Consent joins the profile route's identity gate.** `whatsapp_opt_in` is added to `touchesContact`.
  Under bare shared-password auth (`friendId: null`), anyone could otherwise opt a colleague IN to
  WhatsApp messages. The request gets the same 401 and the same message as the phone/e-mail half.
- **`friends` columns are ALTER-only.** This follows the PI-T9 convention stated at
  `explainer_seen_at`: the friends CREATE is the 2024 shape, and a fresh database runs the ALTERs too.
  `guest_orders` gets CREATE + ALTER, which is that table's convention.
- **Existing pins superseded by design.** Each was retargeted with a strike note rather than deleted:
  - `distribution-foundation.spec.js`: the DP-T1 column list is now DP-T1's sixteen plus two, the
    recipient CHECK includes `'admin'`, and „no index" became module 21's three indexes.
  - `portal-profile-modal.spec.js`: the `.field-help` sequence goes from 5 to 6, with the privacy
    sentence at nth(3).
  - `guest-packeta.spec.js` GP-T3: the parcel-off checkout `.field-help` count goes from 1 to 2.
- **The scrub.** `friends.phone_e164` and `guest_orders.phone_e164` hold the SAME PII as the phone in
  another spelling.
  - `e2e/scrub-template.sql` NULLs both, each in its own statement. The gate server's first boot
    re-derives both from the SCRUBBED phone through the back-fill, so no second E.164 computation
    lives in SQL.
  - `e2e/verify-scrub.sql` checks `IS NOT NULL ⇒ leak`.
  - Same precedent as GL-T6: `make-test-db.sh` FAILS CLOSED until PRODUCTION has booted WA-T1. The
    local template's verify was already failing closed on `guest_waitlist`, which predates this row.
  - ⚠ SEAM FOR WA-T4: once module 21 writes non-NULL `notifications.phone_e164` / `email` / `body`
    snapshots, those columns are PII too and need their own scrub + verify lines.

### Open / for the PO

- ~~⚠ **Register mismatch.** The D6 guest sentence „Na toto číslo **vám** pošleme správu…" is module 21's
  fixed copy in the vy-form. The guest surface is TY-form (PO 2026-09-29, learnings 11 §TY-guest). It
  is shipped VERBATIM as the row instructed. If the PO wants it in the ty-form, „Na toto číslo ti
  pošleme správu, keď bude objednávka pripravená." is one string in `GuestOrder.vue` plus its pin in
  `whatsapp-schema.spec.js`.~~ **→ RESOLVED PO 2026-10-22: TY-form.** `GuestOrder.vue` now says „Na toto
  číslo **ti** pošleme správu, keď bude objednávka pripravená.", pinned by `GUEST_SENTENCE`; spec 21
  §UC-WA-003 carries the strike.
- 21 §UC-WA-014 obligations that belong to later rows are not here. These include composer, release,
  the D5 e-mail rows, and the `not_ordered` exclusion.
