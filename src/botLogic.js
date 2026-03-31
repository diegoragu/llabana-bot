/**
 * Lógica central del bot de Llabana.
 *
 * Flujo cliente NUEVO:
 *   [primer mensaje]  → greeting + pregunta especie → asking_species
 *   asking_species    → guarda especie, pide nombre  → asking_name
 *   asking_name       → pide estado                  → asking_state
 *   asking_state      → valida México, pide ciudad   → asking_city | out_of_coverage
 *   asking_city       → informa canal (paquetería)   → asking_email
 *   asking_email      → registra en Sheets           → active
 *
 * Flujo cliente EXISTENTE (encontrado por teléfono):
 *   active → conversación libre con Claude
 *          → escalación a Wig: mayoreo, quejas, enojados
 *
 * NOTA: Todos los clientes van a paquetería / llabanaenlinea.com por ahora.
 * La lógica de rutas y sucursales se activará después.
 */

const sessionManager = require('./sessionManager');
const sheetsService  = require('./sheetsService');
const claudeService  = require('./claudeService');
const twilioService  = require('./twilioService');

// ── Constantes ────────────────────────────────────────────────────────────────

const OUTSIDE_MEXICO_PATTERNS = [
  /estados\s*unidos/i, /\busa\b/i, /\bee\.?\s*uu\.?\b/i,
  /\bguatemala\b/i,    /\bcolombia\b/i,  /\bvenezuela\b/i,
  /\bargentina\b/i,    /espa[ñn]a/i,     /canad[aá]/i,
  /\bchile\b/i,        /per[uú]/i,       /\bcuba\b/i,
  /\bhonduras\b/i,     /el\s*salvador/i, /\bnicaragua\b/i,
  /costa\s*rica/i,     /panam[aá]/i,     /\bbrasil\b/i,
  /\bbolivia\b/i,      /\becuador\b/i,   /\buruguay\b/i,
];

const SKIP_EMAIL_PATTERNS = [
  /^no$/i, /^nop$/i, /^nope$/i, /^omitir$/i, /^omite$/i,
  /^sin correo$/i, /^no tengo$/i, /^no quiero$/i, /^skip$/i,
  /^da igual$/i, /^no gracias$/i, /^paso$/i, /^ninguno$/i,
  /^no es necesario$/i,
];

// Canal fijo por ahora — se habilitará lógica de rutas/sucursales después
const CHANNEL_PAQUETERIA = {
  channel: 'paqueteria',
  detail:  'Nacional',
  message: 'Te mandamos por paquetería a todo México 📦 Puedes hacer tu pedido en llabanaenlinea.com',
};

const OUT_OF_COVERAGE_MSG =
  'Gracias por escribirnos 🙏 Por ahorita solo manejamos entregas en México, ' +
  'no te podríamos surtir. Cuando estés por acá con gusto te ayudamos 🌾';

function isOutsideMexico(text) {
  return OUTSIDE_MEXICO_PATTERNS.some(re => re.test(text));
}

function wantsToSkipEmail(text) {
  return SKIP_EMAIL_PATTERNS.some(re => re.test(text.trim()));
}

function isValidEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

// ── Punto de entrada ──────────────────────────────────────────────────────────

async function handleMessage(phone, messageBody) {
  let session = sessionManager.getSession(phone);

  if (!session) {
    session = sessionManager.createSession(phone);

    const customer = await sheetsService.findCustomer(phone);

    if (customer) {
      sessionManager.updateSession(phone, { flowState: 'active', customer });
      sheetsService.appendConversationLog(phone, '[inicio sesión]', `Bienvenida enviada a ${customer.name}`).catch(() => {});

      const nombre = customer.name || '';
      return nombre
        ? `¡Hola ${nombre}! 👋 Qué gusto verte de nuevo. ¿En qué te ayudo?`
        : '¡Hola! 👋 Qué gusto verte de nuevo. ¿En qué te ayudo?';
    } else {
      sessionManager.updateSession(phone, { flowState: 'asking_species' });
      return (
        '¡Hola! 👋 Soy el asistente de Llabana, alimento balanceado para todo tipo de animales 🌾\n' +
        '¿Para qué animal estás buscando el alimento? 🐾'
      );
    }
  }

  switch (session.flowState) {
    case 'asking_species':  return handleAskingSpecies(phone, messageBody, session);
    case 'asking_name':     return handleAskingName(phone, messageBody, session);
    case 'asking_state':    return handleAskingState(phone, messageBody, session);
    case 'asking_city':     return handleAskingCity(phone, messageBody, session);
    case 'asking_email':    return handleAskingEmail(phone, messageBody, session);
    case 'active':          return handleActive(phone, messageBody, session);
    case 'out_of_coverage': return OUT_OF_COVERAGE_MSG;
    case 'escalated':
      return 'Tu mensaje ya fue enviado a un asesor. Pronto te contactan 🤝';
    default:
      sessionManager.deleteSession(phone);
      return 'Algo salió mal. Escríbeme de nuevo.';
  }
}

// ── Onboarding ────────────────────────────────────────────────────────────────

async function handleAskingSpecies(phone, message, session) {
  session.tempData.species = message.trim();
  sessionManager.updateSession(phone, { flowState: 'asking_name', tempData: session.tempData });
  return '¿Cómo te llamas?';
}

async function handleAskingName(phone, message, session) {
  const name = message.trim();
  if (name.length < 2) return '¿Cómo te llamas?';

  session.tempData.name = capitalize(name);
  sessionManager.updateSession(phone, { flowState: 'asking_state', tempData: session.tempData });

  return `Qué bueno, ${session.tempData.name}. ¿De qué estado eres?`;
}

