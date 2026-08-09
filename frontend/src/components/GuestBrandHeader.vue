<script setup>
// The guest chrome (06 §UC-GX-001) — ONE home for every guest screen: g-order,
// g-confirm, g-status and g-dead. It composes `BrandChrome` (02 §UC-DS-006) with
// the three things that are constant across the whole unregistered surface:
//
//   · the WORDMARK instead of a screen title. A guest has no friend record and no
//     cycle context in the appbar — `guest.jsx GuestHeader` shows "Podpultovka"
//     with the middle syllable in accent magenta. `BrandChrome`'s `#titles` slot
//     FILLS `.titles` rather than replacing it, which is exactly what this needs:
//     the theme styles the wordmark by descent (`.appbar .titles .t`), so the span
//     must keep its `.titles` ancestor.
//   · the "Bez účtu" chip (`.chip.acc` — magenta, rotated −2°, ink shadow), the
//     one piece of state a guest screen has to announce.
//   · the ticker, identical on every guest screen and for coffee and bakery alike
//     (06 §UC-GX-001 item 2) — unlike the friend order, whose ticker flips with the
//     lock. Held as a module-level constant, not a prop with a default, so no
//     caller can fork it.
//
// Only `subtitle` varies per screen ("Objednávka cez odkaz", "Objednávka
// odoslaná", "Vaša objednávka", "Úprava objednávky"), which is why it is the
// component's only prop. The default is the prototype's own
// (`sub || "Spoločná objednávka"`).
//
// ⚠ NO leading slot / back chevron: a guest arrived from a chat message, not from
// a list inside this app, so there is nowhere in-app to go back to.

import BrandChrome from '@/components/neo/BrandChrome.vue'

defineProps({
  subtitle: { type: String, default: 'Spoločná objednávka' }
})

const GUEST_TICKER = '+++ KÁVA POD PULTOM +++ BEZ ÚČTU · BEZ REČÍ +++ POŠLI ODKAZ ĎALEJ +++'

// `BrandChrome` is itself multi-root (appbar + hazard + ticker), so this wrapper
// is multi-root too and Vue has no single node to put fallthrough attrs on. The
// structure is a fidelity contract and full-bleed — nothing may be spread onto it
// — so the warning would only ever be noise.
defineOptions({ inheritAttrs: false })
</script>

<template>
  <BrandChrome :ticker="GUEST_TICKER">
    <template #titles>
      <span class="t">Pod<span style="color:var(--accent)">pult</span>ovka</span>
      <span class="s">{{ subtitle }}</span>
    </template>
    <template #trailing>
      <span class="chip acc">Bez účtu</span>
    </template>
  </BrandChrome>
</template>
