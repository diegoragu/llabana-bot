/**
 * Lógica central del bot de Llabana — flujo conversacional natural.
 *
 * Estados:
 *   asking_mexico    → filtro inicial único
 *   active           → conversación libre con Claude
 *   waiting_for_wig  → escalado a asesor
 *   escalated        → post-escalación
 *   confirming_reset → confirmación de reinicio
 *
 * Nombre y CP se capturan naturalmente dentro de la conversación activa.
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

const ENTRY_POINT_MAP = {
  'quiero mas informacion':               'Llabana.com Footer',
  'me podrian dar mas informacion':       'Llabana.com Header',
  'quiero mas informes':                  'Llabana.com Chatbot',
  'vi un producto que me interesa':       'Llabana.com Producto',
  'vi un producto en su tienda en linea': 'Tienda Producto',
  'me mandaron aqui desde la tienda':     'Tienda Chatbot',
  'los vi en facebook':                   'Facebook',
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

  let session = sessionManager.getSession(phone);

  // Detectar origen en sesión activa
  if (session) {
    const origenNuevo = detectarOrigen(messageBody);
    if (origenNuevo !== 'Directo' &&
        (!session.tempData?.entryPoint || session.tempData.entryPoint === 'Directo')) {
      session.tempData = { ...session.tempData, entryPoint: origenNuevo };
      sessionManager.updateSession(phone, { tempData: session.tempData });
      if (session.customer?.rowIndex) {
        sheetsService.updateOrderData(session.customer.rowIndex,
          { entryPoint: origenNuevo }).catch(() => {});
      }
      console.log(`🔗 Origen actualizado en sesión activa: ${origenNuevo}`);
    }
  }

  // Sesión nueva
  if (!session) {
    const entryPoint = detectarOrigen(messageBody);
    session = sessionManager.createSession(phone);
    session.tempData = { entryPoint };
    sessionManager.updateSession(phone, { tempData: session.tempData });

    const customer = await sheetsService.findCustomer(phone);

    if (customer) {
      // Cliente existente
      const customerData = {
        ...customer,
        channel:       'paqueteria',
        channelDetail: 'Nacional',
      };
      if (entryPoint !== 'Directo') {
        sheetsService.updateOrderData(customer.rowIndex, { entryPoint }).catch(() => {});
      }
      const nombre = primerNombre(customer.name);
      if (!nombre) {
        sessionManager.updateSession(phone, {
          flowState: 'asking_name',
          customer:  customerData,
        });
        return '¡Hola! 👋 ¿Con quién tengo el gusto?';
      }
      // Cliente existente con nombre → procesar primer mensaje con Claude
      sessionManager.updateSession(phone, {
        flowState: 'active',
        customer:  customerData,
      });
      return handleActive(phone, messageBody, sessionManager.getSession(phone));
    }

    // Cliente nuevo → filtro México
    sessionManager.updateSession(phone, { flowState: 'asking_mexico' });
    return pick(WELCOME_VARIANTS);
  }

  // Rutear
  switch (session.flowState) {
    case 'asking_mexico':    return handleAskingMexico(phone, messageBody, session);
    case 'asking_name':      return handleAskingName(phone, messageBody, session);
    case 'active':           return handleActive(phone, messageBody, session);
    case 'waiting_for_wig':  return handleWaitingForWig(phone, messageBody, session);
    case 'escalated':        return handleEscalated(phone, messageBody, session);
    case 'confirming_reset':        return handleConfirmingReset(phone, messageBody, session);
    case 'confirming_escalation':   return handleConfirmingEscalation(phone, messageBody, session);
    default:
      sessionManager.deleteSession(phone);
      return 'Algo salió mal. Escríbeme de nuevo.';
  }
}

// ── Filtro México ─────────────────────────────────────────────────────────────

async function handleAskingMexico(phone, message, session) {
  if (isOutsideMexico(message)) {
    sessionManager.deleteSession(phone);
    return OUT_OF_COVERAGE_MSG;
  }

  if (!phone.startsWith('whatsapp:+52')) {
    sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    // Solo notificar si viene de un link de tracking (cliente real interesado)
    // Números extranjeros que llegan directo generalmente son spam o error
    if (session.tempData?.entryPoint && session.tempData.entryPoint !== 'Directo') {
      await notifyWig(phone, session,
        `Número extranjero via ${session.tempData.entryPoint}: ${phone}`,
        'Cliente con número extranjero');
    }
    return 'Veo que tu número no es de México 🌎 Te voy a conectar con un asesor.';
  }

  // México confirmado → registrar lead y pedir nombre
  let rowIndex = null;
  try {
    rowIndex = await sheetsService.registerCustomer({
      phone,
      name:          '',
      email:         '',
      state:         '',
      city:          '',
      cp:            '',
      channel:       'paqueteria',
      channelDetail: 'Nacional',
      segmento:      'Lead frío',
      aceWa:         'SI',
      entryPoint:    session.tempData?.entryPoint || 'Directo',
      origen:        'WhatsApp',
    });
    sessionManager.updateSession(phone, {
      customer: {
        phone,
        rowIndex,
        channel:       'paqueteria',
        channelDetail: 'Nacional',
        segmento:      'Lead frío',
      },
    });
    console.log(`✅ Lead registrado al confirmar México | ${phone} | fila ${rowIndex}`);
  } catch (err) {
    console.error('Error registrando lead en México:', err.message);
  }

  sessionManager.updateSession(phone, { flowState: 'asking_name' });
  return '¿Con quién tengo el gusto? 😊';
}

// ── Nombre ────────────────────────────────────────────────────────────────────

async function handleAskingName(phone, message, session) {
  const nombre = sheetsService.limpiarNombre(message);
  const attempts = session.tempData?.nameAttempts ?? 0;

  if (nombre) {
    const first = primerNombre(nombre);
    if (session.customer?.rowIndex) {
      sheetsService.updateOrderData(session.customer.rowIndex, { name: nombre }).catch(() => {});
    }
    sessionManager.updateSession(phone, {
      flowState: 'active',
      tempData:  { ...session.tempData, name: nombre, nameAttempts: 0 },
      customer:  { ...session.customer, name: nombre },
    });
    return pick([
      `¡Mucho gusto, ${first}! 😊 ¿En qué te puedo ayudar?`,
      `¡Qué bueno que nos escribes, ${first}! ¿En qué te ayudo?`,
      `Gracias ${first} 🌾 ¿Qué necesitas hoy?`,
    ]);
  }

  // Nombre inválido
  if (attempts < 2) {
    sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, nameAttempts: attempts + 1 },
    });
    return '¿Me dices tu nombre? Por ejemplo: Juan o María 😊';
  }

  // Agotó intentos → continuar sin nombre
  sessionManager.updateSession(phone, { flowState: 'active' });
  return '¿En qué te puedo ayudar? 😊';
}

// ── Conversación libre con Claude ─────────────────────────────────────────────

const FLOW_PATTERNS = /(primera\s*ve[zs]|es\s*mi\s*primera|nunca\s*he|no\s*he|soy\s*nuev[oa]|no,?\s*primera)/i;

async function handleActive(phone, message, session) {
  // "hola" con cliente activo → confirmar si quiere nueva consulta
  if (/^hola$/i.test(message.trim()) && session.customer) {
    session.tempData = { ...session.tempData, _prevState: 'active' };
    sessionManager.updateSession(phone, {
      flowState: 'confirming_reset',
      tempData:  session.tempData,
    });
    return '¿Quieres empezar una nueva consulta o seguimos con lo que teníamos? 😊';
  }

  // Solicitud de asesor humano
  if (isRequestingHuman(message)) {
    return escalateWithResumen(phone, session, 'Cliente solicita asesor humano');
  }

  // Escalación por perfil (mayoreo, negocio, etc.)
  if (isEscalationProfile(message)) {
    return escalateWithResumen(phone, session,
      `Perfil mayoreo/negocio: "${message.substring(0, 80)}"`);
  }

  // Detectar CP → actualizar registro existente o crear uno nuevo
  // Excluir números largos (teléfonos, etc.) para evitar falsos positivos
  const cpMatch = message.match(/(?<!\d)(\d{5})(?!\d)/);
  const tieneNumeroLargo = /\d{7,}/.test(message);

  if (cpMatch && !tieneNumeroLargo && !session.customer?.cp) {
    const cp = cpMatch[1];
    const isLocal = cpIsCDMX(cp) || cpIsEdomex(cp);
    const { state, city } = await sheetsService.lookupCpMX(cp);

    const updatedData = {
      cp,
      state: state || cpToState(cp),
      city,
    };

    if (session.customer?.rowIndex) {
      // Cliente ya registrado → solo actualizar CP/estado/ciudad
      await sheetsService.updateOrderData(session.customer.rowIndex, updatedData)
        .catch(err => console.error('Error actualizando CP:', err.message));
      sessionManager.updateSession(phone, {
        customer: { ...session.customer, ...updatedData },
      });
      session.customer = { ...session.customer, ...updatedData };
    } else {
      // Cliente sin registro → crear nuevo
      const customerData = {
        phone,
        name:          session.tempData?.name || session.customer?.name || '',
        email:         '',
        ...updatedData,
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
        console.error('Error registrando cliente:', err.message);
      }
      const updatedCustomer = { ...customerData, rowIndex };
      sessionManager.updateSession(phone, { customer: updatedCustomer });
      session.customer = updatedCustomer;
    }

    if (isLocal) {
      const zone = cpIsCDMX(cp) ? 'CDMX' : 'Estado de México';
      sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
      await notifyWig(phone, { ...session, customer: session.customer },
        `Zona local (${zone} / CP: ${cp})`,
        `Cliente de ${zone} requiere atención personalizada`);
      if (session.customer?.rowIndex) {
        sheetsService.updateOrderData(session.customer.rowIndex, {
          notas: `Cliente de ${zone} — atención por asesor`,
        }).catch(() => {});
      }
      const firstName = primerNombre(session.customer?.name || '');
      return firstName
        ? `¡Listo, ${firstName}! 😊 En breve te contacta un asesor por este WhatsApp.`
        : '¡Listo! 😊 En breve te contacta un asesor por este WhatsApp.';
    }
  }

  // Conversación con Claude
  session.conversationHistory.push({ role: 'user', content: message });

  let response;
  try {
    response = await claudeService.chat(
      session.conversationHistory,
      session.customer,
      message
    );
  } catch (err) {
    console.error('claudeService.chat error:', err.message);
    return 'Tuve un problema técnico. ¿Me repites lo que necesitas?';
  }

  // Eliminar saludos dobles — Claude a veces genera saludos o empieza con el nombre
  const lines = response.split('\n');
  const firstLine = lines[0].trim();
  const esSoloNombreOSaludo = (
    /^[¡!]?\s*(hola|bienvenid[oa]|buenos\s*d[ií]as|buenas\s*tardes|buenas\s*noches)/i.test(firstLine) ||
    (firstLine.length < 35 && /^[A-ZÁÉÍÓÚÑ]/.test(firstLine) &&
     /[!,👋🌾😊🐾]\s*$/.test(firstLine))
  );
  if (esSoloNombreOSaludo) {
    lines.shift();
    response = lines.join('\n').trim();
  }
  if (!response) response = '¿En qué te puedo ayudar? 😊';

  // Normalizar formato para WhatsApp
  response = response.replace(/\*\*([^*]+)\*\*/g, '*$1*');
  response = response.replace(/^---+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();

  // Eliminar respuestas duplicadas — cuando el debounce acumula mensajes,
  // Claude puede generar dos párrafos que responden lo mismo
  const parrafos = response.split(/\n\n+/);
  if (parrafos.length > 2) {
    // Comparar inicio de párrafos para detectar contenido repetido
    const palabras0 = new Set(parrafos[0].toLowerCase().split(/\s+/).slice(0, 8));
    const palabras1 = new Set(parrafos[1].toLowerCase().split(/\s+/).slice(0, 8));
    const comunes = [...palabras0].filter(w => palabras1.has(w) && w.length > 3).length;
    if (comunes >= 3) response = parrafos[0];
  }

  if (!response) response = '¿En qué te puedo ayudar? 😊';

  if (response.includes('ESCALAR_A_WIG')) {
    return escalateWithResumen(phone, session, 'Detectado por Claude');
  }

  session.conversationHistory.push({ role: 'assistant', content: response });
  sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
  sheetsService.appendConversationLog(phone, message, response).catch(() => {});

  return response;
}

