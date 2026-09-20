// Slovak count phrases that more than one surface prints.
//
// `colleaguesLabel` was private to `components/GuestSubOrders.vue` (the host's
// "Objednávky kolegov" tab, which counts its own loaded rows) until the portal
// cycle card's share row started printing the same phrase from a different
// source (the link's server-side `totals.count`). Two copies of a three-branch
// declension is exactly how one screen ends up reading "3 kolegov".
//
// 1 kolega / 2-4 kolegovia / 5+ kolegov.
export function colleaguesLabel(count) {
  const n = Number(count) || 0
  if (n === 1) return '1 kolega'
  if (n >= 2 && n <= 4) return `${n} kolegovia`
  return `${n} kolegov`
}

// 1 hosť / 2-4 hostia / 5+ hostí — the nested-guest count on a distribution board
// row („+2 hostia", 16 §UC-DP-011). Same three-branch shape as `colleaguesLabel`
// and DELIBERATELY not the same words: „kolega" is what a HOST calls the people
// ordering through their link, „hosť" is what the ADMIN's board calls the bags
// travelling inside a host's parcel. One home each, so neither screen drifts into
// the other's vocabulary.
//
// ⚠ The „+" is the CALLER's — the badge reads „+2 hostia" but the same phrase is
// wanted without a sign wherever it is not a delta.
export function guestsLabel(count) {
  const n = Number(count) || 0
  if (n === 1) return '1 hosť'
  if (n >= 2 && n <= 4) return `${n} hostia`
  return `${n} hostí`
}

// 1 objednávku / 2-4 objednávky / 5+ objednávok — the ACCUSATIVE case, and the case
// is the point. The one sentence that prints this puts it after "máte"
// ("Cez tento odkaz už máte 2 objednávky od kolegov" — GuestShareDialog's
// regeneration block), and the accusative is what lets that sentence carry ANY count
// with a single verb form. The nominative would drag the verb into the declension
// too ("existuje 1 / existujú 2 / existuje 5"), turning a three-branch rule into a
// six-branch one — which is the mistake this module exists to prevent.
export function ordersAccusativeLabel(count) {
  const n = Number(count) || 0
  if (n === 1) return '1 objednávku'
  if (n >= 2 && n <= 4) return `${n} objednávky`
  return `${n} objednávok`
}

// 1 balíček / 2-4 balíčky / 5+ balíčkov — one BAG, i.e. one party's whole
// collection (a host and the guest bags travelling inside their parcel count as
// ONE balíček, the same unit `plan[].count` and `totals.count` use).
//
// Printed by the distribution board's totals line, every group header badge, the
// bulk-hand-over confirm modal and its toast (16 §UC-DP-010/012) — four surfaces
// for one phrase, which is exactly the condition this module exists for. 0 takes
// the genitive plural ("0 balíčkov"), like `itemsLabel`.
export function bagsLabel(count) {
  const n = Number(count) || 0
  if (n === 1) return '1 balíček'
  if (n >= 2 && n <= 4) return `${n} balíčky`
  return `${n} balíčkov`
}

// The two participles that AGREE with `bagsLabel`'s count noun, as the bare word:
// "zabalený" / "zabalené" / "zabalených" and "odovzdaný" / "odovzdané" /
// "odovzdaných" (nominative, masculine inanimate — „balíček" is the noun they
// describe, and no reader is addressed, so the vy-form register is untouched).
//
// ⚠ Exported as the ADJECTIVE ALONE, not as "{n} zabalený", because the two
// consumers need it in two positions: the board's totals line reads
// „2 zabalené" (count + participle) while the toast reads „2 balíčky odovzdané"
// (bagsLabel + participle). A function that baked the number in would force the
// second one to re-declense the count noun by hand — the six-branch mistake
// `ordersAccusativeLabel` documents.
export function packedAdjective(count) {
  const n = Number(count) || 0
  if (n === 1) return 'zabalený'
  if (n >= 2 && n <= 4) return 'zabalené'
  return 'zabalených'
}

export function handedAdjective(count) {
  const n = Number(count) || 0
  if (n === 1) return 'odovzdaný'
  if (n >= 2 && n <= 4) return 'odovzdané'
  return 'odovzdaných'
}

// The VERB that agrees with `bagsLabel`'s count in the bulk-hand-over confirm
// subtitle (16 §UC-DP-012): „1 balíček prejde" / „2 balíčky prejdú" /
// „5 balíčkov prejde" — 2-4 takes the plural, 1 and 5+ take the singular, because
// the genitive-plural form of 5+ governs a singular verb in Slovak.
//
// ⚠ Why this exists at all, and why it is NOT the six-branch mistake
// `ordersAccusativeLabel` warns about: §UC-DP-012 writes the subtitle as
// „{ready} balíčkov prejde do stavu Odovzdané." and adds „(plural per bagsLabel)",
// i.e. it asks for the NOUN to be declined. Declining only the noun produces
// „2 balíčky prejde" — broken Slovak on an admin screen, which CLAUDE.md's
// language rule does not allow. Two branches in one home is the smallest thing
// that fixes it; the alternative (baking the whole sentence into plural.js)
// would move the copy away from the view that owns it. ⚠ Recorded for the
// module-16 closeout (DP-T8) as a spec-text line for the PO, not a silent change.
export function bagsMoveVerb(count) {
  const n = Number(count) || 0
  return n >= 2 && n <= 4 ? 'prejdú' : 'prejde'
}

// 1 položka / 2-4 položky / 5+ položiek — the cart-line count in the `.cartbar`
// fold's own label. 0 takes the same form as 5+ ("0 položiek"), which is the
// correct Slovak genitive plural and not a fallback.
export function itemsLabel(count) {
  const n = Number(count) || 0
  if (n === 1) return '1 položka'
  if (n >= 2 && n <= 4) return `${n} položky`
  return `${n} položiek`
}

// 1 deň / 2-4 dni / 5+ dní — the ACCUSATIVE after „o", because the only sentence
// that prints it is `lib/cycle-stages.js inWeeksText()`'s „o 3 dni" (17 §UC-CS-005,
// PO decision O6). Slovak „deň" happens to be identical in the nominative and the
// accusative singular, so the case is invisible in the 1-branch and visible only in
// the 2-4 one („dni", not „dní").
//
// ⚠ These two live HERE and not in `cycle-stages.js` for the reason this whole file
// exists: the declension is the shared thing, the sentence around it is not. Module
// 19's pre-open page prints the same „o n týždňov" from `nextOpeningText()`, and
// module 21's notification copy is the next candidate — a second three-branch copy
// is how one screen ends up reading „o 3 týždňov".
export function daysLabel(count) {
  const n = Number(count) || 0
  if (n === 1) return '1 deň'
  if (n >= 2 && n <= 4) return `${n} dni`
  return `${n} dní`
}

// 1 týždeň / 2-4 týždne / 5+ týždňov — the accusative after „o" again, and the
// prototype's exact form („o 4 týždne", `portal2.jsx` P2.next.inWeeks).
export function weeksLabel(count) {
  const n = Number(count) || 0
  if (n === 1) return '1 týždeň'
  if (n >= 2 && n <= 4) return `${n} týždne`
  return `${n} týždňov`
}
