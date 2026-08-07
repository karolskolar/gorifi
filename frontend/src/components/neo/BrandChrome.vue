<script setup>
// The per-screen header stack (UC-DS-006): black appbar → 10px hazard tape →
// magenta ticker. Every friend AND guest screen mounts it as the first child of its
// `.app` root, full-bleed — the page column starts below it.
//
// NOT sticky (UC-DS-005): the chrome scrolls away, `.cat-tabs` owns the top edge.
//
// The ticker is STATIC — the segment is repeated exactly 3× inside one `<span>`,
// separated by two `&nbsp;` each, and clipped by `.ticker`'s `overflow:hidden`.
// The README calls it a "marquee", but the canonical `theme.css` defines no
// `@keyframes` and no `animation`, and the stylesheet wins (02-design-system
// "Resolved conflicts" #1). Adding an animation here is a fidelity bug.
//
// This module owns only the DEFAULT ticker string (ui.jsx's own default); per-screen
// copy is passed in by the consuming screen module, verbatim from the prototype.
//
// SLOT ORDER inside `.appbar` (UC-DS-006):
//   #leading · .titles (#titles) · #after-titles · .grow · #trailing
// `#after-titles` exists because the portal's pencil sits BETWEEN `.titles` and the
// spacer (`friends/portal.jsx:101`; `screenshots/02-shot.png` shows it next to
// "LEGO", not at the right edge). `#trailing` renders AFTER `.grow` and would fling
// it to the far edge; `#leading` is the wrong side; and `.titles` is
// `flex-direction:column`, so `#titles` would stack it under the name.
// No comment lives in the template — Vue keeps template comments in the DOM in dev
// builds, and this component's rendered markup is a fidelity contract.

import { computed } from 'vue'

const props = defineProps({
  // Required unless the `#titles` slot is used. That slot fills the `.titles` block
  // rather than replacing it, because the theme styles the children by descent
  // (`.appbar .titles .t`) — the wordmark override is a bare
  // `<span class="t">Pod<span style="color:var(--accent)">pult</span>ovka</span>`
  // and must keep its `.titles` ancestor to pick up the display font.
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  ticker: {
    type: String,
    default: '+++ TOVAR POD PULTOM +++ IBA PRE STÁLYCH +++'
  },
  // OPT-IN interactivity for the `.titles` block (UC-DS-006 amendment, RD-DS-5).
  //
  // The portal's authenticated appbar puts `cursor:pointer` AND an onClick on the
  // `.titles` div ITSELF (`friends/portal.jsx:97`), which no consumer could reach:
  // `.titles` is component-owned and the `#titles` slot fills it rather than
  // replacing it. This prop is the seam.
  //
  // It carries the ACCESSIBLE LABEL, not a boolean, on purpose: `.titles` holds the
  // friend's name and code, so as a bare `role="button"` it would announce
  // "LEGO lego-4821, button" — the name of the person, never the name of the action.
  // Folding "is it interactive" and "what does it announce" into one prop makes an
  // unlabelled interactive titles block impossible to ship. It also keeps the
  // no-op default honest: empty string ⇒ NOTHING is added (no role, no tabindex, no
  // cursor, no listener), so a non-interactive appbar renders byte-identically.
  //
  // Deliberately NOT a `titlesClass` prop: a class can paint `cursor:pointer` but
  // cannot attach a handler, so the affordance and the behaviour would be separable
  // and a consumer could ship a block that looks clickable and does nothing.
  titlesAction: { type: String, default: '' }
})

const emit = defineEmits(['titles-click'])

// The prototype's titles block is a plain div with an onClick — unreachable by
// keyboard and announcing as nothing. The ARIA layer below is the codebase's house
// zero-pixel enhancement (NeoCheckbox, NeoModal's `.m-x`, RD-FL-2's eye toggle):
// role + tabindex + label + Enter/Space, rendering no extra pixel. Both keys
// preventDefault so Space cannot also scroll the page.
//
// Bound as ONE object so the inactive case adds no attribute and no listener at all
// — `v-bind="{}"` emits nothing, whereas a static `@click` would always register a
// handler even when it is a no-op.
const titlesAttrs = computed(() => {
  if (!props.titlesAction) return {}
  return {
    role: 'button',
    tabindex: 0,
    'aria-label': props.titlesAction,
    // Inline, exactly as the prototype writes it — `.titles` has no cursor rule in
    // the canonical stylesheet and `friends-theme.css` is a byte-for-byte port.
    style: 'cursor:pointer',
    onClick: () => emit('titles-click'),
    onKeydown: onTitlesKeydown
  }
})

function onTitlesKeydown(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return
  e.preventDefault()
  emit('titles-click')
}

// Multi-root template (appbar + hazard + ticker are siblings), so Vue cannot pick a
// root for fallthrough attributes and would warn about extraneous ones. The structure
// is fixed by the spec and full-bleed, so nothing may be spread onto it anyway.
// `title` is a declared prop, which is also what keeps it from landing on the appbar
// as a native HTML `title=` tooltip attribute.
defineOptions({ inheritAttrs: false })
</script>

<template>
  <div class="appbar">
    <slot name="leading" />
    <div class="titles" v-bind="titlesAttrs">
      <slot name="titles">
        <span class="t">{{ title }}</span>
        <span v-if="subtitle" class="s">{{ subtitle }}</span>
      </slot>
    </div>
    <slot name="after-titles" />
    <div class="grow"></div>
    <slot name="trailing" />
  </div>
  <div class="hazard"></div>
  <div class="ticker"><span>{{ ticker }}&nbsp;&nbsp;{{ ticker }}&nbsp;&nbsp;{{ ticker }}</span></div>
</template>
