<script setup>
// THE ONE RENDERING of „kde je vaša káva" — the six steps of a round — in TWO
// variants (17 §UC-CS-006). Three modules mount it: the guest status page (CS-T4),
// the admin cycle header (CS-T3, compact), and module 18's portal landing (vertical)
// and closed modal (compact). It is never forked per consumer and there is never a
// second component: that is the `CartLineList` one-home rule, and the failure mode
// it prevents is two screens showing the same round at two different steps.
//
// ⚠ NO SLOVAK LIVES HERE except the `aria-label` template. Every label, every date
// line and every step key comes from `lib/cycle-stages.js`; this file decides only
// how they look. Re-typing a label here would create the second home the lib exists
// to prevent, and the vocabulary sweep in `cycle-stages.spec.js` reads BOTH files.
//
// ⚠ IT RENDERS IN THREE DIFFERENT SKINS, so the styles below carry no `.app` and no
// `.modal-layer` ancestor selector and read every token through a fallback: the
// portal supplies them from `friends-theme.css`, the admin page supplies none, and
// the component must look right either way. The canon port (A12) is closed — this is
// scoped styling ported from `portal2.css:22-42`, not a theme edit.
//
// ⚠ AND IT MUST NEVER BE A DIRECT CHILD OF `.app` (CLAUDE.md's `.app > *` cascade
// rule). Nothing in here is `fixed`/`sticky`/`z-*` at the root, so the rule cannot
// bite this component today; the `.st::before` connector IS absolute, but it is
// positioned against `.st`, which is a grandchild. Every prototype placement puts
// the component inside a card or a modal body.
import { computed } from 'vue'
import { timelineSteps } from '../lib/cycle-stages.js'

const props = defineProps({
  // Any cycle payload row carrying `status` / `stage` / `opens_at` / `closes_at` —
  // the friend, guest and admin payloads all publish them (§UC-CS-004). `null` is a
  // legitimate value and renders step 0, so a consumer never has to guard its own
  // `v-if` on a not-yet-loaded cycle.
  cycle: { type: Object, default: null },
  // `'vertical'` (label + when + desc) or `'compact'` (the six-dot strip). Neither
  // is width-switched: the portal is one narrow column and the prototype is vertical
  // at every width (resolved conflict 4).
  variant: { type: String, default: 'vertical' },
  // An explicit step array replacing `timelineSteps(cycle)`, same shape — the seam
  // that lets module 18 fill `desc` with its own sentences without forking either
  // this component or the lib's labels.
  steps: { type: Array, default: null },
})

const items = computed(() => (
  Array.isArray(props.steps) && props.steps.length ? props.steps : timelineSteps(props.cycle)
))

// The dot strip is one `role="img"`, so the CURRENT step has to be in its label —
// six identical squares say nothing to a screen reader. Falling back to 0 keeps the
// label sane if a consumer hands in steps with no `now` at all.
const nowIndex = computed(() => {
  const i = items.value.findIndex((s) => s && s.state === 'now')
  return i >= 0 ? i : 0
})
const dotsLabel = computed(() => {
  const step = items.value[nowIndex.value]
  return `Krok ${nowIndex.value + 1} z ${items.value.length}: ${step ? step.label : ''}`
})
</script>

