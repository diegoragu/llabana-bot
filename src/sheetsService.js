/**
 * Google Sheets Service — Llabana Bot
 *
 * ═══════════════════════════════════════════════════════════════════
 * "1 Base Maestra" (3,518+ contactos existentes)
 *   A (0):  Segmento actual
 *   B (1):  Nombre
 *   C (2):  Email
 *   D (3):  Teléfono          ← clave de búsqueda
 *   E (4):  Acepta email mkt
 *   F (5):  Acepta WhatsApp
 *   G (6):  Estado
 *   H (7):  Ciudad
 *   I (8):  Colonia
 *   J (9):  Total órdenes
 *   K (10): Monto gastado ($)
 *   L (11): Sitio de origen
 *   M (12): Punto de entrada
 *   N (13): Historial de tags
 *   O (14): Fecha primer contacto
 *   P (15): Asesoría LlosaGPT  ← log de conversación del bot
 *   Q (16): Notas
 *
 * "2 Sucursales" (35 sucursales existentes)
 *   A (0): #
 *   B (1): Nombre sucursal
 *   C (2): Estado
 *   D (3): Municipio / Ciudad  ← búsqueda por ciudad
 *   E (4): C.P.
 *   F (5): Dirección completa
 *   G (6): Horario
 *   H (7): Teléfono sucursal
 *   I (8): Coordenadas
 *   J (9): Notas bot
 *
 * "3 Rutas Reparto" (vacía, se llenará después)
 *   A: Colonia | B: Ciudad | C: Ruta | D: Días de Reparto
 *
 * "4 Seguimientos 24h"
 *   A: Teléfono | B: Nombre | C: Fecha/Hora | D: Motivo | E: Estado | F: Notas
 * ═══════════════════════════════════════════════════════════════════
 */

const { google } = require('googleapis');

const SPREADSHEET_ID   = process.env.GOOGLE_SHEETS_ID;
const SHEET_BASE       = '1 Base Maestra';
const SHEET_SUCURSALES = '2 Sucursales';
const SHEET_RUTAS      = '3 Rutas Reparto';
const SHEET_SEGUIM     = '4 Seguimientos 24h';

// Índices columnas Base Maestra (0-indexed)
const BASE = {
  SEGMENTO:    0,
  NOMBRE:      1,
  EMAIL:       2,
  TELEFONO:    3,
  ACE_EMAIL:   4,
  ACE_WA:      5,
  ESTADO:      6,
  CIUDAD:      7,
  COLONIA:     8,
  TOTAL_ORD:   9,
  MONTO:       10,
  ORIGEN:      11,
  ENTRADA:     12,
  TAGS:        13,
  FECHA_REG:   14,
  ASESORIA:    15,  // "Asesoría LlosaGPT" — log del bot
  NOTAS:       16,
};

// Índices columnas Sucursales (0-indexed)
const SUC = {
  NUM:       0,
  NOMBRE:    1,
  ESTADO:    2,
  CIUDAD:    3,  // "Municipio / Ciudad"
  CP:        4,
  DIRECCION: 5,
  HORARIO:   6,
  TELEFONO:  7,
  COORDS:    8,
  NOTAS_BOT: 9,
};

// ── Auth ──────────────────────────────────────────────────────────────────────

function getAuth() {
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    try {
      credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON no es JSON válido');
    }
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
    credentials = JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
    );
  } else {
    throw new Error('Faltan credenciales de Google (GOOGLE_SERVICE_ACCOUNT_JSON)');
  }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// ── Normalización ─────────────────────────────────────────────────────────────

/**
 * Quita el prefijo whatsapp: y el código de país 52, deja solo 10 dígitos.
 * whatsapp:+521234567890 → 1234567890
 */
function normalizePhone(phone) {
  let n = (phone || '').replace('whatsapp:', '').replace(/\D/g, '');
  if (n.startsWith('521') && n.length === 13) n = n.substring(2);
  else if (n.startsWith('52') && n.length === 12) n = n.substring(2);
  return n;
}

/** Minúsculas, sin acentos, sin caracteres especiales. */
function normalizeText(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();
}

// ── Base Maestra ──────────────────────────────────────────────────────────────

/**
 * Busca un cliente por número de teléfono en "1 Base Maestra".
 * @returns {object|null}
 */
