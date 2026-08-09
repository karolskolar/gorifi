// Category-tab snapping (UC-DS-012) — verbatim math from ui.jsx `window.snapTab`.
//
// Tapping a tab in a horizontally scrolling strip (`.cat-tabs`) CENTERS it in the
// strip. The mechanism is `parent.scrollTo`, and that is the whole point: the obvious
// alternative, `el.scrollIntoView()`, also scrolls the nearest scrollable ANCESTOR —
// i.e. the page — so tapping a category would jump the document vertically under the
// user's thumb. Never swap it in.
//
// `Math.max(0, …)` clamps the first few tabs, whose ideal centred offset is negative.
// The strip is sticky (z-index 40) and scrolls within itself, which is also what keeps
// the 320px no-horizontal-overflow guarantee (`e2e/tests/mobile-no-h-overflow.spec.js`).
//
// `e.currentTarget` — not `e.target` — so a click landing on something nested inside
// the tab (a count badge, an icon) still measures the tab itself.
//
// Consumed by the friend order screen's cat-tabs (module 04) and the guest grid's tabs
// (module 06).
export function snapTab(e) {
  const el = e.currentTarget, p = el.parentNode
  p.scrollTo({ left: Math.max(0, el.offsetLeft - (p.clientWidth - el.offsetWidth) / 2), behavior: 'smooth' })
}
