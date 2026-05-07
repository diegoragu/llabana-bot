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

const sessionManager    = require('./sessionManager');
const sheetsService     = require('./sheetsService');
const claudeService     = require('./claudeService');
const twilioService     = require('./twilioService');
const shopifyService    = require('./shopifyService');
const horarioService    = require('./horarioService');
const colaEscalaciones  = require('./colaEscalaciones');

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
  /distribuidor/i,
  /revendedor/i,
  /grandes?\s*cantidades?\s+(?:de\s+)?(?:tons?|toneladas?|cami[oó]n)/i,
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

const RH_PATTERNS = [
  /\bvacante/i, /\bempleo\b/i, /\btrabajo\b/i, /\bcontrataci[oó]n/i,
  /\brecursos\s*humanos/i, /\brh\b/i, /\bpostularme\b/i, /\bpostulaci[oó]n/i,
  /\bcurr[ií]culum\b/i, /\bcv\b/i, /\bsueldo\b/i, /\bplaza\b/i,
  /\bmonitorista\b/i, /\bencargado\b/i, /me\s+interesa\s+(la\s+)?plaza/i,
  /busco\s+(trabajo|empleo)/i, /quiero\s+trabajar/i,
];

function isRHRequest(text) {
  return RH_PATTERNS.some(re => re.test(text));
}

const DESPEDIDA_PATTERNS = /^(gracias|muchas gracias|seria todo|sería todo|ok gracias|vale gracias|listo gracias|perfecto gracias|hasta luego|bye|adios|adiós|no gracias|es todo|eso es todo|por ahora es todo|nada mas|nada más)$/i;

const ENTRY_POINT_MAP = {
  'quiero mas informacion':               'Llabana.com Footer',
  'me podrian dar mas informacion':       'Llabana.com Header',
  'quiero mas informes':                  'Llabana.com Chatbot',
  'vi un producto que me interesa':       'Llabana.com Producto',
  'vi un producto en su tienda en linea': 'llabanaenlinea.com Producto',
  'me mandaron aqui desde la tienda':     'llabanaenlinea.com Chatbot',
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
  const TITULOS = /^(dr\.?|dra\.?|doctor|doctora|ing\.?|lic\.?|mtro\.?|mtra\.?|prof\.?|sr\.?|sra\.?|don|doña)\s+/i;
  const sinTitulo = (nombre || '').replace(TITULOS, '').trim();
  return sinTitulo.split(/\s+/)[0] || '';
}

/** Recorta conversationHistory a los últimos N mensajes (par user/assistant) */
function trimHistory(history, max = 20) {
  if (!Array.isArray(history) || history.length <= max) return history;
  return history.slice(-max);
}

// ── Punto de entrada ──────────────────────────────────────────────────────────

async function handleMessage(phone, messageBody) {
  // Reset manual
  if (RESET_PATTERNS.test(messageBody.trim())) {
    await sessionManager.deleteSession(phone);
  }

  let session = await sessionManager.getSession(phone);

  // Detectar origen en sesión activa
  if (session) {
    const origenNuevo = detectarOrigen(messageBody);
    if (origenNuevo !== 'Directo' &&
        (!session.tempData?.entryPoint || session.tempData.entryPoint === 'Directo')) {
      session.tempData = { ...session.tempData, entryPoint: origenNuevo };
      await sessionManager.updateSession(phone, { tempData: session.tempData });
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
    session = await sessionManager.createSession(phone);
    session.tempData = { entryPoint };
    await sessionManager.updateSession(phone, { tempData: session.tempData });

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

      // Actualizar nombre si el registro quedó vacío (ej. tras reinicio mid-flow)
      if (customer.rowIndex && !customer.name && session.tempData?.name) {
        sheetsService.updateOrderData(customer.rowIndex, {
          name: session.tempData.name,
        }).catch(() => {});
      }

      // Recuperar escalación pendiente tras reinicio de servidor
      const notas = customer.notas || '';
      const pendiente = notas.match(/PENDIENTE_ESCALACION: (.+)/);
      if (pendiente) {
        const resumenGuardado = pendiente[1];
        await sessionManager.updateSession(phone, {
          flowState: 'confirming_escalation',
          customer:  customerData,
          tempData:  {
            ...session.tempData,
            resumenEscalacion: resumenGuardado,
            motivoEscalacion:  'Retomado tras reinicio',
          },
        });
        return `Retomando tu solicitud anterior:\n\n"${resumenGuardado}"\n\n¿Confirmas que esto es lo que necesitas? 😊`;
      }

      const nombre = primerNombre(customer.name);
      if (!nombre) {
        await sessionManager.updateSession(phone, {
          flowState: 'asking_name',
          customer:  customerData,
        });
        return '¡Hola! 👋 ¿Con quién tengo el gusto?';
      }
      // Cliente existente con nombre → verificar si el mensaje es solo un entry point
      await sessionManager.updateSession(phone, {
        flowState: 'active',
        customer:  customerData,
      });

      // Si el mensaje es un entry point conocido → saludar sin pasarlo a Claude
      const esEntryPoint = detectarOrigen(messageBody) !== 'Directo';
      if (esEntryPoint) {
        return `¡Hola ${nombre}! 👋 Qué gusto verte de nuevo. ¿En qué te puedo ayudar hoy?`;
      }

      // Si es un mensaje real → procesarlo con Claude
      return handleActive(phone, messageBody, await sessionManager.getSession(phone));
    }

    // Cliente nuevo → verificar número mexicano antes de saludar
    const esMexicano = phone.startsWith('whatsapp:+521') ||
                       phone.startsWith('whatsapp:+52');
    if (!esMexicano) {
      await sessionManager.updateSession(phone, { flowState: 'asking_entrega_mx' });
      console.log(`🌎 Número extranjero — preguntando dirección MX: ${phone}`);
      return 'Hola 👋 Nosotros entregamos a cualquier dirección en México 📦 ¿Tienes una dirección en México donde podamos enviarte el pedido?';
    }

    await sessionManager.updateSession(phone, { flowState: 'asking_mexico' });
    return pick(WELCOME_VARIANTS);
  }

  // Rutear
  switch (session.flowState) {
    case 'asking_mexico':    return handleAskingMexico(phone, messageBody, session);
    case 'asking_name':      return handleAskingName(phone, messageBody, session);
    case 'active':           return handleActive(phone, messageBody, session);
    case 'waiting_for_wig': {
      // Detectar respuesta al Follow-up C
      if (session.tempData?.followupCEnviado) {
        const noFueAtendido = /no\b|nadie|nunca|todavía|aún no|siguen sin|no me han/i.test(messageBody);
        const sisFueAtendido = /^(sí|si|ya|me atendieron|perfecto|listo|ok|claro)$/i.test(messageBody.trim().toLowerCase());
        if (noFueAtendido) {
          await notifyWig(phone, session, '🚨 URGENTE — Cliente sin atención después de 23h');
          await sessionManager.updateSession(phone, {
            tempData: { ...session.tempData, followupCEnviado: false },
          });
          return 'Disculpa la espera 😔 Voy a marcar tu caso como urgente para que te contacten lo antes posible.';
        }
        if (sisFueAtendido) {
          await sessionManager.updateSession(phone, {
            tempData: { ...session.tempData, followupCEnviado: false },
          });
          return '¡Qué gusto! 😊 Quedamos a tus órdenes para lo que necesites 🌾';
        }
      }

      // Si ya es horario de atención y el cliente escribe de nuevo → notificar a Wig ahora
      if (horarioService.estaEnHorario() && session.tempData?.escalacionPendiente) {
        await sessionManager.updateSession(phone, {
          tempData: { ...session.tempData, escalacionPendiente: false },
        });
        await notifyWig(phone, session, `Cliente retomó conversación — ya en horario de atención`);
        return 'Ya avisé al asesor, en breve te contacta 🙌 ¿Hay algo en lo que pueda ayudarte mientras tanto?';
      }

      const wigAvisado = session.tempData?.wigAvisado || false;

      if (!wigAvisado) {
        // Primera vez que escribe después de escalar — avisar y marcar
        sessionManager.updateSession(phone, {
          tempData: { ...session.tempData, wigAvisado: true },
        });
        return 'Ya avisé al asesor, te contactará en breve 🙌\n\nMientras tanto puedo ayudarte con lo que necesites — asesoría de productos, recomendaciones de alimento, dudas de envío. ¿En qué te ayudo?';
      }

      // Ya fue notificado — responder directamente SIN pasar por Claude
      // para evitar que Claude vuelva a detectar escalación y genere loop
      const msg = messageBody.trim().toLowerCase();

      // Mensajes de cierre — responder y quedarse en waiting_for_wig
      const esCierre = /^(gracias|ok|okay|de acuerdo|perfecto|listo|entendido|si|sí|👍|okey)$/i.test(msg);
      if (esCierre) {
        return '¡Con gusto! 🙌 El asesor te contactará en breve por aquí mismo.';
      }

      // Cualquier otra consulta real — atender con Claude pero sin detección de escalación
      session.conversationHistory.push({ role: 'user', content: messageBody });
      let response;
      try {
        response = await claudeService.chat(session.conversationHistory, session.customer);
      } catch (err) {
        console.error('claudeService.chat error en waiting_for_wig:', err.message);
        return 'Tuve un problema técnico. ¿Me repites lo que necesitas?';
      }

      // Si Claude quiere escalar de nuevo — ignorar, ya está escalado
      if (response.includes('ESCALAR_A_WIG')) {
        return '¡Con gusto! 🙌 El asesor te contactará en breve por aquí mismo.';
      }

      session.conversationHistory.push({ role: 'assistant', content: response });
      sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
      return response;
    }
    case 'escalated':        return handleEscalated(phone, messageBody, session);
    case 'asking_cp_before_escalation': return handleAskingCpBeforeEscalation(phone, messageBody, session);
    case 'confirming_name':  return handleConfirmingName(phone, messageBody, session);
    case 'confirming_reset':        return handleConfirmingReset(phone, messageBody, session);
    case 'confirming_escalation':   return handleConfirmingEscalation(phone, messageBody, session);
    case 'asking_entrega_mx': return handleAskingEntregaMx(phone, messageBody, session);
    case 'out_of_coverage':         return 'Con gusto te ayudamos cuando estés en México 🌾';
    default:
      await sessionManager.deleteSession(phone);
      return 'Algo salió mal. Escríbeme de nuevo.';
  }
}

