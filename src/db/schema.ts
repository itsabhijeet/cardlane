import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cardholders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cards (
  id TEXT PRIMARY KEY,
  cardholder_id TEXT NOT NULL REFERENCES cardholders(id),
  status TEXT NOT NULL,
  last4 TEXT NOT NULL,
  currency TEXT NOT NULL,
  transaction_limit_minor INTEGER,
  daily_limit_minor INTEGER,
  blocked_mccs TEXT NOT NULL DEFAULT '[]',
  blocked_atm_countries TEXT NOT NULL DEFAULT '[]',
  atm_allowed INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  card_id TEXT PRIMARY KEY REFERENCES cards(id),
  available_minor INTEGER NOT NULL,
  held_minor INTEGER NOT NULL,
  settled_minor INTEGER NOT NULL,
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS authorizations (
  id TEXT PRIMARY KEY,
  card_id TEXT REFERENCES cards(id),
  amount_minor INTEGER NOT NULL,
  status TEXT NOT NULL,
  response_code TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  mcc TEXT NOT NULL,
  channel TEXT NOT NULL,
  cleared_minor INTEGER NOT NULL DEFAULT 0,
  refunded_minor INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_card_created
  ON authorizations(card_id, created_at);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL UNIQUE,
  card_id TEXT NOT NULL REFERENCES cards(id),
  authorization_id TEXT,
  kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  available_delta INTEGER NOT NULL,
  held_delta INTEGER NOT NULL,
  settled_delta INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spend_daily (
  card_id TEXT NOT NULL REFERENCES cards(id),
  day TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  atm_count INTEGER NOT NULL,
  PRIMARY KEY (card_id, day)
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

export function migrate(db: DatabaseSync): void {
  db.exec(SCHEMA);
}

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db);
  return db;
}
