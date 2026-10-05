import crypto from 'node:crypto';

const PAID = new Set(['paid', 'pago', 'aprovado', 'approved', 'completed', 'concluido', 'concluído']);
const FAILED = new Set(['failed', 'expired', 'cancelled', 'canceled', 'expirado', 'cancelado', 'refused', 'recusado']);
const REFUNDED = new Set(['refunded', 'chargeback', 'reembolsado', 'estornado']);

// Status da Adex → status usado pelo site (PENDING | PAID | FAILED | CHARGEBACK).
export function mapAdexStatus(status) {
  const s = String(status || '').toLowerCase();
  if (PAID.has(s)) return 'PAID';
  if (REFUNDED.has(s)) return 'CHARGEBACK';
  if (FAILED.has(s)) return 'FAILED';
  return 'PENDING';
}

export function createAdexClient(cfg, { fetchImpl = fetch } = {}) {
  const headers = () => ({
    'x-public-key': cfg.publicKey,
    'x-secret-key': cfg.secretKey,
    'Content-Type': 'application/json',
  });
  const configured = () => !!(cfg.publicKey && cfg.secretKey);

  return {
    configured,

    // Cria a cobrança Pix. `amountCents` é o valor final cobrado.
    async createPix({ orderId, amountCents, customer, address, title, document }) {
      const amount = cfg.amountUnit === 'cents' ? amountCents : Number((amountCents / 100).toFixed(2));
      const r = await fetchImpl(`${cfg.baseUrl}/pix-receive`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({
          amount,
          paymentMethod: 'pix',
          customer: {
            name: customer.name,
            email: customer.email,
            phone: customer.phone,
            document: { number: document.number, type: document.type },
            address: {
              zip: address.zip,
              street: address.street,
              number: address.number,
              complement: address.complement,
              neighborhood: address.neighborhood,
              city: address.city,
              state: address.state,
            },
          },
          items: [{ title, unitPrice: amount, quantity: 1, tangible: true }],
          postbackUrl: cfg.webhookUrl || undefined,
          external_id: orderId,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      const body = await r.json().catch(() => ({}));
      const tx = body?.transaction;
      const pix = body?.pix;
      if (!r.ok || !body?.success || !tx?.id) {
        const err = new Error('gateway_error');
        err.detail = { httpStatus: r.status, body };
        throw err;
      }
      return {
        transactionId: String(tx.id),
        status: tx.status,
        code: pix?.qrCode || pix?.copyPaste || null,
        expiresAt: pix?.expiresAt || null,
        raw: body,
      };
    },

    // Consulta autenticada (fonte da verdade). Recebe o UUID devolvido pela Adex na criação.
    async getTransaction(transactionId) {
      const r = await fetchImpl(`${cfg.baseUrl}/pix-receive?transaction_id=${encodeURIComponent(transactionId)}`, {
        headers: headers(),
        signal: AbortSignal.timeout(10_000),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || !body?.transaction) return null;
      return body.transaction;
    },
  };
}

// Valida x-webhook-signature (sha256=<hex>, HMAC-SHA256 com a secret key). Aceita o corpo cru
// e, como reserva, o JSON re-serializado (formato do exemplo da documentação).
export function verifyAdexSignature({ header, secret, rawBody, parsedBody }) {
  if (!header || !secret) return false;
  const provided = Buffer.from(String(header).replace(/^sha256=/, ''), 'hex');
  const candidates = [];
  if (rawBody) candidates.push(rawBody);
  if (parsedBody !== undefined) candidates.push(JSON.stringify(parsedBody));
  return candidates.some((c) => {
    const expected = crypto.createHmac('sha256', secret).update(c).digest();
    return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
  });
}
