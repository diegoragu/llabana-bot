/**
 * Lógica central del bot de Llabana — flujo conversacional natural.
 *
 * Estados:
 *   asking_mexico   → filtro inicial (¿estás en México?)
 *   asking_name     → solo si no tiene nombre
 *   active          → conversación libre con Claude
 *   waiting_for_wig → escalado a asesor
 *   escalated       → post-escalación
 *
 * Cliente EXISTENTE (encontrado por teléfono): → active directamente.
 * Registro en Sheets: se hace cuando el cliente da su CP en conversación activa.
 */

const sessionManager = require('./sessionManager');
const sheetsService  = require('./sheetsService');
const claudeService  = require('./claudeService');
const twilioService  = require('./twilioService');
const shopifyService = require('./shopifyService');

// ── Constantes ────────────────────────────────────────────────────────────────

const OUT_OF_COVERAGE_MSG =
  'Gracias por escribirnos 🙏 Por ahora solo tenemos entregas en México. ' +
  'Cuando estés por acá con gusto te ayudamos 🌾';

// ── Variedad en mensajes ──────────────────────────────────────────────────────

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

const WELCOME_VARIANTS = [
  '¡Hola! 👋 Soy el asistente de Llabana, tu aliado en alimento balanceado 🌾 ¿Estás en México?',
  '¡Bienvenido! 🌾 Soy el asistente de Llabana. ¿Nos escribes desde México?',
  '¡Hola! 👋 Llabana, alimento balanceado para tus animales 🌾 ¿Estás en México?',
];

const GREETING_NAME_VARIANTS = [
  n => `¡Mucho gusto, ${n}! 😊 ¿En qué te puedo ayudar hoy?`,
  n => `¡Qué bueno que nos escribes, ${n}! ¿En qué te ayudo?`,
  n => `Gracias ${n} 🌾 ¿Qué necesitas hoy?`,
];

const CHANNEL_VARIANTS = [
  n => `¡Listo${n ? `, ${n}` : ''}! Puedes hacer tu pedido en llabanaenlinea.com y te lo mandamos a todo México 📦`,
  _n => 'Te mandamos por paquetería a todo México 📦 Haz tu pedido en llabanaenlinea.com',
  n => `Perfecto${n ? `, ${n}` : ''}. Entra a llabanaenlinea.com y pide desde ahí, llegamos a todo México 📦`,
];

const CLOSING_VARIANTS = [
  '¿Tienes alguna duda más? 😊',
  '¿Hay algo más en lo que te pueda ayudar?',
  '¿Se te ofrece algo más? 🌾',
];

// ── Patrones de detección ─────────────────────────────────────────────────────

const OUTSIDE_MEXICO_PATTERNS = [
  /estados\s*unidos/i, /\busa\b/i,       /\bee\.?\s*uu\.?\b/i,
  /\bguatemala\b/i,    /\bcolombia\b/i,  /\bvenezuela\b/i,
  /\bargentina\b/i,    /espa[ñn]a/i,     /canad[aá]/i,
  /\bchile\b/i,        /per[uú]/i,       /\bcuba\b/i,
  /\bhonduras\b/i,     /el\s*salvador/i, /\bnicaragua\b/i,
  /costa\s*rica/i,     /panam[aá]/i,     /\bbrasil\b/i,
  /\bbolivia\b/i,      /\becuador\b/i,   /\buruguay\b/i,
];

const ESCALATION_PROFILE_PATTERNS = [
  /grandes?\s*cantidad/i, /mayoreo/i, /reventa/i,
  /revendedor/i, /distribuidor/i, /por\s*mayor/i, /\bal\s*mayor\b/i,
  /emprender/i, /negocio/i, /\bnegoci/i,
  /distribuir/i, /distribuc/i,
  /punto\s*de\s*venta/i,
  /tienda\s*propia/i, /poner\s*(un\s*)?(negocio|tienda)/i,
  /vender\s*alimento/i, /comercializar/i,
];

const HUMAN_REQUEST_PATTERNS = [
  /\basesor\b/i, /\bhumano\b/i, /\bpersona\b/i, /\bwig\b/i,
  /\bagente\b/i, /hablar\s+con/i, /quiero\s+hablar/i,
  /\batenci[oó]n\s+humana\b/i, /\bme\s+atiendan?\b/i,
];

