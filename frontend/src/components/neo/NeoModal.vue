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

import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import NeoIcon from './NeoIcon.vue'

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

// ⚠ SCRIM-CLOSE REQUIRES THE GESTURE TO HAVE *STARTED* ON THE SCRIM.
// (UC-DS-010 amendment, RD-FL-6 — the resolution of the open spec item RD-DS-4
// raised.)
//
// `@click.self` alone is not "the user clicked the backdrop". A `click` fires on
// the nearest common ancestor of mousedown and mouseup, so a text-selection drag
// that STARTS on a label inside `.m-body` and RELEASES over the scrim delivers a
// `click` whose target IS the scrim — `.self` passes, and the dialog closes. On
// the forced-password gate that was harmless (`closable:false` kills scrim-close
// outright), which is why RD-FL-2 could leave it standing; the profile modal is
// the first CLOSABLE form-bearing dialog on this shell, so from here on the same
// gesture destroys a half-filled form. Modules 04/06 add the checkout and
// guest-identity forms behind the same shell.
//
// The flag is deliberately NOT a `ref`: nothing renders from it, so reactivity
// would only cost a re-render per mousedown.
//
// This is written as ONE handler computing `target === currentTarget` rather
// than the amendment's literal `@mousedown.self` + a separate reset: they are
// behaviourally identical (every mousedown that can reach this subtree either
// sets or clears the flag) and a single handler has no dependence on listener
// registration order. `.modal-layer` is `pointer-events:none` and the scrim
// re-enables it over the whole viewport, so there is no mousedown a user can
// produce that misses this handler while the modal is open.
//
// ⚠ The listener is registered in the CAPTURE phase (`@mousedown.capture` in
// the template). Bubble-phase, any descendant that calls `stopPropagation()` on
// `mousedown` — none does today, but this is the shared shell modules 04–06 fill
// with checkout/pickup/payment/guest-identity content, third-party components
// included — would leave the flag at whatever the PREVIOUS gesture set it to,
// and a drag out of the body could then close the dialog again. Capture still
// fires when the scrim itself is the target, so `target === currentTarget` is
// unaffected, and nothing below can pre-empt it.
let scrimDown = false

function onScrimMousedown(e) {
  // ⚠ `button === 0` (primary) as well as the origin check. A right- or
  // middle-click on the scrim correctly does NOT close the modal — but it also
  // produces no `click` (middle-click fires `auxclick`), so without this test it
  // would LATCH the flag: nothing consumes it, and the next `click` to reach the
  // scrim — including a purely programmatic one — would inherit permission from
  // a gesture that was never a dismissal. That contradicts the one-shot rule
  // `onScrimClick` documents, so the two must agree.
  //
  // NOT guarded (measured, RD-FL-6 review): `.modal-scrim` is `overflow-y:auto`,
  // so on a short viewport it grows a scrollbar, and the worry was that dragging
  // a CLASSIC (layout-consuming) one is a press+release+click all targeting the
  // scrim ⇒ the modal closes while the user is only scrolling. Reproduced with a
  // real classic scrollbar (Chromium launched WITHOUT Playwright's default
  // `--hide-scrollbars`, viewport 420×300, gutter 15px): a thumb drag, a track
  // click, a thumb click and an arrow click each deliver `mousedown` + `mouseup`
  // on the scrim (`self: true`, `button: 0`, `offsetX: 413` vs `clientWidth:
  // 405`) and **no `click` at all** — the modal stays open every time, and the
  // subsequent text-selection drag out of `.m-body` still does not close it,
  // because that drag's own mousedown re-computes the flag. So an
  // `offsetX < clientWidth` guard would be dead code. The only residue is that a
  // scrollbar press leaves the flag set for a later *programmatic* `click()` —
  // the same script-only class as the non-primary press above, and no worse than
  // it.
  scrimDown = e.button === 0 && e.target === e.currentTarget
}

function onScrimClick() {
  if (!scrimDown) return
  // One-shot: a subsequent programmatic `click` with no mousedown behind it
  // must not inherit this gesture's permission.
  scrimDown = false
  requestClose()
}

// Everything the browser will hand a Tab to. `[tabindex]` deliberately matches
// negative values too, so they can be filtered out below rather than silently
// treated as reachable — the `.modal` container itself is `tabindex="-1"`.
//
// `summary` is in the list because `<details>`/`<summary>` ALREADY ships in this
// tree (FriendOrder, GuestOrder, GuestProductGrid) and modules 04/06 compose
// product cards containing a composition disclosure into modal surfaces — a
// `<summary>` tail is focusable to the browser, so omitting it used to mean Tab
// walked straight out of the dialog. `details` is listed alongside it as a
// cheap superset; it is not itself focusable in Chromium, which costs nothing
// because `focusFirstThatTakes()` below skips any candidate that refuses focus.
const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'audio[controls]',
  'video[controls]',
  'details',
  'summary',
  '[contenteditable]',
  '[tabindex]'
].join(',')

