<script>
// ---------------------------------------------------------------------------
// Module-scope state, shared by every NeoModal instance on the page.
//
// It lives in a plain `<script>` block (not `<script setup>`) on purpose: a
// `<script setup>` body compiles into `setup()` and would be re-allocated per
// instance, which is exactly the reallocation RD-DS-2 hoisted `icons.js` out
// for — and here it would be worse than wasteful, because the scroll lock is
// only correct if all instances share ONE counter.
// ---------------------------------------------------------------------------

// How many NeoModals are currently mounted. UC-DS-010 says one modal at a time,
// but "at a time" is not the same as "never for one tick": a route change or a
// parent that swaps `v-if`s can legally overlap two instances for a frame.
let openLocks = 0

// `document.body`'s inline `overflow` as it was before the FIRST lock.
// ⚠ Restoring to `''` instead of this would silently destroy a pre-existing
// inline value (something else on the page may have set `overflow:hidden` or
// `scroll` for its own reasons), and the page would be left mis-scrolling with
// no visible cause.
let savedBodyOverflow = ''

function lockBodyScroll() {
  // Only the outermost lock records the baseline — an inner one would record
  // the `hidden` we ourselves just wrote and then "restore" it forever.
  if (openLocks === 0) savedBodyOverflow = document.body.style.overflow
  openLocks += 1
  document.body.style.overflow = 'hidden'
}

function unlockBodyScroll() {
  // `Math.max` keeps the counter honest if an instance ever unmounts twice.
  openLocks = Math.max(0, openLocks - 1)
  // Only the LAST unmount unlocks. Without the counter, an overlapping second
  // modal's unmount would unlock the page while the first is still open.
  if (openLocks === 0) document.body.style.overflow = savedBodyOverflow
}
</script>

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

import { onBeforeUnmount, onMounted, ref, useId } from 'vue'
import NeoIcon from './NeoIcon.vue'

const props = defineProps({
  title: { type: String, required: true },
  // Plain-text subtitle. For rich content (the payment "Suma na úhradu: …"
  // line, a bolded cycle name) use the `#subtitle` slot instead — both render
  // into the same `.sub` row, and the row is absent when neither is supplied.
  subtitle: { type: String, default: '' },
  // `.modal` max-width 520px instead of the default 420px.
  wide: { type: Boolean, default: false },
  closable: { type: Boolean, default: true }
})

const emit = defineEmits(['close'])

const titleId = useId()
const modalEl = ref(null)

// Per-INSTANCE pairing flag for the module-scope lock counter above (this is
// `<script setup>`, so it is re-allocated per instance — which is what we want
// here and precisely what the counter must NOT be).
//
// ⚠ `onMounted` and `onBeforeUnmount` are not guaranteed to come in pairs:
// Vue queues `mounted` and SKIPS it if the instance is already unmounted by
// the time the queue flushes, whereas `beforeUnmount` runs unconditionally. An
// unguarded `unlockBodyScroll()` would then release a lock this instance never
// took, and — with another modal open — unlock the page under it. The
// `Math.max(0, …)` clamp bounds the damage; this closes the hole.
let didLock = false

// The element focus must return to on close. Captured in `setup()` — the
// earliest point in this component's life — because the opener is still the
// active element there: the parent's `v-if` flip and this component's creation
// happen in the same update, before anything can steal focus.
const opener = typeof document !== 'undefined' ? document.activeElement : null

// One JS guard for all three close paths. `pointer-events`/`disabled` do not
// stop a programmatic `dispatchEvent` (RD-DS-3's lesson), and `closable` is a
// live prop — a parent may flip it while a submit is in flight — so it is read
// at event time, never captured.
function requestClose() {
  if (!props.closable) return
  emit('close')
}

function onKeydown(e) {
  if (e.key !== 'Escape') return
  if (!props.closable) return
  // Stops the key also dismissing something underneath (a native <dialog>, a
  // browser find bar) now that this modal has claimed it.
  e.preventDefault()
  emit('close')
}

onMounted(() => {
  lockBodyScroll()
  didLock = true
  // Listener on `document`, not on the container: Esc must work even while
  // focus sits in an input inside the modal, or nowhere in particular.
  document.addEventListener('keydown', onKeydown)
  // `tabindex="-1"` + programmatic focus moves the caret into the dialog so
  // Tab continues inside it and screen readers announce the dialog. The
  // container also carries `outline:none`, because a -1 element is not
  // keyboard-reachable — the ring would be a pure artifact with nothing behind
  // it (UC-DS-010: "focus handling must add no visual artifact").
  modalEl.value?.focus()

  if (openLocks > 1 && import.meta.env.DEV) {
    console.warn(
      '[NeoModal] more than one modal is mounted. UC-DS-010 specifies one modal ' +
        'at a time per screen — stacking is not supported (module 06 swaps modal ' +
        'content, it does not layer modals).'
    )
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (didLock) {
    didLock = false
    unlockBodyScroll()
  }
  // Focus is restored BEFORE the node leaves the DOM. Removing a focused
  // element resets `activeElement` to `<body>`, so doing this after teardown
  // would drop the keyboard user at the top of the page.
  if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus()
})

// ⚠ Two known seams, both deliberately NOT closed here — see the RD-DS-4
// review notes. Neither is a UC-DS-010 violation; both need a spec amendment
// or a later row that owns the affected screen.
//
// 1. No focus TRAP. Tab can leave the dialog into the page behind it.
//    ⚠ Do not bolt one on ad hoc: `FriendPortal.vue` currently renders the
//    forced password-change gate with radix `Dialog`, which DOES trap focus
//    and mark outside content inert. Porting that gate to NeoModal under
//    03 §UC-FL-012 (`closable: false`) without a trap would turn Tab into a
//    functional bypass of a gate. The trap lands in RD-FL-2 as an additive
//    opt-in prop (likely `trapFocus`, defaulting to `closable === false`),
//    pinned by the modern-mode e2e that row already owns.
//
// 2. A text-selection drag can close the modal: mousedown inside `.m-body`,
//    drag out, mouseup over the scrim — the DOM `click` target is then the
//    nearest common ancestor (`.modal-scrim`), so `@click.self` fires. This is
//    faithful to UC-DS-010's fixed structure and to `ui.jsx`, so the
//    `@click.self` below stays exactly as specced. Closing it (also requiring
//    the MOUSEDOWN to have originated on the scrim) needs a UC-DS-010
//    amendment, and matters once modules 03/04/06 compose input-heavy dialogs
//    on this shell — losing a half-filled checkout to a drag is data loss.

// Notes on the template below (kept here, not as template comments, so the
// rendered DOM stays identical to the prototype's in dev as well as prod):
//
// · `.modal-scrim` uses `@click.self` — that IS the scrim-close rule: a click
//   that started on ANY child (the card, a button, a text node inside it) must
//   never close.
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
      <div class="modal-scrim" @click.self="requestClose">
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
              <div class="m-title" :id="titleId">{{ title }}</div>
              <div v-if="subtitle || $slots.subtitle" class="sub" style="margin-top: 4px">
                <slot name="subtitle">{{ subtitle }}</slot>
              </div>
            </div>
            <span
              v-if="closable"
              class="m-x"
              role="button"
              tabindex="0"
              aria-label="Zavrieť"
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
