import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

// Armazenamento próprio (SQLite em arquivo). Em produção, aponte DATA_DIR para um volume persistente.
export function openDb(dataDir) {
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true });
    file = path.join(dataDir, 'gelacar.sqlite');
  }
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      attempt_id TEXT UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      status TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      amount_cents INTEGER NOT NULL,
      subtotal_cents INTEGER NOT NULL,
      shipping_cents INTEGER NOT NULL,
      shipping_method TEXT,
      pix_discount_cents INTEGER NOT NULL DEFAULT 0,
      coupon_code TEXT,
      coupon_discount_cents INTEGER NOT NULL DEFAULT 0,
      gift_wrap_cents INTEGER NOT NULL DEFAULT 0,
      customer TEXT NOT NULL,
      address TEXT NOT NULL,
      items TEXT NOT NULL,
      units TEXT NOT NULL,
      units_count INTEGER NOT NULL,
      personalization_complete INTEGER NOT NULL DEFAULT 0,
      tracking TEXT,
      client TEXT,
      gateway TEXT NOT NULL DEFAULT 'adex',
      gateway_id TEXT,
      pix_code TEXT,
      pix_expires_at TEXT,
      paid_at TEXT,
      warnings TEXT,
      capi_purchase_sent_at TEXT,
      capi_purchase_attempts INTEGER NOT NULL DEFAULT 0,
      utmify_waiting_sent_at TEXT,
      utmify_paid_sent_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS orders_gateway_id ON orders(gateway_id) WHERE gateway_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS orders_status ON orders(status, created_at);

    CREATE TABLE IF NOT EXISTS webhook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedupe_key TEXT NOT NULL UNIQUE,
      received_at TEXT NOT NULL,
      event TEXT,
      transaction_id TEXT,
      signature_valid INTEGER,
      payload TEXT
    );

    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tracking_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      event_type TEXT,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS capi_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      order_id TEXT,
      event_name TEXT,
      event_id TEXT,
      ok INTEGER,
      response TEXT
    );
  `);
  return db;
}
