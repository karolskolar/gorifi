<script setup>
// ⚠ ONE HOME for the admin's per-friend guest-link control cluster (module 14
// §UC-GR-008 + §UC-GR-012). TWO call sites, both in `CycleDetail.vue`'s orders tab:
//
//   1. the friend rows of the orders table (submitted / draft / hosts-guests only);
//   2. the "Hosťovské odkazy (všetci priatelia)" fold below that table, which lists
//      EVERY active friend — the 43-of-76 the table never showed, i.e. exactly the
//      "lost the link before anyone used it" case §UC-GR-008 recorded as a residual.
//
// Extracted rather than copy-pasted, deliberately: this is a money-adjacent control
// whose copy, testids and revoked marker are pinned by `guest-order-recovery.spec.js`,
// and three drifting copies is how one of them ends up offering a revoked link for
// forwarding as if it worked.
//
// ⚠ NO TOKEN EVER REACHES THE DOM (§UC-GR-007's promoted rule). This component is
// handed the whole `link` row but renders NOTHING out of it except the `active` /
// `host_active` flags; both URLs are composed in the PARENT, in JS, at click time.
// The controls' only hook is the friend id.
//
// ⚠ ADMIN SKIN ONLY — shadcn / Tailwind utilities, zero `neo/` classes, zero theme
// tokens, no `.app` scope (01-architecture design-system scope rule).
//
// All mutation state (pending flags, `rowSeq`, row errors, the inline confirm) stays
// in the parent: one friend has ONE mutation state regardless of which of the two
// surfaces the click came from, so a create started in the fold is visible as pending
// in the table row too and can never be double-submitted from the other surface.
import { computed } from 'vue'

const props = defineProps({
  friendId: { type: [Number, String], required: true },
  // The joined link row (`GET /api/guest-links/cycle/:id/all`) or null when this
  // friend has never shared. Never rendered — only inspected.
  link: { type: Object, default: null },
  // Distinct per call site so the two surfaces can render the SAME friend at once
  // without colliding in Playwright's strict mode. The orders table keeps the
  // shipped `host-guest-link*` ids; the fold uses its own namespace.
  testidPrefix: { type: String, default: 'host-guest-link' },
  copied: { type: Boolean, default: false },
  createPending: { type: Boolean, default: false },
  regenPending: { type: Boolean, default: false },
  confirmOpen: { type: Boolean, default: false },
  error: { type: String, default: '' },
})

defineEmits(['copy', 'create', 'regenerate', 'open-confirm', 'close-confirm'])

// A link under a DEACTIVATED host 410s for every guest even while `active = 1`
// (routes/guest.js `resolveEntry`, formerly `resolveLink`), so the marker has to answer BOTH halves —
// otherwise the admin forwards a URL that is dead for a reason the row never said.
const isDead = computed(() => !props.link || !props.link.active || !props.link.host_active)

const tid = (suffix) => `${props.testidPrefix}${suffix ? `-${suffix}` : ''}-${props.friendId}`
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 font-normal">
    <template v-if="link">
      <button
        type="button"
        class="text-xs text-primary underline underline-offset-2 hover:no-underline"
        :data-testid="tid('')"
        @click="$emit('copy')"
      >{{ copied ? 'Skopírované!' : 'Hosťovský odkaz' }}</button>
      <!-- ⚠ MARKED, not silently offered as if it worked: a revoked link (or one
           under a deactivated host) 410s for every guest. D3 keeps reactivation
           host-only — the person who distributed the URL is the only one who knows
           who holds it — so this states the fact and offers no control. -->
      <span
        v-if="isDead"
        class="text-xs text-muted-foreground"
        :data-testid="tid('inactive')"
      >neaktívny</span>
      <!-- ⚠ THE ADMIN REGENERATE (D3 as AMENDED — PO decision, 2026-08-31). The
           host's own regenerate refuses while colleagues have live orders on the link
           and their dialog says "kontaktujte správcu"; this is that target. It
           rotates the token only — there is still no admin deactivate/reactivate, so
           a revoked link stays revoked and this control can never republish a leaked
           URL. -->
      <button
        v-if="!confirmOpen"
        type="button"
        class="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50 disabled:no-underline"
        :disabled="regenPending"
        :data-testid="tid('regen')"
        @click="$emit('open-confirm')"
      >{{ regenPending ? 'Generujem...' : 'Nový odkaz' }}</button>
      <!-- Inline confirm, because the consequence is not reversible and is easy to
           get wrong in both directions.
           ⚠ Both sentences are FACTUAL and must not be softened or swapped: the
           server UPDATEs `token` on the existing row (never DELETE+INSERT, which
           would cascade the sub-orders away), and every order already placed resolves
           by `order_token` alone (§UC-GR-001/002) — which is precisely what made
           amending D3 safe.
           Copy is DRAFT pending PO sign-off (14 §OPEN); mirrored as constants in
           `guest-order-recovery.spec.js`. -->
      <span
        v-else
        class="text-xs inline-flex flex-wrap items-center gap-1.5"
        :data-testid="tid('regen-confirm')"
      >
        <span class="text-muted-foreground">Starý odkaz prestane prijímať nové objednávky. Už vytvorené objednávky kolegov zostanú funkčné.</span>
        <button
          type="button"
          class="text-destructive underline underline-offset-2 hover:no-underline disabled:opacity-50"
          :disabled="regenPending"
          :data-testid="tid('regen-yes')"
          @click="$emit('regenerate')"
        >Áno, vygenerovať</button>
        <button
          type="button"
          class="text-muted-foreground underline underline-offset-2 hover:no-underline"
          :data-testid="tid('regen-no')"
          @click="$emit('close-confirm')"
        >Nie</button>
      </span>
    </template>
    <button
      v-else
      type="button"
      class="text-xs text-primary underline underline-offset-2 hover:no-underline disabled:opacity-50 disabled:no-underline"
      :disabled="createPending"
      :data-testid="tid('create')"
      @click="$emit('create')"
    >{{ createPending ? 'Vytváram...' : 'Vytvoriť hosťovský odkaz' }}</button>
    <span
      v-if="error"
      class="text-xs text-destructive"
      :data-testid="tid('error')"
    >{{ error }}</span>
  </div>
</template>