async function findCustomer(phone) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_BASE}!A:Q`,
    });

    const rows = res.data.values || [];
    const search = normalizePhone(phone);

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowPhone = row[BASE.TELEFONO] || '';
      if (!rowPhone) continue;
      if (normalizePhone(rowPhone) === search) {
        return {
          rowIndex:    i + 1,             // 1-based para la API
          phone:       rowPhone,
          name:        row[BASE.NOMBRE]   || '',
          email:       row[BASE.EMAIL]    || '',
          state:       row[BASE.ESTADO]   || '',
          city:        row[BASE.CIUDAD]   || '',
          colonia:     row[BASE.COLONIA]  || '',
          segmento:    row[BASE.SEGMENTO] || '',
          tags:        row[BASE.TAGS]     || '',
          totalOrders: row[BASE.TOTAL_ORD]|| '0',
          totalSpent:  row[BASE.MONTO]    || '0',
          fechaReg:    row[BASE.FECHA_REG]|| '',
        };
      }
    }
    return null;
  } catch (err) {
    console.error('sheetsService.findCustomer error:', err.message);
    return null;
  }
}

/**
 * Registra un cliente nuevo al final de "1 Base Maestra".
 * Solo escribe los campos que el bot conoce; el resto queda vacío.
 */
async function registerCustomer(data) {
  const sheets = await getSheets();
  const now = nowMX();

  // Construir fila de 17 columnas (A–Q)
  const row = Array(17).fill('');
  row[BASE.SEGMENTO]  = data.segmento || 'Lead frío';
  row[BASE.NOMBRE]    = data.name;
  row[BASE.EMAIL]     = data.email || '';
  row[BASE.TELEFONO]  = data.phone;
  row[BASE.ACE_WA]    = 'Sí';
  row[BASE.ESTADO]    = data.state;
  row[BASE.CIUDAD]    = data.city;
  row[BASE.COLONIA]   = data.colonia;
  row[BASE.ORIGEN]    = data.origen  || 'WhatsApp';
  row[BASE.ENTRADA]   = data.origen === 'Shopify' ? 'Shopify' : 'Bot Llabana';
  row[BASE.FECHA_REG] = now;
  row[BASE.ASESORIA]  = `[${now}] Canal: ${data.channel} (${data.channelDetail})`;
  row[BASE.NOTAS]     = data.species ? `Especie: ${data.species}` : '';

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_BASE}!A:Q`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });

  console.log(`✅ Cliente registrado: ${data.name} | ${data.phone}`);
}

/**
 * Agrega un turno de conversación a la columna P (Asesoría LlosaGPT).
 */
async function appendConversationLog(phone, userMsg, botMsg) {
  try {
    const customer = await findCustomer(phone);
    if (!customer) return;

    const sheets = await getSheets();
    const now = nowMX();
    const col = columnLetter(BASE.ASESORIA); // P

    // Leer contenido actual de la celda
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_BASE}!${col}${customer.rowIndex}`,
    });
    const existing = res.data.values?.[0]?.[0] || '';
    const newEntry = `[${now}] Cliente: ${userMsg} | Bot: ${botMsg}`;
    const updated  = existing ? `${existing}\n${newEntry}` : newEntry;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_BASE}!${col}${customer.rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[updated]] },
    });
  } catch (err) {
    console.error('sheetsService.appendConversationLog error:', err.message);
  }
}

/**
 * Actualiza en batch los campos de orden de un cliente: segmento (A), órdenes (J) y monto (K).
 * Todos los campos son opcionales — solo actualiza los que se pasen.
 * Usado por los webhooks de Shopify.
 *
 * @param {number} rowIndex  - Fila 1-based del cliente en la hoja
 * @param {object} fields    - { totalOrders?, totalSpent?, segmento? }
 */
async function updateOrderData(rowIndex, { totalOrders, totalSpent, segmento } = {}) {
  try {
    const sheets = await getSheets();
    const data   = [];

    if (segmento    !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.SEGMENTO)}${rowIndex}`,  values: [[segmento]]    });
    if (totalOrders !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.TOTAL_ORD)}${rowIndex}`, values: [[totalOrders]] });
    if (totalSpent  !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.MONTO)}${rowIndex}`,     values: [[totalSpent]]  });

    if (data.length === 0) return;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { valueInputOption: 'USER_ENTERED', data },
    });
  } catch (err) {
    console.error('sheetsService.updateOrderData error:', err.message);
    throw err;
  }
}

/**
 * Actualiza la columna A (Segmento actual) de un cliente.
 * Ej: 'Lead frío', 'Mayoreo / Reventa', 'Redirigido a sucursal', 'Fuera de cobertura'
 */
async function updateSegmento(phone, segmento) {
  try {
    const customer = await findCustomer(phone);
    if (!customer) return;

    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_BASE}!A${customer.rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[segmento]] },
    });
  } catch (err) {
    console.error('sheetsService.updateSegmento error:', err.message);
  }
}

/**
 * Busca un cliente por email en la columna C (Email) de "1 Base Maestra".
 * @returns {object|null}
 */
