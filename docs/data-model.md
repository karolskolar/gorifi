# Gorifi Data Model

## Storage

**SQLite** via sql.js (SQLite compiled to WebAssembly), in-memory with file persistence to `database.sqlite`. Query helpers (`all`, `get`, `run`, `prepare`, `transaction`) mimic the better-sqlite3 API.

---

## Entities

### Order Cycle (`order_cycles`)
The central organizing unit — a round of orders (coffee or bakery).

| Field | Type | Notes |
|---|---|---|
| id | INTEGER | PK, autoincrement |
| name | TEXT | e.g. "Goriffee Marec 2026" |
| type | TEXT | `'coffee'` (default) or `'bakery'` |
| status | TEXT | `'open'`, `'locked'`, or `'completed'` |
| shared_password | TEXT | Legacy per-cycle password |
| total_friends | INTEGER | Snapshot of active friend count at creation |
| markup_ratio | REAL | Price markup multiplier (default 1.0) |
| expected_date | TEXT | Expected order/delivery date |
| created_at | DATETIME | Auto-set |

**Relationships:** Has many **Products**, has many **Orders**.

---

### Product (`products`)
A product available within a specific cycle. For bakery cycles, snapshotted from the bakery catalog.

| Field | Type | Notes |
|---|---|---|
| id | INTEGER | PK, autoincrement |
| cycle_id | INTEGER | FK → order_cycles.id (CASCADE) |
| name | TEXT | |
| description1 | TEXT | |
| description2 | TEXT | |
| roast_type | TEXT | Coffee-specific |
| purpose | TEXT | Bakery: 'Slane'/'Sladke' |
| price_250g | REAL | Coffee variant price |
| price_1kg | REAL | Coffee variant price |
| price_150g | REAL | Coffee variant price |
| price_200g | REAL | Coffee variant price |
| price_20pc5g | REAL | Capsule variant price |
| price_unit | REAL | Bakery per-unit price |
| weight_grams | INTEGER | Bakery product weight |
| composition | TEXT | Bakery ingredients |
| image | TEXT | Image path/URL |
| active | INTEGER | 1 = active |
| source_bakery_product_id | INTEGER | FK → bakery_products.id (if snapshotted) |

**Relationships:** Belongs to **Order Cycle**. Referenced by **Order Items**. Optionally sourced from **Bakery Product**.

---

### Friend (`friends`)
A user/member who can place orders.

