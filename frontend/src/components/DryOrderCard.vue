<script setup>
// „Som na suchu!" (PO 2026-10-09) — the urgent-delivery card in the friend's „Hotovo!"
// modal. Design: Claude Design project „Podpultovka Friends", `Som na suchu.html` +
// `friends/portal2.jsx DryCard` + `friends/portal2.css` §Som na suchu (variant B — the
// card AFTER sending; the cart-bar chip variant A was not chosen).
//
// ⚠ COPY IS PO COPY, IN THE TY-FORM (PO 2026-10-10) — a sanctioned exception to the
// friend surface's vy-form, like „Ako to funguje" (CLAUDE.md, top). ~~The first cut
// rendered the prototype's text in vy („Dochádza vám káva?…")~~ — the PO replaced it
// with the strings below. Reproduce, never improve (uppercase headings included).
//
// The card only PRESENTS and EMITS; the owner (`FriendOrder.vue`) does the request,
// owns `pending`/`error`, and decides `on` from the server's `orders.urgent_at`.

defineProps({
  on: { type: Boolean, default: false },
  pending: { type: Boolean, default: false },
  error: { type: String, default: '' }
})

const emit = defineEmits(['change'])
</script>

<template>
  <div class="dry-wrap" data-testid="dry-card" :data-on="on ? 'true' : 'false'">
    <div v-if="on" class="dry-card on">
      <span class="cbox on dry-cbox" aria-hidden="true">
        <span style="color:#0a0a0a;display:flex">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
        </span>
      </span>
      <div style="min-width:0;flex:1">
        <b>SI NA SUCHU - Viem.</b>
        <div class="sub">Držme si palce, aby si mal/a kávu čo najskôr!</div>
      </div>
      <button
        type="button"
        class="dry-undo"
        data-testid="dry-undo"
        :disabled="pending"
        @click="!pending && emit('change', false)"
      >Zrušiť</button>
    </div>

    <div v-else class="dry-card">
      <div style="min-width:0;flex:1">
        <b>NEMÁŠ UŽ ŽIADNU KÁVU?</b>
        <div class="sub">Klikni „SOM NA SUCHU!“ a ja sa ti pokúsim kávu doručiť prednostne (v rámci možností). Použi len v prípade núdze!</div>
      </div>
      <button
        type="button"
        class="btn dry sm"
        data-testid="dry-on"
        :disabled="pending"
        @click="!pending && emit('change', true)"
      >SOM NA SUCHU!</button>
    </div>

    <div v-if="error" class="dry-err" role="alert">{{ error }}</div>
  </div>
</template>

<style scoped>
/* Ported from the design's `portal2.css` §„Som na suchu!" (`.dry-card`, `.btn.dry`,
   `.dry-undo`); the cart-bar chip/popover rules are not used. The phone `stack`
   variant is a width query here instead of a `phone` prop. */
.dry-wrap { display: flex; flex-direction: column; gap: 6px; }
.dry-card {
  display: flex; align-items: center; gap: 12px;
  border: 2px solid var(--nb-ink, #0a0a0a); border-radius: 10px;
  background: var(--warn-soft, #fff1cf);
  padding: 12px; font-size: 14px; line-height: 1.35; text-wrap: pretty;
}
.dry-card .sub { font-size: 13px; margin-top: 2px; line-height: 1.35; }
.dry-card.on { background: #f2b705; align-items: flex-start; }
.dry-card.on .sub { color: #0a0a0a; }
.cbox.on.dry-cbox { flex-shrink: 0; background: #fff; }
.btn.dry { background: #f2b705; color: #0a0a0a; white-space: nowrap; flex-shrink: 0; }
.dry-undo {
  font-size: 12px; font-weight: 700; text-decoration: underline; cursor: pointer;
  flex-shrink: 0; padding: 2px 0 0; background: none; border: 0; color: inherit;
}
.dry-undo:disabled, .btn.dry:disabled { opacity: .5; cursor: default; }
.dry-err { font-size: 13px; color: var(--danger, #d4183d); }

@media (max-width: 520px) {
  .dry-card:not(.on) { flex-direction: column; align-items: stretch; gap: 10px; }
  .dry-card:not(.on) .btn { width: 100%; }
}
</style>
