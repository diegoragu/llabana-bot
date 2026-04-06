const twilio = require('twilio');

console.log('📱 Twilio FROM number:', process.env.TWILIO_WHATSAPP_NUMBER);

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

/**
 * Envía un mensaje de WhatsApp vía Twilio.
 * @param {string} to  - Número destino en formato whatsapp:+521234567890
 * @param {string} body - Cuerpo del mensaje
 */
async function sendMessage(to, body) {
  const msg = await client.messages.create({
    from: process.env.TWILIO_WHATSAPP_NUMBER,
    to,
    body,
  });
  return msg;
}

module.exports = { sendMessage };
