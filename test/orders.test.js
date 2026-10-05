import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, checkoutBody, unit, sign, P1, P2, pix5 } from './helpers.js';

test('cria pedido Pix, grava personalização de cada unidade e envia ao Adex o valor correto', async () => {
  const t = await startTestApp();
  try {
    const body = checkoutBody({
      units: [unit(), unit({ view: 'rear', category: 'sedan', brand: 'Volkswagen', model: 'Voyage G6', year: '2015', color: 'Prata', plateName: 'MARIA' })],
      shippingCents: 1939,
      couponCode: 'PRIME10',
    });
    const r = await t.post('/api/public/create-payment', body);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'PENDING');
    assert.match(r.json.orderId, /^GC[A-Z0-9]+$/);
    assert.equal(r.json.gatewayId, 'tx-1');
    assert.ok(r.json.pix.url.startsWith('0002'));

    // Adex recebeu: preço de 2 un + SEDEX - Pix 5% - cupom 10%, em reais, external_id e postback do NOVO domínio
    const total2 = P2 + 1939 - pix5(P2) - Math.round(P2 * 0.1);
    const sent = t.calls.adexCreate[0].body;
    assert.equal(sent.amount, Number((total2 / 100).toFixed(2)));
    assert.equal(sent.external_id, r.json.orderId);
    assert.equal(sent.postbackUrl, 'https://novo-dominio.test/api/webhooks/adex');
    assert.equal(sent.customer.document.type, 'cpf');
    assert.equal(t.calls.adexCreate[0].headers['x-public-key'], 'pk_test');

    const o = t.orders.getOrder(r.json.orderId);
    assert.equal(o.amount_cents, total2);
    assert.equal(o.units_count, 2);
    assert.equal(o.personalization_complete, true);
    assert.deepEqual(o.units.map((u) => [u.n, u.side, u.brand, u.model, u.year, u.color, u.plate_name]), [
      [1, 'Frente', 'Toyota', 'Hilux 8ª geração', '2022', 'Preto', 'JOAO'],
      [2, 'Traseira', 'Volkswagen', 'Voyage G6', '2015', 'Prata', 'MARIA'],
    ]);
    assert.equal(o.shipping_method, 'sedex');
    assert.equal(o.tracking.utm_source, 'fb');
    assert.equal(o.client.fbc.startsWith('fb.1.'), true);
    assert.deepEqual(o.warnings, []);
  } finally {
    await t.close();
  }
});

test('mesma tentativa (duplo clique/reenvio) não duplica pedido nem cobrança', async () => {
  const t = await startTestApp();
  try {
    const body = checkoutBody();
    const [a, b] = await Promise.all([t.post('/api/public/create-payment', body), t.post('/api/public/create-payment', body)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.json.orderId, b.json.orderId);
    const again = await t.post('/api/public/create-payment', body);
    assert.equal(again.json.orderId, a.json.orderId);
    assert.equal(t.calls.adexCreate.length, 1);
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM orders').get().n, 1);
  } finally {
    await t.close();
  }
});

test('rejeita valor adulterado, cupom inválido, documento inválido e cartão', async () => {
  const t = await startTestApp();
  try {
    let r = await t.post('/api/public/create-payment', checkoutBody({ amount: 100 }));
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'price_changed');
    r = await t.post('/api/public/create-payment', checkoutBody({ couponCode: 'FAKE50' }));
    assert.equal(r.json.code, 'bad_coupon');
    const bad = checkoutBody();
    bad.customer.document = '111.111.111-11';
    r = await t.post('/api/public/create-payment', bad);
    assert.equal(r.json.code, 'bad_document');
    const card = checkoutBody();
    card.paymentMethod = 'CREDIT_CARD';
    r = await t.post('/api/public/create-payment', card);
    assert.equal(r.json.code, 'payment_method_unavailable');
    assert.equal(t.calls.adexCreate.length, 0);
  } finally {
    await t.close();
  }
});

test('recusa a cobrança se o valor embutido no Pix divergir do pedido (reais x centavos)', async () => {
  const t = await startTestApp();
  try {
    t.adexState.amountMultiplier = 100; // simula a Adex interpretando "reais" como centavos
    const r = await t.post('/api/public/create-payment', checkoutBody());
    assert.equal(r.status, 502);
    assert.equal(r.json.code, 'gateway_error');
    // tentativa pode ser refeita depois de corrigir a configuração
    t.adexState.amountMultiplier = 1;
    const retry = await t.post('/api/public/create-payment', checkoutBody());
    assert.equal(retry.status, 200);
  } finally {
    await t.close();
  }
});

test('webhook: assinatura inválida é rejeitada; válido confirma, e reenvio não duplica Purchase/UTMify', async () => {
  const t = await startTestApp();
  try {
    const created = (await t.post('/api/public/create-payment', checkoutBody())).json;
    assert.equal(t.calls.meta.length, 0);

    const payload = JSON.stringify({ event: 'pix.paid', data: { transaction_id: created.gatewayId } });
    let r = await t.post('/api/webhooks/adex', null, { 'x-webhook-signature': sign(payload, 'chave-errada') }, payload);
    assert.equal(r.status, 401);

    t.adexState.status = 'pending';
    r = await t.post('/api/webhooks/adex', null, { 'x-webhook-signature': sign(payload) }, payload);
    assert.equal(r.status, 200);
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(t.orders.getOrder(created.orderId).status, 'PENDING'); // o corpo nunca decide: a consulta diz pendente
    assert.equal(t.calls.meta.length, 0);

    t.adexState.status = 'paid';
    for (let i = 0; i < 3; i++) {
      r = await t.post('/api/webhooks/adex', null, { 'x-webhook-signature': sign(payload) }, payload);
      assert.equal(r.status, 200);
      await new Promise((res) => setTimeout(res, 80));
    }
    const o = t.orders.getOrder(created.orderId);
    assert.equal(o.status, 'PAID');
    assert.ok(o.paid_at);

    const purchases = t.calls.meta.filter((c) => c.body.data[0].event_name === 'Purchase');
    assert.equal(purchases.length, 1, 'Purchase enviado uma única vez');
    const ev = purchases[0].body.data[0];
    assert.equal(ev.event_id, `purchase_${created.orderId}`);
    assert.equal(ev.custom_data.value, (P1 - pix5(P1)) / 100);
    assert.equal(ev.custom_data.currency, 'BRL');
    assert.equal(ev.custom_data.order_id, created.orderId);
    assert.equal(ev.action_source, 'website');
    assert.match(ev.user_data.em[0], /^[0-9a-f]{64}$/);
    assert.match(purchases[0].url, /\/111222333444555\/events\?/); // pixel NOVO
    assert.equal(t.calls.utmify.filter((u) => u.status === 'paid').length, 1);
    assert.equal(t.calls.utmify.filter((u) => u.status === 'waiting_payment').length, 1);
  } finally {
    await t.close();
  }
});