function focusablesInside() {
  const root = modalEl.value
  if (!root) return []
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter((el) => {
    if (el.hasAttribute('disabled')) return false
    if (el.getAttribute('aria-hidden') === 'true') return false
    // `inert` makes a whole subtree unfocusable, and the attribute normally sits
    // on the ANCESTOR — so this must be `closest`, not `hasAttribute`. Counting
    // an inert element the browser then skips is what un-trapped the dialog.
    if (el.closest('[inert]')) return false
    // `getAttribute` is null when the attribute is absent ⇒ Number(null) === 0,
    // which is exactly the "naturally focusable" case we want to keep.
    if (Number(el.getAttribute('tabindex')) < 0) return false
    // ⚠ `getClientRects()` covers `display:none` and a zero-size subtree ONLY.
    // A `visibility:hidden` element still generates boxes, so it passes this
    // check while the browser refuses to focus it — hence the explicit
    // `visibility` test. (`!== 'visible'` also catches `collapse`, and the
    // property is inherited, so an ancestor's value is already reflected here.)
    if (el.getClientRects().length === 0) return false
    return getComputedStyle(el).visibility === 'visible'
  })
}

// Focus the first candidate walking outward from `startIdx` in direction `dir`
// that actually TAKES focus, wrapping around. Returns false if none did.
//
// ⚠ The "actually takes focus" re-check is the second half of the containment
// guarantee. Any element our filters wrongly keep — a `<details>`, something
// made unfocusable by a mechanism nobody has thought of yet — would otherwise
// park focus permanently on its predecessor, because the next Tab would compute
// the same index and re-target the same dead element.
function focusFirstThatTakes(items, startIdx, dir) {
  const n = items.length
  for (let step = 1; step <= n; step++) {
    const el = items[(((startIdx + dir * step) % n) + n) % n]
    el.focus()
    if (document.activeElement === el) return true
  }
  return false
}

// The trap. Reimplementing Tab is the only way: there is no inert() we can rely
// on, and `aria-modal` is advisory.
//
// ⚠ We ALWAYS `preventDefault()` and move focus ourselves — we never let the
// browser perform the move and only intervene at the two ends. That earlier
// edge-only design made containment depend on `focusablesInside()` agreeing
// with the browser's real tab order, and it disagrees in at least four shipped
// ways: a `<summary>` tail (focusable, absent from the selector), an `[inert]`
// tail (present in the list, skipped by the browser), a `visibility:hidden`
// tail (same), and a positive `tabindex` anywhere (reorders the real sequence,
// so "active === last" never becomes true at the real end). Each one let Tab
// land on the page behind the scrim — i.e. SILENTLY UN-TRAPPING A GATE.
//
// Owning the move inverts the failure mode: containment is now unconditional,
// and the worst a disagreement can do is land focus on a slightly wrong element
// INSIDE the dialog. Consequence to keep in mind: the cycle follows DOM order,
// so a positive `tabindex` inside a trapped modal is not honoured. That is the
// intended trade (and positive tabindex is an antipattern anyway).
//
// Three cases fold into the index walk, and the third is the one that is easy
// to miss:
//   · focus outside the dialog (programmatic, browser find bar) → pull it in;
//   · wrapping at the two ends;
//   · focus on the CONTAINER itself, which is where `onMounted` puts it. Left
//     to the browser, Tab from there walks forward into the dialog (fine) but
//     Shift+Tab walks BACKWARD out of it — i.e. the very first keystroke after
//     the gate opens would escape it.
function trapTab(e) {
  const root = modalEl.value
  if (!root) return
  e.preventDefault()

  const items = focusablesInside()
  if (items.length > 0) {
    const dir = e.shiftKey ? -1 : 1
    const idx = items.indexOf(document.activeElement)
    // Not in the list — the container itself, or something outside the dialog.
    // Seed the walk so the first step lands on the first (Tab) or last
    // (Shift+Tab) item, which is where either key should enter the cycle.
    const start = idx >= 0 ? idx : dir === 1 ? -1 : 0
    if (focusFirstThatTakes(items, start, dir)) return
  }
  // Nothing focusable (or nothing that would accept focus) — fall closed onto
  // the container rather than leaving focus wherever it was.
  root.focus()
}

function onKeydown(e) {
  if (e.key === 'Tab') {
    // Read at event time, like `closable` below — a parent may flip either prop
    // while the modal is open.
    if (trapping.value) trapTab(e)
    return
  }
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

// ⚠ Seam 1 (no focus TRAP) is CLOSED as of RD-FL-2 — see the `trapFocus` prop
// and `trapTab()` above. It is pinned by `e2e/tests/modern-login.spec.js`
// ("Tab and Shift+Tab cannot escape the gate"), which drives the forced
// password-change gate 03 §UC-FL-012 composes on this shell.
//
// ⚠ Seam 2 (a text-selection drag out of `.m-body` closing the modal) is CLOSED
// as of RD-FL-6 — see `onScrimMousedown`/`onScrimClick` above. UC-DS-010 was
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
