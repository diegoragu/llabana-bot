/**
 * Lógica central del bot de Llabana — flujo definitivo.
 *
 * Estados para cliente NUEVO (no encontrado por teléfono):
 *
 *   [primer msg]           → bienvenida + "¿Estás en México?"     → asking_mexico
 *   asking_mexico          → valida México                         → asking_returning | out_of_coverage
 *   asking_returning       → ¿ya compró antes?                    → asking_returning_email | asking_name
 *   asking_returning_email → busca por email                      → active | asking_name
 *   asking_name            → nombre (máx 2 reintentos)            → asking_intent
 *   asking_intent          → pregunta abierta; Claude clasifica    → escalated | asking_cp
 *   asking_cp              → pide CP; deriva estado y canal       → waiting_for_wig | active
 *   active                 → Claude libre                          → waiting_for_wig
 *
 * Cliente EXISTENTE (encontrado por teléfono):
 *   → saludo por nombre → active directamente
 *
 * Escalación a Wig: mayoreo/grandes cantidades (perfil), quejas, enojados (Claude).
 * Canal: todos a paquetería / llabanaenlinea.com (rutas/sucursales se activan después).
 * Teléfono guardado como +52XXXXXXXXXX (sin prefijo whatsapp:).
 */

const sessionManager  = require('./sessionManager');
const sheetsService   = require('./sheetsService');
const claudeService   = require('./claudeService');
const twilioService   = require('./twilioService');
const shopifyService  = require('./shopifyService');

// ── Constantes y helpers de detección ────────────────────────────────────────

const OUT_OF_COVERAGE_MSG =
  'Gracias por escribirnos 🙏 Por ahora solo tenemos entregas en México. ' +
  'Cuando estés por acá con gusto te ayudamos 🌾';

const CHANNEL_PAQUETERIA = {
  channel: 'paqueteria',
  detail:  'Nacional',
};

// ── Variedad en mensajes ──────────────────────────────────────────────────────

/** Elige un elemento al azar de un array. */
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

// Patrones para escalación: mayoreo, grandes cantidades, reventa, negocio/emprendimiento
const ESCALATION_PROFILE_PATTERNS = [
  /grandes?\s*cantidad/i, /mayoreo/i, /reventa/i,
  /revendedor/i, /distribuidor/i, /por\s*mayor/i, /\bal\s*mayor\b/i,
  /emprender/i, /negocio/i, /\bnegoci/i,
  /distribuir/i, /distribuc/i,
  /punto\s*de\s*venta/i,
  /tienda\s*propia/i, /poner\s*(un\s*)?(negocio|tienda)/i,
  /vender\s*alimento/i, /comercializar/i,
];

// Patrones para solicitud de asesor humano
const HUMAN_REQUEST_PATTERNS = [
  /\basesor\b/i, /\bhumano\b/i, /\bpersona\b/i, /\bwig\b/i,
  /\bagente\b/i, /hablar\s+con/i, /quiero\s+hablar/i,
  /\batenci[oó]n\s+humana\b/i, /\bme\s+atiendan?\b/i,
];

// Patrones para preguntas de precio
const PRICE_PATTERNS = [
  /\bprecio/i, /\bcu[aá]nto\s+cuesta/i, /\bcu[aá]nto\s+vale/i,
  /\bcu[aá]nto\s+cobran/i, /\bcu[aá]nto\s+es\b/i, /\bcosto\b/i,
  /\btarifa\b/i, /\bpresupuesto\b/i,
];

// Palabras que reinician la sesión desde cualquier estado
const RESET_PATTERNS = /^(inicio|men[uú]|empezar|reset|start|comenzar|nueva\s*consulta|reiniciar)$/i;

// Mapa de textos pre-cargados de WhatsApp a punto de entrada
const ENTRY_POINT_MAP = {
  'los encontré en google':               'Google Business',
  'los vi en facebook':                   'Facebook',
  'estoy en su página web':               'Web - Header',
  'los contacto desde su página':         'Web - Footer',
  'me pasaron al whatsapp desde el chat': 'Web - Chatbot',
  'vi un producto en su página':          'Web - Producto',
  'vi un producto en la tienda en línea':                  'Tienda - Producto',
  'me pasaron al whatsapp desde el chat de la tienda':     'Tienda - Chatbot',
};

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

