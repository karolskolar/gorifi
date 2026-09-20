<script setup>
// The portaled modal shell (UC-DS-010) — the single shell every friend/guest
// dialog is composed from (share, profile, subscription, invite, pickup,
// payment, checkout, success, cancel-confirm; modules 03–06 own those).
//
// Transcribed from `docs/design/friends-portal-redesign/friends/ui.jsx`
// `Modal`: same nodes in the same order, same inline styles, `.m-foot` and the
// subtitle row omitted entirely when empty, × only when closable.
//
// ⚠ NOT radix. `components/ui/dialog` (radix-vue) stays admin-only per
// UC-DS-004 rule 4 — its baked-in animation/data-state classes would fight
// pixel fidelity, and the behaviour surface here is small and fully pinned.
//
// ⚠ The `<Teleport to="body">` is load-bearing and must never be "optimised"
// away: the theme tokens are declared on `.app, .modal-layer` precisely
// because this subtree lands OUTSIDE `.app`. Remove the teleport (or the
// `.modal-layer` wrapper) and every `var(--accent)` inside the modal resolves
// to nothing.
//
// There is no `open` prop — the PARENT owns mounting via `v-if`, exactly as
// the prototype's modal enum does. Everything with a lifetime therefore hangs
// off mount/unmount (below), so a modal that is unmounted while open — a route
// change, a parent teardown — cannot leak its listener or its scroll lock.

import { computed, ref, useId } from 'vue'
import NeoIcon from './NeoIcon.vue'
import { useModalLayer } from './use-modal-layer.js'

const props = defineProps({
  title: { type: String, required: true },
  // Plain-text subtitle. For rich content (the payment "Suma na úhradu: …"
  // line, a bolded cycle name) use the `#subtitle` slot instead — both render
  // into the same `.sub` row, and the row is absent when neither is supplied.
  subtitle: { type: String, default: '' },
  // `.modal` max-width 520px instead of the default 420px.
  wide: { type: Boolean, default: false },
  // Render `.m-title` as an `<h2>` instead of the prototype's `<div>`.
  //
  // ⚠ OPT-IN, and it exists for exactly one reason: three SHIPPED, non-editable
  // session-boundary specs resolve the credential-setup dialog with
  // `getByRole('heading', { name: 'Nastavte si osobné prihlásenie' })`
  // (`portal-profile-modal.spec.js:812`, `portal-session-boundary.spec.js:457`
  // and `:533`). That dialog was a radix `Dialog`, whose `DialogTitle` is an
  // `<h2>`; a `div` answers to no role, so porting it onto this shell without
  // this prop would have RED-ed three specs that encode a real plaintext-password
  // session leak. The specs cannot be weakened, so the shell grew the affordance.
  //
  // ⚠ DEFAULT `false`, deliberately. Making every modal title a heading is the
  // more correct a11y default, but it is not behaviour-neutral: a dozen shipped
  // specs call `page.getByRole('heading', …)` UNSCOPED while a modal is open, and
  // a new heading in the tree can turn one of those into a strict-mode violation.
  // Flip it per consumer, never globally.
  //
  // Visually inert: Tailwind's preflight resets `h1`–`h6` to
  // `font-size: inherit; font-weight: inherit; margin: 0`, and `.m-title`
  // re-declares font-family/size/weight/line-height/transform explicitly at
  // (0,2,0), so the `h2` renders pixel-for-pixel as the `div` did.
  titleHeading: { type: Boolean, default: false },
  closable: { type: Boolean, default: true },
  // Keyboard focus containment. RD-FL-2, additive and opt-in.
  //
  // `null` (the default) means DERIVE it from `closable`: a non-closable modal
  // is a GATE — 03 §UC-FL-012's forced password change has no "later" path — and
  // a gate Tab can walk out of is not a gate. `aria-modal="true"` already tells
  // AT the rest of the page is inert, but it does nothing for the Tab key, so
  // without this the sighted keyboard user simply tabs past the dialog into the
  // page behind the scrim and uses the app (measured before the fix:
  // `m-x → inside-btn → … → BODY → opener → …`).
  //
  // Ordinary `closable: true` dialogs keep TODAY'S behaviour untouched unless
  // they ask for the trap explicitly — nothing else in the tree opts in yet, so
  // this cannot regress an existing consumer.
  //
  // ⚠ Declared with `default: null` on purpose: a plain `type: Boolean` prop
  // would be cast to `false` when absent, and "absent" has to stay
  // distinguishable from "explicitly off" for the derivation above.
  trapFocus: { type: Boolean, default: null }
})

const trapping = computed(() => (props.trapFocus === null ? !props.closable : props.trapFocus))

const emit = defineEmits(['close'])

const titleId = useId()
const modalEl = ref(null)

// ⚠ EVERY BEHAVIOUR OF THIS SHELL NOW LIVES IN `use-modal-layer.js` — scroll
// lock, Escape, the capture-phase scrim-mousedown origin rule, the focus trap and
// the focus restore, moved there VERBATIM by PI-T2 (18 §UC-PI-004) when
// `NeoDrawer.vue` needed the same five. Two copies of the scrim logic is how one
// stops working. Read that file before changing any of them; the parameterisation
// is three getters and a callback, so `closable` and `trapFocus` are still read at
// EVENT time and a parent may still flip either while the dialog is open.
const { requestClose, onScrimMousedown, onScrimClick } = useModalLayer(modalEl, {
  closable: () => props.closable,
  trapping: () => trapping.value,
  onClose: () => emit('close'),
  tag: 'NeoModal'
})

