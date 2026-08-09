// The 14 inline stroke glyphs of the Podpultovka Neobrutal theme (UC-DS-007).
//
// This is the ONLY icon source for friend/guest surfaces — no icon font, no icon
// package, no new dependency. The table below is a mechanical 1:1 transcription of
// `docs/design/friends-portal-redesign/friends/ui.jsx` lines 5-18 (the prototype's
// `I` map): same shapes in the same order, same `d`/`cx`/`rx`… attribute values,
// same per-icon default size and stroke-width. The fat 3.6 stroke on `check` is
// deliberate — it is what makes the checkbox tick read at 14px.
//
// The source svgs carry no `stroke-linecap`/`stroke-linejoin`, so neither does
// `NeoIcon.vue`: the glyphs render with the SVG defaults (butt/miter), exactly as
// the prototype does. Colour is always `currentColor` — there is no fill or stroke
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
  }
}
