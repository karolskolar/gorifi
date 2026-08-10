<script setup>
// The horizontal-scroll affordance for the `.cat-tabs` category strip.
//
// WHY IT EXISTS. A cycle with more purposes than fit ("Espresso · Filter ·
// Filter Special · Brew Bags · …") scrolls sideways, and the only signal the
// theme gives is `.cat-tabs::after` — a 28px `transparent → --bg` fade. Users
// read that as a soft edge, not as "there is more to the right", so categories
// past the fold went unfound. This adds an accent control at the strip's right
// edge that both SIGNALS the overflow and PERFORMS the scroll.
//
// ⚠ ONE component, TWO call sites — `views/FriendOrder.vue` and
// `components/GuestProductGrid.vue` render byte-identical strips (the guest grid
// serves both `/g/:token` and the status/edit screen). They are the same control
// and must not diverge, so the arrow lives here rather than being inlined twice.
//
// ⚠ IT MUST BE A DIRECT CHILD OF `.cat-tabs`, and it finds that scroller through
// its own `parentElement`. That is not a shortcut around a prop: `position:
// sticky` only pins against the scroll container the element actually lives in,
// so "the element I am a child of" and "the element I control" are necessarily
// the same node. A prop could disagree with the DOM; `parentElement` cannot.
//
// ⚠ WHY NOT A THEME RULE. `friends-theme.css` is a byte-for-byte canon port with
// a numbered adaptation list (A1–A11); every addition to it has to be justified
// as a numbered adaptation. Nothing here needs to reach an existing theme class,
// so the whole control is self-contained in the `<style scoped>` block below and
// the stylesheet is untouched.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import NeoIcon from './neo/NeoIcon.vue'

const root = ref(null)
const visible = ref(false)

let scroller = null
let ro = null

// Visible ONLY when the strip genuinely overflows AND is not already parked at
// the right end. Two short categories that already fit ⇒ no arrow at all; an
// arrow that cannot scroll anywhere is a lie about the content.
//
// The 1px slack on both comparisons is subpixel tolerance, not slop:
// `scrollWidth`/`clientWidth` are integers rounded from fractional layout, and
// `scrollLeft` is fractional in Chromium, so an exactly-at-the-end strip
// routinely reports `max - scrollLeft` around 0.5px.
function measure() {
  if (!scroller) return
  const max = scroller.scrollWidth - scroller.clientWidth
  visible.value = max > 1 && scroller.scrollLeft < max - 1
}

// Roughly one strip-width, deliberately a little less: the tab that was at the
// right edge stays on screen at the left as an anchor, so the user can see what
// they scrolled past. The strip is `scroll-snap-type: x proximity`, so the
// browser settles this on a tab edge — that is the intended behaviour and is not
// fought here (no snap override, no manual correction afterwards).
function scrollRight() {
  if (!scroller) return
  scroller.scrollBy({ left: Math.round(scroller.clientWidth * 0.8), behavior: 'smooth' })
}

onMounted(() => {
  scroller = root.value?.parentElement || null
  if (!scroller) {
    if (import.meta.env.DEV) {
      console.warn('[CatScrollArrow] must be a direct child of the scrolling strip — rendering nothing.')
    }
    return
  }
  scroller.addEventListener('scroll', measure, { passive: true })
  ro = new ResizeObserver(measure)
  ro.observe(scroller)
  measure()
  // ⚠ Tab widths are FONT-METRIC driven and Figtree loads asynchronously, so the
  // first measurement runs against the fallback face. Without this re-measure a
  // strip that only overflows once the real font lands would show no arrow until
  // something else happened to trigger a scroll or resize.
  document.fonts?.ready.then(measure).catch(() => {})
})

onBeforeUnmount(() => {
  if (scroller) scroller.removeEventListener('scroll', measure)
  ro?.disconnect()
  ro = null
  scroller = null
})
</script>

