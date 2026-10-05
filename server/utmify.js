// Envio server-side de pedidos para a UTMify (opcional: só roda com UTMIFY_API_TOKEN).
// "waiting_payment" quando o Pix é gerado e "paid" quando a Adex confirma — mesmo orderId.
const ORDERS_URL = 'https://api.utmify.com.br/api-credentials/orders';
const fmt = (d) => new Date(d).toISOString().slice(0, 19).replace('T', ' ');

export function createUtmifyClient(cfg, { fetchImpl = fetch } = {}) {
  const enabled = () => !!cfg.apiToken;
  return {
    enabled,
    async sendOrder(order, status) {
      if (!enabled()) return { ok: false, skipped: true };
      const t = order.tracking || {};
      const payload = {
        orderId: order.id,
        platform: cfg.platform || 'Adex',
        paymentMethod: 'pix',
        status,
        createdAt: fmt(order.created_at),
        approvedDate: status === 'paid' ? fmt(order.paid_at || Date.now()) : null,
        refundedAt: null,
        customer: {
          name: order.customer.name,
          email: order.customer.email,
          phone: order.customer.phone || null,
          document: order.customer.document || null,
          country: 'BR',
          ip: order.client?.ip || null,
        },
        products: order.items.map((i) => ({
          id: i.id,
          name: i.title,
          planId: null,
          planName: null,
          quantity: i.quantity,
          priceInCents: i.unitPriceCents,
        })),
        trackingParameters: {
          src: t.src || null,
          sck: t.sck || null,
          utm_source: t.utm_source || null,
          utm_campaign: t.utm_campaign || null,
          utm_medium: t.utm_medium || null,
          utm_content: t.utm_content || null,
          utm_term: t.utm_term || null,
        },
        commission: {
          totalPriceInCents: order.amount_cents,
          gatewayFeeInCents: 0,
          userCommissionInCents: order.amount_cents,
          currency: 'BRL',
        },
        isTest: false,
      };
      try {
        const r = await fetchImpl(ORDERS_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-token': cfg.apiToken },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        return { ok: r.ok, status: r.status };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };
}
