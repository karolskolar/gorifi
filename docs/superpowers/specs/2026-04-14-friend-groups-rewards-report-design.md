# Friend Groups & Rewards Report

## Context

Gorifi's admin wants to track coffee ordering volume not just per individual friend, but per **community group** — a "root friend" (group leader/ambassador) plus their invited friends ("siblings"). This enables a future rewards program where root friends who collectively drive enough volume (e.g., 10+ kg) earn benefits.

Currently, friends are flat — no hierarchy or grouping. This feature introduces a simple one-level parent-child relationship between friends and an aggregated report showing group performance across cycles.

## Data Model

### Changes to `friends` table

Two new columns:

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `is_root` | INTEGER | 0 | 1 = this friend is a group leader |
| `root_friend_id` | INTEGER | NULL | FK → `friends.id` — which root friend this sibling belongs to |

**Rules:**
- Root friend: `is_root = 1`, `root_friend_id = NULL`
- Sibling: `is_root = 0`, `root_friend_id` → a root friend's ID
- Unassigned: `is_root = 0`, `root_friend_id = NULL` → aggregated under "Ostatní" in reports
- A root friend cannot simultaneously be a sibling (API enforces mutual exclusion)
- A sibling can belong to at most one root friend

**Migration:** Standard try/catch ALTER TABLE pattern:
```javascript
try { db.run('ALTER TABLE friends ADD COLUMN is_root INTEGER DEFAULT 0'); } catch(e) {}
try { db.run('ALTER TABLE friends ADD COLUMN root_friend_id INTEGER'); } catch(e) {}
```

### New setting

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `rewards_threshold_kg` | NUMBER | 10 | Kg threshold for reward eligibility indicator |

## API Endpoints

### Group Management

**`GET /api/friend-groups`**
Returns all root friends with their assigned siblings, plus the "Ostatní" group.

Response:
```json
{
  "groups": [
    {
      "rootFriend": { "id": 1, "name": "Peter", "displayName": "Peter Novák" },
      "siblings": [
        { "id": 5, "name": "Jano" },
        { "id": 8, "name": "Marek" },
        { "id": 12, "name": "Lucia" }
      ]
    }
  ],
  "unassigned": [
    { "id": 3, "name": "Katka" },
    { "id": 9, "name": "Tomáš" }
  ]
}
```

**`PATCH /api/friends/:id/root-status`**
Toggle a friend's root status.

Request body: `{ "isRoot": true }`