// ── Mutex para evitar registros duplicados por race condition ─────────────────

const registrandoTelefonos = new Set();

// ── Extractor de nombre desde texto libre ─────────────────────────────────────

function extraerNombreDelMensaje(mensaje) {
  const p1 = mensaje.match(
    /(?:mi\s+nombre\s+es|me\s+llamo|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i
  );
  if (p1) return p1[1].trim();

  const p2 = mensaje.match(
    /^con\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/i
  );
  if (p2) return p2[1].trim();

  return null;
}

// ── Detector de estado mexicano en texto ─────────────────────────────────────

function detectarUbicacionMX(texto) {
  return /\b(aguascalientes|baja\s*california|campeche|chiapas|chihuahua|coahuila|colima|durango|guanajuato|guerrero|hidalgo|jalisco|guadalajara|michoac[aá]n|morelos|nayarit|nuevo\s*le[oó]n|monterrey|oaxaca|puebla|quer[eé]taro|quintana\s*roo|san\s*luis\s*potos[ií]|sinaloa|sonora|tabasco|tamaulipas|tlaxcala|veracruz|yucat[aá]n|zacatecas|m[eé]rida|hermosillo|culiac[aá]n|saltillo|villahermosa|tuxtla|xalapa|tepic|pachuca|chetumal|la\s*paz)\b/i
    .test(texto);
}

// ── Detector de zona local por texto ─────────────────────────────────────────

function mencionaZonaLocal(texto) {
  return /\b(estado\s+de\s+m[eé]xico|edomex|edo\.?\s*mex|ecatepec|toluca|neza(hualcoyotl)?|naucalpan|tlalnepantla|chimalhuacan|texcoco|chalco|ciudad\s+de\s+m[eé]xico|cdmx|df|distrito\s+federal|iztapalapa|coyoac[aá]n|xochimilco|tlalpan|azcapotzalco|gustavo\s+a|venustiano\s+carranza|miguel\s+hidalgo|benito\s+ju[aá]rez|cuauht[eé]moc|tlahuac|magdalena\s+contreras|cuajimalpa|milpa\s+alta)\b/i
    .test(texto);
}

/**
 * Detecta si el cliente es de zona local (CDMX/Edomex) por texto o por CP.
 * Centraliza la lógica duplicada de mencionaZonaLocal + cpIsCDMX + cpIsEdomex.
 */
function esZonaLocal(texto = '', cp = '') {
  if (texto && mencionaZonaLocal(texto)) return true;
  if (cp && (cpIsCDMX(cp) || cpIsEdomex(cp))) return true;
  return false;
}

// ── Entrega en México (números extranjeros) ────────────────────────────────────

async function handleAskingEntregaMx(phone, message, session) {
  const msg = message.trim().toLowerCase();
  const esSi = /^(s[ií]|sí|ok|okay|claro|tengo|sí tengo|si tengo|afirmo|correcto|así es)$/i.test(msg)
    || /tengo\s+(una\s+)?(dirección|domicilio|bodega|negocio)\s+(en\s+)?méxico/i.test(msg);
  const esNo = /^no\b|no tengo|no cuento|no hay|fuera de méxico/i.test(msg)
    || /\b(ecuador|peru|perú|guatemala|colombia|venezuela|argentina|españa|estados\s*unidos|usa|canada|chile|cuba|honduras|panama|brasil|bolivia|uruguay|nicaragua|costa\s*rica)\b/i.test(msg)
    || /\b(extranjero|otro\s*pa[ií]s|fuera\s*del\s*pa[ií]s|internacional|no\s*llega|ac[aá]\s*no|all[aá]\s*no)\b/i.test(msg)
    || /\bsoy\s+d[e]?\s+(peru|perú|ecuador|colombia|argentina|chile|venezuela|guatemala|honduras|panama|brasil|bolivia|uruguay|cuba)\b/i.test(msg)
    || (/\benviar?\s+a\s+\w+|llegar?\s+a\s+\w+/i.test(msg) && !/m[eé]xico/i.test(msg))
    || /\bno\b.{0,30}\b(llega|entregan?|envían?|mandan?)\b/i.test(msg);

  // Detectar pregunta sobre envío internacional — explicar política antes de preguntar
  const preguntaExportacion = /enviar?\s+a\s+\w+|llegar?\s+a\s+\w+|envío\s+internacional|mandan?\s+a\s+\w+/i.test(msg)
    && !/méxico|mexico/i.test(msg);

  if (preguntaExportacion && !esNo) {
    const intentos = (session.tempData?.entregaMxIntentos || 0) + 1;
    await sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, entregaMxIntentos: intentos },
    });
    return 'Nosotros entregamos a cualquier dirección dentro de México 📦 Desde ahí puedes llevarlo a donde necesites — el envío internacional corre por tu cuenta.\n\n¿Tienes alguna dirección en México donde podamos enviarte el pedido?';
  }

  if (esSi) {
    // Tiene dirección en México — continuar como cliente normal
    await sessionManager.updateSession(phone, { flowState: 'asking_name', tempData: { ...session.tempData, nameAttempts: 0 } });
    return '¡Perfecto! 😊 ¿Con quién tengo el gusto?';
  }

  if (esNo) {
    // No tiene dirección en México — cerrar amablemente
    await sessionManager.deleteSession(phone);
    return 'Entendido 🙏 Por el momento nuestros envíos son solo dentro de México. Si en algún momento consigues una dirección mexicana, con gusto te ayudamos 🌾';
  }

  // Respuesta ambigua — hasta 2 intentos, luego out_of_coverage
  const intentos = (session.tempData?.entregaMxIntentos || 0) + 1;
  if (intentos >= 2) {
    await sessionManager.updateSession(phone, { flowState: 'out_of_coverage' });
    return OUT_OF_COVERAGE_MSG;
  }
  await sessionManager.updateSession(phone, {
    tempData: { ...session.tempData, entregaMxIntentos: intentos },
  });
  return '¿Cuentas con una dirección de entrega en México? 📦 Con un "sí" o "no" me ayudas a orientarte mejor 😊';
}

// ── Filtro México ─────────────────────────────────────────────────────────────

