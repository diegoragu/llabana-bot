const sessionManager    = require('./sessionManager');
const sheetsService     = require('./sheetsService');
const twilioService     = require('./twilioService');
const transcriptService = require('./transcriptService');

const redis = sessionManager.getRedisClient?.() || null;

// Estados que ameritan seguimiento
const ESTADOS_SEGUIMIENTO = new Set([
  'active', 'confirming_escalation'
]);

function buildFollowUpMessage(nombre, session) {
  const first = nombre ? nombre.split(' ')[0] : '';
  const history = session?.conversationHistory || [];

  const ultimoMensajeCliente = history
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .filter(c => c && c.length > 4)
    .slice(-1)[0] || '';

  const ultimoMensajeBot = history
    .filter(m => m.role === 'assistant')
    .map(m => m.content)
    .slice(-1)[0] || '';

  const productoMencionado = ultimoMensajeBot.match(/\*([^*]+)\*/)?.[1] || '';

  if (productoMencionado) {
    return `Oye${first ? ` ${first}` : ''} 👋 ¿pudiste ver la info del *${productoMencionado}* que te compartí? Aquí sigo por si tienes dudas o quieres hacer tu pedido 🌾`;
  }

  if (ultimoMensajeCliente.length > 10) {
    const resumen = ultimoMensajeCliente.substring(0, 60);
    return `Oye${first ? ` ${first}` : ''} 👋 quedé pendiente de ayudarte con "${resumen}..." ¿Pudiste encontrar lo que buscabas? 🌾`;
  }

  return `Oye${first ? ` ${first}` : ''} 👋 ¿en qué más te puedo ayudar? Aquí sigo por si tienes alguna duda 🌾`;
}

// Fallback en memoria si no hay Redis
const seguimientosEnviados = new Set();

async function yaEnviadoHoy(phone) {
  if (!redis) return seguimientosEnviados.has(phone);
  try {
    const val = await redis.get(`followup:sent:${phone}`);
    return !!val;
  } catch {
    return seguimientosEnviados.has(phone);
  }
}

async function marcarEnviado(phone) {
  seguimientosEnviados.add(phone); // fallback memoria
  if (!redis) return;
  try {
    await redis.set(`followup:sent:${phone}`, '1', 'EX', 86400);
  } catch (err) {
    console.error('[FOLLOWUP] Redis mark error:', err.message);
  }
}

async function runFollowUps() {
  try {
    const sessions = await sessionManager.getAllActiveSessions();
    const ahora = Date.now();
    const DOS_HORAS = 2 * 60 * 60 * 1000;

    for (const [phone, session] of sessions) {
      // Solo estados relevantes
      if (!ESTADOS_SEGUIMIENTO.has(session.flowState)) continue;

      // Ya se le envió seguimiento hoy
      if (await yaEnviadoHoy(phone)) continue;

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

      const mensaje = buildFollowUpMessage(nombre, session);

      try {
        await twilioService.sendMessage(phone, mensaje);
        await marcarEnviado(phone);

        console.log(`📲 [FOLLOWUP] Seguimiento enviado a ${phone} | nombre: ${nombre} | inactivo: ${Math.round(inactivo/60000)} min`);

        // Guardar en transcript para que aparezca en el dashboard
        try {
          const telLimpio = phone.replace('whatsapp:', '');
          const existente = await transcriptService.getExistingTranscript(telLimpio);
          const lineas = existente
            ? existente.split('\n').filter(Boolean)
            : [];
          lineas.push(`Bot: [Follow-up] ${mensaje}`);
          await transcriptService.updateTranscript(
            telLimpio,
            nombre,
            lineas.join('\n')
          );
        } catch (err) {
          console.error(`❌ [FOLLOWUP] Error guardando transcript:`, err.message);
        }

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
