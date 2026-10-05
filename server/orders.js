import crypto from 'node:crypto';
import { priceOrder, OrderError } from './pricing.js';
import { buildUnits, describeUnit } from './personalization.js';
import { mapAdexStatus } from './adex.js';
import { emvAmountCents } from './emv.js';
import { buildUserData, fbcFromClickId } from './meta.js';

const onlyDigits = (v) => String(v ?? '').replace(/\D/g, '');
const clean = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const nowIso = () => new Date().toISOString();
// Pedidos de teste (R$ 1 etc.) têm id GCTEST... e nunca disparam Pixel/CAPI/UTMify.
const isTest = (id) => String(id).startsWith('GCTEST');
const json = (v) => JSON.stringify(v ?? null);

export function isValidCpf(value) {
  const t = onlyDigits(value);
  if (t.length !== 11 || /^(\d)\1+$/.test(t)) return false;
  let n = 0;
  for (let i = 0; i < 9; i++) n += Number(t[i]) * (10 - i);
  let r = 11 - (n % 11);
  if (r >= 10) r = 0;
  if (r !== Number(t[9])) return false;
  n = 0;
  for (let i = 0; i < 10; i++) n += Number(t[i]) * (11 - i);
  r = 11 - (n % 11);
  if (r >= 10) r = 0;
  return r === Number(t[10]);
}

