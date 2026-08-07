<script setup>
// The copy row (UC-DS-011) — the link/reference control with the 2-second green
// "Skopírované!" flip: share link (module 05), guest status URL and payment
// reference (module 06), invite link (module 03).
//
// Transcribed from `docs/design/friends-portal-redesign/friends/ui.jsx`
// `CopyRow`: `div.copyrow` → `div.val` + `button.btn`, same two labels, same
// `.ok` class while copied, same 2000 ms window. No toast, no other feedback —
// the button IS the feedback.

import { onBeforeUnmount, ref } from 'vue'

const props = defineProps({
  value: { type: String, required: true },
  // `.btn.sm` (38px) instead of the default 44px button.
  small: { type: Boolean, default: false },
  // Optional `data-testid` on the `.val` element so consuming views keep their
  // already-pinned e2e hooks (module 05 UC-KG-006). `null` — the default —
  // binds to nothing at all: Vue omits a null attribute, so the DOM carries no
  // `data-testid` rather than the literal string "undefined" (RD-DS-3's rule).
  valueTestid: { type: String, default: null }
})

const copied = ref(false)

// Not a `ref`: nothing renders from it, so reactivity would only cost a
// re-render per tick of bookkeeping.
let timer = null

function copy() {
  // ⚠ The flip happens regardless of whether the write succeeded — the
  // prototype's try/catch semantics, kept deliberately. `navigator.clipboard`
  // is undefined on a non-secure origin and `writeText` rejects on several
  // browsers when the document is not focused; in both cases the UI must not
  // strand at "Kopírovať" while the value actually reached the clipboard, and
  // must not lie loudly when it did not.
  //
  // The call is NOT awaited, also per the prototype: awaiting would delay the
  // flip behind a permission prompt. The `.catch` only exists to keep a
  // rejection from surfacing as an unhandled promise rejection.
  try {
    const written = navigator.clipboard?.writeText(props.value)
    if (written && typeof written.catch === 'function') written.catch(() => {})
  } catch (e) {
    // Clipboard API missing or blocked outright — fall through to the flip.
  }

  // Restart, don't stack: the intended behaviour is "green for 2 s after the
  // LAST click". The prototype leaks the previous timeout, so a second click
  // inside the window turns the button back to "Kopírovať" 2 s after the FIRST
  // one — i.e. the feedback for the click you just made disappears early.
  if (timer) clearTimeout(timer)
  copied.value = true
  timer = setTimeout(() => {
    copied.value = false
    timer = null
  }, 2000)
}

// A pending timer holds a closure over this instance and would fire into a
// destroyed component if the row is unmounted inside the 2 s window (a modal
// closed right after copying — the single most likely case for this control).
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
  timer = null
})

// Note on the template below (kept here rather than as a template comment, so
// the rendered DOM stays identical to the prototype's in dev as well as prod):
// `.val` truncates visually via `text-overflow:ellipsis`, but `title` and the
// clipboard always carry the FULL value — never shorten `value` itself, a
// truncated share link is a broken share link. The `flex:1;min-width:0` chain
// that makes the ellipsis work (instead of the row overflowing its container)
// comes from `.copyrow .val` in friends-theme.css, not from here.
</script>

<template>
  <div class="copyrow">
    <div class="val" :title="value" :data-testid="valueTestid">{{ value }}</div>
    <button type="button" class="btn" :class="{ sm: small, ok: copied }" @click="copy">
      {{ copied ? 'Skopírované!' : 'Kopírovať' }}
    </button>
  </div>
</template>
