/**
 * Gestión de sesiones en memoria.
 * Cada sesión almacena el estado de la conversación por número de teléfono.
 * Las sesiones expiran después de SESSION_TIMEOUT_MS de inactividad.
 */

const sessions = new Map();
const SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutos

/**
 * Obtiene la sesión activa de un número de teléfono.
 * Retorna null si no existe o si expiró.
 */
function getSession(phone) {
  const session = sessions.get(phone);
  if (!session) return null;

  if (Date.now() - session.lastActivity > SESSION_TIMEOUT_MS) {
    sessions.delete(phone);
    return null;
  }

  session.lastActivity = Date.now();
  return session;
}

/**
 * Crea una nueva sesión para un número de teléfono.
 * flowState posibles:
 *   'new'           → cliente recién detectado (aún sin verificar en Sheets)
 *   'asking_name'   → esperando nombre
 *   'asking_state'  → esperando estado
 *   'asking_city'   → esperando ciudad
 *   'asking_colonia'→ esperando colonia
 *   'active'        → cliente registrado, conversación libre con Claude
 *   'escalated'     → derivado a Wig
 */
function createSession(phone) {
  const session = {
    phone,
    flowState: 'new',
    tempData: {},       // datos temporales durante el onboarding
    customer: null,     // datos del cliente una vez registrado/encontrado
    conversationHistory: [], // historial para Claude
    lastActivity: Date.now(),
  };
  sessions.set(phone, session);
  return session;
}

/**
 * Actualiza campos de una sesión existente.
 */
function updateSession(phone, updates) {
  const session = sessions.get(phone);
  if (!session) return null;
  Object.assign(session, updates, { lastActivity: Date.now() });
  return session;
}

function deleteSession(phone) {
  sessions.delete(phone);
}

/** Retorna cuántas sesiones activas hay (útil para monitoreo) */
function getActiveSessionCount() {
  return sessions.size;
}

module.exports = { getSession, createSession, updateSession, deleteSession, getActiveSessionCount };
