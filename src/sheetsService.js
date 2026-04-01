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
 *   I (8):  CP
 *   J (9):  Total órdenes
 *   K (10): Monto gastado ($)
 *   L (11): Fecha última compra ← YYYY-MM-DD
 *   M (12): Sitio de origen
 *   N (13): Punto de entrada
 *   O (14): Historial de tags
 *   P (15): Fecha primer contacto
 *   Q (16): Asesoría LlosaGPT  ← log de conversación del bot
 *   R (17): Notas
 *   S (18): Último movimiento  ← YYYY-MM-DD HH:MM (auto)
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
  SEGMENTO:      0,
  NOMBRE:        1,
  EMAIL:         2,
  TELEFONO:      3,
  ACE_EMAIL:     4,
  ACE_WA:        5,
  ESTADO:        6,
  CIUDAD:        7,
  CP:            8,
  TOTAL_ORD:     9,
  MONTO:         10,
  FECHA_COMPRA:  11,  // "Fecha última compra" — YYYY-MM-DD
  ORIGEN:        12,
  ENTRADA:       13,
  TAGS:          14,
  FECHA_REG:     15,
  ASESORIA:      16,  // "Asesoría LlosaGPT" — log del bot
  NOTAS:         17,
  ULTIMO_MOV:    18,  // "Último movimiento" — YYYY-MM-DD HH:MM (auto)
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

/**
 * Devuelve el teléfono listo para guardar en Google Sheets como texto.
 * - Elimina prefijo "whatsapp:" (case-insensitive) y caracteres no numéricos.
 * - Normaliza a 10 dígitos y antepone +52.
 * - El apóstrofo inicial (') es el prefijo de texto de Sheets: con valueInputOption
 *   'USER_ENTERED', Sheets lo interpreta como "forzar texto" y la celda muestra
 *   +52XXXXXXXXXX sin apóstrofo pero almacenado como texto, no como número.
 */
function formatPhoneForStorage(phone) {
  let n = (phone || '').replace(/^whatsapp:/i, '').replace(/\D/g, '');
  if (n.startsWith('521') && n.length === 13) n = n.substring(3); // 521XXXXXXXXXX → XXXXXXXXXX
  else if (n.startsWith('52') && n.length === 12) n = n.substring(2); // 52XXXXXXXXXX  → XXXXXXXXXX
  return n ? `'+52${n}` : '';
}

/**
 * Valida y limpia un nombre antes de guardarlo.
 * Devuelve el nombre capitalizado o '' si el valor no es un nombre real.
 */
