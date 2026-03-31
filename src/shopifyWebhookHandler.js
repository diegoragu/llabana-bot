/**
 * Shopify Webhook Handler
 * Endpoint: POST /webhook/shopify
 *
 * Eventos manejados (header x-shopify-topic):
 *   orders/paid       → segmento "Comprador" o "Recompra", actualiza órdenes y monto
 *   checkouts/delete  → segmento "Carrito abandonado" (solo si cliente ya existe en Sheets)
 *   customers/create  → registra cliente nuevo si no existe en Sheets
 *
 * Verificación: HMAC-SHA256 del raw body con SHOPIFY_WEBHOOK_SECRET
 */

const crypto = require('crypto');
const sheetsService = require('./sheetsService');

// ── Verificación HMAC ─────────────────────────────────────────────────────────

function verifyHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  // Si no está configurado el secret, logear advertencia pero dejar pasar
  // (útil durante desarrollo — en producción siempre debe estar configurado)
  if (!secret) {
    console.warn('⚠️  SHOPIFY_WEBHOOK_SECRET no configurado — omitiendo verificación HMAC');
    return true;
  }
  if (!hmacHeader) return false;

  try {
    const computed = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('base64');

    const a = Buffer.from(computed);
    const b = Buffer.from(hmacHeader);
    if (a.length !== b.length) return false;

    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── Handler principal ─────────────────────────────────────────────────────────

async function shopifyWebhookHandler(req, res) {
  // Responder 200 de inmediato para evitar reintentos de Shopify (timeout 5s)
  res.status(200).send('');

  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const topic      = req.headers['x-shopify-topic'];
  const rawBody    = req.body; // Buffer (gracias a express.raw)

  if (!verifyHmac(rawBody, hmacHeader)) {
    console.warn(`⚠️  Shopify webhook rechazado — HMAC inválido (topic: ${topic})`);
    return;
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    console.error('Error parseando payload de Shopify:', err.message);
    return;
  }

  console.log(`🛍️  Shopify evento: ${topic}`);

  try {
    switch (topic) {
      case 'orders/paid':
        await handleOrderPaid(payload);
        break;
      case 'checkouts/delete':
        await handleCheckoutDelete(payload);
        break;
      case 'customers/create':
        await handleCustomerCreate(payload);
        break;
      default:
        console.log(`   Topic no manejado: ${topic}`);
    }
  } catch (err) {
    console.error(`Error procesando Shopify [${topic}]:`, err.message);
  }
}

// ── Evento: orders/paid ───────────────────────────────────────────────────────

async function handleOrderPaid(payload) {
  const email = payload.email || payload.customer?.email;
  if (!email) {
    console.log('   orders/paid sin email, omitiendo');
    return;
  }

  const customer = await sheetsService.findCustomerByEmail(email);
  if (!customer) {
    console.log(`   orders/paid: ${email} no está en Sheets`);
    return;
  }

  // Calcular nuevo total de órdenes y segmento
  const prevOrders = parseInt(customer.totalOrders || '0') || 0;
  const newOrders  = prevOrders + 1;
  const segmento   = newOrders > 1 ? 'Recompra' : 'Comprador';

  // Acumular monto gastado
  const prevSpent  = parseFloat((customer.totalSpent || '0').replace(/[$,\s]/g, '')) || 0;
  const orderAmt   = parseFloat(payload.total_price || '0') || 0;
  const newSpent   = `$${(prevSpent + orderAmt).toFixed(2)}`;

  await sheetsService.updateOrderData(customer.rowIndex, {
    totalOrders: String(newOrders),
    totalSpent:  newSpent,
    segmento,
  });

  console.log(`   ✅ ${email} → ${segmento} | Órdenes: ${newOrders} | Total: ${newSpent}`);
}

// ── Evento: checkouts/delete ──────────────────────────────────────────────────

async function handleCheckoutDelete(payload) {
  const email = payload.email;
  if (!email) {
    console.log('   checkouts/delete sin email, omitiendo');
    return;
  }

  const customer = await sheetsService.findCustomerByEmail(email);
  if (!customer) {
    // Spec: solo actualizar si ya existe en Sheets
    console.log(`   checkouts/delete: ${email} no está en Sheets, omitiendo`);
    return;
  }

  // No sobreescribir si ya compró
  const seg = customer.segmento || '';
  if (seg === 'Comprador' || seg === 'Recompra') {
    console.log(`   checkouts/delete: ${email} ya es "${seg}", no se sobreescribe`);
    return;
  }

  await sheetsService.updateOrderData(customer.rowIndex, { segmento: 'Carrito abandonado' });
  console.log(`   🛒 ${email} → Carrito abandonado`);
}

// ── Evento: customers/create ──────────────────────────────────────────────────

async function handleCustomerCreate(payload) {
  const email = payload.email;
  if (!email) {
    console.log('   customers/create sin email, omitiendo');
    return;
  }

  const existing = await sheetsService.findCustomerByEmail(email);
  if (existing) {
    console.log(`   customers/create: ${email} ya existe en Sheets, omitiendo`);
    return;
  }

  const name  = [payload.first_name, payload.last_name].filter(Boolean).join(' ') || 'Sin nombre';
  const state = payload.default_address?.province || '';
  const city  = payload.default_address?.city     || '';
  const phone = payload.phone || '';

  await sheetsService.registerCustomer({
    phone,
    name,
    email,
    state,
    city,
    colonia:       '',
    species:       '',
    channel:       '',
    channelDetail: '',
    segmento:      'Lead frío',
    origen:        'Shopify',
  });

  console.log(`   ✅ customers/create: ${email} registrado como "Lead frío" desde Shopify`);
}

module.exports = shopifyWebhookHandler;