Rules:
- Setting `isRoot: true` clears any existing `root_friend_id` (can't be both root and sibling)
- Setting `isRoot: false` removes root status; any siblings assigned to this friend become unassigned (`root_friend_id = NULL`)
- Returns 400 if friend has siblings and `isRoot: false` without confirmation (query param `?force=true` to confirm)

**`PATCH /api/friends/:id/assign-root`**
Assign a friend as sibling to a root friend (or unassign).

Request body: `{ "rootFriendId": 1 }` or `{ "rootFriendId": null }` to unassign.

Rules:
- Returns 400 if target `rootFriendId` is not actually a root friend
- Returns 400 if the friend being assigned is itself a root friend
- Overwrites any previous assignment (simple reassignment)

### Rewards Report

**`GET /api/analytics/rewards`**
Returns aggregated group performance data across completed coffee cycles.

Query params:
- `limit` (optional, default 10) — number of recent coffee cycles to include

Response:
```json
{
  "cycles": [
    { "id": 15, "name": "Január 2026", "status": "completed" },
    { "id": 18, "name": "Február 2026", "status": "completed" }
  ],
  "thresholdKg": 10,
  "groups": [
    {
      "rootFriend": { "id": 1, "name": "Peter", "displayName": "Peter Novák" },
      "memberCount": 4,
      "perCycle": [
        { "cycleId": 15, "kg": 3.5, "orderedMembers": ["Peter", "Jano", "Marek", "Lucia"] },
        { "cycleId": 18, "kg": 2.25, "orderedMembers": ["Peter", "Jano", "Lucia"] }
      ],
      "cumulativeKg": 5.75,
      "thresholdReached": false,
      "thresholdProgress": 0.575
    },
    {
      "rootFriend": null,
      "label": "Ostatní",
      "memberCount": 2,
      "perCycle": [
        { "cycleId": 15, "kg": 1.0, "orderedMembers": ["Katka"] },
        { "cycleId": 18, "kg": 0.5, "orderedMembers": ["Tomáš"] }
      ],
      "cumulativeKg": 1.5,
      "thresholdReached": false,
      "thresholdProgress": 0.15
    }
  ]
}
```

**Aggregation logic:**
- Only counts coffee cycles (`type = 'coffee'`)
- Only counts submitted orders (`status = 'submitted'`)
- Kg calculation reuses existing `variantToKg()` helper from `analytics.js`
- Groups are based on **current** assignment — reassigning a sibling recalculates everything
- "Ostatní" group aggregates all friends where `is_root = 0` AND `root_friend_id IS NULL`

## Admin UI

### Group Management Page

New admin page at `/admin/friend-groups` (or tab within existing friends management).

**Layout:**
- **Root friends section** — list of cards, each showing the root friend's name and their assigned siblings as chips/tags
  - Each sibling chip has an "×" to unassign
  - "Add sibling" dropdown to assign unassigned friends
  - "Remove root" button (with confirmation if siblings exist)
- **Unassigned friends section** ("Ostatní") — list of friends not in any group
  - Each has a dropdown/button to assign to a root friend or make them a root
- **"Add root" button** — dropdown of all non-root, unassigned friends to promote to root

### Rewards Report Page

New analytics tab alongside existing ones: **Živý prehľad | Káva | Pekáreň | Odmeny**

Route: `/admin/analytics/rewards`

**Layout:**
1. **Threshold setting** — small config area showing current threshold (editable inline)
2. **Groups table** — sortable by cumulative kg
   - Columns: Group (root friend name), Members count, one column per recent cycle (showing kg), Cumulative kg, Progress bar
   - "Ostatní" always appears as last row
   - Rows where `thresholdReached = true` get a visual highlight (green badge or similar)
3. **Expandable rows** — clicking a group row expands to show individual member contributions per cycle
4. **Summary row** at top/bottom showing totals across all groups

## UI Text (Slovak)

- Page title: "Skupiny priateľov"
- Tab label: "Odmeny"
- Root friend label: "Hlavný priateľ"
- Sibling label: "Člen skupiny"
- Unassigned group: "Ostatní"
- Threshold: "Prah odmeny"
- "Pridať hlavného priateľa" (Add root friend)
- "Pridať člena" (Add member)
- "Odstrániť zo skupiny" (Remove from group)
- "Prah dosiahnutý" (Threshold reached)
- "kg celkom" (kg total)

## Scope

### In scope
- Database migration (2 columns on friends + 1 setting)
- Group management API (3 endpoints)
- Rewards report API (1 endpoint)
- Admin group management UI page
- Admin rewards report page (new analytics tab)

### Out of scope
- Automatic reward distribution (vouchers, discounts)
- Friend portal visibility of groups
- Notification to root friends about group progress
- Bakery cycle aggregation (coffee only for now)
- Assignment history / point-in-time tracking

## Verification

1. **Group management:** Create root friends, assign siblings, reassign, remove root status — verify DB state
2. **Report accuracy:** Create test data with known kg across cycles, verify aggregated totals match
3. **Reassignment recalculation:** Move a sibling from group A to B, verify report totals update
4. **Ostatní group:** Verify unassigned friends aggregate correctly
5. **Edge cases:** Root friend with no siblings (just themselves), friend with no orders, empty cycles
6. **UI:** Navigate group management page, verify drag/assign works, check report table renders correctly