async function handleAskingMexico(phone, message, session) {
  if (isOutsideMexico(message)) {
    await sessionManager.updateSession(phone, { flowState: 'out_of_coverage' });
    return OUT_OF_COVERAGE_MSG;
  }

  if (!phone.startsWith('whatsapp:+52')) {
    await sessionManager.updateSession(phone, { flowState: 'asking_entrega_mx' });
    return 'Hola 👋 Nosotros entregamos a cualquier dirección en México 📦 ¿Tienes una dirección en México donde podamos enviarte el pedido?';
  }

  // Detectar estado/ciudad mexicana → saltar confirmación de México
  if (detectarUbicacionMX(message)) {
    const nombreDetectado = extraerNombreDelMensaje(message);
    const nombreLimpio = nombreDetectado ? sheetsService.limpiarNombre(nombreDetectado) : null;

    let ubicRowIndex = null;
    try {
      const yaExisteUbic = await sheetsService.findCustomer(phone);
      if (yaExisteUbic) {
        ubicRowIndex = yaExisteUbic.rowIndex;
      } else {
        ubicRowIndex = await sheetsService.registerCustomer({
          phone, name: nombreLimpio || '', email: '', state: '', city: '', cp: '',
          channel: 'paqueteria', channelDetail: 'Nacional', segmento: 'Lead frío',
          aceWa: 'SI', entryPoint: session.tempData?.entryPoint || 'Directo', origen: 'WhatsApp',
        });
        console.log(`✅ Lead registrado por ubicación MX detectada | ${phone}`);
      }
    } catch (err) {
      console.error('Error registrando cliente por ubicación MX:', err.message);
    }

    const customerUbic = {
      phone, name: nombreLimpio || '', rowIndex: ubicRowIndex,
      channel: 'paqueteria', channelDetail: 'Nacional', segmento: 'Lead frío',
    };

    if (nombreLimpio) {
      await sessionManager.updateSession(phone, {
        flowState: 'active',
        tempData:  { ...session.tempData, name: nombreLimpio, nameAttempts: 0, primerMensaje: message },
        customer:  customerUbic,
      });
      const first = primerNombre(nombreLimpio);
      return pick([
        `¡Mucho gusto, ${first}! 😊 ¿En qué te puedo ayudar?`,
        `¡Qué bueno que nos escribes, ${first}! ¿En qué te ayudo?`,
        `Gracias ${first} 🌾 ¿Qué necesitas hoy?`,
      ]);
    }

    await sessionManager.updateSession(phone, {
      flowState: 'asking_name',
      tempData:  { ...session.tempData, nameAttempts: 0, primerMensaje: message },
      customer:  customerUbic,
    });
    return '¿Con quién tengo el gusto? 😊';
  }

  // Detectar sucursal/distribuidor B2B
  const esSucursal = /\b(sucursal|distribuidor|tienda|negocio|local|establecimiento|punto\s+de\s+venta)\b/i.test(message);

  // Detectar CDMX/Edomex mencionado en texto antes de registrar
  if (mencionaZonaLocal(message)) {
    const stateDetectado = /estado\s+de\s+m[eé]xico|edomex|edo\.?\s*mex|ecatepec|toluca|neza|naucalpan|tlalnepantla|chimalhuacan|texcoco|chalco/i.test(message)
      ? 'Estado de México' : 'Ciudad de México';

    let localRowIndex = null;
    try {
      const yaExisteLocal = await sheetsService.findCustomer(phone);
      if (yaExisteLocal) {
        localRowIndex = yaExisteLocal.rowIndex;
        sheetsService.updateOrderData(localRowIndex, { state: stateDetectado }).catch(() => {});
      } else {
        localRowIndex = await sheetsService.registerCustomer({
          phone, name: '', email: '', state: stateDetectado, city: '', cp: '',
          channel: 'paqueteria', channelDetail: 'Nacional', segmento: 'Lead frío',
          aceWa: 'SI', entryPoint: session.tempData?.entryPoint || 'Directo', origen: 'WhatsApp',
        });
      }
    } catch (err) {
      console.error('Error registrando cliente zona local por texto:', err.message);
    }

    if (esSucursal && localRowIndex) {
      sheetsService.updateOrderData(localRowIndex, {
        notas: `B2B — Sucursal/Distribuidor: ${message.substring(0, 100)}`,
      }).catch(() => {});
      sheetsService.appendTag(localRowIndex, 'Sucursal').catch(() => {});
    }

    const customerLocal = {
      phone, state: stateDetectado, rowIndex: localRowIndex,
      channel: 'paqueteria', channelDetail: 'Nacional', segmento: 'Lead frío',
    };
    await sessionManager.updateSession(phone, { customer: customerLocal });
    const sessionLocal = await sessionManager.getSession(phone);
    const motivoLocal = esSucursal
      ? `Zona local (${stateDetectado}) — ES SUCURSAL/DISTRIBUIDOR: "${message.substring(0, 80)}"`
      : `Zona local detectada por texto: "${message.substring(0, 80)}"`;
    const { fueraHorario: fueraH2 } = await notifyWig(
      phone,
      sessionLocal || { ...session, customer: customerLocal },
      motivoLocal,
      stateDetectado
    );

    if (fueraH2) {
      await sessionManager.updateSession(phone, {
        flowState: 'active',
        tempData:  { ...session.tempData, escalacionPendiente: true },
      });
      const msgs = horarioService.mensajeFueraHorario();
      return msgs[Math.floor(Math.random() * msgs.length)];
    }

    await sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    return pick([
      '¡Qué bueno! 😊 Un asesor de Llabana te contactará en breve por este WhatsApp.',
      '¡Perfecto! 🙌 En breve te contacta un asesor directamente.',
    ]);
  }

  // México confirmado → registrar lead (o reusar si ya existe) y pedir nombre
  let rowIndex = null;

  // Mutex: evitar registro doble por mensajes en ráfaga
  if (registrandoTelefonos.has(phone)) {
    console.log(`⏳ Registro en curso para ${phone}, esperando...`);
    await new Promise(r => setTimeout(r, 2000));
    const yaRegistrado = await sheetsService.findCustomer(phone);
    if (yaRegistrado) {
      await sessionManager.updateSession(phone, {
        flowState: 'asking_name',
        customer: { ...yaRegistrado, channel: 'paqueteria', channelDetail: 'Nacional' },
      });
      return '¿Con quién tengo el gusto? 😊';
    }
  }

  registrandoTelefonos.add(phone);
  try {
    const yaExiste = await sheetsService.findCustomer(phone);
    if (yaExiste) {
      rowIndex = yaExiste.rowIndex;
      await sessionManager.updateSession(phone, {
        customer: {
          ...yaExiste,
          channel:       'paqueteria',
          channelDetail: 'Nacional',
        },
      });
      console.log(`🔄 Cliente ya existe, usando fila ${rowIndex}`);
    } else {
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
      await sessionManager.updateSession(phone, {
        customer: {
          phone,
          rowIndex,
          channel:       'paqueteria',
          channelDetail: 'Nacional',
          segmento:      'Lead frío',
        },
      });
      console.log(`✅ Lead registrado al confirmar México | ${phone} | fila ${rowIndex}`);
    }
  } catch (err) {
    console.error('Error registrando lead en México:', err.message);
  } finally {
    registrandoTelefonos.delete(phone);
  }

  // Intentar extraer nombre del mismo mensaje de confirmación de México
  const nombreDetectado = extraerNombreDelMensaje(message);
  const nombreLimpio = nombreDetectado ? sheetsService.limpiarNombre(nombreDetectado) : null;

  if (nombreLimpio) {
    if (rowIndex) {
      sheetsService.updateOrderData(rowIndex, { name: nombreLimpio }).catch(() => {});
    }
    await sessionManager.updateSession(phone, {
      flowState: 'active',
      tempData:  { ...session.tempData, name: nombreLimpio, nameAttempts: 0 },
    });
    const first = primerNombre(nombreLimpio);
    return pick([
      `¡Mucho gusto, ${first}! 😊 ¿En qué te puedo ayudar?`,
      `¡Qué bueno que nos escribes, ${first}! ¿En qué te ayudo?`,
      `Gracias ${first} 🌾 ¿Qué necesitas hoy?`,
    ]);
  }

  // Detectar si el mensaje contiene una consulta real además de confirmar México
  const msgNorm = message.trim().toLowerCase();
  const soloConfirmacion = /^(s[ií]|sí|si|ok|okay|claro|afirma|mexico|méxico|aquí|aca|acá|desde\s+\w+)$/i.test(msgNorm);
  const esGenerico = /^(informes?|información|info|catálogo|catalogo|precios?|productos?|hola|buenas?|buen\s*d[ií]a)$/i.test(message.trim().toLowerCase());
  if (!soloConfirmacion && message.trim().length > 5 && !esGenerico) {
    const previo = session.tempData?.intentPrevio || '';
    await sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, intentPrevio: previo ? `${previo}. ${message.trim()}` : message.trim() },
    });
  }

  await sessionManager.updateSession(phone, { flowState: 'asking_name' });
  return '¿Con quién tengo el gusto? 😊';
}

