# 05 — Kolegovia panel + share dialog (f-guests)

> Scope: The content of the "Kolegovia" panel on the friend order page (screen f-guests)
> and the shared `GuestShareDialog` — share row, summary heading, `.suborder` cards
> (fold, badges, hand-over checkbox, remove-with-confirm, cancelled rendering), the
> empty/locked states, and every state of the "Zdieľať s kolegami" modal. This is a
> **re-skin**: no API, schema or business-logic change; the components keep their
> script-level contracts (loadSeq / rowSeq / `ready` gate / summary emit) verbatim.
> Out of scope (handoffs): the main-tab SHELL — the Moja objednávka ⇄ Kolegovia switch,
> `main-tab-guests`, `guest-tab-badge` and its violet/amber logic → `04-friend-order.md`
> (this module only feeds it via the `summary` emit); tokens, `friends-theme.css`,
> `NeoModal`/`NeoCheckbox`/`NeoCopyRow`/`NeoIcon` primitives → `02-design-system.md`;
> the portal cycle-card "Zdieľať s kolegami" entry point → `03-friend-login-portal.md`
> (the dialog it opens is THIS module's); what the guest sees through the link
> (g-order/g-status incl. the cancelled view) → `06-guest-flow.md`.
> Actors: Friend (host) — the only actor on this surface; writes `delivered`, triggers
> soft-cancel, manages the share link. Admin — appears only as the read-only `paid`
> badge (admin's flag; no control rendered here) and as the escalation target of the
> paid-409. Guest — never sees this surface; their `order_token` is never rendered here.
> Sources: `docs/design/friends-portal-redesign/friends/order.jsx` (`ShareModal`,
> `SubOrderCard`, `GuestsPanel` — canonical visuals + copy),
> `docs/design/friends-portal-redesign/README.md` (§Screens item 4, §Shared modals,
> §Interactions "Suborder fold", §Business rules to preserve),
> `screenshots/04-shot.png` (kolegovia) / `05-shot.png` (share modal) / `06-shot.png`
> (empty state), `friends/theme.css` (`.suborder`, `.confirmbox`, `.copyrow`, `.banner`,
> `.badge`, `.cbox`, `.card.flat`, `.chev`); repo behavior canon:
> `frontend/src/components/GuestSubOrders.vue`, `frontend/src/components/GuestShareDialog.vue`,
> `frontend/src/views/FriendOrder.vue` (`#panel-guests` fragment), repo `CLAUDE.md`
> (GSO-T2, GSO-T5, GSO-T6 paid-freeze, "Guest sub-orders on screen: folding…"),
> `backend/src/routes/guest-orders.js` (409 copy). E2E pins: `e2e/tests/guest-link.spec.js`,
> `e2e/tests/guest-host-view.spec.js`. The most recent decision wins on conflict —
> handoff bundle (2026-08) canonical for visuals/copy, repo code canonical for behavior.
> **Design reference:** `screenshots/04-shot.png`, `05-shot.png`, `06-shot.png`; live
> prototype `Podpultovka Friends.html` → screen "Objednávka — kolegovia" (+ "prázdny
> stav" state). Match card borders/shadows, badge palette, the display-font total and
> the big green checkbox to the pixel.

---

## Resolved conflicts (recency / canonicity)

1. **Empty-state card class.** 02's UC-DS-013 disposition table lists `.card.dashed`
   as "05 (empty state)". The prototype (`order.jsx` `GuestsPanel`, canonical for
   visuals) renders the empty state as a plain **`.card`** (solid 3px border, 5px
   shadow — confirmed in `06-shot.png`). Resolution: plain `.card`; `.card.dashed`
   returns to reserve (no consumer in this module).
2. **Cancelled row presentation.** Current `GuestSubOrders.vue` keeps a cancelled
   row's item list visible/foldable and shows the paid badge next to "Zrušené".
   The prototype hides the item list on cancelled rows entirely (`open && !cancelled`),
   shows a **single** `.badge.muted` "Zrušené", the permanent "N položiek" line, and a
   struck-through total. Resolution: prototype wins (presentation, not behavior — the
   DB keeps the item rows per GSO-T4/T5, and the payload still carries them; the
   struck-through amount is recomputed from them, see UC-KG-003 rule 6). The paid state
   of a cancelled row remains admin-visible in the refund queue (GSO-T6) — no host-side
   signal is lost that the host could act on.
3. **Native share button.** The prototype always renders the accent "Zdieľať odkaz"
   button in the share modal; repo behavior (canonical) renders it **only when
   `navigator.share` exists** (pinned by `guest-link.spec.js`: count 0 without it).
   Resolution: keep the conditional; take the prototype's label "Zdieľať odkaz"
   (was "Zdieľať"). Substring `getByRole('button', { name: 'Zdieľať' })` still matches.
4. **Clipboard fallback.** Current dialog carries an `execCommand('copy')` fallback;
   `NeoCopyRow` (UC-DS-011, pinned) wraps `navigator.clipboard.writeText` in try/catch
   and flips regardless. Resolution: the primitive's contract wins — the bespoke
   fallback and the dialog's own `copied` timer are deleted with the old markup.
5. **Summary-line copy.** Current: "Kolegovia platia priamo, vaša suma na úhradu sa tým
   nemení." Prototype (copy is final): "Kolegovia platia priamo správcovi — vaša suma
   na úhradu sa tým nemení." Prototype wins. Same for the empty-state sub-line, which
   gains "bez registrácie" (UC-KG-002).
6. **Empty-vs-list gating.** Current parent gates the share row / empty CTA on
   `guestSummary.count` (live, cancelled-excluded), so a host whose only sub-orders
   are cancelled sees the "Zatiaľ nikto" CTA card stacked above cancelled rows. The
   prototype gates on `subs.length` (all rows). Resolution: prototype semantics via an
   **additive** `rows` field on the `summary` emit (UC-KG-001 rule 5) — badge math and
   every other consumer keep using `count`/`pendingDelivery` unchanged.

---

## UC-KG-001 Panel composition, share row and summary heading (Friend/host)

**Goal:** the `#panel-guests` content in `FriendOrder.vue` and the `GuestSubOrders.vue`
list header are restyled to the prototype's `GuestsPanel` layout.

**Preconditions:** 02 landed (`friends-theme.css`, primitives); `FriendOrder.vue`'s
root carries `.app` (module 04's first step — this module's classes render as unstyled
HTML until then; see seams).

**Structure (open cycle, ≥1 sub-order row) — top to bottom inside `#panel-guests`:**

1. **Share row** (lives in `FriendOrder.vue`, as today): `div.card.flat`, padding
   `12px 14px`, `display:flex; align-items:center; justify-content:space-between;
   gap:10px; flex-wrap:wrap`. Left: `span.sub` 13px, copy verbatim
   **"Ďalší kolegovia sa môžu pridať cez ten istý odkaz."** Right: `button.btn.sm`
   with `NeoIcon name="share"` + label **"Zdieľať odkaz"** → opens the share dialog
   (`showShareModal = true`, unchanged).
2. **`GuestSubOrders.vue`** — its root sheds the shadcn `Card` wrapper and becomes a
   plain container `div` keeping `data-testid="guest-sub-orders"`, laid out
   `display:flex; flex-direction:column; gap:14px`. Render condition unchanged:
   the section renders when `subOrders.length > 0 || error`.
3. Inside it, when `subOrders.length > 0`, the **heading block**: `div.display`
   font-size 24 — **"Objednávky kolegov"** — then the summary line `div.sub`
   (margin-top 4, font-size 13.5):
   **"Objednali {label} · spolu `<b class="mono">{total} EUR</b>`. Kolegovia platia
   priamo správcovi — vaša suma na úhradu sa tým nemení."** — the total `<b>` styled
   `color:var(--ink)`; `{total}` = `totals.total` formatted `toFixed(2)` (UC-DS-012).
4. Then the `.suborder` cards (UC-KG-003), one per row in server order.

**Business rules:**

- **The colleague money is CONTEXT ONLY.** `{label}`/`{total}` come from the server's
  `totals` (`{count, total}`, cancelled-excluded — GSO-T5 pins the shape). Nothing in
  this panel writes into, adds to, or renders inside the host's own payable total —
  the cartbar (module 04) stays own-items-only (§UC-GSO-006, README §Business rules).
- Pluralized `{label}`: `1 kolega` / `2–4 → "{n} kolegovia"` / `5+ → "{n} kolegov"`
  (existing `colleagueCount` computed, unchanged).
- Script contract of `GuestSubOrders.vue` is untouched: the `cycleId`+`ready` watcher
  with `loadSeq`, per-row `rowSeq` pending map, `replaceRow`, optimistic delivered
  toggle, the auth-`ready` gate prop (CLAUDE.md GSO-T5 — any friend-authenticated
  child of FriendOrder needs it), and the `v-show` mount requirement (the component
  stays mounted on both tabs so the `summary` emit fires before the tab is opened).
- **Rule 5 — `summary` emit gains `rows`:** payload becomes
  `{ count, total, pendingDelivery, failed, rows: subOrders.length }` (additive).
  The parent's gates change: share row renders when `!isLocked && rows > 0`; the
  empty-state card when `!isLocked && rows === 0`; the locked-empty text when
  `isLocked && rows === 0 && !failed`. `count`/`pendingDelivery` semantics are
  untouched — module 04's tab badge is unaffected (seam).
- Error surfacing: the single panel-level `error` ref renders as
  `div.banner.danger.slim` (with `span.dot`) as the FIRST child of the
  `guest-sub-orders` container, message = `e.message` verbatim (server messages are
  Slovak). It renders with or without rows — a failed load with an empty list must
  not be mistakable for "no colleagues yet" (existing rule, kept).
- Slovak register stays impersonal vy-form throughout (01-architecture §i18n).

**Acceptance criteria:**

- Side-by-side with `04-shot.png` at 378px: flat 2px-border share row card, display
  heading, mono total in the summary line, 14px column rhythm.
- With 2 live + 1 cancelled sub-orders, the summary counts 2 and sums only the live
  totals; the host's cartbar total is unchanged by any value in this panel.
- e2e `guest-host-view.spec.js` "tab split" and list assertions stay green
  (see UC-KG-007 for the pinned selector inventory).

---

## UC-KG-002 Empty state and locked states (Friend/host)

**Goal:** the panel's three non-list states, per prototype.

**A — open cycle, no sub-order rows** (`rows === 0`, `!isLocked`) — the empty-state
card carries the share CTA (it IS the panel). Lives in `FriendOrder.vue`. Structure:
`div.card`, padding 22, `display:flex; flex-direction:column; align-items:center;
gap:10px; text-align:center`:

| # | Element | Classes / style | Copy (verbatim) |
|---|---|---|---|
| 1 | badge | `span.badge.acc` (rotated −1.5° by CSS) | `Zatiaľ nikto` |
| 2 | headline | `div.display`, font-size 22 | `Objednávate aj pre kolegov?` |
| 3 | sub | `div.sub`, `max-width:300px` | `Pošlite im odkaz — objednajú si sami, bez registrácie, a vy im tovar odovzdáte.` |
| 4 | CTA | `button.btn.accent`, margin-top 4, `NeoIcon name="share"` + label | `Zdieľať objednávku s kolegami` |

The CTA opens the same share dialog. `data-testid="guest-sub-orders"` must NOT exist
in this state (pinned: `toHaveCount(0)`).

**B — locked cycle, no rows** (`isLocked && rows === 0 && !failed`): a single line,
`div.sub`, padding `8px 2px`, copy verbatim **"Cez váš odkaz si nikto neobjednal."**
No card, no CTA.

**C — locked cycle, rows present:** the share row (UC-KG-001 item 1) and every share
entry point on this screen disappear (`v-if="!isLocked"` — nobody can order into a
locked cycle), and per-row "Odstrániť" disappears (UC-KG-005), but the heading, the
summary line, the sub-order cards and the **Odovzdané checklist remain** — the
hand-over happens precisely after the lock (README §Business rules: "removal ends at
cycle lock, delivered checklist survives it").

**Business rules:**

- State A/B/C selection uses the `rows` field per UC-KG-001 rule 5.
- With `failed` (load error) the section renders the danger banner instead of state B
  — never "nikto neobjednal" over a failed request (existing rule, kept).
- The tab itself stays visible even in state A — module 04's concern, noted here only
  because state A is the reason (sharing must remain findable).

**Acceptance criteria:**

- Side-by-side with `06-shot.png`: rotated magenta badge, display headline, accent CTA.
- e2e pins hold: `getByText('Objednávate aj pre kolegov?')` visible,
  `getByRole('button', { name: 'Zdieľať objednávku s kolegami' })` visible,
  `guest-sub-orders` count 0 (state A); locked cycle shows no button matching
  `/Zdieľať/` anywhere in the panel.

---

## UC-KG-003 Sub-order card — fold, badges, items, cancelled (Friend/host)

**Goal:** each guest sub-order renders as a `.suborder` card (3px ink border, radius
12, `3px 3px 0` shadow, padding `12px 14px`; `.cancelled` adds dashed border, no
shadow, opacity .6 — all from `friends-theme.css`).

**Structure (live row):**

1. **Header row** — `display:flex; justify-content:space-between;
   align-items:flex-start; gap:8px; flex-wrap:wrap`.
   - **Name block = the fold toggle** (README §Interactions: "whole name block is the
     toggle" — a bare 16px chevron is not a thumb target). Rendered as a real
     `<button type="button">` (as today) with `data-testid="guest-items-toggle-{id}"`,
     `aria-expanded`, `display:flex; gap:8px; align-items:flex-start; min-width:0;
     text-align:left`. Contains: `span.chev` (+`.open` when expanded — CSS rotates it
     90° and colors it accent) wrapping `NeoIcon name="chev"`, margin-top 3; then a
     `min-width:0` column: guest name (`font-weight:800; font-size:15.5px`), phone
     `span.mono.sub` 12px, and — **only when folded** — the count line `span.sub`
     12px with `data-testid="guest-items-summary-{id}"`.
   - **Badge group**, `display:flex; gap:6px; flex-shrink:0`: exactly ONE badge —
     `span.badge.ok` **"Zaplatené"** or `span.badge.warn` **"Nezaplatené"**
     (`data-testid="guest-paid-badge"`).
2. **Item list** (when expanded): `ul.items` (13.5px, ink-dim, 4px row gap),
   `data-testid="guest-items-{id}"`, one `li` per item line:
   left span (`min-width:0`) `"{quantity}× {product_name}"` + variant suffix
   `"— {variant_label}"` (or `"— {variant}"` when no label and variant ≠ `unit`);
   right `span.mono` = `(item.price × item.quantity).toFixed(2)` — **bare number, no
   EUR suffix on item lines** (prototype line 124; the EUR suffix appears on totals
   only).
3. **Foot** — `div.foot` (top-hairline row from CSS): left `span.total` (display font
   800, 20px) = `subOrder.total` as `"{toFixed(2)} EUR"`; right group
   (`display:flex; align-items:center; gap:14px`): the Odovzdané label (UC-KG-004)
   and the Odstrániť button (UC-KG-005).

**Business rules:**

1. Fold count label counts LINES, not pieces: `1 položka` / `2–4 → "{n} položky"` /
   `5+ → "{n} položiek"` (existing `itemCountLabel`, unchanged).
2. Fold state is keyed by `guest_orders.id`, manual, defaults to **expanded** for live
   rows, screen-state only, not persisted (CLAUDE.md folding rules — do NOT auto-fold
   on any event).
3. **Cancelled row** (`status === 'cancelled'`, terminal): card gets `.cancelled`; the
   badge group renders ONLY `span.badge.muted` **"Zrušené"** with
   `data-testid="guest-status-{id}"` (no paid badge — resolved conflict 2); the item
   list is **never rendered** and the name block is NOT a toggle (plain `div`/`span`
   structure, no `aria-expanded`, no `data-testid="guest-items-toggle-{id}"`, `.chev`
   rendered without `.open`); the "N položiek" count line shows permanently (keep
   `data-testid="guest-items-summary-{id}"` on it); the foot renders only
   `span.sub` with `text-decoration:line-through` = the called-off amount + `" EUR"`.
   No checkbox, no Odstrániť, no confirmbox on a cancelled row.
4. The prototype's cancelled card keeps a live-looking click handler on the name block
   that reveals nothing (`open && !cancelled` gates the list) — that is a prototype
   glitch, not intent; rule 3's "not a toggle" is the resolution.
5. Rows never disappear on cancel — the soft-cancel row stays as the host's record
   (GSO-T5; the server keeps the item rows and the status predicate does the rest).
6. **Struck-through amount = Σ(item.price × item.quantity) recomputed client-side**,
   NOT `subOrder.total` — the server zeroes `total` on cancel (GSO-T5), and the design
   intends the amount that was called off (same derivation the admin refund queue
   uses, GSO-T6). Display-only; no payload change.
7. While `pending[id]` (a mutation in flight for this row), the card keeps the current
   `animate-pulse` utility and the row's controls disable (UC-KG-004/005). Per-row —
   never a shared lock (GSO-T1/T7 precedent).

**Acceptance criteria:**

- Fold e2e flow holds: toggle click hides `guest-items-{id}`, shows
  `guest-items-summary-{id}` with "2 položky", second click restores 2 `li`s; badges
  and checkbox remain visible folded.
- A cancelled row shows dashed border, 60% opacity, single "Zrušené" badge, no items,
  struck-through original amount; a live row next to it is fully interactive.
- Visual match to the prototype's kolegovia screen (display-font total, `.chev`
  accent rotation when open).

---

## UC-KG-004 "Odovzdané" — the host's hand-over checkbox (Friend/host)

**Goal:** the big green checkbox in each live row's foot, the ONLY writer of
`delivered` in the system.

**Structure:** `<label>` (`display:flex; align-items:center; gap:8px; cursor:pointer;
font-weight:700; font-size:13.5px`) containing `NeoCheckbox` with `big` + `ok`
(`.cbox.big.ok` — 32px, 3px ink border, green `#1f8a5b` fill when on; UC-DS-009) and
the text **"Odovzdané"**. `data-testid="guest-delivered-{id}"` sits on the NeoCheckbox
root (the `role="checkbox"` element).

**Business rules:**

- `delivered` is the **HOST-only flag** (Decision 2 / GSO-T5): this checkbox is its
  single write point; `paid` has no control here in any state (pinned by e2e: no
  button/checkbox named /Zaplaten/ exists in the section).
- Handler stays `toggleDelivered(subOrder)` verbatim: optimistic flip, per-row
  `rowSeq` ownership, rollback + error surfacing on failure even when superseded
  (the checkbox must never claim a hand-over the server refused). The failure message
  lands in the panel-level danger banner (UC-KG-001).
- Works on locked cycles (hand-over happens after the lock) and on paid rows
  (delivery is independent of payment). Hidden on cancelled rows (UC-KG-003 rule 3).
- While `pending[id]`: NeoCheckbox gets `disabled` — an **approved extension** to
  UC-DS-009's primitive: optional `disabled` prop → click/keyboard no-op +
  `aria-disabled="true"`, no new visual beyond the row's pulse (extend the primitive,
  never fork it).
- Playwright compatibility (verified against the repo's `@playwright/test` 1.61
  bundle): `toBeChecked()` reads `aria-checked` on `role="checkbox"` elements, so the
  NeoCheckbox span satisfies the existing `toBeChecked()` / `.click()` assertions —
  **no e2e change needed for the checkbox**.

**Acceptance criteria:**

- Tick → survives reload (server-persisted); untick works; the "failing row reverts,
  working row sticks" e2e scenario stays green (per-row sequencing intact).
- 32px hit target, green fill, white 3.6-stroke check — matches `.cbox.big.ok`.

---

## UC-KG-005 "Odstrániť" — soft-cancel with inline confirm, and the paid-409 (Friend/host)

**Goal:** removal of a colleague's sub-order, restyled to the inline `.confirmbox`
pattern, with the refusal paths surfaced.

**Structure:**

- Trigger: `button.btn.ghost.sm` **"Odstrániť"**, `data-testid="guest-remove-{id}"`,
  in the foot's right group. Rendered only when `!cycleLocked && !isCancelled(subOrder)
  && confirmRemoveId !== subOrder.id` (unchanged conditions).
- Confirm: `div.confirmbox` (3px ink border, radius 10, warn-soft background), margin-top
  10, appended below the foot. Content: `<span>` copy verbatim —
  **"Objednávka kolegu sa zruší. Kolega ju uvidí ako zrušenú a už si ju nebude môcť
  upraviť."** — then `div.row` with `button.btn.sm.danger` **"Áno, odstrániť"**
  (label **"Odstraňujem..."** while `pending[id]`, both buttons disabled) and
  `button.btn.sm.ghost` **"Nie"** (clears `confirmRemoveId`).

**Business rules:**

- **Soft-cancel semantics** (§UC-GSO-008, unchanged): `removeSubOrder` calls
  `DELETE /api/guest-orders/:id`; on success the response row replaces the on-screen
  row **in place** — it re-renders as the cancelled card of UC-KG-003 rule 3 (dashed,
  60%, struck-through). The row never leaves the list; `totals` from the response
  update the summary line and (via the emit) module 04's badge.
- Removal ends at cycle lock: the trigger is absent when `cycleLocked` (409 `closed`
  server-side is the backstop, surfaced like any error if raced).
- **Paid-409 (the escalation case).** The server refuses deleting a paid sub-order
  with 409 `reason:'paid'` and message
  **"Táto objednávka je už zaplatená. Zrušenie vyriešte so správcom."**
  (`guest-orders.js` — the money the guest sent must keep a refund signal; GSO-T5).
  UI surfacing, pinned: the message renders **verbatim** in the panel-level
  `.banner.danger.slim` (UC-KG-001) — the server copy already carries the "escalate to
  the admin" instruction, so no client-side rewording; the confirmbox stays open (the
  host sees what was refused and can dismiss with "Nie"); the row is otherwise
  unchanged (still live, still paid-badged). The "Odstrániť" trigger stays visible on
  paid rows — hiding it would silently hide the escalation path; the refusal is the
  explanation. Under Decision 2 the host cannot resolve this themselves.
- One confirmbox at a time (`confirmRemoveId` is a single ref — opening one closes
  another; unchanged).

**Acceptance criteria:**

- Remove flow e2e holds: `guest-remove-{id}` → "Áno, odstrániť" →
  `guest-status-{id}` contains "Zrušené"; the row's DOM node persists.
- Removing a paid row: banner shows the server sentence verbatim, row stays live,
  admin-side refund queue is out of scope here (→ admin effort).
- Confirmbox matches theme: warn-soft fill, dark/ghost small buttons, 13.5px text.

---

## UC-KG-006 Share dialog — `GuestShareDialog.vue` on `NeoModal` (Friend/host)

**Goal:** the one shared dialog (FriendOrder panel + FriendPortal cycle cards — GSO-T2:
ONE instance reused across cycles) restyled as the prototype `ShareModal`.

**Component API unchanged:** props `open`, `cycleId`, `cycleName`; emits
`update:open`. The whole `<script setup>` sequencing survives verbatim: the
open-watcher with `loadSeq`, state reset on close, `saveLink` (create AND regenerate —
the server UPDATEs the token on the existing row, sub-orders preserved),
`toggleActive`, `nativeShare`. Only `copyLink`/`copied` are deleted (NeoCopyRow owns
them — resolved conflict 4).

**Structure — `NeoModal` (UC-DS-010) with:**

- `title`: **"Zdieľať s kolegami"**.
- `#subtitle` slot: `<b style="color:var(--ink)">{{ cycleName }}</b><br>` +
  **"Kolegovia si objednajú cez váš odkaz — bez registrácie. Zásielku prevezmete vy a
  odovzdáte im ju."** — the dialog MUST name the cycle (GSO-T2: several open cycles
  sit side by side in the portal; pinned by e2e `toContainText(cycleBName)`).
- `#footer`: `button.btn` **"Zavrieť"** → `emit('update:open', false)`.
- Body states (one at a time, top to bottom):
  1. **Error:** `div.banner.danger.slim` with `e.message` (any state, first).
  2. **Loading:** centered `div.sub` **"Načítavam..."**.
  3. **No link yet** (not designed in the prototype — composed from its primary-action
     pattern; copy pinned by e2e + GSO-T2 register): `p.sub`
     **"Odkaz ešte nie je vytvorený."** + `button.btn.accent.block`
     **"Vytvoriť odkaz"** (label **"Vytváram..."** + disabled while `saving`) →
     `saveLink()`.
  4. **Link exists:**
     - when `!link.active`: `div.banner.warn.slim` with `span.dot` —
       **"Odkaz je deaktivovaný** — kolegovia si cez neho nemôžu objednať."** (bold
       lead as prototype; pinned substring "Odkaz je deaktivovaný").
     - `NeoCopyRow :value="guestUrl"` (mono truncated value + "Kopírovať" →
       "Skopírované!" 2s flip per UC-DS-011), with `value-testid="guest-link-url"` —
       an **approved extension** to UC-DS-011: optional `value-testid` prop rendered
       as `data-testid` on the `.val` element (the testid must sit on the value node,
       not the row, so text assertions don't swallow the button label).
     - `button.btn.accent.block` with `NeoIcon name="share"` + **"Zdieľať odkaz"** →
       `nativeShare()`; rendered **only when `canNativeShare`** (resolved conflict 3).
     - Actions row `display:flex; gap:6px; flex-wrap:wrap`:
       `button.btn.ghost.sm` **"Deaktivovať odkaz"** / **"Znova aktivovať"**
       (disabled while `saving`) → `toggleActive()`; and, when `!confirmRegenerate`,
       `button.btn.ghost.sm` **"Vygenerovať nový odkaz"** → `confirmRegenerate = true`.
     - when `confirmRegenerate`: `div.confirmbox` — `<span>` **"Starý odkaz prestane
       fungovať.** Objednávky, ktoré vám kolegovia už poslali, zostanú zachované."**
       (bold lead) + `div.row`: `button.btn.sm.dark` **"Áno, vygenerovať"** (label
       **"Generujem..."** + disabled while `saving`) → `saveLink()`;
       `button.btn.sm.ghost` **"Zrušiť"** → `confirmRegenerate = false`.

**Business rules:**

- `guestUrl = origin + '/g/' + link.token` — the host sees the **link token only**;
  a guest's `order_token` is never exposed to the host anywhere in this module
  (GSO-T2 hard invariant).
- Deactivation is **reversible** (same button toggles back); regeneration keeps
  existing sub-orders (server UPDATEs the token — never DELETE+INSERT; the copy in
  the confirmbox states exactly that and must not be softened).
- The `loadSeq` guard is load-bearing, not legacy: one dialog instance serves every
  cycle card, and the "slow load … cannot overwrite" e2e reproduces the corruption it
  prevents. The restyle must not restructure the watcher, and `NeoModal`'s
  `open`-driven mount must keep the existing "clear on close, load on open" reset.
- `NeoModal` provides `role="dialog"`, Escape-close and scrim-close (`closable`
  default true) — the e2e presses Escape and expects `getByRole('dialog')` count 0;
  the dialog must emit `update:open(false)` from NeoModal's `close` event so the
  teleported layer unmounts.
- Share-sheet payload (`nativeShare`): text stays
  `` `Pridajte sa k mojej objednávke — ${cycleName || 'objednávkový cyklus'}` ``.
  `OPEN:` the share-sheet `title` is currently `'Objednávka Gorifi'` — the handoff
  rebrands the surface to Podpultovka but specifies no share-sheet payload; should it
  become `'Objednávka Podpultovka'`? Needs a product decision (it is user-visible in
  the OS share sheet).
- Entry points: this module's are the panel share row + empty-state CTA (UC-KG-001/002,
  hidden when locked); the portal cycle-card button ("Zdieľať s kolegami", open cycles
  only, `@click.stop`) is module 03's — both open THIS dialog with `cycleId`/`cycleName`.

**Acceptance criteria:**

- Side-by-side with `05-shot.png`: 4px-ink modal, uppercase display title, bold cycle
  name in subtitle, copyrow with soft-pink value field, full-width magenta share
  button.
- Create → URL matches `/\/g\/[A-Z2-9]{12,}$/` and equals the API's stored token;
  deactivate → warn banner appears and the OTHER cycle's link stays active (race e2e);
  regenerate → old token dead, sub-orders intact.
- Copy button flips "Kopírovať" → green "Skopírované!" for 2s; clipboard holds the
  full URL.

---

## UC-KG-007 Selector contract and verification (Friend/host)

**Goal:** exactly which e2e pins hold unchanged and which spec edits this module
explicitly authorizes (01-architecture: selectors change only when the module spec
says the DOM changes).

**Preserved verbatim (no e2e edit):**

| Pin | Where it lands after the restyle |
|---|---|
| `data-testid="guest-sub-orders"` | GuestSubOrders root container (UC-KG-001) |
| `guest-paid-badge` (+ texts "Zaplatené"/"Nezaplatené") | `.badge.ok`/`.badge.warn` (UC-KG-003) |
| `guest-delivered-{id}` + `.click()` + `toBeChecked()` | NeoCheckbox root, `role="checkbox"` + `aria-checked` (UC-KG-004 — verified compatible with Playwright 1.61) |
| `guest-remove-{id}`, button "Áno, odstrániť", "Nie" | UC-KG-005 |
| `guest-status-{id}` containing "Zrušené" | `.badge.muted` (UC-KG-003) |
| `guest-items-{id}` (ul, `li` count), `guest-items-toggle-{id}`, `guest-items-summary-{id}` (+ "N položky" texts) | UC-KG-003 (toggle/testids absent on cancelled rows — no spec exercises them there) |
| "Objednávate aj pre kolegov?", button "Zdieľať objednávku s kolegami", `guest-sub-orders` count 0 when empty | UC-KG-002 state A |
| `getByRole('dialog')`, Escape close, buttons "Vytvoriť odkaz" / "Kopírovať" / "Deaktivovať odkaz", substring "Odkaz je deaktivovaný", dialog names the cycle | UC-KG-006 |
| button `{ name: 'Zdieľať' }` count 0 in dialog without `navigator.share` | still 0 — the button is absent, not just relabeled (UC-KG-006) |
| buttons matching `/Zdieľať/` on the guests tab, hidden on own tab | share row "Zdieľať odkaz" / empty CTA (UC-KG-001/002); tab mechanics themselves → 04 |

**Authorized e2e edits (this module's DOM change — update `guest-link.spec.js` only):**

1. `guest-link-url` moves from a readonly `<Input>` to NeoCopyRow's `.val` `<div>`
   (via the `value-testid` prop). Replace, in all three occurrences:
   `urlField.inputValue()` → `urlField.textContent()` (then `.trim()` on the value),
   and `toHaveValue(regex)` → `toHaveText(regex)`. The element's text is always the
   FULL URL (CSS truncates visually only — UC-DS-011).
2. No other spec file changes. `guest-host-view.spec.js` runs unmodified.

**Verification procedure (inherited from UC-DS-014):**

- Full suite green from the **238 passed / 3 skipped** baseline (the two authorized
  assertion substitutions do not change counts).
- Fidelity: Playwright screenshots at 378px of (a) the kolegovia panel with live +
  cancelled rows, (b) the share modal, (c) the empty state — side-by-side with
  `04/05/06-shot.png`; recorded in the task PR (no visual-regression CI).
- Admin invariance re-assert: no admin view references `.suborder`, `.confirmbox`,
  `pp-*`, or `neo/` components (module 02's permanent rule).
- 320px width: no horizontal page overflow with a long guest name / long URL (the
  copyrow `.val` and the name block keep their `min-width:0` chains).

---

## Deliverables summary (files this module edits)

| Path | Action |
|---|---|
| `frontend/src/components/GuestSubOrders.vue` | template restyle (UC-KG-001, 003–005); script: only the `summary` emit gains `rows` |
| `frontend/src/components/GuestShareDialog.vue` | template restyle onto NeoModal/NeoCopyRow (UC-KG-006); script: drop `copyLink`/`copied` only |
| `frontend/src/views/FriendOrder.vue` | ONLY the `#panel-guests` fragment (share row, empty/locked states, gating on `rows`) — the tab shell, cartbar and own-order panel are module 04's |
| `frontend/src/components/neo/NeoCheckbox.vue` | approved extension: `disabled` prop (UC-KG-004) |
| `frontend/src/components/neo/NeoCopyRow.vue` | approved extension: `value-testid` prop (UC-KG-006) |
| `e2e/tests/guest-link.spec.js` | the two authorized assertion substitutions (UC-KG-007) |

Dependency note: this module needs 02 (primitives + stylesheet) and renders inside
`FriendOrder.vue`, whose `.app` root and tab shell are module 04's — the two modules'
tasks must land in 02 → (04 root) → 05 order, or 05's classes render unstyled.