const PRICE_PATTERNS = [
  /\bprecio/i, /\bcu[aá]nto\s+cuesta/i, /\bcu[aá]nto\s+vale/i,
  /\bcu[aá]nto\s+cobran/i, /\bcu[aá]nto\s+es\b/i, /\bcosto\b/i,
  /\btarifa\b/i, /\bpresupuesto\b/i,
];

const RESET_PATTERNS = /^(inicio|men[uú]|empezar|reset|start|comenzar|nueva\s*consulta|reiniciar)$/i;

const DESPEDIDA_PATTERNS = /^(gracias|muchas gracias|seria todo|sería todo|ok gracias|vale gracias|listo gracias|perfecto gracias|hasta luego|bye|adios|adiós|no gracias|es todo|eso es todo|por ahora es todo|nada mas|nada más)$/i;

// Mapa de textos pre-cargados de WhatsApp a punto de entrada
const ENTRY_POINT_MAP = {
  'los encontré en google':                              'Google Business',
  'los vi en facebook':                                  'Facebook',
  'estoy en su página web':                              'Web - Header',
  'los contacto desde su página':                        'Web - Footer',
  'me pasaron al whatsapp desde el chat':                'Web - Chatbot',
  'vi un producto en su página':                         'Web - Producto',
  'vi un producto en la tienda en línea':                'Tienda - Producto',
  'me pasaron al whatsapp desde el chat de la tienda':   'Tienda - Chatbot',
};

// ── Helpers de detección ──────────────────────────────────────────────────────