// ── Nombre ────────────────────────────────────────────────────────────────────

const RESPUESTA_FLUJO = /^(s[ií],?|no,?|ok,?|claro,?|desde\s+\w+|estoy\s+en|soy\s+de|vengo\s+de)/i;

const NO_ES_NOMBRE = /^(saber|buscar|cotizar|preguntar|consultar|verificar|checar|querer|necesitar|tiene[n]?(\s|$)|es\s+(saber|que|para|sobre|correcto|as[ií]|en\s)|para\s+(saber|este|ese|el|la|los|las|un|una)\s|quiero\s+saber|quisiera|necesito|me\s+gustar[ií]a|tiene\s+costo|tiene\s+precio|tiene\s+env[ií]o|cuanto\s+cuesta|si\s+tiene|si\s+manejan|de\s+el\s+estado|del\s+estado|en\s+el\s+estado|en\s+\w|estoy\s+en\s|vengo\s+de\s|soy\s+de\s|as[ií](\s+(es|est[aá]|lo)|$)|correcto|exacto|ok(\s|$)|alcald[ií]a|municipio|colonia|delegaci[oó]n|rancho|ejido|comunidad|fraccionamiento|barrio|pueblo|villa|ciudad|M[eé]xico|Quer[eé]taro|Oaxaca|Puebla|Jalisco|Veracruz|Chiapas|Guerrero|Sonora|Chihuahua|Sinaloa|Tamaulipas|Coahuila|Hidalgo|Tabasco|Campeche|Yucat[aá]n|Quintana\s+Roo|Monterrey|Guadalajara|CDMX|Ciudad\s+de\s+M[eé]xico|por\s|para\s|con\s|sin\s|ante\s|bajo\s|desde\s|entre\s|hacia\s|hasta\s|seg[uú]n\s|sobre\s|tras\s|mediante\s|durante\s|excepto\s|salvo\s|incluso\s|aunque\s|si\s+me\s+|si\s+tiene|si\s+manejan|d[oó]nde|cu[aá]ndo|cu[aá]nto|c[oó]mo\s|qu[eé]\s+precio)/i;

async function handleAskingName(phone, message, session) {
  // Rechazar verbos de intención que no son nombres
  if (NO_ES_NOMBRE.test(message.trim())) {
    const attempts = session.tempData?.nameAttempts ?? 0;
    if (attempts < 2) {
      await sessionManager.updateSession(phone, {
        tempData: { ...session.tempData, nameAttempts: attempts + 1 },
      });
    } else {
      await sessionManager.updateSession(phone, { flowState: 'active' });
    }
    return '¿Me dices tu nombre? Por ejemplo: Juan o María 😊';
  }

  // Extraer nombre de frases como "mi nombre es X", "soy X", "me llamo X", "Con X"
  const extraido = extraerNombreDelMensaje(message);
  if (extraido) message = extraido;

  // Filtrar respuestas de contexto que no son nombres ("Sí", "Ok", "Soy de Puebla", etc.)
  if (RESPUESTA_FLUJO.test(message.trim())) {
    const partes = message.split(/,\s*/);
    if (partes.length > 1) {
      const posibleNombre = sheetsService.limpiarNombre(partes[partes.length - 1]);
      if (posibleNombre) {
        // Hay nombre después de la coma ("Sí, Juan") — usarlo
        message = partes[partes.length - 1];
      } else {
        return '¿Me dices tu nombre? 😊';
      }
    } else {
      return '¿Me dices tu nombre? 😊';
    }
  }

  // Quitar emojis antes de procesar
  const mensajeSinEmojis = message
    .replace(/[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu, '')
    .trim();

  // Intentar extraer nombre de frases de contexto (fallback si no se extrajo antes)
  const nombreExtraido = extraerNombreDelMensaje(mensajeSinEmojis) || mensajeSinEmojis;
  const nombre = sheetsService.limpiarNombre(nombreExtraido);
  const attempts = session.tempData?.nameAttempts ?? 0;

  if (nombre) {
    const first = primerNombre(nombre);
    if (session.customer?.rowIndex) {
      sheetsService.updateOrderData(session.customer.rowIndex, { name: nombre }).catch(() => {});
    } else {
      // Fallback: cliente sin rowIndex — registrar ahora con el nombre
      console.log(`⚠️ [NOMBRE] rowIndex no encontrado para ${phone} — registrando con nombre ${nombre}`);
      sheetsService.registerCustomer({
        phone,
        name:       nombre,
        email:      '',
        state:      session.customer?.state || '',
        city:       session.customer?.city  || '',
        cp:         '',
        segmento:   'Lead frío',
        aceWa:      'SI',
        entryPoint: session.tempData?.entryPoint || 'Directo',
        origen:     'WhatsApp',
      }).then(newRowIndex => {
        if (newRowIndex) {
          sessionManager.updateSession(phone, {
            customer: { ...session.customer, rowIndex: newRowIndex, name: nombre },
          });
          console.log(`✅ [NOMBRE] Cliente registrado con nombre en fallback | fila ${newRowIndex}`);
        }
      }).catch(err => {
        console.error(`❌ [NOMBRE] Error en fallback registro:`, err.message);
      });
    }
    // Guardar nombre temporalmente y pedir confirmación
    sessionManager.updateSession(phone, {
      flowState: 'confirming_name',
      tempData:  { ...session.tempData, namePendiente: nombre, nameAttempts: 0 },
    });
    return `Solo para confirmar — ¿tu nombre es *${nombre}*? 😊`;
  }

  // Nombre inválido
  if (attempts < 2) {
    await sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, nameAttempts: attempts + 1 },
    });
    if (attempts === 0 && session.tempData?.intentPrevio) {
      return '¿Con quién tengo el gusto? 😊 En cuanto me digas tu nombre te ayudo con eso.';
    }
    return '¿Me dices tu nombre? Por ejemplo: Juan o María 😊';
  }

  // Agotó intentos → continuar sin nombre
  await sessionManager.updateSession(phone, { flowState: 'active' });
  return '¿En qué te puedo ayudar? 😊';
}

// ── Conversación libre con Claude ─────────────────────────────────────────────

const FLOW_PATTERNS = /(primera\s*ve[zs]|es\s*mi\s*primera|nunca\s*he|no\s*he|soy\s*nuev[oa]|no,?\s*primera)/i;

