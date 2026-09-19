# 00 — Overview: Friends portal + guest flow redesign ("Podpultovka Neobrutal PP")

Sources: `docs/design/friends-portal-redesign/README.md` (canonical handoff),
`docs/design/friends-portal-redesign/friends/theme.css` (design system source of truth),
`docs/brand/Podpultovka — Brand Brief.md`, repo `CLAUDE.md` (GSO invariants),
`docs/superpowers/specs/2026-07-18-guest-shared-orders-design.md`.

## Purpose

Recreate the high-fidelity "09 Neobrutal PP" redesign of the Gorifi **friends portal**
(login, cycle list, ordering) and the **guest shared-orders flow** in the existing
Vue 3 + Vite + Tailwind frontend (`frontend/`). This is a **re-skin plus the UX changes
listed in the handoff** — routing, API layer, state logic and every business rule stay
as they are. **No backend, schema or API change of any kind.** The admin app is a
separate upcoming effort and is out of scope.

Fidelity is **pixel-perfect**: colors, borders, shadows, typography, spacing, copy and
states in the prototype are final. The prototype (`Podpultovka Friends.html` — open in a
browser; screen/state/viewport selectors in its top bar) and the 17 reference screenshots
in `docs/design/friends-portal-redesign/screenshots/` are the acceptance reference.

Design is phone-first (378 px); desktop is the same layout centered at max-width 760 px.

## Actors

