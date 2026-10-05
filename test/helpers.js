import crypto from 'node:crypto';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { createAdexClient } from '../server/adex.js';
import { createMetaClient } from '../server/meta.js';
import { createUtmifyClient } from '../server/utmify.js';
import { openDb } from '../server/db.js';
import { catalog } from '../server/catalog.js';

export const P1 = catalog.product.price; // 1 unidade (centavos)
export const P2 = catalog.product.kit2_price ?? Math.round(P1 * 1.8); // 2 unidades
export const pix5 = (c) => Math.round(c * 0.05);

export const PRODUCT_ID = '2bc65fc1-023e-4c6e-a5bb-8fed24b86f8e';
export const SECRET = 'sk_test_secret';
const silent = { info() {}, warn() {}, error() {} };

// Pix EMV mínimo com o campo 54 (valor) — suficiente para o parser do projeto.
export function fakePixCode(amountReais) {
  const f = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;
  return f('00', '01') + f('54', amountReais.toFixed(2)) + f('58', 'BR') + '6304ABCD';
}

// Sobe o app com Adex/Meta/UTMify falsos (nenhuma chamada real de rede).
export async function startTestApp(overrides = {}) {
  const calls = { adexCreate: [], adexGet: [], meta: [], utmify: [] };
  const adexState = { status: 'pending', amountMultiplier: 1 };

  const adexFetch = async (url, init = {}) => {
    const res = (obj, status = 200) => ({ ok: status < 400, status, json: async () => obj });
    if (init.method === 'POST') {
      const body = JSON.parse(init.body);
      calls.adexCreate.push({ url, headers: init.headers, body });
      const amount = Number(body.amount) * adexState.amountMultiplier;
      return res({ success: true, transaction: { id: `tx-${calls.adexCreate.length}`, status: 'pending' }, pix: { qrCode: fakePixCode(amount), expiresAt: '2030-01-01T00:00:00Z' } });
    }
    const id = new URL(url).searchParams.get('transaction_id');
    calls.adexGet.push(id);
    return res({ transaction: { id, status: adexState.status } });
  };
  const metaFetch = async (url, init) => {
    calls.meta.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ events_received: 1 }) };
  };
  const utmifyFetch = async (url, init) => {
    calls.utmify.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };

  const config = loadConfig({
    SITE_URL: 'https://novo-dominio.test',
    ADEX_PUBLIC_KEY: 'pk_test',
    ADEX_SECRET_KEY: SECRET,
    META_PIXEL_ID: '111222333444555',
    META_CAPI_TOKEN: 'token_test',
    UTMIFY_API_TOKEN: 'utmify_test',
    ADMIN_TOKEN: 'admin_test',
    ...overrides,
  });
  config.dataDir = ':memory:';
  const db = openDb(':memory:');
  const { app, orders } = createApp({
    config,
    log: silent,
    deps: {
      db,
      adex: createAdexClient(config.adex, { fetchImpl: adexFetch }),
      meta: createMetaClient(config.meta, { fetchImpl: metaFetch }),
      utmify: createUtmifyClient(config.utmify, { fetchImpl: utmifyFetch }),
    },
  });
  const server = await new Promise((r) => {
    const s = app.listen(0, '127.0.0.1', () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, headers = {}, raw) => {
    const r = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw ?? JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* corpo vazio */
    }
    return { status: r.status, json, text };
  };
  return { base, server, db, orders, calls, adexState, post, close: () => new Promise((r) => server.close(r)) };
}

const unit = (o = {}) => ({ view: 'front', category: 'pickup', brand: 'Toyota', model: 'Hilux 8ª geração', year: '2022', color: 'Preto', plateName: 'JOAO', manual: false, ...o });

// Corpo igual ao que o checkout do site envia para um kit de N unidades (1 ou 2), Pix.
export function checkoutBody({ units = [unit()], shippingCents = 0, couponCode = null, attemptId = crypto.randomUUID(), amount } = {}) {
  const n = units.length;
  const unitPrice = n === 2 ? P2 : P1;
  const subtotal = unitPrice;
  const pix = Math.round(subtotal * 0.05);
  const coupon = couponCode ? Math.round(subtotal * 0.1) : 0;
  const total = subtotal + shippingCents - pix - coupon;
  const text = units.map((u, i) => `Unidade ${i + 1}: ${u.brand} ${u.model} ${u.year} • ${u.color} • ${u.view === 'front' ? 'Frente' : 'Traseira'} • Placa: ${u.plateName}`);
  return {
    attemptId,
    paymentMethod: 'PIX',
    amount: amount ?? total,
    shippingCents,
    discountCents: pix + coupon,
    couponCode,
    giftWrapCents: 0,
    interestCents: 0,
    customer: { name: 'Maria de Almeida Cruz', email: 'maria@example.com', document: '529.982.247-25', documentType: 'CPF', phone: '(11) 98765-4321' },
    address: { street: 'Avenida Paulista', streetNumber: '1000', complement: '', zipCode: '01310-100', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP' },
    items: [
      {
        id: PRODUCT_ID, slug: 'gelacar', title: n > 1 ? `${n}x GelaCar` : 'GelaCar', unitPrice, quantity: 1, kitQty: n > 1 ? n : undefined,
        variant: text.length > 1 ? text.map((t, i) => `Un. ${i + 1}: ${t.replace(/^Unidade \d+: /, '')}`).join(' | ') : text[0],
        personalization: units, units: n > 1 ? text : undefined,
      },
    ],
    trackingParameters: { utm_source: 'fb', utm_campaign: 'teste', fbclid: 'IwAR123' },
  };
}
export { unit };

export function sign(body, secret = SECRET) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}