function detectarOrigen(message) {
  const lower = (message || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  for (const [key, value] of Object.entries(ENTRY_POINT_MAP)) {
    const keyNorm = key.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (lower.includes(keyNorm)) {
      console.log(`🔗 detectarOrigen: "${lower.substring(0, 50)}" → ${value}`);
      return value;
    }
  }
  console.log(`🔗 detectarOrigen: "${lower.substring(0, 50)}" → Directo`);
  return 'Directo';
}

function isOutsideMexico(text) {
  return /^no$/i.test(text.trim()) || OUTSIDE_MEXICO_PATTERNS.some(re => re.test(text));
}

function isEscalationProfile(text) {
  return ESCALATION_PROFILE_PATTERNS.some(re => re.test(text.trim()));
}

function isRequestingHuman(text) {
  return HUMAN_REQUEST_PATTERNS.some(re => re.test(text.trim()));
}

function isPriceQuestion(text) {
  return PRICE_PATTERNS.some(re => re.test(text.trim()));
}

// ── Helpers de CP ─────────────────────────────────────────────────────────────

/** CP 01000–16999 → CDMX */
function cpIsCDMX(cp) {
  const n = parseInt(cp, 10);
  return n >= 1000 && n <= 16999;
}

/** CP 50000–57999 (prefijo 50–57) → Estado de México */
function cpIsEdomex(cp) {
  const s = cp.toString().padStart(5, '0');
  const prefix = parseInt(s.substring(0, 2), 10);
  return prefix >= 50 && prefix <= 57;
}

/** Deriva el nombre del estado a partir del CP. */
function cpToState(cp) {
  if (cpIsCDMX(cp))   return 'Ciudad de México';
  if (cpIsEdomex(cp)) return 'Estado de México';
  return '';
}

// ── Helpers de texto ──────────────────────────────────────────────────────────

function capitalize(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

function primerNombre(nombre) {
  return (nombre || '').split(' ')[0] || '';
}

// ── Punto de entrada ──────────────────────────────────────────────────────────

async function handleMessage(phone, messageBody) {
  // Reset manual
  if (RESET_PATTERNS.test(messageBody.trim())) {
    sessionManager.deleteSession(phone);
  }

  // Detectar origen de tracking en sesión existente
  let session = sessionManager.getSession(phone);
  if (session) {
    const origenNuevo = detectarOrigen(messageBody);
    if (origenNuevo !== 'Directo' &&
        (!session.tempData?.entryPoint || session.tempData.entryPoint === 'Directo')) {
      session.tempData = { ...session.tempData, entryPoint: origenNuevo };
      sessionManager.updateSession(phone, { tempData: session.tempData });
      if (session.customer?.rowIndex) {
        sheetsService.updateOrderData(session.customer.rowIndex, {
          entryPoint: origenNuevo,
        }).catch(() => {});
      }
      console.log(`🔗 Origen actualizado en sesión activa: ${origenNuevo}`);
    }
  }

  // Sesión nueva
  if (!session) {
    const entryPoint = detectarOrigen(messageBody);
    session = sessionManager.createSession(phone);
    session.tempData.entryPoint = entryPoint;
    sessionManager.updateSession(phone, { tempData: session.tempData });

    const customer = await sheetsService.findCustomer(phone);

    if (customer) {
      // Cliente existente → active directamente
      const nombre = primerNombre(customer.name);
      sessionManager.updateSession(phone, {
        flowState: 'active',
        customer: {
          ...customer,
          channel:       'paqueteria',
          channelDetail: 'Nacional',
        },
      });
      if (entryPoint !== 'Directo') {
        sheetsService.updateOrderData(customer.rowIndex, { entryPoint }).catch(() => {});
      }
      sheetsService.appendConversationLog(
        phone, '[inicio sesión]', `Bienvenida a cliente existente ${customer.name}`
      ).catch(() => {});

      if (!nombre) {
        sessionManager.updateSession(phone, { flowState: 'asking_name' });
        return '¡Hola! 👋 ¿Con quién tengo el gusto?';
      }
      return `¡Hola ${nombre}! 👋 ¿En qué te puedo ayudar hoy?`;
    }

    // Cliente nuevo → filtro México
    sessionManager.updateSession(phone, { flowState: 'asking_mexico' });
    return pick(WELCOME_VARIANTS);
  }

  // Rutear por estado
  switch (session.flowState) {
    case 'confirming_reset': return handleConfirmingReset(phone, messageBody, session);
    case 'asking_mexico':    return handleAskingMexico(phone, messageBody, session);
    case 'asking_name':      return handleAskingName(phone, messageBody, session);
    case 'active':           return handleActive(phone, messageBody, session);
    case 'waiting_for_wig':  return handleWaitingForWig(phone, messageBody, session);
    case 'escalated':        return handleEscalated(phone, messageBody, session);
    default:
      sessionManager.deleteSession(phone);
      return 'Algo salió mal. Escríbeme de nuevo.';
  }
}

// ── Confirmar reset (fallback) ─────────────────────────────────────────────────

const CONFIRM_RESET_PATTERNS = /^(s[ií]|empezar|nueva|nuevo|de\s*nuevo|empezar\s*de\s*nuevo|nueva\s*consulta)$/i;

async function handleConfirmingReset(phone, message, session) {
  if (CONFIRM_RESET_PATTERNS.test(message.trim())) {
    sessionManager.deleteSession(phone);
    sessionManager.createSession(phone);
    sessionManager.updateSession(phone, { flowState: 'asking_mexico' });
    return pick(WELCOME_VARIANTS);
  }

  const prevState = session.tempData?._prevState || 'active';
  sessionManager.updateSession(phone, { flowState: prevState });
  const restored = sessionManager.getSession(phone);

  switch (prevState) {
    case 'asking_mexico': return handleAskingMexico(phone, message, restored);
    case 'asking_name':   return handleAskingName(phone, message, restored);
    default:              return handleActive(phone, message, restored);
  }
}

// ── Filtro México ─────────────────────────────────────────────────────────────

async function handleAskingMexico(phone, message, session) {
  const origen = detectarOrigen(message);
  if (origen !== 'Directo' && !session.tempData?.entryPoint) {
    session.tempData = { ...session.tempData, entryPoint: origen };
    sessionManager.updateSession(phone, { tempData: session.tempData });
  }

  if (isOutsideMexico(message)) {
    sessionManager.deleteSession(phone);
    return OUT_OF_COVERAGE_MSG;
  }

  if (!phone.startsWith('whatsapp:+52')) {
    sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    await notifyWig(phone, session, `Número no mexicano: ${phone}`);
    return 'Veo que tu número no es de México 🌎 Te voy a conectar con un asesor.';
  }

  // Pasar directo a active — Claude lleva la conversación desde aquí
  sessionManager.updateSession(phone, { flowState: 'active' });
  return '¿Con quién tengo el gusto? 😊';
}

// ── Nombre ────────────────────────────────────────────────────────────────────

const INTENT_KEYWORDS = /croquetas?|alimento|comida|producto|precio|cotizaci[oó]n|perro|gato|caballo|cerdo|borrego|ave|pez|pollo|vaca|toro|codorniz/i;
const FLOW_RESPONSE_PATTERNS = /(primera\s*ve[zs]|es\s*mi\s*primera|nunca\s*he|no\s*he|soy\s*nuev[oa]|no,?\s*primera)/i;

async function handleAskingName(phone, message, session) {
  const attempts = session.tempData?.nameAttempts ?? 0;

  // Respuestas de flujo que no son nombres
  if (FLOW_RESPONSE_PATTERNS.test(message)) {
    return '¿Con quién tengo el gusto? 😊';
  }

  // Intención de producto/precio → guardar y seguir pidiendo nombre
  if (INTENT_KEYWORDS.test(message)) {
    session.tempData = { ...session.tempData, intent: message, nameAttempts: attempts };
    sessionManager.updateSession(phone, { tempData: session.tempData });
    return 'Anoto eso 📝 ¿Y tu nombre cuál es?';
  }

  const nombre = sheetsService.limpiarNombre(message);

  if (nombre) {
    const customerData = {
      phone,
      name:          nombre,
      channel:       'paqueteria',
      channelDetail: 'Nacional',
      segmento:      'Lead frío',
      aceWa:         'SI',
      entryPoint:    session.tempData?.entryPoint || 'Directo',
    };
    sessionManager.updateSession(phone, {
      flowState: 'active',
      customer:  customerData,
      tempData:  { ...session.tempData, name: nombre },
    });

    const first = primerNombre(nombre);

    // Si había intent guardado → responderlo de inmediato con Claude
    if (session.tempData?.intent) {
      session.conversationHistory.push({ role: 'user', content: session.tempData.intent });
      let response;
      try {
        response = await claudeService.chat(
          session.conversationHistory,
          customerData,
          session.tempData.intent
        );
      } catch {
        response = '¿En qué te puedo ayudar? 😊';
      }
      session.conversationHistory.push({ role: 'assistant', content: response });
      sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
      return `¡Mucho gusto, ${first}! 😊\n\n${response}`;
    }

    return `¡Mucho gusto, ${first}! 😊 ¿En qué te puedo ayudar?`;
  }

  // Nombre inválido
  if (attempts < 2) {
    sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, nameAttempts: attempts + 1 },
    });
    return '¿Me dices tu nombre? Por ejemplo: Juan o María 😊';
  }

  // Agotó intentos → active sin nombre
  sessionManager.updateSession(phone, { flowState: 'active' });
  return '¿En qué te puedo ayudar? 😊';
}

