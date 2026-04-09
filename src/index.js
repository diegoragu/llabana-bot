require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const webhookHandler = require('./webhookHandler');
const shopifyWebhookHandler = require('./shopifyWebhookHandler');
const { getTranscripts } = require('./transcriptService');
const { invalidateCache } = require('./knowledgeService');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Shopify webhook — DEBE ir antes del bodyParser global ────────────────────
// Shopify requiere el raw body (Buffer) para verificar la firma HMAC.
// Al definir esta ruta antes de app.use(bodyParser.json()), Express aplica
// express.raw() a esta ruta antes de que el parser global intervenga.
app.post(
  '/webhook/shopify',
  express.raw({ type: 'application/json' }),
  shopifyWebhookHandler
);

// ── Parsers globales para el resto de rutas ──────────────────────────────────
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// ── Rutas ────────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'llabana-bot', timestamp: new Date().toISOString() });
});

app.post('/webhook/whatsapp', webhookHandler);

app.use('/dashboard', express.static(path.join(__dirname, '../public')));

app.get('/api/transcripts', async (req, res) => {
  try {
    const data = await getTranscripts();
    res.json(data);
  } catch (err) {
    console.error('[API] Error transcripts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const WA_LINKS = {
  'google':          '¡Hola! Los encontré en Google',
  'facebook':        '¡Hola! Los vi en Facebook',
  'web-header':      '¡Hola! Estoy en su página web',
  'web-footer':      '¡Hola! Los contacto desde su página',
  'web-chat':        '¡Hola! Me pasaron al WhatsApp desde el chat',
  'web-producto':    '¡Hola! Vi un producto en su página',
  'tienda-producto': '¡Hola! Vi un producto en la tienda en línea',
  'tienda-chat':     '¡Hola! Me pasaron al WhatsApp desde el chat de la tienda',
};

app.get('/wa/:origen', (req, res) => {
  const origen = req.params.origen.toLowerCase();
  const texto  = WA_LINKS[origen];
  if (!texto) {
    return res.status(404).json({ error: 'Link no encontrado' });
  }
  const encoded = encodeURIComponent(texto);
  const url = `https://wa.me/17623490579?text=${encoded}`;
  res.redirect(302, url);
});

app.post('/admin/refresh-kb', (req, res) => {
  invalidateCache();
  res.json({ ok: true, message: 'Cache invalidado' });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

app.listen(PORT, () => {
  console.log(`🐾 LlabanaBot corriendo en puerto ${PORT}`);
  console.log(`📱 WhatsApp: POST /webhook/whatsapp`);
  console.log(`🛍️  Shopify:  POST /webhook/shopify`);
});

module.exports = app;
