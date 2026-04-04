# Coffee group-buying app — Analytics & statistics specification

## Context

This is a web application for group-buying specialty coffee from Goriffee roastery (Bratislava). The operator collects individual orders from friends/community members, aggregates them into one wholesale order to unlock volume discounts, and distributes the coffee. The operator currently passes through the 30% wholesale discount to buyers at no markup. The goal is to grow the buyer base to reach higher discount tiers (35% at 26+ kg, 40% at 51+ kg) and keep the difference as margin.

### Business model

- **Retail price**: full price on goriffee.com (varies by coffee, avg ~€61.7/kg based on historical data)
- **Buyer price**: retail minus 30% discount (this is what buyers pay the operator — avg ~€43.2/kg)
- **Operator cost at 30% tier (5–25 kg)**: same as buyer price → **0% margin**
- **Operator cost at 35% tier (26–50 kg)**: retail minus 35% → operator keeps 5% of retail → **~€3.09/kg margin**
- **Operator cost at 40% tier (51+ kg)**: retail minus 40% → operator keeps 10% of retail → **~€6.17/kg margin**

### Current state (based on last 2 cycles)

- ~24 people ordering per cycle
- ~23.4 kg per cycle (~1.0 kg per person)
- ~€43.10 average order value per person
- Cycles happen roughly monthly
- Currently at the 30% tier threshold — need to grow to 26+ kg for margin

### Terminology

- **Cycle** (`order_cycles`): one group order round (roughly monthly, operator opens ordering → collects → places wholesale order → distributes). Has `type` field — these analytics only apply to `type = 'coffee'` cycles.
- **Tier**: wholesale discount bracket (30% at 5 kg+, 35% at 26 kg+, 40% at 51 kg+)
- **Friend** (`friends`): a user/member who can place orders. This is the app's term for buyer/customer.
- **Operator**: the app owner (admin) who aggregates and distributes

---

## Feature 1: Trends across cycles

### Purpose

Show historical trends so the operator can see growth trajectory, seasonal patterns, and whether they're approaching higher tiers consistently (not just in a single lucky cycle).

### Data points per cycle

For each completed cycle (`order_cycles.status = 'completed'` or `'locked'`), compute and display:

| Metric | Calculation |
|--------|------------|
| Total kg | Sum of weight derived from `order_items` (variant × quantity) for all submitted orders in the cycle |
| Total order value (€) | `SUM(orders.total)` for submitted orders in the cycle |
| Number of active friends | `COUNT(DISTINCT orders.friend_id)` for submitted orders |
| Avg kg per person | Total kg / number of active friends |
| Avg order value per person (€) | Total order value / number of active friends |
| Tier achieved | Which discount bracket the total kg fell into (5 kg → 30%, 26 kg → 35%, 51 kg → 40%) |
| Operator margin (€) | See margin formula in implementation notes |
| New friends | Friends whose first-ever submitted coffee order is in this cycle |
| Returning friends | Friends who also had a submitted order in the previous coffee cycle |
| Churned friends | Friends who had a submitted order in the previous coffee cycle but not this one |

### UI components

#### 1.1 Cycle-over-cycle line/bar chart

- **X-axis**: cycle (labeled by month/year, e.g. "Feb 2026", "Mar 2026")
- **Primary Y-axis**: total kg (bar chart)
- **Secondary Y-axis or overlay**: number of friends (line)
- **Visual**: horizontal threshold lines at 26 kg (35% tier) and 51 kg (40% tier), styled as dashed lines with labels
- **Hover/tooltip**: show all metrics for that cycle

#### 1.2 Cycle comparison cards

Show delta vs previous cycle for each key metric:

- Total kg: "25.8 kg → 21.1 kg (▼ 18%)"
- Friends: "26 → 21 (▼ 5)"
- Avg kg/person: "0.99 → 1.00 (▲ 1%)"
- Margin: "€79 → €0 (dropped to 30% tier)"

Use green for positive deltas, red for negative, gray for neutral.

#### 1.3 Buyer flow (retention funnel)

For each cycle transition, show:

- Retained: N friends (ordered in both cycles)
- New: N friends (first time or returned after absence)
- Churned: N friends (ordered last cycle, not this one)

This can be a simple stacked bar or a Sankey-like mini visualization.

---

## Feature 2: Friend analysis

### Purpose

