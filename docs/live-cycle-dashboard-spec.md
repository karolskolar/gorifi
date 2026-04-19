# Live cycle dashboard — Specification

## Context

This spec describes a real-time dashboard visible to the operator (admin) during an active ordering cycle. It answers: "How is the current cycle going, and what do I need to do to hit my tier target?"

This is a companion to the analytics spec (`coffee-analytics-spec.md`) which covers historical trends, friend analysis, and tier tracking. This spec focuses exclusively on the **current open cycle**.

Refer to `coffee-analytics-spec.md` for: business model details, tier thresholds, margin formulas, and the full data model reference.

---

## Scope

The dashboard is shown when there is an open coffee cycle (`order_cycles.status = 'open'` AND `order_cycles.type = 'coffee'`). If no coffee cycle is open, show a simple empty state: "Žiadny aktívny cyklus" with a link to create one (if that flow exists).

If the cycle status is `'locked'` (ordering closed but not yet completed), the dashboard should still be visible but in a read-only "summary" mode — all the same data, but without the "who hasn't ordered yet" nudge section.

---

## Data sources

All data comes from the current open cycle. Queries filter to:
- `order_cycles.type = 'coffee'`
- `order_cycles.status IN ('open', 'locked')`
- `orders.status = 'submitted'` (ignore drafts)

Weight is derived from `order_items` as described in the analytics spec:

```sql
CASE order_items.variant
  WHEN '250g'   THEN 0.250 * order_items.quantity
  WHEN '1kg'    THEN 1.000 * order_items.quantity
  WHEN '150g'   THEN 0.150 * order_items.quantity
  WHEN '200g'   THEN 0.200 * order_items.quantity
  WHEN '20pc5g' THEN 0.100 * order_items.quantity
  ELSE 0
END
```

Previous cycle = the most recent completed coffee cycle (`status = 'completed'`, `type = 'coffee'`, ordered by `created_at DESC`, `LIMIT 1`).

---

## UI layout

The dashboard has 4 sections, stacked vertically:

1. **Tier progress bar** (most prominent, top of page)
2. **Key metric cards** (grid of 4–6 cards)
3. **Comparison with previous cycle** (compact delta indicators)
4. **Who hasn't ordered yet** (action-oriented list)

---

## Section 1: Tier progress bar

A wide horizontal progress bar showing the current total kg relative to tier thresholds.

### Visual design

```
[===========================|·····|·····················]
0 kg                       26 kg  51 kg
          21.3 kg
       "Ešte 4.7 kg do 35%"
```

- The bar spans from 0 to a reasonable max (e.g., 60 kg, or dynamically: `max(51, current_kg * 1.2)`)
- Two threshold markers at 26 kg and 51 kg, visually distinct (dashed vertical lines with labels "35%" and "40%")
- Current position shown with a filled bar and a label showing the exact kg value
- Below the bar: a text message based on current position:
  - If < 26 kg: **"Ešte X.X kg do 35% tieru (+ Y ľudí pri priemernej objednávke)"**
  - If 26–50 kg: **"35% tier dosiahnutý! Ešte X.X kg do 40%"**
  - If 51+ kg: **"40% tier dosiahnutý!"**
- Color coding: the filled portion of the bar uses gray (under 26), blue (26–50), or green (51+) — matching the tier colors from the analytics spec.

### Data needed

```sql
-- Current cycle totals
SELECT
  SUM(
    CASE oi.variant
      WHEN '250g'   THEN 0.250 * oi.quantity
      WHEN '1kg'    THEN 1.000 * oi.quantity
      WHEN '150g'   THEN 0.150 * oi.quantity
      WHEN '200g'   THEN 0.200 * oi.quantity
      WHEN '20pc5g' THEN 0.100 * oi.quantity
      ELSE 0
    END
  ) AS total_kg,
  COUNT(DISTINCT o.friend_id) AS num_friends
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
WHERE o.cycle_id = :current_cycle_id
  AND o.status = 'submitted';
```

The "Y ľudí pri priemernej objednávke" calculation uses: `ceil(kg_remaining / avg_kg_per_person)`, where `avg_kg_per_person` is derived from either the current cycle (if enough data) or the previous cycle.

---

## Section 2: Key metric cards

A grid of metric cards (2 or 3 columns, responsive). Each card has: a muted label on top, a large number below, and optionally a small secondary indicator.

### Cards

| Card | Label (SK) | Value | Secondary |
|------|-----------|-------|-----------|
| Total kg | Celkovo kg | `XX.X kg` | — |
| Friends ordered | Objednalo | `N ľudí` | out of total active friends: `z M` |
| Avg kg per person | Priemer na osobu | `X.XX kg` | — |
| Total order value | Hodnota objednávok | `€ XXX.XX` | — |
| Estimated margin | Odhadovaná marža | `€ XX.XX` | only shown if currently above 26 kg, otherwise show `€0 (30% tier)` |
| Estimated tier | Aktuálny tier | `30%` / `35%` / `40%` | color-coded badge |

### Margin calculation

The estimated margin for the current cycle:

```
if total_kg <= 25:
  margin = 0  (operator buys at 30%, sells at 30%)
if total_kg 26-50:
  margin = total_order_value * (1 - 0.65/0.70)  ≈ 7.14% of order value
if total_kg 51+:
  margin = total_order_value * (1 - 0.60/0.70)  ≈ 14.29% of order value
```

Note: respect `order_cycles.markup_ratio` if it's not 1.0. In that case, `total_order_value` already includes the markup, and the margin formula adjusts accordingly.