function isReturningCustomer(text) {
  return RETURNING_PATTERNS.some(re => re.test(text.trim()));
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

function isValidEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text.trim());
}

// ── Punto de entrada ──────────────────────────────────────────────────────────

async function handleMessage(phone, messageBody) {
  // Palabra clave de reinicio → borrar sesión y empezar desde cero
  if (RESET_PATTERNS.test(messageBody.trim())) {
    sessionManager.deleteSession(phone);
  }

  // "hola" con sesión activa → preguntar si quiere nueva consulta
  const existingSession = sessionManager.getSession(phone);
  if (existingSession && /^hola$/i.test(messageBody.trim())) {
    existingSession.tempData = {
      ...existingSession.tempData,
      _prevState: existingSession.flowState,
    };
    sessionManager.updateSession(phone, { flowState: 'confirming_reset', tempData: existingSession.tempData });
    return '¿Quieres empezar una nueva consulta o seguimos con lo que teníamos? 😊';
  }

  let session = sessionManager.getSession(phone);

  // ── Sesión nueva: buscar cliente por teléfono ─────────────────────────────
  if (!session) {
    const entryPoint = detectarOrigen(messageBody);
    session = sessionManager.createSession(phone);
    session.tempData.entryPoint = entryPoint;
    sessionManager.updateSession(phone, { tempData: session.tempData });

    const customer = await sheetsService.findCustomer(phone);

    if (customer) {
      // Cliente existente — saltar todo el onboarding
      sessionManager.updateSession(phone, { flowState: 'active', customer });
      sheetsService.appendConversationLog(
        phone, '[inicio sesión]', `Bienvenida enviada a ${customer.name}`
      ).catch(() => {});

      // Actualizar punto de entrada si vino de un link de tracking
      if (entryPoint !== 'Directo') {
        sheetsService.updateOrderData(customer.rowIndex, { entryPoint }).catch(() => {});
      }

      return customer.name
        ? `¡Hola ${primerNombre(customer.name)}! 👋 Qué gusto verte de nuevo. ¿En qué te puedo ayudar hoy?`
        : '¡Hola! 👋 Qué gusto verte de nuevo. ¿En qué te puedo ayudar hoy?';
    }

    // Cliente nuevo — saludo inicial aleatorio
    sessionManager.updateSession(phone, { flowState: 'asking_mexico' });
    return pick(WELCOME_VARIANTS);
  }

  // Detectar origen de tracking en cualquier mensaje, no solo en sesión nueva
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

  // ── Rutear por estado ─────────────────────────────────────────────────────
  switch (session.flowState) {
    case 'confirming_reset':        return handleConfirmingReset(phone, messageBody, session);
    case 'asking_mexico':           return handleAskingMexico(phone, messageBody, session);
    case 'asking_returning':        return handleAskingReturning(phone, messageBody, session);
    case 'asking_returning_email':  return handleAskingReturningEmail(phone, messageBody, session);
    case 'asking_name':             return handleAskingName(phone, messageBody, session);
    case 'asking_intent':           return handleAskingIntent(phone, messageBody, session);
    case 'asking_cp':               return handleAskingCp(phone, messageBody, session);
    case 'active':                  return handleActive(phone, messageBody, session);
    case 'out_of_coverage':
      sessionManager.deleteSession(phone);
      return OUT_OF_COVERAGE_MSG;
    case 'waiting_for_wig':        return handleWaitingForWig(phone, messageBody, session);
    case 'escalated':              return handleEscalated(phone, messageBody, session);
    default:
      sessionManager.deleteSession(phone);
      return 'Algo salió mal. Escríbeme de nuevo.';
  }
}

// ── Confirmar reset desde "hola" ──────────────────────────────────────────────

const CONFIRM_RESET_PATTERNS = /^(s[ií]|empezar|nueva|nuevo|de\s*nuevo|empezar\s*de\s*nuevo|nueva\s*consulta)$/i;