| Field | Type | Notes |
|---|---|---|
| id | INTEGER | PK, autoincrement |
| cycle_id | INTEGER | Legacy, unused (SQLite can't DROP COLUMN) |
| name | TEXT | Short name |
| display_name | TEXT | Optional full name |
| uid | TEXT | System-generated 8-char unique ID (UNIQUE index) |
| username | TEXT | Per-user login (UNIQUE index) |
| password_hash | TEXT | bcrypt hash for per-user auth |
| access_token | TEXT | Legacy token (UNIQUE) |
| active | INTEGER | 1 = active |
| created_at | DATETIME | Auto-set |

**Relationships:** Has many **Orders**, has many **Transactions**, has many **Subscriptions**, has many **Sessions**.

---

### Order (`orders`)
A friend's order within a cycle.

| Field | Type | Notes |
|---|---|---|
| id | INTEGER | PK, autoincrement |
| friend_id | INTEGER | FK → friends.id (CASCADE) |
| cycle_id | INTEGER | FK → order_cycles.id (CASCADE) |
| status | TEXT | `'draft'` or `'submitted'` |
| paid | INTEGER | 0/1 boolean |
| total | REAL | Order total in EUR |
| packed | INTEGER | 0/1 boolean |
| packed_at | DATETIME | When packed |
| pickup_location_id | INTEGER | FK → pickup_locations.id (nullable) |
| pickup_location_note | TEXT | Free text for "Iné" option |
| submitted_at | DATETIME | When submitted |
| created_at | DATETIME | Auto-set |

**Relationships:** Belongs to **Friend** and **Order Cycle**. Has many **Order Items**. Optionally belongs to **Pickup Location**. Has many **Transactions**.

---

### Order Item (`order_items`)
A line item within an order.

| Field | Type | Notes |
|---|---|---|
| id | INTEGER | PK, autoincrement |
| order_id | INTEGER | FK → orders.id (CASCADE) |
| product_id | INTEGER | FK → products.id (CASCADE) |
| variant | TEXT | `'250g'`, `'1kg'`, `'150g'`, `'200g'`, `'20pc5g'`, or `'unit'` |
| quantity | INTEGER | Default 1 |
| price | REAL | Price at time of order |

**Relationships:** Belongs to **Order** and **Product**.

---

### Transaction (`transactions`)
Balance tracking — payments, charges, adjustments.

| Field | Type | Notes |
|---|---|---|
| id | INTEGER | PK, autoincrement |
| friend_id | INTEGER | FK → friends.id (CASCADE) |
| order_id | INTEGER | FK → orders.id (SET NULL), nullable |
| type | TEXT | `'payment'`, `'charge'`, or `'adjustment'` |
| amount | REAL | Positive or negative |
| note | TEXT | |
| created_at | DATETIME | Auto-set |

**Relationships:** Belongs to **Friend**. Optionally linked to **Order**.

---

### Pickup Location (`pickup_locations`)

| Field | Type | Notes |
|---|---|---|
| id | INTEGER | PK, autoincrement |
| name | TEXT | |
| address | TEXT | |
| for_coffee | INTEGER | 1 = available for coffee cycles |
| for_bakery | INTEGER | 1 = available for bakery cycles |
| active | INTEGER | 1 = active (soft-delete) |
| created_at | DATETIME | Auto-set |

**Relationships:** Referenced by **Orders**.

---

### Bakery Product (`bakery_products`)
Persistent catalog of bakery items (not per-cycle).

| Field | Type | Notes |
|---|---|---|
| id | INTEGER | PK, autoincrement |
| name | TEXT | |
| description | TEXT | |
| weight_grams | INTEGER | |
| price | REAL | |
| composition | TEXT | Ingredients |
| category | TEXT | `'slané'` or `'sladké'` |
| image | TEXT | |
| active | INTEGER | 1 = active |
| created_at | DATETIME | Auto-set |
| updated_at | DATETIME | Auto-set |

**Relationships:** Referenced by **Cycle Bakery Products** junction. Snapshotted into **Products** when cycle is created.

---

### Cycle Bakery Products (`cycle_bakery_products`)
Junction table linking bakery catalog items to specific cycles.

| Field | Type | Notes |
|---|---|---|
| cycle_id | INTEGER | FK → order_cycles.id (CASCADE), composite PK |
| bakery_product_id | INTEGER | FK → bakery_products.id, composite PK |

---

### Friend Subscription (`friend_subscriptions`)
Which portfolio types a friend subscribes to.

| Field | Type | Notes |
|---|---|---|
| id | INTEGER | PK, autoincrement |
| friend_id | INTEGER | FK → friends.id (CASCADE) |
| type | TEXT | e.g. `'coffee'`, `'bakery'` |
| created_at | DATETIME | Auto-set |

**Constraint:** UNIQUE(friend_id, type). Empty subscriptions = show all cycles.

---

### Friend Session (`friend_sessions`)
Token-based auth sessions for per-user login.

| Field | Type | Notes |
|---|---|---|
| id | INTEGER | PK, autoincrement |
| friend_id | INTEGER | FK → friends.id (CASCADE) |
| token | TEXT | UNIQUE |
| expires_at | INTEGER | Unix timestamp |
| created_at | DATETIME | Auto-set |

---

### Settings (`settings`)
Key-value store for app configuration.

| Field | Type | Notes |
|---|---|---|
| key | TEXT | PK |
| value | TEXT | |

Known keys: `friends_password`, `auth_mode` (`'legacy'` or `'modern'`).
