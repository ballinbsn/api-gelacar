import { findProduct } from './catalog.js';

// Regras idênticas às do site de referência (carrinho + checkout), recalculadas no servidor.
export const SHIPPING = {
  correios: { cents: 0, label: 'Frete grátis via Correios' },
  sedex: { cents: 1939, label: 'Entrega Full via SEDEX' },
};
export const PIX_DISCOUNT_PCT = 5;
export const COUPONS = { PRIME10: { pct: 10 } };
export const GIFT_WRAP_CENTS = 500;

// Preço do kit: 1 un = preço; 2 un = 1,8x; 3 un = 2,5x (função Bh do carrinho original).
export function kitPrice(base, qty) {
  return qty >= 3 ? Math.round(base * 2.5) : qty === 2 ? Math.round(base * 1.8) : base;
}

export class OrderError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function shippingMethodFromCents(cents) {
  const hit = Object.entries(SHIPPING).find(([, v]) => v.cents === Number(cents));
  return hit ? hit[0] : null;
}

// Retorna os valores calculados a partir do catálogo do servidor (nunca confia no preço do navegador).
export function priceOrder({ items, shippingCents, couponCode, giftWrapCents }) {
  if (!Array.isArray(items) || items.length === 0) throw new OrderError('empty_cart', 'Sua sacola está vazia');
  if (items.length > 10) throw new OrderError('too_many_items', 'Itens demais no pedido');

  const lines = [];
  let subtotal = 0;
  for (const it of items) {
    const product = findProduct({ id: it?.id, slug: it?.slug });
    if (!product) throw new OrderError('unknown_product', 'Produto indisponível');
    const quantity = Math.floor(Number(it.quantity) || 0);
    const kitQty = Math.floor(Number(it.kitQty) || 1);
    if (quantity < 1 || quantity > 10) throw new OrderError('bad_quantity', 'Quantidade inválida');
    if (kitQty < 1 || kitQty > 3) throw new OrderError('bad_quantity', 'Quantidade inválida');
    const unitPrice = kitQty > 1 ? kitPrice(product.price, kitQty) : product.price;
    const units = kitQty > 1 ? kitQty * quantity : quantity;
    subtotal += unitPrice * quantity;
    lines.push({ product, quantity, kitQty, unitPrice, units });
  }

  const shipMethod = shippingMethodFromCents(shippingCents ?? 0);
  if (!shipMethod) throw new OrderError('bad_shipping', 'Frete inválido');
  const shipping = SHIPPING[shipMethod].cents;

  const gift = Number(giftWrapCents) > 0 ? GIFT_WRAP_CENTS : 0;
  if (Number(giftWrapCents) > 0 && Number(giftWrapCents) !== GIFT_WRAP_CENTS) throw new OrderError('bad_gift', 'Valor do embrulho inválido');

  const pixDiscount = Math.round((subtotal * PIX_DISCOUNT_PCT) / 100);

  let coupon = null;
  let couponDiscount = 0;
  if (couponCode) {
    const code = String(couponCode).replace(/\s+/g, '').toUpperCase();
    if (!COUPONS[code]) throw new OrderError('bad_coupon', 'Cupom inválido');
    coupon = code;
    couponDiscount = Math.min(subtotal, Math.round((subtotal * COUPONS[code].pct) / 100));
  }

  const total = subtotal + gift + shipping - pixDiscount - couponDiscount;
  return {
    lines,
    unitsCount: lines.reduce((n, l) => n + l.units, 0),
    subtotal,
    shipping,
    shippingMethod: shipMethod,
    gift,
    pixDiscount,
    coupon,
    couponDiscount,
    total,
  };
}