async function handleActive(phone, message, session) {
  // "hola" con cliente activo → confirmar si quiere nueva consulta
  if (/^hola$/i.test(message.trim()) && session.customer) {
    session.tempData = { ...session.tempData, _prevState: 'active' };
    await sessionManager.updateSession(phone, {
      flowState: 'confirming_reset',
      tempData:  session.tempData,
    });
    return '¿Quieres empezar una nueva consulta o seguimos con lo que teníamos? 😊';
  }

  // Si ya hay escalación pendiente fuera de horario, no procesar con Claude
  if (session.tempData?.escalacionPendiente) {
    const DESPEDIDAS_PENDIENTE = /^(gracias|ok|okey|okay|bien|perfecto|entendido|👍|🙌|hasta luego|bye|adios|adiós|de acuerdo|listo|sale|muchas gracias)$/i;
    if (DESPEDIDAS_PENDIENTE.test(message.trim())) {
      return '¡Hasta luego! Te contactaremos a primera hora 🙌';
    }
    sheetsService.appendConversationLog(
      phone, message,
      '[info adicional — escalación pendiente]'
    ).catch(() => {});
    const wigAvisado = session.tempData?.wigAvisado || false;
    if (!wigAvisado) {
      await sessionManager.updateSession(phone, {
        tempData: { ...session.tempData, wigAvisado: true },
      });
      return 'Ya avisé al asesor, te contactará cuando inicien operaciones 🙌\n\nMientras tanto puedo ayudarte con lo que necesites — asesoría de productos, recomendaciones de alimento, dudas de envío. ¿En qué te ayudo?';
    }
    return '¡Con gusto! 🙌 El asesor te contactará cuando inicien operaciones por aquí mismo.';
  }

  // Agregar mensaje al historial ANTES de cualquier escalación
  // (para que generateResumen incluya el mensaje que disparó la escalación)
  session.conversationHistory.push({ role: 'user', content: message });
  session.conversationHistory = trimHistory(session.conversationHistory);
  await sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });

  // Solicitud de empleo o RH
  if (isRHRequest(message)) {
    await notifyWig(phone, session, `Solicitud de empleo o RH: "${message.substring(0, 100)}"`);
    sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    return 'Ese tema lo maneja directamente nuestro equipo 😊 Ya les avisé — en breve te contactan por este mismo WhatsApp.';
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
    const isLocal = esZonaLocal('', cp);
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
      await sessionManager.updateSession(phone, {
        customer: { ...session.customer, ...updatedData },
      });
      session.customer = { ...session.customer, ...updatedData };
    } else {
      // Verificar si ya existe por teléfono antes de crear nuevo
      const existente = await sheetsService.findCustomer(phone);
      if (existente) {
        // Ya existe — solo actualizar CP, estado y ciudad
        await sheetsService.updateOrderData(existente.rowIndex, updatedData)
          .catch(err => console.error('Error actualizando CP en existente:', err.message));
        await sessionManager.updateSession(phone, {
          customer: { ...existente, ...updatedData },
        });
        session.customer = { ...existente, ...updatedData };
        console.log(`🔄 CP actualizado en registro existente | ${phone} | fila ${existente.rowIndex}`);
      } else {
        // No existe — crear nuevo
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
        await sessionManager.updateSession(phone, { customer: updatedCustomer });
        session.customer = updatedCustomer;
      }
    }

    if (isLocal) {
      const zone = cpIsCDMX(cp) ? 'CDMX' : 'Estado de México';
      const { fueraHorario: fueraH3 } = await notifyWig(
        phone, { ...session, customer: session.customer },
        `Zona local (${zone} / CP: ${cp})`,
        `Cliente de ${zone} requiere atención personalizada`
      );
      if (session.customer?.rowIndex) {
        sheetsService.appendNota(session.customer.rowIndex, `Cliente de ${zone} — atención por asesor`).catch(() => {});
      }

      if (fueraH3) {
        await sessionManager.updateSession(phone, {
          flowState: 'active',
          tempData:  { ...session.tempData, escalacionPendiente: true },
        });
        const msgs = horarioService.mensajeFueraHorario();
        return msgs[Math.floor(Math.random() * msgs.length)];
      }

      await sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
      const firstName = primerNombre(session.customer?.name || '');
      return firstName
        ? `¡Listo, ${firstName}! 😊 En breve te contacta un asesor por este WhatsApp.`
        : '¡Listo! 😊 En breve te contacta un asesor por este WhatsApp.';
    } else {
      // Zona nacional: confirmar paquetería + responder con Claude
      let claudeResp;
      try {
        claudeResp = await claudeService.chat(
          session.conversationHistory,
          session.customer
        );
      } catch (err) {
        console.error('claudeService.chat error (CP nacional):', err.message);
      }

      if (claudeResp && claudeResp.includes('ESCALAR_A_WIG')) {
        return escalateWithResumen(phone, session, 'Detectado por Claude');
      }

      const respuesta = claudeResp
        ? `Te llegamos por paquetería 📦\n\n${claudeResp}`
        : 'Te llegamos por paquetería a todo México 📦 Haz tu pedido en llabanaenlinea.com 😊';

      session.conversationHistory.push({ role: 'assistant', content: respuesta });
      session.conversationHistory = trimHistory(session.conversationHistory);
      await sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
      sheetsService.appendConversationLog(phone, message, respuesta).catch(() => {});
      return respuesta;
    }
  }

  // Detectar nombre cuando aún no lo tenemos y el cliente lo menciona al inicio
  if (!session.customer?.name && !session.tempData?.name) {
    const nombreMatch = message.match(/^([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)\s*[,.\s]/);
    if (nombreMatch) {
      const posibleNombre = sheetsService.limpiarNombre(nombreMatch[1]);
      if (posibleNombre && posibleNombre.split(' ').length >= 2) {
        session.tempData = { ...session.tempData, name: posibleNombre };
        await sessionManager.updateSession(phone, { tempData: session.tempData });
        if (session.customer?.rowIndex) {
          sheetsService.updateOrderData(session.customer.rowIndex,
            { name: posibleNombre }).catch(() => {});
        }
        console.log(`👤 Nombre detectado en active: ${posibleNombre}`);
      }
    }
  }

  // Detectar si el cliente mencionó una cantidad de bultos o toneladas (suma todas las menciones)
  // Se hace ANTES de llamar a Claude para que ya tenga la cantidad en tempData al decidir
  const cantidadMatches = [...message.matchAll(/(\d+)\s*(bultos?|costales?|sacos?|toneladas?|tons?|kg|kilos?)/gi)];
  if (cantidadMatches.length > 0) {
    let totalBultos = 0;
    for (const match of cantidadMatches) {
      let cantidad = parseInt(match[1]);
      const unidad = match[2].toLowerCase();
      if (/ton/.test(unidad)) cantidad = cantidad * 40;
      if (/kg|kilo/.test(unidad)) cantidad = Math.ceil(cantidad / 25);
      totalBultos += cantidad;
    }
    if (totalBultos > 0) {
      sessionManager.updateSession(phone, {
        tempData: { ...session.tempData, cantidadBultos: totalBultos },
      });
      console.log(`📦 Cantidad detectada: ${totalBultos} bultos | ${phone}`);
    }
  }

  // Conversación con Claude
  // (el mensaje ya fue agregado al historial antes de los checks de escalación)

  let response;
  try {
    response = await claudeService.chat(
      session.conversationHistory,
      session.customer
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

  // Diagnóstico: cliente se despide sin haber recibido link de compra
  const DESPEDIDAS_DIAG = /^(gracias|ok|okey|bye|adios|adiós|hasta luego|no gracias|está bien|de acuerdo|ya no|ya vi|lo pienso|lo considero)$/i;
  const COMPRO_DIAG = /llabanaenlinea\.com|pedido|comprar|ordenar/i;
  if (DESPEDIDAS_DIAG.test(message.trim())) {
    const tuvoProducto = session.conversationHistory
      .some(m => COMPRO_DIAG.test(m.content || ''));
    if (!tuvoProducto) {
      console.log(
        `🔍 [DIAGNOSTICO:SIN_COMPRA] ` +
        `nombre="${session.customer?.name || session.tempData?.name || 'N/D'}" | ` +
        `ultimo_mensaje="${message}" | ` +
        `total_mensajes=${session.conversationHistory.length} | ` +
        `flow=${session.flowState}`
      );
    }
  }

  if (response.includes('QUEJA_PEDIDO')) {
    const respuestaLimpia = response.replace('QUEJA_PEDIDO', '').trim();

    // Notificar a Wig con urgencia
    await notifyWig(phone, session, `🚨 URGENTE — Problema con pedido: "${message.substring(0, 100)}"`);

    // NO cambiar flowState — el bot sigue atendiendo mientras Wig revisa
    // Solo registrar en Sheets que hay una queja activa
    if (session.customer?.rowIndex) {
      sheetsService.appendTag(session.customer.rowIndex, 'Queja').catch(() => {});
      sheetsService.updateOrderData(session.customer.rowIndex, {
        notas: `Queja pedido: ${message.substring(0, 100)}`,
      }).catch(() => {});
    }

    session.conversationHistory.push({ role: 'assistant', content: respuestaLimpia });
    sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
    sheetsService.appendConversationLog(phone, message, respuestaLimpia).catch(() => {});
    return respuestaLimpia;
  }

  if (response.includes('ESCALAR_A_WIG')) {
    const ultimoMensaje = session.conversationHistory
      .filter(m => m.role === 'user')
      .slice(-1)[0]?.content || 'desconocido';
    console.log(
      `🔍 [DIAGNOSTICO:ESCALACION] ` +
      `nombre="${session.customer?.name || session.tempData?.name || 'N/D'}" | ` +
      `mensaje="${message.substring(0, 100)}" | ` +
      `historial=${session.conversationHistory.length} msgs`
    );

    const cpGuardado = session.customer?.cp || '';

    // Si no tiene CP → pedirlo antes de escalar
    if (!cpGuardado) {
      sessionManager.updateSession(phone, {
        flowState: 'asking_cp_before_escalation',
        tempData: { ...session.tempData, pendingEscalation: true },
      });
      return '¿Cuál es tu código postal? 📍 Con eso te digo si te atendemos por paquetería o con un asesor directo.';
    }

    // Ya tiene CP → usarlo directamente
    const cpNum  = parseInt(cpGuardado.replace(/\D/g, ''), 10);
    const prefix = parseInt(String(cpNum).padStart(5, '0').substring(0, 2), 10);
    const esLocal = (cpNum >= 1000 && cpNum <= 16999) || (prefix >= 50 && prefix <= 57);

    if (esLocal) {
      await notifyWig(phone, session, `CP guardado: ${cpGuardado} — zona local`);
      sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
      const nombre = primerNombre(session.customer?.name || '');
      return nombre
        ? `¡Listo, ${nombre}! 😊 Un asesor te contactará en breve por este mismo WhatsApp.`
        : '¡Listo! 😊 Un asesor te contactará en breve por este mismo WhatsApp.';
    }

    // CP foráneo → cerrar con tienda sin escalar
    const nombre = primerNombre(session.customer?.name || '');
    return nombre
      ? `${pick(CHANNEL_VARIANTS)(nombre)} ${pick(CLOSING_VARIANTS)}`
      : `Te mandamos por paquetería a todo México 📦 Haz tu pedido en llabanaenlinea.com ${pick(CLOSING_VARIANTS)}`;
  }

  // Detectar intención de compra pendiente
  if (response.includes('PENDIENTE_COMPRA')) {
    const respuestaLimpia = response.replace('PENDIENTE_COMPRA', '').trim();

    if (session.customer?.rowIndex) {
      const ultimoProducto = session.conversationHistory
        .filter(m => m.role === 'assistant')
        .map(m => m.content)
        .reverse()
        .find(c => c.includes('llabanaenlinea.com')) || '';
      const productoMatch = ultimoProducto.match(/\*([^*]+)\*/);
      const producto = productoMatch ? productoMatch[1] : 'producto sin especificar';

      sheetsService.updateOrderData(session.customer.rowIndex, {
        notas: `Interesado en: ${producto} — pendiente de decidir`,
      }).catch(() => {});

      sheetsService.addSeguimiento(
        session.customer.phone || phone,
        session.customer.name || '',
        `Interesado en ${producto} — dijo que lo piensa`,
        'Pendiente de compra — hacer seguimiento'
      ).catch(() => {});

      if (!session.customer.segmento || session.customer.segmento === 'Lead frío') {
        sheetsService.updateSegmento(phone, 'Lead frío').catch(() => {});
      }
    }

    session.conversationHistory.push({ role: 'assistant', content: respuestaLimpia });
    sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
    sheetsService.appendConversationLog(phone, message, respuestaLimpia).catch(() => {});
    return respuestaLimpia;
  }

  // Contar productos no encontrados — escalar tras 2 respuestas sin catálogo
  const sinProducto = /no tengo ese producto|no lo tengo en mi cat[aá]logo|no tengo ese en mi cat[aá]logo/i.test(response);
  if (sinProducto) {
    const noEncontrados = (session.tempData?.productosNoEncontrados || 0) + 1;
    session.tempData = { ...session.tempData, productosNoEncontrados: noEncontrados };
    await sessionManager.updateSession(phone, { tempData: session.tempData });
    if (noEncontrados >= 2) {
      return escalateWithResumen(phone, session,
        'Productos no encontrados en catálogo — cliente requiere asesor');
    }
  }

  session.conversationHistory.push({ role: 'assistant', content: response });
  session.conversationHistory = trimHistory(session.conversationHistory);
  await sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
  sheetsService.appendConversationLog(phone, message, response).catch(() => {});

  // Si el bot recomendó un producto (tiene link de la tienda), taggear como asesorado
  if (response.includes('llabanaenlinea.com') && session.customer?.rowIndex) {
    sheetsService.appendTag(session.customer.rowIndex, 'Asesorado Bot').catch(() => {});
  }

  return response;
}

// ── CP antes de escalar ───────────────────────────────────────────────────────

async function handleAskingCpBeforeEscalation(phone, message, session) {
  const cp = message.trim().replace(/\D/g, '');
  if (cp.length < 4 || cp.length > 5) {
    return '¿Cuál es tu código postal? 📍 Son 5 dígitos, por ejemplo: 06600';
  }

  // Guardar CP en Sheets si tiene rowIndex
  if (session.customer?.rowIndex) {
    const { state, city } = await sheetsService.lookupCpMX(cp);
    await sheetsService.updateOrderData(session.customer.rowIndex, {
      cp,
      ...(state ? { state } : {}),
      ...(city  ? { city  } : {}),
    });
    session.customer.cp    = cp;
    session.customer.state = state || session.customer.state;
    session.customer.city  = city  || session.customer.city;
    await sessionManager.updateSession(phone, { customer: session.customer });
  }

  const cpNum   = parseInt(cp, 10);
  const prefix  = parseInt(cp.padStart(5, '0').substring(0, 2), 10);
  const esLocal = (cpNum >= 1000 && cpNum <= 16999) || (prefix >= 50 && prefix <= 57);

  const nombre = primerNombre(session.customer?.name || '');

  if (esLocal) {
    await notifyWig(phone, session, `CP ${cp} — zona local (primer compra cliente existente)`);
    sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    return nombre
      ? `¡Listo, ${nombre}! 😊 Un asesor te contactará en breve por este mismo WhatsApp.`
      : '¡Listo! 😊 Un asesor te contactará en breve por este mismo WhatsApp.';
  }

  // CP foráneo — verificar cantidad antes de cerrar
  const cantidadSesion = session.tempData?.cantidadBultos || 0;

  if (cantidadSesion >= 500) {
    // 500+ bultos en provincia → camión completo → escalar
    await notifyWig(phone, session, `CP foráneo ${cp} — mayoreo real: ${cantidadSesion} bultos`);
    sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    return nombre
      ? `¡Listo, ${nombre}! 😊 Un asesor te contactará para cotizar el flete del camión completo.`
      : '¡Listo! 😊 Un asesor te contactará para cotizar el flete del camión completo.';
  }

  if (cantidadSesion > 10 && cantidadSesion < 500) {
    sessionManager.updateSession(phone, { flowState: 'active' });
    return `Para esa cantidad fuera de la zona centro no contamos con servicio de entrega disponible por el momento 😔\n\nSi en algún momento reduces a pedidos de hasta 10 bultos o tu volumen llega a camión completo (12 toneladas), aquí estamos con gusto 🌾\n\nMientras tanto, si necesitas algún producto en menor cantidad puedo ayudarte a encontrarlo en la tienda.`;
  }

  // 1-10 bultos en provincia → paquetería normal
  sessionManager.updateSession(phone, { flowState: 'active' });
  return nombre
    ? `${pick(CHANNEL_VARIANTS)(nombre)} ${pick(CLOSING_VARIANTS)}`
    : `Te mandamos por paquetería a todo México 📦 Haz tu pedido en llabanaenlinea.com`;
}

// ── Confirmar reset ───────────────────────────────────────────────────────────

const CONFIRM_RESET_PATTERNS = /^(s[ií]|empezar|nueva|nuevo|de\s*nuevo|empezar\s*de\s*nuevo|nueva\s*consulta)$/i;

async function handleConfirmingReset(phone, message, session) {
  if (CONFIRM_RESET_PATTERNS.test(message.trim())) {
    await sessionManager.deleteSession(phone);
    await sessionManager.createSession(phone);
    await sessionManager.updateSession(phone, { flowState: 'asking_mexico' });
    return pick(WELCOME_VARIANTS);
  }

  // Continuar con el estado anterior
  const prevState = session.tempData?._prevState || 'active';
  await sessionManager.updateSession(phone, { flowState: prevState });
  const restored = await sessionManager.getSession(phone);

  switch (prevState) {
    case 'asking_mexico': return handleAskingMexico(phone, message, restored);
    default:              return handleActive(phone, message, restored);
  }
}

// ── Esperando asesor ──────────────────────────────────────────────────────────

async function handleWaitingForWig(phone, message, session) {
  if (DESPEDIDA_PATTERNS.test(message.trim())) {
    await sessionManager.updateSession(phone, { flowState: 'escalated' });
    return '¡Con gusto! En breve te contacta un asesor 🙌 Que tengas buen día 🌾';
  }

  return 'Ya avisamos a un asesor, en breve te contacta 🙌';
}

async function handleEscalated(phone, message, session) {
  // Detectar respuesta al Follow-up C
  if (session.tempData?.followupCEnviado) {
    const noFueAtendido = /no\b|nadie|nunca|todavía|aún no|siguen sin|no me han/i.test(message);
    const sisFueAtendido = /^(sí|si|ya|me atendieron|perfecto|listo|ok|claro)$/i.test(message.trim().toLowerCase());
    if (noFueAtendido) {
      await notifyWig(phone, session, '🚨 URGENTE — Cliente sin atención después de 23h');
      await sessionManager.updateSession(phone, {
        tempData: { ...session.tempData, followupCEnviado: false },
      });
      return 'Disculpa la espera 😔 Voy a marcar tu caso como urgente para que te contacten lo antes posible.';
    }
    if (sisFueAtendido) {
      await sessionManager.updateSession(phone, {
        tempData: { ...session.tempData, followupCEnviado: false },
      });
      return '¡Qué gusto! 😊 Quedamos a tus órdenes para lo que necesites 🌾';
    }
  }

  // Si ya es horario de atención y el cliente escribe de nuevo → notificar a Wig ahora
  if (horarioService.estaEnHorario() && session.tempData?.escalacionPendiente) {
    await sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, escalacionPendiente: false },
    });
    await notifyWig(phone, session, `Cliente retomó conversación — ya en horario de atención`);
    return 'Ya avisé al asesor, en breve te contacta 🙌 ¿Hay algo en lo que pueda ayudarte mientras tanto?';
  }

  // Detección de frustración — responder con urgencia antes de cualquier otra lógica
  const esFrustrado = /SIGO|TODAVÍA|AÚN NO|SIGUEN|YA PASARON|CUÁNDO|NO HAN|POR QUÉ|!!|😤|😡|🤬/.test(message)
    || message === message.toUpperCase() && message.trim().length > 5;

  if (esFrustrado) {
    return 'Entiendo tu molestia y lamento la espera 😔 Voy a marcar tu caso como urgente para que te contacten lo antes posible. ¿Me puedes confirmar tu número de pedido o el producto que ordenaste?';
  }

  // Despedida → cerrar amablemente
  if (DESPEDIDA_PATTERNS.test(message.trim())) {
    return '¡Hasta luego! 🌾 Cuando necesites algo más, aquí estamos.';
  }

  // Mensajes de cierre/agradecimiento → dar seguridad sin llamar a Claude
  const esCierre = /^(gracias|ok|okay|de acuerdo|perfecto|listo|entendido|espero|👍|okey|bien|claro|si|sí)$/i.test(message.trim());
  if (esCierre) {
    const cuando = horarioService.proximoDiaHabil();
    return `Tu caso ya quedó registrado 🙌 Nuestros asesores te contactarán ${cuando} a primera hora por este mismo WhatsApp.\n\nMientras tanto puedo ayudarte con dudas de productos, precios o envíos. ¿En qué te oriento?`;
  }

  // Tomar solo los últimos 6 mensajes del historial filtrando ruido de escalación
  const historialLimpio = (session.conversationHistory || [])
    .filter(m => !m.content?.includes('ESCALAR_A_WIG') && !m.content?.includes('Antes de conectarte'))
    .slice(-6);

  historialLimpio.push({ role: 'user', content: message });

  let response;
  try {
    response = await claudeService.chat(historialLimpio, session.customer);
  } catch {
    response = 'Tu caso ya quedó registrado 🙌 Un asesor te contactará a primera hora por este mismo WhatsApp.';
  }

  // Si Claude quiere escalar de nuevo → ya está escalado, dar seguridad
  if (response.includes('ESCALAR_A_WIG')) {
    const cuando = horarioService.proximoDiaHabil();
    return `Tu caso ya quedó registrado ✅ Nuestros asesores te contactarán ${cuando} a primera hora.\n\n¿Hay algo más en lo que te pueda ayudar mientras tanto?`;
  }

  // Respuesta normal de Claude
  session.conversationHistory.push({ role: 'user', content: message });
  session.conversationHistory.push({ role: 'assistant', content: response });
  session.conversationHistory = trimHistory(session.conversationHistory);
  await sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });

  return response;
}

