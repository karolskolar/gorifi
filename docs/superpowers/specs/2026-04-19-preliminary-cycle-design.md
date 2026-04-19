# Preliminary Cycle Status

## Overview

Add a "plánovaný" (planned) status to ordering cycles that serves as an announcement for friends about upcoming orders. Friends see the planned cycle with a schedule note but cannot click into it or place orders. When the admin is ready, they change the status to "open" and ordering begins.

## Motivation

Friends frequently ask on WhatsApp when the next order will happen. A planned cycle with a visible schedule eliminates this — friends check the portal and see the timeline.

## Data Changes

### order_cycles table

- **status CHECK constraint**: Add `'planned'` to allowed values: `('planned', 'open', 'locked', 'completed')`
- **New column**: `plan_note TEXT` — free-text schedule/plan visible to friends

### Example plan_note content

```
1. - 3. máj objednávanie kávy
4. - 5. máj dodávka kávy
od 6. mája distribúcia (Packetou 8.5. káva na adrese)
```

## Backend Changes

### Schema migration
- Recreate CHECK constraint to include `'planned'` (SQLite doesn't support ALTER CHECK — use the existing pattern of try/catch migrations; since CHECK is only on CREATE TABLE which uses IF NOT EXISTS, new databases get the updated constraint; existing databases work because SQLite doesn't enforce CHECK on ALTER)
- Add `plan_note` column via ALTER TABLE migration

### Cycle routes
- `POST /cycles` — accept `plan_note` and allow `status: 'planned'` at creation
- `PATCH /cycles/:id` — accept `plan_note` updates, allow status transitions from `planned` to `open`
- `GET /cycles/:id` — return `plan_note`

### Friends routes
- `GET /friends/cycles` — return planned cycles with `plan_note`, same as open/locked cycles

## Frontend Changes

### Admin Dashboard (AdminDashboard.vue)
- Show planned cycles in the active list
- Badge: "Plánovaný" with appropriate styling
- Allow creating a cycle with "Plánovaný" status
- Plan note textarea in the cycle creation/edit form

### Cycle Detail (CycleDetail.vue)
- Show/edit `plan_note` textarea
- Allow status change from "Plánovaný" to "Otvorený"

### Friend Portal (FriendPortal.vue)
- Show planned cycles in the active cycles list (not archive)
- Badge: "Plánovaný" — blue/indigo color (informational)
- Display `plan_note` below the cycle name, preserving line breaks (whitespace-pre-line)
- Card is NOT clickable — no router-link, no chevron arrow
- No "Neobjednané" badge on planned cycles
- No order-related info (kilos, item count)

### Friend Order (FriendOrder.vue)
- No changes needed — planned cycles are not navigable from the portal

### Status helpers
- `getStatusText('planned')` returns `'Plánovaný'`
- `getStatusVariant('planned')` returns a blue/indigo variant

## Status Lifecycle

```
planned → open → locked → completed
```

A planned cycle can only transition to open. The reverse (open → planned) is not needed.

## Not in scope

- Scheduled auto-open (cron-based status change)
- Notification to friends when status changes
- Structured date fields (free text is sufficient)
