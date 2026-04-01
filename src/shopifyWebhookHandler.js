/**
 * Shopify Webhook Handler
 * Endpoint: POST /webhook/shopify
 *
 * Eventos manejados (header x-shopify-topic):
 *   customers/create  → registra o actualiza cliente; agrega tag "Solo cuenta"
 *   customers/update  → si accepts_marketing pasó a true, marca "Acepta email mkt" = SI; actualiza nombre si incompleto
 *   checkouts/create  → segmento "Carrito abandonado" + tag; nunca sobreescribe Comprador/Recompra
 *   orders/paid       → segmento "Comprador"/"Recompra", actualiza órdenes, monto y tags
 *
 * Nota: no existe columna "Fecha última compra" en el schema de Sheets —
 *       agrégala manualmente si se necesita en el futuro.
 *
 * Verificación: HMAC-SHA256 del raw body con SHOPIFY_WEBHOOK_SECRET
 */

const crypto = require('crypto');
const sheetsService = require('./sheetsService');
const { formatPhoneForStorage, limpiarNombre } = sheetsService;

// ── Verificación HMAC ─────────────────────────────────────────────────────────

function verifyHmac(rawBody, hmacHeader) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  // Sin secret configurado: dejar pasar con advertencia (solo en desarrollo)
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
  const rawBody    = req.body; // Buffer (express.raw)

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
      case 'customers/create':  await handleCustomerCreate(payload);  break;
      case 'customers/update':  await handleCustomerUpdate(payload);  break;
      case 'checkouts/create':  await handleCheckoutCreate(payload);  break;
      case 'orders/paid':       await handleOrderPaid(payload);       break;
      default:
        console.log(`   Topic no manejado: ${topic}`);
    }
  } catch (err) {
    console.error(`Error procesando Shopify [${topic}]:`, err.message);
  }
}

// ── Evento: customers/create ──────────────────────────────────────────────────

async function handleCustomerCreate(payload) {
  const email = payload.email;
  if (!email) {
    console.log('   customers/create sin email, omitiendo');
    return;
  }

  const acceptsMarketing = !!payload.accepts_marketing;
  const existing = await sheetsService.findCustomerByEmail(email);

  if (existing) {
    // Cliente ya existe → solo agregar tag y actualizar marketing si aplica
    await sheetsService.appendTag(existing.rowIndex, 'Solo cuenta');
    if (acceptsMarketing) {
      await sheetsService.updateEmailMarketing(existing.rowIndex, 'SI');
    }
    // Guardar teléfono si el registro actual no tiene uno
    if (payload.phone && !existing.phone) {
      const formattedPhone = formatPhoneForStorage(payload.phone);
      if (formattedPhone) await sheetsService.updateCustomerPhone(existing.rowIndex, formattedPhone);
    }
    console.log(`   customers/create: ${email} ya existe → tag + marketing actualizado`);
    return;
  }

  // Cliente nuevo → registrar fila
  const name = limpiarNombre(`${(payload.first_name || '').trim()} ${(payload.last_name || '').trim()}`);
  const state = payload.default_address?.province || '';
  const city  = payload.default_address?.city     || '';
  const phone = payload.phone || '';

  const rowIndex = await sheetsService.registerCustomer({
    phone,
    name,
    email,
    state,
    city,
    cp:            '',
    species:       '',
    channel:       '',
    channelDetail: '',
    segmento:      'Lead frío',
    origen:        'Shopify',
  });

  if (rowIndex) {
    await sheetsService.appendTag(rowIndex, 'Solo cuenta');
    if (acceptsMarketing) {
      await sheetsService.updateEmailMarketing(rowIndex, 'SI');
    }
  }

  console.log(`   ✅ customers/create: ${email} registrado como "Lead frío" | rowIndex: ${rowIndex}`);
}

// ── Evento: customers/update ──────────────────────────────────────────────────

