/**
 * Lógica central del bot de Llabana — flujo definitivo.
 *
 * Estados para cliente NUEVO (no encontrado por teléfono):
 *
 *   [primer msg]         → bienvenida + "¿Estás en México?"  → asking_mexico
 *   asking_mexico        → valida México                      → asking_returning | out_of_coverage
 *   asking_returning     → ¿ya compró antes?                 → asking_returning_email | asking_profile
 *   asking_returning_email → busca por email                 → active | asking_profile
 *   asking_profile       → elige qué busca (4 opciones)     → escalated | asking_state
 *   asking_state         → pide estado                       → asking_city
 *   asking_city          → REGISTRA EN SHEETS, informa canal → asking_email
 *   asking_email         → email opcional, actualiza Sheets  → active
 *   active               → Claude libre                      → escalated
 *
 * Cliente EXISTENTE (encontrado por teléfono):
 *   → saludo por nombre → active directamente
 *
 * Escalación a Wig: mayoreo/grandes cantidades (perfil), quejas, enojados (Claude).
 * Canal: todos a paquetería / llabanaenlinea.com (rutas/sucursales se activan después).
 * Teléfono guardado como +52XXXXXXXXXX (sin prefijo whatsapp:).
 */

const sessionManager = require('./sessionManager');
const sheetsService  = require('./sheetsService');
const claudeService  = require('./claudeService');
const twilioService  = require('./twilioService');

// ── Constantes y helpers de detección ────────────────────────────────────────

const WELCOME_MSG =
  '¡Hola! 👋 Soy el asistente de Llabana, tu aliado en alimento balanceado 🌾\n' +
  '¿Estás en México?';

const OUT_OF_COVERAGE_MSG =
  'Gracias por escribirnos 🙏 Por ahora solo tenemos entregas en México. ' +
  'Cuando estés por acá con gusto te ayudamos 🌾';

const PROFILE_MENU =
  '¿Qué estás buscando?\n\n' +
  '1️⃣  Comprar 1 o 2 bultos 🛒\n' +
  '2️⃣  Grandes cantidades 📦\n' +
  '3️⃣  Mayoreo o reventa 🚛\n' +
  '4️⃣  Otra consulta ❓';

const CHANNEL_PAQUETERIA = {
  channel: 'paqueteria',
  detail:  'Nacional',
  message: 'Te mandamos por paquetería a todo México 📦 Puedes hacer tu pedido en llabanaenlinea.com',
};

// Patrones para detectar que está fuera de México
const OUTSIDE_MEXICO_PATTERNS = [
  /estados\s*unidos/i, /\busa\b/i,       /\bee\.?\s*uu\.?\b/i,
  /\bguatemala\b/i,    /\bcolombia\b/i,  /\bvenezuela\b/i,
  /\bargentina\b/i,    /espa[ñn]a/i,     /canad[aá]/i,
  /\bchile\b/i,        /per[uú]/i,       /\bcuba\b/i,
  /\bhonduras\b/i,     /el\s*salvador/i, /\bnicaragua\b/i,
  /costa\s*rica/i,     /panam[aá]/i,     /\bbrasil\b/i,
  /\bbolivia\b/i,      /\becuador\b/i,   /\buruguay\b/i,
];

// Patrones para detectar que ya es cliente
const RETURNING_PATTERNS = [
  /^s[ií]$/i, /\bya\s+compr/i, /\bsoy\s+cliente/i, /\btengo\s+cuenta/i,
  /\bhe\s+compr/i, /\bcompré\b/i, /\bcompre\b/i, /\bcliente\b/i,
  /\bya\s+he\b/i, /\bantes\b/i, /\bregistrado\b/i,
];

// Patrones para escalación en perfil (mayoreo / grandes cantidades)
const ESCALATION_PROFILE_PATTERNS = [
  /^[23]$/, /grandes?\s*cantidad/i, /mayoreo/i, /reventa/i,
  /revendedor/i, /distribuidor/i, /por\s*mayor/i, /\bal\s*mayor\b/i,
];