### "Friends ordered" denominator

The denominator (`M` in "N z M") should be: count of active friends who are subscribed to coffee cycles. Query:

```sql
SELECT COUNT(*) FROM friends f
WHERE f.active = 1
  AND (
    -- Has a coffee subscription
    EXISTS (SELECT 1 FROM friend_subscriptions fs WHERE fs.friend_id = f.id AND fs.type = 'coffee')
    -- OR has no subscriptions at all (which means they see all cycles)
    OR NOT EXISTS (SELECT 1 FROM friend_subscriptions fs WHERE fs.friend_id = f.id)
  );
```

---

## Section 3: Comparison with previous cycle

A compact row of delta indicators comparing the current cycle's state to the **same point in the previous cycle** (if possible) or the **final state of the previous cycle**.

### Option A: Compare to final state of previous cycle (simpler)

Show deltas for:

| Metric | Format |
|--------|--------|
| Total kg | `21.3 kg vs 25.8 kg minulý cyklus (▼ 17%)` |
| Friends | `18 vs 26 minulý cyklus (▼ 8)` |
| Avg kg/person | `1.18 kg vs 0.99 kg (▲ 19%)` |
| Order value | `€780 vs €1,164 (▼ 33%)` |

Use green arrow (▲) for positive change, red arrow (▼) for negative, gray for neutral (< 2% change).

**Important nuance**: when the current cycle is still open, comparing to a completed cycle's final numbers can be misleading (current will always look "worse" because not everyone has ordered yet). Add a subtle note: _"Cyklus ešte prebieha — porovnanie s konečným stavom predošlého cyklu"_.

### Option B: Compare to same-day-in-cycle (more accurate, optional/future)

If `orders.submitted_at` timestamps are reliable, you could compare "day 5 of current cycle" to "day 5 of previous cycle". This requires calculating `days_since_cycle_opened = now - order_cycles.created_at` and filtering previous cycle's orders to `submitted_at <= previous_cycle.created_at + same_number_of_days`. This is significantly more complex — implement Option A first, consider Option B as an enhancement later.

### Data needed

```sql
-- Previous completed coffee cycle
SELECT id, name FROM order_cycles
WHERE type = 'coffee' AND status = 'completed'
ORDER BY created_at DESC
LIMIT 1;

-- Then run the same totals query as Section 1 but with previous_cycle_id
```

---

## Section 4: Who hasn't ordered yet

An action-oriented list of friends who are eligible to order but haven't submitted an order in the current cycle. This is the operator's "outreach list" — the people to nudge.

### Only show when cycle is open

When `status = 'locked'`, hide this section entirely (no point nudging when ordering is closed).

### List criteria

Show friends who match ALL of:
1. `friends.active = 1`
2. Are subscribed to coffee (same logic as Section 2 denominator)
3. Do NOT have a submitted order in the current cycle

```sql
SELECT f.id, f.name, f.display_name
FROM friends f
WHERE f.active = 1
  AND (
    EXISTS (SELECT 1 FROM friend_subscriptions fs WHERE fs.friend_id = f.id AND fs.type = 'coffee')
    OR NOT EXISTS (SELECT 1 FROM friend_subscriptions fs WHERE fs.friend_id = f.id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM orders o
    WHERE o.friend_id = f.id
      AND o.cycle_id = :current_cycle_id
      AND o.status = 'submitted'
  )
ORDER BY f.name ASC;
```

### Display

- Show as a simple list with friend names
- Show total count prominently: **"Ešte neobjednalo: 8 ľudí"**
- For each friend, optionally show their historical behavior as a subtle indicator:
  - If they ordered in the previous cycle: show a small dot or "minule objednal/a"
  - If they are a "Core" or "Regular" segment friend (from analytics spec): highlight them — these are the most likely to convert with a nudge
- Keep the list compact — if more than 10–15 friends, show the first batch (prioritized by segment: Core first, then Regular, then others) with an expandable "Zobraziť všetkých" toggle

### Potential kg impact

At the bottom of the list, show an estimate: **"Ak objednajú všetci, potenciálne + X.X kg"** calculated as: `count_of_not_ordered × avg_kg_per_person_from_previous_cycle`.

---

## Refresh behavior

The dashboard should update when the operator navigates to it (standard page load / route navigation). Real-time WebSocket updates are not needed — the data changes infrequently (a few orders per day during an open cycle). A manual refresh button ("Obnoviť dáta") or auto-refresh every 60 seconds is sufficient.

---

## Implementation notes

- This dashboard is **operator/admin only**. Regular friends should not see these metrics.
- All weight calculations use the same variant-to-kg mapping as the analytics spec. Extract this into a shared utility function used by both dashboards.
- The dashboard should be a single page/route in the admin section of the app.
- Use `vue-chartjs` / `chart.js` only if you want to make the tier progress bar fancy. A pure CSS/Tailwind progress bar works just as well and is simpler for this use case. The metric cards and comparison deltas are pure layout — no charting library needed.
- Handle edge cases:
  - No submitted orders yet in current cycle → show all zeros, full "who hasn't ordered" list
  - No previous cycle exists → hide the comparison section, show "Prvý cyklus — žiadne porovnanie"
  - Only 1 friend has ordered → avg per person is based on 1 data point, note this somehow or just show it
- Monetary precision: EUR to 2 decimals. Weight: 1 decimal for totals, 2 decimals for per-person averages.
- UI language: Slovak.
