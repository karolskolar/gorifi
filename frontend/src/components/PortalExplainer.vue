<script setup>
// 18 §UC-PI-012 — „AKO TO FUNGUJE", THE EXPLAINER (PI-T8).
//
// The friend surface that says what Podpultovka IS: six phases, the three ways the
// coffee reaches you, who we are, how you pay, and a note from the person who runs
// it. Composed from `portal2.jsx:122-190` (`Explainer`) with §16's copy fixes.
//
// ⚠⚠ THE LIVE TIMELINE IS NOT MOUNTED HERE, AND THAT IS THE DECISION, NOT AN
// OVERSIGHT. `CycleTimeline.vue` (module 17, CS-T2) renders the SAME six phases and
// the temptation to reach for it here is the obvious one — §UC-PI-012 item 3 forbids
// it in as many words („the LIVE timeline is module 17's component and is not mounted
// in the explainer"). The two answer different questions: this page explains the
// PROCESS in general, to a friend who may have no round in flight at all; the
// timeline reports where ONE particular round is right now. A timeline here would be
// wrong on every screen where the answer is „no round is running", which is most of
// the time (phase 1 is literally „Väčšinu času sa neobjednáva"). The phase copy below
// is therefore STATIC TEXT owned by this file, and it deliberately does not import
// `lib/cycle-stages.js` — pinned in `portal-explainer.spec.js` §1.
//
// ⚠ THE COPY IS THE PRODUCT OWNER'S. The roaster descriptions (`lib/roasters.js`),
// the „— Lego" note, the „(PayMe)" in §Ako platím and the WhatsApp mention in phase
// 2 are all recorded decisions or PO drafts marked `OPEN:` in the spec. Reproduce
// them; do not improve the prose. „(PayMe)" in particular looks redundant beside
// „bankovú appku" and is not: module 15 shipped the PayMe bar deliberately
// (15 §UC-PL-005), and §UC-PI-012 item 6 resolves its `OPEN:` to „keep".
//
// ⚠ NOT A DIRECT CHILD OF `.app`. It is mounted inside `FriendPortalSession.vue`'s
// page column, so nothing here is subject to the `.app > *` `position:relative;
// z-index:1` cascade — but the component also declares no `fixed`/`sticky`/`z-*` of
// its own, so a future call site cannot be broken by that rule either. The one
// overlay this module needs (the roaster popover) lives in `FriendOrder.vue`, on the
// modal layer.
//
// ⚠ PO COPY PASS 2026-09-29: this page speaks in the TY-FORM („môžeš", „dozvieš") —
// the ONE friend surface that does; the rest of the UI stays vy-form. Phase 1 is
// „Čas na kávu", the note is signed „— Lego" (avatar „L"), and the Bratislava row is
// a static delivery sentence, so the component no longer fetches pickup locations.
import { ref, computed } from 'vue'
import { fmtEur } from '@/lib/money'
import { ROASTERS } from '@/lib/roasters'
import NeoIcon from '@/components/neo/NeoIcon.vue'
import NeoCheckbox from '@/components/neo/NeoCheckbox.vue'

