import crypto from 'node:crypto';

const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const norm = (v) =>
  String(v ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const digits = (v) => String(v ?? '').replace(/\D/g, '');

// Dados do cliente no formato exigido pela API de Conversões (campos hasheados em SHA-256).
export function buildUserData(raw = {}, ctx = {}) {
  const u = {};
  const email = norm(raw.email);
  if (email) u.em = [sha(email)];
  let phone = digits(raw.phone);
  if (phone) {
    if (phone.length <= 11) phone = `55${phone}`;
    u.ph = [sha(phone)];
  }
  const fn = norm(raw.first_name ?? raw.fn);
  if (fn) u.fn = [sha(fn)];
  const ln = norm(raw.last_name ?? raw.ln);
  if (ln) u.ln = [sha(ln)];
  const ct = norm(raw.city).replace(/[^a-z]/g, '');
  if (ct) u.ct = [sha(ct)];
  const st = norm(raw.state).replace(/[^a-z]/g, '');
  if (st) u.st = [sha(st)];
  const zp = digits(raw.zip);
  if (zp) u.zp = [sha(zp.slice(0, 8))];
  u.country = [sha(norm(raw.country || 'br'))];
  if (raw.external_id) u.external_id = [sha(raw.external_id)];
  const fbp = raw.fbp || ctx.fbp;
  const fbc = raw.fbc || ctx.fbc;
  if (fbp) u.fbp = fbp;
  if (fbc) u.fbc = fbc;
  const ip = ctx.ip || raw.client_ip_address;
  if (ip) u.client_ip_address = ip;
  const ua = ctx.userAgent || raw.client_user_agent;
  if (ua) u.client_user_agent = ua;
  return u;
}

export function fbcFromClickId(fbclid, ts = Date.now()) {
  return fbclid ? `fb.1.${ts}.${fbclid}` : undefined;
}

export function createMetaClient(cfg, { fetchImpl = fetch } = {}) {
  const enabled = () => !!(cfg.pixelId && cfg.capiToken);
  return {
    enabled,
    // Envia UM evento. Retorna { ok, status, body }.
    async send({ eventName, eventId, eventTime, sourceUrl, userData, customData }) {
      if (!enabled()) return { ok: false, skipped: true };
      const payload = {
        data: [
          {
            event_name: eventName,
            event_time: eventTime ?? Math.floor(Date.now() / 1000),
            event_id: eventId,
            event_source_url: sourceUrl,
            action_source: 'website',
            user_data: userData,
            custom_data: customData,
          },
        ],
      };
      if (cfg.testEventCode) payload.test_event_code = cfg.testEventCode;
      const url = `https://graph.facebook.com/${cfg.graphVersion}/${encodeURIComponent(cfg.pixelId)}/events?access_token=${encodeURIComponent(cfg.capiToken)}`;
      try {
        const r = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        });
        const body = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, body };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };
}
