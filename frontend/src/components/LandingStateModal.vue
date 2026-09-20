<script setup>
// 18 §UC-PI-006 — THE LANDING'S STATE MODAL: „why is there nothing to order".
//
// ⚠ IT IS PARAMETRISED BECAUSE IT HAS TWO CONSUMERS, AND THE SECOND ONE IS THE
// REASON THIS IS A COMPONENT AT ALL. §UC-PI-007's „locked, NO own order" branch is
// „the closed-state treatment with the modal title „Objednávky sú uzamknuté" and
// intro „Táto objednávka je už uzavretá — káva je objednaná v pražiarni."" — i.e.
// the same card, the same dots, the same footer, three different strings. PI-T5
// passes those strings; a second modal component would be the defect.
//
// `title` / `intro` / `lead` are therefore PROPS, not literals. Everything else
// (the WhatsApp line, „Kde sme teraz", the two footer buttons, the three captions)
// is the same on both surfaces and stays here — a prop nobody varies is a seam
// nobody can read.
//
// ⚠⚠ THE DATE APPEARS IN TWO FORMATS ON THE SAME CLOSED LANDING, AND THAT IS A
// RECORDED, UNRESOLVED PO QUESTION — NOT A BUG TO FIX AT THIS CALL SITE.
// The card below prints the SHORT form („3. 10.", `lib/dates.js fmtDayMonth`,
// 18 §UC-PI-002's letter); the warn banner that REPLACES this modal after dismissal
// prints module 17's composed sentence, which carries the LONG form
// („približne 3. októbra", `cycle-stages.js nextOpeningText`). Both spellings are
// specified, by two modules, for the same date.
//
//   · PI-T1 kept 17's form inside the SENTENCE because the alternative is a second
//     home for one sentence (`docs/learnings/10-portal-ia.md` §1, both options
//     costed, PO decision pending);
//   · the rule that came out of it — a date standing ALONE (display type, after a
//     preposition) is SHORT and comes from `lib/dates.js`; a date INSIDE one of
//     module 17's composed sentences is LONG and comes from `cycle-stages.js` — is
//     what this file follows to the letter. The 38px date below stands alone.
//
// ⚠ So: do NOT „fix" the mismatch by formatting one of them differently here, and
// do NOT recompose 17's sentence with `fmtDayMonth`. Either move creates the second
// home the whole module has spent the week collapsing. ⚠ And note what is NOT true,
// because an earlier draft of the note said it and a reader who checked would have
// concluded the conflict had evaporated: the two forms are not both inside this
// modal. In the `opens_at === null` branch this modal carries `nextText` ALONE and
// there is no collision here at all.
import { computed } from 'vue'
import NeoModal from './neo/NeoModal.vue'
import CycleTimeline from './CycleTimeline.vue'
import { fmtDayMonth } from '../lib/dates.js'
import { stageIndex } from '../lib/cycle-stages.js'

const props = defineProps({
  // „Objednávky sú zatvorené" (§UC-PI-006) / „Objednávky sú uzamknuté" (PI-T5).
  title: { type: String, required: true },
  // The `div.sub` under the title.
  intro: { type: String, required: true },
  // The `field-lbl` above the big date. Both consumers say the same thing today;
  // it is a prop so PI-T5 does not have to touch this file to disagree.
  lead: { type: String, default: 'Ďalšia objednávka sa otvorí približne' },
  // The newest `planned` round, from `lib/portal-state.js` — `null` when none.
  nextCycle: { type: Object, default: null },
  // `cycle-stages.js nextOpeningText()`'s `{ date, inWeeks, text }`, as
  // `resolveLanding()` publishes it (`landing.nextOpening`). ⚠ `date` is 17's LONG
  // form and is used here ONLY as the „is `opens_at` usable" predicate — it already
  // encodes the `2026-02-31` round-trip refusal, so re-deriving that check would be
  // a second home for it. What is RENDERED is `fmtDayMonth` (see the header).
  nextOpening: { type: Object, default: () => ({ date: null, inWeeks: null, text: '' }) },
  // Which round the dots describe: §UC-PI-006 says `nextCycle ?? catalogCycle`, and
  // the caller does that pick. `null` is legitimate and renders step 0.
  timelineCycle: { type: Object, default: null },
})

defineEmits(['close', 'explainer'])

/** True when there is a real opening date to set in display type. */
const hasDate = computed(() => !!(props.nextOpening && props.nextOpening.date))