const props = defineProps({
  /**
   * ⚠ THE SEAM FOR PI-T9 (§UC-PI-013), BUILT NOW SO THAT ROW PASSES A FLAG RATHER
   * THAN EDITING THIS FILE.
   *
   * `false` (the menu / the closed-landing modal / the drawer): one button,
   * „Späť na ponuku". `true` (the first-login gate): the pre-ticked „Už mi to
   * neukazovať" checkbox plus „Rozumiem, idem na ponuku".
   *
   * It changes NOTHING else — the six phases, the ways, the roasters, the payment
   * section and the note are the same page in both modes, which is the whole reason
   * the gate can reuse this view instead of forking it.
   *
   * ⚠ WHAT PI-T9 MUST NOT HAVE TO TOUCH: this component and `lib/roasters.js`. It
   * passes ~~`:as-gate="explainerPending"`~~ at the ONE call site in
   * `FriendPortalSession.vue` and handles `@done`'s payload there (the `hide` flag
   * decides whether `markExplainerSeen()` fires). Routing stays in the session, which
   * is where every other `router.push` on the authenticated surface already lives.
   *
   * ⚠ **PI-T9 SHIPPED, and it binds `:as-gate="explainerGate"` — a `ref`, not the
   * prop.** `explainerPending` is the LOGIN payload's field, true for the whole
   * session; `explainerGate` is seeded from it once at setup and LOWERED the moment
   * the friend leaves the explainer view, so a later visit from the menu is not a
   * gate. Binding the prop directly would re-arm the gate on every menu visit.
   * The prediction above was right about the SEAM (this file was not touched) and
   * wrong about the expression — see `docs/learnings/10-portal-ia.md` §PI-T9.
   */
  asGate: { type: Boolean, default: false },
  /**
   * §UC-PI-012 item 4's Packeta badge: `(currentCycle ?? catalogCycle)?.parcel_enabled`.
   * The `??` is resolved by the CALLER, because `landing` is the session's shape and
   * this component knows nothing about rounds — it is told whether parcel delivery is
   * on offer and what it costs, nothing more.
   */
  parcelEnabled: { type: Boolean, default: false },
  parcelFee: { type: Number, default: 0 }
})

const emit = defineEmits(['done'])

/**
 * „Už mi to neukazovať" — PRE-TICKED (§UC-PI-012 item 8, 18 resolved conflict 3).
 * Inert while `asGate` is false: the checkbox is not rendered, and the `done` payload
 * still carries the flag so the handler has one shape to read.
 */
const hide = ref(true)

// ── §UC-PI-012 item 3: the six phases, as STATIC TEXT ────────────────────────
// Frozen and module-scoped-by-`const`: nothing here is reactive, nothing here is
// derived from a round. See the header for why this is not `CycleTimeline`.
const PHASES = [
  { n: 1, icon: 'pause', title: 'Čas na kávu', text: 'Väčšinu času sa neobjednáva. Ponuku si môžeš prezrieť, košík je zamknutý.' },
  { n: 2, icon: 'bell', title: 'Ohlásenie objednávky', text: 'Pár dní vopred sa dozvieš, kedy sa objednávky otvoria. V appke aj cez WhatsApp.' },
  { n: 3, icon: 'cup', title: 'Objednávanie', text: 'Zvyčajne 5–7 dní. Naklikáš si kávu, odošleš, do uzavretia môžeš meniť.' },
  { n: 4, icon: 'truck', title: 'Čakáme na pražiareň', text: 'Objednávky uzavrieme, kávu objednáme. Praží sa na čerstvo, trvá to okolo týždňa.' },
  { n: 5, icon: 'box', title: 'Balíme', text: 'Káva dorazila, každému zabalíme jeho objednávku. Vtedy je čas zaplatiť.' },
  { n: 6, icon: 'hand', title: 'Odovzdanie', text: 'Vyzdvihneš si ju na odbernom mieste, od priateľa alebo príde Packetou.' }
]

// ── §UC-PI-012 item 4: „Ako sa ku káve dostanete" ────────────────────────────

/**
 * §UC-PI-012 item 4: the Packeta row's badge is „+{fmtEur(parcel_fee)}" when the
 * resolved round has `parcel_enabled`; OTHERWISE THERE IS NO BADGE AT ALL — not
 * „zdarma", not „+0.00 EUR". Packeta being off is not a price of zero.
 */
const parcelBadge = computed(() => (props.parcelEnabled ? `+${fmtEur(props.parcelFee)}` : null))

// ── §UC-PI-012 item 8: the actions ───────────────────────────────────────────
//
// ⚠ IT EMITS; IT DOES NOT NAVIGATE AND IT WRITES NOTHING. `FriendPortalSession.vue`
// owns routing on the authenticated surface (`backHome()`, `onMenuSelect()`), and
// PI-T9 owns `markExplainerSeen()`. The payload carries `hide` so that row reads a
// value rather than a second ref.
function done() {
  emit('done', { hide: hide.value })
}
</script>

