// 18 §UC-PI-014 — THE TWO COFFEE SOURCES, DESCRIBED ONCE (PI-T8).
//
// ⚠⚠ ONE HOME, AND IT HAS A NAMED NON-CONSUMER.
//
//   MAY import this file:
//     · `components/PortalExplainer.vue`  — „Kto sme a odkiaľ je káva" (§UC-PI-012 item 5)
//     · `views/FriendOrder.vue`           — the product card's roastery badge + its
//                                           popover (§UC-PI-014)
//     · `components/GuestRoastersLine.vue` — module 19 §UC-GL-007, GL-T4 (SHIPPED).
//                                           It imports THIS file — labels, badge
//                                           classes AND the `short` parenthesis; a
//                                           second copy of the texts on the guest
//                                           surface is the defect this module exists
//                                           to prevent. Mounted on the open guest hero
//                                           (`GuestOrder.vue`) and, from GL-T5, on the
//                                           pre-open hero.
//
//   MUST NOT import this file:
//     · EVERY ADMIN SURFACE (`views/Admin*.vue`, `components/analytics/*`,
//       `components/ui/*`). Roastery administration keeps its own data — the admin
//       edits `products.roastery` as free text and must keep being able to name a
//       roastery this file has never heard of. These are marketing descriptions for
//       a friend or a guest, not a lookup table for a form. The boundary is asserted
//       in `portal-explainer.spec.js` §7 (a source sweep over `frontend/src`; §5 is the heading
//       and payment block — the section number was wrong here until the review, and a
//       pointer naming the wrong section is how the next reader concludes the guard does
//       not exist), not
//       merely asked for here, because „admin invariance" is this repo's standing
//       claim and an unmeasured boundary drifts silently.
//
// ⚠ DEPENDENCY-FREE PLAIN ESM — no Vue, no `@/` alias, no imports at all — so a
// Playwright worker can `import()` it directly. This project has no unit runner and
// that import IS the unit test (the `lib/history-badges.js`, `lib/cycle-stages.js`
// and `lib/payment-links.js` precedent). Nothing may be added here that needs a
// bundler to resolve.
//
// ⚠ THE TEXTS ARE THE PRODUCT OWNER'S, NOT THIS FILE'S OPINION. §UC-PI-014 marks
// both as `OPEN:` — prototype drafts the PO polishes. Reproduce, never improve. The
// Q13.a decision is recorded there too: the badge stays „Robo", there is no
// „domáce praženie" variant of it.

/**
 * The roasters, in the order the explainer renders them (§UC-PI-012 item 5).
 *
 * - `key`        stable id for a `v-for` — never rendered.
 * - `match`      what a `products.roastery` value has to look like. Anchored and
 *                case-insensitive; NOT global, so `.test()` here is stateless
 *                (a `/g/` regex would carry `lastIndex` between calls and answer
 *                differently on every second product card).
 * - `label`      the badge text and the popover's title.
 * - `badgeClass` the theme class BESIDE `badge` — `''` for Goriffee (the plain
 *                badge), `acc-o` for Robo. §UC-PI-014: an unknown roastery keeps
 *                today's `acc-o`, which is the CALLER's fallback, not a row here.
 * - `text`       the description, shown in the explainer card and in the popover.
 * - `short`      the PARENTHESIS after the badge on the guest roasters line (19
 *                §UC-GL-007 rule 4, prototype `G2Roasters`: „Káva od [Goriffee]
 *                (pražiareň) a [Robo] (domáci pražič, SCA výbery).") — GL-T4. Added HERE,
 *                not typed into `GuestRoastersLine.vue`, because 19 names this file the
 *                one home of the Goriffee / Robo texts: a second, shorter description in
 *                a component is the second copy this module exists to prevent. PO copy
 *                (Q13.a) — reproduce, never improve.
 */
export const ROASTERS = [
  {
    key: 'goriffee',
    match: /^goriffee$/i,
    label: 'Goriffee',
    badgeClass: '',
    text: 'Pražiareň — stály základ ponuky. Espresso aj filter, čerstvo pražené na objednávku.',
    short: 'pražiareň'
  },
  {
    key: 'robo',
    match: /^robo$/i,
    label: 'Robo',
    badgeClass: 'acc-o',
    text: 'Domáci pražič. Hľadá zelenú kávu s vysokým hodnotením SCA (Specialty Coffee Association) a praží ju sám, v malých dávkach — všetko pod jeho značkou je ručne pražené doma.',
    short: 'domáci pražič, SCA výbery'
  }
]

/**
 * The first `ROASTERS` entry whose `match` accepts this roastery name, else `null`.
 *
 * ⚠ TYPE-SAFE ON PURPOSE, and this is a deliberate reading of §UC-PI-014's
 * „`String(name).trim()`". `products.roastery` is a nullable TEXT column, so `null`
 * and `undefined` reach here on every product that has no roastery at all —
 * `String(null)` would build the string „null" and test two regexes against it to
 * learn what a type check answers for free. It also keeps a `Symbol` (which
 * `String()` THROWS on) from taking a product grid down, the same class of guard
 * `variantGrams()` carries for stock. Everything a real roastery value can be is a
 * string, so no reachable input behaves differently.
 *
 * ⚠ Returns the ENTRY, not a class or a label: every caller needs two or three of
 * its fields (badge class, title, text) and a helper per field is how the second
 * home gets built one accessor at a time.
 */
export function roasterFor(name) {
  if (typeof name !== 'string') return null
  const trimmed = name.trim()
  if (!trimmed) return null
  return ROASTERS.find((r) => r.match.test(trimmed)) || null
}