<template>
  <!-- ⚠ `aria-hidden` + `tabindex="-1"`: pointer-only by design. `.cat-tabs` is a
       `role="tablist"` whose children are `role="tab"` — a focusable button is not
       a valid tablist child, and `mobile-no-h-overflow.spec.js` counts
       `strip.getByRole('tab')`, so an exposed control here would both break the
       ARIA contract and inflate that count. This is the house precedent, not a
       shortcut: the appbar's profile pencil is `aria-hidden` for exactly the same
       reason — exactly ONE control answers to an action's name, and an adjacent
       duplicate stays out of the tree. No function is lost: keyboard users already
       reach every category by tabbing, and focusing a tab scrolls it into view.

       ⚠ The element is ALWAYS rendered and toggles the `on` class rather than
       being `v-if`'d away, for two reasons. (1) `parentElement` — the scroller
       reference above — only exists while the node does. (2) The resting state is
       `display:none` AND `position:static`, which keeps a hidden affordance out of
       the page's sticky census (`guest-order-shell.spec.js` pins the exact set of
       sticky elements inside `.app`); a `position:sticky` element still computes
       as sticky while `display:none`. -->
  <span
    ref="root"
    class="catarrow"
    :class="{ on: visible }"
    data-testid="cat-scroll-arrow"
    aria-hidden="true"
    tabindex="-1"
    @click="scrollRight"
  >
    <NeoIcon name="chev" :size="18" />
  </span>
</template>

<style scoped>
/* Resting state: no box, no sticky positioning, nothing in the sticky census. */
.catarrow {
  display: none;
}

.catarrow.on {
  /* ⚠ `sticky` inside the horizontally scrolling strip is the theme's OWN
     technique — `.cat-tabs::after` is `position:sticky; right:-1px` and pins the
     fade to the right edge exactly this way. It is also the only technique that
     works here: `.cat-tabs` is itself `position:sticky; top:0`, so wrapping it in
     a positioned container to get `position:absolute` would give the strip no
     travel and silently stop it sticking (`order-shell.spec.js` pins that), and
     `display:contents` on such a wrapper generates no box to position against. */
  position: sticky;
  right: 4px;
  /* ⚠ ABOVE THE FADE. `.cat-tabs::after` is generated content, so it is the last
     thing in the box's paint order and — being `position:sticky` with `z-index:
     auto` — would wash its `transparent → --bg` gradient straight over this
     control. Any positive z-index puts the arrow in front; measured, not eyeballed
     (`cat-scroll-arrow.spec.js` samples the rendered pixel). */
  z-index: 2;

  display: flex;
  align-items: center;
  justify-content: center;
  align-self: center;

  /* ⚠ ZERO NET CONTRIBUTION TO `scrollWidth`. As a flex item this control would
     add its own 36px plus one more 8px `gap` to the strip's scrollable content —
     44px that would make a strip whose tabs comfortably FIT report an overflow and
     render an arrow that scrolls nothing, and that would change `scrollWidth` as
     the arrow appears and disappears at the right end. `margin-left` cancels both
     terms exactly (`-(36 + 8)`), so `scrollWidth` is identical whether the arrow
     is showing or not. The 8px is `.cat-tabs { gap: 8px }` from the theme; if that
     gap ever changes, this number moves with it. */
  flex: 0 0 36px;
  height: 36px;
  margin-left: -44px;

  border: 3px solid var(--nb-ink);
  border-radius: 10px;
  background: var(--accent);
  color: var(--accent-ink);
  box-shadow: 3px 3px 0 var(--nb-ink);
  cursor: pointer;
  /* Explicit, because Tailwind preflight leaves an inline child in an unclassed
     block inheriting 1.5 — the glyph would sit off-centre. */
  line-height: 1;
}

/* The house press physics, copied from the theme's `.stepper button:active`. */
.catarrow.on:active {
  transform: translate(2px, 2px);
  box-shadow: 0 0 0 var(--nb-ink);
}
</style>