async function handleConfirmingReset(phone, message, session) {
  if (CONFIRM_RESET_PATTERNS.test(message.trim())) {
    sessionManager.deleteSession(phone);
    sessionManager.createSession(phone);
    sessionManager.updateSession(phone, { flowState: 'asking_mexico' });
    return pick(WELCOME_VARIANTS);
  }

  // Continuar con el estado anterior
  const prevState = session.tempData?._prevState || 'active';
  sessionManager.updateSession(phone, { flowState: prevState });
  const restored = sessionManager.getSession(phone);

  switch (prevState) {
    case 'asking_mexico':          return handleAskingMexico(phone, message, restored);
    case 'asking_returning':       return handleAskingReturning(phone, message, restored);
    case 'asking_returning_email': return handleAskingReturningEmail(phone, message, restored);
    case 'asking_name':            return handleAskingName(phone, message, restored);
    case 'asking_intent':          return handleAskingIntent(phone, message, restored);
    case 'asking_cp':              return handleAskingCp(phone, message, restored);
    default:                       return handleActive(phone, message, restored);
  }
}

// ── Paso 1: Filtro México ─────────────────────────────────────────────────────

async function handleAskingMexico(phone, message, session) {
  // Si el mensaje viene de un link de tracking, guardarlo
  const origen = detectarOrigen(message);
  if (origen !== 'Directo' && !session.tempData?.entryPoint) {
    session.tempData = { ...session.tempData, entryPoint: origen };
    sessionManager.updateSession(phone, { tempData: session.tempData });
    console.log(`🔗 Origen detectado en asking_mexico: ${origen}`);
  }

  if (isOutsideMexico(message)) {
    sessionManager.deleteSession(phone);
    return OUT_OF_COVERAGE_MSG;
  }

  // Validar que el número de WhatsApp sea mexicano (+52)
  if (!phone.startsWith('whatsapp:+52')) {
    sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    await notifyWig(phone, session, `Número no mexicano: ${phone}`);
    return 'Veo que tu número no es de México 🌎 Te voy a conectar con un asesor para que te ayude.';
  }

  // Respuesta afirmativa o ambigua → asumir México, continuar
  sessionManager.updateSession(phone, { flowState: 'asking_returning' });
  return '¿Ya has comprado con nosotros antes o es tu primera vez?';
}

// ── Paso 2: ¿Ya es cliente? ───────────────────────────────────────────────────

const INTENT_KEYWORDS = /croquetas?|alimento|comida|producto|precio|cotizaci[oó]n|perro|gato|caballo|cerdo|borrego|ave|pez|pollo|vaca|toro|codorniz/i;

const ESTADOS_MX = /jalisco|cdmx|ciudad\s*de\s*m[eé]xico|estado\s*de\s*m[eé]xico|edomex|nuevo\s*le[oó]n|veracruz|puebla|guanajuato|chihuahua|sonora|tamaulipas|oaxaca|chiapas|guerrero|michoac[aá]n|sinaloa|hidalgo|tabasco|yucatan|yucat[aá]n|quintana\s*roo|san\s*luis\s*potos[ií]|coahuila|durango|zacatecas|colima|nayarit|tlaxcala|campeche|baja\s*california|morelos|quer[eé]taro|aguascalientes/i;

async function handleAskingReturning(phone, message, session) {
  if (isReturningCustomer(message)) {
    sessionManager.updateSession(phone, { flowState: 'asking_returning_email' });
    return 'Dame tu correo para buscarte en nuestros registros 📧';
  }

  // Detectar estado mexicano en la respuesta → continuar como cliente nuevo
  if (ESTADOS_MX.test(message)) {
    const estadoMatch = message.match(ESTADOS_MX);
    const tempData = {
      ...session.tempData,
      nameAttempts: 0,
      ...(INTENT_KEYWORDS.test(message) ? { intent: message } : {}),
      ...(estadoMatch ? { estadoDetectado: estadoMatch[0] } : {}),
    };
    sessionManager.updateSession(phone, { flowState: 'asking_name', tempData });
    return '¿Con quién tengo el gusto? 😊';
  }

  // Primera vez o ambiguo → pedir nombre, guardar intent si hay palabras clave
  const tempData = {
    ...session.tempData,
    nameAttempts: 0,
    ...(INTENT_KEYWORDS.test(message) ? { intent: message } : {}),
  };
  sessionManager.updateSession(phone, { flowState: 'asking_name', tempData });
  return '¿Con quién tengo el gusto? 😊';
}