Understand the composition of the friend base — who is reliable, who is at risk of churning, and where growth opportunities lie. This helps the operator know whether their volume is built on a stable foundation or dependent on occasional friends.

### Friend-level metrics

For each friend (from `friends` table), compute across coffee cycles only:

| Metric | Calculation |
|--------|------------|
| Total cycles participated | Count of coffee cycles where they have a submitted order |
| Participation rate | Cycles participated / total coffee cycles since their first order |
| Total kg ordered (all time) | Sum of weight from their `order_items` across all coffee cycles |
| Avg kg per cycle (when active) | Total kg / cycles participated |
| Avg order value per cycle (€) | `SUM(orders.total)` / cycles participated |
| Last active cycle | Most recent coffee cycle they had a submitted order in |
| Streak | Number of consecutive recent coffee cycles they've ordered in |
| Cycle-over-cycle trend | Did their last order kg go up, down, or stay flat vs the one before? |

### Friend segments

Classify each friend into one of these segments based on their behavior:

| Segment | Criteria | Color/label |
|---------|----------|-------------|
| Core | Has a submitted order in every one of the last 3 coffee cycles | Green, "Jadro" |
| Regular | Has a submitted order in 2 of the last 3 coffee cycles | Blue, "Pravidelný" |
| Occasional | Has a submitted order in 1 of the last 3 coffee cycles | Amber, "Občasný" |
| New | Has only 1 or 2 coffee cycles of history total | Purple, "Nový" |
| Inactive | No submitted order in the last 2 coffee cycles but has history | Gray, "Neaktívny" |

Note: if fewer than 3 completed coffee cycles exist, adjust criteria proportionally. Also consider `friends.active` flag — if `active = 0`, classify as Inactive regardless.

### UI components

#### 2.1 Segment breakdown (donut chart + summary)

Show the distribution of current friends across segments:

- Donut chart with segment colors
- Next to it, show for each segment: count of people, total kg they represent, % of total volume
- Key insight: e.g. "Tvoje jadro (12 ľudí) tvorí 58% celkového objemu"

#### 2.2 Friend table

Sortable table with columns:

- Name (`display_name ?? name`, grayed out if `friends.active = 0`)
- Segment (color-coded badge with Slovak label)
- Cycles active / total
- Participation rate (%)
- Avg kg/cycle
- Total kg (all time)
- Last order (cycle name)
- Streak

Default sort: by total kg descending (biggest contributors first).

Allow filtering by segment.

#### 2.3 Concentration risk indicator

Calculate and display:

- **Top 5 friends' share**: what % of total kg (in last completed cycle) comes from the top 5 friends?
- **Risk assessment**: if top 5 share > 40%, show a warning: "Vysoká koncentrácia — tvoj objem závisí od niekoľkých kľúčových ľudí"
- **Minimum viable base**: how many core+regular friends would need to order to stay above 26 kg? (i.e., avg kg/person of core+regular × count, compare to 26 kg threshold)

---

## Feature 3: Tier tracking & goal metrics

### Purpose

Strategic view focused on the operator's business goal: reaching and maintaining higher tiers. Answers "Am I getting there?" and "What do I need to do?"

### Metrics

| Metric | Calculation |
|--------|------------|
| Current rolling avg (3 cycles) | Average of total kg across last 3 completed coffee cycles |
| Tier hit rate | How many of the last N coffee cycles achieved 35%+ tier |
| Cumulative margin (all time) | Sum of all margin earned across all completed coffee cycles |
| Cumulative margin (last 12 months) | Same, but trailing 12 months only |
| Distance to next tier | How many more kg needed to reach next tier threshold |
| Friends needed for next tier | Distance to next tier / avg kg per person |

### UI components

#### 3.1 Tier progress card

Large, prominent card showing:

- Current rolling average (e.g., "22.4 kg — 3-cycle average")
- Visual progress bar with tier thresholds marked (26 kg, 51 kg)
- "You need X more kg to consistently hit 35%"
- "That's roughly N more friends at current avg"

#### 3.2 Margin tracker

- Cumulative margin earned bar chart or area chart over time
- If margin is €0 for a cycle (stuck at 30% tier), show it visually — it motivates growth
- Running total displayed prominently

#### 3.3 Scenario simulator

Interactive controls (sliders or input fields):