function limpiarNombre(nombre) {
  if (!nombre) return '';
  let n = nombre.trim();
  if (!n) return '';

  // Demasiado largo para ser un nombre
  if (n.length > 60) return '';

  // Parece un email
  if (n.includes('@') || /\.com\b/i.test(n)) return '';

  // Quitar prefijo "Con " (Shopify lo genera en checkouts de invitado)
  // Ejemplo: "Con Diego Ramirez" → "Diego Ramirez"
  n = n.replace(/^con\s+/i, '').trim();
  if (!n) return '';

  // Contiene palabras que no son nombres
  const nonName = /\b(hola|buenos?\s*d[ií]as?|buenas?\s*(tardes?|noches?)|quiero|precio|info(rmaci[oó]n)?|cu[aá]nto|c[oó]mo|gracias|tengo|busco|necesito|vendo|compro)\b/i;
  if (nonName.test(n)) return '';

  // Solo dígitos
  if (/^\d+$/.test(n)) return '';

  // Lowercase primero (normaliza GARCIA, RomáN, etc.) luego capitaliza cada palabra
  return n.toLowerCase()
    .split(' ')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
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
      range: `${SHEET_BASE}!A:S`,
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
          cp:          row[BASE.CP]       || '',
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

  // Construir fila de 19 columnas (A–S)
  const row = Array(19).fill('');
  row[BASE.SEGMENTO]   = data.segmento || 'Lead frío';
  row[BASE.NOMBRE]     = data.name || '';
  row[BASE.EMAIL]      = data.email || '';
  row[BASE.TELEFONO]   = formatPhoneForStorage(data.phone);
  row[BASE.ACE_WA]     = data.aceWa || '';
  row[BASE.ESTADO]     = data.state;
  row[BASE.CIUDAD]     = data.city;
  row[BASE.CP]         = data.cp;
  row[BASE.ORIGEN]     = data.origen  || 'WhatsApp';
  row[BASE.ENTRADA]    = data.origen === 'Shopify' ? 'Shopify' : 'Bot Llabana';
  row[BASE.FECHA_REG]  = now;
  row[BASE.ASESORIA]   = '';  // se llena durante la conversación por appendConversationLog
  row[BASE.NOTAS]      = [
    data.channel ? `Canal: ${data.channel} (${data.channelDetail})` : '',
    data.species ? `Especie: ${data.species}` : '',
  ].filter(Boolean).join(' | ');
  row[BASE.ULTIMO_MOV] = nowMXDatetime();

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_BASE}!A:S`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });

  // Extraer el rowIndex de la respuesta para permitir actualizaciones posteriores
  // updatedRange tiene formato "1 Base Maestra!A3520:Q3520"
  const updatedRange = res.data.updates?.updatedRange || '';
  const match = updatedRange.match(/!A(\d+):/);
  const rowIndex = match ? parseInt(match[1]) : null;

  console.log(`✅ Cliente registrado: ${data.name} | ${data.phone} | fila ${rowIndex}`);
  return rowIndex;
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
    const col = columnLetter(BASE.ASESORIA); // Q

    // Leer contenido actual de la celda
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_BASE}!${col}${customer.rowIndex}`,
    });
    const existing = res.data.values?.[0]?.[0] || '';
    const newEntry = `[${now}] Cliente: ${userMsg} | Bot: ${botMsg}`;
    const updated  = existing ? `${existing}\n${newEntry}` : newEntry;

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${SHEET_BASE}!${col}${customer.rowIndex}`,                                         values: [[updated]]          },
          { range: `${SHEET_BASE}!${columnLetter(BASE.ULTIMO_MOV)}${customer.rowIndex}`,               values: [[nowMXDatetime()]]  },
        ],
      },
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
async function updateOrderData(rowIndex, { totalOrders, totalSpent, segmento, fechaCompra, name, phone, state, city, cp, notas } = {}) {
  try {
    const sheets = await getSheets();
    const data   = [];

    if (segmento    !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.SEGMENTO)}${rowIndex}`,     values: [[segmento]]     });
    if (totalOrders !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.TOTAL_ORD)}${rowIndex}`,    values: [[totalOrders]]  });
    if (totalSpent  !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.MONTO)}${rowIndex}`,        values: [[totalSpent]]   });
    if (fechaCompra !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.FECHA_COMPRA)}${rowIndex}`, values: [[fechaCompra]]  });
    if (name        !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.NOMBRE)}${rowIndex}`,       values: [[name]]         });
    if (phone       !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.TELEFONO)}${rowIndex}`,     values: [[phone]]        });
    if (state       !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.ESTADO)}${rowIndex}`,       values: [[state]]        });
    if (city        !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.CIUDAD)}${rowIndex}`,       values: [[city]]         });
    if (cp          !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.CP)}${rowIndex}`,           values: [[cp]]           });
    if (notas       !== undefined) data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.NOTAS)}${rowIndex}`,        values: [[notas]]        });
    data.push({ range: `${SHEET_BASE}!${columnLetter(BASE.ULTIMO_MOV)}${rowIndex}`, values: [[nowMXDatetime()]] });

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
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${SHEET_BASE}!A${customer.rowIndex}`,                                          values: [[segmento]]         },
          { range: `${SHEET_BASE}!${columnLetter(BASE.ULTIMO_MOV)}${customer.rowIndex}`,           values: [[nowMXDatetime()]]  },
        ],
      },
    });
  } catch (err) {
    console.error('sheetsService.updateSegmento error:', err.message);
  }
}

// Caché del sheetId numérico (evita una llamada extra a la API por cada delete)
const _sheetIdCache = {};

async function getNumericSheetId(sheets, sheetName) {
  if (_sheetIdCache[sheetName] !== undefined) return _sheetIdCache[sheetName];
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  for (const s of meta.data.sheets) {
    _sheetIdCache[s.properties.title] = s.properties.sheetId;
  }
  return _sheetIdCache[sheetName] ?? null;
}

/**
 * Elimina la fila del cliente recién creada cuando se detecta que ya existe
 * un registro previo con el mismo email (evita duplicados).
 *
 * @param {number} rowIndex - Fila 1-based a eliminar
 */
