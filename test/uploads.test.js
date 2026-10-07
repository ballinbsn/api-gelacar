import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, checkoutBody, unit } from './helpers.js';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(50, 3)]);

const send = (base, body, type) => fetch(`${base}/api/public/upload-photo`, { method: 'POST', headers: { 'content-type': type }, body });

test('upload: aceita JPEG/PNG/WEBP pelo conteúdo, serve de volta e recusa o resto', async () => {
  const t = await startTestApp();
  try {
    for (const [buf, type] of [[JPEG, 'image/jpeg'], [PNG, 'image/png'], [WEBP, 'image/webp']]) {
      const r = await send(t.base, buf, type);
      assert.equal(r.status, 200);
      const j = await r.json();
      assert.match(j.id, /^[a-f0-9]{12}$/);
      assert.ok(j.url.endsWith(`/f/${j.id}`));
      const back = await fetch(`${t.base}/f/${j.id}`);
      assert.equal(back.status, 200);
      assert.equal(back.headers.get('content-type'), type);
      assert.equal(back.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(Buffer.from(await back.arrayBuffer()).equals(buf));
    }
    // texto disfarçado de imagem
    assert.equal((await send(t.base, Buffer.from('<script>alert(1)</script>'), 'image/jpeg')).status, 415);
    // tipo não permitido
    assert.equal((await send(t.base, JPEG, 'application/pdf')).status, 415);
    // grande demais
    const big = await send(t.base, Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]), 'image/jpeg');
    assert.equal(big.status, 413);
    // id inexistente / mal formado
    assert.equal((await fetch(`${t.base}/f/000000000000`)).status, 404);
    assert.equal((await fetch(`${t.base}/f/../../etc/passwd`)).status, 404);
  } finally {
    await t.close();
  }
});

test('pedido: foto fica ligada à unidade, aparece no título da Adex e não pode ser reaproveitada', async () => {
  const t = await startTestApp();
  try {
    const up = await (await send(t.base, JPEG, 'image/jpeg')).json();
    const body = checkoutBody({ units: [unit({ photo: { id: up.id, url: up.url } })] });
    const r = await t.post('/api/public/create-payment', body);
    assert.equal(r.status, 200, r.text);
    const o = t.orders.getOrder(r.json.orderId);
    assert.equal(o.units[0].photo_id, up.id);
    assert.ok(o.units[0].photo_url.endsWith(`/f/${up.id}`));
    assert.ok(t.calls.adexCreate[0].body.items[0].title.includes(`foto:${up.id}`));
    assert.equal(t.db.prepare('SELECT order_id FROM uploads WHERE id = ?').get(up.id).order_id, r.json.orderId);
    // segundo pedido tentando usar a mesma foto
    const again = await t.post('/api/public/create-payment', checkoutBody({ units: [unit({ photo: { id: up.id } })] }));
    const o2 = t.orders.getOrder(again.json.orderId);
    assert.equal(o2.units[0].photo_id, null);
    assert.ok(o2.warnings.some((w) => /já usada/.test(w)));
    // id inventado
    const fake = await t.post('/api/public/create-payment', checkoutBody({ units: [unit({ photo: { id: 'abcdefabcdef' } })] }));
    assert.ok(t.orders.getOrder(fake.json.orderId).warnings.some((w) => /inválida/.test(w)));
  } finally {
    await t.close();
  }
});

test('personalização nova: ano opcional e cor "Outra" com texto livre', async () => {
  const t = await startTestApp();
  try {
    const body = checkoutBody({ units: [unit({ year: '', color: 'Outra', colorOther: 'Azul petróleo' })] });
    const r = await t.post('/api/public/create-payment', body);
    assert.equal(r.status, 200, r.text);
    const o = t.orders.getOrder(r.json.orderId);
    assert.equal(o.units[0].color, 'Azul petróleo');
    assert.equal(o.units[0].color_choice, 'Outra');
    assert.equal(o.units[0].year, '');
    assert.equal(o.units[0].complete, true);
    assert.equal(o.personalization_complete, true);
    assert.ok(t.calls.adexCreate[0].body.items[0].title.includes('Azul petróleo Frente placa JOAO'));
  } finally {
    await t.close();
  }
});
