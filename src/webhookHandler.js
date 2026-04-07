const botLogic    = require('./botLogic');
const twilioService = require('./twilioService');
const { updateTranscript, getExistingTranscript } = require('./transcriptService');
const sessionManager = require('./sessionManager');

/**
 * Maneja el webhook POST de Twilio para mensajes de WhatsApp entrantes.
 *
 * Twilio envía un body form-encoded con estos campos clave:
 *   From  → número del remitente (ej. whatsapp:+521234567890)
 *   To    → número del bot
 *   Body  → texto del mensaje
 *
 * Respondemos con 200 inmediatamente para evitar timeouts de Twilio (15s),
 * y procesamos el mensaje de forma asíncrona.
 *
 * Debounce: acumula mensajes del mismo número durante 3s antes de procesar,
 * para manejar mensajes enviados en ráfaga como un solo input concatenado.
 */

// Deduplicación: guarda los últimos 100 MessageSid procesados
const processedSids = new Set();
const MAX_SIDS = 100;

const chatLogs = new Map();

// Debounce: { from → { timer, messages[] } }
const pendingMessages = new Map();

async function procesarMensaje(from, body) {
  try {
    if (!chatLogs.has(from)) {
      const previo = await getExistingTranscript(from);
      const lines = previo ? previo.split('\n').filter(Boolean) : [];
      chatLogs.set(from, { lines, lastActivity: Date.now() });
    }
    const log = chatLogs.get(from);
    log.lines.push(`Cliente: ${body}`);
    log.lastActivity = Date.now();

    const reply = await botLogic.handleMessage(from, body);
    await twilioService.sendMessage(from, reply);

    log.lines.push(`Bot: ${reply}`);
    console.log(`📤 [${from}]: ${reply.substring(0, 120)}${reply.length > 120 ? '…' : ''}`);

    const session = sessionManager.getSession(from);
    const nombre = session?.customer?.name || session?.tempData?.name || '';
    const telefono = from.replace('whatsapp:', '');
    await updateTranscript(telefono, nombre, log.lines.join('\n'));
  } catch (err) {
    console.error(`❌ Error procesando mensaje de ${from}:`, err);
    try {
      await twilioService.sendMessage(
        from,
        'Disculpa, tuve un problema técnico. Por favor intenta de nuevo en un momento.'
      );
    } catch (sendErr) {
      console.error('Error enviando mensaje de fallo:', sendErr.message);
    }
  }
}

async function webhookHandler(req, res) {
  // Responder a Twilio de inmediato
  res.status(200).send('');

  // Deduplicar por MessageSid para evitar doble procesamiento
  const sid = req.body?.MessageSid;
  if (sid) {
    if (processedSids.has(sid)) {
      console.log(`⚠️  SID duplicado ignorado: ${sid}`);
      return;
    }
    processedSids.add(sid);
    if (processedSids.size > MAX_SIDS) {
      processedSids.delete(processedSids.values().next().value);
    }
  }

  const from = req.body?.From;
  const body = (req.body?.Body || '').trim();

  if (!from || !body) {
    console.log('Webhook recibido sin From o Body:', JSON.stringify(req.body));
    return;
  }

  console.log(`📨 [${from}]: ${body}`);

  // Registrar mensaje individual en el log antes del debounce
  if (!chatLogs.has(from)) {
    getExistingTranscript(from).then(previo => {
      const lines = previo ? previo.split('\n').filter(Boolean) : [];
      if (!chatLogs.has(from)) chatLogs.set(from, { lines, lastActivity: Date.now() });
    }).catch(() => {});
  }

  // Debounce: acumular mensajes y procesar tras 3s de silencio
  // Si el bot ya respondió desde el último mensaje, no concatenar con mensajes anteriores
  const existing = pendingMessages.get(from);
  const pending = (existing && !existing.respondido)
    ? existing
    : { timer: null, messages: [], respondido: false };

  pending.messages.push(body);
  pending.respondido = false;
  if (pending.timer) clearTimeout(pending.timer);

  pending.timer = setTimeout(async () => {
    const accumulated = pendingMessages.get(from);
    if (!accumulated) return;
    const mensajeCompleto = accumulated.messages.join(' ');
    pendingMessages.delete(from);
    await procesarMensaje(from, mensajeCompleto);
    // Marcar que el bot ya respondió para el próximo mensaje
    const curr = pendingMessages.get(from);
    if (curr) curr.respondido = true;
  }, 3000);

  pendingMessages.set(from, pending);
}

module.exports = webhookHandler;