async function deleteCustomerRow(rowIndex) {
  try {
    const sheets = await getSheets();
    const sheetId = await getNumericSheetId(sheets, SHEET_BASE);
    if (sheetId === null) throw new Error(`Sheet "${SHEET_BASE}" no encontrada`);

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        requests: [{
          deleteDimension: {
            range: {
              sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex - 1, // API usa índice 0-based
              endIndex:   rowIndex,
            },
          },
        }],
      },
    });
    console.log(`🗑️  Fila duplicada ${rowIndex} eliminada de "${SHEET_BASE}"`);
  } catch (err) {
    console.error('sheetsService.deleteCustomerRow error:', err.message);
    throw err;
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
      range: `${SHEET_BASE}!A:S`,
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
          cp:          row[BASE.CP]        || '',
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
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${SHEET_BASE}!${columnLetter(BASE.TELEFONO)}${rowIndex}`,    values: [[phone]]           },
          { range: `${SHEET_BASE}!${columnLetter(BASE.ULTIMO_MOV)}${rowIndex}`,  values: [[nowMXDatetime()]] },
        ],
      },
    });
  } catch (err) {
    console.error('sheetsService.updateCustomerPhone error:', err.message);
  }
}

// Tags válidos — solo estos valores pueden guardarse en Historial de tags
const VALID_TAGS = new Set(['Solo cuenta', 'Carrito abandonado', 'Compro', 'Recompra', 'newsletter']);

// Detecta cadenas que parecen fechas (YYYY-MM-DD, DD/MM/YYYY, YYYY-MM-DD HH:MM, etc.)
const DATE_LIKE = /^\d{2,4}[-/]\d{2}[-/\d]/;

/**
 * Agrega un tag al historial de tags (columna O) si no está ya presente.
 * Formato: "Creo cuenta, Carrito abandonado, Compro" (separados por coma).
 * - Valida que `tag` sea un valor conocido antes de escribir.
 * - Filtra fechas u otros valores inválidos que pudieran haber quedado en la columna.
 * - Siempre actualiza Último movimiento, aunque el tag ya exista.
 */
async function appendTag(rowIndex, tag) {
  // Rechazar cualquier valor que no sea un tag conocido (evita fechas u otros datos)
  if (!VALID_TAGS.has(tag)) {
    console.warn(`appendTag: valor inválido ignorado — "${tag}" no es un tag reconocido`);
    return;
  }

  try {
    const sheets = await getSheets();
    const col = columnLetter(BASE.TAGS); // O

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_BASE}!${col}${rowIndex}`,
    });
    const existing = res.data.values?.[0]?.[0] || '';

    // Limpiar valores históricos que parezcan fechas o no sean tags válidos
    const tags = existing
      ? existing.split(',').map(t => t.trim()).filter(t => t && VALID_TAGS.has(t) && !DATE_LIKE.test(t))
      : [];

    const alreadyExists = tags.includes(tag);
    if (!alreadyExists) tags.push(tag);

    // Siempre actualizar ULTIMO_MOV; solo reescribir TAGS si hubo cambio
    const batchData = [
      { range: `${SHEET_BASE}!${columnLetter(BASE.ULTIMO_MOV)}${rowIndex}`, values: [[nowMXDatetime()]] },
    ];
    if (!alreadyExists) {
      batchData.push({ range: `${SHEET_BASE}!${col}${rowIndex}`, values: [[tags.join(', ')]] });
    }

    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: { valueInputOption: 'USER_ENTERED', data: batchData },
    });
  } catch (err) {
    console.error('sheetsService.appendTag error:', err.message);
  }
}

/**
 * Actualiza "Acepta email mkt" (columna E) de una fila.
 * Valor típico: 'SI' o 'NO'.
 */
async function updateEmailMarketing(rowIndex, value) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${SHEET_BASE}!${columnLetter(BASE.ACE_EMAIL)}${rowIndex}`,   values: [[value]]           },
          { range: `${SHEET_BASE}!${columnLetter(BASE.ULTIMO_MOV)}${rowIndex}`,  values: [[nowMXDatetime()]] },
        ],
      },
    });
  } catch (err) {
    console.error('sheetsService.updateEmailMarketing error:', err.message);
  }
}

/**
 * Actualiza el email (columna C) de una fila existente.
 * Usado cuando un cliente nuevo proporciona su email al final del onboarding.
 */
async function updateCustomerEmail(rowIndex, email) {
  try {
    const sheets = await getSheets();
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: [
          { range: `${SHEET_BASE}!${columnLetter(BASE.EMAIL)}${rowIndex}`,       values: [[email]]           },
          { range: `${SHEET_BASE}!${columnLetter(BASE.ULTIMO_MOV)}${rowIndex}`,  values: [[nowMXDatetime()]] },
        ],
      },
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

/** Retorna fecha y hora actual en México con formato YYYY-MM-DD HH:MM. */
function nowMXDatetime() {
  // sv-SE produce "YYYY-MM-DD HH:MM:SS"; tomamos los primeros 16 caracteres
  return new Date()
    .toLocaleString('sv-SE', { timeZone: 'America/Mexico_City' })
    .substring(0, 16);
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
  limpiarNombre,
  formatPhoneForStorage,
  findCustomer,
  findCustomerByEmail,
  registerCustomer,
  deleteCustomerRow,
  updateCustomerPhone,
  updateCustomerEmail,
  updateOrderData,
  appendConversationLog,
  updateSegmento,
  appendTag,
  updateEmailMarketing,
  findCityInSucursales,
  findColoniaInRutas,
  addSeguimiento,
};
