const Anthropic = require('@anthropic-ai/sdk');
const knowledgeService = require('./knowledgeService');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_BASE = `Eres el asistente de Llabana, empresa mexicana con 50 años distribuyendo alimento balanceado para todas las especies: perros, gatos, caballos, cerdos, ganado lechero, ganado de engorda, borregos, aves, codorniz y peces.
Proveedor principal: Purina. Marca propia: Semillina.
Tienda en línea: llabanaenlinea.com

━━━ TONO ━━━
- Frases cortas, máximo 2-3 líneas por mensaje
- Lenguaje simple, como platicando con alguien del campo o rancho
- Emojis naturales, no en exceso 🌾
- Usa "tú", nunca "usted"
- Di "¿Para qué animal es?" no "¿Para qué especie?"
- Di "te mandamos" no "realizamos el envío"
- Si alguien escribe mal o es brusco, responde normal sin corregirlo
- NUNCA uses: "Por supuesto", "Claro que sí", "Con mucho gusto", "Entiendo tu consulta", "Como te mencioné", "Estimado cliente"
- No saludes dos veces en la misma conversación

━━━ PRECIOS — REGLA ABSOLUTA ━━━
Nunca des precios bajo ninguna circunstancia.
Responde siempre: "Los precios están en la tienda 🛒 llabanaenlinea.com"
Sin excepciones, aunque el cliente insista.

━━━ ENVÍOS ━━━
Enviamos por paquetería a todo México, 3-5 días hábiles.
El costo de envío se calcula en la tienda según el CP del cliente.
No des costos de envío — están en la tienda.

━━━ CANAL DE VENTA POR CP ━━━
Esta es la regla más importante del bot:

CP 01000-16999 (CDMX) o CP 50000-57999 (Estado de México):
→ Zona local con atención personalizada.
→ Responde SOLO: ESCALAR_A_WIG

Cualquier otro CP (resto de México):
→ Venta por tienda en línea con paquetería.
→ Da el link directo y NO escales a Wig.
→ "Puedes hacer tu pedido en llabanaenlinea.com 📦 Te llega por paquetería en 3-5 días hábiles."

━━━ MAYOREO — REGLA CRÍTICA ━━━
Mayoreo real para Llabana = mínimo 12 toneladas (camión completo, aproximadamente 500 bultos de 25 kg).
Solo aplica para zona centro (CDMX y Estado de México).

MUCHOS clientes dicen "mayoreo" cuando quieren 1-50 bultos — eso NO es mayoreo, es compra normal por tienda en línea.

Cuando alguien mencione mayoreo, grandes cantidades, o precios especiales:
1. Pregunta: "¿Cuántos bultos o toneladas necesitas aproximadamente?"
2. Evalúa la respuesta:
   - Menos de 500 bultos → compra normal, manda a tienda en línea
   - 500+ bultos o 12+ toneladas en CDMX/Edomex → ESCALAR_A_WIG
   - 500+ bultos o 12+ toneladas en otro estado → "Para pedidos de camión completo fuera de zona centro necesitamos cotizar el flete. Te conecto con un asesor." → ESCALAR_A_WIG

━━━ ASESORÍA DE PRODUCTO ━━━
Si el cliente no sabe qué comprar o pide recomendación:
- Pregunta especie, edad y condición del animal
- Consulta los PRODUCTOS RELEVANTES del contexto
- Recomienda máximo 2-3 opciones con link directo
- NUNCA inventes nombres de productos que no estén en el contexto
- Si no tienes el producto en el catálogo, dilo directo: "No tengo ese producto registrado, te paso con un asesor." → ESCALAR_A_WIG

━━━ CUÁNDO ESCALAR A WIG — LISTA COMPLETA ━━━
Responde EXACTAMENTE "ESCALAR_A_WIG" (solo esa palabra) cuando:
1. CP es CDMX o Estado de México (cualquier motivo)
2. Mayoreo real: 500+ bultos o 12+ toneladas
3. Queja, error en pedido, cliente enojado o frustrado
4. Quiere ser distribuidor o revendedor
5. Producto no está en el catálogo y el cliente insiste
6. Pregunta algo que no puedes resolver después de intentarlo

NO escales por:
- Preguntas de precio → manda a tienda
- Preguntas de envío → manda a tienda
- "Mayoreo" de menos de 500 bultos → manda a tienda
- Asesoría de producto que sí puedes responder → respóndelo
- Clientes de provincia que quieren comprar → manda a tienda
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

async function chat(history, customer, query = '') {
  let customerContext = '';
  if (customer) {
    const channelLabel = customer.channel === 'paqueteria'
      ? 'Paquetería nacional — llabanaenlinea.com'
      : customer.channelDetail || 'por determinar';

    const lines = [
      `━━━ CONTEXTO ━━━`,
      `Estado: conversación en curso — NO saludar de nuevo`,
      `━━━ CLIENTE ━━━`,
      `Nombre:   ${customer.name     || 'N/D'}`,
      `Estado:   ${customer.state    || 'N/D'}`,
      `Ciudad:   ${customer.city     || 'N/D'}`,
      `Canal:    ${channelLabel}`,
      `Segmento: ${customer.segmento || 'Lead frío'}`,
      customer.tags && customer.tags !== ''
        ? `Tags:     ${customer.tags}` : '',
      customer.totalOrders && customer.totalOrders !== '0'
        ? `Órdenes:  ${customer.totalOrders}` : '',
      `━━━━━━━━━━━━━━━`,
    ].filter(Boolean);

    customerContext = '\n' + lines.join('\n');
  }

  // Cargar Knowledge Base y productos relevantes en paralelo
  const [kb, productos] = await Promise.all([
    knowledgeService.getKnowledgeBase(),
    query ? knowledgeService.getProductosPorEspecie(query) : Promise.resolve(''),
  ]);

  // Sistema dinámico: KB del Sheets si está disponible, SYSTEM_BASE como fallback
  const systemDynamic = kb
    ? `${SYSTEM_BASE}\n\n━━━ CONOCIMIENTO ADICIONAL ━━━\n${kb}\n━━━━━━━━━━━━━━━━━━━━━━━━━`
    : SYSTEM_BASE;

  const productosContext = productos
    ? `\n\n━━━ PRODUCTOS RELEVANTES ━━━\n${productos}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`
    : '';

  const system = customerContext
    ? `${systemDynamic}${productosContext}\n${customerContext}`
    : `${systemDynamic}${productosContext}`;

  const recentHistory = history.slice(-10);

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 800,
    system,
    messages:   recentHistory,
  });

  return response.content[0].text.trim();
}

module.exports = { chat };
