const fetch = require('node-fetch');

// Reutilizar el token del shopifyWebhookHandler no es posible porque están
// en módulos separados — este servicio maneja su propio token.

let _token = null;
let _tokenExpiry = null;

async function getToken() {
  if (_token && _tokenExpiry && Date.now() < _tokenExpiry) return _token;
  const storeUrl     = process.env.SHOPIFY_STORE_URL;
  const clientId     = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  const res = await fetch(`https://${storeUrl}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}`,
  });
  const data = await res.json();
  if (!data.access_token) throw new Error('No se pudo obtener token Shopify');
  _token = data.access_token;
  _tokenExpiry = Date.now() + ((data.expires_in ?? 86400) - 300) * 1000;
  return _token;
}

// Mapa de palabras clave a handles de colección
const ESPECIE_MAP = {
  'perro':          'perros',
  'perros':         'perros',
  'cachorro':       'perros',
  'cachorra':       'perros',
  'cachorros':      'perros',
  'cachorras':      'perros',
  'perrito':        'perros',
  'perritos':       'perros',
  'perrita':        'perros',
  'perritas':       'perros',
  'gato':           'gatos',
  'gatos':          'gatos',
  'gatito':         'gatos',
  'gatitos':        'gatos',
  'caballo':        'caballos',
  'caballos':       'caballos',
  'yegua':          'caballos',
  'yeguas':         'caballos',
  'potro':          'caballos',
  'potros':         'caballos',
  'equino':         'caballos',
  'equinos':        'caballos',
  'cerdo':          'cerdos',
  'cerdos':         'cerdos',
  'puerco':         'cerdos',
  'cerda':          'cerdos',
  'cerdas':         'cerdos',
  'porcino':        'cerdos',
  'porcina':        'cerdos',
  'porcinos':       'cerdos',
  'porcinas':       'cerdos',
  'cochino':        'cerdos',
  'cochinos':       'cerdos',
  'marrano':        'cerdos',
  'marranos':       'cerdos',
  'gestacion':      'cerdos',
  'gestación':      'cerdos',
  'lactancia':      'cerdos',
  'lechon':         'cerdos',
  'lechones':       'cerdos',
  'borrego':        'borregos',
  'borregos':       'borregos',
  'oveja':          'borregos',
  'ovejas':         'borregos',
  'ovino':          'borregos',
  'ovinos':         'borregos',
  'ave':            'aves-de-postura',
  'aves':           'aves-de-postura',
  'gallina':        'aves-de-postura',
  'gallinas':       'aves-de-postura',
  'pollo':          'aves-de-postura',
  'pollos':         'aves-de-postura',
  'postura':        'aves-de-postura',
  'gallo':          'gallos',
  'gallos':         'gallos',
  'pelea':          'gallos',
  'pez':            'peces',
  'peces':          'peces',
  'tilapia':        'peces',
  'trucha':         'peces',
  'carpas':         'peces',
  'bagre':          'peces',
  'salmon':         'peces',
  'conejo':         'conejos',
  'conejos':        'conejos',
  'coneja':         'conejos',
  'conejas':        'conejos',
  'codorniz':       'especialidades',
  'codornices':     'especialidades',
  'pavo':           'especialidades',
  'pavos':          'especialidades',
  'guajolote':      'especialidades',
  'roedor':         'especialidades',
  'roedores':       'especialidades',
  'ganado':         'ganado-de-engorda',
  'bovino':         'ganado-de-engorda',
  'bovinos':        'ganado-de-engorda',
  'becerro':        'ganado-de-engorda',
  'becerros':       'ganado-de-engorda',
  'novillo':        'ganado-de-engorda',
  'novillos':       'ganado-de-engorda',
  'engorda':        'ganado-de-engorda',
  'toro':           'ganado-de-engorda',
  'vaca':           'ganado-lechero',
  'vacas':          'ganado-lechero',
  'vaquillas':      'ganado-lechero',
  'leche':          'ganado-lechero',
  'lechero':        'ganado-lechero',
};

/**
 * Detecta la especie en un texto y retorna el handle de colección.
 * Retorna null si no detecta especie.
 */
function detectarEspecie(texto) {
  const lower = texto.toLowerCase();
  for (const [keyword, handle] of Object.entries(ESPECIE_MAP)) {
    if (lower.includes(keyword)) return handle;
  }
  return null;
}

/**
 * Consulta los primeros N productos de una colección por handle.
 * Retorna array de { title, price, url } o [] si hay error.
 */
async function getProductosPorEspecie(handle, limit = 3) {
  try {
    const storeUrl = process.env.SHOPIFY_STORE_URL;
    const token = await getToken();

    // Primero obtener el collection_id por handle
    const colRes = await fetch(
      `https://${storeUrl}/admin/api/2024-01/custom_collections.json?handle=${handle}&limit=1`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const colData = await colRes.json();
    const colId = colData.custom_collections?.[0]?.id;
    if (!colId) return [];

    // Luego obtener productos de esa colección
    const prodRes = await fetch(
      `https://${storeUrl}/admin/api/2024-01/products.json?collection_id=${colId}&limit=${limit}&status=active`,
      { headers: { 'X-Shopify-Access-Token': token } }
    );
    const prodData = await prodRes.json();
    const productos = prodData.products || [];

    return productos.map(p => ({
      title: p.title,
      price: p.variants?.[0]?.price || '0',
      url:   `https://llabanaenlinea.com/products/${p.handle}`,
    }));
  } catch (err) {
    console.error('shopifyService.getProductosPorEspecie error:', err.message);
    return [];
  }
}

module.exports = { detectarEspecie, getProductosPorEspecie };
