// The inline stroke glyphs of the Podpultovka Neobrutal theme (UC-DS-007):
// the canonical 14 from `ui.jsx` (`I`), then the v2 portal set from
// `portal2.jsx` (`I2`) added by PI-T2.
//
// This is the ONLY icon source for friend/guest surfaces — no icon font, no icon
// package, no new dependency. The table below is a mechanical 1:1 transcription of
// `docs/design/friends-portal-redesign/friends/ui.jsx` lines 5-18 (the prototype's
// `I` map): same shapes in the same order, same `d`/`cx`/`rx`… attribute values,
// same per-icon default size and stroke-width. The fat 3.6 stroke on `check` is
// deliberate — it is what makes the checkbox tick read at 14px.
//
// ⚠ The FOURTEEN `I` glyphs carry no `stroke-linecap`/`stroke-linejoin` and so
// declare none: they render with the SVG defaults (butt/miter), exactly as the
// prototype does. The `I2` glyphs added below DO set them where `portal2.jsx`
// does, so the table grew two OPTIONAL keys (`linecap`, `linejoin`) which
// `NeoIcon.vue` binds. Vue omits a binding whose value is `undefined`, so every
// one of the original fourteen still renders byte-identically. Colour is always `currentColor` — there is no fill or stroke
// prop; consumers set `color` on an ancestor.
//
// ⚠ This map lives in its own module, NOT inside `NeoIcon.vue`'s `<script setup>`,
// so it is allocated once per module rather than once per mounted icon. `<script
// setup>` compiles its body into `setup()`, so an inline literal — `gear`'s ~900
// char path included — would be rebuilt for every one of the dozens of icons an
// order screen mounts.
export const ICONS = {
  back: {
    size: 20,
    strokeWidth: '2.6',
    shapes: [
      { tag: 'path', attrs: { d: 'M15 18l-6-6 6-6' } }
    ]
  },
  chev: {
    size: 16,
    strokeWidth: '2.6',
    shapes: [
      { tag: 'path', attrs: { d: 'M9 18l6-6-6-6' } }
    ]
  },
  check: {
    size: 14,
    strokeWidth: '3.6',
    shapes: [
      { tag: 'path', attrs: { d: 'M20 6L9 17l-5-5' } }
    ]
  },
  share: {
    size: 17,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'circle', attrs: { cx: '6', cy: '12', r: '3' } },
      { tag: 'circle', attrs: { cx: '18', cy: '6', r: '3' } },
      { tag: 'circle', attrs: { cx: '18', cy: '18', r: '3' } },
      { tag: 'path', attrs: { d: 'M8.7 10.7l6.6-3.4M8.7 13.3l6.6 3.4' } }
    ]
  },
  gear: {
    size: 18,
    strokeWidth: '2',
    shapes: [
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } },
      { tag: 'path', attrs: { d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z' } }
    ]
  },
  pencil: {
    size: 16,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'path', attrs: { d: 'M12 20h9' } },
      { tag: 'path', attrs: { d: 'M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z' } }
    ]
  },
  logout: {
    size: 18,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'path', attrs: { d: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4' } },
      { tag: 'path', attrs: { d: 'M16 17l5-5-5-5M21 12H9' } }
    ]
  },
  close: {
    size: 18,
    strokeWidth: '2.6',
    shapes: [
      { tag: 'path', attrs: { d: 'M18 6L6 18M6 6l12 12' } }
    ]
  },
  copy: {
    size: 15,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'rect', attrs: { x: '9', y: '9', width: '13', height: '13', rx: '2' } },
      { tag: 'path', attrs: { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' } }
    ]
  },
  lock: {
    size: 17,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'rect', attrs: { x: '4', y: '11', width: '16', height: '10', rx: '2' } },
      { tag: 'path', attrs: { d: 'M8 11V7a4 4 0 0 1 8 0v4' } }
    ]
  },
  cal: {
    size: 15,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'rect', attrs: { x: '3', y: '4', width: '18', height: '18', rx: '2' } },
      { tag: 'path', attrs: { d: 'M16 2v4M8 2v4M3 10h18' } }
    ]
  },
  invite: {
    size: 17,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'path', attrs: { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' } },
      { tag: 'circle', attrs: { cx: '9', cy: '7', r: '4' } },
      { tag: 'path', attrs: { d: 'M19 8v6M22 11h-6' } }
    ]
  },
  eye: {
    size: 17,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'path', attrs: { d: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' } },
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '3' } }
    ]
  },
  warn: {
    size: 17,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'path', attrs: { d: 'M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z' } },
      { tag: 'path', attrs: { d: 'M12 9v4M12 17h.01' } }
    ]
  },
  // ── I2 (prototype `portal2.jsx`, the v2 portal's own set) ──────────────────
  // ⚠ Transcribed on the same rules as the 14 above: same shapes, same order,
  // same attribute values, same default size and stroke-width. The I2 glyphs
  // DO carry `stroke-linecap` / `stroke-linejoin` where the prototype sets them
  // — the v1 set does not, and the difference is real, not an oversight — so
  // they are declared per icon below and `NeoIcon.vue` passes them through.
  //
  // PI-T2 ports the six the appbar and the drawer need (18 §UC-PI-003/004), and
  // PI-T5 adds `pin` for §UC-PI-007's own-order pickup badge.
  // ⚠ SEAM: PI-T8 (the explainer) and GL-T4 (the guest steps) add `cup`, `box`,
  // `hand`, `truck`, `pause`, `bell` from the same table — to THIS file,
  // never a second icon module (RD-DS-2).
  menu: {
    size: 20,
    strokeWidth: '2.6',
    linecap: 'round',
    shapes: [
      { tag: 'path', attrs: { d: 'M3 6h18M3 12h18M3 18h18' } }
    ]
  },
  bag: {
    size: 20,
    strokeWidth: '2.2',
    linejoin: 'round',
    shapes: [
      { tag: 'path', attrs: { d: 'M6 7h12l1 14H5z' } },
      { tag: 'path', attrs: { d: 'M9 7V5a3 3 0 0 1 6 0v2' } }
    ]
  },
  list: {
    size: 20,
    strokeWidth: '2.2',
    linecap: 'round',
    shapes: [
      { tag: 'path', attrs: { d: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' } }
    ]
  },
  wallet: {
    size: 20,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'rect', attrs: { x: '2', y: '6', width: '20', height: '14', rx: '2' } },
      { tag: 'path', attrs: { d: 'M2 10h20M16 15h2' } }
    ]
  },
  help: {
    size: 20,
    strokeWidth: '2.2',
    linecap: 'round',
    shapes: [
      { tag: 'circle', attrs: { cx: '12', cy: '12', r: '10' } },
      { tag: 'path', attrs: { d: 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 2-3 4M12 17h.01' } }
    ]
  },
  user: {
    size: 20,
    strokeWidth: '2.2',
    shapes: [
      { tag: 'path', attrs: { d: 'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2' } },
      { tag: 'circle', attrs: { cx: '12', cy: '7', r: '4' } }
    ]
  },
  // `portal2.jsx` I2.pin — 14px, because it sits INSIDE a `.badge` beside text
  // (§UC-PI-007's pickup row), not on a 44px control like the drawer's glyphs.
  pin: {
    size: 14,
    strokeWidth: '2.4',
    shapes: [
      { tag: 'path', attrs: { d: 'M21 10c0 7-9 12-9 12S3 17 3 10a9 9 0 0 1 18 0z' } },
      { tag: 'circle', attrs: { cx: '12', cy: '10', r: '3' } }
    ]
  }
}