<template>
  <!-- `portal2.jsx:143` — the explainer's own flex column, because the page column
       is not one (the history and balance views do the same). -->
  <div
    class="p2-explainer"
    style="display:flex;flex-direction:column;gap:18px;padding-bottom:12px"
    data-testid="portal-explainer"
  >
    <!-- ⚠ 40px on phone / 52px on desktop (§UC-PI-012 item 1). The `<br>` and the
         `<span>` CONCATENATE in the accessible name — but NOT the way §UC-PI-012
         originally claimed. ~~`getByRole('heading', { name: /Káva pod ?pultom, spolu\./ })`
         resolves~~ — **it does not.** `.p2-hl` is `display:inline-block`
         (`friends-theme.css:533`), and a non-`inline` display makes the accname
         computation pad EVERY boundary, including the one before the comma. The real
         name is „Káva pod pultom **,** spolu.", so the criterion is
         `/Káva\s*pod\s*pultom\s*,\s*spolu\./` — pinned that way in
         `portal-explainer.spec.js`, and corrected in the spec.
         ⚠⚠ **DO NOT „fix“ this by rewriting the markup** to make the old pattern
         true: the `<br>` and the highlight are the prototype's, and the `.p2-hl`
         assertion beside the heading pin exists to stop exactly that repair.
         `.p2-hl` is the theme's own accent block (`friends-theme.css:533`); the
         size is the only thing this call site supplies, through Tailwind, because
         `.h-screen` deliberately declares no `font-size`. -->
    <h1 class="h-screen text-[40px] sm:text-[52px]" style="line-height:1.08;margin-top:4px">
      Káva pod<br /><span class="p2-hl">pultom</span>, spolu.
    </h1>

    <p class="sub" style="font-size:15px;line-height:1.45;margin:0">
      Podpultovka je spoločná objednávka výberovej kávy pre okruh priateľov. Raz za pár
      týždňov otvoríme objednávky, nakúpime priamo v pražiarni za lepšiu cenu a rozdáme si
      to medzi sebou.
    </p>

    <!-- ══ 1. THE SIX PHASES (§UC-PI-012 item 3) — static text, no timeline ══ -->
    <div style="display:flex;flex-direction:column;gap:16px">
      <div v-for="phase in PHASES" :key="phase.n" class="p2-step" data-testid="explainer-phase">
        <div class="ico">
          <NeoIcon :name="phase.icon" />
          <span class="n">{{ phase.n }}</span>
        </div>
        <div style="min-width:0;padding-top:2px;overflow-wrap:anywhere">
          <div class="display" style="font-size:20px;line-height:1">{{ phase.title }}</div>
          <div class="sub" style="font-size:14px;line-height:1.4;margin-top:5px">{{ phase.text }}</div>
        </div>
      </div>
    </div>

    <!-- ══ 2. „AKO SA KU KÁVE DOSTANETE" (§UC-PI-012 item 4) ══════════════════
         Three `.card.flat` rows, each icon + `<b>` title + trailing badge + `.sub`.
         ⚠ R3.4.1 IS DROPPED (spec, item 4): this page RECOMMENDS, it restricts
         nothing — free-text pickup stays open to everyone. -->
    <div>
      <div class="field-lbl" style="margin-bottom:10px">Ako sa ku káve dostaneš</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <!-- WAY 1 — the Bratislava pickup points. -->
        <div class="card flat" style="padding:12px 14px;display:flex;gap:12px;align-items:flex-start" data-testid="explainer-way">
          <span style="display:flex;flex-shrink:0;padding-top:2px"><NeoIcon name="pin" :size="20" /></span>
          <!-- ⚠ `overflow-wrap:anywhere` is REQUIRED, not cosmetic: a pickup location
               name is free admin text and §UC-PI-012's acceptance criterion is zero
               horizontal overflow at 320px with a 120-character one. `min-width:0`
               alone only lets the flex item SHRINK — an unbreakable token still
               paints outside it (the `order-product-card` precedent). -->
          <div style="min-width:0;flex:1;overflow-wrap:anywhere">
            <div style="display:flex;align-items:center;gap:8px">
              <b style="font-size:15px">Odberné miesto v Bratislave</b>
              <span class="badge ok" style="margin-left:auto;flex-shrink:0">zdarma</span>
            </div>
            <!-- PO copy 2026-09-29: the Bratislava row is a personal delivery offer, no
                 longer the list of pickup points (the checkout picker still lists them). -->
            <div class="sub" style="font-size:13.5px;line-height:1.4;margin-top:3px" data-testid="explainer-pickup-line">
              Ak si z Petržalky, alebo v okolí Legovej práce, môžem ti kávu doniesť cestou. Ak si
              tu nový/á, over si vopred, či mám kapacitu doručovať kam potrebuješ. Stále však
              môžeš počítať s donáškou cez Packetu.
            </div>
          </div>
        </div>

        <!-- WAY 2 — through the friend who shared the link (module 14's guest flow,
             seen from the guest's side). -->
        <div class="card flat" style="padding:12px 14px;display:flex;gap:12px;align-items:flex-start" data-testid="explainer-way">
          <span style="display:flex;flex-shrink:0;padding-top:2px"><NeoIcon name="invite" /></span>
          <div style="min-width:0;flex:1;overflow-wrap:anywhere">
            <div style="display:flex;align-items:center;gap:8px">
              <b style="font-size:15px">Cez priateľa</b>
              <span class="badge ok" style="margin-left:auto;flex-shrink:0">zdarma</span>
            </div>
            <div class="sub" style="font-size:13.5px;line-height:1.4;margin-top:3px">
              Objednávaš cez odkaz od priateľa? Kávu prevezme on/ona a odovzdá ti ju.
            </div>
          </div>
        </div>

        <!-- WAY 3 — Packeta. §16's corrected sentence; the badge is conditional. -->
        <div class="card flat" style="padding:12px 14px;display:flex;gap:12px;align-items:flex-start" data-testid="explainer-way">
          <span style="display:flex;flex-shrink:0;padding-top:2px"><NeoIcon name="truck" :size="18" /></span>
          <div style="min-width:0;flex:1;overflow-wrap:anywhere">
            <div style="display:flex;align-items:center;gap:8px">
              <b style="font-size:15px">Packeta</b>
              <span
                v-if="parcelBadge"
                class="badge acc-o"
                style="margin-left:auto;flex-shrink:0"
                data-testid="explainer-parcel-fee"
              >{{ parcelBadge }}</span>
            </div>
            <div class="sub" style="font-size:13.5px;line-height:1.4;margin-top:3px">
              Nie si z Bratislavy? Objednaj si a nechaj poslať cez Packetu — na
              ľubovoľný Z-BOX alebo výdajné miesto.
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ══ 3. „KTO SME A ODKIAĽ JE KÁVA" (§UC-PI-012 item 5 / §UC-PI-014) ══════
         ⚠ The two cards ITERATE `ROASTERS`. Typing the texts into this template
         would be the second home `lib/roasters.js` exists to prevent, and module
         19's guest line (GL-T4) renders the same two strings from the same file. -->
    <div>
      <div class="field-lbl" style="margin-bottom:10px">Kto sme a odkiaľ je káva</div>
      <div class="sub" style="font-size:14px;line-height:1.45;margin-bottom:10px">
        Podpultovka vznikla ako jedna objednávka pre pár kamarátov. Nie je to obchod — je
        to okruh známych a známych ich známych, len na pozvánku. Káva pochádza z dvoch
        zdrojov, podľa značky na karte produktu:
      </div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <div
          v-for="roaster in ROASTERS"
          :key="roaster.key"
          class="card flat"
          style="padding:12px 14px;display:flex;gap:12px;align-items:flex-start"
          data-testid="explainer-roaster"
        >
          <span class="badge" :class="roaster.badgeClass" style="flex-shrink:0;margin-top:1px">{{ roaster.label }}</span>
          <div class="sub" style="font-size:13.5px;line-height:1.4;overflow-wrap:anywhere">{{ roaster.text }}</div>
        </div>
      </div>
    </div>

    <!-- ══ 4. „AKO PLATÍM" (§UC-PI-012 item 6) ═══════════════════════════════
         ⚠ „(PayMe)" STAYS. It reads redundant beside „bankovú appku" and is not:
         PayMe.sk is the named scheme module 15 shipped a dedicated bar for
         (`lib/payment-links.js paymeLink`, `PaymentModal.vue`), and the spec's
         `OPEN:` („hide it until 15 ships") resolved to keep — 15 landed first.
         Nothing on this page composes a payment link; it only describes them. -->
    <div>
      <div class="field-lbl" style="margin-bottom:10px">Ako platím</div>
      <div class="sub" style="font-size:14px;line-height:1.45">
        Po zabalení dostaneš sumu a QR kód. Zaplatíš jedným klepnutím cez
        <b>Revolut</b> alebo <b>bankovú appku</b> (PayMe), alebo prevodom na účet. Bez
        hotovosti.
      </div>
    </div>

    <!-- ══ 5. THE PERSONAL NOTE (§UC-PI-012 item 7) ══════════════════════════
         ⚠ HARDCODED, NOT A SETTING — the spec says so explicitly. It is the PO's
         own draft wording and the „L" avatar is his initial; neither is derived
         from `friends` or from an admin setting, and an admin must not be able to
         edit the voice of the person who runs the thing.
         ⚠ NOT `[data-user-copy]`: every character here is APP copy, so the
         rendered-copy sweep (`e2e/helpers/copy-sweep.js`) must see it. -->
    <div
      class="card flat"
      style="padding:14px;background:var(--accent-soft);display:flex;gap:12px;align-items:flex-start"
      data-testid="explainer-note"
    >
      <div
        class="display"
        style="width:44px;height:44px;border-radius:12px;border:3px solid var(--nb-ink);background:var(--nb-ink);color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:22px"
        aria-hidden="true"
      >L</div>
      <div style="font-size:14px;line-height:1.45;min-width:0;overflow-wrap:anywhere">
        „Podpultovku robím vo voľnom čase pre kamarátov a kamarátov kamarátov. Ak čokoľvek
        nesedí, napíš mi na WhatsApp a určite doriešime.“<br /><b>— Lego</b>
      </div>
    </div>

    <!-- ══ 6. THE ACTIONS (§UC-PI-012 item 8) ════════════════════════════════
         The `asGate` seam, and the ONLY thing it changes. -->
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">
      <!-- ⚠ THE THREE-ZONE CHECKBOX ROW, copied from the shipped call sites
           (`FriendPortal.vue:1248`, `GuestSubOrders.vue:531`) rather than
           re-derived. A `<label>` only forwards clicks to LABELABLE elements and
           `NeoCheckbox` is a `span[role=checkbox]`, so nothing here toggles by
           itself; the row declares `cursor:pointer` across its full width, so all
           three zones honour it, each exactly once:
             · the box  → NeoCheckbox's own handler;
             · the text → the `@click` on the span;
             · the 10px → `@click.self` on the label, which fires ONLY when the
               gap        label itself is the target. Without `.self` it would also
                          catch the two clicks above and double-toggle them back.
           `aria-label` gives the box its accessible name (it has none otherwise),
           and `line-height:normal` is RD-FL-8b's rule for unclassed text A10's
           class list cannot reach. -->
      <label
        v-if="asGate"
        style="display:flex;align-items:center;gap:10px;font-size:14px;line-height:normal;cursor:pointer"
        @click.self="hide = !hide"
      >
        <NeoCheckbox v-model="hide" aria-label="Už mi to neukazovať" />
        <span @click="hide = !hide">Už mi to neukazovať</span>
      </label>
      <button type="button" class="btn accent block" data-testid="explainer-done" @click="done">
        {{ asGate ? 'Rozumiem, idem na ponuku' : 'Späť na ponuku' }}
      </button>
    </div>
  </div>
</template>
