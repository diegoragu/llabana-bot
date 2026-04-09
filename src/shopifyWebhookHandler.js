/**
 * Shopify Webhook Handler
 * Endpoint: POST /webhook/shopify
 *
 * Eventos manejados (header x-shopify-topic):
 *   customers/create  → registra o actualiza cliente; agrega tag "Solo cuenta"
 *   customers/update  → accepts_marketing, nombre incompleto, y tags de Shopify Flow
 *                       (tag "Carrito abandonado" → segmento; tag "Solo cuenta" → historial)
 *   checkouts/create  → DESACTIVADO (carrito abandonado ahora llega via customers/update + Shopify Flow)
 *   orders/paid       → segmento "Comprador"/"Recompra", actualiza órdenes, monto y tags
 *
 * Nota: no existe columna "Fecha última compra" en el schema de Sheets —
 *       agrégala manualmente si se necesita en el futuro.
 *
 * Verificación: HMAC-SHA256 del raw body con SHOPIFY_WEBHOOK_SECRET
 */

const crypto = require('crypto');
const sheetsService = require('./sheetsService');
const { formatPhoneForStorage, limpiarNombre, lookupCpMX } = sheetsService;

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
      // checkouts/create desactivado — carrito abandonado llega via customers/update + Shopify Flow
      // case 'checkouts/create':  await handleCheckoutCreate(payload);  break;
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
  const accountState     = payload.state || 'disabled';
  const tieneCtaActiva   = accountState === 'enabled';

  console.log(`   customers/create: ${email} | state=${accountState}`);

  const existing = await sheetsService.findCustomerByEmail(email);

  if (existing) {
    const segExistente = existing.segmento || '';
    // Solo actualizar a "Solo cuenta" si tiene cuenta activa y segmento es Lead frío o vacío
    if (tieneCtaActiva && (segExistente === 'Lead frío' || !segExistente)) {
      await sheetsService.updateOrderData(existing.rowIndex, { segmento: 'Solo cuenta' });
      await sheetsService.appendTag(existing.rowIndex, 'Solo cuenta');
    }
    if (acceptsMarketing) {
      await sheetsService.updateEmailMarketing(existing.rowIndex, 'SI');
    }
    if (payload.phone && !existing.phone) {
      const formattedPhone = formatPhoneForStorage(payload.phone);
      if (formattedPhone) await sheetsService.updateCustomerPhone(existing.rowIndex, formattedPhone);
    }
    console.log(`   customers/create: ${email} ya existe → actualizado`);
    return;
  }

  // Cliente nuevo → registrar fila
  const name = limpiarNombre(`${(payload.first_name || '').trim()} ${(payload.last_name || '').trim()}`);
  const state2 = payload.default_address?.province || '';
  const city   = payload.default_address?.city     || '';
  const phone  = payload.phone || '';

  // Segmento inicial basado en state
  const segmentoInicial = tieneCtaActiva ? 'Solo cuenta' : 'Lead frío';

  const rowIndex = await sheetsService.registerCustomer({
    phone, name, email,
    state: state2, city,
    cp: '', species: '', channel: '', channelDetail: '',
    segmento: segmentoInicial,
    origen: 'Shopify',
  });

  if (rowIndex) {
    if (tieneCtaActiva) {
      await sheetsService.appendTag(rowIndex, 'Solo cuenta');
    }
    if (acceptsMarketing) {
      await sheetsService.updateEmailMarketing(rowIndex, 'SI');
    }
  }

  console.log(`   ✅ customers/create: ${email} → ${segmentoInicial} | rowIndex: ${rowIndex}`);
}

// ── Shopify Admin API ─────────────────────────────────────────────────────────

let shopifyToken       = null;
let shopifyTokenExpiry = null;

async function getShopifyToken() {
  if (shopifyToken && shopifyTokenExpiry && Date.now() < shopifyTokenExpiry) {
    return shopifyToken;
  }

  const storeUrl     = process.env.SHOPIFY_STORE_URL;
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!storeUrl || !clientId || !clientSecret) {
    console.warn('⚠️  SHOPIFY_STORE_URL, SHOPIFY_CLIENT_ID o SHOPIFY_CLIENT_SECRET no configurados');
    return null;
  }

  try {
    const response = await fetch(
      `https://${storeUrl}/admin/oauth/access_token`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
      }
    );
    const data = await response.json();
    if (!data.access_token) {
      console.error('Error obteniendo token Shopify:', JSON.stringify(data));
      return null;
    }
    shopifyToken       = data.access_token;
    shopifyTokenExpiry = Date.now() + ((data.expires_in ?? 86400) - 300) * 1000;
    console.log('Token Shopify obtenido, expira en:', data.expires_in, 'segundos');
    return shopifyToken;
  } catch (err) {
    console.error('Error en getShopifyToken:', err.message);
    return null;
  }
}

