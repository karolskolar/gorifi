<script setup>
// The friend portal's hamburger drawer (18 §UC-PI-004) — a full-height LEFT
// drawer on the modal layer, on phone and desktop alike.
//
// Transcribed from `docs/design/friends-portal-redesign/friends/portal2.jsx`
// `MenuDrawer`: same nodes in the same order, same inline styles, same class
// names. Its CSS is the A13 canon sync in `friends-theme.css`.
//
// ⚠ IT IS ON THE MODAL LAYER, NOT INSIDE `.app`, and that is not a preference.
// `friends-theme.css` declares `.app > * { position:relative; z-index:1 }` at
// (0,1,0) and loads after Tailwind, so a hand-rolled `position:fixed` drawer
// mounted as a direct child of `.app` silently computes `relative` / `z-index:1`
// and renders in the document flow (CLAUDE.md §Frontend, the most-repeated trap
// in this codebase). `<Teleport to="body">` → `.modal-layer` is also what makes
// `var(--accent)` resolve inside it: the token block is declared on
// `.app, .modal-layer` precisely because this subtree lands outside `.app`.
//
// ⚠ EVERY BEHAVIOUR IS `use-modal-layer.js`'s, NOT A SECOND COPY — scroll lock,
// Escape, the capture-phase scrim-mousedown origin rule, the focus trap and the
// focus restore. 18 §UC-PI-004: "two copies of the scrim logic is how one stops
// working". The composable was extracted out of `NeoModal.vue` for this
// component; the lock counter it owns is module-scope, so a drawer opening over
// a modal cannot unlock the page under it.
//
// ⚠ Like `NeoModal`, there is NO `open` prop — the PARENT mounts it with `v-if`.
// That is load-bearing twice over: everything with a lifetime hangs off
// mount/unmount (so a drawer torn down while open leaks neither its listener nor
// its scroll lock), AND `role="dialog"` exists in the DOM only while the drawer
// is really open. 28 shipped spec files resolve `getByRole('dialog')`; a drawer
// rendered-but-hidden would turn every one of those into a strict-mode violation.

import { ref } from 'vue'
import NeoIcon from './NeoIcon.vue'
import { useModalLayer } from './use-modal-layer.js'

const props = defineProps({
  // The friend's `name`, rendered under the wordmark. NOTHING else identifies
  // them here: no uid, no „člen od" line (18 resolved conflict 9 / §16 — "a
  // friend never needs to see their uid"). The prototype's
  // „{code} · člen od 2024" row is demo data and is deliberately NOT ported.
  friendName: { type: String, default: '' },
  // The menu rows, in render order. Shape per row:
  //   { key, icon, label, sub?, subData?, badge?: { text, tone: 'danger'|'ok' }, on?: bool }
  // ⚠ `subData` is PERSON-TYPED text appended to `sub` after one space (today: the
  // „Moje objednávky" row's last cycle name). It renders in its own `data-user-copy`
  // span (FUP-T22 / 18 §UC-PI-017) so the vocabulary sweep reads the app half only.
  // Anything a person typed goes in `subData`, never composed into `sub`.
  // The DATA lives in `FriendPortalSession.vue` (the session-boundary rule); the
  // MARKUP and the keyboard layer live here, once, so a new row cannot ship with
  // a different `role`/`tabindex`/Enter-Space contract from the other six.
  items: { type: Array, default: () => [] }
})

const emit = defineEmits([
  // A row was chosen. The parent closes the drawer FIRST and then acts
  // (§UC-PI-004 business rules).
  'select',
  // The footer's „Odhlásiť sa".
  'logout',
  // Scrim, × or Escape.
  'close'
])

const drawerEl = ref(null)

const { requestClose, onScrimMousedown, onScrimClick } = useModalLayer(drawerEl, {
  // Always dismissible — a menu is never a gate.
  closable: () => true,
  // ⚠ ALWAYS trapped, unlike `NeoModal`'s derive-from-`closable` default. The
  // drawer covers the viewport edge-to-edge behind an opaque scrim, so a Tab
  // that walks out of it lands on controls the user cannot see; `aria-modal`
  // says the rest of the page is inert and the Tab key must agree with it.
  trapping: () => true,
  onClose: () => emit('close'),
  tag: 'NeoDrawer'
})

function choose(key) {
  emit('select', key)
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-layer">
      <div class="p2-drawer-scrim" @mousedown.capture="onScrimMousedown" @click.self="onScrimClick">
        <aside
          ref="drawerEl"
          class="p2-drawer"
          style="outline: none"
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          tabindex="-1"
        >
          <div class="p2-dh">
            <div style="flex: 1; min-width: 0">
              <div class="display" style="font-size: 25px; line-height: 1.1">Pod<span style="color:var(--accent)">pult</span>ovka</div>
              <div v-if="friendName" data-testid="drawer-friend-name" data-user-copy style="margin-top: 8px; font-weight: 700; font-size: 15px; line-height: normal">{{ friendName }}</div>
            </div>
            <span
              class="p2-icobtn"
              style="margin: -6px -6px 0 0"
              role="button"
              tabindex="0"
              aria-label="Zatvoriť menu"
              @click="requestClose"
              @keydown.enter.prevent="requestClose"
              @keydown.space.prevent="requestClose"
            >
              <NeoIcon name="close" />
            </span>
          </div>

          <div style="flex: 1; overflow-y: auto">
            <div
              v-for="item in items"
              :key="item.key"
              class="p2-mi"
              :class="{ on: item.on }"
              :data-menu-item="item.key"
              role="button"
              tabindex="0"
              @click="choose(item.key)"
              @keydown.enter.prevent="choose(item.key)"
              @keydown.space.prevent="choose(item.key)"
            >
              <span class="ic"><NeoIcon :name="item.icon" /></span>
              <div style="flex: 1; min-width: 0">
                <div class="lab">{{ item.label }}</div>
                <div v-if="item.sub" class="sub">{{ item.sub }}<template v-if="item.subData">{{ ' ' }}<span data-user-copy>{{ item.subData }}</span></template></div>
              </div>
              <span v-if="item.badge" class="badge" :class="item.badge.tone">{{ item.badge.text }}</span>
              <!-- The chevron's colour is INLINE, exactly as the prototype writes
                   it (`portal2.jsx` `Item`): magenta normally, and the accent's
                   ink on the active row, where the row itself is magenta. -->
              <span v-else :style="{ display: 'flex', color: item.on ? 'var(--accent-ink)' : 'var(--accent)' }"><NeoIcon name="chev" /></span>
            </div>
          </div>

          <div style="padding: 14px 18px 18px; display: flex; justify-content: space-between; align-items: center; gap: 10px; border-top: 3px solid var(--nb-ink)">
            <button type="button" class="btn ghost" style="padding-left: 0; gap: 8px" @click="emit('logout')">
              <NeoIcon name="logout" /> Odhlásiť sa
            </button>
            <span class="sub mono" style="font-size: 11px">podpultovka.biz</span>
          </div>
        </aside>
      </div>
    </div>
  </Teleport>
</template>