<template>
  <!-- compact: six dots joined by five rules; the caption row under them belongs to
       the CONSUMER (module 18's „Pauza · Objednávky · Doručenie"), not here. -->
  <div
    v-if="variant === 'compact'"
    class="cs-dots"
    role="img"
    :aria-label="dotsLabel"
    data-testid="cycle-timeline-compact"
  >
    <template v-for="(s, i) in items" :key="s.key || i">
      <span class="d" :class="{ now: i === nowIndex, next: i > nowIndex }"></span>
      <span v-if="i < items.length - 1" class="ln"></span>
    </template>
  </div>

  <div v-else class="cs-tl" data-testid="cycle-timeline">
    <div v-for="(s, i) in items" :key="s.key || i" class="st" :class="s.state" :data-step="s.key">
      <span class="mk">
        <!-- the prototype's `I.check` path, white on ink. The marker is a flex box,
             which is what keeps the icon centred under the admin skin's preflight
             `svg{display:block}` (CLAUDE.md §Frontend). -->
        <svg
          v-if="s.state === 'done'"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="3.6"
          aria-hidden="true"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
        <template v-else>{{ i + 1 }}</template>
      </span>
      <div class="bd">
        <!-- ⚠ `line-height` inline on the `now` label: it is the one declaration the
             display-font treatment cannot afford to lose to a host cascade, and the
             portal has form here (CLAUDE.md §Frontend). -->
        <div class="lbl" :style="s.state === 'now' ? { lineHeight: '1' } : null">{{ s.label }}</div>
        <div v-if="s.when" class="when">{{ s.when }}</div>
        <div v-if="s.desc" class="desc">{{ s.desc }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Ported from `docs/design/friends-portal-redesign/friends/portal2.css:22-42`
   (`.p2-tl` / `.p2-dots`), byte-equivalent apart from ~~three~~ FOUR deliberate
   changes: the `.app` / `.modal-layer` prefixes are DROPPED (scoped styles, three
   skins), every `var()` gained a fallback (the admin page defines no tokens), the
   `.p2-` prefix became `.cs-`, and — PI-T12 — `.when` gained the `line-height:normal`
   the canon gets for free (see that rule). */
.cs-tl {
  display: flex;
  flex-direction: column;
}
.cs-tl .st {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  position: relative;
  padding-bottom: 14px;
}
.cs-tl .st::before {
  content: "";
  position: absolute;
  left: 13px;
  top: 28px;
  bottom: 0;
  border-left: 3px solid rgba(10, 10, 10, 0.18);
}
.cs-tl .st.done::before {
  border-left-color: var(--nb-ink, #0a0a0a);
}
.cs-tl .st:last-child::before {
  display: none;
}
.cs-tl .mk {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  border: 3px solid var(--nb-ink, #0a0a0a);
  border-radius: 8px;
  background: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-weight: 700;
  font-size: 12px;
}
.cs-tl .st.done .mk {
  background: var(--nb-ink, #0a0a0a);
  color: #fff;
}
.cs-tl .st.now .mk {
  background: var(--accent, #ff2d87);
  color: var(--accent-ink, #fff8f3);
  box-shadow: 3px 3px 0 var(--nb-ink, #0a0a0a);
}
.cs-tl .st.next .mk {
  border-style: dashed;
  color: var(--ink-faint, rgba(10, 10, 10, 0.45));
}
/* the prototype's inline `minWidth: 0` on the text column — a long roastery label
   must ellipsize inside the flex row, not push the marker off the card */
.cs-tl .bd {
  min-width: 0;
  overflow-wrap: anywhere;
}
.cs-tl .lbl {
  font-weight: 700;
  font-size: 15px;
  line-height: 1.25;
  padding-top: 4px;
}
.cs-tl .st.next .lbl {
  color: var(--ink-faint, rgba(10, 10, 10, 0.45));
  font-weight: 600;
}
.cs-tl .st.now .lbl {
  font-family: var(--font-display, inherit);
  text-transform: uppercase;
  font-weight: 800;
  font-size: 20px;
  line-height: 1;
  padding-top: 5px;
}
/* ⚠ `line-height: normal` is the FOURTH deliberate change from the canon's bytes, and
   it restores the canon's RESULT rather than departing from it. `portal2.css:34`
   declares no line-height on `.when`, so the prototype (no Tailwind) computes the UA
   default `normal`; here Tailwind preflight's `html{line-height:1.5}` reached it
   through the host, and PI-T12's `portal-fidelity` pin measured 17.25px on every
   `.when` line of the locked landing's vertical timeline — the A10 class of drift
   (`friends-theme.css` §A10), on a class that list cannot name because it is this
   component's. `.lbl` and `.desc` need nothing: the canon declares theirs (1.25 /
   1.35) and they are ported. `.mk` is left alone on A10's `.tabbadge` reasoning: a
   fixed 28px flex box centres its line, so the inherited value changes nothing
   measurable. The admin header mounts only the COMPACT variant, which has no text. */
.cs-tl .when {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, monospace);
  font-size: 11.5px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--ink-dim, rgba(10, 10, 10, 0.66));
  margin-top: 3px;
  line-height: normal;
}
.cs-tl .desc {
  font-size: 13.5px;
  color: var(--ink-dim, rgba(10, 10, 10, 0.66));
  margin-top: 3px;
  line-height: 1.35;
}

.cs-dots {
  display: flex;
  align-items: center;
}
.cs-dots .d {
  width: 22px;
  height: 22px;
  border: 3px solid var(--nb-ink, #0a0a0a);
  border-radius: 6px;
  background: #fff;
  flex-shrink: 0;
  box-sizing: border-box;
}
.cs-dots .d.now {
  background: var(--accent, #ff2d87);
  box-shadow: 2px 2px 0 var(--nb-ink, #0a0a0a);
}
.cs-dots .d.next {
  border-style: dashed;
}
.cs-dots .ln {
  flex: 1;
  border-top: 3px solid rgba(10, 10, 10, 0.25);
}
</style>
