/**
 * Servicio de horario de atención Llabana
 * L-V: 8am-5pm | Sáb: 9am-2pm | Dom: sin atención
 */

function getHoraMX() {
  const now = new Date();
  const mx = new Date(now.toLocaleString('en-US', {
    timeZone: 'America/Mexico_City'
  }));
  return {
    hora:    mx.getHours(),
    minutos: mx.getMinutes(),
    dia:     mx.getDay(), // 0=Dom, 1=Lun, ..., 6=Sáb
  };
}

function estaEnHorario() {
  const { hora, dia } = getHoraMX();
  if (dia === 0) return false;                          // Domingo
  if (dia >= 1 && dia <= 5) return hora >= 8 && hora < 17; // L-V 8am-5pm
  if (dia === 6) return hora >= 9 && hora < 14;        // Sábado
  return false;
}

function proximoDiaHabil() {
  const { dia } = getHoraMX();
  if (dia === 5) return 'el lunes';  // Viernes
  if (dia === 6) return 'el lunes';  // Sábado
  if (dia === 0) return 'el lunes';  // Domingo
  return 'mañana';
}

function mensajeFueraHorario() {
  const cuando = proximoDiaHabil();
  return [
    `Nuestros asesores atienden lunes a viernes 8am-5pm y sábados 9am-2pm 🕘\nTu solicitud quedó anotada — un asesor te contactará ${cuando} a primera hora 🙌\n\nMientras tanto puedo ayudarte con dudas técnicas, recomendaciones de productos o info de envíos. ¿En qué te oriento? 🌾`,
    `En este momento nuestros asesores ya terminaron su horario 🕘\nTe contactarán ${cuando} por la mañana.\n\nSi tienes dudas sobre productos, nutrición o envíos, aquí estoy para ayudarte 🌾`,
    `Nuestro horario de atención con asesor es L-V 8am-5pm y sáb 9am-2pm 🕘\nQuedó anotado tu caso — ${cuando} te contactamos.\n\nMientras tanto, ¿puedo ayudarte con alguna duda técnica o recomendación de producto? 🌾`,
  ];
}

module.exports = { estaEnHorario, proximoDiaHabil, mensajeFueraHorario };
