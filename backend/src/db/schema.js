import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbPath = join(__dirname, 'database.sqlite');

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
      status TEXT DEFAULT 'open' CHECK (status IN ('open', 'locked', 'completed')),
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

  db.run(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // Initialize friends_password if not exists (empty string means not set)
  const friendsPassword = db.prepare("SELECT * FROM settings WHERE key = 'friends_password'").get();
  if (!friendsPassword) {
    db.run("INSERT INTO settings (key, value) VALUES ('friends_password', '')");
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
export { saveDb };
