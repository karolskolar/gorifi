<script setup>
// 19 §UC-GL-007 rule 4 — the guest ROASTERS LINE (GL-T4).
//
// ~~„Káva od [Goriffee] (pražiareň) a [Robo] (domáci pražič, SCA výbery)."~~ —
// SUPERSEDED by PO 2026-09-29: the guest reads the SAME full descriptions a member
// reads on „Ako to funguje" — one row per roaster, badge + `text`. The short
// parenthesis (`short`) is gone from `lib/roasters.js` with it.
//
// ⚠ EVERY roaster word comes from `lib/roasters.js` — label, badge class AND text.
// That file is module 18's ONE home of the Goriffee / Robo texts and this component
// is one of its three NAMED consumers (`portal-explainer.spec.js` §7 sweeps the
// importer set). Never a second copy of the texts.
//
// ⚠ STATIC: every `ROASTERS` entry, in the library's order, whatever the listing on
// the page happens to contain. It takes no products and no props, so GL-T5's pre-open
// hero mounts it exactly as the open hero does.
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
</script>

<template>
  <!-- `.sub` 13px; one row per roaster, badge then its full description. -->
  <div class="sub gr-line" data-testid="guest-roasters">
    <div v-for="r in ROASTERS" :key="r.key" class="gr-row" data-testid="guest-roaster">
      <span class="gr-badge" :class="r.badgeClass" data-testid="guest-roaster-badge">{{ r.label }}</span>
      <span class="gr-text">{{ r.text }}</span>
    </div>
  </div>
</template>

<style scoped>
.gr-line {
  font-size: 13px;
  line-height: 1.4;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.gr-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}
.gr-text {
  min-width: 0;
  overflow-wrap: anywhere;
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
  flex-shrink: 0;
  margin-top: 1px;
}
.gr-badge.acc-o { background: var(--hi); color: var(--nb-ink); }
</style>