// ── Esperando asesor ──────────────────────────────────────────────────────────

async function handleWaitingForWig(phone, message, session) {
  if (DESPEDIDA_PATTERNS.test(message.trim())) {
    sessionManager.updateSession(phone, { flowState: 'escalated' });
    return '¡Con gusto! En breve te contacta un asesor 🙌 Que tengas buen día 🌾';
  }

  const esConsulta = message.trim().length > 8 || message.includes('?');
  if (esConsulta) {
    session.conversationHistory.push({ role: 'user', content: message });
    let response;
    try {
      response = await claudeService.chat(session.conversationHistory, session.customer);
    } catch {
      response = 'En breve te contacta un asesor para ayudarte 🙌';
    }
    if (response.includes('ESCALAR_A_WIG')) {
      return 'En breve te contacta un asesor 🙌';
    }
    session.conversationHistory.push({ role: 'assistant', content: response });
    sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
    return response;
  }

  return 'En breve te contacta un asesor 🙌';
}

async function handleEscalated(phone, message, session) {
  if (DESPEDIDA_PATTERNS.test(message.trim())) {
    return '¡Hasta luego! 🌾';
  }

  session.conversationHistory.push({ role: 'user', content: message });
  let response;
  try {
    response = await claudeService.chat(session.conversationHistory, session.customer);
  } catch {
    response = 'En breve te contacta un asesor para ayudarte 🙌';
  }
  if (response.includes('ESCALAR_A_WIG')) {
    return 'En breve te contacta un asesor 🙌';
  }
  session.conversationHistory.push({ role: 'assistant', content: response });
  sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
  return response + '\n\n_(Un asesor también te contactará en breve)_';
}

