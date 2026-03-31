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
async function webhookHandler(req, res) {
  // Responder a Twilio de inmediato
  res.status(200).send('');

  const from = req.body?.From;
  const body = (req.body?.Body || '').trim();

  if (!from || !body) {
    console.log('Webhook recibido sin From o Body:', JSON.stringify(req.body));
    return;
  }

  console.log(`📨 [${from}]: ${body}`);

  try {
    const reply = await botLogic.handleMessage(from, body);
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
