import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createAdexClient, verifyAdexSignature } from './adex.js';
import { createMetaClient, buildUserData, fbcFromClickId } from './meta.js';
import { createUtmifyClient } from './utmify.js';
import { createOrderService } from './orders.js';
import { createPostgrestMock } from './postgrest.js';
import { OrderError } from './pricing.js';
import { catalog } from './catalog.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const PRODUCT_PATH = '/produto/gelacar';

const PAGES = {
  '/produto/gelacar': 'produto-gelacar.html',
  '/checkout': 'checkout.html',
  '/pagamento-pix': 'pagamento-pix.html',
  '/politicas': 'politicas.html',
  '/rastreio': 'rastreio.html',
};

export function createApp({ config = loadConfig(), deps = {}, log = console } = {}) {
  const db = deps.db || openDb(config.dataDir);
  const adex = deps.adex || createAdexClient(config.adex);
  const meta = deps.meta || createMetaClient(config.meta);
  const utmify = deps.utmify || createUtmifyClient(config.utmify);
  const orders = createOrderService({ config, db, adex, meta, utmify, log });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  const clientIp = (req) => (String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || null;
  const origin = (req) => config.siteUrl || `${req.protocol}://${req.get('host')}`;

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  // O site (páginas) fica em outro domínio e chama esta API. Sem CORS_ORIGIN, qualquer origem pode chamar
  // (o checkout não usa cookies de login). Para restringir, defina CORS_ORIGIN=https://seusite.com.br.
  app.use('/api/public', (req, res, next) => {
    res.set({ 'Access-Control-Allow-Origin': config.corsOrigin || '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' });
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  });

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // ------------------------------------------------------------------ backend de dados do front (substitui o Supabase do original)
  app.use('/sb', createPostgrestMock({ db, config }));

  // ------------------------------------------------------------------ API pública
  const jsonBody = express.json({
    limit: '512kb',
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  });

  const hits = new Map();
  const rateLimit = (max, windowMs) => (req, res, next) => {
    const key = `${req.path}|${clientIp(req)}`;
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Muitas tentativas. Aguarde um instante e tente novamente.' });
    arr.push(now);
    hits.set(key, arr);
    next();
  };
  setInterval(() => hits.clear(), 3600_000).unref?.();

  app.post('/api/public/create-payment', rateLimit(20, 10 * 60_000), jsonBody, async (req, res) => {
    try {
      const out = await orders.createOrder(req.body, {
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
        cookie: req.headers.cookie,
        sourceUrl: `${origin(req)}/checkout`,
        apiOrigin: `${req.protocol}://${req.get('host')}`,
      });
      res.json(out);
    } catch (e) {
      if (e instanceof OrderError) return res.status(e.status).json({ error: e.message, code: e.code });
      log.error?.('[create-payment]', e);
      res.status(500).json({ error: 'Erro interno ao processar o pagamento' });
    }
  });

  app.post('/api/public/check-payment-status', rateLimit(120, 10 * 60_000), jsonBody, async (req, res) => {
    try {
      const out = await orders.checkStatus({ orderId: req.body?.orderId, gatewayId: req.body?.gatewayId });
      if (!out) return res.status(404).json({ error: 'Pedido não encontrado' });
      res.json(out);
    } catch (e) {
      log.error?.('[check-payment-status]', e);
      res.status(500).json({ error: 'Erro interno' });
    }
  });

  // Webhook da Adex (postbackUrl). Responde rápido; a confirmação sempre vem da consulta autenticada.
  app.post('/api/webhooks/adex', jsonBody, async (req, res) => {
    const header = req.headers['x-webhook-signature'];
    let signatureValid = null;
    if (header) {
      signatureValid = verifyAdexSignature({ header, secret: config.adex.webhookSecret || config.adex.secretKey, rawBody: req.rawBody, parsedBody: req.body });
      if (!signatureValid) {
        log.warn?.('[adex webhook] assinatura inválida');
        return res.status(401).end();
      }
    }
    res.status(200).end();
    try {
      const r = await orders.handleWebhook({ rawBody: req.rawBody, body: req.body, signatureValid });
      log.info?.('[adex webhook]', req.body?.event, JSON.stringify(r));
    } catch (e) {
      log.error?.('[adex webhook] erro', e);
    }
  });

  // Eventos do navegador → API de Conversões da Meta (com o mesmo event_id do Pixel, para deduplicar).
  // Purchase NUNCA é aceito do navegador: só o servidor envia, após o pagamento confirmado.
  app.post('/api/public/meta-capi', rateLimit(300, 10 * 60_000), jsonBody, async (req, res) => {
    const b = req.body || {};
    if (!meta.enabled() || !b.event_name || !b.event_id) return res.status(204).end();
    if (b.event_name === 'Purchase') return res.status(204).end();
    const ud = b.user_data || {};
    const search = (() => {
      try {
        return new URL(b.event_source_url || '').searchParams;
      } catch {
        return new URLSearchParams();
      }
    })();
    const userData = buildUserData(ud, { ip: clientIp(req), userAgent: ud.client_user_agent || req.headers['user-agent'], fbc: ud.fbc || fbcFromClickId(search.get('fbclid')) });
    const r = await meta.send({
      eventName: String(b.event_name).slice(0, 40),
      eventId: String(b.event_id).slice(0, 100),
      sourceUrl: typeof b.event_source_url === 'string' ? b.event_source_url.slice(0, 2000) : undefined,
      userData,
      customData: b.custom_data && typeof b.custom_data === 'object' ? b.custom_data : undefined,
    });
    if (!r.ok) log.warn?.('[meta-capi]', b.event_name, r.status || r.error, JSON.stringify(r.body || '').slice(0, 300));
    res.status(204).end();
  });

  // TikTok: o front mantém a chamada, mas esta operação não usa TikTok.
  app.post('/api/public/tiktok-capi', jsonBody, (_req, res) => res.status(204).end());
  // ---- Foto de referência do carro (opcional). Fica no volume persistente (DATA_DIR/uploads) e é ligada ao
  // pedido na criação. Aceita só JPEG/PNG/WebP (conferido pelo conteúdo, não pelo nome), até 4 MB.
  const uploadsDir = path.join(config.dataDir === ':memory:' ? fs.mkdtempSync(path.join(os.tmpdir(), 'gc-up-')) : config.dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  const insertUpload = db.prepare('INSERT INTO uploads (id, created_at, ip, mime, bytes) VALUES (?, ?, ?, ?, ?)');
  const getUpload = db.prepare('SELECT * FROM uploads WHERE id = ?');
  const sniff = (b) => {
    if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
    if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
    if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
    return null;
  };
  app.post(
    '/api/public/upload-photo',
    rateLimit(15, 60 * 60_000),
    express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '4mb' }),
    (req, res) => {
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) return res.status(415).json({ error: 'Envie uma imagem JPG, PNG ou WEBP.' });
      const kind = sniff(body);
      if (!kind) return res.status(415).json({ error: 'Arquivo não reconhecido como imagem JPG, PNG ou WEBP.' });
      const id = crypto.randomBytes(6).toString('hex');
      fs.writeFileSync(path.join(uploadsDir, id + '.' + kind.ext), body);
      insertUpload.run(id, new Date().toISOString(), clientIp(req), kind.mime, body.length);
      res.json({ id, url: `${req.protocol}://${req.get('host')}/f/${id}`, bytes: body.length });
    },
  );
  // Erros do upload (arquivo grande demais etc.) em JSON amigável
  app.use('/api/public/upload-photo', (err, _req, res, next) => {
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'A foto é grande demais (máximo 4 MB).' });
    next(err);
  });
  app.get('/f/:id', (req, res) => {
    const row = /^[a-f0-9]{12}$/.test(req.params.id) ? getUpload.get(req.params.id) : null;
    if (!row) return res.status(404).type('text').send('Não encontrada');
    const ext = row.mime === 'image/png' ? 'png' : row.mime === 'image/webp' ? 'webp' : 'jpg';
    const file = path.join(uploadsDir, row.id + '.' + ext);
    if (!fs.existsSync(file)) return res.status(404).type('text').send('Não encontrada');
    res.set({ 'Content-Type': row.mime, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'", 'Cache-Control': 'private, max-age=3600' });
    fs.createReadStream(file).pipe(res);
  });
  // Fotos enviadas e nunca ligadas a um pedido (cliente desistiu) saem depois de 7 dias.
  const purge = () => {
    const cutoff = new Date(Date.now() - 7 * 24 * 3600_000).toISOString();
    for (const r of db.prepare('SELECT * FROM uploads WHERE order_id IS NULL AND created_at < ?').all(cutoff)) {
      const ext = r.mime === 'image/png' ? 'png' : r.mime === 'image/webp' ? 'webp' : 'jpg';
      fs.rmSync(path.join(uploadsDir, r.id + '.' + ext), { force: true });
      db.prepare('DELETE FROM uploads WHERE id = ?').run(r.id);
    }
  };
  setInterval(purge, 6 * 3600_000).unref?.();

  app.post('/api/public/truckbar-photo', (_req, res) => res.status(404).json({ error: 'indisponível' }));

  // Modo de teste (ADEX_MOCK=true): simula o pagamento de um pedido.
  if (config.adex.mock) {
    app.post('/api/dev/simulate-payment', jsonBody, async (req, res) => {
      try {
        const o = await orders.simulatePaid(req.body?.orderId);
        res.json({ status: o.status });
      } catch (e) {
        res.status(e.status || 500).json({ error: e.message });
      }
    });
  }

  // ------------------------------------------------------------------ painel simples de pedidos (ADMIN_TOKEN)
  const adminAuth = (req, res, next) => {
    const token = config.adminToken;
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
    const ok = token && given.length === token.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(token));
    if (!ok) return res.status(401).type('text').send('Não autorizado');
    next();
  };
  app.get('/api/admin/orders', adminAuth, (req, res) => {
    res.json(orders.listOrders({ limit: Math.min(Number(req.query.limit) || 100, 500), status: req.query.status || undefined }));
  });
  // Gera um Pix de teste (R$ 1 a R$ 50) para validar Adex + webhook sem mexer no preço do produto.
  app.post('/api/admin/test-pix', adminAuth, jsonBody, async (req, res) => {
    try {
      res.json(await orders.createTestPix({ amountCents: req.body?.amountCents ?? 100, customer: req.body?.customer }));
    } catch (e) {
      if (e instanceof OrderError) return res.status(e.status).json({ error: e.message, code: e.code });
      log.error?.('[test-pix]', e);
      res.status(500).json({ error: 'Erro interno' });
    }
  });
  app.get('/admin/pedidos', adminAuth, (req, res) => {
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const rows = orders.listOrders({ limit: 200, status: req.query.status || undefined }).map((o) => {
      const units = o.units.map((u) => `<li>${esc(orders.describeUnit(u))}${u.photo_id ? ` <a href="/f/${esc(u.photo_id)}" target="_blank">ver foto</a>` : ''}${u.complete ? '' : ' ⚠️ incompleto'}</li>`).join('');
      return `<tr><td>${esc(o.id)}<br><small>${esc(o.created_at)}</small></td><td><b>${esc(o.status)}</b><br>R$ ${(o.amount_cents / 100).toFixed(2)}</td>
        <td>${esc(o.customer.name)}<br>${esc(o.customer.email)}<br>${esc(o.customer.phone)}<br>${esc(o.customer.documentType)} ${esc(o.customer.document)}</td>
        <td>${esc(o.address.street)}, ${esc(o.address.number)} ${esc(o.address.complement)}<br>${esc(o.address.neighborhood)} – ${esc(o.address.city)}/${esc(o.address.state)}<br>CEP ${esc(o.address.zip)}<br>${esc(o.shipping_method)}</td>
        <td><ul>${units}</ul>${o.warnings.length ? `<small>⚠️ ${esc(o.warnings.join('; '))}</small>` : ''}</td>
        <td><small>${esc(o.tracking?.utm_source || '')} / ${esc(o.tracking?.utm_campaign || '')}<br>CAPI: ${o.capi_purchase_sent_at ? 'enviado' : '—'}</small></td></tr>`;
    });
    res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Pedidos GelaCar</title><style>body{font:14px system-ui;margin:16px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px;vertical-align:top}th{background:#f4f4f4}ul{margin:0;padding-left:16px}</style>
      <h1>Pedidos</h1><table><tr><th>Pedido</th><th>Status</th><th>Cliente</th><th>Entrega</th><th>Unidades personalizadas</th><th>Origem</th></tr>${rows.join('')}</table>`);
  });

  // ------------------------------------------------------------------ site
  const gcJson = () =>
    JSON.stringify({ utmifyPixelId: config.utmify.pixelId || null, cardEnabled: config.checkout.cardEnabled, kit2Price: catalog.product.kit2_price ?? null }).replace(/</g, '\\u003c');
  // Só para testes automatizados: troca o fbq real por um registrador (nada é enviado à Meta pelo navegador).
  const gcExtra = () =>
    config.debug.fbqStub
      ? '<script>window.__fbqLog=[];window.fbq=function(){window.__fbqLog.push([].slice.call(arguments))};window.fbq.loaded=true;window.fbq.queue=[]</script>'
      : '';
  const pageCache = new Map();
  const readPage = (name) => {
    if (!pageCache.has(name)) pageCache.set(name, fs.readFileSync(path.join(PUBLIC, 'pages', name), 'utf8'));
    return pageCache.get(name);
  };
  const sendPage = (name) => (req, res) => {
    const html = readPage(name).replaceAll('%%SITE_URL%%', origin(req)).replace('%%GC_JSON%%', () => gcJson()).replace('%%GC_EXTRA%%', () => gcExtra());
    res.set('Cache-Control', 'no-store').type('html').send(html);
  };
  const redirectKeepQuery = (to) => (req, res) => {
    const i = req.originalUrl.indexOf('?');
    res.redirect(302, to + (i >= 0 ? req.originalUrl.slice(i) : ''));
  };

  const hasSite = fs.existsSync(path.join(PUBLIC, 'pages'));
  for (const [route, file] of hasSite ? Object.entries(PAGES) : []) {
    app.get([route, `${route}/`], sendPage(file));
  }
  // A operação nova vende só o GelaCar: a vitrine/outros produtos da loja de referência levam ao produto.
  if (hasSite) app.get(['/', '/produtos', '/colecao/:slug', '/produto/:slug'], (req, res, next) => {
    if (req.path === PRODUCT_PATH) return next();
    redirectKeepQuery(PRODUCT_PATH)(req, res);
  });

  // Os arquivos JS/CSS foram corrigidos mantendo os nomes originais (hash do site de referência), então não
  // podem ser "immutable": o navegador revalida (ETag) e pega correções futuras. Fontes/imagens podem ficar em cache.
  app.use(
    '/assets',
    express.static(path.join(PUBLIC, 'assets'), {
      setHeaders: (res, file) => {
        if (/.(js|css)$/.test(file)) res.set('Cache-Control', config.assetsImmutable ? 'public, max-age=31536000, immutable' : 'no-cache');
        else res.set('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );
  app.use('/__l5e', express.static(path.join(PUBLIC, '__l5e'), { immutable: true, maxAge: '30d' }));
  app.use('/img', express.static(path.join(PUBLIC, 'img'), { maxAge: '7d' }));
  app.use(express.static(path.join(PUBLIC, 'root'), { maxAge: '1d' }));

  app.use((req, res) => {
    if (req.accepts('html') && !req.path.startsWith('/api')) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>404</title><h1>404</h1><p><a href="/">Voltar</a></p>');
    res.status(404).json({ error: 'not_found' });
  });

  const sweeper = setInterval(() => orders.retryPendingEffects().catch(() => {}), 60_000);
  sweeper.unref?.();

  return { app, db, orders, config };
}