async function handleCustomerUpdate(payload) {
  const email = payload.email;
  if (!email) return;

  // Nos interesa si cambia accepts_marketing o si podemos mejorar el nombre
  const hasMarketingChange = !!payload.accepts_marketing;
  const hasFirstName       = !!(payload.first_name || '').trim();
  if (!hasMarketingChange && !hasFirstName) return;

  const existing = await sheetsService.findCustomerByEmail(email);
  if (!existing) {
    console.log(`   customers/update: ${email} no está en Sheets, omitiendo`);
    return;
  }

  if (hasMarketingChange) {
    await sheetsService.updateEmailMarketing(existing.rowIndex, 'SI');
  }

  // Actualizar nombre si el actual está vacío o tiene solo 1 palabra
  if (hasFirstName) {
    const currentName = (existing.name || '').trim();
    const nameWords   = currentName.split(/\s+/).filter(Boolean).length;
    if (nameWords <= 1) {
      const newName = limpiarNombre(`${(payload.first_name || '').trim()} ${(payload.last_name || '').trim()}`);
      if (newName) await sheetsService.updateOrderData(existing.rowIndex, { name: newName });
    }
  }

  console.log(`   ✅ customers/update: ${email} → mkt=${hasMarketingChange} nombre actualizado=${hasFirstName}`);
}

// ── Evento: checkouts/create (carrito abandonado) ─────────────────────────────

async function handleCheckoutCreate(payload) {
  const email = payload.email;
  if (!email) {
    console.log('   checkouts/create sin email, omitiendo');
    return;
  }

  const customer = await sheetsService.findCustomerByEmail(email);
  if (!customer) {
    console.log(`   checkouts/create: ${email} no está en Sheets, omitiendo`);
    return;
  }

  const seg = customer.segmento || '';
  if (seg === 'Comprador' || seg === 'Recompra') {
    console.log(`   checkouts/create: ${email} ya es "${seg}", no se sobreescribe`);
    return;
  }

  await sheetsService.updateOrderData(customer.rowIndex, { segmento: 'Carrito abandonado' });
  await sheetsService.appendTag(customer.rowIndex, 'Carrito abandonado');
  console.log(`   🛒 checkouts/create: ${email} → Carrito abandonado`);
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

  const prevOrders   = parseInt(customer.totalOrders || '0') || 0;
  const newOrders    = prevOrders + 1;
  const isFirstBuy   = prevOrders === 0;
  const segmento     = isFirstBuy ? 'Comprador' : 'Recompra';
  const tag          = isFirstBuy ? 'Compro'    : 'Recompra';

  const prevSpent = parseFloat((customer.totalSpent || '0').replace(/[$,\s]/g, '')) || 0;
  const orderAmt  = parseFloat(payload.total_price || '0') || 0;
  const newSpent  = `$${(prevSpent + orderAmt).toFixed(2)}`;

  // Fecha de la orden en formato YYYY-MM-DD (hora México)
  const rawDate    = payload.created_at || payload.processed_at || new Date().toISOString();
  const fechaCompra = new Date(rawDate)
    .toLocaleDateString('sv-SE', { timeZone: 'America/Mexico_City' }); // sv-SE → YYYY-MM-DD

  // Actualizar nombre desde shipping_address si el actual está vacío o es solo 1 palabra
  const shipping = payload.shipping_address;
  const updateFields = {
    totalOrders: String(newOrders),
    totalSpent:  newSpent,
    segmento,
    fechaCompra,
  };
  if (shipping) {
    const currentName = (customer.name || '').trim();
    const nameWords   = currentName.split(/\s+/).filter(Boolean).length;
    if (nameWords <= 1) {
      const shippingName = limpiarNombre(`${(shipping.first_name || '').trim()} ${(shipping.last_name || '').trim()}`);
      if (shippingName) updateFields.name = shippingName;
    }
    if (shipping.province) updateFields.state = shipping.province;
    if (shipping.city)     updateFields.city  = shipping.city;
    if (shipping.address1) updateFields.cp    = shipping.address1;
    if (shipping.phone && !customer.phone) {
      const formattedPhone = formatPhoneForStorage(shipping.phone);
      if (formattedPhone) updateFields.phone = formattedPhone;
    }
  }

  await sheetsService.updateOrderData(customer.rowIndex, updateFields);
  await sheetsService.appendTag(customer.rowIndex, tag);

  console.log(`   ✅ orders/paid: ${email} → ${segmento} | Órdenes: ${newOrders} | Total: ${newSpent}`);
}

module.exports = shopifyWebhookHandler;
