const sessionManager = require('./sessionManager');
const sheetsService  = require('./sheetsService');
const twilioService  = require('./twilioService');

// Estados que ameritan seguimiento
const ESTADOS_SEGUIMIENTO = new Set([
  'active', 'waiting_for_wig', 'confirming_escalation'
]);

// Mensajes de seguimiento variados
const FOLLOWUP_MSGS = [
  n => `Hola${n ? ` ${n}` : ''}! 👋 Solo quería saber si pudiste hacer tu pedido o si tienes alguna duda con la que te pueda ayudar 🌾`,
  n => `Hola${n ? ` ${n}` : ''}! ¿Pudiste encontrar lo que buscabas en la tienda? Si tienes alguna pregunta aquí estamos 😊`,
  n => `Hola${n ? ` ${n}` : ''}! 🌾 ¿Te puedo ayudar con algo más? Si tuviste algún problema con tu pedido con gusto te orientamos.`,
  n => `Hola${n ? ` ${n}` : ''}! Solo pasamos a ver si pudiste comprar o si el asesor ya te contactó. Cualquier duda aquí estamos 🙌`,
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Registro de seguimientos ya enviados para no duplicar
const seguimientosEnviados = new Set();

async function runFollowUps() {
  try {
    const sessions = await sessionManager.getAllActiveSessions();
    const ahora = Date.now();
    const DOS_HORAS = 2 * 60 * 60 * 1000;

    for (const [phone, session] of sessions) {
      // Solo estados relevantes
      if (!ESTADOS_SEGUIMIENTO.has(session.flowState)) continue;

      // Ya se le envió seguimiento en esta sesión
      if (seguimientosEnviados.has(phone)) continue;

      // Calcular inactividad
      const inactivo = ahora - (session.lastActivity || 0);
      if (inactivo < DOS_HORAS) continue;

      // No molestar de noche (10pm - 9am hora México)
      const horaMX = new Date().toLocaleString('en-US', {
        timeZone: 'America/Mexico_City',
        hour: 'numeric',
        hour12: false
      });
      const hora = parseInt(horaMX);
      if (hora >= 22 || hora < 9) continue;

      // Enviar seguimiento
      const nombre = session.customer?.name
        ? session.customer.name.split(' ')[0]
        : (session.tempData?.name?.split(' ')[0] || '');

      const mensaje = pick(FOLLOWUP_MSGS)(nombre);

      try {
        await twilioService.sendMessage(phone, mensaje);
        seguimientosEnviados.add(phone);

        console.log(`📲 [FOLLOWUP] Seguimiento enviado a ${phone} | nombre: ${nombre} | inactivo: ${Math.round(inactivo/60000)} min`);

        // Registrar en Sheets pestaña 4 Seguimientos
        await sheetsService.addSeguimiento(
          phone.replace('whatsapp:', ''),
          nombre,
          'Seguimiento automático 2h',
          `Estado: ${session.flowState}`
        );
      } catch (err) {
        console.error(`❌ [FOLLOWUP] Error enviando a ${phone}:`, err.message);
      }
    }
  } catch (err) {
    console.error('❌ [FOLLOWUP] Error en runFollowUps:', err.message);
  }
}

module.exports = { runFollowUps };