// Patrones para omitir email
const SKIP_EMAIL_PATTERNS = [
  /^no$/i, /^nop$/i, /^nope$/i, /^omitir$/i, /^omite$/i, /^sin correo$/i,
  /^no tengo$/i, /^no quiero$/i, /^skip$/i, /^da igual$/i,
  /^no gracias$/i, /^paso$/i, /^ninguno$/i, /^no es necesario$/i,
];

function isOutsideMexico(text) {
  return /^no$/i.test(text.trim()) || OUTSIDE_MEXICO_PATTERNS.some(re => re.test(text));
}

function isReturningCustomer(text) {
  return RETURNING_PATTERNS.some(re => re.test(text.trim()));
}

function isEscalationProfile(text) {
  return ESCALATION_PROFILE_PATTERNS.some(re => re.test(text.trim()));
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

  // ── Sesión nueva: buscar cliente por teléfono ─────────────────────────────
  if (!session) {
    session = sessionManager.createSession(phone);
    const customer = await sheetsService.findCustomer(phone);

    if (customer) {
      // Cliente existente — saltar todo el onboarding
      sessionManager.updateSession(phone, { flowState: 'active', customer });
      sheetsService.appendConversationLog(
        phone, '[inicio sesión]', `Bienvenida enviada a ${customer.name}`
      ).catch(() => {});

      return customer.name
        ? `¡Hola ${customer.name}! 👋 Qué gusto verte de nuevo. ¿En qué te ayudo?`
        : '¡Hola! 👋 Qué gusto verte de nuevo. ¿En qué te ayudo?';
    }

    // Cliente nuevo — enviar mensaje de bienvenida exacto
    sessionManager.updateSession(phone, { flowState: 'asking_mexico' });
    return WELCOME_MSG;
  }

  // ── Rutear por estado ─────────────────────────────────────────────────────
  switch (session.flowState) {
    case 'asking_mexico':           return handleAskingMexico(phone, messageBody, session);
    case 'asking_returning':        return handleAskingReturning(phone, messageBody, session);
    case 'asking_returning_email':  return handleAskingReturningEmail(phone, messageBody, session);
    case 'asking_profile':          return handleAskingProfile(phone, messageBody, session);
    case 'asking_state':            return handleAskingState(phone, messageBody, session);
    case 'asking_city':             return handleAskingCity(phone, messageBody, session);
    case 'asking_email':            return handleAskingEmail(phone, messageBody, session);
    case 'active':                  return handleActive(phone, messageBody, session);
    case 'out_of_coverage':         return OUT_OF_COVERAGE_MSG;
    case 'escalated':
      return 'Tu mensaje ya fue enviado a un asesor. Pronto te contactan 🤝';
    default:
      sessionManager.deleteSession(phone);
      return 'Algo salió mal. Escríbeme de nuevo.';
  }
}

// ── Paso 1: Filtro México ─────────────────────────────────────────────────────

async function handleAskingMexico(phone, message, session) {
  if (isOutsideMexico(message)) {
    sessionManager.updateSession(phone, { flowState: 'out_of_coverage' });
    return OUT_OF_COVERAGE_MSG;
  }
  // Respuesta afirmativa o ambigua → asumir México, continuar
  sessionManager.updateSession(phone, { flowState: 'asking_returning' });
  return '¿Ya has comprado con nosotros antes o es tu primera vez?';
}

// ── Paso 2: ¿Ya es cliente? ───────────────────────────────────────────────────

async function handleAskingReturning(phone, message, session) {
  if (isReturningCustomer(message)) {
    sessionManager.updateSession(phone, { flowState: 'asking_returning_email' });
    return 'Dame tu correo para buscarte en nuestros registros 📧';
  }
  // Primera vez o ambiguo → ir directo al perfil
  sessionManager.updateSession(phone, { flowState: 'asking_profile' });
  return PROFILE_MENU;
}

// ── Paso 2b: Buscar cliente existente por email ───────────────────────────────

