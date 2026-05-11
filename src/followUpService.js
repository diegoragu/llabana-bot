const sessionManager    = require('./sessionManager');
const sheetsService     = require('./sheetsService');
const twilioService     = require('./twilioService');
const transcriptService = require('./transcriptService');

function getRedis() {
  return sessionManager.getRedisClient?.() || null;
}

// ── Constantes ────────────────────────────────────────────────────────────────

const DOS_HORAS         = 2  * 60 * 60 * 1000;
const VEINTITRES_HORAS  = 23 * 60 * 60 * 1000;

// Estados que activan Follow-up A (cliente activo)
const ESTADOS_ACTIVO = new Set(['active', 'confirming_escalation']);

// Estados que activan Follow-up C (cliente escalado)
const ESTADOS_ESCALADO = new Set(['waiting_for_wig', 'escalated']);

// ── Mensajes ──────────────────────────────────────────────────────────────────

function buildFollowUpA(nombre, session) {
  const first = nombre ? nombre.split(' ')[0] : '';
  const history = session?.conversationHistory || [];

  const ultimoMensajeBot = history
    .filter(m => m.role === 'assistant')
    .map(m => m.content)
    .slice(-1)[0] || '';

  const ultimoMensajeCliente = history
    .filter(m => m.role === 'user')
    .map(m => m.content)
    .filter(c => c && c.length > 4)
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

function buildFollowUpC(nombre) {
  const first = nombre ? nombre.split(' ')[0] : '';
  return `Hola${first ? ` ${first}` : ''} 👋 Solo quería confirmarte que tu solicitud sigue registrada con nosotros 🙌\n\n¿Ya pudiste hablar con nuestro asesor? Queremos asegurarnos de que quedaste bien atendido 😊`;
}

// ── Redis helpers ─────────────────────────────────────────────────────────────

const _memFallback = new Set();

async function yaEnviado(key) {
  const redis = getRedis();
  if (!redis) return _memFallback.has(key);
  try {
    return !!(await redis.get(key));
  } catch {
    return _memFallback.has(key);
  }
}

async function marcarEnviado(key, ttlSeconds) {
  _memFallback.add(key);
  const redis = getRedis();
  if (!redis) return;
  try {
    await redis.set(key, '1', 'EX', ttlSeconds);
  } catch (err) {
    console.error('[FOLLOWUP] Redis mark error:', err.message);
  }
}

// ── Horario válido ────────────────────────────────────────────────────────────

function dentroDeHorario() {
  const ahora = new Date();
  const hora = parseInt(ahora.toLocaleString('en-US', {
    timeZone: 'America/Mexico_City',
    hour: 'numeric',
    hour12: false,
  }));
  const dia = ahora.toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    weekday: 'long',
  });

  if (dia === 'domingo') return false;
  if (dia === 'sábado') return hora >= 9 && hora < 14;
  return hora >= 9 && hora < 21;
}

function dentroDeHorarioFollowUpA() {
  const ahora = new Date();
  const hora = parseInt(ahora.toLocaleString('en-US', {
    timeZone: 'America/Mexico_City',
    hour: 'numeric',
    hour12: false,
  }));
  const dia = ahora.toLocaleString('es-MX', {
    timeZone: 'America/Mexico_City',
    weekday: 'long',
  });

  if (dia === 'domingo') return false;
  if (dia === 'sábado') return hora >= 9 && hora < 14;
  return hora >= 9 && hora < 19; // L-V solo hasta 7pm
}

// ── Enviar y registrar ────────────────────────────────────────────────────────

async function enviarFollowUp(phone, mensaje, nombre, tipo, flowState) {
  try {
    await twilioService.sendMessage(phone, mensaje);
    console.log(`📲 [FOLLOWUP-${tipo}] Enviado a ${phone} | nombre: ${nombre} | estado: ${flowState}`);

    // Guardar en transcript
    try {
      const telLimpio = phone.replace('whatsapp:', '');
      const existente = await transcriptService.getExistingTranscript(telLimpio);
      const lineas = existente ? existente.split('\n').filter(Boolean) : [];
      lineas.push(`Bot: [Follow-up ${tipo}] ${mensaje}`);
      await transcriptService.updateTranscript(telLimpio, nombre, lineas.join('\n'));
    } catch (err) {
      console.error(`❌ [FOLLOWUP-${tipo}] Error guardando transcript:`, err.message);
    }

    // Registrar en Sheets pestaña 4
    await sheetsService.addSeguimiento(
      phone.replace('whatsapp:', ''),
      nombre,
      `Follow-up ${tipo}`,
      `Estado: ${flowState}`
    );
  } catch (err) {
    console.error(`❌ [FOLLOWUP-${tipo}] Error enviando a ${phone}:`, err.message);
  }
}

// ── Loop principal ────────────────────────────────────────────────────────────

async function runFollowUps() {
  if (!dentroDeHorario()) return;

  try {
    const sessions = await sessionManager.getAllActiveSessions();
    const ahora = Date.now();

    const sesionesArr = [...sessions];
    const totalSesiones = sesionesArr.length;
    const escaladas = sesionesArr.filter(([, s]) => ESTADOS_ESCALADO.has(s.flowState));
    console.log(`[FOLLOWUP] Revisando ${totalSesiones} sesiones | ${escaladas.length} escaladas`);

    // Log detallado de sesiones escaladas para diagnóstico
    for (const [phone, s] of escaladas) {
      const inactivo = Date.now() - (s.lastActivity || 0);
      const keyC = `followup:C:${phone}`;
      const yaEnv = await yaEnviado(keyC);
      console.log(`[FOLLOWUP-C-DEBUG] ${phone} | inactivo: ${Math.round(inactivo/3600000)}h | yaEnviado: ${yaEnv} | flowState: ${s.flowState}`);
    }

    for (const [phone, session] of sessions) {
      const inactivo = ahora - (session.lastActivity || 0);
      const nombre = session.customer?.name?.split(' ')[0]
        || session.tempData?.name?.split(' ')[0]
        || '';

      // ── Follow-up A — cliente activo 2h sin respuesta ──────────────────────
      if (ESTADOS_ACTIVO.has(session.flowState) &&
          !ESTADOS_ESCALADO.has(session.flowState) &&
          inactivo >= DOS_HORAS &&
          dentroDeHorarioFollowUpA()) {
        const keyA = `followup:A:${phone}`;
        if (!(await yaEnviado(keyA))) {
          const mensaje = buildFollowUpA(nombre, session);
          await enviarFollowUp(phone, mensaje, nombre, 'A', session.flowState);
          await marcarEnviado(keyA, 86400); // no repetir en 24h
        }
      }

      // ── Follow-up C — cliente escalado 23h sin atención ───────────────────
      if (ESTADOS_ESCALADO.has(session.flowState) && inactivo >= VEINTITRES_HORAS) {
        const keyC = `followup:C:${phone}`;
        if (!(await yaEnviado(keyC))) {
          const mensaje = buildFollowUpC(nombre);
          await enviarFollowUp(phone, mensaje, nombre, 'C', session.flowState);
          await marcarEnviado(keyC, 86400 * 7); // no repetir en 7 días

          // Marcar en sesión para detectar su respuesta en botLogic
          await sessionManager.updateSession(phone, {
            tempData: { ...session.tempData, followupCEnviado: true },
          });
        }
      }
    }
  } catch (err) {
    console.error('❌ [FOLLOWUP] Error en runFollowUps:', err.message);
  }
}

module.exports = { runFollowUps };
