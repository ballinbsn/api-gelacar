# api-gelacar — API de checkout do GelaCar (Meta Ads)

Backend do funil GelaCar: pedidos (com a personalização de cada unidade), Pix pela Adex, webhook, Pixel/API de Conversões da Meta e UTMify opcional.
O site (páginas) fica em outro lugar e chama esta API (`apiBase` no `config.js` do site).

## Railway
1. New Project → Deploy from GitHub repo (`api-gelacar`). Node ≥ 24 (já definido em `package.json`).
2. **Volume**: adicione um Volume montado em `/data` e crie a variável `DATA_DIR=/data` (o banco é SQLite em arquivo; sem volume os pedidos somem a cada deploy).
3. Variáveis (veja `.env.example`): `ADEX_PUBLIC_KEY`, `ADEX_SECRET_KEY`, `ADEX_BASE_URL=https://api.adex.cash/functions/v1`, `ADEX_AMOUNT_UNIT=reais`,
   `PUBLIC_URL` (domínio desta API), `ADMIN_TOKEN`, `META_PIXEL_ID`, `META_CAPI_TOKEN`, `UTMIFY_API_TOKEN` (opcional).
   **Não** crie `ADEX_MOCK` nem `DEBUG_FBQ_STUB`.
4. Adex: webhook apontando para `https://<DOMINIO_DA_API>/api/webhooks/adex` (evento de pagamento confirmado).
5. Conferir: `https://<DOMINIO_DA_API>/health` → `{"ok":true}`; compra de teste de baixo valor; pedido em `/admin/pedidos?token=<ADMIN_TOKEN>`.

## Rotas
`POST /api/public/create-payment` · `POST /api/public/check-payment-status` · `POST /api/webhooks/adex` · `POST /api/public/meta-capi` · `GET /health` · `GET /admin/pedidos` · `GET /api/admin/orders`

## Testes
`npm install && npm test` (18 testes; nenhuma chamada real de rede).

## Foto de referência do carro (opcional)
`POST /api/public/upload-photo` (corpo = imagem JPEG/PNG/WEBP, até 4 MB; conteúdo conferido, 15 envios/hora por IP) grava em `DATA_DIR/uploads`
(volume do Railway) e devolve `{ id, url }`. A foto é ligada ao pedido na criação (`photo_id`/`photo_url` na unidade) e o título do item na Adex leva `foto:<id>`.
Para ver: `https://<DOMINIO_DA_API>/f/<id>`. Fotos nunca ligadas a um pedido são apagadas após 7 dias.
