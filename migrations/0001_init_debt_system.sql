PRAGMA foreign_keys = ON;

-- 1) users (Telegram users + roles)
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('OWNER','ADMIN','STAFF','CUSTOMER','PENDING')) DEFAULT 'PENDING',
  full_name TEXT,
  phone TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE','LOCKED')) DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

-- 2) customers (Customer identity by phone)
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  tg_id TEXT, -- may be NULL until linked/approved
  notes TEXT,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW','MED','HIGH')) DEFAULT 'LOW',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_customers_tg_id ON customers(tg_id);

-- 3) balances (Debt balance per currency)
CREATE TABLE IF NOT EXISTS balances (
  customer_id INTEGER PRIMARY KEY,
  balance_iqd INTEGER NOT NULL DEFAULT 0,
  balance_usd REAL NOT NULL DEFAULT 0,
  last_activity_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

-- 4) transactions (Debt add / payment / adjustment)
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  actor_tg_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('DEBT_ADD','PAYMENT','ADJUSTMENT')),
  amount REAL NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('IQD','USD')),
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tx_customer_created ON transactions(customer_id, created_at);
CREATE INDEX IF NOT EXISTS idx_tx_actor ON transactions(actor_tg_id);

-- 5) approval_requests (Admin approval for linking)
CREATE TABLE IF NOT EXISTS approval_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_tg_id TEXT NOT NULL,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  requested_role TEXT NOT NULL CHECK (requested_role IN ('CUSTOMER','STAFF')) DEFAULT 'CUSTOMER',
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED')) DEFAULT 'PENDING',
  admin_tg_id TEXT,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_requests(status);

-- 6) processed_updates (Idempotency for Telegram update_id)
CREATE TABLE IF NOT EXISTS processed_updates (
  update_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 7) message_outbox (Reliability for telegram sends)
CREATE TABLE IF NOT EXISTS message_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_tg_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','SENT','FAILED')) DEFAULT 'PENDING',
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_outbox_status ON message_outbox(status);

-- 8) audit_log (Professional audit trail)
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_tg_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);