- **Input 1**: number of friends (slider, current avg as default)
- **Input 2**: avg kg per person (slider, current avg as default)  
- **Output**: projected total kg, resulting tier, projected margin per cycle, projected annual margin
- **Visual**: highlight which tier they'd land in, show the delta vs current state

This is similar to the calculator I already built in our conversation — embed a version of it in the app itself.

#### 3.4 Growth roadmap

Simple milestone list:

- ☑ Reach 5 kg (unlock wholesale pricing) — DONE
- ☐ Reach 26 kg consistently (35% tier → 5% margin) — "ešte N ľudí"  
- ☐ Reach 51 kg (40% tier → 10% margin) — "ešte ~N ľudí"

With progress indicators for each milestone.

---

## Data model (actual schema)

**Storage:** SQLite via sql.js (WebAssembly), in-memory with file persistence to `database.sqlite`.

### Relevant tables

**`order_cycles`** — the cycle entity.
- `id` INTEGER PK
- `name` TEXT (e.g. "Goriffee Marec 2026")
- `type` TEXT — `'coffee'` or `'bakery'`. **Filter to `type = 'coffee'` for all analytics.**
- `status` TEXT — `'open'`, `'locked'`, or `'completed'`
- `markup_ratio` REAL — price multiplier (currently 1.0, relevant for future margin model)
- `expected_date` TEXT — expected delivery date
- `created_at` DATETIME

**`friends`** — the buyer/member entity.
- `id` INTEGER PK
- `name` TEXT — short name
- `display_name` TEXT — optional full name (use `display_name ?? name` for display)
- `uid` TEXT — 8-char unique ID
- `active` INTEGER — 1 = active. Include inactive friends in historical analytics but flag them.
- `created_at` DATETIME

**`orders`** — a friend's order within a cycle.
- `id` INTEGER PK
- `friend_id` INTEGER FK → friends.id
- `cycle_id` INTEGER FK → order_cycles.id
- `status` TEXT — `'draft'` or `'submitted'`. **Only count `status = 'submitted'` orders in analytics.**
- `total` REAL — order total in EUR (already computed, use this for value metrics)
- `paid` INTEGER — 0/1
- `submitted_at` DATETIME
- `created_at` DATETIME

**`order_items`** — line items within an order.
- `id` INTEGER PK
- `order_id` INTEGER FK → orders.id
- `product_id` INTEGER FK → products.id
- `variant` TEXT — `'250g'`, `'1kg'`, `'150g'`, `'200g'`, `'20pc5g'`, or `'unit'`
- `quantity` INTEGER
- `price` REAL — price at time of order

**`products`** — products available within a specific cycle.
- `id` INTEGER PK
- `cycle_id` INTEGER FK → order_cycles.id
- `name` TEXT
- `roast_type` TEXT
- Various price columns: `price_250g`, `price_1kg`, `price_150g`, `price_200g`, `price_20pc5g`, `price_unit`

### Critical: computing weight from order_items

There is no explicit weight column on orders. Weight must be derived from `order_items.variant` and `order_items.quantity`:

```sql
-- Weight mapping for each variant
CASE order_items.variant
  WHEN '250g'   THEN 0.250 * order_items.quantity
  WHEN '1kg'    THEN 1.000 * order_items.quantity
  WHEN '150g'   THEN 0.150 * order_items.quantity
  WHEN '200g'   THEN 0.200 * order_items.quantity
  WHEN '20pc5g' THEN 0.100 * order_items.quantity  -- 20 capsules × 5g = 100g
  WHEN 'unit'   THEN 0  -- bakery items, no coffee weight
  ELSE 0
END
```

### Key query: cycle statistics

```sql
SELECT
  oc.id AS cycle_id,
  oc.name AS cycle_name,
  oc.status,
  oc.created_at,
  oc.expected_date,
  COUNT(DISTINCT o.friend_id) AS num_friends,
  SUM(o.total) AS total_value,
  SUM(
    CASE oi.variant
      WHEN '250g'   THEN 0.250 * oi.quantity
      WHEN '1kg'    THEN 1.000 * oi.quantity
      WHEN '150g'   THEN 0.150 * oi.quantity
      WHEN '200g'   THEN 0.200 * oi.quantity
      WHEN '20pc5g' THEN 0.100 * oi.quantity
      ELSE 0
    END
  ) AS total_kg
FROM order_cycles oc
LEFT JOIN orders o ON o.cycle_id = oc.id AND o.status = 'submitted'
LEFT JOIN order_items oi ON oi.order_id = o.id
WHERE oc.type = 'coffee'
GROUP BY oc.id
ORDER BY oc.created_at ASC;
```