async function handleAskingReturningEmail(phone, message, session) {
  const input = message.trim();

  // Si no quiere dar email → tratar como nuevo
  if (wantsToSkipEmail(input) || !isValidEmail(input)) {
    sessionManager.updateSession(phone, { flowState: 'asking_profile' });
    const nota = isValidEmail(input) ? '' : 'No te encontramos 🙏 No hay problema, te atendemos igual.\n\n';
    return `${nota}${PROFILE_MENU}`;
  }

  const email    = input.toLowerCase();
  const existing = await sheetsService.findCustomerByEmail(email);

  if (existing) {
    // Cliente encontrado — actualizar teléfono y activar
    await sheetsService.updateCustomerPhone(existing.rowIndex, phone);
    sheetsService.appendConversationLog(
      phone, '[reconocido por email]', `Tel actualizado. Bienvenida a ${existing.name}`
    ).catch(() => {});

    const customer = {
      ...existing,
      phone,
      channel:       CHANNEL_PAQUETERIA.channel,
      channelDetail: CHANNEL_PAQUETERIA.detail,
    };
    sessionManager.updateSession(phone, { flowState: 'active', customer });
    console.log(`🔄 Reconocido por email: ${existing.name} (nuevo tel: ${phone})`);

    return `¡Ya te tenemos, ${existing.name}! 👋 ¿En qué te ayudo?`;
  }

  // No encontrado → tratar como nuevo
  sessionManager.updateSession(phone, { flowState: 'asking_profile' });
  return `No te encontramos en nuestros registros 🙏 No hay problema.\n\n${PROFILE_MENU}`;
}

// ── Paso 3: Perfil ────────────────────────────────────────────────────────────

async function handleAskingProfile(phone, message, session) {
  if (isEscalationProfile(message)) {
    // Mayoreo / grandes cantidades → escalar a Wig sin registrar
    session.tempData.profile = 'mayoreo';
    sessionManager.updateSession(phone, { flowState: 'escalated', tempData: session.tempData });
    await notifyWig(phone, session, 'Perfil: mayoreo / grandes cantidades');
    return 'Ahorita te conecto con un asesor 🙌';
  }

  // Opción 1 (comprar), 4 (consulta) o ambiguo → continuar flujo
  const profile = /^4$|consulta|informaci/i.test(message.trim()) ? 'consulta' : 'compra';
  session.tempData.profile = profile;
  sessionManager.updateSession(phone, { flowState: 'asking_state', tempData: session.tempData });

  return '¿De qué estado eres?';
}

// ── Paso 4: Ubicación ─────────────────────────────────────────────────────────

