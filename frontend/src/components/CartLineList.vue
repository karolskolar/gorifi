<script setup>
// THE ONE HOME for a list of ordered coffee lines, on every screen that shows one
// (product decision 2026-08-12: they must all read the same).
//
// Before this component there were FIVE hand-rolled copies of the same list, and
// they had already drifted into four different formats:
//   · FriendOrder.vue's cart bar          "Name (250g) ×1 … 7.60 €"
//   · GuestOrder.vue's cart bar           "Name (250g) ×1 … 7.60 EUR"
//   · GuestOrder.vue's confirmation card  "Name (250g) ×1 … 7.60"
//   · GuestOrderStatus.vue's item list    "Name (250g) ×2 … 20.00"
//   · GuestSubOrders.vue's sub-order list "2× Name — 250g … 15.20"
// The host reads the last two side by side on one screen, so the drift was visible
// in a single glance. Extend this component; never fork it.
//
// The format, all four parts of it:
//   1. GROUPED BY PURPOSE, one neutral badge header per group.
//   2. The product name is ONE ROW, truncated with a CSS ellipsis (never shortened
//      in the data — the full string stays in the DOM and in the `title`).
//   3. Quantity and size are their OWN fixed-width columns, so they align down the
//      list instead of drifting with the name's length.
//   4. `€` on every line amount.
//
// ⚠ Part 4 REVERSES the "EUR appears on TOTALS only, item lines carry a bare mono
// column" rule (05 §UC-KG-003 item 2, from the prototype's `order.jsx:124`). That
// rule made a bare "15.20" ambiguous on the two guest screens where the nearest
// total belongs to a DIFFERENT order — the host's own payable total sits in the cart
// bar while a colleague's lines sit in a card above it. Superseded deliberately.
//
// ⚠ It renders `ul`/`li`. That is what `GuestSubOrders` already used and it is the
// honest markup for a list; the three copies that used `div`s were the outliers.
import { computed } from 'vue'

const props = defineProps({
  // Normalized lines: `{ key, name, purpose, size, quantity, amount }`. Every call
  // site maps its own row shape into this — the mapping is the caller's business,
  // the presentation is ours. `size` is already resolved to a label ('250g', 'ks',
  // '1/2', …); this component never touches `variant` keys or price fields.
  items: { type: Array, default: () => [] },
  // Lines that are NOT products and belong to no purpose — today only the Packeta
  // delivery fee. They render after every group, with no header and no
  // quantity/size, but they DO keep the amount column so their figure stays aligned
  // with the lines above.
  extras: { type: Array, default: () => [] },
  // Preferred group order, e.g. FriendOrder's `availablePurposes`, so the cart lists
  // its groups in the same order as the category strip above it. Purposes missing
  // from this list keep their first-appearance order and are appended — a line must
  // never disappear because its purpose is unknown here.
  purposeOrder: { type: Array, default: () => [] },
  // Per-line testid. Applied to every product line so a caller's existing spec
  // locator (`status-item`) survives the extraction.
  lineTestid: { type: String, default: null },
})

const FALLBACK_PURPOSE = 'Ostatné'

const groups = computed(() => {
  const byPurpose = new Map()
  for (const item of props.items) {
    const purpose = item.purpose || FALLBACK_PURPOSE
    if (!byPurpose.has(purpose)) byPurpose.set(purpose, [])
    byPurpose.get(purpose).push(item)
  }
  const out = []
  for (const purpose of props.purposeOrder) {
    if (byPurpose.has(purpose)) {
      out.push({ purpose, items: byPurpose.get(purpose) })
      byPurpose.delete(purpose)
    }
  }
  // Whatever the caller did not rank keeps insertion order (a Map preserves it),
  // which for a server-ordered item list is the order it was added in.
  for (const [purpose, items] of byPurpose) out.push({ purpose, items })
  return out
})

// Two decimals plus the sign, separated by an ORDINARY space (U+0020).
//
// ⚠ Not a non-breaking space, even though Slovak typography would prefer one between a
// value and its unit: `.ln-amt` is `white-space:nowrap`, so U+00A0 buys nothing here
// and costs plenty — Playwright normalises NBSP away for a STRING `toHaveText` but not
// for a REGEX one, so an invisible character made `toHaveText('9.04 €')` pass while
// `toHaveText(/^\d+\.\d{2} €$/)` failed against the same node. Keep it plain.
function fmt(amount) {
  return `${Number(amount || 0).toFixed(2)} €`
}
</script>

