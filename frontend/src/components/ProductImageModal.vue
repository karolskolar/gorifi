<script setup>
// The product-photo lightbox (product decision 2026-08-20). The card renders the
// photo at 58/70px (frameless, uncropped — same decision earlier that day), which
// is too small to read the text printed on a coffee bag; tapping it opens this.
//
// ⚠ ONE HOME, TWO CALL SITES — `views/FriendOrder.vue` and
// `components/GuestProductGrid.vue` (which itself serves both `/g/:token` and the
// status/edit screen). 06 §UC-GX-002 keeps the friend and guest cards
// pixel-identical, so a forked lightbox would be a divergence by construction.
// Extend this component; never inline a second copy.
//
// ⚠ Built on `NeoModal`, NOT a hand-rolled fixed overlay. A `position:fixed`
// overlay that is a direct child of `.app` silently computes `position:relative`
// (the `.app > *` rule at equal specificity, documented in CLAUDE.md), and the
// friend order screen IS an `.app` scope. NeoModal teleports to `body` and brings
// the scroll lock, Escape, scrim-close (with the mousedown-origin guard), focus
// restore and the ARIA wiring already pinned by its own specs.
import NeoModal from '@/components/neo/NeoModal.vue'

defineProps({
  // A `data:` URI today (`products.image`). Nothing here assumes that — the
  // planned DB consolidation may turn it into a URL, and an `<img src>` takes
  // either unchanged.
  image: { type: String, required: true },
  // The product name: the dialog title, and what makes the accessible name of
  // the modal say WHICH product is being shown.
  name: { type: String, required: true }
})

defineEmits(['close'])
</script>

<template>
  <NeoModal :title="name" wide :trap-focus="true" @close="$emit('close')">
    <!-- ⚠ `width:100%` + `height:auto`, and DELIBERATELY NO `max-height`.
           · width:100%  — fill the dialog, which is the whole point: a 390px
                           phone gives ~310px here against 58px on the card.
           · height:auto — the natural ratio, so nothing is ever cropped or
                           stretched (the same rule the card itself follows).
         ⚠ A `max-height:70vh` cap was written first and REMOVED after measuring:
         combined with `width:100%` it makes the BOX 100% × 70vh, so a portrait
         photo — which a coffee bag usually is — gets letterboxed inside it with
         dead bands either side, i.e. rendered SMALLER than the dialog allows,
         which is exactly the complaint this row answers. Without the cap a tall
         photo simply makes the dialog tall and `.modal-scrim` (already
         `overflow-y:auto`) scrolls it; the × sits at the top where the reader
         starts, and Escape and a scrim tap close it from anywhere. With
         `height:auto` doing the work, `object-fit` never applies and is not set.
         No background, no border, no frame — a transparent PNG stays transparent
         here exactly as it does on the card.
         Pinch-zoom still works for finer detail: the viewport meta deliberately
         carries neither `maximum-scale` nor `user-scalable=no` (theme adaptation
         A12), and NeoModal's scroll lock does not disable it. -->
    <img
      :src="image"
      :alt="name"
      data-testid="product-photo-full"
      style="display:block;width:100%;height:auto;margin:0 auto"
    />
    <template #footer>
      <!-- The house footer control. NeoModal's × is named "Zatvoriť dialóg"
           precisely so this one can be the only "Zavrieť" in the tree — see the
           long note on that span. On a phone this is also the thumb-reachable
           close, which the × in the top corner is not. -->
      <button class="btn" @click="$emit('close')">Zavrieť</button>
    </template>
  </NeoModal>
</template>
