import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = process.env.DB_PATH || join(__dirname, 'database.sqlite');

// Generate a unique 8-character alphanumeric ID
function generateUid() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars: 0, O, I, 1
  let uid = '';
  for (let i = 0; i < 8; i++) {
    uid += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return uid;
}

// Generate a 5-character invite code
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

let db = null;
let inTransaction = false;

// Initialize database
async function initDb() {
  const SQL = await initSqlJs();

  // Load existing database or create new
  if (existsSync(dbPath)) {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  // Enable foreign keys
  db.run('PRAGMA foreign_keys = ON');

  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS order_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'open' CHECK (status IN ('planned', 'open', 'locked', 'completed')),
      shared_password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: Add shared_password column if it doesn't exist (for existing databases)
  try {
    db.run('ALTER TABLE order_cycles ADD COLUMN shared_password TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add total_friends column to store friend count at cycle creation time
  try {
    db.run('ALTER TABLE order_cycles ADD COLUMN total_friends INTEGER DEFAULT 0');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add markup_ratio column for per-cycle price markup (e.g., 1.19 = 19% markup)
  try {
    db.run('ALTER TABLE order_cycles ADD COLUMN markup_ratio REAL DEFAULT 1.0');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add expected_date column for expected order date/time
  try {
    db.run('ALTER TABLE order_cycles ADD COLUMN expected_date TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add plan_note column for preliminary cycle schedule text
  try {
    db.run('ALTER TABLE order_cycles ADD COLUMN plan_note TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Update CHECK constraint to allow 'planned' status
  // SQLite can't ALTER CHECK constraints, so recreate table if needed
  try {
    db.run("INSERT INTO order_cycles (name, status) VALUES ('_check_test', 'planned')");
    db.run("DELETE FROM order_cycles WHERE name = '_check_test'");
  } catch (e) {
    // CHECK constraint rejects 'planned', recreate table
    db.run('PRAGMA foreign_keys = OFF');
    db.run(`CREATE TABLE order_cycles_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'open' CHECK (status IN ('planned', 'open', 'locked', 'completed')),
      shared_password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      total_friends INTEGER DEFAULT 0,
      markup_ratio REAL DEFAULT 1.0,
      expected_date TEXT,
      plan_note TEXT,
      type TEXT DEFAULT 'coffee'
    )`);
    db.run('INSERT INTO order_cycles_new SELECT id, name, status, shared_password, created_at, total_friends, markup_ratio, expected_date, plan_note, type FROM order_cycles');
    db.run('DROP TABLE order_cycles');
    db.run('ALTER TABLE order_cycles_new RENAME TO order_cycles');
    db.run('PRAGMA foreign_keys = ON');
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      description1 TEXT,
      description2 TEXT,
      roast_type TEXT,
      purpose TEXT,
      price_250g REAL,
      price_1kg REAL,
      image TEXT,
      active INTEGER DEFAULT 1,
      FOREIGN KEY (cycle_id) REFERENCES order_cycles(id) ON DELETE CASCADE
    )
  `);

  // Migration: Add image column if it doesn't exist (for existing databases)
  try {
    db.run('ALTER TABLE products ADD COLUMN image TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add price_20pc5g column for capsule products
  try {
    db.run('ALTER TABLE products ADD COLUMN price_20pc5g REAL');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add price_150g and price_200g columns for new variants
  try {
    db.run('ALTER TABLE products ADD COLUMN price_150g REAL');
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    db.run('ALTER TABLE products ADD COLUMN price_200g REAL');
  } catch (e) {
    // Column already exists, ignore
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS friends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cycle_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      access_token TEXT UNIQUE NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (cycle_id) REFERENCES order_cycles(id) ON DELETE CASCADE
    )
  `);

  // Migration: Add active column for global friends management
  // (cycle_id becomes unused but SQLite doesn't support DROP COLUMN)
  try {
    db.run('ALTER TABLE friends ADD COLUMN active INTEGER DEFAULT 1');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add display_name column (optional, for full name like "Ivet a Peto")
  try {
    db.run('ALTER TABLE friends ADD COLUMN display_name TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add uid column (unique identifier, system-generated, immutable)
  try {
    db.run('ALTER TABLE friends ADD COLUMN uid TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Generate UIDs for existing friends that don't have one
  try {
    const friendsWithoutUid = db.exec("SELECT id FROM friends WHERE uid IS NULL");
    if (friendsWithoutUid.length > 0 && friendsWithoutUid[0].values.length > 0) {
      for (const row of friendsWithoutUid[0].values) {
        const friendId = row[0];
        let uid = generateUid();
        // Ensure uniqueness
        let existing = db.exec(`SELECT id FROM friends WHERE uid = '${uid}'`);
        while (existing.length > 0 && existing[0].values.length > 0) {
          uid = generateUid();
          existing = db.exec(`SELECT id FROM friends WHERE uid = '${uid}'`);
        }
        db.run(`UPDATE friends SET uid = '${uid}' WHERE id = ${friendId}`);
      }
    }
  } catch (e) {
    console.error('Migration error (generating UIDs):', e.message);
  }

  // Add UNIQUE index on uid if not exists (separate step to avoid issues with NULL values)
  try {
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_uid ON friends(uid) WHERE uid IS NOT NULL');
  } catch (e) {
    // Index already exists or other error, ignore
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      friend_id INTEGER NOT NULL,
      cycle_id INTEGER NOT NULL,
      status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'submitted')),
      paid INTEGER DEFAULT 0,
      total REAL DEFAULT 0,
      submitted_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE,
      FOREIGN KEY (cycle_id) REFERENCES order_cycles(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      variant TEXT NOT NULL CHECK (variant IN ('250g', '1kg')),
      quantity INTEGER NOT NULL DEFAULT 1,
      price REAL NOT NULL,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    )
  `);

  // Migration: Recreate order_items table to allow '20pc5g' variant
  // SQLite doesn't support ALTER TABLE to modify CHECK constraints
  try {
    // Check if migration is needed by looking for the old constraint
    const tableInfo = db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='order_items'");
    const tableSql = tableInfo[0]?.values[0]?.[0] || '';

    if (tableSql.includes("IN ('250g', '1kg')") && !tableSql.includes("'20pc5g'")) {
      // Create new table without restrictive CHECK constraint
      db.run(`
        CREATE TABLE order_items_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER NOT NULL,
          product_id INTEGER NOT NULL,
          variant TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          price REAL NOT NULL,
          FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
          FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
        )
      `);

      // Copy data from old table
      db.run(`
        INSERT INTO order_items_new (id, order_id, product_id, variant, quantity, price)
        SELECT id, order_id, product_id, variant, quantity, price FROM order_items
      `);

      // Drop old table and rename new one
      db.run('DROP TABLE order_items');
      db.run('ALTER TABLE order_items_new RENAME TO order_items');
    }
  } catch (e) {
    console.error('Migration error (order_items variant constraint):', e.message);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Migration: Add packed column to orders
  try {
    db.run('ALTER TABLE orders ADD COLUMN packed INTEGER DEFAULT 0');
  } catch (e) {
    // Column already exists, ignore
  }

  try {
    db.run('ALTER TABLE orders ADD COLUMN packed_at DATETIME');
  } catch (e) {
    // Column already exists, ignore
  }

  // Create pickup_locations table
  db.run(`
    CREATE TABLE IF NOT EXISTS pickup_locations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: Add for_coffee and for_bakery columns to pickup_locations
  try {
    db.run('ALTER TABLE pickup_locations ADD COLUMN for_coffee INTEGER DEFAULT 1');
  } catch (e) {}
  try {
    db.run('ALTER TABLE pickup_locations ADD COLUMN for_bakery INTEGER DEFAULT 1');
  } catch (e) {}

  // Migration: Add pickup_location_id and pickup_location_note to orders
  try {
    db.run('ALTER TABLE orders ADD COLUMN pickup_location_id INTEGER');
  } catch (e) {
    // Column already exists, ignore
  }
  try {
    db.run('ALTER TABLE orders ADD COLUMN pickup_location_note TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Create transactions table for balance tracking
  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      friend_id INTEGER NOT NULL,
      order_id INTEGER,
      type TEXT NOT NULL CHECK (type IN ('payment', 'charge', 'adjustment')),
      amount REAL NOT NULL,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE SET NULL
    )
  `);

  // Create bakery_products table (persistent catalog)
  db.run(`
    CREATE TABLE IF NOT EXISTS bakery_products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      weight_grams INTEGER,
      price REAL NOT NULL,
      composition TEXT,
      category TEXT NOT NULL DEFAULT 'slané',
      image TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Migration: Add subtitle column to bakery_products
  try {
    db.run('ALTER TABLE bakery_products ADD COLUMN subtitle TEXT');
  } catch (e) {}

  // Create bakery_product_variants table
  db.run(`
    CREATE TABLE IF NOT EXISTS bakery_product_variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bakery_product_id INTEGER NOT NULL,
      label TEXT,
      weight_grams INTEGER,
      price REAL NOT NULL,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (bakery_product_id) REFERENCES bakery_products(id) ON DELETE CASCADE
    )
  `);

  // Migration: Populate variants from existing bakery_products that have no variants yet
  try {
    const existingVariants = db.exec('SELECT COUNT(*) FROM bakery_product_variants');
    const count = existingVariants[0]?.values[0]?.[0] || 0;
    if (count === 0) {
      const productsWithPrice = db.exec('SELECT id, weight_grams, price FROM bakery_products WHERE price IS NOT NULL');
      if (productsWithPrice.length > 0 && productsWithPrice[0].values.length > 0) {
        for (const row of productsWithPrice[0].values) {
          const [id, weight_grams, price] = row;
          db.run('INSERT INTO bakery_product_variants (bakery_product_id, weight_grams, price, sort_order) VALUES (?, ?, ?, 0)',
            [id, weight_grams, price]);
        }
      }
    }
  } catch (e) {
    console.error('Migration error (bakery product variants):', e.message);
  }

  // Create cycle_bakery_products junction table
  db.run(`
    CREATE TABLE IF NOT EXISTS cycle_bakery_products (
      cycle_id INTEGER NOT NULL,
      bakery_product_id INTEGER NOT NULL,
      PRIMARY KEY (cycle_id, bakery_product_id),
      FOREIGN KEY (cycle_id) REFERENCES order_cycles(id) ON DELETE CASCADE,
      FOREIGN KEY (bakery_product_id) REFERENCES bakery_products(id)
    )
  `);

  // Create friend_subscriptions table
  db.run(`
    CREATE TABLE IF NOT EXISTS friend_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      friend_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE,
      UNIQUE(friend_id, type)
    )
  `);

  // Migration: Add type column to order_cycles
  try {
    db.run("ALTER TABLE order_cycles ADD COLUMN type TEXT DEFAULT 'coffee'");
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add bakery-support columns to products
  try {
    db.run('ALTER TABLE products ADD COLUMN source_bakery_product_id INTEGER');
  } catch (e) {}
  try {
    db.run('ALTER TABLE products ADD COLUMN price_unit REAL');
  } catch (e) {}
  try {
    db.run('ALTER TABLE products ADD COLUMN weight_grams INTEGER');
  } catch (e) {}
  try {
    db.run('ALTER TABLE products ADD COLUMN composition TEXT');
  } catch (e) {}
  try {
    db.run('ALTER TABLE products ADD COLUMN variant_label TEXT');
  } catch (e) {}
  try {
    db.run('ALTER TABLE products ADD COLUMN source_variant_id INTEGER');
  } catch (e) {}

  // Migration: Add roastery column for multi-roastery support
  try {
    db.run('ALTER TABLE products ADD COLUMN roastery TEXT');
  } catch (e) {}

  // Migration: Add price_500g column for 500g variant
  try {
    db.run('ALTER TABLE products ADD COLUMN price_500g REAL');
  } catch (e) {}

  // Migration: Add stock_limit_g column for per-product stock limits (in grams)
  try {
    db.run('ALTER TABLE products ADD COLUMN stock_limit_g INTEGER');
  } catch (e) {}

  // Migration: Add username column for per-user authentication
  try {
    db.run('ALTER TABLE friends ADD COLUMN username TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Migration: Add password_hash column for per-user authentication (bcrypt)
  try {
    db.run('ALTER TABLE friends ADD COLUMN password_hash TEXT');
  } catch (e) {
    // Column already exists, ignore
  }

  // Add UNIQUE index on username if not exists
  try {
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_username ON friends(username) WHERE username IS NOT NULL');
  } catch (e) {
    // Index already exists or other error, ignore
  }

  // Create friend_sessions table for token-based authentication
  db.run(`
    CREATE TABLE IF NOT EXISTS friend_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      friend_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE
    )
  `);

  // Create vouchers table for friend discount vouchers
  db.run(`
    CREATE TABLE IF NOT EXISTS vouchers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      friend_id INTEGER NOT NULL,
      source_cycle_id INTEGER NOT NULL,
      supplier_discount REAL NOT NULL,
      applied_discount REAL NOT NULL,
      order_total REAL NOT NULL,
      retail_total REAL NOT NULL,
      voucher_amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
      transaction_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      resolved_at DATETIME,
      FOREIGN KEY (friend_id) REFERENCES friends(id) ON DELETE CASCADE,
      FOREIGN KEY (source_cycle_id) REFERENCES order_cycles(id),
      FOREIGN KEY (transaction_id) REFERENCES transactions(id) ON DELETE SET NULL
    )
  `);

  // Migration: Add friend grouping columns for rewards report
  try {
    db.run('ALTER TABLE friends ADD COLUMN is_root INTEGER DEFAULT 0');
  } catch (e) {}
  try {
    db.run('ALTER TABLE friends ADD COLUMN root_friend_id INTEGER');
  } catch (e) {}

  // Migration: Add invite_code column for invitation/referral system
  try {
    db.run('ALTER TABLE friends ADD COLUMN invite_code TEXT');
  } catch (e) {}

  // Generate invite codes for existing friends that don't have one
  try {
    const friendsWithoutCode = db.exec("SELECT id FROM friends WHERE invite_code IS NULL");
    if (friendsWithoutCode.length > 0 && friendsWithoutCode[0].values.length > 0) {
      for (const row of friendsWithoutCode[0].values) {
        const friendId = row[0];
        let code = generateInviteCode();
        let existing = db.exec(`SELECT id FROM friends WHERE invite_code = '${code}'`);
        while (existing.length > 0 && existing[0].values.length > 0) {
          code = generateInviteCode();
          existing = db.exec(`SELECT id FROM friends WHERE invite_code = '${code}'`);
        }
        db.run(`UPDATE friends SET invite_code = '${code}' WHERE id = ${friendId}`);
      }
    }
  } catch (e) {
    console.error('Migration error (generating invite codes):', e.message);
  }

  // Unique index on invite_code
  try {
    db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_friends_invite_code ON friends(invite_code) WHERE invite_code IS NOT NULL');
  } catch (e) {}

  // Create invitations table
  db.run(`
    CREATE TABLE IF NOT EXISTS invitations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invite_code TEXT NOT NULL,
      invited_by_friend_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      email TEXT,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processed', 'rejected')),
      admin_note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      processed_at DATETIME,
      FOREIGN KEY (invited_by_friend_id) REFERENCES friends(id)
    )
  `);

  // Partial unique index: prevent duplicate pending registrations for same phone
  try {
    db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_invitations_phone_pending ON invitations(phone) WHERE status = 'pending'");
  } catch (e) {}

  // Initialize rewards_threshold_kg setting if not exists
  const rewardsThreshold = db.exec("SELECT * FROM settings WHERE key = 'rewards_threshold_kg'");
  if (!rewardsThreshold.length || !rewardsThreshold[0].values.length) {
    db.run("INSERT INTO settings (key, value) VALUES ('rewards_threshold_kg', '10')");
  }

  // Initialize friends_password if not exists (empty string means not set)
  const friendsPassword = db.prepare("SELECT * FROM settings WHERE key = 'friends_password'").get();
  if (!friendsPassword) {
    db.run("INSERT INTO settings (key, value) VALUES ('friends_password', '')");
  }

  // Initialize auth_mode if not exists (default: legacy)
  const authModeCheck = db.exec("SELECT * FROM settings WHERE key = 'auth_mode'");
  if (!authModeCheck.length || !authModeCheck[0].values.length) {
    db.run("INSERT INTO settings (key, value) VALUES ('auth_mode', 'legacy')");
  }

  // Roasteries table for multi-roastery support
  db.run(`
    CREATE TABLE IF NOT EXISTS roasteries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      is_default INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Seed default roastery if table is empty
  const roasteryCount = db.exec("SELECT COUNT(*) FROM roasteries");
  if (!roasteryCount.length || !roasteryCount[0].values.length || roasteryCount[0].values[0][0] === 0) {
    db.run("INSERT INTO roasteries (name, is_default) VALUES ('Goriffee', 1)");
  }

  saveDb();
  return db;
}

// Save database to file
function saveDb() {
  if (db) {
    const data = db.export();
    const buffer = Buffer.from(data);
    writeFileSync(dbPath, buffer);
  }
}

// Query helpers that mimic better-sqlite3 API
const dbHelpers = {
  // Run query and return all results as array of objects
  all(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    const results = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject());
    }
    stmt.free();
    return results;
  },

  // Run query and return first result as object
  get(sql, params = []) {
    const results = this.all(sql, params);
    return results[0] || null;
  },

  // Run insert/update/delete and return changes info
  run(sql, params = []) {
    const stmt = db.prepare(sql);
    if (params.length > 0) {
      stmt.bind(params);
    }
    stmt.step();
    stmt.free();

    // Get changes BEFORE any other operations that might reset the value
    const changes = db.getRowsModified();
    const lastIdResult = db.exec('SELECT last_insert_rowid() as id');
    const lastId = lastIdResult[0]?.values[0][0];

    // Only save if not in a transaction (transaction will save on commit)
    if (!inTransaction) {
      saveDb();
    }
    return { lastInsertRowid: lastId, changes };
  },

  // Prepare statement (returns object with run, get, and all methods)
  prepare(sql) {
    return {
      run: (...params) => dbHelpers.run(sql, params),
      get: (...params) => dbHelpers.get(sql, params),
      all: (...params) => dbHelpers.all(sql, params)
    };
  },

  // Transaction helper
  transaction(fn) {
    return (...args) => {
      inTransaction = true;
      db.run('BEGIN TRANSACTION');
      try {
        const result = fn(...args);
        db.run('COMMIT');
        inTransaction = false;
        saveDb();
        return result;
      } catch (e) {
        db.run('ROLLBACK');
        inTransaction = false;
        throw e;
      }
    };
  },

  // Direct exec for multi-statement queries
  exec(sql) {
    db.exec(sql);
    saveDb();
  }
};

// Initialize and export
await initDb();

export default dbHelpers;
export { saveDb, generateUid, generateInviteCode };
