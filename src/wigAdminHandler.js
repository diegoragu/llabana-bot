const sheetsService  = require('./sheetsService');
const sessionManager = require('./sessionManager');

const AYUDA = `*Comandos Llabana Bot* 🤖

*/reparto* +521XXXXXXXXXX
→ Cliente compró, se entrega por reparto

*/sucursal* +521XXXXXXXXXX NombreSucursal
→ Cliente redirigido a sucursal

*/nocontesta* +521XXXXXXXXXX
→ Cliente no contestó

*/ayuda*
→ Ver esta lista

Ejemplos:
/reparto +5215512345678
/sucursal +5215512345678 Ecatepec
/nocontesta +5215512345678`;

function normalizePhoneForSearch(raw) {
  let n = (raw || '').replace(/\D/g, '');
  if (n.startsWith('521') && n.length === 13) n = n.substring(3);
  else if (n.startsWith('52') && n.length === 12) n = n.substring(2);
  if (n.length === 10) return `whatsapp:+52${n}`;
  return null;
}

async function handleWigCommand(body) {
  const texto = (body || '').trim();

  // Ayuda
  if (/^\/ayuda$/i.test(texto)) {
    return AYUDA;
  }

  // Parsear /reparto +521...
  const matchReparto = texto.match(
    /^\/reparto\s+(\S+)$/i
  );
  if (matchReparto) {
    const phone = normalizePhoneForSearch(matchReparto[1]);
    if (!phone) return `❌ Número inválido: ${matchReparto[1]}`;

    const cliente = await sheetsService.findCustomer(phone);
    if (!cliente) {
      return `❌ No encontré ese número en la base de datos.\nVerifica el número e intenta de nuevo.`;
    }

    const prevOrders = parseInt(cliente.totalOrders || '0') || 0;
    const segmento   = prevOrders > 0 ? 'Recompra' : 'Comprador';
    const tag        = prevOrders > 0 ? 'Recompra' : 'Compro';
    const nombre     = cliente.name || matchReparto[1];
    const ahora      = new Date().toLocaleDateString('sv-SE', {
      timeZone: 'America/Mexico_City'
    });

    await sheetsService.updateOrderData(cliente.rowIndex, {
      segmento,
      fechaCompra: ahora,
    });
    await sheetsService.appendTag(cliente.rowIndex, tag);
    await sheetsService.appendTag(cliente.rowIndex, 'Reparto');
    await sessionManager.deleteSession(phone);

    console.log(`🔧 [WIG-ADMIN] /reparto | ${nombre} | ${phone} → ${segmento}`);
    return `✅ Listo — *${nombre}* actualizado:\n- Segmento: ${segmento}\n- Tags: ${tag}, Reparto`;
  }

  // Parsear /sucursal +521... NombreSucursal
  const matchSucursal = texto.match(
    /^\/sucursal\s+(\S+)\s+(.+)$/i
  );
  if (matchSucursal) {
    const phone     = normalizePhoneForSearch(matchSucursal[1]);
    const nombreSuc = matchSucursal[2].trim();
    if (!phone)     return `❌ Número inválido: ${matchSucursal[1]}`;
    if (!nombreSuc) return `❌ Falta el nombre de la sucursal.\nEjemplo: /sucursal +5215512345678 Ecatepec`;

    const cliente = await sheetsService.findCustomer(phone);
    if (!cliente) {
      return `❌ No encontré ese número en la base de datos.`;
    }

    const nombre = cliente.name || matchSucursal[1];
    const tagSuc = `Sucursal ${nombreSuc}`;

    await sheetsService.updateOrderData(cliente.rowIndex, {
      segmento: 'Redirigido a Sucursal',
    });
    await sheetsService.appendTag(cliente.rowIndex, tagSuc);
    await sessionManager.deleteSession(phone);

    console.log(`🔧 [WIG-ADMIN] /sucursal | ${nombre} | ${phone} → ${tagSuc}`);
    return `✅ Listo — *${nombre}* actualizado:\n- Segmento: Redirigido a Sucursal\n- Tag: ${tagSuc}`;
  }

  // Parsear /nocontesta +521...
  const matchNoContesta = texto.match(
    /^\/nocontesta\s+(\S+)$/i
  );
  if (matchNoContesta) {
    const phone = normalizePhoneForSearch(matchNoContesta[1]);
    if (!phone) return `❌ Número inválido: ${matchNoContesta[1]}`;

    const cliente = await sheetsService.findCustomer(phone);
    if (!cliente) {
      return `❌ No encontré ese número en la base de datos.`;
    }

    const nombre = cliente.name || matchNoContesta[1];
    const ahora  = new Date().toLocaleDateString('sv-SE', {
      timeZone: 'America/Mexico_City'
    });

    await sheetsService.updateOrderData(cliente.rowIndex, {
      segmento: 'No Contestó',
      notas: `${cliente.notas || ''} | ${ahora}: No contestó`.trim(),
    });
    await sheetsService.appendTag(cliente.rowIndex, 'No Contestó');
    await sheetsService.addSeguimiento(
      phone.replace('whatsapp:', '').replace('+52', ''),
      nombre,
      'No contestó',
      'Registrado por Wig'
    );
    await sessionManager.deleteSession(phone);

    console.log(`🔧 [WIG-ADMIN] /nocontesta | ${nombre} | ${phone}`);
    return `📵 Listo — *${nombre}* marcado como No Contestó y guardado en Seguimientos.`;
  }

  // Comando no reconocido
  return `No entendí ese comando 🤔\nEscribe */ayuda* para ver los disponibles.`;
}

async function isWigCommand(from, body) {
  const wigNumber = process.env.WIG_WHATSAPP_NUMBER;
  if (!wigNumber) return false;
  const fromNorm = from.replace(/\D/g, '').slice(-10);
  const wigNorm  = wigNumber.replace(/\D/g, '').slice(-10);
  return fromNorm === wigNorm && /^\/\w/.test((body || '').trim());
}

module.exports = { handleWigCommand, isWigCommand };