// ── Conversación libre con Claude ─────────────────────────────────────────────

async function handleActive(phone, message, session) {
  // Detectar CP en el mensaje si el cliente aún no está registrado
  const cpMatch = message.match(/\b(\d{5})\b/);
  if (cpMatch && !session.customer?.rowIndex) {
    const cp = cpMatch[1];
    const isLocal = cpIsCDMX(cp) || cpIsEdomex(cp);
    const { state, city } = await sheetsService.lookupCpMX(cp);

    const customerData = {
      ...session.customer,
      phone,
      cp,
      state:         state || cpToState(cp),
      city,
      channel:       'paqueteria',
      channelDetail: 'Nacional',
      segmento:      'Lead frío',
      aceWa:         'SI',
      entryPoint:    session.tempData?.entryPoint || 'Directo',
    };

    let rowIndex = null;
    try {
      rowIndex = await sheetsService.registerCustomer(customerData);
    } catch (err) {
      console.error('Error registrando cliente en handleActive:', err.message);
    }

    sessionManager.updateSession(phone, {
      customer: { ...customerData, rowIndex },
    });
    session = sessionManager.getSession(phone);

    if (isLocal) {
      const zone = cpIsCDMX(cp) ? 'CDMX' : 'Estado de México';
      sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
      await notifyWig(phone, { ...session, customer: customerData },
        `Zona local (${zone} / CP: ${cp})`);
      const firstName = primerNombre(session.customer?.name || '');
      return firstName
        ? `¡Listo, ${firstName}! 😊 Un asesor te contactará en breve por este WhatsApp.`
        : '¡Listo! 😊 Un asesor te contactará en breve por este WhatsApp.';
    }
  }

  // Detección rápida: cliente pide hablar con un asesor/humano
  if (isRequestingHuman(message)) {
    await notifyWig(phone, session, 'Cliente solicita hablar con un asesor');
    sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    return 'Ahorita te conecto con un asesor 🙌';
  }

  session.conversationHistory.push({ role: 'user', content: message });

  // Cargar productos por especie detectada en el mensaje
  let productos = session.productos || [];
  if (productos.length === 0) {
    const handle = shopifyService.detectarEspecie(message);
    if (handle) {
      productos = await shopifyService.getProductosPorEspecie(handle, 3);
      session.productos = productos;
      sessionManager.updateSession(phone, { productos });
    }
  }

  let response;
  try {
    response = await claudeService.chat(session.conversationHistory, session.customer, message);
  } catch (err) {
    console.error('claudeService.chat error:', err.message);
    return 'Tuve un problema técnico. ¿Me repites lo que necesitas?';
  }

  if (response.includes('ESCALAR_A_WIG')) {
    sheetsService.updateSegmento(phone, 'Mayoreo / Reventa').catch(() => {});
    await notifyWig(phone, session, 'Detectado por Claude: queja o enojo');
    sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    return 'Ahorita te conecto con un asesor 🙌';
  }

  session.conversationHistory.push({ role: 'assistant', content: response });
  sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
  sheetsService.appendConversationLog(phone, message, response).catch(() => {});

  return response;
}

// ── Notificación a asesor ─────────────────────────────────────────────────────

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
    `👤 Nombre:   ${customer.name || tempData.name || 'N/D'}\n` +
    `📍 Estado:   ${customer.state || tempData.state || 'N/D'}\n` +
    `🏙️ Ciudad:  ${customer.city  || tempData.city  || 'N/D'}\n` +
    `💬 Consulta: ${tempData.intent || customer.segmento || 'N/D'}\n` +
    `📌 Motivo:   ${motivo}\n\n` +
    `*Conversación:*\n${transcript}`;

  console.log(`📤 Intentando notificar a Wig | to: ${wigNumber} | motivo: ${motivo}`);
  try {
    const result = await twilioService.sendMessage(wigNumber, msg);
    console.log(`📲 Wig notificado | sid: ${result.sid} | status: ${result.status} | errorCode: ${result.errorCode ?? 'none'} | errorMsg: ${result.errorMessage ?? 'none'}`);
  } catch (err) {
    console.error(`❌ Error notificando a Wig | code: ${err.code} | status: ${err.status} | msg: ${err.message} | moreInfo: ${err.moreInfo}`);
  }
}

module.exports = { handleMessage };
