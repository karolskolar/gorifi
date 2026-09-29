<script setup>
// 19 §UC-GL-007 — the 3-step GUEST explainer (GL-T4). ONE component, two layouts:
//
//   · `compact` — three centred columns, titles only: the strip on the OPEN guest hero
//     (`GuestOrder.vue`, `data-testid="guest-steps-compact"`), and again, in the FULL
//     layout, under that hero's „Viac o tom, ako to funguje" toggle;
//   · full (default) — a vertical list with the details: the toggle's detail AND, from
//     GL-T5, the pre-open page's „Ako to funguje" card. GL-T5 mounts THIS component —
//     never a second step list (one-home rule, CLAUDE.md „extend, never fork").
//
// Transcribed from the prototype's `G2Steps` (`docs/design/friends-portal-redesign/
// friends/guest2.jsx`): tile 44 (34 compact), 3px ink border, radius 10, `3px 3px 0`
// ink shadow, a 20px magenta numbered dot at the top-left corner; full = column gap 14
// (row gap 12), compact = row gap 8 (column gap 8). Titles `.display` 19 / 14 with the
// canon's `line-height:1`; details `.sub` 13.5 / 1.4 / margin-top 4 — the canon
// DECLARES both line-heights, so they are used verbatim, not A10's `normal` (CLAUDE.md
// PI-T12 rule).
//
// ⚠ CANON DEVIATION, deliberate: the numbered dot is NOT `class="mono"`. It carries
// `.mono`'s two declarations (`font-family: var(--font-mono)` + `letter-spacing:.01em`)
// in a scoped class instead. The open hero's shipped pin
// `guest-order-shell.spec.js` resolves the deadline line as `hero.locator('.mono')`
// under Playwright's strict mode, and 19 §UC-GL-011 item 2 says that file passes
// UNMODIFIED — three more `.mono` elements inside `.card.hl` would turn that pin into
// a strict-mode violation. Same pixels, different selector.
//
// ⚠ The step texts are CONSTANTS HERE on purpose (19: „guest-specific, they do not
// exist in module 18's six-step content") — unlike the roasters line, which reads
// `lib/roasters.js`. DRAFT PO copy: reproduce, never improve.
//
// ⚠ `packeta` DEFAULTS OFF. Step 3's „…, alebo si ju nechajte poslať cez Packetu." is
// TRUE only once module 20 ships guest Packeta; until then the detail ends „Od {host}.".
// GP-T3 flips it on when `cycle.parcel_enabled`. Nobody „fixes" the missing clause
// early (19 §Accepted risks).
//
// Icons: `NeoIcon` `cup` / `box` / `hand` — the I2 glyphs PI-T8 already added to the ONE
// icon module (`neo/icons.js`); inline SVG, no request (CSP). This file draws no `<svg>`.
import NeoIcon from '@/components/neo/NeoIcon.vue'

const props = defineProps({
  compact: { type: Boolean, default: false },
  // The host's FIRST name (`host.first_name` on the guest payloads) — interpolated into
  // step 3 only, and only in the full layout (compact renders no details).
  hostName: { type: String, default: '' },
  packeta: { type: Boolean, default: false }
})

const HOST = '{host}'
const PACKETA_CLAUSE = ', alebo si ju nechaj poslať cez Packetu.'

// `G2.steps`, verbatim. Step 3's detail is split at the Packeta clause so the prop
// can append it; `props.packeta` true ⇒ the prototype sentence byte for byte.
const STEPS = [
  { icon: 'cup', title: 'Objednáš', detail: 'Vyberieš kávu, zadáš meno a mobil. Bez registrácie.' },
  { icon: 'box', title: 'Zabalíme', detail: 'Kávu nakúpime v pražiarni a zabalíme. Vtedy zaplatíš cez QR alebo Revolut.' },
  { icon: 'hand', title: 'Prevezmeš', detail: `Od ${HOST}`, packetaTail: true }
]

// [before, after] around the host name — the name renders in its own
// `data-user-copy` span (a person typed it; FUP-T22 / `e2e/helpers/copy-sweep.js`).
function detailParts(step) {
  const text = step.packetaTail ? step.detail + (props.packeta ? PACKETA_CLAUSE : '.') : step.detail
  const at = text.indexOf(HOST)
  if (at < 0) return { before: text, host: false, after: '' }
  return { before: text.slice(0, at), host: true, after: text.slice(at + HOST.length) }
}
</script>

<template>
  <div class="gs" :class="{ 'gs-compact': compact }">
    <div v-for="(step, i) in STEPS" :key="step.icon" class="gs-step" data-testid="guest-step">
      <div class="gs-tile">
        <NeoIcon :name="step.icon" :size="compact ? 16 : 20" />
        <span class="gs-n" data-testid="guest-step-n">{{ i + 1 }}</span>
      </div>
      <div class="gs-text">
        <div class="display gs-title" data-testid="guest-step-title">{{ step.title }}</div>
        <div v-if="!compact" class="sub gs-detail" data-testid="guest-step-detail">
          {{ detailParts(step).before }}<span v-if="detailParts(step).host" data-user-copy>{{ hostName }}</span>{{ detailParts(step).after }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gs { display: flex; flex-direction: column; gap: 14px; }
.gs-compact { flex-direction: row; gap: 8px; }

.gs-step { display: flex; flex-direction: row; gap: 12px; align-items: flex-start; text-align: left; min-width: 0; }
.gs-compact .gs-step { flex-direction: column; gap: 8px; align-items: center; text-align: center; flex: 1; }

.gs-tile {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  border: 3px solid var(--nb-ink);
  border-radius: 10px;
  background: #fff;
  box-shadow: 3px 3px 0 var(--nb-ink);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  color: var(--nb-ink);
}
.gs-compact .gs-tile { width: 34px; height: 34px; }

/* `.mono`'s declarations, NOT the class — see the header's canon deviation. */
.gs-n {
  position: absolute;
  top: -9px;
  left: -9px;
  width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-ink);
  border: 2px solid var(--nb-ink);
  font-family: var(--font-mono);
  letter-spacing: 0.01em;
  font-size: 10.5px;
  font-weight: 700;
  line-height: normal;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* `overflow-wrap:anywhere` only on the DETAIL (a long host name); a title breaking
   mid-word would be the defect §UC-GL-007's 320px criterion forbids. */
.gs-text { min-width: 0; }
.gs-detail { overflow-wrap: anywhere; }
.gs-title { font-size: 19px; line-height: 1; }
.gs-compact .gs-title { font-size: 14px; }
.gs-detail { font-size: 13.5px; line-height: 1.4; margin-top: 4px; }
</style>
