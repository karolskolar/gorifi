# Raw source: guest order recovery + admin controls (2026-08-26)

Source: production incident reported by the product owner + the working session
that diagnosed it (Claude Code session, 2026-08-26). PO decisions quoted below
are verbatim or near-verbatim. This file is the provenance for
`docs/specification/14-guest-order-recovery.md`.

## The incident (Martina Tomašová)

- Martina Tomašová ordered as a GUEST through a host's share link and PAID.
- She then changed her mind and wanted to cancel.
- Meanwhile her host (the friend who gave her the link) REGENERATED his share
  link — almost certainly not to revoke it, but reading "Vygenerovať nový odkaz"
  as the way to share with one more colleague.
- Her saved status/edit URL is `/g/:linkToken/o/:orderToken`;
  `resolveGuestOrder()` (backend/src/routes/guest.js) looks the order up by
  `order_token AND link_id`, resolving `link_id` from the CURRENT link token.
  Regeneration swapped the token on the same row (guest-links.js), so her URL's
  first half is dead → 404. Her order and `order_token` still exist in the DB.
- Nobody can reconstruct her URL: `order_token` is deliberately absent from
  every column list in `helpers/guest-orders.js` (GSO-T2 rule), so neither the
  host nor the admin can see it.
- Nobody can cancel the order either: the host's
  `DELETE /api/guest-orders/:id` returns 409 `reason:'paid'` (GSO-T5 rule:
  paid orders escalate to the admin), and the admin has NO cancel route at all
  (`guest-orders.js` admin surface is only `/paid` and `/unpaid`). The GSO-T5
  escalation is a dead end.

## PO requirements (verbatim intent)

1. "Ja ako administrátor by som mal vedieť link pre hosťa každého užívateľa
   (aby som im ho mohol v prípade potreby preposlať)."
