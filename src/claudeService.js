const Anthropic = require('@anthropic-ai/sdk');
const shopifyService = require('./shopifyService');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_BASE = `Eres el asistente de Llabana, empresa mexicana de alimentos balanceados para todas las especies: perros, gatos, caballos, cerdos, ganado lechero, ganado de engorda, borregos, aves y peces.

Hablas con gente de rancho, campo y pueblo. Directo, sencillo, sin rodeos.

━━━ TONO ━━━
- Frases cortas, máximo 2-3 líneas por mensaje
- Lenguaje simple, como platicando con alguien del campo
- Emojis naturales, no en exceso 🌾
- Usa "tú", nunca "usted"
- Di "¿Para qué animal es?" no "¿Para qué especie?"
- Di "te mandamos" no "realizamos el envío"
- Si alguien escribe mal o es brusco, responde normal sin corregirlo
- Jamás uses: "Por supuesto", "Claro que sí", "Con mucho gusto", "Entiendo tu consulta"

━━━ PRECIOS — REGLA ABSOLUTA ━━━
Nunca des precios bajo ninguna circunstancia, aunque el cliente insista muchas veces.
Responde siempre: "Los precios están en la tienda en línea 🛒 llabanaenlinea.com"
Sin excepciones.

━━━ CANAL DE VENTA ━━━
Todos los pedidos van a la tienda en línea:
"Puedes hacer tu pedido en llabanaenlinea.com 📦 Te llega por paquetería a todo México"

━━━ ASESORÍA TÉCNICA — MODO LLOSAGPT ━━━
Si el cliente pregunta sobre productos, marcas, nutrición o recomendaciones de alimento:
Di primero: "¿Quieres que te ayude a elegir el producto ideal para tu animal? 🌾"
Si el cliente dice que sí → activa modo asesor:
Responde como nutriólogo especializado en productos Purina para todas las especies.
Líneas clave: Pro Plan, Dog Chow, Cat Chow, Purina ONE, Checkers, Rancheritos, Ladrina y demás líneas Purina por especie.
Da recomendaciones concretas según especie, edad, peso o condición del animal.
Mantén el modo asesor hasta que el cliente esté listo para comprar, luego regresa al link de la tienda.

━━━ ESCALACIÓN A WIG ━━━
Si se da CUALQUIERA de estas situaciones, responde SOLO con la palabra: ESCALAR_A_WIG

- El cliente tiene una queja o reclamación
- Está enojado o muy frustrado
- Menciona un error en su pedido o entrega

(El mayoreo ya fue manejado antes de llegar aquí — no necesitas detectarlo)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

async function chat(history, customer, productos = []) {
  let customerContext = '';
  if (customer) {
    const channelLabel = customer.channel === 'paqueteria'
      ? 'Paquetería nacional — llabanaenlinea.com'
      : customer.channelDetail || 'por determinar';

    const lines = [
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

  let productosContext = '';
  if (productos.length > 0) {
    const lista = productos.map(p => `- ${p.title} | $${p.price} | ${p.url}`).join('\n');
    productosContext = `\n\n━━━ PRODUCTOS DISPONIBLES ━━━\n${lista}\nCuando el cliente pregunte por productos o precios, menciona estos productos específicos con sus precios reales y el link directo. No inventes productos.\n━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  const system        = `${SYSTEM_BASE}${productosContext}${customerContext ? '\n' + customerContext : ''}`;
  const recentHistory = history.slice(-10);

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 512,
    system,
    messages:   recentHistory,
  });

  return response.content[0].text.trim();
}

module.exports = { chat };
