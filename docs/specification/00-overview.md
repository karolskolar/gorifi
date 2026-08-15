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
- **Status URL / pair token** — `/g/:token/o/:orderToken`-style guest credential, persisted per link-token in `localStorage`.
- **`paid` / `delivered`** — admin's flag / host's flag respectively; each writable in exactly one place; guests see both read-only.
