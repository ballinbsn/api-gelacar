// Toda a configuração vem do ambiente (.env). Nada daqui é herdado da operação original.
const bool = (v, d) => (v === undefined || v === '' ? d : /^(1|true|yes|sim)$/i.test(String(v)));
const str = (v) => (v === undefined ? '' : String(v).trim());
const withProto = (v) => (v && !/^https?:\/\//i.test(v) ? `https://${v}` : v);

export function loadConfig(env = process.env) {
  const siteUrl = str(env.SITE_URL).replace(/\/+$/, '');
  // Nomes do template Adex/Railway: PUBLIC_URL = endereço público da API; FUNNEL_URL = domínio do site (páginas).
  const publicUrl = withProto(str(env.PUBLIC_URL)).replace(/\/+$/, '') || siteUrl;
  return {
    port: Number(env.PORT) || 3000,
    // URL pública do novo domínio. Vazia = deduzida de cada requisição (útil em testes locais).
    siteUrl,
    // true = JS/CSS com cache de 1 ano (só ative se nunca mais reconstruir public/ com o mesmo nome de arquivo)
    assetsImmutable: bool(env.ASSETS_IMMUTABLE, false),
    // Domínio do site estático que chama esta API (ex.: https://seudominio.com.br). Vazio = só mesma origem.
    corsOrigin: withProto(str(env.CORS_ORIGIN)).replace(/\/+$/, ''),
    dataDir: str(env.DATA_DIR) || './data',
    adminToken: str(env.ADMIN_TOKEN),

    adex: {
      publicKey: str(env.ADEX_PUBLIC_KEY),
      secretKey: str(env.ADEX_SECRET_KEY),
      baseUrl: str(env.ADEX_BASE_URL) || 'https://api.adex.cash/functions/v1',
      // URL que a Adex chama quando o Pix muda de status. Por padrão: SITE_URL + /api/webhooks/adex
      webhookUrl: str(env.ADEX_WEBHOOK_URL) || (publicUrl ? `${publicUrl}/api/webhooks/adex` : ''),
      // Segredo do webhook, se a Adex mostrar um separado; vazio = usa a secret key.
      webhookSecret: str(env.ADEX_WEBHOOK_SECRET),
      // A documentação da Adex é ambígua (reais x centavos). Padrão = reais, como no projeto da Bíblia.
      amountUnit: str(env.ADEX_AMOUNT_UNIT) === 'cents' ? 'cents' : 'reais',
      // Confere o valor embutido no Pix (campo 54 do EMV) antes de mostrar o QR ao cliente.
      verifyEmv: bool(env.ADEX_VERIFY_EMV, true),
      // Modo de teste local: NÃO chama a Adex; gera um Pix fictício e permite simular o pagamento.
      mock: bool(env.ADEX_MOCK, false),
    },

    meta: {
      pixelId: str(env.META_PIXEL_ID),
      capiToken: str(env.META_CAPI_TOKEN),
      testEventCode: str(env.META_TEST_EVENT_CODE),
      graphVersion: str(env.META_GRAPH_VERSION) || 'v21.0',
    },

    utmify: {
      pixelId: str(env.UTMIFY_PIXEL_ID), // pixel do navegador (script da UTMify)
      apiToken: str(env.UTMIFY_API_TOKEN), // envio server-side de pedidos (opcional)
      platform: str(env.UTMIFY_PLATFORM) || 'Adex',
    },

    debug: {
      // SÓ PARA TESTES: registra as chamadas do Pixel em window.__fbqLog em vez de carregar o fbevents.js.
      fbqStub: bool(env.DEBUG_FBQ_STUB, false),
    },

    checkout: {
      // O fluxo Adex implementado é Pix. Cartão fica oculto até existir integração própria.
      cardEnabled: bool(env.CARD_ENABLED, false),
    },
  };
}
