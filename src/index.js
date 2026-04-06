require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');
const webhookHandler = require('./webhookHandler');
const shopifyWebhookHandler = require('./shopifyWebhookHandler');
const { getTranscripts } = require('./transcriptService');

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

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

app.listen(PORT, () => {
  console.log(`🐾 LlabanaBot corriendo en puerto ${PORT}`);
  console.log(`📱 WhatsApp: POST /webhook/whatsapp`);
  console.log(`🛍️  Shopify:  POST /webhook/shopify`);
});

module.exports = app;