### Key query: per-friend per-cycle breakdown

```sql
SELECT
  o.friend_id,
  f.name,
  f.display_name,
  f.active AS friend_active,
  o.cycle_id,
  o.total AS order_value,
  SUM(
    CASE oi.variant
      WHEN '250g'   THEN 0.250 * oi.quantity
      WHEN '1kg'    THEN 1.000 * oi.quantity
      WHEN '150g'   THEN 0.150 * oi.quantity
      WHEN '200g'   THEN 0.200 * oi.quantity
      WHEN '20pc5g' THEN 0.100 * oi.quantity
      ELSE 0
    END
  ) AS order_kg
FROM orders o
JOIN friends f ON f.id = o.friend_id
JOIN order_cycles oc ON oc.id = o.cycle_id
LEFT JOIN order_items oi ON oi.order_id = o.id
WHERE o.status = 'submitted'
  AND oc.type = 'coffee'
GROUP BY o.id
ORDER BY oc.created_at ASC, f.name ASC;
```

All analytics metrics should be computed from these queries. Given the low data volume (~24 orders per cycle, a few cycles), compute everything on-the-fly — no need for pre-aggregation or materialized views.

---

## Implementation notes

- **Filter to coffee only**: all analytics queries must filter `order_cycles.type = 'coffee'`. The app also handles bakery cycles which should be excluded.
- **Submitted orders only**: only count orders where `orders.status = 'submitted'`. Draft orders are incomplete and should be ignored.
- **Weight calculation**: there is no weight column — always derive from `order_items.variant` × `order_items.quantity` using the mapping in the data model section above. Extract this into a reusable helper function.
- **Order value**: use `orders.total` for monetary calculations — it's already computed and stored.
- **Friend display name**: use `friends.display_name` if present, fall back to `friends.name`.
- **Active vs inactive friends**: `friends.active = 0` means the friend was deactivated. Include their historical data in analytics but visually mark them (e.g., grayed out name in the buyer table).
- **Cycle ordering**: use `order_cycles.created_at` for chronological ordering of cycles. The `expected_date` field can be used for display labels.
- **markup_ratio**: the `order_cycles.markup_ratio` field (currently 1.0) is the mechanism for the operator to eventually charge more than the 30% discount price. The analytics should be aware of this: if `markup_ratio > 1.0`, the buyer pays `base_price × markup_ratio`, and the operator's margin includes both the tier delta AND the markup. For now, assume 1.0 but don't hardcode it.
- **Tier thresholds**: 5 kg (30%), 26 kg (35%), 51 kg (40%). Store as configurable constants.
- **Retail price derivation**: compute avg retail price from actual order data: `SUM(orders.total) / SUM(order_kg)` gives avg price per kg at buyer price (30% discount). Divide by 0.70 to get retail. Don't hardcode €61.7.
- **Margin formula**: `operator_margin = total_order_value × (1 - (1 - tier_discount) / (1 - 0.30))`. Simplified: at 35% tier on €1000 of orders (at 30% price), operator cost is €1000 × (0.65/0.70) = €928.57, margin = €71.43. At 40%: cost = €1000 × (0.60/0.70) = €857.14, margin = €142.86.
- **Charts**: should work with as few as 2–3 cycles of data (current state). Show "Nedostatok dát pre analýzu trendov" if only 1 cycle exists.
- **Segmentation lookback** (3 cycles) should be configurable.
- **Precision**: EUR to 2 decimals, kg to 1 decimal.
- **UI language**: Slovak. All labels, tooltips, and messages in Slovak.
- **Access control**: analytics dashboard is operator-only (admin view). Regular friends should not see this data.

---

## Priority order

1. **Tier progress card + scenario simulator** (Feature 3.1, 3.3) — most actionable, directly tied to the business goal
2. **Cycle trends chart** (Feature 1.1) — provides historical context
3. **Friend segments + table** (Feature 2.1, 2.2) — helps understand the base
4. **Margin tracker** (Feature 3.2) — motivational, less urgent
5. **Friend flow / retention** (Feature 1.3) — nice to have
6. **Concentration risk** (Feature 2.3) — nice to have
7. **Growth roadmap** (Feature 3.4) — simple, add anytime
