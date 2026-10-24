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

## WA-T2 — templates: seed, fail-quiet reader, `renderTemplate`, `GET/PUT /api/notifications/templates` (2026-10-24)

Spec: 21 §UC-WA-004 as amended by „PO decisions 2026-09-19" + the orchestrator `{suma}` clarification.
Tests: `e2e/tests/whatsapp-templates.spec.js` (26) + two `ADMIN_ENDPOINTS` rows in `api-security.spec.js`.

### What shipped

- **Module split (the seam later rows build on).**
  - `backend/src/helpers/template-render.js` is PURE (its only import is `pricing.js roundMoney`, also pure).
    It holds `TEMPLATE_KEYS`, `TEMPLATE_SEEDS` (byte-exact to the spec table, `enabled` stored 0|1),
    `templateSettingKey()`, `seedSettingValue()`, `isTemplateKey()`, `MAX_BODY_LENGTH = 1000`,
    `PLACEHOLDERS` (the closed eight), `unknownPlaceholders()`, `unresolvedFor(body, vars)` (WA-T4/T5's release
    gate — see below), `NOTHING_OWED`, `renderTemplate()`, `formatMoney()`, `sumaValue()`, `formatDatum()`, `firstName()`.
    Purity is load-bearing twice: `db/schema.js` imports the seed table at boot (a DB-importing module there
    would be a circular import), and the spec imports the module with plain node. A spec pin checks its
    import lines.
  - `backend/src/helpers/templates.js` imports the DB: `getTemplate(key)` (null for a key outside the six),
    `listTemplates()` (key order), `writeTemplate(key, {body?, enabled?})` — the ONE writer. Published shape
    `{ key, name, body, enabled: boolean }`.
  - The boot seed joins WA-T1's `whatsapp_test_phone`/`whatsapp_paused` loop in `schema.js`: missing ⇒ INSERT,
    existing ⇒ untouched — including an INVALID existing row (the reader masks it; the boot never repairs it).
  - Source pin: the seed copy and the composed `` `wa_template:${…}` `` key exist in `template-render.js`
    only (comments excluded via `stripComments` — `outbox.js` NAMES the templates in a comment).
