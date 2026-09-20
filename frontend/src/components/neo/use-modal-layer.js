// =============================================================================
// THE ONE HOME of "what a thing on `.modal-layer` does" — 18 §UC-PI-004.
//
// Body scroll lock · Escape · capture-phase scrim-mousedown origin rule · focus
// trap · focus restore. Extracted VERBATIM out of `NeoModal.vue` by PI-T2 when
// `NeoDrawer.vue` needed the same five behaviours: "two copies of the scrim logic
// is how one stops working" (18 §UC-PI-004, restating 02 §UC-DS-010's RD-FL-6
// amendment). Every comment below was written for NeoModal and is reproduced
// unchanged — the reasoning is about the LAYER, not about the modal card.
//
// ⚠ THE EXTRACTION IS BEHAVIOUR-PRESERVING BY CONSTRUCTION. Exactly FIVE
// mechanical substitutions were applied to the moved code and nothing else:
//
//     props.closable   → closable()      (a getter, so it is still read at EVENT
//                                         time — see `requestClose`)
//     trapping.value   → trapping()      (same)
//     emit('close')    → onClose()
//     modalEl          → el              (the ref the caller hands in)
//     el (loop/filter  → node            (a rename out of the way of the `el`
//     variable)                           parameter above — same variable, same
//                                         scope, no semantic change)
//
// PROVED, not asserted: strip comments and blank lines from both sides, apply the
// five substitutions to the OLD code, sort, and diff as multisets — 106 statements
// in, 107 out, and the only difference is this file's `export function` signature
// (`docs/learnings/10-portal-ia.md`, PI-T2 §1). The per-behaviour mutation matrix —
// including the FOUR behaviours no shipped test pins — is PI-T2 §2 there.
//
// ⚠ IT IS A PLAIN `.js` MODULE, NOT A `<script setup>` BLOCK, and that is
// load-bearing: the lock counter below MUST be allocated once per PAGE, not once
// per instance (CLAUDE.md: "`<script setup>` has NO module scope: a singleton /
// guard / cache needs a plain `<script>` block"). A module is the stronger form of
// the same rule — and it is now shared across NeoModal AND NeoDrawer, which is
// exactly what makes "a drawer open over a modal does not unlock the page early"
// true rather than hoped for.
// =============================================================================

import { onBeforeUnmount, onMounted } from 'vue'

// ---------------------------------------------------------------------------
// Module-scope state, shared by every layer surface on the page.
// ---------------------------------------------------------------------------

// How many layer surfaces are currently mounted. UC-DS-010 says one modal at a
// time, but "at a time" is not the same as "never for one tick": a route change
// or a parent that swaps `v-if`s can legally overlap two instances for a frame.
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

// Everything the browser will hand a Tab to. `[tabindex]` deliberately matches
// negative values too, so they can be filtered out below rather than silently
// treated as reachable — the `.modal` / `.p2-drawer` container itself is
// `tabindex="-1"`.
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

/**
 * Wire one `.modal-layer` surface.
 *
 * @param el       a template ref holding the dialog container (`tabindex="-1"`).
 * @param closable `() => boolean` — read at EVENT time, never captured.
 * @param trapping `() => boolean` — whether Tab is trapped. Read at event time.
 * @param onClose  called when a close was REQUESTED (scrim, ×, Esc).
 * @param tag      the component name used in the dev-only stacking warning.
 * @returns `{ requestClose, onScrimMousedown, onScrimClick }` for the template.
 */
export function useModalLayer(el, { closable, trapping, onClose, tag = 'NeoModal' } = {}) {
  // Per-INSTANCE pairing flag for the module-scope lock counter above.
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
    if (!closable()) return
    onClose()
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

  function focusablesInside() {
    const root = el.value
    if (!root) return []
    return Array.from(root.querySelectorAll(FOCUSABLE)).filter((node) => {
      if (node.hasAttribute('disabled')) return false
      if (node.getAttribute('aria-hidden') === 'true') return false
      // `inert` makes a whole subtree unfocusable, and the attribute normally sits
      // on the ANCESTOR — so this must be `closest`, not `hasAttribute`. Counting
      // an inert element the browser then skips is what un-trapped the dialog.
      if (node.closest('[inert]')) return false
      // `getAttribute` is null when the attribute is absent ⇒ Number(null) === 0,
      // which is exactly the "naturally focusable" case we want to keep.
      if (Number(node.getAttribute('tabindex')) < 0) return false
      // ⚠ `getClientRects()` covers `display:none` and a zero-size subtree ONLY.
      // A `visibility:hidden` element still generates boxes, so it passes this
      // check while the browser refuses to focus it — hence the explicit
      // `visibility` test. (`!== 'visible'` also catches `collapse`, and the
      // property is inherited, so an ancestor's value is already reflected here.)
      if (node.getClientRects().length === 0) return false
      return getComputedStyle(node).visibility === 'visible'
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
      const node = items[(((startIdx + dir * step) % n) + n) % n]
      node.focus()
      if (document.activeElement === node) return true
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
    const root = el.value
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
      if (trapping()) trapTab(e)
      return
    }
    if (e.key !== 'Escape') return
    if (!closable()) return
    // Stops the key also dismissing something underneath (a native <dialog>, a
    // browser find bar) now that this modal has claimed it.
    e.preventDefault()
    onClose()
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
    el.value?.focus()

    if (openLocks > 1 && import.meta.env.DEV) {
      console.warn(
        `[${tag}] more than one modal is mounted. UC-DS-010 specifies one modal ` +
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

  return { requestClose, onScrimMousedown, onScrimClick }
}