async function handleAskingState(phone, message, session) {
  const state = message.trim();
  if (state.length < 2) return '¿De qué estado eres?';

  // Detectar si menciona país extranjero en la respuesta del estado
  if (OUTSIDE_MEXICO_PATTERNS.some(re => re.test(state))) {
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

  // ── Registrar en Sheets en cuanto tenemos teléfono + estado + ciudad ──────
  const customerData = {
    phone,
    name:          '',
    email:         '',
    state:         session.tempData.state,
    city:          session.tempData.city,
    cp:            '',
    species:       '',
    channel:       CHANNEL_PAQUETERIA.channel,
    channelDetail: CHANNEL_PAQUETERIA.detail,
    segmento:      'Lead frío',
    aceWa:         'SI',
  };

  let rowIndex = null;
  try {
    rowIndex = await sheetsService.registerCustomer(customerData);
  } catch (err) {
    console.error('Error al registrar cliente en handleAskingCity:', err.message);
  }

  sessionManager.updateSession(phone, {
    flowState: 'asking_email',
    customer:  { ...customerData, rowIndex },
    tempData:  session.tempData,
  });

  return (
    `${CHANNEL_PAQUETERIA.message}\n\n` +
    `¿Me compartes tu correo para mandarte información y promociones? 📧\n` +
    `No es obligatorio`
  );
}

// ── Paso 7: Email opcional ────────────────────────────────────────────────────

async function handleAskingEmail(phone, message, session) {
  const input    = message.trim();
  const customer = session.customer;

  if (wantsToSkipEmail(input)) {
    sessionManager.updateSession(phone, { flowState: 'active', tempData: {} });
    return '¡Listo! ¿En qué te ayudo?';
  }

  if (!isValidEmail(input)) {
    return (
      'Ese correo no se ve bien. ¿Lo revisas?\n' +
      '(o escribe "no" si no quieres darlo)'
    );
  }

  const email    = input.toLowerCase();
  const existing = await sheetsService.findCustomerByEmail(email);

  if (existing) {
    // Email pertenece a un registro previo → eliminar duplicado, activar con el original
    if (customer?.rowIndex) {
      sheetsService.deleteCustomerRow(customer.rowIndex).catch(err =>
        console.error('No se pudo eliminar fila duplicada:', err.message)
      );
    }
    await sheetsService.updateCustomerPhone(existing.rowIndex, phone);
    sheetsService.appendConversationLog(
      phone, '[reconocido por email]', `Tel actualizado. Bienvenida a ${existing.name}`
    ).catch(() => {});

    const mergedCustomer = {
      ...existing,
      phone,
      channel:       CHANNEL_PAQUETERIA.channel,
      channelDetail: CHANNEL_PAQUETERIA.detail,
    };
    sessionManager.updateSession(phone, { flowState: 'active', customer: mergedCustomer, tempData: {} });
    console.log(`🔄 Reconocido por email: ${existing.name} (nuevo tel: ${phone})`);
    return `¡Ya te conocemos, ${existing.name}! 🎉 ¿En qué te ayudo?`;
  }

  // Email nuevo → actualizar fila ya creada
  if (customer?.rowIndex) {
    sheetsService.updateCustomerEmail(customer.rowIndex, email).catch(err =>
      console.error('Error actualizando email:', err.message)
    );
  }
  sessionManager.updateSession(phone, {
    flowState: 'active',
    customer:  { ...customer, email },
    tempData:  {},
  });

  return `Listo, te avisamos a *${email}*. ¿En qué te ayudo?`;
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
    await notifyWig(phone, session, 'Detectado por Claude: queja o enojo');
    sessionManager.updateSession(phone, { flowState: 'escalated' });
    return 'Ahorita te conecto con un asesor 🙌';
  }

  session.conversationHistory.push({ role: 'assistant', content: response });
  sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
  sheetsService.appendConversationLog(phone, message, response).catch(() => {});

  return response;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function notifyWig(phone, session, motivo = '') {
  const wigNumber = process.env.WIG_WHATSAPP_NUMBER;
  if (!wigNumber) {
    console.warn('WIG_WHATSAPP_NUMBER no configurado.');
    return;
  }

  const customer   = session.customer || {};
  const tempData   = session.tempData  || {};
  const history    = (session.conversationHistory || []).slice(-8);
  const transcript = history.length
    ? history.map(m => `${m.role === 'user' ? '👤' : '🤖'}: ${m.content}`).join('\n')
    : '(sin historial previo)';

  const msg =
    `🚨 *ESCALACIÓN*\n\n` +
    `📱 Tel:      ${phone}\n` +
    `👤 Nombre:   ${customer.name  || 'N/D'}\n` +
    `📍 Estado:   ${customer.state || tempData.state || 'N/D'}\n` +
    `🏙️ Ciudad:  ${customer.city  || tempData.city  || 'N/D'}\n` +
    `🏷️ Perfil:  ${tempData.profile || customer.segmento || 'N/D'}\n` +
    `📌 Motivo:   ${motivo}\n\n` +
    `*Conversación:*\n${transcript}`;

  try {
    await twilioService.sendMessage(wigNumber, msg);
    console.log(`📲 Wig notificado — ${phone} | ${motivo}`);
  } catch (err) {
    console.error('Error notificando a Wig:', err.message);
  }
}

function capitalize(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = { handleMessage };