// ── Resumen y escalación con confirmación ─────────────────────────────────────

async function generateResumen(conversationHistory, customer, motivo = '') {
  const historialFiltrado = (conversationHistory || []).slice(-10);

  console.log(`🔍 generateResumen: historial=${historialFiltrado.length} msgs | motivo="${motivo}"`);

  if (historialFiltrado.length < 2) {
    console.log(`🔍 generateResumen: historial corto → usando último mensaje`);
    const ultimoCliente = (conversationHistory || [])
      .filter(m => m.role === 'user')
      .slice(-1)[0]?.content || '';
    const textoFallback = ultimoCliente.length > 5
      ? `Cliente quiere ${ultimoCliente.substring(0, 80)}`
      : motivo || 'Cliente requiere atención de un asesor';
    return textoFallback;
  }

  const historial = historialFiltrado
    .map(m => `${m.role === 'user' ? 'Cliente' : 'Bot'}: ${m.content}`)
    .join('\n');

  console.log(`🔍 generateResumen: llamando a Claude con ${historial.length} chars`);

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 80,
      messages: [{
        role: 'user',
        content: `Eres un asistente que resume solicitudes de clientes.\n\n` +
          `Basándote en esta conversación, escribe UN resumen de máximo 15 palabras ` +
          `de lo que necesita el cliente.\n` +
          `Empieza OBLIGATORIAMENTE con "Cliente quiere" o "Cliente necesita".\n` +
          `Responde SOLO con el resumen. Sin comillas, sin puntos, sin explicaciones.\n\n` +
          `Conversación:\n${historial}\n\nResumen (empieza con Cliente quiere o Cliente necesita):`,
      }],
    });
    const texto = (response.content?.[0]?.text || '')
      .trim()
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/\.$/, '')
      .replace(/^(resumen:|summary:)/i, '')
      .trim()
      .substring(0, 120);

    if (!texto) console.warn('⚠️ generateResumen: Claude devolvió respuesta vacía');
    console.log(`🔍 generateResumen: resultado="${texto}"`);
    return texto || motivo || 'Cliente requiere atención de un asesor';
  } catch (err) {
    console.error('Error generando resumen:', err.message);
    return motivo || 'Cliente requiere atención de un asesor';
  }
}