- **Fail-quiet reader.** A row is valid only if the PUT could have written it: an object, `name` a non-empty
  string, `body` a string ≤ 1000 with every `{…}` token in the vocabulary, `enabled` ∈ {0,1,true,false}.
  Anything else (bad JSON, `null`, an array, a stray type, `{menoo}` hand-typed into the row) reads as the SEED
  default and logs ONE bounded line (200-char excerpt) PER READ. A MISSING row reads as the seed silently.
  Nothing throws. A PUT on a corrupt row merges onto the seed default and rewrites the whole row valid (no
  parking — CLAUDE.md's park rule is `admin_google_subs`-specific; the corrupt excerpt is in the log).
- **Router** `routes/notifications.js`, mounted `app.use('/api/notifications', requireAdmin, …)` (wholly admin,
  the `/api/guest-waitlist` pattern). `GET /templates` ⇒ `{ templates: [6], placeholders: [8] }`.
  `PUT /templates/:key` ⇒ the template. Decisions:
  - unknown `:key` ⇒ 404 `unknown_template`, checked FIRST (prototype names `__proto__`/`constructor`/
    `toString` and the raw `wa_template:pickup` included; no row is ever created for one);
  - array body (incl. the one-element trap) ⇒ 400 `invalid_payload`; top-level `true`/`'abc'`/`null`/`42`
    never reach the route (express.json strict ⇒ 400 `entity.parse.failed`);
  - neither `body` nor `enabled` present (`{}`, bodyless, only unknown keys like `name`) ⇒ 400
    `nothing_to_change`; `name` is NOT editable and an extra key is ignored;
  - `body` non-string ⇒ 400 `invalid_body`; > 1000 (`.length`) ⇒ 400 `body_too_long`; an unknown token ⇒
    400 `unknown_placeholder` with `token` = the FIRST offender; empty is legal (custom, D3); stored verbatim;
  - `enabled` strict `true/false/1/0` else 400 `invalid_enabled`;
  - every 400 is `{ error: <Slovak>, reason, field?, token? }`; all validation precedes the write.
- **Tokenizer.** A token is any brace PAIR with no brace inside (`/\{[^{}]*\}/gu`) — `{}`, `{ meno }`,
  `{Meno}` are tokens and unknown; an unpaired brace is text. Token names are NFC-normalised before lookup, so
  a Mac-typed NFD `{objednávka}` is the same placeholder (stored body untouched).

### The `{suma}` seam (WA-T3/WA-T4 read this)

- `vars.suma = NOTHING_OWED` (a `Symbol.for('gorifi.wa.nothing_owed')` — registered, so it survives two module
  URLs) DROPS every sentence holding `{suma}`: from just after the previous boundary/newline (or the start) to
  the next boundary inclusive, or up to the next newline, or the end. **A boundary is `.`/`!`/`?` FOLLOWED BY
  WHITESPACE OR THE END** (review fix), so `12.5 €`, `revolut.me/…`, `podpultovka.biz` never cut. A sentence
  that began a line takes its following gap/line break with it; after a drop 3+ line breaks collapse to 2 and
  trailing whitespace is trimmed. The drop runs on the TEMPLATE before substitution, so a `.` in a value
  („Nám. SNP") cannot move a boundary.
- ⚠ **Known limit, pinned as behaviour:** an ABBREVIATION followed by a space in the TEMPLATE („(vr. dopravy)")
  IS a boundary — `'Ahoj. Suma (vr. dopravy): {suma}. Vďaka.'` ⇒ `'Ahoj. Suma (vr. Vďaka.'` when nothing is
  owed. The rule cannot tell it from a sentence end; the seeds hold none and the admin sees the preview.
- A NUMBER passed as `vars.suma` goes through `sumaValue()` inside the renderer (review fix): `31.1` ⇒
  `31,10 €`, `0`/negative/rounds-to-0 ⇒ the drop, `NaN` ⇒ literal. A raw `31.1`/`0` never reaches a message.
- ⚠ **RELEASE MUST ASK `unresolvedFor(body, vars)` — never rescan the rendered body** (review fix; the first cut
  exported `unresolvedPlaceholders(text)`, a rescan, and it is DELETED — a spec pins its absence). A value can
  carry braces (a guest named „{suma}"): a rescan would block that row for nothing, and the template+vars answer
  is the only one that knows which literal came from the template. WA-T4/T5 compute it at render time, beside
  the body. ⚠ The one case with no template+vars at hand is an admin's per-row body edit (UC-WA-008): a rescan
  there can only OVER-block (every literal the template left is still in the text), never under-block — WA-T4
  decides that case explicitly.
- „No value" is DIFFERENT: undefined / null / '' / blank / non-finite / non-string ⇒ the placeholder stays
  literal (D10) and release refuses the row. Never pass `''` to mean „paid".
- `sumaValue(owed)`: `roundMoney(owed) > 0` ⇒ `formatMoney(owed)`; finite ≤ 0 ⇒ `NOTHING_OWED`; else `''`.
  The CALLER computes `owed` (friend `-balance`, guest `total + delivery_fee` or 0 once paid).
- D4's „už uhradené" is retired; spec 21 §UC-WA-004's `{suma}` row, its acceptance line and D4 carry strikes.

### Formatters

- `formatMoney`: `31,10 €` — comma decimal, ORDINARY space (no NBSP), via `roundMoney`, no thousands separator;
  non-number ⇒ `''`.
- `formatDatum`: `v piatok 12. 9.` — the seven ACCUSATIVE forms with their preposition, spelled out
  (`v nedeľu … vo štvrtok … v sobotu`; ICU gives the nominative and the preposition changes before
  „štvrtok"). A `YYYY-MM-DD` string (`closes_at` is a CALENDAR date) is read with UTC arithmetic — no timezone;
  only a `Date` instant is converted to its Europe/Bratislava day. Impossible days (`2026-02-31`) ⇒ `''`.
  Not imported from `frontend/src/lib/dates.js` (no frontend code in the backend; that file owns the genitive set).
- `firstName`: first `\s+` token (NBSP counts) of the trimmed string; non-string ⇒ `''`.

### Traps found

- A pure-module spec gated on the NEW file's existence skips silently when the file is deleted — gate on
  `db/schema.js` (the backend tree) instead, so a missing module reds.
- `backend/public` must be REBUILT before running `whatsapp-schema.spec.js`: its three UI tests red on a stale
  build that predates WA-T1's profile checkbox (not a regression — rebuild, re-run, green).

## WA-T3 — `helpers/segments.js` + the two READ routes (2026-10-24)

Spec: 21 §UC-WA-005 (segments), §UC-WA-007 (the `waitlist:<cycle>` SEGMENT only), §UC-WA-008 (ONLY
`GET /segments` + `GET /`), as amended by „PO decisions 2026-09-19". Tests: `e2e/tests/whatsapp-segments.spec.js`
(22: 8 throwaway-boot probes, 10 HTTP over real module-16 hand-overs incl. 3 `DB_PATH`-gated, 4 validation) + three
`ADMIN_ENDPOINTS` rows. `guest-waitlist.spec.js` GL-T3 „no helpers/segments.js" pin RETARGETED (strike note).

### What shipped

- **`backend/src/helpers/segments.js`** — READ-ONLY (a probe pins `total_changes()` unmoved across every builder).
  The six kinds of the spec's table, keyed by 21's grammar:
  `handed_over:pickup:<loc>:<date>` (pickup) · `handed_over:packeta:<date>` (packeta) · `host_guests:<host>:<date>`
  (host) · `not_ordered:<cycle>` (closing) · `waitlist:<cycle>` (waitlist) · `all_active` (custom).
- **Routes** on `routes/notifications.js` (wholly admin mount):
  - `GET /segments?cycle_id=N[&segment_key=K]` ⇒ `{ cycle:{id,name,status}, groups, computed, segment? }`.
    `groups` = existing outbox rows of the cycle (+ cycle-less `all_active` rows) grouped by
    `(segment_key, template_key)`: `{ segment_key, name, template_key, template_name, counts:{queued,released,sent,failed,skipped}, total }`,
    ordered by first row id. `computed` = always `not_ordered:N`, `waitlist:N`, `all_active` with
    `{ key, name, template_key, template_enabled, requires_open_cycle, count, excluded_opt_out, no_phone }` (live
    counts — composed or not). `segment` (ONLY with `segment_key`) = the JSON preview of one built segment.
  - `GET /?cycle_id=N&segment_key=K` ⇒ `{ rows }`, id order, fields
    `id, template_key, recipient_kind, recipient_id, name, phone, phone_e164, channel, status, sent_via, body, error, created_at, released_at, sent_at`
    (the spec's list + `template_key`/`created_at`); `name`/`phone` via three LEFT JOINs each gated on
    `recipient_kind` and a PK (no multiplication); `all_active` ⇒ `cycle_id IS NULL`.
  - Validation: `cycle_id` `^[1-9]\d{0,15}$` string (missing/array/object/`0`/float ⇒ 400 `invalid_cycle_id`),
    unknown ⇒ 404 `unknown_cycle`; `segment_key` grammar ≤ 80 (incl. empty / repeated ⇒ 400 `invalid_segment_key`);
    preview: a grammatical non-segment ⇒ 404 `unknown_segment`; `not_ordered:/waitlist:<other cycle>` ⇒ 400
    `segment_cycle_mismatch`. The rows route reads any grammatical key (empty group ⇒ `[]`).

### THE SEAM (WA-T4 / WA-T5 consume this — in-process, never through JSON)

- `buildSegment(cycleId, key, { baseUrl }) ⇒ segment | null` — `{ key, kind, name, template_key, cycle_id,
  recipients, excluded_opt_out, no_phone, opted_out }`; recipient = §UC-WA-005's shape `{ recipient_kind,
  recipient_id, name, phone, phone_e164, email, opt_in, order_id, guest_order_id, vars }`. Hand `vars` to
  `renderTemplate()` / `unresolvedFor()` AS IS (`vars.suma` may be the `NOTHING_OWED` Symbol).
- `opted_out` = the active friends WITHOUT consent, in full — WA-T4's D5 e-mail rule needs them; JSON drops the list.
- `handOverSegmentKey({ delivery, handedOverAt, hostFriendId })` ⇒ the group of a handed-over bag, or null
  (`in_person`, no stamp, `via_host` without host id). **WA-T4 recipe:** for each stamped bag compute the key with
  THIS, `buildSegment(cycleId, key)` once per key, pick the bag's recipient by `order_id` / `guest_order_id`.
- `computedSegments(cycleId)`, `segmentSummary()`, `segmentForJson()`, `isSegmentKey()`, `parseSegmentKey()`,
  `segmentName()`, `bratislavaDateOf(stamp)`, `SEGMENT_KEY_MAX`.
- `template-render.js bratislavaDay()` is now EXPORTED (one home of „which Bratislava day").

### Decisions (orchestrator: please confirm or overturn)

1. **Symbol over JSON.** `JSON.stringify` silently DROPS a Symbol-valued key — `vars.suma = NOTHING_OWED` would
   vanish and read as „no value" = literal, release-blocking `{suma}`: the opposite meaning. `segmentForJson()`
   maps it to **`null` (key present)**; a string = the amount; an absent key = no source for that recipient.
2. **Standing-token exposure.** The JSON preview NEVER publishes `vars.odkaz` (a guest's `order_token`, a host's
   `friends.guest_link_token`); it carries `odkaz_resolved: boolean`. So WA-T3 adds NO publication surface for
   the standing token (CLAUDE.md's four-routes rule holds). ⚠ For WA-T5/WA-T12: a COMPOSED waitlist row's `body`
   contains `<base>/g/<guest_link_token>` by spec (§UC-WA-007 acceptance), and `GET /api/notifications` returns
   `body` to the admin — that is module 21's inherent fifth surface (the message IS the link; admin-only, the
   admin GET already mints it). CLAUDE.md's rule needs that clause when WA-T5 lands.
   ⚠ **(WA-T3 review) Recorded on the PROGRESS WA-T5 row too: once compose writes waitlist rows,
   `GET /api/notifications` returns bodies containing `/g/<guest_link_token>` — a FIFTH publication surface;
   the CLAUDE.md `guest_link_token` rule must gain that clause in WA-T5's change.**
3. **Read path never mints.** `{odkaz}` for waitlist = `standingUrlPath(token AS STORED)`; an un-minted host ⇒
   `''` ⇒ literal `{odkaz}` ⇒ release refuses (§UC-WA-007). GL-T3's contract comment said
   `ensureStandingToken()` — struck in `helpers/guest-waitlist.js`. Pinned (probe + DB_PATH HTTP + source pin).
4. **Waitlist `phone_e164 IS NOT NULL` (backlog row + GL-T3 contract) vs the spec.** Followed 21: no-phone rows
   are RETURNED and counted in `no_phone` (§UC-WA-005 „returned, not filtered"; §UC-WA-007 makes them
   `skipped/no_phone`). A waitlist row with `whatsapp_opt_in = 0` counts in `excluded_opt_out`. Not filtered by
   `w.cycle_id` (that is the signup round; the key's cycle is the round being announced). Inactive host ⇒ dropped.
5. **Balance source.** Friend `{suma}` = `sumaValue(balancePaymentBlock({id,name,balance}).amount)` — the balance
   is `COALESCE((SELECT SUM(amount) FROM transactions WHERE friend_id = f.id), 0)` (the `routes/cycles.js`
   distribution form), and `balancePaymentBlock` owns the sign flip + rounding. Guest = `paid ? NOTHING_OWED :
   sumaValue(guestPaymentBlock(row, cycle.name).amount)` (total + fee, the module-20 seam). No second formula.
6. **Base URL.** `options.baseUrl`, default `credentials-message.js resolveLoginUrl()` (PUBLIC_BASE_URL ⇒ allowlisted
   Origin ⇒ `https://podpultovka.biz`); the routes pass `resolveLoginUrl(req)` (a GET usually has no Origin, so in
   practice PUBLIC_BASE_URL / brand). ~~Guest `{odkaz}` = `${base}/g/o/${order_token}` composed in segments.js — a
   second composition of `routes/guest.js`'s mail URL (left untouched there; a shared helper would be one edit).~~
   **→ WA-T3 review: `helpers/guest-orders.js guestStatusUrlPath(token)` is the ONE composer of `/g/o/<token>`
   (`''` for a non-string/empty token, the `standingUrlPath` twin) — used by `routes/guest.js` `status_path` and
   the confirmation-mail URL (byte-identical output) and by segments.js's guest `{odkaz}` = `${base}${path}`.**
7. **Six kinds, no `in_person`.** The backlog row's „`handed_over:<target>` ×3" read as pickup/packeta/in_person;
   the spec's table has six kinds and §UC-WA-006 maps `in_person` to nothing ⇒ `handOverSegmentKey()` is null for
   it. `outbox.js`'s „its `in_person` SEGMENT still exists" comment is struck.
8. **`not_ordered` literal.** „Ordered" = an `orders` row of the cycle with ≥ 1 `order_items` row, ANY status: an
   empty auto-saved draft is not ordered, a DRAFT WITH ITEMS (never submitted) IS ordered. Spec-literal; if the PO
   wants unsubmitted carts reminded, it is one predicate (`AND o.status = 'submitted'`). Pinned both ways.
9. **Consent.** Friend rows: `active = 1 AND whatsapp_opt_in = 1` ⇒ recipient; active without consent ⇒
   `excluded_opt_out` (+ `opted_out`); inactive ⇒ neither (not counted). Guests: no flag, `opt_in: null`.
10. **Guest classification.** `deliveryOf(row)` with NO `host` option — segments read `.type`, which the classifier
    settles (own address ⇒ packeta, else via_host) before inheritance; same call as `cycles.js isPacketaSubOrder`.
    `{miesto}` for a via_host guest has no source ⇒ absent ⇒ literal (spec: „else unresolved").

### Traps found

- **DP-T3's segment keys are OUTSIDE 21's grammar.** `loc5` has a digit in the kind (`[a-z_]+`), `in_person` an
  `_` in a qualifier. So today's hook rows (`loc<id>`) show in `groups` with `name: null` but their rows 400 on the
  validated rows route. Deliberately NOT relaxed (spec regex); **WA-T4 must move the hook onto
  `handOverSegmentKey()`** — the groups test asserts both branches so it holds before and after. Existing DP-T3
  rows in production (if any) stay unreadable through the rows route; WA-T4 may want a one-time re-key.
- **A hand-over before cancel keeps `handed_over_at`** (the DP-T3 seam): the HTTP test hands a host over (stamping
  G1+G2), cancels G2 through the admin route, and pins G2's absence — the case the status filter exists for.
- A hand-over group name uses `d. m.` from the KEY's date (Bratislava), never from the stamp.
- A probe that `.find()`s a recipient and reads `.vars` TypeErrors when a mutation removes it — guard with `r ? … :
  null` so the mutation reds on the assertion, not on a crash.
- Mutation-checked (probes): cancelled filter, consent predicate, UTC-vs-Bratislava date, minting on read, the
  empty-draft predicate, a re-added waitlist no-phone filter — each reds ≥ 1 test.

### Open / for WA-T4/T5

- WA-T4: replace `outbox.js rowFor()`'s `segment_key` with `handOverSegmentKey()`; source vars/phone from
  `buildSegment()`; `opted_out` feeds D5. ⚠ **Re-key DP-T3's existing hook rows** (`loc<id>` / `packeta` /
  `host:<id>`) to the 21 grammar (recorded on the PROGRESS WA-T4 row).
- WA-T5: compose = `buildSegment()` + `renderTemplate(body, vars)` + `unresolvedFor(body, vars)`; refuse a
  `not_ordered`/`waitlist` compose while `requires_open_cycle && cycle.status !== 'open'`.
- Scrub: no new column. (WA-T4's non-NULL `notifications.phone_e164/email/body` remain that row's scrub item.)
