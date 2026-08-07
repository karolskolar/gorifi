# Handoff: Podpultovka — Friends portal + guest shared orders (redesign)

## Overview
Complete redesign of the Gorifi **friends portal** (login, cycle list, ordering) and the **guest shared-orders flow** (a friend shares a per-cycle link; unregistered colleagues order through it, pay the admin directly, and the friend hands the goods over). Visual direction: **"09 Neobrutal PP"** — neo-brutalist components in the Podpultovka tabloid palette. The admin app is a separate, upcoming task and is NOT part of this handoff.

## About the Design Files
The files in this bundle are **design references created in HTML/React (Babel, no build step)** — a clickable prototype showing intended look and behavior, **not production code to copy directly**. The task is to **recreate these designs in the target codebase**: `karolskolar/gorifi`, `frontend/` — Vue 3 + Vite + Tailwind + shadcn-vue. Port the design language into that stack (Tailwind config + restyled shadcn components); keep the repo's existing routing, API layer, and state logic. All behavior contracts already exist in the repo — this is a re-skin plus the UX changes listed below, not a functional rewrite.

Open `Podpultovka Friends.html` in a browser: top bar has a **screen selector** (Priateľ / Kolega groups), a **state selector** for multi-state screens (guest status: Upraviteľná / Zaplatená / Uzamknutá / Zrušená; dead link: 3 variants), and a **phone/desktop toggle**. Design is phone-first (378 px); desktop is the same layout centered at max-width 760 px.

## Fidelity
**High-fidelity.** Colors, borders, shadows, typography, spacing, copy and states are final. Recreate pixel-perfectly. `friends/theme.css` is the canonical stylesheet — every component class in it maps 1:1 to what the prototype renders.

## Design Tokens (from `friends/theme.css` — the source of truth)
- Background `#fff8f3` (with 5px halftone dot texture at 6% opacity), surface `#ffffff`, ink `#0a0a0a`
- Accent magenta `#ff2d87`, accent-ink `#fff8f3`, soft `#ffe3ef`, highlight `#ffd9e7`
- OK green `#1f8a5b` (soft `#dff2e8`, deep text `#0f5d3c`); danger `#d11a5b` (soft `#ffe0ea`, text `#a01044`); warn text `#8a5a00` on `#fff1cf`
- Nav: black `#0a0a0a` bar, white ink, 4px magenta bottom rule
- Borders: 3px solid ink on interactive elements (2px on badges/dividers, 4px on modals); radius 6 (badges) / 10 (buttons, inputs) / 12–16 (cards, modals)
- Shadows: hard offset only — `3px 3px 0 #0a0a0a` (buttons/tabs), `5px 5px 0` (cards), `8px 8px 0` (modals), `6px 6px 0 #ff2d87` (highlighted cards). Buttons translate into their shadow on hover/press.
- Type: **Darker Grotesque 800** (display: headings, prices, card titles — uppercase, line-height ≤1), **Figtree** 400–800 (UI/body), **Courier Prime** (money, counts, IDs, links, payment references ONLY). Google Fonts.
- Hit targets: buttons ≥44px, steppers 38px, checkboxes 24/32px.
- Brand chrome on every screen: appbar → 10px magenta/ink tape (`.hazard`) → magenta marquee ticker (`.ticker`, punk copy per screen). Guest screens keep full branding.
- Accent badges rotate −1.5° to −2°; wordmark "POD**PULT**OVKA" with PULT in magenta.

## Screens
Route names match the prototype's selector; repo source files are listed for each.

1. **f-login — Prihlásenie** (`FriendPortal.vue`): personal username+password only (modern auth mode), password eye-toggle, remember-me checkbox, invite explainer card. Legacy shared-password mode intentionally not designed — decide before porting.
2. **f-portal — Portál** (`FriendPortal.vue`, `FriendBalanceCard.vue`): appbar = name + code + edit + Pozvať chip + logout; balance card (negative balance = `.neg.pill`); cycle cards (open = `.card.hl` + share row with colleague-count badge; planned = non-clickable; bakery badge); archive fold. Modals: profile (ID/username read-only, login name, Packeta address, password change fold), subscription (Káva/Pekáreň checkboxes), invite link.
3. **f-order — Objednávka, moja** (`FriendOrder.vue`): green "odoslaná" banner; `.tabgroup` main switch Moja objednávka ⇄ Kolegovia (amber `.tabbadge.pending` = colleagues not yet handed over); sticky `.cat-tabs` (Espresso / Filter / Filter Special / Brew Bags / Nespresso) with right-edge fade, scroll-snap, tap-to-center; product cards (stretched bag image aligned to description height, roast + roaster badges, spec, tasting notes in mono, stock-limit bar where applicable); `.vbox` variant boxes — qty>0 ⇒ ink border + magenta offset shadow + magenta price; sticky `.cartbar` (deadline, item count, display total, actions Zrušiť / Zaplatiť(green) / Aktualizovať(accent), cart lines behind `<details>`, "Zmeny neboli odoslané" inline warning when dirty).
4. **f-guests — Kolegovia** (`GuestSubOrders.vue`, `GuestShareDialog.vue`): share row; summary line (count + colleague money = context only, host total unaffected); `.suborder` cards — name block toggles fold, paid badge (admin's flag, read-only), big green Odovzdané checkbox (host's flag), Odstrániť with inline `.confirmbox`; cancelled rows stay: dashed, 60% opacity, struck-through total. Empty state card carries the share CTA. Locked cycle: no share/remove, checklist remains.
5. **f-order-locked**: warn banner, disabled steppers, no footer actions.
6. **f-bakery** (`FriendOrder.vue` bakery branch): Slané/Sladké tabs, weight, composition behind `<details>`, unit variants.
7. **g-order — Guest objednávka** (`GuestOrder.vue`, `GuestProductGrid.vue`): hero `.card.hl` — cycle name display headline, "Spoločná objednávka · organizuje {host}", deadline, badges [Login netreba / Platba prevodom / Tovar odovzdá {host}]; same grid + sticky footer with single accent **Objednať**. Checkout modal: Meno* + Mobil* (≥9 digits, server re-validates) + E-mail optional; inline error banner.
8. **g-confirm — Potvrdenie**: rotated "✔ Odoslané" badge, "Objednávka je odoslaná" headline, sum card with items, green **Zaplatiť** (opens payment modal — in production auto-open on submit), status-URL copy row, compact invite CTA. Payment reference lives ONLY in the payment modal.
9. **g-status — Stav objednávky** (`GuestOrderStatus.vue`): header "Vaša objednávka · organizuje a odovzdá {host}"; `.statuspill`s (Zaplatené/Nezaplatené + Odovzdané/Zatiaľ neodovzdané); items card with total. Actions by state: *editable* → one row [Upraviť | Zaplatiť(green, wider)]; *paid* → pills only + ghost Zrušiť objednávku (items frozen server-side, cancel allowed); *locked* → warn banner "Objednávky sú uzavreté a už ich nie je možné zmeniť. Prípadnú zmenu skúste vyriešiť s organizátorom objednávky alebo objednávku môžete zrušiť." + green Zaplatiť if unpaid; *cancelled* → terminal danger banner, struck-through items, nothing else. Edit mode reuses the ordering grid + footer [Späť | Uložiť zmeny] + ghost Zrušiť objednávku; emptying the cart funnels into the cancel confirm.
10. **g-dead — Mŕtvy odkaz**: centered card, rotated "Slepá ulička" badge; 3 variants (404 / deactivated / cycle closed) with distinct copy + "požiadajte kolegu o nový".