export function isValidCnpj(value) {
  const t = onlyDigits(value);
  if (t.length !== 14 || /^(\d)\1+$/.test(t)) return false;
  const calc = (weights) => {
    let n = 0;
    for (let i = 0; i < weights.length; i++) n += Number(t[i]) * weights[i];
    const r = n % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc([5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(t[12]) && calc([6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === Number(t[13]);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > 0) {
      try {
        out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        /* cookie malformado: ignora */
      }
    }
  }
  return out;
}

function rowToOrder(r) {
  if (!r) return null;
  const p = (s) => (s == null ? null : JSON.parse(s));
  return {
    ...r,
    customer: p(r.customer),
    address: p(r.address),
    items: p(r.items),
    units: p(r.units),
    tracking: p(r.tracking),
    client: p(r.client),
    warnings: p(r.warnings) || [],
    personalization_complete: !!r.personalization_complete,
  };
}

// CRC16-CCITT do BR Code (usado só no modo de teste ADEX_MOCK).
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function mockPixCode(amountCents, orderId) {
  const f = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;
  const body =
    f('00', '01') + f('26', f('00', 'br.gov.bcb.pix') + f('01', `teste-${orderId}`)) + f('52', '0000') + f('53', '986') +
    f('54', (amountCents / 100).toFixed(2)) + f('58', 'BR') + f('59', 'TESTE GELACAR') + f('60', 'SAO PAULO') + f('62', f('05', orderId.slice(0, 20))) + '6304';
  return body + crc16(body);
}

export function createOrderService({ config, db, adex, meta, utmify, log = console }) {
  const q = {
    byId: db.prepare('SELECT * FROM orders WHERE id = ?'),
    byAttempt: db.prepare('SELECT * FROM orders WHERE attempt_id = ?'),
    byGateway: db.prepare('SELECT * FROM orders WHERE gateway_id = ?'),
    insert: db.prepare(`INSERT INTO orders (id, attempt_id, created_at, updated_at, status, payment_method, amount_cents, subtotal_cents,
      shipping_cents, shipping_method, pix_discount_cents, coupon_code, coupon_discount_cents, gift_wrap_cents, customer, address, items, units,
      units_count, personalization_complete, tracking, client, gateway, warnings)
      VALUES (?, ?, ?, ?, 'PENDING', 'PIX', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    setGateway: db.prepare('UPDATE orders SET gateway_id = ?, pix_code = ?, pix_expires_at = ?, updated_at = ? WHERE id = ?'),
    failCreate: db.prepare(`UPDATE orders SET status = 'GATEWAY_ERROR', attempt_id = ?, warnings = ?, updated_at = ? WHERE id = ?`),
    markPaid: db.prepare(`UPDATE orders SET status = 'PAID', paid_at = ?, updated_at = ? WHERE id = ? AND status != 'PAID'`),
    setStatus: db.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?'),
    capiAttempt: db.prepare('UPDATE orders SET capi_purchase_attempts = capi_purchase_attempts + 1 WHERE id = ?'),
    capiSent: db.prepare('UPDATE orders SET capi_purchase_sent_at = ? WHERE id = ? AND capi_purchase_sent_at IS NULL'),
    utmifyWaiting: db.prepare('UPDATE orders SET utmify_waiting_sent_at = ? WHERE id = ? AND utmify_waiting_sent_at IS NULL'),
    utmifyPaid: db.prepare('UPDATE orders SET utmify_paid_sent_at = ? WHERE id = ? AND utmify_paid_sent_at IS NULL'),
    capiLog: db.prepare('INSERT INTO capi_log (created_at, order_id, event_name, event_id, ok, response) VALUES (?, ?, ?, ?, ?, ?)'),
    pendingCapi: db.prepare(`SELECT id FROM orders WHERE status = 'PAID' AND id NOT LIKE 'GCTEST%' AND capi_purchase_sent_at IS NULL AND capi_purchase_attempts < 8 AND paid_at > ?`),
    pendingUtmifyPaid: db.prepare(`SELECT id FROM orders WHERE status = 'PAID' AND id NOT LIKE 'GCTEST%' AND utmify_paid_sent_at IS NULL AND paid_at > ?`),
  };

  const getOrder = (id) => rowToOrder(q.byId.get(id));
  const lastPoll = new Map();

  function newOrderId() {
    return `GC${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  }

  function validate(body) {
    const customer = body?.customer || {};
    const name = clean(customer.name, 120);
    const email = clean(customer.email, 160);
    const phone = onlyDigits(customer.phone);
    const docType = customer.documentType === 'CNPJ' ? 'CNPJ' : 'CPF';
    const docNumber = onlyDigits(customer.document);
    if (name.length < 2) throw new OrderError('bad_customer', 'Preencha o nome completo');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new OrderError('bad_customer', 'Digite um e-mail válido');
    if (phone.length < 10 || phone.length > 11) throw new OrderError('bad_customer', 'Preencha o celular / WhatsApp');
    if (docType === 'CPF' ? !isValidCpf(docNumber) : !isValidCnpj(docNumber)) {
      throw new OrderError('bad_document', docType === 'CPF' ? 'CPF inválido. Verifique e tente novamente.' : 'CNPJ inválido. Verifique e tente novamente.');
    }
    const a = body?.address || {};
    const address = {
      zip: onlyDigits(a.zipCode).slice(0, 8),
      street: clean(a.street, 160),
      number: clean(a.streetNumber, 20),
      complement: clean(a.complement, 80),
      neighborhood: clean(a.neighborhood, 80),
      city: clean(a.city, 80),
      state: clean(a.state, 2).toUpperCase(),
    };
    if (address.zip.length !== 8 || !address.street || !address.number || !address.neighborhood || !address.city || address.state.length !== 2) {
      throw new OrderError('bad_address', 'Endereço de entrega incompleto');
    }
    return {
      customer: { name, email, phone, document: docNumber, documentType: docType },
      address,
    };
  }

  function responseFor(order) {
    return {
      orderId: order.id,
      gatewayId: order.gateway_id,
      status: order.status === 'PAID' ? 'PAID' : 'PENDING',
      pix: order.pix_code ? { url: order.pix_code, qrcode: order.pix_code, expiresAt: order.pix_expires_at } : null,
    };
  }

  async function createOrder(body, ctx) {
    if (body?.paymentMethod !== 'PIX') {
      throw new OrderError('payment_method_unavailable', 'Pagamento por cartão indisponível no momento. Escolha Pix.');
    }
    const attemptId = clean(body?.attemptId, 80);
    if (!/^[A-Za-z0-9-]{8,80}$/.test(attemptId)) throw new OrderError('bad_attempt', 'Requisição inválida');

    // Mesma tentativa (duplo clique / reenvio): devolve o pedido já criado.
    const existing = q.byAttempt.get(attemptId);
    if (existing) {
      let o = rowToOrder(existing);
      for (let i = 0; i < 30 && !o.gateway_id && o.status === 'PENDING'; i++) {
        await new Promise((r) => setTimeout(r, 500));
        o = getOrder(o.id);
      }
      if (o.gateway_id) return responseFor(o);
      throw new OrderError('in_progress', 'Seu pedido ainda está sendo processado. Tente novamente em instantes.', 409);
    }

    const { customer, address } = validate(body);
    const items = Array.isArray(body.items) ? body.items : [];
    const priced = priceOrder({
      items,
      shippingCents: body.shippingCents,
      couponCode: body.couponCode,
      giftWrapCents: body.giftWrapCents,
    });
    if (Number(body.amount) !== priced.total) {
      log.warn?.('[order] valor divergente', { cliente: body.amount, servidor: priced.total });
      throw new OrderError('price_changed', 'Os valores do pedido mudaram. Atualize a página e tente novamente.', 409);
    }
    if (priced.total < 100) throw new OrderError('bad_amount', 'Valor do pedido inválido');

    const { units, warnings, complete } = buildUnits(items, priced.lines);
    const orderItems = priced.lines.map((l, i) => ({
      id: l.product.id,
      slug: l.product.slug,
      title: l.kitQty > 1 ? `${l.kitQty}x ${l.product.name}` : l.product.name,
      quantity: l.quantity,
      kitQty: l.kitQty,
      unitPriceCents: l.unitPrice,
      units: l.units,
      variant: clean(items[i]?.variant, 1000) || null,
    }));

    const t = body.trackingParameters && typeof body.trackingParameters === 'object' ? body.trackingParameters : {};
    const tracking = {};
    for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'src', 'sck', 'xcod', 'fbclid', 'gclid', 'ttclid']) {
      tracking[k] = t[k] ? clean(t[k], 300) : null;
    }
    const cookies = parseCookies(ctx.cookie);
    const client = {
      ip: ctx.ip || null,
      user_agent: ctx.userAgent || null,
      fbp: cookies._fbp || null,
      fbc: cookies._fbc || fbcFromClickId(tracking.fbclid) || null,
      source_url: ctx.sourceUrl || null,
    };

    const id = newOrderId();
    const ts = nowIso();
    try {
      q.insert.run(
        id, attemptId, ts, ts, priced.total, priced.subtotal, priced.shipping, priced.shippingMethod, priced.pixDiscount,
        priced.coupon, priced.couponDiscount, priced.gift, json(customer), json(address), json(orderItems), json(units),
        units.length, complete ? 1 : 0, json(tracking), json(client), 'adex', json(warnings),
      );
    } catch (e) {
      if (/UNIQUE/i.test(String(e.message))) return createOrder(body, ctx); // corrida: cai no ramo "existente"
      throw e;
    }

    // Título visível no painel da Adex: produto + o que produzir (cada unidade) + id do pedido.
    const unitsText = units.map((u) => `U${u.n}: ${(u.brand_model_text || `${u.brand} ${u.model}`).trim()} ${u.year} ${u.color} ${u.side} placa ${u.plate_name}`).join(' | ');
    const title = `GelaCar ${units.length}un - ${unitsText} (${id})`.slice(0, 250);
    let pix;
    try {
      if (config.adex.mock) {
        pix = { transactionId: `mock-${id}`, status: 'pending', code: mockPixCode(priced.total, id), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
      } else {
        if (!adex.configured()) throw Object.assign(new Error('adex_not_configured'), { detail: 'ADEX_PUBLIC_KEY/ADEX_SECRET_KEY ausentes' });
        pix = await adex.createPix({
          orderId: id,
          amountCents: priced.total,
          customer,
          address,
          title,
          document: { number: customer.document, type: customer.documentType.toLowerCase() },
        });
      }
      if (!pix.code) throw Object.assign(new Error('no_pix_code'), { detail: 'Adex não devolveu o código Pix' });
      if (config.adex.verifyEmv) {
        const embedded = emvAmountCents(pix.code);
        if (embedded !== null && embedded !== priced.total) {
          throw Object.assign(new Error('emv_amount_mismatch'), {
            detail: `valor no Pix=${embedded} centavos, esperado=${priced.total}. Revise ADEX_AMOUNT_UNIT (reais|cents).`,
          });
        }
      }
    } catch (e) {
      log.error?.('[order] falha ao criar cobrança', id, e.message, e.detail ? JSON.stringify(e.detail).slice(0, 600) : '');
      q.failCreate.run(`${attemptId}:failed:${Date.now()}`, json([...warnings, `falha ao criar cobrança: ${e.message}`]), nowIso(), id);
      throw new OrderError('gateway_error', 'Não foi possível gerar o Pix agora. Tente novamente em instantes.', 502);
    }

    q.setGateway.run(pix.transactionId, pix.code, pix.expiresAt, nowIso(), id);
    const order = getOrder(id);
    log.info?.('[order] criado', { id, gateway_id: pix.transactionId, total: priced.total, unidades: units.length });

    if (utmify.enabled() && !isTest(id)) {
      utmify.sendOrder(order, 'waiting_payment').then((r) => {
        if (r.ok) q.utmifyWaiting.run(nowIso(), id);
        else log.warn?.('[utmify] waiting_payment falhou', id, r.status || r.error);
      });
    }
    return responseFor(order);
  }

  // Pix de teste com valor livre (protegido por ADMIN_TOKEN na rota). Mesmo caminho real da Adex e do webhook.
  async function createTestPix({ amountCents = 100, customer: c = {} } = {}) {
    amountCents = Math.floor(Number(amountCents));
    if (!(amountCents >= 100 && amountCents <= 5000)) throw new OrderError('bad_amount', 'Valor de teste deve ficar entre R$ 1,00 e R$ 50,00');
    const customer = { name: clean(c.name, 120) || 'Teste GelaCar', email: clean(c.email, 160) || 'teste@gelacar.shop', phone: onlyDigits(c.phone) || '11999999999', document: onlyDigits(c.document) || '52998224725', documentType: 'CPF' };
    if (!isValidCpf(customer.document)) throw new OrderError('bad_document', 'CPF inválido');
    const address = { zip: '01310100', street: 'Avenida Paulista', number: '1000', complement: '', neighborhood: 'Bela Vista', city: 'São Paulo', state: 'SP' };
    const id = `GCTEST${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const ts = nowIso();
    q.insert.run(id, `test-${id}`, ts, ts, amountCents, amountCents, 0, 'correios', 0, null, 0, 0, json(customer), json(address),
      json([{ id: 'teste', slug: 'teste', title: 'TESTE de Pix GelaCar', quantity: 1, kitQty: 1, unitPriceCents: amountCents, units: 0, variant: null }]),
      json([]), 0, 0, json({}), json({ test: true }), 'adex', json(['PEDIDO DE TESTE']));
    let pix;
    try {
      if (config.adex.mock) pix = { transactionId: `mock-${id}`, code: mockPixCode(amountCents, id), expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
      else {
        if (!adex.configured()) throw Object.assign(new Error('adex_not_configured'), { detail: 'ADEX_PUBLIC_KEY/ADEX_SECRET_KEY ausentes' });
        pix = await adex.createPix({ orderId: id, amountCents, customer, address, title: `TESTE Pix GelaCar (${id})`, document: { number: customer.document, type: 'cpf' } });
      }
      if (!pix.code) throw Object.assign(new Error('no_pix_code'), { detail: 'Adex não devolveu o código Pix' });
      const embedded = emvAmountCents(pix.code);
      if (config.adex.verifyEmv && embedded !== null && embedded !== amountCents) throw Object.assign(new Error('emv_amount_mismatch'), { detail: `valor no Pix=${embedded} centavos, esperado=${amountCents}` });
    } catch (e) {
      q.failCreate.run(`test-${id}:failed:${Date.now()}`, json(['PEDIDO DE TESTE', `falha: ${e.message}`]), nowIso(), id);
      throw new OrderError('gateway_error', `Adex recusou o Pix de teste: ${e.message}${e.detail ? ' ' + JSON.stringify(e.detail).slice(0, 300) : ''}`, 502);
    }
    q.setGateway.run(pix.transactionId, pix.code, pix.expiresAt, nowIso(), id);
    return { orderId: id, gatewayId: pix.transactionId, amountCents, pixCode: pix.code, expiresAt: pix.expiresAt };
  }

  async function sendPurchase(orderId) {
    const o = getOrder(orderId);
    if (!o || isTest(o.id) || o.status !== 'PAID' || o.capi_purchase_sent_at || !meta.enabled()) return;
    q.capiAttempt.run(o.id);
    const [first, ...rest] = o.customer.name.split(' ');
    const userData = buildUserData(
      {
        email: o.customer.email, phone: o.customer.phone, first_name: first, last_name: rest.join(' '),
        city: o.address.city, state: o.address.state, zip: o.address.zip, country: 'br',
      },
      { ip: o.client?.ip, userAgent: o.client?.user_agent, fbp: o.client?.fbp, fbc: o.client?.fbc },
    );
    const eventId = `purchase_${o.id}`;
    const res = await meta.send({
      eventName: 'Purchase',
      eventId,
      eventTime: Math.floor(new Date(o.paid_at).getTime() / 1000),
      sourceUrl: o.client?.source_url || undefined,
      userData,
      customData: {
        value: o.amount_cents / 100,
        currency: 'BRL',
        content_ids: o.items.map((i) => i.id),
        content_type: 'product',
        num_items: o.units_count,
        order_id: o.id,
      },
    });
    q.capiLog.run(nowIso(), o.id, 'Purchase', eventId, res.ok ? 1 : 0, JSON.stringify(res).slice(0, 2000));
    if (res.ok) q.capiSent.run(nowIso(), o.id);
    else log.warn?.('[meta-capi] Purchase falhou', o.id, res.status || res.error);
  }

  async function afterPaid(orderId) {
    await sendPurchase(orderId).catch((e) => log.error?.('[meta-capi] erro', e.message));
    const o = getOrder(orderId);
    if (o && !isTest(o.id) && utmify.enabled() && !o.utmify_paid_sent_at) {
      const r = await utmify.sendOrder(o, 'paid');
      if (r.ok) q.utmifyPaid.run(nowIso(), o.id);
      else log.warn?.('[utmify] paid falhou', o.id, r.status || r.error);
    }
  }

  // Aplica um status confirmado (consulta autenticada à Adex) ao pedido. Idempotente.
  async function applyStatus(order, mapped) {
    if (!order) return null;
    if (mapped === 'PAID') {
      const res = q.markPaid.run(nowIso(), nowIso(), order.id);
      if (res.changes === 1) {
        log.info?.('[order] pago', order.id);
        await afterPaid(order.id);
      } else {
        // reenvio de notificação / consulta repetida: só garante efeitos pendentes
        await afterPaid(order.id);
      }
    } else if (mapped === 'FAILED' && order.status === 'PENDING') {
      q.setStatus.run('FAILED', nowIso(), order.id);
    } else if (mapped === 'CHARGEBACK' && order.status !== 'CHARGEBACK') {
      q.setStatus.run('CHARGEBACK', nowIso(), order.id);
    }
    return getOrder(order.id);
  }

  async function refreshFromGateway(order) {
    if (!order.gateway_id || config.adex.mock) return order;
    const tx = await adex.getTransaction(order.gateway_id);
    if (!tx) return order;
    return applyStatus(order, mapAdexStatus(tx.status));
  }

  // Consulta do navegador (a cada ~5 s). Não dispara mais de 1 consulta por pedido a cada 3 s.
  async function checkStatus({ orderId, gatewayId }) {
    const order = getOrder(String(orderId || ''));
    if (!order || order.gateway_id !== String(gatewayId || '')) return null;
    if (order.status === 'PAID') return { status: 'PAID' };
    const last = lastPoll.get(order.id) || 0;
    let current = order;
    if (Date.now() - last > 3000) {
      lastPoll.set(order.id, Date.now());
      try {
        current = (await refreshFromGateway(order)) || order;
      } catch (e) {
        log.warn?.('[order] consulta à Adex falhou', order.id, e.message);
      }
    }
    return { status: current.status === 'PAID' ? 'PAID' : current.status === 'FAILED' ? 'FAILED' : current.status === 'CHARGEBACK' ? 'CHARGEBACK' : 'PENDING' };
  }

  // Webhook da Adex: o corpo nunca decide sozinho; sempre reconsulta a transação.
  async function handleWebhook({ rawBody, body, signatureValid }) {
    const key = crypto.createHash('sha256').update(rawBody || JSON.stringify(body || {})).digest('hex');
    const transactionId = body?.data?.transaction_id || body?.data?.id || null;
    let processedBefore = false;
    try {
      db.prepare('INSERT INTO webhook_events (dedupe_key, received_at, event, transaction_id, signature_valid, payload) VALUES (?, ?, ?, ?, ?, ?)')
        .run(key, nowIso(), body?.event || null, transactionId, signatureValid === null ? null : signatureValid ? 1 : 0, (rawBody || '').slice(0, 20_000));
    } catch (e) {
      if (!/UNIQUE/i.test(String(e.message))) throw e;
      processedBefore = true; // notificação reenviada; o processamento abaixo é idempotente
    }
    if (!transactionId) return { ok: true, ignored: 'sem transaction_id' };
    const order = rowToOrder(q.byGateway.get(String(transactionId)));
    if (!order) return { ok: true, ignored: 'pedido não encontrado' };
    if (order.status === 'PAID' && order.capi_purchase_sent_at && (!utmify.enabled() || order.utmify_paid_sent_at)) {
      return { ok: true, duplicate: processedBefore };
    }
    const updated = await refreshFromGateway(order);
    return { ok: true, duplicate: processedBefore, status: updated?.status };
  }

  // Reenvia efeitos que falharam (CAPI/UTMify) para pedidos pagos nas últimas 24 h.
  async function retryPendingEffects() {
    const since = new Date(Date.now() - 24 * 3600_000).toISOString();
    for (const { id } of q.pendingCapi.all(since)) await sendPurchase(id).catch(() => {});
    if (utmify.enabled()) {
      for (const { id } of q.pendingUtmifyPaid.all(since)) {
        const o = getOrder(id);
        const r = await utmify.sendOrder(o, 'paid');
        if (r.ok) q.utmifyPaid.run(nowIso(), id);
      }
    }
  }

  // Só no modo ADEX_MOCK: simula a confirmação do pagamento.
  async function simulatePaid(orderId) {
    if (!config.adex.mock) throw new OrderError('forbidden', 'Disponível apenas com ADEX_MOCK=true', 403);
    const o = getOrder(orderId);
    if (!o) throw new OrderError('not_found', 'Pedido não encontrado', 404);
    return applyStatus(o, 'PAID');
  }

  function listOrders({ limit = 100, status } = {}) {
    const rows = status
      ? db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
      : db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit);
    return rows.map(rowToOrder);
  }

  return { createOrder, createTestPix, checkStatus, handleWebhook, retryPendingEffects, simulatePaid, getOrder, listOrders, describeUnit };
}
