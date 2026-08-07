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

defineProps({
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
  }
})

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
    <div class="titles">
      <slot name="titles">
        <span class="t">{{ title }}</span>
        <span v-if="subtitle" class="s">{{ subtitle }}</span>
      </slot>
    </div>
    <div class="grow"></div>
    <slot name="trailing" />
  </div>
  <div class="hazard"></div>
  <div class="ticker"><span>{{ ticker }}&nbsp;&nbsp;{{ ticker }}&nbsp;&nbsp;{{ ticker }}</span></div>
</template>