test('consulta do navegador confirma o pagamento e o navegador não consegue forjar Purchase na API de Conversões', async () => {
  const t = await startTestApp();
  try {
    const created = (await t.post('/api/public/create-payment', checkoutBody())).json;
    let r = await t.post('/api/public/check-payment-status', { orderId: created.orderId, gatewayId: created.gatewayId });
    assert.deepEqual(r.json, { status: 'PENDING' });
    r = await t.post('/api/public/check-payment-status', { orderId: created.orderId, gatewayId: 'outro' });
    assert.equal(r.status, 404);

    // Purchase vindo do navegador é ignorado; outros eventos são repassados com o mesmo event_id
    await t.post('/api/public/meta-capi', { event_name: 'Purchase', event_id: 'x1', user_data: {}, custom_data: { value: 1 } });
    await t.post('/api/public/meta-capi', { event_name: 'AddToCart', event_id: 'ev-123', event_source_url: 'https://novo-dominio.test/produto/gelacar?fbclid=abc', user_data: { email: 'A@b.com' }, custom_data: { value: P1 / 100, currency: 'BRL' } });
    assert.equal(t.calls.meta.length, 1);
    const ev = t.calls.meta[0].body.data[0];
    assert.equal(ev.event_name, 'AddToCart');
    assert.equal(ev.event_id, 'ev-123');
    assert.equal(ev.user_data.fbc.startsWith('fb.1.'), true);
    assert.notEqual(ev.user_data.em[0], 'a@b.com'); // hasheado

    t.adexState.status = 'paid';
    await new Promise((res) => setTimeout(res, 3100)); // intervalo mínimo entre consultas por pedido
    r = await t.post('/api/public/check-payment-status', { orderId: created.orderId, gatewayId: created.gatewayId });
    assert.deepEqual(r.json, { status: 'PAID' });
    r = await t.post('/api/public/check-payment-status', { orderId: created.orderId, gatewayId: created.gatewayId });
    assert.deepEqual(r.json, { status: 'PAID' });
    assert.equal(t.calls.meta.filter((c) => c.body.data[0].event_name === 'Purchase').length, 1);
  } finally {
    await t.close();
  }
});

test('personalização incompleta/faltando gera aviso no pedido (nada é inventado)', async () => {
  const t = await startTestApp();
  try {
    const body = checkoutBody({ units: [unit(), unit({ model: 'Voyage G6' })] });
    body.items[0].personalization = [body.items[0].personalization[0]]; // só 1 de 2 unidades
    const r = await t.post('/api/public/create-payment', body);
    assert.equal(r.status, 200);
    const o = t.orders.getOrder(r.json.orderId);
    assert.equal(o.personalization_complete, false);
    assert.equal(o.units.length, 2);
    assert.equal(o.units[1].complete, false);
    assert.ok(o.warnings.some((w) => /esperadas 2/.test(w)));
  } finally {
    await t.close();
  }
});

test('painel de pedidos exige token', async () => {
  const t = await startTestApp();
  try {
    await t.post('/api/public/create-payment', checkoutBody());
    assert.equal((await fetch(`${t.base}/api/admin/orders`)).status, 401);
    const ok = await fetch(`${t.base}/api/admin/orders`, { headers: { authorization: 'Bearer admin_test' } });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).length, 1);
    const page = await fetch(`${t.base}/admin/pedidos?token=admin_test`);
    assert.match(await page.text(), /Toyota Hilux 8ª geração 2022/);
  } finally {
    await t.close();
  }
});

test('Pix de teste: exige token, valida valor, cria na Adex e NÃO dispara Meta/UTMify ao ser pago', async () => {
  const t = await startTestApp();
  try {
    assert.equal((await t.post('/api/admin/test-pix', { amountCents: 100 })).status, 401);
    const auth = { authorization: 'Bearer admin_test' };
    assert.equal((await t.post('/api/admin/test-pix', { amountCents: 50 }, auth)).status, 400);
    const r = await t.post('/api/admin/test-pix', { amountCents: 100 }, auth);
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.orderId, /^GCTEST/);
    assert.equal(t.calls.adexCreate[0].body.amount, 1);
    t.adexState.status = 'paid';
    const payload = JSON.stringify({ event: 'pix.paid', data: { transaction_id: r.json.gatewayId } });
    await t.post('/api/webhooks/adex', null, { 'x-webhook-signature': sign(payload) }, payload);
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(t.orders.getOrder(r.json.orderId).status, 'PAID');
    assert.equal(t.calls.meta.length, 0);
    assert.equal(t.calls.utmify.length, 0);
  } finally {
    await t.close();
  }
});
