<script setup>
// The neo checkbox (UC-DS-009) — subscription toggles and remember-me (module 03),
// the host's big green "Odovzdané" hand-over tick (module 05).
//
// Transcribed from `docs/design/friends-portal-redesign/friends/ui.jsx` `Checkbox`:
// a bare `span.cbox` wrapping a white flex span around the `check` glyph. The tick is
// always in the DOM — `friends-theme.css` hides it with `.cbox svg{display:none}` and
// reveals it with `.cbox.on svg{display:block}`, so the checked state is pure CSS.
//
// The glyph comes from `NeoIcon name="check"` (stroke-width 3.6, the fat tick) — there
// is exactly one copy of that path in the codebase, in `icons.js`.
//
// The component carries NO label. Consuming screens compose their own label row, and
// own any "the whole name block toggles" behaviour (module 05).

import NeoIcon from './NeoIcon.vue'

const props = defineProps({
  modelValue: { type: Boolean, required: true },
  // 32px variant (`.cbox.big`) instead of the default 24px.
  big: { type: Boolean, default: false },
  // Green `--ok` checked fill instead of magenta `--accent`. Reserved for the
  // delivery/hand-over semantics — green means done/money-good across this system.
  ok: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false }
})

const emit = defineEmits(['update:modelValue'])

function toggle() {
  if (props.disabled) return
  emit('update:modelValue', !props.modelValue)
}

// The prototype's control is a bare `span` with an onClick, which is unreachable by
// keyboard and announces as nothing. The ARIA layer below renders no pixel, so it is a
// permitted enhancement (UC-DS-009). Space is the native checkbox activation key and
// Enter is accepted too, matching what people expect from a click-target span; both
// preventDefault so Space cannot also scroll the page.
function onKeydown(e) {
  if (props.disabled) return
  if (e.key !== ' ' && e.key !== 'Enter') return
  e.preventDefault()
  toggle()
}

// ⚠ `tabindex` stays 0 even when disabled — do NOT make it `disabled ? -1 : 0`.
// This is `aria-disabled` on a span, not native `disabled` on an <input>: the ARIA
// idiom is "disabled but present and discoverable", so the APG keeps the element
// focusable. `tabindex="-1"` alongside `aria-disabled="true"` is the worst of both —
// the state is announced only to someone who can already reach it, and Tab cannot.
// Module 05 makes this concrete: `disabled` marks locked / pending hand-over rows,
// where the disabled state IS the information a keyboard or screen-reader user came
// for. Nothing leaks, because the guards above already refuse click/Space/Enter.
</script>

<template>
  <span
    class="cbox"
    :class="{ big, ok, on: modelValue }"
    role="checkbox"
    :aria-checked="modelValue"
    :aria-disabled="disabled ? 'true' : null"
    tabindex="0"
    :style="disabled ? 'opacity:.35;cursor:not-allowed' : null"
    @click="toggle"
    @keydown="onKeydown"
  >
    <span style="color:#fff;display:flex"><NeoIcon name="check" /></span>
  </span>
</template>
