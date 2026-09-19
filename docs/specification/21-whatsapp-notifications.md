# 21 — WhatsApp notifications: outbox, segments, templates, composer, `gorifi-wa` process

> Scope: The first outbound-messaging layer of Podpultovka and the LAST slice of the
> October 2026 roadmap (PO 2026-09-06/19: launched only after the next ordering round has
> proven the in-app visibility of modules 16–20). Eight areas: (a) the `notifications`
> OUTBOX table and its state machine `queued → released → sent | failed | skipped` — rows
> are queued by module 16's hand-over hook or by the admin composer, released by exactly
> one admin „Poslať skupine“ per group, and sent by a separate process; **the API process
> never sends a WhatsApp message**; (b) `helpers/phone.js` — E.164 derivation
> (`phone_e164`, `+421` default) at EVERY write of `friends.phone`, `guest_orders.guest_phone`
> and the module-19 waitlist phone, with a one-time idempotent backfill; (c)
> `friends.whatsapp_opt_in` SEMANTICS (existing friends default on, new registrations off,
> opted-out excluded from every WhatsApp segment, operational ones included) — module 18
> hosts the checkbox UI; (d) templates in `settings` — six keys, seeded with the prototype's
> five drafts rewritten to the „objednávka“ register plus one free-text template, THREE
> enabled at start; (e) `helpers/segments.js` — the SQL recipient lists (handed-over per
> target per day, a host's guests, not-ordered in the open cycle, waitlist, everyone
> active); (f) the admin composer `/admin/whatsapp` (`a-wa`: auto-built groups → template
> text → per-recipient preview → „Poslať skupine (n)“; a wa.me click-to-chat tab as the
> hand fallback with a persisted per-row sent tick) and the release/compose/retry API; (g)
> the `gorifi-wa` process — a SEPARATE PM2 app with its own `package.json` running
> **whatsapp-web.js** (`LocalAuth` on disk, headless Chromium), polling `released` rows
> with pacing (random 3–10 s gap, ≤ 30 per rolling hour), stopping on an auth error,
> writing ONLY `status/sent_at/error`, exposing `GET :3010/health` which the API proxies to
> the settings page (`a-wa-settings`: state, number, QR pairing, pacing, opt-in count, test
> message), with a `WA_SENDER=stub` mode for the e2e suite; (h) deploy changes (ecosystem
> entries, `deploy.sh wa` component, `.env` keys, server sizing 8 GB / 4 vCPU / +2 GB disk /
> swap / `/dev/shm`) and the e-mail fallback (`channel='email'` through the existing mailer
> when a recipient has no valid number).
> Out of scope (handoffs): **Baileys and the WhatsApp Business Cloud API** (struck, PO
> 2026-09-19 — the sender is ONE whatsapp-web.js implementation behind one interface);
> **inbound message handling** (R5.9 — replies are not processed; the bot's WA profile text
> points at the PO's own number); **sending from the API process**; **Packeta tracking
> numbers** (no Packeta API — `{tracking}` is an optional, hand-filled placeholder);
> **the portal opt-in checkbox layout and the privacy-note placement** (module 18 §profile
> modal — this module owns only the column's semantics and the sentence); **the hand-over
> action, `handed_over_at`, and the distribution board's „Správa skupine“ button** (module
> 16 — this module defines the enqueue function 16 calls and the composer route 16 links
> to); **`order_cycles.closes_at`/`stage`** (module 17 — read here for `{datum}`);
> **`guest_waitlist` writes and the standing link** (module 19 — read here as a segment);
> **guest Packeta columns** (module 20 — read here for delivery type and `{suma}`); **cycle
> auto-completion** and **„pick up within N days“ copy** (both dropped, 00-overview).
> Actors: **Admin** — the ONLY writer and releaser: edits templates, prepares groups,
> reviews every body, presses „Poslať skupine“, ticks wa.me rows, pairs the bot, sends the
> test message. **WA process (system)** — `gorifi-wa`: reads `released` rows, sends, writes
> `sent`/`failed`; has no admin token and no HTTP write surface. **Friend** — recipient;
> controls `whatsapp_opt_in` in the profile (module 18's UI). **Guest** — recipient of
> operational messages about their own sub-order (no opt-in flag on `guest_orders` — see
> Decision D6); **Waitlist guest** — recipient of the round-open message under the explicit
> consent given on the pre-open page (module 19).
> Sources: `docs/superpowers/specs/2026-09-03-roadmap-requirements.md` §5 R5.1–R5.5,
> R5.7–R5.9 (composer, segments, templates, E.164, consent, human-in-the-loop, fallback,
> no inbound; §5's library assessment is STRUCK), §11 „Notifications wired to the pipeline“
> table + „Hand-over also enqueues“, §12 (DECISION whatsapp-web.js + server requirements
> table), §15 Q5.d/Q8.b, §16 rows F5, Q5.a–d, Q8.b, §17 R9.3, §18 row 9, §19 (Mobil =
> WhatsApp target); `00-overview.md` §Scope extension — roadmap October 2026 (row 21,
> glossary Outbox / Segment / Waitlist / Delivery type / Bag stages); `01-architecture.md`
> §Auth & data models → Roadmap additions (the `notifications` table, `phone_e164`,
> `whatsapp_opt_in`), §Permissions (notifications + WhatsApp settings = admin), §Shared
> services (the `gorifi-wa` process contract, sizing, stub sender), §Dependencies
> (`whatsapp-web.js` only in the WA process's own package; `libphonenumber-js` in
> `backend/`), §Testing & gate (stub sender, outbox transitions); `08-transactional-email.md`
> (`sendMail`/`renderEmail`, the three mailer rules — the fallback channel);
> `14-guest-order-recovery.md` (format reference; the fire-and-forget mail precedent in
> `routes/magic-link.js`); prototypes `docs/design/friends-portal-redesign/friends/admin2.jsx`
> (`A2.templates` = the five draft texts; `AWa` = composer; `AWaSettings` = settings) +
> README addendum 2026-09-06; repo code (`deploy/ecosystem.config.cjs`, `deploy/deploy.sh`,
> `backend/src/helpers/mailer.js`, `backend/src/routes/admin.js` settings GET/PUT,
> `routes/friends.js` (phone = length only), `routes/guest.js` (checkout identity),
> `routes/onboarding.js`, `routes/invitations.js`, `db/schema.js`, `middleware/rate-limit.js`,
> `e2e/tests/api-security.spec.js`, `frontend/src/views/AdminSettings.vue`,
> `FriendPortalSession.vue` profile modal); repo `CLAUDE.md`. The most recent decision wins
> on conflict (§16/§18 over §5/§8/§14; the orchestrator's 2026-09-19 scope note over §11's
> `in_person` row).
> **Design reference:** `admin2.jsx` screens `a-wa` (composer) and `a-wa-settings`
> (settings) — **layout and flow only** (the prototype borrows the Podpultovka theme; the
> admin app keeps the shadcn skin, 01-architecture §Design system scope rule: no `neo/`
> classes, no theme tokens). Match: the three-column composer (Komu · Šablóna · Náhľad),
> the „Cez bota (Podpultovka)“ / „Ručne z môjho čísla (wa.me)“ tab pair, the per-row
> Vo fronte / Odoslané badges, the settings page's Stav card + QR card + Tempo card +
> Šablóny list, and the copy transcribed in the UCs below.

---

## Resolved conflicts (recency / canonicity)

1. **Library.** §5's assessment (whatsapp-web.js „not viable“, Baileys, Cloud API as the
   upgrade path) and §9 item 2 are STRUCK. §12 + §16 F5/Q5 (PO 2026-09-06, confirmed
   2026-09-19) win: **whatsapp-web.js only**, server resources added. The „pluggable
   sender“ of R5.6 survives only as *one interface with one implementation plus the
   stub* (UC-WA-011) — no second backend is designed.
2. **Two phases → one module, two tabs.** §8's Phase A (wa.me composer, ≥ 2 cycles) then
   Phase B (bot) is superseded by §16 F5 („screens first“, PO decides on the `a-wa` tabs)
   and §18 row 9 (one slice). Both tabs ship together; the wa.me tab is the fallback, not
   a prerequisite phase. `OPEN:` default tab = „Cez bota“ with wa.me as the fallback tab
   (00-overview §Open prototype decisions).
3. **Six stage messages → three.** R5.3's „seed the six stage messages + closing soon +
   at pickup point“ is superseded by Q5.c/§16 Q5.a–d: three notifications to start
   (pickup delivered · handed to Packeta · handed to friend). The composer seeds six
   template KEYS (UC-WA-004) but only those three are `enabled` at seed.
4. **`in_person` hand-over message.** §11's table has a row for it („Vaša káva je
   zabalená, dohodneme odovzdanie“) and the prototype's hand-over confirm names it. The
   orchestrator's 2026-09-19 scope note wins: **`in_person` enqueues nothing by default**
   (the admin meets the friend personally). Recorded as Phase 2 in UC-WA-006.
5. **„Within N days“.** Q8.b's default („5 dní, per-location setting“) is superseded by
   §16 Q8.b: the pickup message says only that the bag is at the point and can be picked
   up. No `{dní}` placeholder exists.
6. **`{kolo}` → `{objednávka}`.** R5.3's placeholder list and every draft using „kolo“
   are rewritten to the §16 R1.6 register (00-overview glossary „Round / objednávka“).
7. **Timer sends.** R5.7 („nothing is sent on a timer without an explicit admin action“)
   and Q5.d („batched: queued on hand-over, released with one Poslať per group“) are
   consistent and both hold: no scheduler anywhere; the WA process only drains rows an
   admin has released.
8. **`guest_waitlist.notified_at`.** Module 19 says the waitlist „becomes a segment when
   the round opens“ but does not say who stamps `notified_at`. Because the WA process may
   write only `notifications` columns (01-architecture), the **API stamps `notified_at`
   at RELEASE** (UC-WA-007), not at `sent` — recorded as Decision D8.

---

## UC-WA-001 Schema — outbox table, phone/opt-in columns, template seed (system)

**Goal:** the persistent contract every other UC and the `gorifi-wa` process rely on.
All via the `try/catch ALTER` pattern; new tables via `CREATE TABLE IF NOT EXISTS` in
`backend/src/db/schema.js`; a column on a table already in prod needs CREATE **and** ALTER
(01-architecture §Roadmap additions).

**`notifications` (new table — the outbox):**

| Column | Type / constraint | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `channel` | TEXT NOT NULL CHECK IN (`'whatsapp'`,`'email'`) | e-mail = fallback only (UC-WA-010) |
| `template_key` | TEXT NOT NULL | one of UC-WA-004's keys, or `'test'` |
| `segment_key` | TEXT NOT NULL | the GROUP identifier (UC-WA-005 grammar); release is per `(cycle_id, segment_key)` |
| `recipient_kind` | TEXT NOT NULL CHECK IN (`'friend'`,`'guest'`,`'waitlist'`,`'admin'`) | ⚠ `'admin'` is an ADDITION to 01-architecture's list — needed only by the test message (UC-WA-012); orchestrator to mirror |
| `recipient_id` | INTEGER NULL | `friends.id` / `guest_orders.id` / `guest_waitlist.id`; NULL for `'admin'` |
| `phone_e164` | TEXT NULL | SNAPSHOT at enqueue — the ONLY column the sender reads for the address |
| `email` | TEXT NULL | snapshot at enqueue, used only when `channel='email'` (addition, same reason) |
| `body` | TEXT NOT NULL | the fully rendered message (≤ 1000 chars) |
| `status` | TEXT NOT NULL DEFAULT `'queued'` CHECK IN (`'queued'`,`'released'`,`'sent'`,`'failed'`,`'skipped'`) | |
| `sent_via` | TEXT NULL CHECK IN (`'bot'`,`'wa_me'`,`'email'`) | how a `sent` row went out (addition — the wa.me tick needs it, UC-WA-009) |
| `cycle_id` | INTEGER NULL FK `order_cycles` | NULL only for `'test'` and `all_active` rows |
| `order_id` | INTEGER NULL FK `orders` | the party, when a friend order |
| `guest_order_id` | INTEGER NULL FK `guest_orders` | the party, when a sub-order |
| `created_at` | DATETIME DEFAULT CURRENT_TIMESTAMP | |
| `released_at` | DATETIME NULL | set by the release endpoint |
| `sent_at` | DATETIME NULL | set by the sender / the manual tick / the mailer callback |
| `error` | TEXT NULL | fixed vocabulary + bounded detail (≤ 300 chars), never a token |

Indexes: `idx_notifications_status (status)`; `idx_notifications_group (cycle_id,
segment_key)`; **partial unique** `idx_notifications_queued_once ON notifications
(template_key, recipient_kind, recipient_id, cycle_id) WHERE status = 'queued'` — the
DB-level half of enqueue idempotency (UC-WA-006): the same recipient cannot hold two
queued rows of the same template in the same cycle. The API translates
`SQLITE_CONSTRAINT*` + the index name into „already queued“ (GA-T8 idiom), never a 500.

**Columns on existing tables (CREATE + ALTER):**

- `friends.phone_e164 TEXT` — derived (UC-WA-002); `friends.phone` stays as entered.
- `friends.whatsapp_opt_in INTEGER DEFAULT 1` — the ALTER gives every EXISTING row `1`
  (R5.5: they already receive the PO's WhatsApp messages). New registrations write `0`
  explicitly (UC-WA-003) — the DEFAULT is the migration's tool, not the registration's.
- `guest_orders.phone_e164 TEXT` — ⚠ addition to 01-architecture's list (it names the
  derivation „at every write of `guest_phone`“ but not the column); orchestrator to mirror.
- `guest_waitlist.phone_e164` already exists in module 19's CREATE — this module only
  mandates that 19's INSERT calls `toE164()` (UC-WA-002 seam).

**Settings rows (seeded at boot if missing — the `rewards_threshold_kg` idiom):**
`wa_template:<key>` for the six keys of UC-WA-004 (JSON `{ name, body, enabled }`),
`whatsapp_test_phone` (`''`), `whatsapp_paused` (`'0'`). Seeding never overwrites an
existing row (the admin's edits survive every restart).

**Business rules:**

- Nothing here touches `transactions`, `orders.total`, `packed`, `handed_over_at`, or
  any guarded seam (`helpers/stock.js`, `pricing.js`, `packing.js`, `pickup.js`,
  `guest-aggregation.js`). Notifications are not financial events (the GSO-T6 lesson).
- `status` is the ONLY column with a state machine; the transitions and who performs
  them are fixed in UC-WA-008 (API) and UC-WA-011 (process). No other writer exists:
  ⚠ the WA process writes `status`, `sent_at`, `sent_via`, `error` and nothing else —
  never `body`, never `phone_e164`, never another table.
- The one-time backfill (UC-WA-002) runs after the ALTERs, inside `schema.js`'s
  initialisation, in JS (the helper is JS): `SELECT id, phone FROM friends WHERE
  phone_e164 IS NULL AND phone IS NOT NULL` → `UPDATE friends SET phone_e164 = ?` for
  each row that normalises. Idempotent by construction (rows that fail stay NULL and are
  retried on the next boot — ~50 rows, negligible). Same for `guest_orders`.

**Acceptance criteria:** after a boot on a copied prod-shaped DB every pre-existing
friend has `whatsapp_opt_in = 1`; a friend with `phone = '0905 123 456'` has `phone_e164
= '+421905123456'`; the six `wa_template:*` rows exist with exactly `pickup`,
`packeta`, `host` `enabled: true`; inserting a second `queued` row for the same
`(template_key, recipient_kind, recipient_id, cycle_id)` fails on the partial index
while a second `sent` one does not.

---

## UC-WA-002 `helpers/phone.js` — E.164 derivation at every phone write (system)

> Shared with module 19 (UC-GL-004 waitlist idempotency key): whichever module lands first ships
> `helpers/phone.js` with THIS contract; the other consumes it unchanged.

**Goal:** ONE normaliser, called at every write of a phone column, so the sender never
parses a phone (R5.4). Package: **`libphonenumber-js`** in `backend/package.json`
(pre-approved, 01-architecture §Dependencies; `/min` metadata build is sufficient).

**The seam:**

```js
toE164(raw, { defaultCountry = 'SK' } = {}) → '+421905123456' | null
```

- `raw` is coerced with `String(raw ?? '').trim()`; empty ⇒ `null`.
- `parsePhoneNumberFromString(raw, defaultCountry)`; result must satisfy `isValid()`;
  returns `number.number` (E.164) else `null`. No exceptions escape (wrap in try/catch
  ⇒ `null`) — a phone must never 500 a checkout.
- `+421` default means a national `09xx…` and an international `00421…` / `+421…` all
  converge; a Czech `+420…` stays Czech (the library handles it — no hand-rolled prefix
  logic, no regex fallback).
- ⚠ **Normalisation NEVER refuses a write.** `friends.phone` and `guest_phone` keep their
  length-only validation (friends.js:55-92, guest.js:107-155 — untouched); a row whose
  phone fails to normalise gets `phone_e164 = NULL` and surfaces in the composer as
  „bez platného čísla“ (UC-WA-005/009) with its `notifications` row `skipped`
  (UC-WA-006). Module 18's profile modal MAY show a soft format hint (its call).

**Every writer (enumerated — the CLAUDE.md „guard must enumerate every file“ rule):**

| Writer | Column pair | Change |
|---|---|---|
| `routes/friends.js` `POST /` (admin create) | `friends.phone` → `phone_e164` | INSERT both |
| `routes/friends.js` `PATCH /:id` (admin edit) | same | when `phone !== undefined`, also `phone_e164 = toE164(phone)` |
| `routes/friends.js` `PATCH /:id/profile` (friend self-edit, UC-FC-009) | same | same |
| `routes/invitations.js` `POST /:id/approve` | invitation `phone` → new friend row | INSERT `phone_e164` — ⚠ inside the SAME two writes, no third statement (the approve-route invariant: exactly TWO writes inside the transaction; `phone_e164` is a column of the friend INSERT, not a new statement) |
| `routes/onboarding.js` `POST /onboarding/:token` | `phone` → friend row | INSERT both |
| `routes/guest.js` `POST /:token/orders` (checkout) | `guest_phone` → `guest_orders.phone_e164` | INSERT both (identity is frozen at submit — no PUT path writes it) |
| module 19 `POST /api/guest/…/waitlist` | `guest_waitlist.phone` → `phone_e164` | 19's INSERT calls `toE164()`; its `(host, phone_e164)` idempotency key is the E.164 value when non-NULL, the raw phone otherwise (seam — 19 to state the same) |
| `schema.js` backfill | both tables | UC-WA-001 |

No other file may compute an E.164 value; `grep -rn "parsePhoneNumber" backend/src`
must hit `helpers/phone.js` only.

**Acceptance criteria:** `'0905 123 456'`, `'+421 905 123 456'`, `'00421905123456'`
⇒ `'+421905123456'`; `'123'`, `'abc'`, `''` ⇒ `null`; a friend profile PATCH with
`phone: '0905123456'` reads back `phone_e164 = '+421905123456'`; a guest checkout with
`guest_phone: '0000000000'` still 201s with `phone_e164 = NULL`; the approve route still
performs exactly two writes inside its transaction.

---

## UC-WA-003 `whatsapp_opt_in` — consent semantics (Friend)

**Goal:** the column's meaning and every place it gates, with module 18 owning the pixels.

**Business rules:**

- **Defaults:** existing rows `1` via the ALTER default (UC-WA-001). Every registration
  path that CREATES a friend (`invitations.js` approve, `onboarding.js`, `friends.js`
  admin POST) writes `whatsapp_opt_in = 0` explicitly — new people are off until they tick
  it (R5.5). `OPEN:` should the admin's own `POST /api/friends` default to `1` (the PO
  creates friends he already messages)? Default here: `0`, consistent with „new = off“.
- **Write surface:** `PATCH /api/friends/:id/profile` (friend, `requireFriendOwner`) gains
  `whatsapp_opt_in` as a strict boolean (`true`/`false`/`0`/`1` only; anything else 400
  — the unbindable-body rule). Admin `PATCH /api/friends/:id` gains it too (the admin
  may switch it off on request). `GET /api/friends/:id/profile` and the admin friend
  detail return it. Module 18's profile modal renders the checkbox with the label
  **„Chcem dostávať správy o objednávke cez WhatsApp“** and, under it, the one privacy
  sentence (R5.5 GDPR): **„Vaše číslo používame len na správy o vašej objednávke a jej
  odovzdaní. Súhlas môžete kedykoľvek zrušiť tu v profile.“** (this module owns the two
  strings; 18 owns placement and the modal's save flow).
- **Gate:** `helpers/segments.js` adds `AND f.whatsapp_opt_in = 1` to EVERY friend
  segment, operational ones included (R5.5 — „the composer excludes opted-out people
  from operational segments too“). There is no admin override in the composer.
- **E-mail for opted-out (Decision D5):** for the three OPERATIONAL templates (`pickup`,
  `packeta`, `host`) an opted-out friend who has an e-mail gets a `channel='email'` row
  instead (the consent withdrawn is WhatsApp consent; the fact that their bag is at the
  pickup point is transactional information about their own order). For `closing`,
  `waitlist`-kind and `custom` templates an opted-out friend gets nothing. `OPEN:` PO to
  confirm D5; the alternative (nothing at all for opted-out) is one predicate change in
  UC-WA-006.
- **Count for the settings page:** `SELECT SUM(whatsapp_opt_in = 1), COUNT(*) FROM friends
  WHERE active = 1` → „41 z 43 priateľov“ (UC-WA-012).
- Guests (`guest_orders`) have NO opt-in column — Decision D6: a guest is messaged only
  about their OWN sub-order (`host`/`packeta` templates) — operational, legitimate
  interest; the guest checkout gains the sentence **„Na toto číslo vám pošleme správu,
  keď bude objednávka pripravená.“** under the phone field (module 06/20 surface — one
  string, seam noted for the orchestrator). Waitlist rows carry their own explicit
  `whatsapp_opt_in` from module 19's checkbox („Súhlasím so správou cez WhatsApp“).

**Acceptance criteria:** a friend created via approve reads back `whatsapp_opt_in = 0`;
a profile PATCH `{ whatsapp_opt_in: true }` flips it and `{ whatsapp_opt_in: 'yes' }`
400s; a friend with `whatsapp_opt_in = 0` and a handed-over pickup bag produces NO
`channel='whatsapp'` row and (with an e-mail) exactly one `channel='email'` row; the same
friend never appears in `not_ordered` or `all_active`.

---

## UC-WA-004 Templates in `settings` — keys, placeholders, seeded drafts (Admin)

**Goal:** editable Slovak templates with a closed placeholder vocabulary, three enabled
at start (R5.3 as amended by Q5.c).

**Storage:** one `settings` row per key, `key = 'wa_template:<tkey>'`, `value` = JSON
`{ "name": string, "body": string, "enabled": 0|1 }`. Read through ONE helper
`getTemplate(key)` / `listTemplates()` in `helpers/templates.js` (fail-closed and
fail-quiet like the admin Google allowlist reader: a hand-edited/invalid JSON row reads as
the seed default and logs one line — the settings page must never 500).

**Keys and seeded drafts (from `admin2.jsx` `A2.templates`, rewritten to the vy-form
„objednávka“ register; `{host}` and `{miesto}` appear only in nominative-safe positions —
no Slovak declension is attempted):**

| key | name | enabled at seed | body (seed) |
|---|---|---|---|
| `pickup` | Doručené na odberné miesto | **1** | `Ahoj {meno}, vaša káva z Podpultovky je na odbernom mieste {miesto}. Môžete si ju vyzdvihnúť. Suma na úhradu: {suma}. Ďakujeme!` |
| `packeta` | Odovzdané Packete | **1** | `Ahoj {meno}, váš balík z Podpultovky sme odovzdali Packete ({miesto}). Packeta vám pošle správu, keď bude pripravený na výdaj. Suma na úhradu: {suma}.` |
| `host` | Odovzdané priateľovi | **1** | `Ahoj {meno}, vaša objednávka z Podpultovky je pripravená — má ju pri sebe {host}. Prevzatie si dohodnite priamo. Suma na úhradu: {suma}.` |
| `closing` | Objednávky sa čoskoro zatvárajú | 0 | `Ahoj {meno}, objednávka kávy z Podpultovky sa zatvára {datum}. Ak chcete, ešte stihnete objednať: {odkaz}` |
| `waitlist` | Objednávka otvorená (čakajúci hostia) | 0 | `Ahoj {meno}, {host} vám otvoril objednávku kávy z Podpultovky. Objednávajte tu: {odkaz}` |
| `custom` | Vlastná správa | 1 | `` (empty — Decision D3: the `all_active` segment needs a template key; the admin writes the text in the composer) |

The prototype's `packeta` draft carried `Sledovanie: {tracking}`; it is REMOVED from the
seed because no tracking source exists (no Packeta API) — the admin may type `{tracking}`
back into the template and fill it per row (UC-WA-008 body edit). `{host}` in the
`waitlist` draft is the host's first name as the sentence subject (nominative) — the only
place the prototype's dative („Legovi“) is dropped.

**Placeholder vocabulary (closed):**

| placeholder | resolves to |
|---|---|
| `{meno}` | recipient's first name: first whitespace-token of `friends.name` / `guest_name` / `guest_waitlist.name`, trimmed |
| `{objednávka}` | `order_cycles.name` of the row's cycle (replaces R5.3's `{kolo}`) |
| `{miesto}` | pickup: `pickup_locations.name` + (`address` ? ` (address)` : ``); packeta: the party's `packeta_address`; else unresolved |
| `{suma}` | the party's amount to pay: friend `orders.total + orders.delivery_fee`, guest `guest_orders.total + delivery_fee` (module 20), formatted `31,10 €`; when the party is `paid = 1` ⇒ literal `už uhradené` (Decision D4) |
| `{odkaz}` | friend: `resolveLoginUrl()` root (production `https://podpultovka.biz`); guest: `${base}/g/o/${order_token}`; waitlist: the host's standing link `${base}/g/${guest_link_token}` (module 19) |
| `{host}` | the host friend's first name |
| `{datum}` | `order_cycles.closes_at` formatted `v piatok 12. 9.` (Slovak weekday + day. month.) — unresolved when NULL (module 17) |
| `{tracking}` | never auto-resolved (no source); stays literal for the per-row edit |

**Business rules:**

- **`PUT /api/notifications/templates/:key`** (`requireAdmin`): body `{ body?, enabled? }`.
  `body` ≤ 1000 chars, string only (unbindable ⇒ 400); every `{…}` token in it must be in
  the vocabulary ⇒ else **400 `unknown_placeholder`** with the offending token — a typo
  like `{menoo}` cannot reach a message. `enabled` strict boolean. Unknown `:key` ⇒ 404.
  Returns the template. **`GET /api/notifications/templates`** returns all six.
- **Rendering is ONE pure function** `renderTemplate(body, vars) → string`: replaces each
  known placeholder that has a non-empty value; a placeholder with NO value for that
  recipient is **left literal** (e.g. `{datum}` when `closes_at` is NULL, `{tracking}`
  always) so the admin SEES it in the preview and either edits the row or the template.
  Release refuses rows still containing a literal placeholder (UC-WA-008) — a message
  with `{datum}` in it can never leave.
- A **disabled** template makes its segments inert: the hand-over hook enqueues nothing
  for it (UC-WA-006 — the rows are simply not created, so enabling it later does not
  back-fill yesterday's hand-overs), and `POST /compose` answers **409 `template_disabled`**.
  The composer greys the segment with „Šablóna je vypnutá — zapnite ju v Nastaveniach“.
- Body text is stored per ROW at enqueue (`notifications.body`); editing a template
  afterwards changes only future rows. The composer's textarea edits the TEMPLATE (as in
  the prototype) and offers „Prepísať texty vo fronte (n)“ which re-renders the group's
  `queued` rows (never `released`/`sent` ones) — `POST /api/notifications/rerender`
  `{ cycle_id, segment_key }`.

**Acceptance criteria:** the seed matches the table byte-for-byte; `PUT` with
`{ body: 'Ahoj {menoo}' }` ⇒ 400 `unknown_placeholder: {menoo}`; `renderTemplate` on
the `pickup` seed with a paid friend yields `Suma na úhradu: už uhradené.`; with
`closes_at = NULL` the `closing` body keeps the literal `{datum}`; a disabled `closing`
makes `POST /compose` for `not_ordered:<cycle>` answer 409.

---

## UC-WA-005 `helpers/segments.js` — recipient lists (system)

**Goal:** ONE home for the SQL that says who a message goes to (R5.2), consumed by the
hand-over hook (UC-WA-006), the waitlist trigger (UC-WA-007) and the composer (UC-WA-008).

**Segment key grammar:** `<kind>[:<qualifier>…]`, ASCII, `:`-separated:

| segment_key | template | recipients (all rows already filtered as stated in the Rules) | built by |
|---|---|---|---|
| `handed_over:pickup:<location_id>:<YYYY-MM-DD>` | `pickup` | friend `orders` of the cycle with `handed_over_at` on that local date (Europe/Bratislava) whose `helpers/delivery.js` type is `pickup` with that target | hook |
| `handed_over:packeta:<YYYY-MM-DD>` | `packeta` | friend `orders` AND guest `guest_orders` (module 20 own-Packeta parties) handed over that date with type `packeta` | hook |
| `host_guests:<host_friend_id>:<YYYY-MM-DD>` | `host` | non-cancelled `via_host` sub-orders under that host whose `handed_over_at` was stamped that date (module 16 stamps them with the host) | hook |
| `not_ordered:<cycle_id>` | `closing` | active friends with NO `orders` row in the cycle that has ≥ 1 `order_items` row (an auto-saved empty order counts as not ordered) | composer (compose) |
| `waitlist:<cycle_id>` | `waitlist` | `guest_waitlist` rows with `notified_at IS NULL AND whatsapp_opt_in = 1`, host `active = 1` and host has a standing link | composer / UC-WA-007 |
| `all_active` | `custom` | every `friends.active = 1` (no cycle) | composer (compose) |

Each builder returns `{ key, name, template_key, recipients: [{ recipient_kind,
recipient_id, name, phone, phone_e164, email, opt_in, order_id, guest_order_id,
vars }] }` where `vars` are the resolved placeholder values of UC-WA-004 for that
recipient. `name` (the Slovak group title shown in the composer) follows the prototype:
`{location name} — odovzdané {d. m.}`, `Packeta — odovzdané {d. m.}`, `Hostia
{host first name} — odovzdané hostiteľovi`, `Neobjednali (otvorená objednávka)`,
`Čakajúci hostia`, `Všetci aktívni priatelia`.

**Business rules:**

- **Consent predicate** on every friend row: `f.active = 1 AND f.whatsapp_opt_in = 1`
  (UC-WA-003). Opted-out friends are returned in a SEPARATE `excluded_opt_out` count so
  the composer can show „3 bez súhlasu“ without listing names.
- **Number predicate:** recipients with `phone_e164 IS NULL` are RETURNED (not filtered)
  with `phone_e164: null` — the composer lists them under „bez platného čísla“ and the
  enqueue turns them into `skipped`/e-mail rows (UC-WA-006). The segment never guesses.
- **Guest aggregation discipline (CLAUDE.md):** the guest half of `handed_over:packeta`
  is a SEPARATE query merged in JS, never a second `LEFT JOIN` on `orders`; cycle-level
  counts use correlated subqueries. Cancelled sub-orders (`status = 'cancelled'`) are
  excluded everywhere.
- `helpers/delivery.js` (module 16) is the ONLY source of a party's type/target; this
  file never re-derives it from `packeta_address`/`pickup_location_id` itself.
- Hand-over date = `handed_over_at` converted to the Europe/Bratislava calendar date in
  JS (SQLite timestamps are UTC); groups roll over at local midnight, so „odovzdané
  dnes“ means today in Bratislava.
- Read-only module: no writes in `segments.js`.

**Acceptance criteria:** with two friends handed over at the same pickup point today and
one yesterday, `handed_over:pickup:<loc>:<today>` has 2 recipients and `…:<yesterday>`
1; a friend with an auto-saved empty order appears in `not_ordered`; an opted-out friend
appears in none and increments `excluded_opt_out`; a waitlist row with `notified_at` set
is absent; a cancelled `via_host` sub-order is absent from `host_guests`.

---

## UC-WA-006 Enqueue contract for the hand-over hook (system — called by module 16)

**Goal:** the function module 16 calls inside its hand-over transaction, and its inverse
for the un-hand-over case. Module 16 owns the endpoints and the `handed_over_at` write;
this module owns the rows that come out of it. **Nothing is sent here** (§11: „Hand-over
also enqueues notifications but never sends synchronously“).

**The seam (`helpers/outbox.js`):**

```js
enqueueForHandOver({ cycleId, orderIds = [], guestOrderIds = [], handedOverAt })
  → { queued, email, skipped, none, groups: [segment_key…] }
cancelForUnHandOver({ orderIds = [], guestOrderIds = [] })
  → { deleted }
```

Both are **synchronous** (better-sqlite3) and MUST be called by module 16 INSIDE the
same `db.transaction` that stamps/clears `handed_over_at`, after the UPDATEs — the stamp
and its rows are atomic, and `instances: 1` + no `await` keeps the check-then-insert
race closed (CLAUDE.md §Auth & boundaries).

**Template mapping per delivery type (`helpers/delivery.js`):**

| party | type | template | segment_key |
|---|---|---|---|
| friend order | `pickup` | `pickup` | `handed_over:pickup:<location_id>:<date>` |
| friend order | `packeta` | `packeta` | `handed_over:packeta:<date>` |
| friend order | `in_person` | **none** (resolved conflict 4) | — |
| host order handed over | each non-cancelled `via_host` sub-order of that host in the cycle | `host` (to the GUEST's own phone) | `host_guests:<host_friend_id>:<date>` |
| guest sub-order | `packeta` (module 20 own parcel) | `packeta` | `handed_over:packeta:<date>` |
| guest sub-order | `via_host` passed directly in `guestOrderIds` | `host` | `host_guests:<host>:<date>` (same group as via the host) |

`<date>` = `handedOverAt` as the Europe/Bratislava calendar date.

**Per recipient, in this order:**

1. Template disabled (`enabled = 0`) ⇒ **no row** (counted in `none`).
2. Friend with `whatsapp_opt_in = 0` (guests have no flag): e-mail present ⇒ row
   `channel='email'`, `status='queued'` (Decision D5); else no row (`none`).
3. `phone_e164` present ⇒ row `channel='whatsapp'`, `status='queued'`, `phone_e164`
   snapshot, `body = renderTemplate(template.body, vars)`.
4. `phone_e164` NULL and e-mail present ⇒ `channel='email'`, `queued` (R5.8 fallback,
   UC-WA-010).
5. Neither ⇒ row `channel='whatsapp'`, **`status='skipped'`, `error='no_phone'`** — the
   row exists so the composer can LIST the person as „bez platného čísla“ and the admin
   can reach them by hand (the wa.me tab cannot help without a number; the row is the
   to-do item).

**Idempotency:** the partial unique index (UC-WA-001) refuses a second `queued` row for
the same `(template_key, recipient_kind, recipient_id, cycle_id)`; the helper pre-checks
and, on the constraint anyway, counts it as already queued — never throws out of the
transaction. A party handed over, un-handed (mis-click), and handed over again therefore
holds ONE queued row. A party whose row was already `sent` and is handed over again
(after an un-hand-over) gets a NEW queued row — the admin sees it in the preview and may
delete it (UC-WA-008) before releasing.

**`cancelForUnHandOver`:** `DELETE FROM notifications WHERE status = 'queued' AND
template_key IN ('pickup','packeta','host') AND (order_id IN (…) OR guest_order_id IN
(…))` — only `queued` rows; `released`/`sent`/`failed`/`skipped` rows are history and
stay. When a HOST is un-handed, module 16 clears its guests too and passes their ids —
their `host` rows are deleted the same way.

**Dropped / Phase 2:** an `in_person` template („Vaša káva je zabalená, dohodneme
odovzdanie“) — not seeded, not mapped; adding it later is one mapping row + one seed.
The admin-only „Ukončiť kolo“ hint (§11 last row) belongs to module 16/17, not the outbox.

**Acceptance criteria (module 16's spec runs these against its own endpoints):** handing
over a packed pickup bag inserts exactly one `queued` `whatsapp` row with the friend's
`phone_e164` and a body containing the location name; handing over a HOST with two live
guests and one cancelled inserts two `host` rows to the GUESTS' numbers and none for the
cancelled one; an `in_person` bag inserts nothing; un-hand-over deletes the queued rows
and leaves a `sent` one; hand-over of a friend with `phone_e164 = NULL` and no e-mail
inserts a `skipped`/`no_phone` row; `transactions` count unmoved.

---

## UC-WA-007 Waitlist notification on round open (Admin — segment + template)

**Goal:** R9.3 — when the round opens, the guests who left a contact on a host's pre-open
page get „{host} vám otvoril objednávku kávy…“ with the host's standing link.

**Business rules:**

- **No automatic enqueue on cycle open.** Opening a cycle (module 17/admin) does NOT
  insert rows (resolved conflict 7 — no timer, no implicit action). The composer shows the
  computed segment `waitlist:<cycle_id>` with its count whenever a cycle is `open`; the
  admin presses „Pripraviť správy (n)“ (compose, UC-WA-008) → rows `queued` → reviews →
  „Poslať skupine (n)“. `OPEN:` PO may prefer auto-compose (not auto-release) on open so
  the group is pre-built; default: manual compose.
- The template `waitlist` is seeded `enabled = 0` (three-to-start decision); enabling it
  is one toggle on the settings page. While disabled, the segment is visible but greyed.
- **`{odkaz}`** = the host's standing link (`friends.guest_link_token`, module 19). A host
  with no standing link yet ⇒ the recipient is returned with `vars.odkaz` empty and the
  body keeps the literal `{odkaz}` ⇒ release refuses (UC-WA-008) until the admin creates
  the link (module 19's admin/host creation) and presses „Prepísať texty vo fronte“.
- **`notified_at` (Decision D8):** the RELEASE endpoint sets `guest_waitlist.notified_at =
  released_at` for every waitlist row it releases, in the same transaction. This is the
  one write this module makes to a module-19 table; it makes the segment shrink to zero
  after release, so a second compose finds nobody (idempotent from the admin's view). A
  failed send leaves `notified_at` set — the admin re-releases from the failed list
  (UC-WA-008 retry) rather than re-composing. Waitlist rows have no e-mail ⇒ a
  `phone_e164 = NULL` waitlist row is `skipped`/`no_phone` (module 19 can only store what
  the guest typed).
- Purge rules (order placed / two rounds passed) are module 19's.

**Acceptance criteria:** with an open cycle and two un-notified opted-in waitlist rows,
compose creates two `queued` rows whose bodies contain the host's first name and
`/g/<guest_link_token>`; release stamps both `notified_at`; the segment then counts 0; a
waitlist row with `whatsapp_opt_in = 0` is never composed.

---

## UC-WA-008 Outbox API — compose, release, retry, per-row edits (Admin)

**Goal:** the admin's write surface over the outbox and the only place the `queued →
released` transition happens. New router `backend/src/routes/notifications.js`, mounted
**`app.use('/api/notifications', requireAdmin, notificationsRouter)`** — wholly admin
(NOT a mixed router). Every route below joins `ADMIN_ENDPOINTS` (UC-WA-014).

| Route | Body | Behaviour |
|---|---|---|
| `GET /api/notifications/segments?cycle_id=` | — | `{ groups: [...], computed: [...] }` — `groups` = distinct `segment_key` among rows of the cycle (plus `all_active` rows) with counts per status `{ queued, released, sent, failed, skipped }`, template key and name; `computed` = the not-yet-composed segments (`not_ordered`, `waitlist`, `all_active`) with `count`, `excluded_opt_out`, `no_phone`, `template_enabled` |
| `GET /api/notifications?cycle_id=&segment_key=` | — | the rows of one group: `{ id, recipient_kind, recipient_id, name, phone, phone_e164, channel, status, sent_via, body, error, released_at, sent_at }` — ⚠ never `order_token` in the payload beyond what is already inside `body` for guest rows (the body is the message; it is shown only to the admin) |
| `POST /api/notifications/compose` | `{ cycle_id, segment_key }` | builds the computed segment and inserts rows per UC-WA-006's per-recipient rules; 404 unknown cycle/segment; **409 `template_disabled`**; 409 `cycle_not_open` for `not_ordered`/`waitlist` when the cycle is not `open`; idempotent via the partial index (already-queued recipients counted, not duplicated); returns the counts |
| `POST /api/notifications/release` | `{ cycle_id, segment_key }` | **the one transition to `released`** — see Rules |
| `POST /api/notifications/retry` | `{ cycle_id, segment_key }` | `failed → released` for the group (`released_at` refreshed, `error` kept until overwritten); 200 `{ released: n }`, 0 is fine |
| `POST /api/notifications/rerender` | `{ cycle_id, segment_key }` | re-renders `queued` rows' `body` from the current template (UC-WA-004) |
| `PATCH /api/notifications/:id/body` | `{ body }` | edits ONE `queued` row's body (≤ 1000 chars, string only); **409 `not_queued`** otherwise |
| `PATCH /api/notifications/:id/manual-sent` | `{ sent: true }` | the wa.me tick: `queued` or `released` ⇒ `sent`, `sent_at = now`, `sent_via = 'wa_me'`. On a `released` row it is allowed ONLY while the WA health is not `connected` (UC-WA-012 proxy, 2 s timeout, unreachable counts as not connected) — **409 `bot_active`** otherwise (a duplicate-send guard); `skipped`/`failed`/`sent` ⇒ 409 `not_pending` |
| `DELETE /api/notifications/:id` | — | removes a `queued` or `skipped` row (the admin decides not to message someone); 409 `not_queued` for `released`/`sent`/`failed` |
| `GET /api/notifications/templates`, `PUT /api/notifications/templates/:key` | UC-WA-004 | |

**Release rules (`POST /release`):**

- Selects `status = 'queued'` rows of `(cycle_id, segment_key)` (for `all_active`,
  `cycle_id IS NULL`). **None ⇒ 200 `{ released: 0 }`** — idempotent, a double-click is
  harmless (the „one Poslať per group“ of Q5.d).
- **All-or-nothing:** if ANY selected row's body still matches `/\{[^{}\s]{1,40}\}/`
  ⇒ **409 `unresolved_placeholders`** with `{ ids: [...] }` and nothing is released — the
  composer highlights those rows („Doplňte {datum}“). This is what makes a literal
  `{tracking}`/`{datum}` unsendable.
- Inside ONE transaction: `UPDATE notifications SET status = 'released', released_at =
  CURRENT_TIMESTAMP WHERE id IN (…) AND status = 'queued'`; for `recipient_kind =
  'waitlist'` rows also `UPDATE guest_waitlist SET notified_at = … WHERE id = ?`
  (UC-WA-007). Returns `{ released, whatsapp, email }`.
- **After commit**, `channel='email'` rows are handed to the mailer fire-and-forget
  (UC-WA-010). WhatsApp rows are now the WA process's to drain — the API does not touch
  them again except via `retry`/`manual-sent`.
- No cycle-status gate (hand-over groups are released while the cycle is `locked`; that
  is the whole point). No `whatsapp_paused` gate — a paused bot simply leaves rows
  `released`; the composer shows the pause banner (UC-WA-009).

**Common rules:** unbindable bodies (`{}`, `true`, `[1]`, `'abc'`) ⇒ 400 never 500;
`cycle_id`/`segment_key` validated (`segment_key` against the UC-WA-005 grammar,
`/^[a-z_]+(:[A-Za-z0-9-]+)*$/`, ≤ 80 chars); literal column names in every UPDATE, never a
spread body; every response reads the rows back (no optimistic echo).

**Acceptance criteria:** compose → release moves every row of the group to `released`
with `released_at` set and touches no other group; a second release answers `released:
0`; a group with one `{datum}` row 409s and NO row changes; `manual-sent` on a `queued`
row yields `sent`/`wa_me` and on a `released` row with the stub sender `connected` 409s
`bot_active`; `DELETE` of a `released` row 409s; anonymous and friend-Bearer calls 401 on
every route.

---

## UC-WA-009 Admin composer page `/admin/whatsapp` (Admin)

**Goal:** the `a-wa` screen — „Správa sa nikdy neodošle sama. Skupinu vyberiete, text
skontrolujete, odošlete jedným tlačidlom.“ Admin shadcn skin; view `AdminWhatsApp.vue`;
route `/admin/whatsapp` (query `?cycle=<id>`); linked from the admin dashboard and from
module 16's board button „Správy (n vo fronte)“ / per-group „Správa skupine“ (16 owns the
buttons, they deep-link here with `?cycle=&segment=`).

**Layout (prototype `AWa`):**

- **Header:** title „Správy skupinám“, the sub-line above, a cycle selector (default: the
  cycle from the query, else the newest `locked`, else the newest `open`), and the tab
  pair **„Cez bota (Podpultovka)“ | „Ručne z môjho čísla (wa.me)“** (default „Cez bota“ —
  `OPEN:` per resolved conflict 2). A pause/offline banner when the health proxy reports
  `state ≠ connected` or `whatsapp_paused = 1`: „Bot je odpojený — správy zostanú vo fronte.
  Môžete ich poslať ručne v záložke wa.me.“
- **Komu (left card):** one row per group from `GET /segments` — name + count badge
  (`queued + released + failed`), status chips (`n odoslané`, `n chyby`, `n bez čísla`);
  then the computed segments with „Pripraviť správy (n)“ (disabled + hint when
  `template_enabled = false`, or when `n = 0`). Help text: „Skupiny vznikajú samy: z
  odovzdania balíčkov (Distribúcia), z otvorenej objednávky a z čakajúcich hostí.“
- **Šablóna (middle card):** „Šablóna · {name}“, the placeholder chips of the vocabulary
  (click inserts at the caret), a textarea bound to the TEMPLATE body (saves via `PUT
  /templates/:key` on blur with the 400 `unknown_placeholder` rendered inline), and the
  „Prepísať texty vo fronte (n)“ button (`/rerender`) shown when the group has queued rows.
- **Náhľad (right card):** „Náhľad · n príjemcov“; per recipient: name, phone (mono),
  the rendered body (editable inline for `queued` rows → `PATCH /:id/body`), a status
  badge — `Vo fronte` (queued), `Uvoľnené` (released), `Odoslané` (sent; `wa.me` /
  `e-mail` suffix per `sent_via`/`channel`), `Chyba` (failed, tooltip = `error`),
  `Bez platného čísla` (skipped/no_phone — these rows render greyed at the bottom); a
  per-row „×“ (DELETE) on queued/skipped rows. Rows still containing a literal `{…}`
  render with a warning outline.
- **Primary action (bot tab):** **„Poslať skupine (n)“** where n = queued count → `POST
  /release` → on 409 `unresolved_placeholders` scroll to the first flagged row; success
  toast „n správ uvoľnených — bot ich odošle s odstupom 3–10 s“. „Skúsiť znova (n)“ for
  failed rows → `/retry`. Footer help: „Bot posiela s odstupom 3–10 s, max. 30 správ/hod.
  Pri chybe prihlásenia sa zastaví a ukáže to tu.“
- **wa.me tab:** no bulk button. Each row renders **„Otvoriť chat“** whose href is
  composed **in JS at click time** as
  `https://wa.me/<E.164 digits without '+'>?text=<encodeURIComponent(body)>`, opened in
  a new tab (`rel="noopener noreferrer"`), immediately followed by `PATCH
  /:id/manual-sent` → the button becomes „Otvorené ✓“ (persisted on the row — stop and
  resume across devices, R5.1). Rows in `released` state show the button only while the
  bot is not connected (the 409 `bot_active` is rendered as „Bot je pripojený — správu
  pošle bot“ and the row stays). Sub-line: „Každý riadok otvorí chat s predvyplneným
  textom vo vašom WhatsAppe.“ ⚠ Neither the wa.me URL nor the body is ever rendered into
  a DOM attribute at render time (the body may carry a guest `order_token` inside
  `{odkaz}` — CLAUDE.md „compose the URL in JS at click time“).
- **Conventions:** per-row pending state keyed by id; a `loadSeq` guard on the group
  loader (switching groups fast must not paint a stale list); refused changes snap back;
  `min-w-0` + `overflow-wrap: anywhere` on the body column; `maxlength=1000` mirrors the
  server bound.

**Acceptance criteria (UI):** picking a hand-over group renders its rows with `Vo fronte`
badges; „Poslať skupine (2)“ flips both to `Uvoľnené` and (with the stub sender running)
to `Odoslané` within the poll interval; the wa.me tab's „Otvoriť chat“ marks the row
`Otvorené ✓` and the DOM has no `href` containing `wa.me` before the click; a row with a
literal `{datum}` blocks release with the inline message.

---

## UC-WA-010 E-mail fallback `channel='email'` through the existing mailer (system)

**Goal:** R5.8 — a recipient with no valid number (or an opted-out friend on an
operational template, D5) still learns that their bag has left, by e-mail, through
module 08's seam. ⚠ This is the ONE place the API process sends a notification itself,
because the mailer lives in the API (01-architecture §Shared services); the „API never
sends“ rule is a WhatsApp rule.

**Business rules:**

- Rows are created `channel='email'` by UC-WA-006/008 with `email` snapshot (friend
  `friends.email`, guest `guest_email`; waitlist rows never — no e-mail column).
- On release (after the transaction commits — the `routes/magic-link.js` fire-and-forget
  precedent), for each released e-mail row: `renderEmail({ text: body, blocks: [{ type:
  'paragraph', text: body }] })` → `sendMail({ to: row.email, subject, text, html })`
  where subject = the template `name` prefixed „Podpultovka · “ (e.g. „Podpultovka ·
  Doručené na odberné miesto“). The `.then` writes `status = 'sent', sent_at = now,
  sent_via = 'email'` on `{ sent: true }`, else `status = 'failed', error = <result
  code>` (`no_recipient` / `not_configured` / `invalid_recipient` / `timeout` / `network` /
  `HTTP <n>` — the mailer's fixed vocabulary). The whole render+send sits in try/catch
  (a `renderEmail` throw ⇒ `failed`/`render`), never an unhandled rejection.
- The three mailer rules hold verbatim: with no Mailgun env the result is
  `not_configured` ⇒ the row is `failed`/`not_configured` — visible in the composer as
  „Chyba: e-mail nie je nakonfigurovaný“, never a silent success. The key never appears
  in `error`.
- The `.then` write is a plain conditional UPDATE `WHERE id = ? AND status = 'released'`
  — the manual tick may have moved the row meanwhile; whoever writes second affects 0
  rows and logs one line (`[outbox] email result for already-final row id=…`).
- No HTML beyond module 08's shell; the body is one paragraph. No link tracking (08's
  per-message flags).

**Acceptance criteria (mail harness, `withMailHarness`):** releasing a group with one
e-mail row produces exactly ONE stub request whose `text` field equals the row's `body`
and the row reads back `sent`/`email`; with the stub answering 500 the row reads back
`failed`/`HTTP 500`; a group with no e-mail rows produces ZERO requests; with no Mailgun
env the row becomes `failed`/`not_configured` and the composer renders the error.

---

## UC-WA-011 The `gorifi-wa` process — whatsapp-web.js sender (system)

**Goal:** the only component that talks to WhatsApp. Directory **`wa/`** at the repo root
with its OWN `package.json` (`whatsapp-web.js`, `puppeteer` peer, `better-sqlite3`,
`qrcode`); **`backend/` never imports any of them** (`grep -rn "whatsapp-web" backend/`
must be empty). ESM, plain JavaScript, no TypeScript, no test runner.

**Configuration (env, read at boot; one boot line per resolved value, secrets none):**

| var | default | meaning |
|---|---|---|
| `DB_PATH` | **required** (absolute) | the SAME SQLite file the API opens (`backend/src/db/database.sqlite`); the process refuses to start without it (exit 1, log `[wa] DB_PATH is required`) — a relative default would silently open a second, empty DB |
| `WA_SENDER` | `whatsapp` | `whatsapp` \| `stub` (below) |
| `WA_SESSION_DIR` | `<cwd>/../wa-session` | `LocalAuth({ dataPath })` — `/var/www/gorifi{,-staging}/wa-session`, OUTSIDE the rsynced tree |
| `WA_HEALTH_PORT` | `3010` | health server, bound to **127.0.0.1 only** |
| `WA_POLL_MS` | `5000` | outbox poll interval |
| `WA_PACE_MIN_MS` / `WA_PACE_MAX_MS` | `3000` / `10000` | random gap between two sends |
| `WA_HOURLY_MAX` | `30` | rolling-hour cap |
| `WA_STUB_FAIL_NUMBER` | `+421900000000` | stub only: rows to this number `fail` deterministically |
| `PUPPETEER_CACHE_DIR` | — | set in `.env` to `/var/www/gorifi/.cache/puppeteer` so Chromium survives `--delete` rsyncs |

**Lifecycle / state (`state` in health):** `starting` → (`qr` while unpaired) →
`connected` → `disconnected` (network; auto-reconnect with backoff 5 s · 10 s · 20 s … ≤ 5
min) | `auth_failure` (logged out / session invalid ⇒ **stop the sender**, keep the health
server up, emit `qr` when the client offers one so the admin can re-pair) | `paused`
(`settings.whatsapp_paused = '1'`, re-read every poll; the process READS `settings`, never
writes it). Puppeteer args `--no-sandbox --disable-dev-shm-usage`. The client emits
`ready` ⇒ `connected`, `number = client.info.wid.user` as E.164.

**Send loop (only while `connected` and not `paused`):**

1. Every `WA_POLL_MS`: `SELECT id, phone_e164, body FROM notifications WHERE status =
   'released' AND channel = 'whatsapp' ORDER BY released_at, id LIMIT 1`.
2. **Pacing:** before each send wait `random(WA_PACE_MIN_MS, WA_PACE_MAX_MS)`; keep an
   in-memory ring of send timestamps seeded at boot from `SELECT sent_at FROM
   notifications WHERE sent_via = 'bot' AND sent_at > datetime('now','-1 hour')`; if the
   last hour holds ≥ `WA_HOURLY_MAX` sends, sleep until the oldest expires (health shows
   `hourly_sent` and `next_send_at`).
3. Resolve the chat id: `phone_e164` without `+` + `@c.us`; `client.getNumberId()` ⇒
   null means the number is not on WhatsApp ⇒ `failed`, `error = 'not_on_whatsapp'`.
4. `client.sendMessage(chatId, body)` ⇒ `UPDATE notifications SET status = 'sent', sent_at
   = CURRENT_TIMESTAMP, sent_via = 'bot' WHERE id = ? AND status = 'released'` — the
   conditional WHERE is the duplicate guard against the manual tick (UC-WA-008); 0 rows
   affected ⇒ log `[wa] row id=… was finalised elsewhere — possible duplicate`.
5. Any other error ⇒ `status = 'failed'`, `error = <name>: <message ≤ 300 chars>`; the
   loop continues with the next row. An `auth_failure`/`LOGOUT` disconnect ⇒ stop
   (state above); rows stay `released` — the admin sees the count on the settings page
   and can switch to the wa.me tab.
6. ⚠ **Writes:** only `notifications.status / sent_at / sent_via / error`, one short
   transaction per row (WAL; `busy_timeout = 5000`). Never `body`, never other tables.

**`GET /health` (127.0.0.1:`WA_HEALTH_PORT`, JSON, no auth — loopback only):**
`{ state, sender, number, qr (data:image/png;base64 — ONLY while state = 'qr'; the
`qrcode` package renders it; refreshed on every `qr` event ≈ 20 s), queue: { released,
sent_today, failed }, hourly_sent, next_send_at, last_sent_at, last_error, db_path,
uptime_s, version }`. Anything else ⇒ 404. No `POST` routes in v1 (Decision D7).

**Log lines (`[wa]` prefix, PII-free — ids, never bodies or numbers beyond the bot's
own):** `[wa] boot sender=whatsapp db=/var/www/gorifi/backend/src/db/database.sqlite
session=/var/www/gorifi/wa-session health=127.0.0.1:3010`, `[wa] state=qr (scan in
Nastavenia → WhatsApp)`, `[wa] state=connected number=+421…`, `[wa] sent id=123`,
`[wa] failed id=124 error=not_on_whatsapp`, `[wa] paused (settings.whatsapp_paused)`,
`[wa] auth_failure — sender stopped; re-pair via Nastavenia → WhatsApp`,
`[wa] hourly cap reached (30) — next send at 14:52`.

**`WA_SENDER=stub` (01-architecture §Testing & gate):** no `whatsapp-web.js`/puppeteer
import at all (dynamic `import()` only in the `whatsapp` branch — the stub must run on the
4 GB e2e box without Chromium); `state = 'connected'`, `number = '+421000000000'`; the
same poll loop with the same conditional UPDATEs; pacing honours the env (the e2e harness
sets `WA_PACE_MIN_MS=0 WA_PACE_MAX_MS=0 WA_POLL_MS=200`); a row whose `phone_e164 ===
WA_STUB_FAIL_NUMBER` ⇒ `failed`/`stub_fail`. Staging runs the stub unless the operator
deliberately pairs (UC-WA-013).

**Acceptance criteria (stub, e2e; the real sender is verified manually — UC-WA-014):**
a `released` row flips to `sent`/`bot` within 1 s; a `queued` row is never touched; a row
to `WA_STUB_FAIL_NUMBER` becomes `failed`/`stub_fail`; setting `whatsapp_paused = '1'`
leaves a released row `released` and health says `paused`; `GET /health` answers the
shape above; `body` and `phone_e164` are byte-unchanged after the send.

---

## UC-WA-012 WhatsApp settings page — health proxy, QR pairing, pacing, opt-in count, test message (Admin)

**Goal:** the `a-wa-settings` screen (`AdminWhatsAppSettings.vue`, route
`/admin/whatsapp/settings`, linked from `AdminSettings.vue` „WhatsApp bot →“ and from the
composer). Admin shadcn skin.

**API (in `routes/admin.js`, `requireAdmin`, all into `ADMIN_ENDPOINTS`):**

- `GET /api/admin/whatsapp/health` → proxies `http://127.0.0.1:${WA_HEALTH_PORT}/health`
  (API env `WA_HEALTH_URL`, default `http://127.0.0.1:3010`; staging `:3011`) with a
  **2 s `AbortSignal.timeout`**; on any failure answers 200 `{ reachable: false }`; on
  success `{ reachable: true, ...health, opt_in: { on, total }, paused }` (opt-in count
  from UC-WA-003; `paused` from settings). Never throws into the handler; never logs the
  QR.
- `PUT /api/admin/settings` grows `whatsappPaused` (strict boolean → `'0'|'1'`) and
  `whatsappTestPhone` (string ≤ 32, stored as entered, normalised at use); `GET` returns
  both. The `bindValue` guard pattern of FUP-T13 applies.
- `POST /api/admin/whatsapp/test` → `toE164(whatsapp_test_phone)`; NULL ⇒ 400
  `invalid_test_phone`; else INSERT ONE row `template_key = 'test'`, `recipient_kind =
  'admin'`, `recipient_id = NULL`, `segment_key = 'test'`, `cycle_id = NULL`, `channel =
  'whatsapp'`, **`status = 'released'`** directly (this IS the explicit admin action),
  `body = 'Testovacia správa z Podpultovky · <d. m. yyyy HH:mm>'`; returns the row. Rate:
  the admin is one person; still refuse a second test while one is `released` (409
  `test_pending`).

**Page (prototype `AWaSettings`):**

- **Stav card:** badge `Pripojené` (connected) / `Odpojené` (any other state; the state
  word in Slovak beneath: `spúšťa sa`, `čaká na spárovanie`, `odpojené`, `chyba
  prihlásenia`, `pozastavené`, `proces nebeží` for `reachable: false`); rows „Číslo bota“
  (mono), „Zariadenie: WhatsApp Web · server“, „Posledná správa“ (`last_sent_at`), „Vo
  fronte / odoslané / chyby“ (`queue.released / queue.sent_today / queue.failed`), „Posledná
  chyba“ when present. Buttons: **„Pozastaviť odosielanie“ / „Obnoviť odosielanie“**
  (toggles `whatsappPaused`) and **„Poslať testovaciu správu“** (+ the test phone input,
  `maxlength=32`, pre-filled from settings; the button is disabled until a number is
  saved). The prototype's „Odpojiť/Pripojiť“ is Phase 2 (Decision D7).
- **Spárovať telefón card** — only while `state = 'qr'`: „Na telefóne s číslom bota:
  WhatsApp → Prepojené zariadenia → Prepojiť zariadenie → naskenujte.“, the `qr` data URL
  as `<img>` (CSP `img-src 'self' data:` already allows it — no CSP change), „QR sa
  obnoví o ~20 s“. The page polls health every **5 s** while open (the `loadSeq` rule; stop
  on unmount). ⚠ The QR is a pairing credential: never logged, never cached, never
  rendered anywhere else.
- **Tempo odosielania card:** „Odstup medzi správami 3–10 s“, „Max. za hodinu 30“ (from
  health `pace`/`hourly_max` when reported, else the documented defaults), „Súhlas
  (opt-in) {on} z {total} priateľov“, help „Správy sa odosielajú len ľuďom so zapnutým
  súhlasom v profile. Bez platného čísla sa riadok preskočí a označí.“
- **Šablóny card:** the six templates: name, `Zapnuté` / `Neskôr` badge (toggle →
  `PUT /templates/:key { enabled }`), body preview, „Upraviť“ (inline textarea → `PUT`,
  400 `unknown_placeholder` inline). Sub-header „3 na štart · 2 pripravené · 1 vlastná“
  computed from `enabled`.
- **Runbook fold („Pre správcu servera“):** re-pair = `pm2 stop gorifi-wa`, delete
  `wa-session/`, `pm2 restart …ecosystem.config.cjs --only gorifi-wa`, scan; a library
  bump after a WhatsApp Web change = `npm update whatsapp-web.js` in `wa/` + deploy
  (Q5.b accepted).

**Acceptance criteria:** with the stub running the card shows `Pripojené`, number
`+421 000 000 000`, and the counts move after a release; with no process the card shows
`proces nebeží` and the composer's offline banner appears; toggling pause writes
`whatsapp_paused` and the stub stops draining; the test button with `'0905 123 456'`
inserts one `released` `admin` row the stub flips to `sent`; with `'abc'` it 400s;
`GET /api/admin/whatsapp/health` anonymously ⇒ 401.

---

## UC-WA-013 Deploy — ecosystem entries, `deploy.sh wa`, `.env` keys, server sizing (Operator/Admin)

**Goal:** the process runs on the server the same way the API does — from the ecosystem
file, as the `gorifi` user, restarted FROM THE FILE.

**`deploy/ecosystem.config.cjs` — two new apps:**

```js
{ name: 'gorifi-wa', script: 'src/index.js', cwd: '/var/www/gorifi/wa',
  node_args: '--env-file-if-exists=/var/www/gorifi/.env',
  instances: 1, exec_mode: 'fork', autorestart: true, restart_delay: 10000,
  max_memory_restart: '1200M', watch: false,
  env: { NODE_ENV: 'production', WA_HEALTH_PORT: 3010 },
  error_file: '/var/log/gorifi/wa-error.log', out_file: '/var/log/gorifi/wa-out.log',
  log_date_format: 'YYYY-MM-DD HH:mm:ss Z' },
{ name: 'gorifi-wa-staging', … cwd: '/var/www/gorifi-staging/wa',
  node_args: '--env-file-if-exists=/var/www/gorifi-staging/.env',
  env: { NODE_ENV: 'production', WA_HEALTH_PORT: 3011 }, logs under /var/log/gorifi-staging/ }
```

`instances: 1` is load-bearing (one WhatsApp session, one sender). The file's header
comment gains the new `.env` keys (below) in the same style as the Mailgun block.

**`.env` keys (both servers; mode 600, owner `gorifi`; read at boot — edit + restart):**
`DB_PATH=/var/www/gorifi/backend/src/db/database.sqlite` (⚠ now REQUIRED — the API
defaults to the same relative file, but the WA process refuses to guess; set it
explicitly in BOTH `.env`s so the two processes provably open one file),
`WA_SENDER=whatsapp` (prod) / `WA_SENDER=stub` (staging default — Decision D9),
`WA_SESSION_DIR=/var/www/gorifi/wa-session`, `WA_HEALTH_URL=http://127.0.0.1:3010`
(API side; `:3011` on staging), `PUPPETEER_CACHE_DIR=/var/www/gorifi/.cache/puppeteer`.
Pacing vars only if the defaults must change.

**`deploy/deploy.sh`:** new component **`wa`** (and `full` includes it): `mkdir -p
$REMOTE_PATH/wa $REMOTE_PATH/wa-session $REMOTE_PATH/.cache`, rsync `wa/` with
`--delete --exclude node_modules --exclude '*.sqlite*'` (the session dir and the
Puppeteer cache live OUTSIDE `wa/`, so `--delete` cannot touch them — the `src/db/uploads`
lesson), chown, then `npm ci --omit=dev` as `gorifi` (downloads Chromium into
`PUPPETEER_CACHE_DIR` on first run — ~400 MB, several minutes; the script prints a
notice), then `pm2 restart $REMOTE_PATH/ecosystem.config.cjs --only $WA_APP || pm2 start
…` and `pm2 save` (restart FROM THE FILE, per the script's standing comment). Usage text
gains `wa`; the final „Verify with“ line adds `curl -s http://localhost:3010/health`.
The `backend` component is unchanged except that the ecosystem file it copies now carries
the WA apps.

**Server (LXC) checklist — §12 table, PO confirmed resources are not a constraint:**
RAM **8 GB** (from 4), **4 vCPU** (from 2), **+2 GB disk**, **1–2 GB swap**, **`/dev/shm ≥
256 MB`** inside the container (Puppeteer's `--disable-dev-shm-usage` is set anyway),
Chromium's Debian runtime libraries (`libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0
libgbm1 libasound2 fonts-liberation` et al. — the Puppeteer troubleshooting list),
`ulimit -n ≥ 4096` for the `gorifi` user. Verify: `pm2 status` shows `gorifi-wa` online,
`free -m`, `df -h`, `curl -s localhost:3010/health | jq .state`. Written to
`docs/deploy/whatsapp-process.md` (new) alongside the NPM doc; no nginx change (the
health port is loopback-only and reached through the API proxy).

**Backups (SEC-D2):** `wa-session/` is NOT backed up (it is a device credential — losing
it means re-pairing, which is the safer failure); `notifications` rows ride in the
existing DB backup.

**Acceptance criteria (manual, staging first — the sandbox cannot deploy):**
`./deploy/deploy.sh staging wa` ends with `gorifi-wa-staging` online in stub mode and
`/admin/whatsapp/settings` on staging showing `Pripojené · +421 000 000 000`; on
production the first boot logs `state=qr`, the settings page shows the QR, one scan from
the bot phone yields `state=connected` with the bot's number, and the test message
arrives on the admin's phone.

---

## UC-WA-014 Verification — e2e obligations (system)

**Goal:** what the suite pins (no unit runner; Playwright in `e2e/`, `--workers=1`).

**1. `api-security.spec.js` — `ADMIN_ENDPOINTS` +=**
`GET /api/notifications/segments?cycle_id=1`, `GET /api/notifications?cycle_id=1&segment_key=all_active`,
`POST /api/notifications/compose` `{cycle_id:1, segment_key:'not_ordered:1'}`,
`POST /api/notifications/release` `{…}`, `POST /api/notifications/retry` `{…}`,
`POST /api/notifications/rerender` `{…}`, `PATCH /api/notifications/1/body` `{body:'x'}`,
`PATCH /api/notifications/1/manual-sent` `{sent:true}`, `DELETE /api/notifications/1`,
`GET /api/notifications/templates`, `PUT /api/notifications/templates/pickup` `{enabled:true}`,
`GET /api/admin/whatsapp/health`, `POST /api/admin/whatsapp/test`.
The `gorifi-wa` health port is not an app route and does not join the list (loopback only).
No new PUBLIC route exists in this module ⇒ nothing joins the zero-external-requests sweep.

**2. New `e2e/tests/whatsapp-outbox.spec.js` (API; fixtures per test):**
- E.164: the three input shapes ⇒ `+421905123456`; garbage ⇒ NULL; approve/onboarding/
  profile/guest-checkout writers each read back `phone_e164`.
- Opt-in: approve ⇒ `0`; profile PATCH boolean/400 cases; opted-out excluded from
  `not_ordered`; D5 e-mail row for an operational template.
- Templates: seed byte-equality; `unknown_placeholder` 400; disabled ⇒ compose 409.
- Enqueue via module 16's hand-over endpoints: pickup ⇒ 1 whatsapp row; host with guests
  ⇒ rows to the guests; `in_person` ⇒ none; un-hand-over deletes queued only; `no_phone`
  ⇒ `skipped`; partial-index idempotency; ⚠ `transactions` count unmoved before/after
  (the GSO-T6 pin).
- Release: transitions read back; idempotent 0; `unresolved_placeholders` all-or-nothing;
  waitlist `notified_at` stamped; `manual-sent` on queued; `DELETE` refusals (409s read the
  row back unchanged — the refusal-test rule).
- Mail describe (`withMailHarness`, self-skipping): UC-WA-010's four cases.

**3. New `e2e/wa-harness.js` + describe „stub sender“ in the same spec:** `withWaStub({
dbPath })` spawns `node wa/src/index.js` with `WA_SENDER=stub WA_POLL_MS=200
WA_PACE_MIN_MS=0 WA_PACE_MAX_MS=0 WA_HEALTH_PORT=<free port> DB_PATH=<the gate DB>`
(self-skips unless `DB_PATH` and `CAN_SPAWN_BACKEND` are set — the mail-harness
convention), waits for `/health` `state=connected`, runs: released ⇒ sent/`bot` ≤ 1 s;
queued untouched; `WA_STUB_FAIL_NUMBER` ⇒ failed; pause honoured; `manual-sent` on a
released row ⇒ 409 `bot_active` while the stub is up; `body`/`phone_e164` unchanged.
The e2e recipe (`e2e/README.md`) documents starting the API with `WA_HEALTH_URL` pointing
at the harness port.

**4. New `e2e/tests/whatsapp-composer.spec.js` (UI, admin token adopted from the
browser):** group list + badges; „Poslať skupine (n)“ → `Uvoľnené`; wa.me tab: no
`wa.me` in any `href` before click, „Otvorené ✓“ after; `{datum}` row blocks release with
the inline text; settings page: `Pripojené` with stub / `proces nebeží` without;
template toggle + edit; test-message button 400 on `'abc'`.

**5. Untouched:** `guest-payment-modal.spec.js` (no payload change), `self-hosted-fonts.spec.js`
CSP copies (no CSP change — `img-src data:` already present), every module 02–20 spec.

**6. The real sender is NOT exercised by the suite** (no Chromium-in-Chromium, no real
number — 01-architecture §Testing & gate); UC-WA-013's manual staging → production
procedure is the acceptance for whatsapp-web.js itself.

---

## Decisions (module-level, recorded)

- **D1** One module, both tabs; bot tab default, wa.me fallback (resolved conflict 2).
  `OPEN:` PO confirms the default tab.
- **D2** Three templates enabled at seed (`pickup`, `packeta`, `host`); `closing`,
  `waitlist` seeded off; `custom` on but empty.
- **D3** A sixth template key `custom` („Vlastná správa“) exists so the `all_active`
  segment (R5.2 „newsletter / new features“) has a body to send.
- **D4** `{suma}` = the party's own `total + delivery_fee`; `už uhradené` when paid.
  `OPEN:` PO may prefer the friend's outstanding LEDGER balance instead — one
  substitution in `segments.js`.
- **D5** Opted-out friends get an e-mail row for the three operational templates when
  they have an e-mail; nothing for `closing`/`custom`. `OPEN:` PO to confirm.
- **D6** Guests have no opt-in flag; operational messages about their own sub-order only;
  one consent sentence on the guest checkout (module 06/20 surface).
- **D7** No `POST` control routes on the WA process in v1: pause is a `settings` flag the
  process reads; re-pairing is an operator runbook; „Odpojiť“ is Phase 2.
- **D8** `guest_waitlist.notified_at` is stamped at RELEASE by the API (the process may
  not write module-19 tables).
- **D9** Staging runs `WA_SENDER=stub` by default; only production pairs the real number.
- **D10** `{tracking}` is never auto-resolved and is removed from the `packeta` seed;
  unresolved placeholders are left literal and block release.
- **D11** Normalisation never refuses a phone write; invalid numbers surface as
  „bez platného čísla“ + `skipped` rows.
- **D12** Schema additions beyond 01-architecture's list: `notifications.email`,
  `notifications.sent_via`, `recipient_kind 'admin'`, `guest_orders.phone_e164`, the partial
  unique index — orchestrator to mirror in 01-architecture §Roadmap additions.

## Supersedes / amends (for CLAUDE.md and sibling specs when this lands)

- CLAUDE.md „Auth & boundaries“: add the WA process as the ONLY second writer to the DB
  (writes `notifications.status/sent_at/sent_via/error` only) and `wa/` as the only home
  of `whatsapp-web.js`; „Rate limits“ unchanged (no new public route); „Money & data“: a
  `notifications` row is never a financial event.
- CLAUDE.md „Dev & deploy“: `deploy.sh … wa`; `DB_PATH` required in both `.env`s;
  restart both `gorifi-backend` and `gorifi-wa` after a schema change (the WA process
  opens the same file; a new column it reads needs the API's migration to have run first
  — start order: backend, then wa).
- 01-architecture §Roadmap additions: mirror D12.
- Module 16: must call `enqueueForHandOver` / `cancelForUnHandOver` INSIDE its hand-over
  transaction (UC-WA-006) and deep-link „Správa skupine“ to
  `/admin/whatsapp?cycle=&segment=`.
- Module 18: renders the opt-in checkbox + privacy sentence (UC-WA-003 strings) and MAY
  add a soft phone-format hint.
- Module 19: its INSERT calls `toE164()`; its idempotency key uses `phone_e164` when
  non-NULL; `notified_at` is written by UC-WA-008's release, not by 19.
- Module 20: `guest_orders.delivery_fee` feeds `{suma}`; own-Packeta guests are their own
  party in `handed_over:packeta`.
- Module 06 (guest checkout): the one consent sentence under the phone field (D6).

## Accepted risks / follow-ups (recorded, not silently implemented)

- **ToS / ban risk** (§5): whatsapp-web.js is unofficial; the dedicated number may be
  banned. Mitigations in scope: pacing, hourly cap, opt-in, human release, no bulk
  marketing from the bot by default (`closing`/`custom` are the admin's call). A ban costs
  the bot number only (Q5.a); the wa.me tab from the PO's own phone remains.
- **Protocol churn** (Q5.b accepted): a WhatsApp Web change can break the library until a
  bump; the process degrades to `auth_failure`/`disconnected` with rows waiting, never to
  a broken API.
- **Duplicate on the manual/bot race:** the conditional UPDATE + the `bot_active` 409 make
  it unlikely, not impossible (a send in flight while the health flips). Accepted.
- **`{meno}` is the first whitespace token** of a full name — a friend stored as
  „Ivet a Peto“ gets „Ahoj Ivet“. The admin sees it in the preview and can edit the row.
- **Clock/timezone:** hand-over grouping uses Europe/Bratislava dates computed in JS; a
  server TZ change does not move the groups.
- **Phase 2:** `in_person` template; „Odpojiť“/logout control; per-location `hours` in
  the pickup message; guest opt-in flag; Cloud API — none planned.

## OPEN items

- `OPEN:` default composer tab „Cez bota“ (D1).
- `OPEN:` `{suma}` = order amount vs ledger balance for friends (D4).
- `OPEN:` e-mail for opted-out friends on operational templates (D5).
- `OPEN:` admin `POST /api/friends` opt-in default `0` vs `1` (UC-WA-003).
- `OPEN:` auto-COMPOSE (not release) of `waitlist:<cycle>` when a cycle opens (UC-WA-007).
- `OPEN:` the bot's WhatsApp profile text („Na správy odpovedá Karol na čísle …“, R5.9) —
  PO supplies the number; set by hand on the bot phone, not by code.
- `OPEN:` bot number to be purchased/activated before UC-WA-013's production step
  (Q5.a: yes, not yet in hand as of 2026-09-19).

## PO decisions 2026-09-19 — OPEN items resolved

> Recorded by the orchestrator from the PO walkthrough. Each line resolves the `OPEN:` of the same name above; where a default was overturned the affected UC carries an amendment note.

- **Default composer tab** = „Cez bota“.
- **`{suma}` for friends** = LEDGER balance (matches the portal's Zaplatiť); omitted when the balance is zero or positive. Guests: the sub-order amount incl. fee.
- **Opted-out friends on operational templates** = e-mail fallback via `channel='email'` when an e-mail exists; otherwise no message (they see the stage in the app).
- **Admin `POST /api/friends` opt-in default** = `1` (ON).
- **Waitlist on round open** = auto-COMPOSE the `waitlist:<cycle>` group (never auto-release).
- **Tasks for the PO (not decisions):** buy/activate the bot number before UC-WA-013's production step; write the bot's WhatsApp profile text („Na správy odpovedá Karol na čísle …“).
- **Orchestrator clarification 2026-09-19 (`{suma}` when nothing is owed):** a literal placeholder blocks release (D10), so „omitted“ means the renderer DROPS the whole sentence containing `{suma}` (from the preceding sentence boundary to the next `.`) when the friend's ledger balance is ≥ 0 or the guest sub-order is paid. D4's `už uhradené` substitution is retired in favour of this rule; the seed bodies keep `Suma na úhradu: {suma}.` as their own sentence so the drop is clean.