// ── Paso 2b: Buscar cliente existente por email ───────────────────────────────

async function handleAskingReturningEmail(phone, message, session) {
  const input = message.trim();

  // Si no quiere dar email o no es válido → tratar como nuevo
  if (!isValidEmail(input) || /^no$/i.test(input)) {
    sessionManager.updateSession(phone, { flowState: 'asking_name', tempData: { ...session.tempData, nameAttempts: 0 } });
    return '¿Con quién tengo el gusto? 😊';
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

    return `¡Ya te tenemos, ${primerNombre(existing.name)}! 👋 ¿En qué te ayudo?`;
  }

  // No encontrado → continuar como nuevo desde nombre
  sessionManager.updateSession(phone, { flowState: 'asking_name', tempData: { ...session.tempData, nameAttempts: 0 } });
  return 'No te encontramos en nuestros registros 🙏 No hay problema, te atiendo igual.\n\n¿Con quién tengo el gusto? 😊';
}

// ── Paso 3: Nombre ────────────────────────────────────────────────────────────

const NAME_INTENT_PATTERNS  = /\b(croquetas?|alimento|comida|producto|precio|cotizaci[oó]n|perro|gato|caballo|cerdo|borrego|ave|pez|pollo|vaca|toro)\b/i;
const NAME_PRECIO_PATTERNS  = /\bprecio|cu[aá]nto|costo|cotizaci[oó]n|barato|caro\b/i;
const NAME_NEGOCIO_PATTERNS = /\b(empresa|negocio|tienda|rancho|granja)\b/i;

async function handleAskingName(phone, message, session) {
  const input    = message.trim();
  const attempts = session.tempData?.nameAttempts ?? 0;

  // Pregunta de precio → informar, guardar intent y seguir pidiendo nombre
  if (NAME_PRECIO_PATTERNS.test(input)) {
    sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, intent: input },
    });
    return 'Los precios los encuentras en llabanaenlinea.com 🛒 ¿Y tu nombre cuál es?';
  }

  // Parece una intención de compra → guardar y seguir pidiendo nombre
  if (NAME_INTENT_PATTERNS.test(input)) {
    // Si ya hay un intent guardado, respuesta más corta
    if (session.tempData?.intent) {
      return 'Anoto eso 📝 ¿Y tu nombre?';
    }
    sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, intent: input },
    });
    return 'Anoto eso 📝 ¿Y tu nombre cuál es?';
  }

  // Parece descripción de empresa/rol → guardar y seguir pidiendo nombre
  if (NAME_NEGOCIO_PATTERNS.test(input)) {
    sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, negocio: input },
    });
    return '¡Qué bien! ¿Y con quién tengo el gusto?';
  }

  // Respuesta de flujo que llegó tarde (ej. "primera vez") — no es un nombre
  const FLOW_RESPONSE_PATTERNS = /(primera\s*ve[zs]|es\s*mi\s*primera|nunca\s*he|no\s*he|soy\s*nuev[oa]|no,?\s*primera|first\s*time|1era\s*vez|primera\s*ocasion)/i;
  if (FLOW_RESPONSE_PATTERNS.test(input)) {
    sessionManager.updateSession(phone, {
      flowState: 'asking_name',
      tempData: { ...session.tempData, nameAttempts: 0 },
    });
    return '¿Con quién tengo el gusto? 😊';
  }

  // Claramente inválido como nombre (solo números, email, 1 carácter) → no contar intento
  if (/^\d+$/.test(input) || isValidEmail(input) || input.length === 1) {
    return '¿Me dices tu nombre? Por ejemplo: Juan o María 😊';
  }

  const nombre = sheetsService.limpiarNombre(input);

  if (nombre) {
    const first = primerNombre(nombre);
    sessionManager.updateSession(phone, {
      flowState: 'asking_intent',
      tempData:  { ...session.tempData, name: nombre, nameAttempts: 0 },
    });
    return pick(GREETING_NAME_VARIANTS)(first);
  }

  if (attempts < 2) {
    sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, nameAttempts: attempts + 1 },
    });
    return 'No capturé bien tu nombre 😅 ¿Me lo dices de nuevo? Solo tu nombre, por ejemplo: Juan García';
  }

  // Agotó intentos → continuar sin nombre
  sessionManager.updateSession(phone, {
    flowState: 'asking_intent',
    tempData:  { ...session.tempData, nameAttempts: 0 },
  });
  return '¿En qué te puedo ayudar hoy? 😊';
}

