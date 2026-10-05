import test from 'node:test';
import assert from 'node:assert/strict';
import { priceOrder, kitPrice, OrderError } from '../server/pricing.js';
import { parseUnitText, buildUnits } from '../server/personalization.js';
import { emvAmountCents } from '../server/emv.js';
import { mapAdexStatus, verifyAdexSignature } from '../server/adex.js';
import { buildUserData } from '../server/meta.js';
import { isValidCpf, isValidCnpj } from '../server/orders.js';
import { PRODUCT_ID, fakePixCode, sign, P1, P2, pix5 } from './helpers.js';

const item = (o = {}) => ({ id: PRODUCT_ID, quantity: 1, ...o });

test('preço do kit: 1 = base, 2 = valor fixo do catálogo (ou 1,8x), 3 = 2,5x', () => {
  assert.equal(kitPrice({ price: 29310 }, 1), 29310);
  assert.equal(kitPrice({ price: 29310 }, 2), 52758);
  assert.equal(kitPrice({ price: 17990, kit2_price: 31990 }, 2), 31990);
  assert.equal(kitPrice({ price: 29310 }, 3), 73275);
});

test('priceOrder reproduz o checkout do site (Pix 5%, cupom 10%, SEDEX)', () => {
  const a = priceOrder({ items: [item()], shippingCents: 0 });
  assert.equal(a.subtotal, P1);
  assert.equal(a.pixDiscount, pix5(P1));
  assert.equal(a.total, P1 - pix5(P1));
  const b = priceOrder({ items: [item({ kitQty: 2 })], shippingCents: 1939, couponCode: 'prime10' });
  assert.equal(b.subtotal, P2);
  assert.equal(b.total, P2 + 1939 - pix5(P2) - Math.round(P2 * 0.1));
  assert.equal(b.unitsCount, 2);
});

test('priceOrder recusa produto desconhecido, frete e quantidade inválidos', () => {
  assert.throws(() => priceOrder({ items: [{ id: 'x', quantity: 1 }] }), OrderError);
  assert.throws(() => priceOrder({ items: [item()], shippingCents: 777 }), OrderError);
  assert.throws(() => priceOrder({ items: [item({ quantity: 0 })] }), OrderError);
  assert.throws(() => priceOrder({ items: [] }), OrderError);
});

test('parseUnitText lê o texto gerado pela página (reserva)', () => {
  const u = parseUnitText('Unidade 2: Land Rover Defender 90 2020 • Cinza • Traseira • Placa: ZE DA SILVA');
  assert.equal(u.side, 'Traseira');
  assert.equal(u.year, '2020');
  assert.equal(u.color, 'Cinza');
  assert.equal(u.plate_name, 'ZE DA SILVA');
  assert.equal(u.brand_model_text, 'Land Rover Defender 90');
  assert.equal(parseUnitText('texto qualquer'), null);
});

test('buildUnits usa o objeto estruturado, numera as unidades e marca incompletas', () => {
  const items = [{ personalization: [{ view: 'front', category: 'suv', brand: 'Jeep', model: 'Compass', year: '2021', color: 'Branco', plateName: ' ana ' }] }];
  const lines = [{ units: 1, product: { id: PRODUCT_ID, slug: 'gelacar', name: 'GelaCar' } }];
  const r = buildUnits(items, lines);
  assert.equal(r.complete, true);
  assert.equal(r.units[0].plate_name, 'ana');
  assert.equal(r.units[0].category_label, 'SUV');
  const r2 = buildUnits([{ personalization: [{ view: 'front', brand: 'Jeep' }] }], lines);
  assert.equal(r2.complete, false);
});

test('EMV: lê o valor do Pix', () => {
  assert.equal(emvAmountCents(fakePixCode(278.44)), 27844);
  assert.equal(emvAmountCents('lixo'), null);
});

test('status Adex → status do site', () => {
  assert.equal(mapAdexStatus('PAID'), 'PAID');
  assert.equal(mapAdexStatus('approved'), 'PAID');
  assert.equal(mapAdexStatus('expired'), 'FAILED');
  assert.equal(mapAdexStatus('refunded'), 'CHARGEBACK');
  assert.equal(mapAdexStatus('pending'), 'PENDING');
  assert.equal(mapAdexStatus(undefined), 'PENDING');
});

test('assinatura do webhook: corpo cru ou JSON re-serializado', () => {
  const body = JSON.stringify({ event: 'x', data: { transaction_id: '1' } });
  assert.equal(verifyAdexSignature({ header: sign(body), secret: 'sk_test_secret', rawBody: body, parsedBody: JSON.parse(body) }), true);
  assert.equal(verifyAdexSignature({ header: sign(body, 'outra'), secret: 'sk_test_secret', rawBody: body }), false);
  assert.equal(verifyAdexSignature({ header: undefined, secret: 'sk_test_secret', rawBody: body }), false);
});

import nodeCrypto from 'node:crypto';
test('CAPI user_data: tudo hasheado em SHA-256, telefone com 55, sem acentos', () => {
  const u = buildUserData({ email: ' Maria@Example.com ', phone: '(11) 98765-4321', first_name: 'María', city: 'São Paulo', state: 'SP', zip: '01310-100' }, { ip: '1.2.3.4', fbp: 'fb.1.1.2' });
  assert.equal(u.em[0], nodeCrypto.createHash('sha256').update('maria@example.com').digest('hex'));
  assert.equal(u.ph[0], nodeCrypto.createHash('sha256').update('5511987654321').digest('hex'));
  assert.equal(u.ct[0], nodeCrypto.createHash('sha256').update('saopaulo').digest('hex'));
  for (const k of ['em', 'ph', 'fn', 'ct', 'st', 'zp', 'country']) assert.match(u[k][0], /^[0-9a-f]{64}$/);
  assert.equal(u.client_ip_address, '1.2.3.4');
  assert.equal(u.fbp, 'fb.1.1.2');
});

test('CPF/CNPJ', () => {
  assert.equal(isValidCpf('529.982.247-25'), true);
  assert.equal(isValidCpf('111.111.111-11'), false);
  assert.equal(isValidCnpj('11.222.333/0001-81'), true);
  assert.equal(isValidCnpj('11.222.333/0001-82'), false);
});
