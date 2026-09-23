<script setup>
// 19 §UC-GL-007 rule 4 — the guest ROASTERS LINE (GL-T4), prototype `G2Roasters`:
//
//   „Káva od [Goriffee] (pražiareň) a [Robo] (domáci pražič, SCA výbery)."
//
// ⚠ EVERY roaster word comes from `lib/roasters.js` — label, badge class AND the
// parenthesis (`short`). That file is module 18's ONE home of the Goriffee / Robo
// texts and this component is one of its three NAMED consumers
// (`portal-explainer.spec.js` §7 sweeps the importer set). Only the connectives
// („Káva od", „ a", the final period) live here. Never a second copy of the texts.
//
// ⚠ STATIC by spec: the line names every `ROASTERS` entry, in the library's order,
// whatever the listing on the page happens to contain — 19 transcribes it as a fixed
// sentence (Q13.a, „PO polishes"). It takes no products and no props, so GL-T5's
// pre-open hero mounts it exactly as the open hero does.
//
// ⚠ CANON DEVIATION, deliberate: the two badges are NOT `class="badge"`. They carry the
// theme `.badge` declarations (+ the prototype's inline 11px / `2px 7px`) in a scoped
// class. The open hero's shipped pin `guest-order-shell.spec.js` counts
// `hero.locator('.badge')` = 3 (the „Login netreba" row) and the pre-open hero's pin
// `guest-invite-dead.spec.js` resolves `hero.locator('.badge')` strictly („Zatvorené");
// 19 §UC-GL-011 item 2 keeps both passing unmodified, and this line sits INSIDE both
// heroes. Same pixels (asserted computed-style-equal to a real `.badge` in
// `guest-standing-link.spec.js`), different selector. `badgeClass` from the library
// (`''` / `acc-o`) is kept beside it, with the `acc-o` fill re-declared below.
import { ROASTERS } from '../lib/roasters.js'

const last = ROASTERS.length - 1
// The joiner after entry i: „ a" before the last one, „," between earlier ones, „." at
// the end — the prototype's sentence for two entries, and a grammatical one for more.
function tail(i) {
  if (i === last) return '.'
  return i === last - 1 ? ' a' : ','
}
</script>

<template>
  <!-- Canon: `.sub` 13px, flex, centred, gap 6, wrap. The text runs are flex items of
       their own (the prototype's anonymous items made explicit), so the 6px gap — not a
       space — separates them from the badges. -->
  <div class="sub gr-line" data-testid="guest-roasters">
    <span>Káva od</span>
    <template v-for="(r, i) in ROASTERS" :key="r.key">
      <span class="gr-badge" :class="r.badgeClass" data-testid="guest-roaster-badge">{{ r.label }}</span>
      <span>({{ r.short }}){{ tail(i) }}</span>
    </template>
  </div>
</template>

<style scoped>
.gr-line {
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  min-width: 0;
}

/* The theme's `.badge` rule (friends-theme.css:82, + A10's `line-height:normal`) with the
   prototype's inline `fontSize:11, padding:"2px 7px"` — see the header for why the class
   itself is not used. */
.gr-badge {
  font-family: var(--font-body);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 6px;
  border: 2px solid var(--nb-ink);
  background: #fff;
  color: var(--ink);
  white-space: nowrap;
  display: inline-block;
  line-height: normal;
}
.gr-badge.acc-o { background: var(--hi); color: var(--nb-ink); }
</style>
