/**
 * Cola de escalaciones fuera de horario
 * Persiste en Redis indefinidamente hasta que Wig las pida
 */

const REDIS_KEY = 'escalaciones:pendientes';

let redisClient = null;

function setRedis(client) {
  redisClient = client;
}

async function agregarEscalacion({ phone, nombre, resumen, timestamp }) {
  if (!redisClient) return;
  try {
    const entrada = JSON.stringify({
      phone, nombre, resumen,
      timestamp: timestamp || Date.now(),
      fecha: new Date().toLocaleString('es-MX', {
        timeZone: 'America/Mexico_City',
        weekday: 'long', day: '2-digit',
        month: '2-digit', hour: '2-digit', minute: '2-digit',
      }),
    });
    await redisClient.rpush(REDIS_KEY, entrada);
    console.log(`📥 [COLA] Escalación guardada: ${nombre || phone} | ${(resumen || '').substring(0, 50)}`);
  } catch (err) {
    console.error('❌ [COLA] Error guardando escalación:', err.message);
  }
}

async function obtenerYLimpiarEscalaciones() {
  if (!redisClient) return [];
  try {
    const items = await redisClient.lrange(REDIS_KEY, 0, -1);
    if (!items || items.length === 0) return [];

    await redisClient.del(REDIS_KEY);

    return items.map(item => {
      try { return JSON.parse(item); }
      catch { return null; }
    }).filter(Boolean);
  } catch (err) {
    console.error('❌ [COLA] Error leyendo escalaciones:', err.message);
    return [];
  }
}

async function contarPendientes() {
  if (!redisClient) return 0;
  try {
    return await redisClient.llen(REDIS_KEY);
  } catch {
    return 0;
  }
}

module.exports = { setRedis, agregarEscalacion, obtenerYLimpiarEscalaciones, contarPendientes };
