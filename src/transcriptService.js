const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;
const SHEET = '5 Transcripciones';

function getSheets() {
  let credentials;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_BASE64) {
    credentials = JSON.parse(
      Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
    );
  } else {
    throw new Error('Faltan credenciales de Google');
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function saveTranscript(nombre, telefono, transcript) {
  const sheets = getSheets();
  const fecha = new Date().toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET}!A:D`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[fecha, nombre, telefono, transcript]]
    }
  });
}

async function getTranscripts() {
  const sheets = getSheets();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET}!A2:D`,
  });

  const rows = res.data.values || [];
  return rows
    .filter(r => r[0] || r[1] || r[2])
    .map(r => ({
      fecha:      r[0] || '',
      nombre:     r[1] || '',
      telefono:   r[2] || '',
      transcript: r[3] || '',
    }))
    .reverse();
}

async function updateTranscript(telefono, nombre, transcript) {
  const sheets = getSheets();
  const telefono_clean = telefono.replace('whatsapp:', '').replace(/^\+?52/, '');

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET}!A2:D`,
  });

  const rows = res.data.values || [];
  const rowIndex = rows.findIndex(r => (r[2] || '').replace(/^\+?52/, '').replace(/\D/g, '').slice(-10) === telefono_clean.replace(/\D/g, '').slice(-10));

  const fecha = new Date().toLocaleString('es-MX', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false
  });

  if (rowIndex !== -1) {
    const sheetRow = rowIndex + 2; // +1 por header, +1 por base-1
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET}!A${sheetRow}:D${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[fecha, nombre || rows[rowIndex][1] || '', rows[rowIndex][2] || '', transcript]]
      }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET}!A:D`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[fecha, nombre || '', telefono, transcript]]
      }
    });
  }
}

module.exports = { saveTranscript, getTranscripts, updateTranscript };