<template>
  <ul class="lines">
    <template v-for="group in groups" :key="group.purpose">
      <li class="ln-group"><span class="badge acc-o">{{ group.purpose }}</span></li>
      <li
        v-for="item in group.items"
        :key="item.key"
        class="ln"
        :data-testid="lineTestid"
      >
        <span class="ln-name" :title="item.name">{{ item.name }}</span>
        <span class="mono ln-qty">{{ item.quantity }}×</span>
        <span class="mono ln-size">{{ item.size }}</span>
        <span class="mono ln-amt">{{ fmt(item.amount) }}</span>
      </li>
    </template>
    <li v-for="extra in extras" :key="extra.key" class="ln">
      <span class="ln-name">{{ extra.name }}</span>
      <span class="mono ln-amt">{{ fmt(extra.amount) }}</span>
    </li>
  </ul>
</template>

<style scoped>
/* ⚠ EVERY value here that the theme also declares for `.cartbar .lines .ln` is
   declared with the IDENTICAL value, on purpose. That selector is (0,3,0) —
   `:where()` contributes nothing — against this file's (0,2,0), so inside a
   `.cartbar` the theme wins; everywhere else these rules are the only ones there
   are. Matching the numbers is what makes the two cases indistinguishable. Do not
   "tidy" a value here without checking friends-theme.css:191-192.

   Deliberately NOT declared: `max-height` / `overflow-y` (the cart bar's 170px
   scroll cap is the theme's alone — a list inside a card must show every line) and
   `margin-top` (the theme gives the cart bar 8px; other call sites pass their own
   inline value, which falls through to this root element).

   ⚠ `line-height:normal` is LOAD-BEARING, not decoration. `.ln-name` and the
   `.ln-*` columns carry classes that are NOT in the theme's A10 list, so without
   this every line would inherit Tailwind preflight's `html{line-height:1.5}` — the
   exact drift A10 exists to undo, measured at +4.25px per line on this list when
   RD-FO-3 first hit it. Declaring it here rather than widening A10 also means the
   component is self-sufficient on screens that are not `.app` scopes. */
.lines {
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13.5px;
  line-height: normal;
  /* Preflight already zeroes these for `ul`; explicit so the component does not
     depend on preflight being present. */
  margin: 0;
  padding: 0;
  list-style: none;
}

.ln {
  display: flex;
  gap: 10px;
  border-bottom: 1px solid rgba(10, 10, 10, 0.12);
  padding-bottom: 5px;
}

.ln-group {
  /* Not an `.ln`: no bottom rule, so a header can never be read as a line with a
     missing price. `.lines` is a 5px-gap flex column, so the extra `margin-top` is
     what makes the badge sit closer to the group it labels (5px below) than to the
     group above it (11px) — without it the header floats equidistant between two
     groups and labels neither. */
  margin-top: 6px;
}

.ln-group:first-child {
  margin-top: 0;
}

.ln-name {
  /* ONE ROW, always. `min-width:0` is what lets a flex item shrink below its
     content at all; without it `text-overflow` never triggers and the row grows
     instead. This is also the guard against an unbreakable product name: unlike
     `overflow-wrap`, a clipped box cannot paint outside its row (RD-FO-2 measured a
     263px sideways document scroll from exactly that, one screen up). */
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* The three fixed columns. `flex-shrink:0` so they never give up width to a long
   name, `text-align` so the digits align on their own edge, and `tabular-nums` so
   "1×" and "12×" occupy the same box in a proportional fallback face (Courier Prime
   is already monospaced; the fallback may not be). */
.ln-qty,
.ln-size,
.ln-amt {
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
  color: var(--ink-dim);
}

.ln-qty {
  width: 26px;
  text-align: right;
}

.ln-size {
  /* Fits `20pc5g`'s label at 13.5px mono; a bakery `variant_label` is free admin
     text, so it may still ellipsise — the correct failure here, since the column
     alignment is the point and the size is repeated on the product card. */
  width: 52px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ln-amt {
  min-width: 58px;
  text-align: right;
  white-space: nowrap;
  color: var(--ink);
}
</style>