| Actor | Description | Surfaces |
|---|---|---|
| **Friend (host)** | Registered member with personal username+password (modern auth mode). Orders for themselves; may share a per-cycle guest link and hands goods over to colleagues. | f-login, f-portal, f-order (+locked, bakery), f-guests |
| **Guest (colleague)** | Unregistered person holding a shared link. Orders through it, pays the admin directly; their only credential is the status-URL token pair. | g-order, g-confirm, g-status (4 states), g-dead |
| **Admin** | Out of scope for this redesign. Appears only through read-only flags the other actors see (`paid` is admin's flag) and as payee. | — |

## Scope decisions (confirmed 2026-08-07)

- **Modern-login only.** The legacy shared-password mode was intentionally not designed;
  the login screen is styled for username+password only. The legacy branch keeps working
  unstyled until `auth_mode=modern` retires it (existing follow-up, not part of this effort).
- **Re-skin only** — no API or business-logic changes; the "Business rules to preserve"
  list in the handoff README is a do-not-regress contract.
- Voucher modal and admin app: out of scope (next task).

## Scope extension — auth & e-mail (confirmed 2026-08-14)

Modules 08–11 extend the spec beyond the redesign (like 07 did): branded transactional
e-mail, magic-link password recovery, Google sign-in, and the `friends` field
consolidation. All four include backend/schema changes; the "no backend change" rule
above still scopes 02–06 only. Decisions confirmed with the product owner:

- **Magic link = log in + non-blocking prompt to set a new password.** Passwords stay;
  the link is a recovery/login path, not a reset ceremony.
- **Google matching is explicit-link only** — a Google identity logs in only an account
  that deliberately linked it (at registration or later). No silent matching on e-mail.
  Admin Google access is an allowlist in settings; admin password auth remains as backup.
- **Field mapping:** existing `friends.name` becomes "Meno a priezvisko" (relabel +
  data-cleanup pass); `display_name` (already labelled Poznámka) is the admin note.
  No destructive migration.
- The **Applicant** (person registering via `/invite/:code`) gains a "sign up with
  Google" path in module 10; guests are untouched by all four modules.
- The Admin actor's "out of scope" note above predates this extension: modules 08–11
  touch the admin login screen (Google + password backup) and AdminFriends.

## Scope extension — product catalog & coffee passport (confirmed 2026-08-22)

Modules 12–13 extend the spec again (the 07/08–11 pattern): a consolidated coffee
product catalog with duplicate-aware import and cross-cycle statistics (12), and the
friend-facing "coffee passport" layer on top of it (13). Both include backend/schema
changes; the "no backend change" rule scopes 02–06 only. Canonical source:
`docs/requirements/2026-08-18-catalog-profiles-recommendations-brief.md` (v5) — its
§6 Decisions log wins over earlier body text on any conflict. Key confirmed decisions:

- **Bakery-pattern import (pivot 2026-08-22, decision #15).** The import tool lives in
  the ADMIN MAIN MENU and targets the CATALOG — cycle-independent, like the bakery
  products page; the sheet PARSING/column mapping stays byte-identical, only the target
  moved. Coffee cycle creation ticks products from the catalog (default: all available)
  and snapshots them with frozen prices; the per-cycle import endpoints + CycleDetail
  import UI retire. Goriffee-only matching; exact normalized-name matches auto-link,
  fuzzy matches ask for confirmation; price changes update catalog current prices and
  are reported. **Cycles are frozen by construction — no import path can touch any
  cycle.** The import returns a machine-readable JSON report
  (automation-readiness: a future scheduled job drives the same HTTP API; the DB stays
  SQLite — no external database).
- **Catalog + snapshot links** (the bakery pattern): `coffee_products` holds each real
  product once; cycle `products` rows stay immutable snapshots linked via
  `source_coffee_product_id` — the only schema change to an existing table. One-time
  migration retro-links history; an admin merge tool resolves the fuzzy tail.
- **Module 12 is admin-primary** (import, migration, merge, catalog management,
  cross-cycle stats). Module 13 (friend-facing passport layer) was drafted and then
  **DEFERRED wholesale on 2026-08-22** — only module 12 is built. Guests are
  untouched: they count in product/cycle totals, never in per-friend aggregates.
- **Deferred display, DB-ready:** social-proof badges/labels (aggregate AND named),
  tier-progress on the order page (cut entirely), discovery/engagement module 14 —
  none are drafted; the schema and stats must support the badges later.

## Scope extension — roadmap October 2026 (confirmed 2026-09-19)

Source of truth: `docs/superpowers/specs/2026-09-03-roadmap-requirements.md` (§16 decisions,
§18 roadmap v3, §19 profile) and the interactive prototypes in the Claude Design project
mirrored at `docs/design/friends-portal-redesign/` (`friends/portal2.jsx`, `guest2.jsx`,
`admin2.jsx`, README addenda 2026-09-05/06). Later sections of the roadmap doc win over
earlier ones (struck text is superseded). Modules **15–21** below; all include backend +
schema changes unless a module says otherwise.

- **Why:** newly onboarded friends and their guests do not understand "objednávkové cykly";
  the portal must open on the current offer, explain the process once, and the admin must
  be able to plan distribution by delivery type and tell people when their bag left.
- **Confirmed product decisions (PO):** bakery cycles are retiring (coffee only, at most one
  open cycle); user-facing copy says **„objednávka“**, never „kolo“/„cyklus“; the **Pozvať**
  chip stays in the appbar; Podpultovka stays **private** (no public explainer page — the
  guest link carries it); free-text pickup note stays available to everyone; guests may
  order via a host who orders nothing; guest Packeta = same fee as friends, free-text
  point, no Packeta API; WhatsApp = **whatsapp-web.js only** (no Baileys, no Cloud API),
  new dedicated number, three templates to start, messages released per group by the
  admin, and it is the **last** slice, after the next ordering round; payment links use
  Revolut **@karolskolar** and PayMe creditor **„Karol Skolar“**; a friend never needs to
  see their `uid`.
- **Out of scope (not drafted):** bag labels (F7 — built elsewhere), public „Ako to
  funguje“ page, Packeta widget/API, Baileys / WhatsApp Business Cloud API, cycle
  auto-completion, "pick up within N days" copy.
- **2026-09-19: every `OPEN:` item of modules 15–21 was resolved with the PO** — see the „PO decisions 2026-09-19“ block at the end of each module file. Two defaults were overturned: admin gets read/regenerate of a host's standing link (19), and a cancelled paid Packeta guest order is refunded items + fee (20). `expected_date` now means delivery expectation; `closes_at` is the ordering deadline (17).
- ~~**Open prototype decisions** are written with their defaults and marked `OPEN:` in the~~ (resolved, see above) — original text kept: written with their defaults and marked `OPEN:` in the
  module files so `/plan-backlog` can proceed: debt banner on the landing (default yes),
  closed-state modal once + banner (default), guest explainer 3 steps (default), board
  layout as prototyped, WhatsApp bot with wa.me fallback.

## Specification files

| File | Scope | UC prefix |
|---|---|---|
| `00-overview.md` | This file | — |
| `01-architecture.md` | Existing-system reference + design-system conventions | — |
| `02-design-system.md` | theme.css → Tailwind port, fonts, brand chrome, shared primitives, modal layer, scoping so admin views are untouched | UC-DS |
| `03-friend-login-portal.md` | f-login, f-portal, profile/subscription/invite modals | UC-FL |
| `04-friend-order.md` | f-order, f-order-locked, f-bakery; cat-tabs, product cards, vbox, cartbar, pickup/cancel/success modals | UC-FO |
| `05-colleagues-panel.md` | f-guests panel, suborder cards, share dialog | UC-KG |
| `06-guest-flow.md` | g-order, g-confirm, g-status ×4, g-dead, checkout + payment modals, invite CTA | UC-GX |
| `07-invitation-approval.md` | Invitation → friend-with-login: registration username field, register hardening, atomic approve endpoint, admin approval dialog, AdminFriends relabel. ⚠ Unlike 02–06 this module INCLUDES backend/schema changes (added 2026-08-13, after the redesign shipped — the "no backend change" rule above scopes 02–06 only) | UC-IA |
| `08-transactional-email.md` | Branded HTML e-mail layer: multipart text+html templates on top of `helpers/mailer.js`, canonical `podpultovka.biz` login URL in outbound mail, applied to the credentials mail; the shared foundation module 09 reuses. Backend + config changes | UC-EM |
| `09-magic-link-recovery.md` | "Zabudli ste heslo?" → single-use, short-lived, hashed magic-link login e-mail (requires `friends.email`); passwords preserved; logging in via link prompts (does not force) a new password; "Zapamätať si ma na tomto zariadení" = 60-day session opt-in (default 24 h). Backend + schema changes | UC-ML |
| `10-google-auth.md` | Sign in with Google on the friend AND admin portals: choose-Google at invite registration, link-to-existing prompt after friend login (áno / teraz nie / už sa nepýtať) + manual link/unlink in the profile, explicit-link-only matching (no silent e-mail matching), admin keeps password auth as backup. Backend + schema changes | UC-GA |
| `11-friends-consolidation.md` | `friends` table + AdminFriends consolidation to the canonical field set: Meno a priezvisko (`name`), username, password state, Google auth on/off, mobil (`phone`), e-mail, admin note (`display_name`). Relabel/reconcile, no destructive migration | UC-FC |
| `12-product-catalog.md` | Consolidated `coffee_products` catalog + snapshot links; CATALOG-targeted import from the admin main menu (bakery-pattern pivot 2026-08-22; parsing byte-identical, Goriffee-only, exact auto-link / fuzzy confirm, price auto-apply + report, naturally idempotent); cycle creation ticks catalog products (picker + snapshot); per-cycle importers retired; one-time historical migration + admin merge tool; cross-cycle statistics; AdminCatalog view. Backend + schema changes | UC-PC |
| `13-coffee-passport.md` | **DEFERRED wholesale (PM 2026-08-22)** — drafted, not planned/built. Friend-facing catalog layer: multi-select brew methods (`friend_brew_methods`), passport "Moje kávy" (stats header, history, Objednať znova), 👍/😐/👎 micro-reviews, product detail modal (Región/Nadmorská výška/Farma/Odroda/Spracovanie — display only). Backend + schema changes | UC-CP |
| `14-guest-order-recovery.md` | Guest order recovery + admin guest controls (from the 2026-08-26 Martina Tomašová incident): canonical `/g/o/:orderToken` decoupled from the share link (legacy pair form keeps working), admin read/create of host share links (revocation stays host-only), admin soft-cancel of guest sub-orders (no paid blockade — paid+cancelled lands in the refund queue), `order_token` published to host + admin for resending (conscious GSO-T2 reversal), share-dialog standing copy (one link for all; regenerate only on a leak). Backend changes, NO schema change | UC-GR |
| `15-payment-links.md` | Amount-prefilled Revolut link (`@karolskolar`), PayMe.sk deep link (new `payment_creditor_name` setting, mobile only), numeric variable symbol in the bysquare payload and reference — one component (`PaymentModal.vue`), four surfaces. Backend + settings change, no schema table | UC-PL |
| `16-distribution-pipeline.md` | `helpers/delivery.js` (party → `packeta` / `pickup` / `in_person` / `via_host`), ledger-neutral `handed_over_at` on `orders` + `guest_orders` (409 before packed, reversible, guests inherit from host), hand-over + bulk endpoints, distribution board (plan cards per target, group-by doručenie/stav/priateľ, stage filter, per-group hand-over with confirm), outbox enqueue hook (no sending). Prototype `a-dist`. Backend + schema changes | UC-DP |
| `17-cycle-stages.md` | `order_cycles.opens_at` / `closes_at` / `stage` (`ordered` → `arrived` → `ready`, auto-fed by the first hand-over), admin controls on cycle detail, `CycleTimeline.vue` (vertical + compact dots) used by portal, guest status page and admin header. Backend + schema changes | UC-CS |
| `18-portal-information-architecture.md` | Landing = current offer (open / closed-modal / locked with own-order card + timeline), hamburger drawer (ponuka, moje objednávky, zostatok a platby, zdieľať, pozvať, ako to funguje, profil, odhlásiť), first-login explainer incl. „Kto sme a odkiaľ je káva“ (Goriffee + Robo), „objednávka“ wording, subscription filter retired, profile modal per roadmap §19 (Login ro, Meno a priezvisko, Mobil, E-mail, Packeta). Prototype `f-portal2`. Frontend + small backend (`explainer_seen_at`, cycle payload) | UC-PI |
| `19-guest-standing-link.md` | Per-host standing guest link resolving to "the current round"; pre-open guest page (host, next opening, 3-step explainer, roasters, „Dajte mi vedieť“ waitlist with WhatsApp consent); `guest_waitlist` table + public rate-limited write; host „kto čaká“ count; compact 3-step explainer on the open guest page. Prototype `g-link2`. Backend + schema changes | UC-GL |
| `20-guest-packeta.md` | Guest checkout choice „Prevezmem od {host}“ / „Poslať Packetou (+fee)“ when the cycle allows parcels; `guest_orders.delivery_fee` + `packeta_address`; e-mail required for Packeta; amount = total + fee in QR/links/status; edits/cancel rules; host/admin/distribution surfaces; `helpers/pickup.js` extended to guest rows. Backend + schema changes | UC-GP |
| `21-whatsapp-notifications.md` | Outbox table (`channel`, `status`, per-group release), segments (`helpers/segments.js`: handed-over per target, host's guests, not-ordered, waitlist), `phone_e164` normalisation, `whatsapp_opt_in` in profile, templates (3 on at start), admin composer (segment → template → preview → „Poslať skupine“; wa.me fallback tab), `gorifi-wa` whatsapp-web.js PM2 process with QR pairing + health, settings page, server sizing (8 GB / 4 vCPU). Prototypes `a-wa`, `a-wa-settings`. Backend + schema + deploy changes | UC-WA |

## Glossary

- **Podpultovka** — the brand; wordmark "POD**PULT**OVKA" with PULT in magenta.
- **Neobrutal PP** — the visual direction: 3px ink borders, hard offset shadows, magenta
  accent `#ff2d87`, Darker Grotesque display type, rotated badges, halftone background.
- **Brand chrome** — the per-screen header stack: black appbar → 10px hazard tape → magenta marquee ticker.
- **Cycle** — an ordering round (`order_cycles`); open/planned/locked; coffee or bakery.
- **Host** — the friend who shared a guest link for a cycle.
- **Sub-order** — a guest's order under a host's link (`guest_orders`); `cancelled` is terminal.
- **vbox** — variant box on a product card (size + price + stepper); selected state gets ink border + magenta offset shadow.
- **cartbar** — sticky cart footer with deadline, total, actions, and cart lines behind `<details>`.
- **Status URL** — the guest's own order page. Canonical form `/g/o/:orderToken`; **`order_token` ALONE is the credential** (module 14, UC-GR-001/002 — same entropy as a link token). The legacy pair form `/g/:token/o/:orderToken` keeps working forever, but its `:token` half is URL carriage only: it neither resolves nor authorizes, and the page re-canonicalises the address bar after a successful load. Still persisted per LINK-token in `localStorage` (`gorifi_guest_orders`) — that shape is deliberately unchanged. ⚠ Do not reintroduce the "pair is the credential" model: it is what stranded a paid guest when her host regenerated the share link.
- **`paid` / `delivered`** — admin's flag / host's flag respectively; each writable in exactly one place; guests see both read-only.
- **Catalog product** — a row in `coffee_products`: one real-world coffee, existing once across all cycles (module 12).
- **Snapshot link** — `products.source_coffee_product_id`: ties a cycle's immutable product snapshot to its catalog product.
- **Passport / Moje kávy** — the friend's cross-cycle coffee history screen (module 13); also the micro-review collection surface.
- **Micro-review** — 👍/😐/👎 verdict + optional brew method, one row per (friend, catalog product), latest wins. No stars, no text.
- **Flavor chips** — the 4 consumer taste families concept; **REMOVED from v1 by PM decision 2026-08-22** (risk of misleading tags). No column, no tagger, no display; returns, if ever, with module 14.
- **Round / objednávka** — user-facing name for a cycle from module 18 on („Ďalšia objednávka sa otvorí…“); „cyklus“/„kolo“ never appear to a friend or guest. Admin UI may keep „cyklus“.
- **Delivery type** — derived per party by `helpers/delivery.js`: `packeta` (parcel), `pickup` (a `pickup_locations` row), `in_person` (neither), `via_host` (a guest bag inside the host's bag; inherits the host's type/target for planning).
- **Bag stages** — Na zabalenie → **Zabalené** (`orders.packed`, the ledger moment, unchanged) → **Odovzdané** (`handed_over_at`, admin-only, ledger-neutral, the notification moment). The host's `guest_orders.delivered` tick stays a separate, later, host-only flag.
- **Cycle stage** — `order_cycles.stage` while `locked`: `ordered` (at roastery) → `arrived` → `ready` (first bag handed over); shown on the timeline.
- **Standing link** — a host's cycle-independent guest link (`friends.guest_link_token`) that resolves to the current round, or to the pre-open page when nothing is open.
- **Waitlist** — `guest_waitlist` rows left by guests on the pre-open page; becomes a WhatsApp segment when the round opens.
- **Outbox** — `notifications` rows queued by hand-over / admin composer; nothing is sent without an explicit admin „Poslať“ per group.
- **Segment** — a computed recipient list (SQL in `helpers/segments.js`) the composer sends to.