2. "Mal by som vedieť v admin zrušiť objednávku registrovaného aj
   neregistrovaného užívateľa." — LATER NARROWED by the PO: admin cancel is
   for GUEST orders only, "lebo registrovaný užívateľ to už teraz vie spraviť"
   (a registered friend can already cancel their own order). Additional PO
   requirements on the cancel:
   - "Rušenie objednávky musí byť dostupné ešte pred uzavretím cyklu" — the
     capability must exist while the cycle is still open (the incident's state).
   - After an admin cancel, the cancelled order must remain VISIBLE under the
     host "ako potvrdenie, že objednávka existovala (a kto ju vytvoril) a že
     bola zrušená".
3. "Registrovaný užívateľ by mal mať možnosť kolegovi preposlať jeho unikátnu
   linku na už vytvorenú objednávku, takže by sa mala niekde v objednávkach
   ukladať." — Note: `guest_orders.order_token` already IS stored; the change
   is publishing it to the host (and admin), a conscious reversal of the
   GSO-T2 "never expose order_token" rule.

## PO decision on the share dialog copy

The share dialog (GuestShareDialog.vue) must say explicitly:
- generating a new link is EXPRESSLY for when the link leaked to the wrong
  group ("generovanie nového odkazu je vyslovene pri úniku linku do zlej
  skupiny");
- the SAME link is to be used for all colleagues ("pre rôznych kolegov sa má
  použiť ten istý odkaz").
Register: impersonal vy-form (GSO-T2 rule), no gendered participles.

## Confirmed product decisions (AskUserQuestion, 2026-08-26)

- **Module split:** one new module `14-guest-order-recovery.md`, UC prefix
  UC-GR; dialog copy (e) and order_token exposure (d) are written as
  amendments to modules 05/06 from within module 14.
- **Decouple (a): YES.** The guest's order status/edit URL stops depending on
  the share link. New form `/g/o/:orderToken` (page + API); the old pair form
  `/g/:linkToken/o/:orderToken` keeps working (people hold it in messages and
  in `localStorage.gorifi_guest_orders`). Regeneration fully keeps its purpose
  (revoking a leaked SHARE link — nobody new can order through the old URL)
  but no longer kills links to already-created orders. `order_token` has the
  same entropy as the link token (both `generateGuestToken()`, 14 chars,
  crypto RNG) — it is a full standalone credential.
- **Admin link powers (b): read + create.** Admin can see and copy every
  host's share link, and can create one for a friend who has not shared yet.
  Regenerate/deactivate (revocation) stays host-only — the admin must not be
  able to revoke a link the host has already distributed.
- **Admin cancel (c):** guest orders only. Soft cancel (same mechanism as the
  host's: `status='cancelled'`, `total=0`, item rows KEPT). NO paid blockade
  for the admin — a paid cancelled order lands in the EXISTING refund queue
  (`paid = 1 AND status = 'cancelled'`, `GET /api/guest-orders/cycle/:id/unpaid`).
  The host's own DELETE keeps its 409 `reason:'paid'` (Decision 2 escalation
  now has a working target instead of a dead end).

## Mechanism facts for the spec author (verified in code, 2026-08-26)

- `guest_orders.order_token TEXT UNIQUE NOT NULL` (schema.js) — no schema
  change needed for any of this.
- `routes/guest.js` is mounted BARE at `/api/guest` — the URL token IS the
  credential; hostile input boundary (GSO-T3 contract: 404/410/409/400).
- The read-side resolver is deliberately 404-only (GSO-T4): a locked cycle or
  deactivated link must still let the guest READ their order + payment
  reference. The new `/g/o/:orderToken` resolver must preserve this, and the
  write half re-applies the gates (410 inactive link/host, 409 non-open
  cycle, 409 cancelled, 409 paid-with-items).
- `cancelled` is TERMINAL (no edge back); `statusPayload.items_editable =
  editable && !paid` is the pinned shape GSO-T10's CTA rides on.
- `PATCH /api/guest-orders/:id/paid` (admin) writes NO `transactions` row —
  guests have no friend_id and no balance (Decision 1: they pay the admin
  directly). Any new admin cancel route must likewise write NO transactions
  row.
- `requireHost()` lives in `middleware/friend-auth.js`; `/api/guest-orders`
  is a MIXED router — mounted bare, gated per route. Never wrap the mount.
- Every new admin endpoint must be added to `ADMIN_ENDPOINTS` in
  `e2e/tests/api-security.spec.js` (CLAUDE.md rule).
- Stock: cancelled sub-orders release stock via the status predicate in
  `helpers/stock.js` (`COALESCE(status,'submitted') <> 'cancelled'`) — row
  deletion is never the mechanism.
- The host's "Objednávky kolegov" view (`GuestSubOrders.vue`) and the admin
  cycle detail (nested sub-orders) already render cancelled rows as neutral
  stone "Zrušené" — requirement 2's "stays visible as confirmation" builds on
  this, does not invent it.

## Follow-up PO requirements (added 2026-08-26, same session, after the module draft)

4. **Guest order-confirmation e-mail.** "Neregistrovaným užívateľom, ktorí
   vytvorili objednávku a zadali email, by mal prísť email s potvrdením
   objednávky a s linkom na vytvorenú objednávku, aby link mali uložený."
   - Only when the guest entered an e-mail (the field is optional at checkout).
   - The link in the mail is the CANONICAL `/g/o/:orderToken` form.
   - Infrastructure exists: `helpers/mailer.js` + module 08's branded
     multipart templates (shipped); mailer is a no-op without Mailgun config,
     so the send must be fire-and-forget — a mail failure must never fail the
     201 submit.

5. **PO clarifications on the draft's OPEN items (same session):**
   - Regeneration semantics confirmed understood: orders are never cancelled
     by regeneration; after this module the guests' order links survive it too.
   - Refund-queue resend affordance: PO default accepted = minimal placement
     (nested sub-order rows only), unless the PO says otherwise.
   - Deploy-continuity requirement made explicit: the module MUST be
     deployable mid-open-cycle without breaking existing share links or order
     URLs (no schema change, additive routes only, existing tokens untouched
     — and previously dead pair URLs come back to life, incl. the incident's).

## Out of scope (PO)

- A separate "what's in people's carts" statistic (PO: "Neskôr môžeme dorobiť
  samostatnú štatistiku, ktorá zobrazí čo ľudia majú v košíku") — explicitly
  later.
- Admin cancel of a registered friend's order (they can cancel their own).
- Any payment-flow change.