async function escalateWithResumen(phone, session, motivo) {
  const resumen = await generateResumen(
    session.conversationHistory || [],
    session.customer,
    motivo
  );

  // Persistir en Sheets para sobrevivir reinicios de servidor
  if (session.customer?.rowIndex) {
    sheetsService.appendNota(session.customer.rowIndex, `PENDIENTE_ESCALACION: ${resumen}`).catch(() => {});
  }

  session.tempData = {
    ...session.tempData,
    resumenEscalacion: resumen,
    motivoEscalacion:  motivo,
  };
  await sessionManager.updateSession(phone, {
    flowState: 'confirming_escalation',
    tempData:  session.tempData,
  });

  // Limpiar prefijos internos antes de mostrar al cliente
  const resumenLimpio = resumen
    .replace(/^Perfil mayoreo\/negocio:\s*/i, '')
    .replace(/^Cliente solicita asesor humano\s*/i, 'Hablar con un asesor')
    .replace(/^Detectado por Claude\s*/i, '')
    .replace(/^"+|"+$/g, '')
    .trim();

  return `Antes de conectarte con un asesor, déjame confirmar tu solicitud:\n\n"${resumenLimpio}"\n\n¿Es correcto? 😊`;
}

const CONFIRMA_PATTERNS = /\b(s[ií]|correcto|exacto|as[ií]\s*es|eso\s*es|ok|dale|claro|perfecto|confirmo|est[aá]\s*bien|de\s*acuerdo|va|listo|as[ií]|confirm|es\s*correcto|correcto\s*gracias|s[ií]\s*es\s*correcto|as[ií]\s*lo\s*quiero|as[ií]\s*me\s*gustar[ií]a)\b/i;
const CORRIGE_PATTERNS  = /^(no|no es|no exactamente|espera|corrige|falta|también|además)/i;

