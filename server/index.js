import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app } = createApp({ config });

app.listen(config.port, () => {
  console.log(`GelaCar v2 rodando na porta ${config.port}`);
  const warn = (m) => console.warn(`⚠️  ${m}`);
  if (config.adex.mock) warn('ADEX_MOCK=true: pagamentos são SIMULADOS (nada é cobrado). Não use em produção.');
  else if (!config.adex.publicKey || !config.adex.secretKey) warn('ADEX_PUBLIC_KEY / ADEX_SECRET_KEY não configuradas: o checkout não conseguirá gerar Pix.');
  if (!config.adex.webhookUrl && !config.adex.mock) warn('Defina SITE_URL (ou ADEX_WEBHOOK_URL): a Adex precisa de uma URL pública para avisar os pagamentos.');
  if (!config.meta.pixelId) warn('META_PIXEL_ID não configurado: o Pixel da Meta não será carregado.');
  else if (!config.meta.capiToken) warn('META_CAPI_TOKEN não configurado: a API de Conversões (e o Purchase do servidor) ficará desligada.');
  if (!config.adminToken) warn('ADMIN_TOKEN não configurado: o painel /admin/pedidos fica desativado.');
});
