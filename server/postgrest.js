import express from 'express';
import { catalog } from './catalog.js';

// Mini-API compatível com o subconjunto do PostgREST/Supabase que o front-end copiado consome.
// Substitui o backend do site original: catálogo, configurações da loja, pixels e captura de leads/eventos.
// Tudo é servido/guardado por ESTE projeto.
const PRODUCT_ROWS = [catalog.product];
const SETTINGS_ROWS = Object.entries(catalog.settings).map(([key, value]) => ({ key, value }));

const TABLES = {
  products: () => PRODUCT_ROWS,
  store_settings: () => SETTINGS_ROWS,
  collections: () => [],
  collection_products: () => [],
};

function applyFilter(rows, column, expr) {
  const dot = expr.indexOf('.');
  const op = expr.slice(0, dot);
  const val = expr.slice(dot + 1);
  const norm = (v) => (v === null || v === undefined ? '' : String(v));
  switch (op) {
    case 'eq': return rows.filter((r) => norm(r[column]) === val);
    case 'neq': return rows.filter((r) => norm(r[column]) !== val);
    case 'in': {
      const list = val.replace(/^\(|\)$/g, '').split(',').map((s) => s.replace(/^"|"$/g, ''));
      return rows.filter((r) => list.includes(norm(r[column])));
    }
    case 'is': return rows.filter((r) => (val === 'null' ? r[column] == null : norm(r[column]) === val));
    default: return rows; // operadores não usados pelo front: ignora
  }
}

function project(rows, select) {
  if (!select || select === '*') return rows;
  const cols = select.split(',').map((c) => c.trim().split(':').pop()).filter(Boolean);
  if (cols.includes('*')) return rows;
  if (cols.includes('offer_mode')) cols.push('kit2_price', 'kit2_compare_at_price');
  return rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
}

export function createPostgrestMock({ db, config }) {
  const router = express.Router();
  router.use(express.json({ limit: '256kb' }));

  const insertLead = db.prepare('INSERT OR IGNORE INTO leads (id, created_at, data) VALUES (?, ?, ?)');
  const insertEvent = db.prepare('INSERT INTO tracking_events (created_at, event_type, data) VALUES (?, ?, ?)');

  router.get('/rest/v1/:table', (req, res) => {
    const source = TABLES[req.params.table];
    if (!source) return res.status(404).json({ code: 'PGRST205', message: `tabela ${req.params.table} não existe`, details: null, hint: null });
    let rows = source();
    for (const [k, v] of Object.entries(req.query)) {
      if (['select', 'order', 'limit', 'offset'].includes(k) || typeof v !== 'string') continue;
      rows = applyFilter(rows, k, v);
    }
    if (req.query.limit) rows = rows.slice(0, Number(req.query.limit) || 0);
    rows = project(rows, String(req.query.select || '*'));
    res.set('Cache-Control', 'no-store');
    if (String(req.headers.accept || '').includes('application/vnd.pgrst.object+json')) {
      if (rows.length !== 1) {
        return res.status(406).json({ code: 'PGRST116', details: `The result contains ${rows.length} rows`, hint: null, message: 'JSON object requested, multiple (or no) rows returned' });
      }
      return res.json(rows[0]);
    }
    res.json(rows);
  });

  router.post('/rest/v1/leads', (req, res) => {
    const list = Array.isArray(req.body) ? req.body : [req.body];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      insertLead.run(String(row.id || crypto.randomUUID()), new Date().toISOString(), JSON.stringify(row));
    }
    res.status(201).end();
  });

  router.post('/rest/v1/tracking_events', (req, res) => {
    const list = Array.isArray(req.body) ? req.body : [req.body];
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      insertEvent.run(new Date().toISOString(), String(row.event_type || ''), JSON.stringify(row));
    }
    res.status(201).end();
  });

  // Pixels configurados NESTE projeto (ambiente). Nunca vêm do site original.
  router.post('/rest/v1/rpc/get_active_meta_pixels', (_req, res) => {
    res.json(config.meta.pixelId ? [{ pixel_id: config.meta.pixelId }] : []);
  });
  router.post('/rest/v1/rpc/get_active_tiktok_pixels', (_req, res) => res.json([]));
  router.post('/rest/v1/rpc/lookup_tracking', (_req, res) => res.json([]));

  router.all('/rest/v1/*', (_req, res) => res.status(404).json({ code: 'PGRST202', message: 'rota não suportada', details: null, hint: null }));
  router.all('/auth/*', (_req, res) => res.status(404).json({ error: 'auth indisponível' }));
  return router;
}