**Shared modals** (portaled to a `.modal-layer` covering the viewport — note: the layer sits outside `.app`, so tokens are declared on `.app,.modal-layer`): Zdieľať s kolegami (copy row, accent share button, deactivate toggle with warn banner, regenerate with inline confirm "starý odkaz prestane fungovať, objednávky kolegov zostanú"); Platba (Revolut blue `#0075EB` button, Pay by Square QR, IBAN, copyable reference `G8 / {meno} / {cyklus}`); Spôsob prevzatia (Osobný odber / Packeta +3.80 €, locations + Iné note, default Packeta address, save-as-default); Hotovo! (success + inline payment); Zrušiť objednávku confirm.

## Interactions & Behavior
- Steppers mutate cart instantly; totals recompute live; submitted+dirty shows the footer warning until Aktualizovať.
- First submit routes through Spôsob prevzatia → success modal; later submits are direct Aktualizovať.
- Copy buttons flip to "Skopírované!" (green) for 2 s.
- Button press physics: hover translate(1,1) shadow 2px; active translate(3,3) shadow 0.
- Category tab tap centers the tab in the strip (no scrollIntoView; parent.scrollTo).
- Suborder fold: whole name block is the toggle; folded shows "N položiek".

## Business rules to preserve (from the repo — do not regress)
- Host's payable total = own items only; colleague totals are context (§UC-GSO-006).
- `paid` = ADMIN's flag; `delivered` = HOST's flag — each writable in exactly one place; guest sees both read-only.
- Guest edit rights come from server flags `editable` + `items_editable`; paid freezes items but allows cancel; cancelled is terminal.
- Host removal soft-cancels (row stays as Zrušené); removal ends at cycle lock, delivered checklist survives it.
- Regenerating the share link keeps existing sub-orders; deactivation is reversible.
- Status URL pair-token is the guest's only credential; persist per link-token in localStorage.
- Invite CTA when server says `invite_request.available`; 409 → "žiadosť už evidujeme".

## State Management
Prototype state is per-screen React state (cart map `productId|variant → qty`, submitted/dirty flags, modal enum, fold maps). In the repo these already exist in the Vue views — keep them; only the rendering changes.

## Assets
- Product images: prototype uses stylized bag placeholders (`.pimg`, roaster label GORIFFEE/ROBO). Production: real uploaded photos inside the same 2px-ink-border rounded frame.
- QR: placeholder pattern — production uses `bysquare` + `qrcode` (already in the repo's PaymentModal.vue).
- Icons: inline stroke SVGs (see `friends/ui.jsx` → `I`), stroke-width 2–2.6.

## Files
- `Podpultovka Friends.html` — prototype shell (open this)
- `friends/theme.css` — **design system: tokens + all component classes**
- `friends/ui.jsx` — primitives (icons, stepper, checkbox, modal, copy row, payment modal, QR)
- `friends/portal.jsx` — login + portal + profile/subscription/invite modals
- `friends/order.jsx` — friend order, kolegovia panel, share/pickup/cancel/success modals
- `friends/guest.jsx` — guest order, checkout, confirmation, status (4 states), dead link
- `friends/data.js` — demo data shaped after `docs/data-model.md`
- `screenshots/` — reference captures: 01 login · 02 portál · 03 objednávka · 04 kolegovia · 05 share modal · 06 kolegovia empty · 07 uzamknutá · 08 pekáreň · 09 guest objednávka · 10 guest checkout · 11 potvrdenie · 12 platba modal · 13 stav editable · 14 stav zaplatená · 15 stav zrušená · 16 mŕtvy odkaz · 17 desktop

## Out of scope (next task)
Admin app redesign; voucher modal; legacy shared-password login.
