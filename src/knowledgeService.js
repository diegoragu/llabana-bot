const { google } = require('googleapis');

const SPREADSHEET_ID  = process.env.GOOGLE_SHEETS_ID;
const SHEET_FAQS      = '6 FAQs';
const SHEET_PRODUCTOS = '7 Productos';

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
}

async function getSheets() {
  return google.sheets({ version: 'v4', auth: getAuth() });
}

// Cache con TTL de 30 minutos para no consultar Sheets en cada mensaje
let _kbCache     = null;
let _kbCacheTime = null;
let _prodCache     = null;
let _prodCacheTime = null;
const CACHE_TTL = 30 * 60 * 1000;

/**
 * Lee la pestaña "6 FAQs" completa y retorna como texto formateado.
 * Formato esperado: columna A = sección, columna B = descripción.
 */
async function getKnowledgeBase() {
  if (_kbCache && _kbCacheTime && Date.now() - _kbCacheTime < CACHE_TTL) {
    return _kbCache;
  }
  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_FAQS}!A:B`,
    });
    const rows = (res.data.values || []).slice(1); // skip header
    const text = rows
      .filter(r => r[0] && r[1])
      .map(r => `${r[0].toUpperCase()}: ${r[1]}`)
      .join('\n');
    _kbCache     = text;
    _kbCacheTime = Date.now();
    console.log(`📚 Knowledge Base cargada: ${rows.length} entradas`);
    return text;
  } catch (err) {
    console.error('knowledgeService.getKnowledgeBase error:', err.message);
    return '';
  }
}

/**
 * Busca productos relevantes en "7 Productos" por especie o palabras clave.
 * Retorna máximo 3 productos formateados como texto.
 * Columnas: A=Precio, B=Producto, C=Especie, D=Marca, E=Presentacion,
 *           F=Peso, G=Descripcion, H=Usos, I=Etapa, J=Competencia,
 *           K=Palabras clave, L=Link
 */
async function getProductosPorEspecie(query) {
  const cacheKey = query.toLowerCase();
  if (_prodCache?.[cacheKey] && _prodCacheTime &&
      Date.now() - _prodCacheTime < CACHE_TTL) {
    return _prodCache[cacheKey];
  }

  try {
    const sheets = await getSheets();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_PRODUCTOS}!A:L`,
    });
    const rows = (res.data.values || []).slice(1);
    const queryLower = query.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    const relevantes = rows.filter(r => {
      const especie  = (r[2]  || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const keywords = (r[10] || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      const producto = (r[1]  || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      return especie.includes(queryLower) ||
             keywords.includes(queryLower) ||
             queryLower.includes(especie) ||
             producto.includes(queryLower);
    }).slice(0, 3);

    if (relevantes.length === 0) return '';

    const texto = relevantes.map(r => [
      `Producto: ${r[1] || ''}`,
      r[3]  ? `Marca: ${r[3]}`                       : '',
      r[0]  ? `Precio: ${r[0]}`                      : '',
      r[5]  ? `Presentación: ${r[4] || ''} ${r[5]}`  : '',
      r[6]  ? `Descripción: ${r[6]}`                 : '',
      r[7]  ? `Ideal para: ${r[7]}`                  : '',
      r[8]  ? `Etapa: ${r[8]}`                       : '',
      r[11] ? `Link: ${r[11]}`                       : '',
    ].filter(Boolean).join(' | ')).join('\n');

    if (!_prodCache) _prodCache = {};
    _prodCache[cacheKey] = texto;
    _prodCacheTime = Date.now();
    return texto;
  } catch (err) {
    console.error('knowledgeService.getProductosPorEspecie error:', err.message);
    return '';
  }
}

/**
 * Invalida el cache — llamar cuando se actualice el Sheets.
 */
function invalidateCache() {
  _kbCache     = null;
  _kbCacheTime = null;
  _prodCache     = null;
  _prodCacheTime = null;
  console.log('📚 Cache de Knowledge Base invalidado');
}

module.exports = { getKnowledgeBase, getProductosPorEspecie, invalidateCache };
