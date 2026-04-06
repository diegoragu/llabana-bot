const botLogic    = require('./botLogic');
const twilioService = require('./twilioService');

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

async function webhookHandler(req, res) {
  console.log('=== TWILIO FULL BODY ===', JSON.stringify(req.body, null, 2));

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

  console.log('TWILIO PAYLOAD COMPLETO:', JSON.stringify(req.body));

  const from = req.body?.From;
  const body = (req.body?.Body || '').trim();

  if (!from || !body) {
    console.log('Webhook recibido sin From o Body:', JSON.stringify(req.body));
    return;
  }

  const ref = (req.body?.ReferralBody || '').trim();
  console.log(`📨 [${from}]: ${body}${ref ? ` | ref: ${ref}` : ''}`);

  try {
    const reply = await botLogic.handleMessage(from, body, ref);
    await twilioService.sendMessage(from, reply);
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

module.exports = webhookHandler;
