const botLogic    = require('./botLogic');
const twilioService = require('./twilioService');
const { saveTranscript } = require('./transcriptService');

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
 */

// Deduplicación: guarda los últimos 100 MessageSid procesados
const processedSids = new Set();
const MAX_SIDS = 100;

const chatLogs = new Map();

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

  try {
    if (!chatLogs.has(from)) chatLogs.set(from, { lines: [], lastActivity: Date.now() });
    const log = chatLogs.get(from);
    log.lines.push(`Cliente: ${body}`);
    log.lastActivity = Date.now();

    const reply = await botLogic.handleMessage(from, body);
    await twilioService.sendMessage(from, reply);

    log.lines.push(`Bot: ${reply}`);
    console.log(`📤 [${from}]: ${reply.substring(0, 120)}${reply.length > 120 ? '…' : ''}`);
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

setInterval(async () => {
  const TREINTA_MIN = 30 * 60 * 1000;
  const ahora = Date.now();
  for (const [phone, log] of chatLogs.entries()) {
    if (ahora - log.lastActivity > TREINTA_MIN) {
      await saveTranscript('', phone.replace('whatsapp:', ''), log.lines.join('\n'));
      chatLogs.delete(phone);
      console.log(`💾 Transcript guardado: ${phone}`);
    }
  }
}, 60 * 1000);

module.exports = webhookHandler;
