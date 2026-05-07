/**
 * Gestión de sesiones con Redis (persistente) y fallback a memoria.
 * Las sesiones sobreviven reinicios de servidor cuando REDIS_URL está configurado.
 */

const Redis = require('ioredis');

// Conectar a Redis si está disponible, sino usar memoria como fallback
let redis = null;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL, {
    retryStrategy(times) {
      const delay = Math.min(times * 500, 5000);
      console.log(`🔄 Redis reconectando en ${delay}ms (intento ${times})`);
      return delay;
    },
    reconnectOnError(err) {
      console.error('Redis error de conexión:', err.message);
      return true;
    },
    maxRetriesPerRequest: 3,
  });
  redis.on('connect', () => console.log('✅ Redis conectado'));
  redis.on('error', (err) => console.error('❌ Redis error:', err.message));
} else {
  console.warn('⚠️  REDIS_URL no configurado — usando sesiones en memoria');
}

const SESSION_TIMEOUT_MS  = 30 * 60 * 60 * 1000; // 30 horas
const SESSION_TTL_SECONDS = 30 * 60 * 60;         // 30 horas

// Fallback en memoria si no hay Redis
const memorySessions = new Map();

// ── Serialización ──────────────────────────────────────────────────────────────

function serialize(session) {
  return JSON.stringify(session);
}

function deserialize(data) {
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

// ── API pública ────────────────────────────────────────────────────────────────

async function getSession(phone) {
  if (redis) {
    try {
      const data = await redis.get(`session:${phone}`);
      const session = deserialize(data);
      if (!session) return null;
      // Renovar TTL con cada acceso
      await redis.expire(`session:${phone}`, SESSION_TTL_SECONDS);
      return session;
    } catch (err) {
      console.error('Redis getSession error:', err.message);
      // Fallback a memoria
    }
  }

  const session = memorySessions.get(phone);
  if (!session) return null;
  if (Date.now() - session.lastActivity > SESSION_TIMEOUT_MS) {
    memorySessions.delete(phone);
    return null;
  }
  session.lastActivity = Date.now();
  return session;
}

async function createSession(phone) {
  const session = {
    phone,
    flowState:           'new',
    tempData:            {},
    customer:            null,
    conversationHistory: [],
    lastActivity:        Date.now(),
  };

  if (redis) {
    try {
      await redis.setex(`session:${phone}`, SESSION_TTL_SECONDS, serialize(session));
      return session;
    } catch (err) {
      console.error('Redis createSession error:', err.message);
    }
  }

  memorySessions.set(phone, session);
  return session;
}

async function updateSession(phone, updates) {
  if (redis) {
    try {
      const data = await redis.get(`session:${phone}`);
      const session = deserialize(data);
      if (!session) return null;
      const updated = { ...session, ...updates, lastActivity: Date.now() };
      await redis.setex(`session:${phone}`, SESSION_TTL_SECONDS, serialize(updated));
      return updated;
    } catch (err) {
      console.error('Redis updateSession error:', err.message);
    }
  }

  const session = memorySessions.get(phone);
  if (!session) return null;
  Object.assign(session, updates, { lastActivity: Date.now() });
  return session;
}

async function deleteSession(phone) {
  if (redis) {
    try {
      await redis.del(`session:${phone}`);
      return;
    } catch (err) {
      console.error('Redis deleteSession error:', err.message);
    }
  }
  memorySessions.delete(phone);
}

async function getActiveSessionCount() {
  if (redis) {
    try {
      const keys = await redis.keys('session:*');
      return keys.length;
    } catch {
      return 0;
    }
  }
  return memorySessions.size;
}

async function getAllActiveSessions() {
  if (redis) {
    try {
      const keys = await redis.keys('session:*');
      const entries = [];
      for (const key of keys) {
        const data = await redis.get(key);
        const session = deserialize(data);
        if (session) {
          const phone = key.replace('session:', '');
          entries.push([phone, session]);
        }
      }
      return entries;
    } catch (err) {
      console.error('Redis getAllActiveSessions error:', err.message);
      return [];
    }
  }
  return [...memorySessions.entries()];
}

function getRedisClient() {
  return redis;
}

module.exports = { getSession, createSession, updateSession, deleteSession, getActiveSessionCount, getAllActiveSessions, getRedisClient };