// ── Paso 4: Intención (pregunta abierta) ──────────────────────────────────────

async function handleAskingIntent(phone, message, session) {
  const intent = message.trim();

  // Guardar consulta en tempData para incluirla en Notas al registrar
  session.tempData.intent = intent;
  const especieHandle = shopifyService.detectarEspecie(intent);
  if (especieHandle) session.tempData.especieHandle = especieHandle;
  sessionManager.updateSession(phone, { tempData: session.tempData });

  // Escalación: mayoreo, reventa, grandes cantidades o solicitud de humano
  if (isEscalationProfile(message) || isRequestingHuman(message)) {
    await notifyWig(phone, session, `Consulta inicial: "${intent}"`);
    sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    return 'Ahorita te conecto con un asesor 🙌';
  }

  // Pregunta de precio → informar y pedir CP
  if (isPriceQuestion(message)) {
    sessionManager.updateSession(phone, { flowState: 'asking_cp' });
    return (
      'Los precios y disponibilidad los encuentras en nuestra tienda en línea 🛒\n' +
      'llabanaenlinea.com\n\n' +
      '¿Cuál es tu código postal? 📍 Con eso verifico qué opciones de entrega tenemos disponibles para ti.'
    );
  }

  // Cualquier otra consulta → pedir CP
  sessionManager.updateSession(phone, { flowState: 'asking_cp' });
  return '¿Cuál es tu código postal? 📍 Con eso verifico qué opciones de entrega tenemos disponibles para ti.';
}

// ── Paso 5: Código postal → canal ─────────────────────────────────────────────

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

const CP_INVALID_PATTERNS = /^[a-zA-Z\s]{2,}$/;