async function handleAskingState(phone, message, session) {
  const state = message.trim();
  if (state.length < 2) return '¿De qué estado eres?';

  // Validar cobertura México — si está fuera, NO registrar
  if (isOutsideMexico(state)) {
    sessionManager.updateSession(phone, { flowState: 'out_of_coverage' });
    return OUT_OF_COVERAGE_MSG;
  }

  session.tempData.state = capitalize(state);
  sessionManager.updateSession(phone, { flowState: 'asking_city', tempData: session.tempData });

  return '¿Y de qué ciudad o municipio?';
}

async function handleAskingCity(phone, message, session) {
  const city = message.trim();
  if (city.length < 2) return '¿De qué ciudad o municipio?';

  session.tempData.city = capitalize(city);
  sessionManager.updateSession(phone, { flowState: 'asking_email', tempData: session.tempData });

  return (
    `${CHANNEL_PAQUETERIA.message}\n\n` +
    `¿Me compartes tu correo para mandarte información y promociones? 📧\n` +
    `No es obligatorio`
  );
}

// ── Email (opcional) ──────────────────────────────────────────────────────────

async function handleAskingEmail(phone, message, session) {
  const input = message.trim();
  const { name, state, city, species } = session.tempData;

  if (wantsToSkipEmail(input)) {
    const customerData = buildCustomerData(phone, { name, state, city, species });
    await registerAndActivate(phone, session, customerData);
    return `Listo ${name}, ya te tenemos. ¿En qué te ayudo?`;
  }

  if (!isValidEmail(input)) {
    return (
      'Ese correo no se ve bien. ¿Lo revisas?\n' +
      '(o escribe "no" si no quieres darlo)'
    );
  }

  const email = input.toLowerCase();
  const existing = await sheetsService.findCustomerByEmail(email);

  if (existing) {
    // Cliente reconocido por email con número nuevo
    await sheetsService.updateCustomerPhone(existing.rowIndex, phone);
    sheetsService.appendConversationLog(phone, '[reconocido por email]', `Tel actualizado. Bienvenida a ${existing.name}`).catch(() => {});

    const customer = { ...existing, phone, ...CHANNEL_PAQUETERIA, species };
    sessionManager.updateSession(phone, { flowState: 'active', customer, tempData: {} });
    console.log(`🔄 Reconocido por email: ${existing.name} (nuevo tel: ${phone})`);

    return (
      `¡Ya te conocemos, ${existing.name}! 🎉\n` +
      `${CHANNEL_PAQUETERIA.message}\n\n` +
      `¿En qué te ayudo?`
    );
  }

  // Email nuevo → registrar con email
  const customerData = buildCustomerData(phone, { name, state, city, species, email });
  await registerAndActivate(phone, session, customerData);

  return (
    `Listo ${name}, ya te tenemos. Te avisamos a *${email}*.\n` +
    `¿En qué te ayudo?`
  );
}

// ── Conversación libre con Claude ─────────────────────────────────────────────

async function handleActive(phone, message, session) {
  session.conversationHistory.push({ role: 'user', content: message });

  let response;
  try {
    response = await claudeService.chat(session.conversationHistory, session.customer);
  } catch (err) {
    console.error('claudeService.chat error:', err.message);
    return 'Tuve un problema técnico. ¿Me repites lo que necesitas?';
  }

  if (response.includes('ESCALAR_A_WIG')) {
    sheetsService.updateSegmento(phone, 'Mayoreo / Reventa').catch(() => {});
    await notifyWig(phone, session);
    sessionManager.updateSession(phone, { flowState: 'escalated' });
    return 'Ahorita te conecto con un asesor 🙌';
  }

  session.conversationHistory.push({ role: 'assistant', content: response });
  sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
  sheetsService.appendConversationLog(phone, message, response).catch(() => {});

  return response;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildCustomerData(phone, { name, state, city, species = '', email = '' }) {
  return {
    phone,
    name,
    email,
    state,
    city,
    colonia:       '',
    species,
    channel:       CHANNEL_PAQUETERIA.channel,
    channelDetail: CHANNEL_PAQUETERIA.detail,
    segmento:      'Lead frío',
  };
}

async function registerAndActivate(phone, session, customerData) {
  try {
    await sheetsService.registerCustomer(customerData);
  } catch (err) {
    console.error('Error al registrar cliente:', err.message);
  }

  sessionManager.updateSession(phone, {
    flowState: 'active',
    customer:  customerData,
    tempData:  {},
  });
}

async function notifyWig(phone, session) {
  const wigNumber = process.env.WIG_WHATSAPP_NUMBER;
  if (!wigNumber) {
    console.warn('WIG_WHATSAPP_NUMBER no configurado.');
    return;
  }

  const customer   = session.customer || {};
  const history    = session.conversationHistory.slice(-8);
  const transcript = history
    .map(m => `${m.role === 'user' ? '👤' : '🤖'}: ${m.content}`)
    .join('\n');

  const msg =
    `🚨 *ESCALACIÓN*\n\n` +
    `📱 Tel:      ${phone}\n` +
    `👤 Nombre:   ${customer.name    || 'N/D'}\n` +
    `📍 Ubicación: ${customer.city   || 'N/D'}, ${customer.state || 'N/D'}\n` +
    `🐾 Especie:  ${customer.species || 'N/D'}\n` +
    `🏷️ Segmento: ${customer.segmento || 'N/D'}\n\n` +
    `*Conversación:*\n${transcript}`;

  try {
    await twilioService.sendMessage(wigNumber, msg);
    console.log(`📲 Wig notificado — ${phone}`);
  } catch (err) {
    console.error('Error notificando a Wig:', err.message);
  }
}

function capitalize(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = { handleMessage };