async function fetchShopifyCustomer(customerId) {
  const storeUrl = process.env.SHOPIFY_STORE_URL;
  if (!storeUrl) {
    console.warn('⚠️  SHOPIFY_STORE_URL no configurado — no se pueden obtener tags');
    return null;
  }

  const token = await getShopifyToken();
  if (!token) return null;

  try {
    const response = await fetch(
      `https://${storeUrl}/admin/api/2024-01/customers/${customerId}.json`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) shopifyToken = null;
      console.warn(`⚠️  fetchShopifyCustomer: HTTP ${response.status} para customer ${customerId}`);
      return null;
    }
    const data = await response.json();
    return data.customer;
  } catch (err) {
    console.error('Error en fetchShopifyCustomer:', err.message);
    return null;
  }
}

// ── Evento: customers/update ──────────────────────────────────────────────────

// Tags de Shopify que no son propios del negocio y deben ignorarse
const SHOPIFY_SYSTEM_TAGS = /^(judge\.me|login with shop|shop|shopify)/i;

function parseShopifyTags(rawTags) {
  if (!rawTags) return new Set();
  return new Set(
    rawTags.split(',')
      .map(t => t.trim().toLowerCase())
      .filter(t => t && !SHOPIFY_SYSTEM_TAGS.test(t))
  );
}

async function handleCustomerUpdate(payload) {
  const email      = payload.email;
  // Usar admin_graphql_api_id para evitar pérdida de precisión con IDs grandes
  const customerId = payload.admin_graphql_api_id?.split('/').pop() ?? String(payload.id);
  if (!email) return;

  // Tags y marketing reales via Admin API
  let shopifyTags    = new Set();
  let marketingValue = null;

  let customerState = payload.state || 'disabled';

  if (customerId) {
    const customer = await fetchShopifyCustomer(customerId);
    if (customer?.tags) shopifyTags = parseShopifyTags(customer.tags);
    // state real desde la Admin API (más confiable que el payload)
    if (customer?.state) customerState = customer.state;
    // marketing desde el customer completo de la API
    const apiConsent = customer?.email_marketing_consent;
    if (apiConsent?.state === 'subscribed')        marketingValue = 'SI';
    else if (apiConsent?.state === 'unsubscribed') marketingValue = 'NO';
  }

  // Fallback: leer del payload del webhook si la API no lo devolvió
  if (!marketingValue) {
    const consent = payload.email_marketing_consent;
    if (consent?.state === 'subscribed')        marketingValue = 'SI';
    else if (consent?.state === 'unsubscribed') marketingValue = 'NO';
  }

  const hasFirstName   = !!(payload.first_name || '').trim();
  const hasCarrito     = shopifyTags.has('carrito abandonado');
  const tieneCtaActiva = customerState === 'enabled';

  if (!marketingValue && !hasFirstName && !hasCarrito && !tieneCtaActiva) return;

  const existing = await sheetsService.findCustomerByEmail(email);
  if (!existing) {
    console.log(`   customers/update: ${email} no está en Sheets, omitiendo`);
    return;
  }

  const seg = existing.segmento || '';

  if (marketingValue) {
    await sheetsService.updateEmailMarketing(existing.rowIndex, marketingValue);
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

  // state=enabled → actualizar a "Solo cuenta" si el segmento es Lead frío o vacío
  // (se evalúa antes del carrito para que carrito siempre tenga prioridad)
  if (tieneCtaActiva && (seg === 'Lead frío' || !seg) && !hasCarrito) {
    await sheetsService.updateOrderData(existing.rowIndex, { segmento: 'Solo cuenta' });
    await sheetsService.appendTag(existing.rowIndex, 'Solo cuenta');
    console.log(`   customers/update: ${email} → Solo cuenta (state=enabled)`);
  }

  // Tag "Carrito abandonado" → actualizar segmento (nunca sobreescribir Comprador/Recompra)
  if (hasCarrito && seg !== 'Comprador' && seg !== 'Recompra') {
    await sheetsService.updateOrderData(existing.rowIndex, { segmento: 'Carrito abandonado' });
    await sheetsService.appendTag(existing.rowIndex, 'Carrito abandonado');
    console.log(`   🛒 customers/update: ${email} → Carrito abandonado (via Admin API)`);
  }

  console.log(`   ✅ customers/update: ${email} | mkt=${marketingValue} carrito=${hasCarrito} state=${customerState}`);
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

    // Guardar CP desde el campo correcto (zip, no address1)
    const zip = (shipping.zip || '').trim().replace(/\D/g, '');
    if (zip) {
      updateFields.cp = zip;
      // Derivar estado y ciudad desde el CP
      const { state: cpState, city: cpCity } = await lookupCpMX(zip);
      if (cpState) updateFields.state = cpState;
      else if (shipping.province) updateFields.state = shipping.province;
      if (cpCity)  updateFields.city  = cpCity;
      else if (shipping.city) updateFields.city = shipping.city;
    } else {
      if (shipping.province) updateFields.state = shipping.province;
      if (shipping.city)     updateFields.city  = shipping.city;
    }

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
