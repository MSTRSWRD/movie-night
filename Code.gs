// Movie Night Bracket — Apps Script backend
// Bind this script to a Google Sheet (Extensions > Apps Script from inside the sheet).
// It stores every movie night as a row, so the Sheet itself is your history/DB.

const NIGHTS_SHEET = 'Nights';
const ROSTER_SHEET = 'Roster';
const NIGHTS_HEADER = ['id', 'name', 'theme', 'bracketSize', 'phase', 'organizer', 'createdAt', 'winner', 'data'];
const ROSTER_HEADER = ['name', 'addedAt'];

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(name === NIGHTS_SHEET ? NIGHTS_HEADER : ROSTER_HEADER);
  }
  return sheet;
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    const action = e.parameter.action;
    if (action === 'listNights') return jsonOut_({ ok: true, nights: listNights_() });
    if (action === 'getNight') return jsonOut_({ ok: true, night: getNight_(e.parameter.id) });
    if (action === 'getRoster') return jsonOut_({ ok: true, roster: getRoster_() });
    return jsonOut_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    if (action === 'createNight') return jsonOut_({ ok: true, night: createNight_(body.night) });
    if (action === 'updateNight') return jsonOut_({ ok: true, night: updateNight_(body.night) });
    if (action === 'addToRoster') return jsonOut_({ ok: true, roster: addToRoster_(body.name) });
    return jsonOut_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function listNights_() {
  const sheet = getSheet_(NIGHTS_SHEET);
  const rows = sheet.getDataRange().getValues();
  const data = rows.slice(1);
  return data.filter((r) => r[0]).map((r) => ({
    id: r[0], name: r[1], theme: r[2], bracketSize: r[3], phase: r[4],
    organizer: r[5], createdAt: r[6], winner: r[7],
  })).reverse();
}

function findRow_(sheet, id) {
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === id) return i + 1;
  }
  return -1;
}

function getNight_(id) {
  const sheet = getSheet_(NIGHTS_SHEET);
  const row = findRow_(sheet, id);
  if (row === -1) return null;
  const vals = sheet.getRange(row, 1, 1, NIGHTS_HEADER.length).getValues()[0];
  const extra = JSON.parse(vals[8] || '{}');
  return Object.assign({
    id: vals[0], name: vals[1], theme: vals[2], bracketSize: vals[3], phase: vals[4],
    organizer: vals[5], createdAt: vals[6], winner: vals[7],
  }, extra);
}

function createNight_(night) {
  const sheet = getSheet_(NIGHTS_SHEET);
  const { id, name, theme, bracketSize, phase, organizer, createdAt } = night;
  const extra = stripKnown_(night);
  sheet.appendRow([id, name, theme, bracketSize, phase, organizer, createdAt, '', JSON.stringify(extra)]);
  return night;
}

function updateNight_(night) {
  const sheet = getSheet_(NIGHTS_SHEET);
  const row = findRow_(sheet, night.id);
  if (row === -1) throw new Error('Movie night not found: ' + night.id);
  const { id, name, theme, bracketSize, phase, organizer, createdAt } = night;
  const extra = stripKnown_(night);
  let winner = '';
  if (phase === 'complete' && extra.results && extra.results.length) {
    const top = extra.results[0].votes;
    winner = extra.results.filter((r) => r.votes === top).map((r) => r.title).join(' & ');
  }
  sheet.getRange(row, 1, 1, NIGHTS_HEADER.length).setValues([[id, name, theme, bracketSize, phase, organizer, createdAt, winner, JSON.stringify(extra)]]);
  return night;
}

function stripKnown_(night) {
  const known = ['id', 'name', 'theme', 'bracketSize', 'phase', 'organizer', 'createdAt'];
  const extra = {};
  Object.keys(night).forEach((k) => { if (known.indexOf(k) === -1) extra[k] = night[k]; });
  return extra;
}

function getRoster_() {
  const sheet = getSheet_(ROSTER_SHEET);
  const rows = sheet.getDataRange().getValues();
  return rows.slice(1).filter((r) => r[0]).map((r) => r[0]);
}

function addToRoster_(name) {
  const existing = getRoster_();
  if (existing.indexOf(name) === -1) {
    getSheet_(ROSTER_SHEET).appendRow([name, new Date().toISOString()]);
    existing.push(name);
  }
  return existing;
}