// ── Confirmar reset ───────────────────────────────────────────────────────────

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
    case 'asking_mexico': return handleAskingMexico(phone, message, restored);
    default:              return handleActive(phone, message, restored);
  }
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

// ── Resumen y escalación con confirmación ─────────────────────────────────────

async function generateResumen(conversationHistory, customer) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const historial = (conversationHistory || []).slice(-10)
      .map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`)
      .join('\n');

    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 150,
      messages: [{
        role: 'user',
        content: `Basándote en esta conversación, genera UN resumen corto (máximo 2 líneas) ` +
          `de lo que necesita el cliente. Empieza con "Cliente necesita..." o "Cliente quiere...".\n` +
          `Solo el resumen, sin explicaciones adicionales.\n\nConversación:\n${historial}`,
      }],
    });
    return response.content[0].text.trim();
  } catch (err) {
    console.error('Error generando resumen:', err.message);
    return 'Cliente requiere atención de un asesor';
  }
}

async function escalateWithResumen(phone, session, motivo) {
  const resumen = await generateResumen(
    session.conversationHistory || [],
    session.customer
  );

  session.tempData = {
    ...session.tempData,
    resumenEscalacion: resumen,
    motivoEscalacion:  motivo,
  };
  sessionManager.updateSession(phone, {
    flowState: 'confirming_escalation',
    tempData:  session.tempData,
  });

  return `Antes de conectarte con un asesor, déjame confirmar tu solicitud:\n\n"${resumen}"\n\n¿Es correcto? 😊`;
}

const CONFIRMA_PATTERNS = /^(s[ií]|correcto|exacto|así es|eso es|ok|dale|sí eso|claro|perfecto|confirmo)$/i;
const CORRIGE_PATTERNS  = /^(no|no es|no exactamente|espera|corrige|falta|también|además)/i;

async function handleConfirmingEscalation(phone, message, session) {
  const resumen = session.tempData?.resumenEscalacion || 'Cliente requiere atención de un asesor';
  const motivo  = session.tempData?.motivoEscalacion  || '';

  if (CONFIRMA_PATTERNS.test(message.trim())) {
    await notifyWig(phone, session, motivo, resumen);

    if (session.customer?.rowIndex) {
      sheetsService.updateOrderData(session.customer.rowIndex, {
        notas: resumen,
      }).catch(() => {});
    }

    sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    const firstName = primerNombre(session.customer?.name || session.tempData?.name || '');
    return firstName
      ? `¡Listo, ${firstName}! 🙌 Un asesor te contactará en breve.`
      : '¡Listo! 🙌 Un asesor te contactará en breve.';
  }

  if (CORRIGE_PATTERNS.test(message.trim())) {
    sessionManager.updateSession(phone, {
      flowState: 'confirming_escalation',
      tempData:  { ...session.tempData, esperandoCorreccion: true },
    });
    return '¿Cómo lo describirías tú? Cuéntame en tus palabras 😊';
  }

  if (session.tempData?.esperandoCorreccion) {
    const nuevaDescripcion = message.trim();
    session.tempData.resumenEscalacion  = nuevaDescripcion;
    session.tempData.esperandoCorreccion = false;
    sessionManager.updateSession(phone, { tempData: session.tempData });
    return `Perfecto, queda así:\n\n"${nuevaDescripcion}"\n\n¿Lo confirmas? 😊`;
  }

  return `Tu solicitud quedó como:\n\n"${resumen}"\n\n¿Está bien así o quieres cambiar algo?`;
}

// ── Notificación a asesor ─────────────────────────────────────────────────────

async function notifyWig(phone, session, motivo = '', resumen = '') {
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
    `🚨 *NUEVA SOLICITUD*\n\n` +
    `👤 *${customer.name || tempData.name || 'Sin nombre'}*\n` +
    `📱 ${phone.replace('whatsapp:', '')}\n` +
    `📍 ${customer.city || tempData.city || 'N/D'}${customer.state ? ', ' + customer.state : ''}\n\n` +
    `📋 *Solicitud:* ${resumen || motivo}\n\n` +
    `📌 *Motivo:* ${motivo}\n\n` +
    `*Conversación reciente:*\n${transcript}`;

  console.log(`📤 Intentando notificar a Wig | to: ${wigNumber} | motivo: ${motivo}`);
  try {
    const result = await twilioService.sendMessage(wigNumber, msg);
    console.log(`📲 Wig notificado | sid: ${result.sid} | status: ${result.status} | errorCode: ${result.errorCode ?? 'none'} | errorMsg: ${result.errorMessage ?? 'none'}`);
  } catch (err) {
    console.error(`❌ Error notificando a Wig | code: ${err.code} | status: ${err.status} | msg: ${err.message} | moreInfo: ${err.moreInfo}`);
  }
}

module.exports = { handleMessage };
