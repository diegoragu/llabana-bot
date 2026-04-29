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
      // Cliente existente con nombre → procesar primer mensaje con Claude
      await sessionManager.updateSession(phone, {
        flowState: 'active',
        customer:  customerData,
      });
      return handleActive(phone, messageBody, await sessionManager.getSession(phone));
    }

    // Cliente nuevo → verificar número mexicano antes de saludar
    const esMexicano = phone.startsWith('whatsapp:+521') ||
                       phone.startsWith('whatsapp:+52');
    if (!esMexicano) {
      await sessionManager.updateSession(phone, { flowState: 'out_of_coverage' });
      console.log(`🌎 Número extranjero bloqueado: ${phone}`);
      return OUT_OF_COVERAGE_MSG;
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
      const esCierre = /^(ok|okey|okay|gracias|bien|perfecto|entendido|👍|🙌|👌|de acuerdo|va|listo|sale|hasta luego|bye|adios|adiós|hasta pronto)$/i.test(messageBody.trim());
      if (esCierre) {
        return '¡Hasta luego! El asesor te contactará en breve 🙌';
      }
      sheetsService.appendConversationLog(
        phone, messageBody, '[info adicional mientras espera asesor]'
      ).catch(() => {});
      return 'Anotado 📝 Le paso esa info al asesor para que llegue preparado.';
    }
    case 'escalated':        return handleEscalated(phone, messageBody, session);
    case 'confirming_reset':        return handleConfirmingReset(phone, messageBody, session);
    case 'confirming_escalation':   return handleConfirmingEscalation(phone, messageBody, session);
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

// ── Filtro México ─────────────────────────────────────────────────────────────

async function handleAskingMexico(phone, message, session) {
  if (isOutsideMexico(message)) {
    await sessionManager.updateSession(phone, { flowState: 'out_of_coverage' });
    return OUT_OF_COVERAGE_MSG;
  }

  if (!phone.startsWith('whatsapp:+52')) {
    // Solo notificar si viene de un link de tracking (cliente real interesado)
    // Números extranjeros que llegan directo generalmente son spam o error
    if (session.tempData?.entryPoint && session.tempData.entryPoint !== 'Directo') {
      const { fueraHorario } = await notifyWig(phone, session,
        `Número extranjero via ${session.tempData.entryPoint}: ${phone}`,
        'Cliente con número extranjero');
      await sessionManager.updateSession(phone, {
        flowState: fueraHorario ? 'active' : 'waiting_for_wig',
        ...(fueraHorario ? { tempData: { ...session.tempData, escalacionPendiente: true } } : {}),
      });
    } else {
      await sessionManager.updateSession(phone, { flowState: 'waiting_for_wig' });
    }
    return 'Veo que tu número no es de México 🌎 Te voy a conectar con un asesor.';
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

    const customerLocal = {
      phone, state: stateDetectado, rowIndex: localRowIndex,
      channel: 'paqueteria', channelDetail: 'Nacional', segmento: 'Lead frío',
    };
    await sessionManager.updateSession(phone, { customer: customerLocal });
    const sessionLocal = await sessionManager.getSession(phone);
    const { fueraHorario: fueraH2 } = await notifyWig(
      phone,
      sessionLocal || { ...session, customer: customerLocal },
      `Zona local detectada por texto: "${message.substring(0, 80)}"`,
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
    await sessionManager.updateSession(phone, {
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
    await sessionManager.updateSession(phone, {
      tempData: { ...session.tempData, nameAttempts: attempts + 1 },
    });
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
    return 'Anotado 📝 Le paso esa info al asesor cuando te contacte.';
  }

  // Agregar mensaje al historial ANTES de cualquier escalación
  // (para que generateResumen incluya el mensaje que disparó la escalación)
  session.conversationHistory.push({ role: 'user', content: message });
  await sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });

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
        sheetsService.updateOrderData(session.customer.rowIndex, {
          notas: `Cliente de ${zone} — atención por asesor`,
        }).catch(() => {});
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
    return escalateWithResumen(phone, session, 'Detectado por Claude');
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
  await sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
  sheetsService.appendConversationLog(phone, message, response).catch(() => {});

  return response;
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
  await sessionManager.updateSession(phone, { conversationHistory: session.conversationHistory });
  return response + '\n\n_(Un asesor también te contactará en breve)_';
}

// ── Resumen y escalación con confirmación ─────────────────────────────────────

async function generateResumen(conversationHistory, customer, motivo = '') {
  const historialFiltrado = (conversationHistory || []).slice(-10);

  console.log(`🔍 generateResumen: historial=${historialFiltrado.length} msgs | motivo="${motivo}"`);

  if (historialFiltrado.length < 2) {
    console.log(`🔍 generateResumen: historial corto → usando motivo`);
    return motivo || 'Cliente requiere atención de un asesor';
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
    const texto = response.content[0].text.trim()
      .replace(/^["'`]|["'`]$/g, '')
      .replace(/\.$/, '')
      .replace(/^(resumen:|summary:)/i, '')
      .trim()
      .substring(0, 120);

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
    sheetsService.updateOrderData(session.customer.rowIndex, {
      notas: `PENDIENTE_ESCALACION: ${resumen}`,
    }).catch(() => {});
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
    sheetsService.updateOrderData(session.customer.rowIndex, {
      notas: resumen,
    }).catch(() => {});
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

module.exports = { handleMessage };
