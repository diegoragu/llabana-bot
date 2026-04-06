const { getSheets, SPREADSHEET_ID } = require('./sheetsService');

const SHEET = '5 Transcripciones';

async function saveTranscript(nombre, telefono, transcript) {
  const sheets = await getSheets();
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
  const sheets = await getSheets();

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

module.exports = { saveTranscript, getTranscripts };
