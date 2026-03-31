/**
 * Script de verificación del Google Spreadsheet.
 * Confirma que las 4 pestañas requeridas existen y son accesibles.
 *
 * Uso: node scripts/setup-sheets.js
 */

require('dotenv').config();
const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SHEETS_REQUERIDAS = [
  '1 Base Maestra',
  '2 Sucursales',
  '3 Rutas Reparto',
  '4 Seguimientos 24h',
];

async function main() {
  if (!SPREADSHEET_ID || SPREADSHEET_ID === 'your_spreadsheet_id_here') {
    console.error('❌ Configura GOOGLE_SHEETS_ID en tu .env');
    process.exit(1);
  }

  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });

  console.log('🔍 Verificando acceso al Spreadsheet...\n');

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existentes = meta.data.sheets.map(s => s.properties.title);

  console.log(`📊 Spreadsheet: "${meta.data.properties.title}"`);
  console.log(`   URL: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}\n`);

  let todo_ok = true;
  for (const nombre of SHEETS_REQUERIDAS) {
    if (existentes.includes(nombre)) {
      console.log(`  ✅ "${nombre}"`);
    } else {
      console.log(`  ❌ "${nombre}" — NO ENCONTRADA`);
      todo_ok = false;
    }
  }

  // Verificar conteo de filas en Base Maestra
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: '1 Base Maestra!D:D',
  });
  const contactos = (res.data.values || []).length - 1; // -1 por header
  console.log(`\n📋 Contactos en Base Maestra: ${contactos.toLocaleString()}`);

  // Verificar sucursales
  const resSuc = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: '2 Sucursales!B:B',
  });
  const sucursales = (resSuc.data.values || []).length - 1;
  console.log(`🏪 Sucursales registradas: ${sucursales}`);

  if (todo_ok) {
    console.log('\n🎉 Todo listo. El bot puede conectarse al Spreadsheet.');
  } else {
    console.log('\n⚠️  Algunas pestañas faltan. Créalas manualmente en el Spreadsheet.');
  }
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