/** ⚠ 18's SHORT form, for a date that stands alone. See the header. */
const shortDate = computed(() => fmtDayMonth(props.nextCycle ? props.nextCycle.opens_at : null))

/**
 * „o 2 týždne · dáme vedieť cez WhatsApp" — and the bare promise when the round is
 * not far enough away for `inWeeksText()` to say anything (today, or already past).
 * Dropping the „ · " separator rather than printing an empty left half is the same
 * rule the drawer's sub-lines follow.
 */
const whatsappLine = computed(() => {
  const inWeeks = props.nextOpening && props.nextOpening.inWeeks
  return inWeeks ? `${inWeeks} · dáme vedieť cez WhatsApp` : 'dáme vedieť cez WhatsApp'
})

/**
 * WHICH of the three captions is the one we are on.
 *
 * ⚠ IT READS MODULE 17's `stageIndex()` AND BUILDS NO STEP ARRAY OF ITS OWN.
 * `CycleTimeline` is handed `:cycle`, never `:steps` — a consumer that assembles
 * steps owns their `state` field, and re-deriving it is exactly how the
 * stage-before-status ordering 17 guards against (`cycle-stages.js`'s three
 * measured stale-`stage` transitions) comes back on one screen only. `stageIndex`
 * IS that status-first translation, so asking it is asking 17.
 *
 * The three captions span the six steps: 0 „Pauza", 1 „Objednávky", 2–5
 * „Doručenie" — the prototype's grouping (`portal2.jsx:424-426`).
 */
const captions = ['Pauza', 'Objednávky', 'Doručenie']
const activeCaption = computed(() => {
  const i = stageIndex(props.timelineCycle)
  return i <= 0 ? 0 : i === 1 ? 1 : 2
})
</script>

<template>
  <NeoModal :title="title" data-testid="landing-state-modal" @close="$emit('close')">
    <div class="sub" style="font-size:14px">{{ intro }}</div>

    <!-- The next-round card. `.card.flat` + `--accent-soft`, exactly as
         `portal2.jsx:414-418`. -->
    <div class="card flat" style="padding:14px;background:var(--accent-soft)" data-testid="next-round-card">
      <template v-if="hasDate">
        <div class="field-lbl" style="margin-bottom:6px">{{ lead }}</div>
        <!-- ⚠ `line-height` INLINE: `friends-theme.css` loads after Tailwind and
             `:where(.app,.modal-layer) .display` matches at the same specificity as
             a utility class, so the canon's `.9` survives only as a style attribute
             (CLAUDE.md §Frontend). -->
        <div class="display" style="font-size:38px;line-height:.9" data-testid="next-round-date">{{ shortDate }}</div>
        <div class="sub" style="margin-top:6px;font-weight:700">{{ whatsappLine }}</div>
      </template>
      <!-- No usable `opens_at` ⇒ the card body is `nextText` itself (§UC-PI-006):
           either the admin's `plan_note` verbatim — hence `pre-line` and
           `anywhere` — or „O ďalšej objednávke dáme vedieť." -->
      <div
        v-else
        class="display"
        style="font-size:22px;line-height:1.05;white-space:pre-line;overflow-wrap:anywhere"
        data-testid="next-round-text"
      >{{ nextOpening.text }}</div>
    </div>

    <div>
      <div class="field-lbl" style="margin-bottom:8px">Kde sme teraz</div>
      <!-- ⚠ `:cycle`, NEVER `:steps` — 17 owns which dot is „now". -->
      <CycleTimeline variant="compact" :cycle="timelineCycle" />
      <!-- ⚠ THE CAPTION ROW IS THIS MODULE's, NOT THE COMPONENT's. `CycleTimeline`
           renders six dots and nothing else by its own spec (17 §UC-CS-006, and its
           template says so); the three-word legend is a module-18 surface and lives
           at the consumer, which is why it is here rather than behind a prop. -->
      <div
        style="display:flex;justify-content:space-between;margin-top:6px;gap:8px"
        data-testid="timeline-captions"
      >
        <span
          v-for="(cap, i) in captions"
          :key="cap"
          class="mono"
          :class="{ sub: i !== activeCaption }"
          :style="{ fontSize: '11px', textTransform: 'uppercase', fontWeight: i === activeCaption ? 700 : null }"
        >{{ cap }}</span>
      </div>
    </div>

    <template #footer>
      <button type="button" class="btn" @click="$emit('explainer')">Ako to funguje</button>
      <button type="button" class="btn accent" @click="$emit('close')">Prezrieť ponuku</button>
    </template>
  </NeoModal>
</template>