// ⚠ Seam 1 (no focus TRAP) is CLOSED as of RD-FL-2 — see the `trapFocus` prop
// here and `trapTab()` in `use-modal-layer.js`. It is pinned by
// `e2e/tests/modern-login.spec.js`
// ("Tab and Shift+Tab cannot escape the gate"), which drives the forced
// password-change gate 03 §UC-FL-012 composes on this shell.
//
// ⚠ Seam 2 (a text-selection drag out of `.m-body` closing the modal) is CLOSED
// as of RD-FL-6 — see `onScrimMousedown`/`onScrimClick` in
// `use-modal-layer.js`. UC-DS-010 was
// amended in the same row, so the spec's structure block and this template
// agree. It is pinned by `e2e/tests/portal-profile-modal.spec.js` ("a
// text-selection drag out of the body must NOT close the modal"), which performs
// the real gesture, alongside a test proving a genuine scrim click still closes.
//
// No seams remain open on this component.

// Notes on the template below (kept here, not as template comments, so the
// rendered DOM stays identical to the prototype's in dev as well as prod):
//
// · `.modal-scrim` uses `@click.self` — that IS the scrim-close rule: a click
//   that started on ANY child (the card, a button, a text node inside it) must
//   never close — plus the mousedown-origin requirement above.
// · The × is a bare `span` in the prototype, with an onClick — unreachable by
//   keyboard and announced as nothing. The role/tabindex/aria-label/keydown
//   layer here renders no pixel; it is the same permitted enhancement
//   NeoCheckbox (UC-DS-009) makes for its `span.cbox`.
// · `.m-foot` is absent, not empty, when there is no `#footer` — it carries its
//   own 18px padding, so an empty one would show as dead space.

defineOptions({
  // A single-root component whose root is a <Teleport> cannot inherit
  // fallthrough attrs — Vue drops them either way and only warns
  // ("Extraneous non-props attributes … cannot be automatically inherited …
  // teleport root nodes") when this is left true. So `false` is
  // behaviour-neutral; it exists purely to suppress that warning, now that
  // `v-bind="$attrs"` on `.modal` routes the attrs somewhere real.
  //
  // ⚠ That `v-bind` is deliberately the FIRST binding on the element. The
  // compiler turns any element carrying both `v-bind="obj"` and literal attrs
  // into `mergeProps(...)`, whose rule is: `class` and `style` MERGE, `onX`
  // handlers CHAIN, and every other key is LAST-WINS. Attrs-first therefore
  // means a consumer's `class` composes with `.modal` (all the theme CSS keeps
  // applying) while `role="dialog"` / `aria-modal` / `tabindex` stay ours and
  // cannot be clobbered — RD-KG-2's race-guard e2e keys on `role="dialog"`.
  // Moving the `v-bind` after them would invert that and let a caller break
  // the dialog semantics.
  inheritAttrs: false
})
</script>

<template>
  <Teleport to="body">
    <div class="modal-layer">
      <div class="modal-scrim" @mousedown.capture="onScrimMousedown" @click.self="onScrimClick">
        <div
          v-bind="$attrs"
          ref="modalEl"
          class="modal"
          style="outline: none"
          :style="wide ? { maxWidth: '520px' } : null"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          tabindex="-1"
        >
          <div class="m-head">
            <div style="flex: 1; min-width: 0">
              <component :is="titleHeading ? 'h2' : 'div'" class="m-title" :id="titleId">{{ title }}</component>
              <div v-if="subtitle || $slots.subtitle" class="sub" style="margin-top: 4px">
                <slot name="subtitle">{{ subtitle }}</slot>
              </div>
            </div>
            <!-- ⚠ The accessible name is "Zatvoriť dialóg", and it MUST NOT
                 CONTAIN the word "Zavrieť". Every modal specced on this shell
                 carries a footer button labelled exactly "Zavrieť" (03
                 §UC-FL-011, 05 §Share dialog, 06 §UC-GX-005), and three shipped,
                 non-editable guest specs close the payment modal with an
                 unscoped `getByRole('button', { name: 'Zavrieť' })`. Playwright
                 matches that name as a case-insensitive SUBSTRING unless
                 `exact: true`, so "Zavrieť" and even "Zavrieť dialóg" both
                 resolve to two elements and throw a strict-mode violation
                 (measured, not assumed — "Zavrieť dialóg" was tried first and
                 failed exactly this way). A synonym is the only fix available:
                 the specs cannot be edited and the × must stay named for a11y.
                 See 02 §UC-DS-010. Do not "simplify" this back. -->
            <span
              v-if="closable"
              class="m-x"
              role="button"
              tabindex="0"
              aria-label="Zatvoriť dialóg"
              @click="requestClose"
              @keydown.enter.prevent="requestClose"
              @keydown.space.prevent="requestClose"
            >
              <NeoIcon name="close" />
            </span>
          </div>
          <div class="m-body"><slot /></div>
          <div v-if="$slots.footer" class="m-foot"><slot name="footer" /></div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