async function handleConfirmingEscalation(phone, message, session) {
  const resumen = session.tempData?.resumenEscalacion ||
                  session.tempData?.motivoEscalacion  ||
                  'requiere atención de un asesor';
  const motivo  = session.tempData?.motivoEscalacion  || '';

  // Si está esperando que el cliente corrija → usar el mensaje como nueva descripción
  if (session.tempData?.esperandoCorreccion) {
    const nuevaDescripcion = message.trim();
    session.tempData.resumenEscalacion   = nuevaDescripcion;
    session.tempData.esperandoCorreccion = false;
    await sessionManager.updateSession(phone, { tempData: session.tempData });
    return `Perfecto, queda así:\n\n"${nuevaDescripcion}"\n\n¿Lo confirmas? 😊`;
  }

  // Corrección explícita → pedir nueva descripción
  if (CORRIGE_PATTERNS.test(message.trim())) {
    await sessionManager.updateSession(phone, {
      flowState: 'confirming_escalation',
      tempData:  { ...session.tempData, esperandoCorreccion: true },
    });
    return '¿Cómo lo describirías tú? Cuéntame en tus palabras 😊';
  }

  // Todo lo demás (Sí, Si, correcto, emojis, mensajes sustanciales…) → confirmar y escalar
  const { fueraHorario: fueraH4 } = await notifyWig(phone, session, motivo, resumen);
  if (session.customer?.rowIndex) {
    sheetsService.appendNota(session.customer.rowIndex, resumen).catch(() => {});
  }

  if (fueraH4) {
    await sessionManager.updateSession(phone, {
      flowState: 'active',
      tempData:  { ...session.tempData, escalacionPendiente: true },
    });
    const msgs = horarioService.mensajeFueraHorario();
    return msgs[Math.floor(Math.random() * msgs.length)];
  }

  await sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
  const firstName = primerNombre(session.customer?.name || session.tempData?.name || '');
  return firstName
    ? `¡Listo, ${firstName}! 🙌 Un asesor te contactará en breve.`
    : '¡Listo! 🙌 Un asesor te contactará en breve.';
}

// ── Notificación a asesor ─────────────────────────────────────────────────────

async function notifyWig(phone, session, motivo = '', resumen = '') {
  const wigNumber = process.env.WIG_WHATSAPP_NUMBER;
  if (!wigNumber) {
    console.warn('WIG_WHATSAPP_NUMBER no configurado.');
    return { fueraHorario: false };
  }

  const customer   = session.customer || {};
  const tempData   = session.tempData  || {};
  const history    = (session.conversationHistory || []).slice(-8);
  const transcript = history.length
    ? history.map(m => `${m.role === 'user' ? '👤' : '🤖'}: ${m.content}`).join('\n')
    : '(sin historial previo)';

  const nombre   = customer.name  || tempData.name  || 'Sin nombre';
  const estado   = customer.state || tempData.state || '';
  const ciudad   = customer.city  || tempData.city  || '';
  const cp       = customer.cp    || tempData.cp    || '';
  const resumenF = tempData.resumenEscalacion || motivo || '';

  // Limpiar prefijos internos del resumen
  const resumenLimpio = resumenF
    .replace(/^Perfil mayoreo\/negocio:\s*/i, '')
    .replace(/^Cliente solicita asesor humano\s*/i, '')
    .replace(/^Detectado por Claude\s*/i, '')
    .replace(/^Zona local[^:]*:\s*/i, '')
    .replace(/^"+|"+$/g, '')
    .trim();

  // Ubicación en una línea
  const ubicacion = [estado, ciudad, cp ? `CP: ${cp}` : '']
    .filter(Boolean).join(' | ');

  // ── Verificar horario ──────────────────────────────────────
  if (!horarioService.estaEnHorario()) {
    await colaEscalaciones.agregarEscalacion({
      phone,
      nombre,
      resumen: resumenLimpio || motivo,
      timestamp: Date.now(),
    });
    await sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, escalacionPendiente: true },
    });
    console.log(`📥 [COLA] Fuera de horario — escalación de ${nombre} guardada para después`);
    return { fueraHorario: true };
  }

  // ── Dentro de horario — notificar normal ───────────────────
  const telMostrar = phone.replace('whatsapp:', '');
  const msg =
    `🚨 *NUEVA SOLICITUD*\n\n` +
    `👤 *${nombre}* | ${telMostrar}\n` +
    (ubicacion ? `📍 ${ubicacion}\n` : '') +
    (resumenLimpio ? `📝 ${resumenLimpio}` : '');

  console.log(`📤 Intentando notificar a Wig | to: ${wigNumber} | motivo: ${motivo}`);
  try {
    const result = await twilioService.sendMessage(wigNumber, msg);
    console.log(`📲 Wig notificado | sid: ${result.sid} | status: ${result.status} | errorCode: ${result.errorCode ?? 'none'} | errorMsg: ${result.errorMessage ?? 'none'}`);
    return { fueraHorario: false };
  } catch (err) {
    console.error(`❌ Error notificando a Wig | code: ${err.code} | status: ${err.status} | msg: ${err.message} | moreInfo: ${err.moreInfo}`);
    return { fueraHorario: false };
  }
}

async function handleMediaMessage(phone) {
  const session = await sessionManager.getSession(phone);

  if (session?.flowState === 'active' || session?.flowState === 'waiting_for_wig') {
    const nombre = session?.customer?.name
      ? ` ${primerNombre(session.customer.name)}`
      : '';
    return `Vi que mandaste una imagen${nombre} 😊 Por el momento no puedo verla, pero cuéntame — ¿qué producto o tema te interesa? Con gusto te ayudo 🌾`;
  }

  if (session) {
    return '😊 Recibí tu imagen pero no puedo verla. ¿Me puedes decir con texto qué producto buscas o en qué te puedo ayudar?';
  }

  return '¡Hola! 👋 Soy el asistente de Llabana, tu aliado en alimento balanceado 🌾\nRecibí tu imagen pero no puedo verla 😅 ¿Me cuentas qué producto te interesa o en qué te puedo ayudar? ¿Estás en México?';
}

// ── Confirmar nombre ──────────────────────────────────────────────────────────

async function handleConfirmingName(phone, message, session) {
  const msg = message.trim().toLowerCase();

  // Confirmación positiva
  const esConfirmacion = /^(s[ií]|sí|si|correcto|exact|ok|okay|claro|así|eso|👍|afirma)/.test(msg);

  // Corrección — el cliente da un nombre diferente
  const nombreNuevo = sheetsService.limpiarNombre(message);

  if (esConfirmacion || (!nombreNuevo && !esConfirmacion)) {
    // Confirmó o no dijo nada reconocible — usar el nombre pendiente
    const nombre = session.tempData?.namePendiente || '';
    const first  = primerNombre(nombre);

    if (session.customer?.rowIndex) {
      sheetsService.updateOrderData(session.customer.rowIndex, { name: nombre }).catch(() => {});
    }
    await sessionManager.updateSession(phone, {
      flowState: 'active',
      tempData:  { ...session.tempData, name: nombre, namePendiente: undefined },
      customer:  { ...session.customer, name: nombre },
    });

    const intentPrevio = session.tempData?.intentPrevio;
    if (intentPrevio) {
      // Limpiar intentPrevio ANTES de llamar a handleActive para evitar loops
      await sessionManager.updateSession(phone, {
        tempData: { ...session.tempData, intentPrevio: undefined, namePendiente: undefined },
      });
      const updatedSession = await sessionManager.getSession(phone);
      const respuesta = await handleActive(phone, intentPrevio, updatedSession);
      return `¡Mucho gusto, ${first}! 😊\n\n${respuesta}`;
    }
    return pick([
      `¡Mucho gusto, ${first}! 😊 ¿En qué te puedo ayudar?`,
      `¡Qué bueno que nos escribes, ${first}! ¿En qué te ayudo?`,
      `Gracias ${first} 🌾 ¿Qué necesitas hoy?`,
    ]);
  }

  if (nombreNuevo) {
    // El cliente dio un nombre diferente — usar el nuevo
    const first = primerNombre(nombreNuevo);
    if (session.customer?.rowIndex) {
      sheetsService.updateOrderData(session.customer.rowIndex, { name: nombreNuevo }).catch(() => {});
    }
    await sessionManager.updateSession(phone, {
      flowState: 'active',
      tempData:  { ...session.tempData, name: nombreNuevo, namePendiente: undefined },
      customer:  { ...session.customer, name: nombreNuevo },
    });

    const intentPrevio = session.tempData?.intentPrevio;
    if (intentPrevio) {
      // Limpiar intentPrevio ANTES de llamar a handleActive para evitar loops
      await sessionManager.updateSession(phone, {
        tempData: { ...session.tempData, intentPrevio: undefined, namePendiente: undefined },
      });
      const updatedSession = await sessionManager.getSession(phone);
      const respuesta = await handleActive(phone, intentPrevio, updatedSession);
      return `¡Mucho gusto, ${first}! 😊\n\n${respuesta}`;
    }
    return pick([
      `¡Mucho gusto, ${first}! 😊 ¿En qué te puedo ayudar?`,
      `¡Qué bueno que nos escribes, ${first}! ¿En qué te ayudo?`,
      `Gracias ${first} 🌾 ¿Qué necesitas hoy?`,
    ]);
  }

  // No se pudo determinar — preguntar de nuevo
  return '¿Me confirmas tu nombre? 😊';
}

module.exports = { handleMessage, handleMediaMessage };