async function handleAskingCp(phone, message, session) {
  const input = message.trim();
  const cp    = input.replace(/\D/g, '');

  if (cp.length < 4 || cp.length > 5) {
    // Parece un nombre (letras, sin números)
    if (CP_INVALID_PATTERNS.test(input)) {
      const posibleNombre = sheetsService.limpiarNombre(input);
      if (posibleNombre && !session.tempData?.name) {
        sessionManager.updateSession(phone, {
          tempData: { ...session.tempData, name: posibleNombre },
        });
        return `Mucho gusto ${primerNombre(posibleNombre)} 😊 ¿Cuál es tu código postal?`;
      }
    }

    // Parece una pregunta o consulta → Claude responde brevemente y vuelve a pedir CP
    if (input.length > 6 || /[¿?]/.test(input)) {
      let respuesta = '';
      try {
        respuesta = await claudeService.chat(session, [
          { role: 'user', content: input },
          { role: 'user', content: '(responde en máximo 1 oración, sin pedir nada más)' },
        ]);
      } catch {
        respuesta = 'Claro';
      }
      const resp = (respuesta || 'Claro').replace(/\n/g, ' ').trim();
      return `${resp} ¿Me das tu código postal para ver opciones de entrega? 📍`;
    }

    return '¿Cuál es tu código postal? 📍 Son 5 dígitos, por ejemplo: 06600';
  }

  const isLocal = cpIsCDMX(cp) || cpIsEdomex(cp);

  // Enriquecer estado y ciudad desde la API de códigos postales
  const { state, city } = await sheetsService.lookupCpMX(cp);

  const customerData = {
    phone,
    name:          session.tempData.name || '',
    email:         '',
    state:         state || cpToState(cp), // fallback si la API falla
    city,
    cp,
    species:       '',
    channel:       CHANNEL_PAQUETERIA.channel,
    channelDetail: CHANNEL_PAQUETERIA.detail,
    segmento:      'Lead frío',
    aceWa:         'SI',
    entryPoint:    session.tempData?.entryPoint || 'Directo',
  };

  let rowIndex = null;
  try {
    rowIndex = await sheetsService.registerCustomer(customerData);
  } catch (err) {
    console.error('Error al registrar cliente en handleAskingCp:', err.message);
  }

  if (rowIndex && session.tempData.intent) {
    sheetsService.updateOrderData(rowIndex, {
      notas: `Consulta: ${session.tempData.intent}`,
    }).catch(() => {});
  }

  const updatedSession = {
    ...session,
    customer: { ...customerData, rowIndex },
    tempData: {},
  };

  if (isLocal) {
    const zone = cpIsCDMX(cp) ? 'CDMX' : 'Estado de México';
    sessionManager.updateSession(phone, {
      flowState: 'waiting_for_wig',
      customer:  updatedSession.customer,
      tempData:  {},
    });
    await notifyWig(phone, updatedSession,
      `Zona local (${zone} / CP: ${cp}): requiere coordinar entrega`);
    const firstName = primerNombre(customerData.name);
    return firstName
      ? `¡Listo, ${firstName}! 😊 Un asesor de Llabana se pondrá en contacto contigo en breve por este mismo WhatsApp para ayudarte. ¡Estamos para servirte!`
      : '¡Listo! 😊 Un asesor de Llabana se pondrá en contacto contigo en breve por este mismo WhatsApp para ayudarte. ¡Estamos para servirte!';
  }

  const firstName = primerNombre(customerData.name);

  // Precargar productos si se detectó especie en el flujo de onboarding
  let productosPreCargados = [];
  const especieHandle = session.tempData?.especieHandle;
  if (especieHandle) {
    productosPreCargados = await shopifyService.getProductosPorEspecie(especieHandle, 3);
  }

  sessionManager.updateSession(phone, {
    flowState: 'active',
    customer:  updatedSession.customer,
    tempData:  {},
    productos: productosPreCargados,
  });

  return `${pick(CHANNEL_VARIANTS)(firstName)} ${pick(CLOSING_VARIANTS)}`;
}

// ── Esperando asesor ──────────────────────────────────────────────────────────

const DESPEDIDA_PATTERNS = /^(gracias|muchas gracias|seria todo|sería todo|ok gracias|vale gracias|listo gracias|perfecto gracias|hasta luego|bye|adios|adiós|no gracias|es todo|eso es todo|por ahora es todo|nada mas|nada más)$/i;

async function handleWaitingForWig(phone, message, session) {
  // Detectar despedida → cerrar conversación amablemente
  if (DESPEDIDA_PATTERNS.test(message.trim())) {
    sessionManager.updateSession(phone, { flowState: 'escalated' });
    return '¡Con gusto! En breve te contacta un asesor 🙌 Que tengas buen día 🌾';
  }

  // Detectar pregunta o consulta nueva → responder con Claude brevemente
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

  // Respuesta corta o ambigua → mensaje estándar
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
    response = await claudeService.chat(session.conversationHistory, session.customer, productos);
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
    `👤 Nombre:   ${customer.name || tempData.name || 'N/D'}\n` +
    `📍 Estado:   ${customer.state || tempData.state || session.tempData?.state || 'N/D'}\n` +
    `🏙️ Ciudad:  ${customer.city  || tempData.city  || session.tempData?.city  || 'N/D'}\n` +
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

function capitalize(str) {
  return str.replace(/\b\w/g, c => c.toUpperCase());
}

/** Devuelve solo el primer nombre para usar en mensajes del bot. */
function primerNombre(nombre) {
  return (nombre || '').split(' ')[0] || '';
}

module.exports = { handleMessage };