async function findCustomerByEmail(email) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_BASE}!A:Q`,
    });

    const rows = res.data.values || [];
    const search = (email || '').toLowerCase().trim();

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const rowEmail = (row[BASE.EMAIL] || '').toLowerCase().trim();
      if (rowEmail && rowEmail === search) {
        return {
          rowIndex:    i + 1,
          phone:       row[BASE.TELEFONO]  || '',
          name:        row[BASE.NOMBRE]    || '',
          email:       row[BASE.EMAIL]     || '',
          state:       row[BASE.ESTADO]    || '',
          city:        row[BASE.CIUDAD]    || '',
          colonia:     row[BASE.COLONIA]   || '',
          segmento:    row[BASE.SEGMENTO]  || '',
          tags:        row[BASE.TAGS]      || '',
          totalOrders: row[BASE.TOTAL_ORD] || '0',
          totalSpent:  row[BASE.MONTO]     || '0',
          fechaReg:    row[BASE.FECHA_REG] || '',
        };
      }
    }
    return null;
  } catch (err) {
    console.error('sheetsService.findCustomerByEmail error:', err.message);
    return null;
  }
}

/**
 * Actualiza el teléfono (columna D) de una fila existente.
 * Usado cuando encontramos a un cliente por email con un número nuevo.
 */
async function updateCustomerPhone(rowIndex, phone) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_BASE}!${columnLetter(BASE.TELEFONO)}${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[phone]] },
    });
  } catch (err) {
    console.error('sheetsService.updateCustomerPhone error:', err.message);
  }
}

/**
 * Actualiza el email (columna C) de una fila existente.
 * Usado cuando un cliente nuevo proporciona su email al final del onboarding.
 */
async function updateCustomerEmail(rowIndex, email) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_BASE}!${columnLetter(BASE.EMAIL)}${rowIndex}`,
      valueInputOption: 'USER_ENTERED',
      resource: { values: [[email]] },
    });
  } catch (err) {
    console.error('sheetsService.updateCustomerEmail error:', err.message);
  }
}

// ── Sucursales ────────────────────────────────────────────────────────────────

/**
 * Busca una ciudad en "2 Sucursales" (columna D: Municipio / Ciudad).
 * @returns {object|null}
 */
async function findCityInSucursales(city) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_SUCURSALES}!A:J`,
    });

    const rows = res.data.values || [];
    const search = normalizeText(city);

    for (const row of rows.slice(1)) {
      const rowCity = normalizeText(row[SUC.CIUDAD] || '');
      if (!rowCity) continue;
      if (rowCity === search || rowCity.includes(search) || search.includes(rowCity)) {
        return {
          nombre:    row[SUC.NOMBRE]    || '',
          estado:    row[SUC.ESTADO]    || '',
          ciudad:    row[SUC.CIUDAD]    || '',
          cp:        row[SUC.CP]        || '',
          direccion: row[SUC.DIRECCION] || '',
          horario:   row[SUC.HORARIO]   || '',
          telefono:  row[SUC.TELEFONO]  || '',
          notasBot:  row[SUC.NOTAS_BOT] || '',
        };
      }
    }
    return null;
  } catch (err) {
    console.error('sheetsService.findCityInSucursales error:', err.message);
    return null;
  }
}

// ── Rutas de Reparto ──────────────────────────────────────────────────────────

/**
 * Busca una colonia en "3 Rutas Reparto".
 * La pestaña está vacía por ahora; retorna null hasta que se llene.
 * Columnas esperadas: A: Colonia | B: Ciudad | C: Ruta | D: Días
 */
async function findColoniaInRutas(colonia) {
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_RUTAS}!A:D`,
    });

    const rows = res.data.values || [];
    if (rows.length <= 1) return null; // vacía

    const search = normalizeText(colonia);

    for (const row of rows.slice(1)) {
      if (!row[0]) continue;
      const rowColonia = normalizeText(row[0]);
      if (rowColonia === search || rowColonia.includes(search) || search.includes(rowColonia)) {
        return {
          colonia: row[0],
          ciudad:  row[1] || '',
          ruta:    row[2] || '',
          dias:    row[3] || '',
        };
      }
    }
    return null;
  } catch (err) {
    console.error('sheetsService.findColoniaInRutas error:', err.message);
    return null;
  }
}

// ── Seguimientos 24h ──────────────────────────────────────────────────────────

/**
 * Registra un seguimiento en "4 Seguimientos 24h".
 * Columnas: A: Teléfono | B: Nombre | C: Fecha/Hora | D: Motivo | E: Estado | F: Notas
 */
async function addSeguimiento(phone, name, motivo, notas = '') {
  try {
    const sheets = await getSheets();
    const now = nowMX();

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_SEGUIM}!A:F`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[phone, name, now, motivo, 'pendiente', notas]],
      },
    });
    console.log(`📋 Seguimiento registrado para ${name} (${phone})`);
  } catch (err) {
    console.error('sheetsService.addSeguimiento error:', err.message);
  }
}

// ── Utilidades ────────────────────────────────────────────────────────────────

function nowMX() {
  return new Date().toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Convierte índice de columna (0-based) a letra. 0→A, 15→P, etc. */
function columnLetter(index) {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

module.exports = {
  findCustomer,
  findCustomerByEmail,
  registerCustomer,
  updateCustomerPhone,
  updateCustomerEmail,
  updateOrderData,
  appendConversationLog,
  updateSegmento,
  findCityInSucursales,
  findColoniaInRutas,
  addSeguimiento,
};
