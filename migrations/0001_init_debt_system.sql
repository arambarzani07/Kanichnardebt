-- Kanichnar Debt System - D1 schema
-- 0001_init_debt_system.sql

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'customer', -- admin | staff | customer
  phone TEXT,
  name TEXT,
  username TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tg_id INTEGER NOT NULL UNIQUE,
  created_by_tg INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  full_name TEXT,
  note TEXT,
  created_by_tg INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  type TEXT NOT NULL,            -- debt | payment
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,        -- IQD | USD
  note TEXT,
  created_by_tg INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS notify_links (
  phone TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  tg_id INTEGER,
  linked_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_tg TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  meta_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_tx_phone ON transactions(phone);
CREATE INDEX IF NOT EXISTS idx_tx_created_at ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);