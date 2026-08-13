// Movie Night Bracket — Apps Script backend
// Bind this script to a Google Sheet (Extensions > Apps Script from inside the sheet).
// It stores every movie night as a row, so the Sheet itself is your history/DB.
//
// Every mutation below is a small, atomic read-modify-write that happens
// entirely inside doPost's lock. That's deliberate: earlier versions had the
// client read a movie night, edit its own copy, and push the whole thing
// back — which meant two people acting around the same moment could
// silently overwrite each other. Doing the read+modify+write server-side,
// one action at a time, removes that race regardless of how many devices
// are using the app at once.

const NIGHTS_SHEET = 'Nights';
const ROSTER_SHEET = 'Roster';
const NIGHTS_HEADER = ['id', 'name', 'theme', 'bracketSize', 'phase', 'organizer', 'createdAt', 'winner', 'data', 'archived'];
const ROSTER_HEADER = ['name', 'addedAt'];
const NIGHT_KNOWN_FIELDS = ['id', 'name', 'theme', 'bracketSize', 'phase', 'organizer', 'createdAt', 'archived'];

function getSheet_(name) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(name === NIGHTS_SHEET ? NIGHTS_HEADER : ROSTER_HEADER);
    return sheet;
  }
  if (name === NIGHTS_SHEET) {
    const lastCol = Math.max(sheet.getLastColumn(), 1);
    const header = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
    if (header.indexOf('archived') === -1) {
      sheet.getRange(1, lastCol + 1).setValue('archived');
    }
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
    if (action === 'deleteNight') return jsonOut_({ ok: true, deleted: deleteNight_(body.id) });
    if (action === 'addToRoster') return jsonOut_({ ok: true, roster: addToRoster_(body.name) });
    if (action === 'removeFromRoster') return jsonOut_({ ok: true, roster: removeFromRoster_(body.name) });

    // Atomic per-action mutations — each one loads the night fresh, applies
    // exactly one change, and writes it back, all inside this same lock.
    if (action === 'addEntry') return jsonOut_({ ok: true, night: addEntry_(body.nightId, body.title, body.submittedBy) });
    if (action === 'removeEntry') return jsonOut_({ ok: true, night: removeEntryAction_(body.nightId, body.entryId) });
    if (action === 'editEntry') return jsonOut_({ ok: true, night: editEntryAction_(body.nightId, body.entryId, body.title) });
    if (action === 'lockSubmissions') return jsonOut_({ ok: true, night: lockSubmissionsAction_(body.nightId) });
    if (action === 'castVote') return jsonOut_({ ok: true, night: castVoteAction_(body.nightId, body.matchupId, body.voterName, body.side) });
    if (action === 'closeRound') return jsonOut_({ ok: true, night: closeRoundAction_(body.nightId) });
    if (action === 'reshuffle') return jsonOut_({ ok: true, night: reshuffleAction_(body.nightId) });
    if (action === 'advanceRound') return jsonOut_({ ok: true, night: advanceRoundAction_(body.nightId) });
    if (action === 'submitBallot') return jsonOut_({ ok: true, night: submitBallotAction_(body.nightId, body.voterName, body.picks) });
    if (action === 'revealResults') return jsonOut_({ ok: true, night: revealResultsAction_(body.nightId) });
    if (action === 'castTiebreakerVote') return jsonOut_({ ok: true, night: castTiebreakerVoteAction_(body.nightId, body.voterName, body.optionId) });
    if (action === 'closeTiebreaker') return jsonOut_({ ok: true, night: closeTiebreakerAction_(body.nightId) });
    if (action === 'revoteTiebreaker') return jsonOut_({ ok: true, night: revoteTiebreakerAction_(body.nightId) });
    if (action === 'transferOrganizer') return jsonOut_({ ok: true, night: transferOrganizerAction_(body.nightId, body.newOrganizer) });
    if (action === 'setArchived') return jsonOut_({ ok: true, night: setArchivedAction_(body.nightId, body.archived) });

    // Generic full-document save — kept as a fallback, not used by the
    // current frontend for anything the atomic actions above cover.
    if (action === 'updateNight') return jsonOut_({ ok: true, night: updateNight_(body.night) });

    return jsonOut_({ ok: false, error: 'Unknown action: ' + action });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

// ---------- sheet-level read/write ----------

function listNights_() {
  const sheet = getSheet_(NIGHTS_SHEET);
  const rows = sheet.getDataRange().getValues();
  const data = rows.slice(1);
  return data.filter((r) => r[0]).map((r) => ({
    id: r[0], name: r[1], theme: r[2], bracketSize: r[3], phase: r[4],
    organizer: r[5], createdAt: r[6], winner: r[7], archived: !!r[9],
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
    organizer: vals[5], createdAt: vals[6], winner: vals[7], archived: !!vals[9],
  }, extra);
}

function createNight_(night) {
  const sheet = getSheet_(NIGHTS_SHEET);
  const { id, name, theme, bracketSize, phase, organizer, createdAt } = night;
  const extra = stripKnown_(night);
  sheet.appendRow([id, name, theme, bracketSize, phase, organizer, createdAt, '', JSON.stringify(extra), false]);
  return night;
}

function updateNight_(night) {
  const sheet = getSheet_(NIGHTS_SHEET);
  const row = findRow_(sheet, night.id);
  if (row === -1) throw new Error('Movie night not found: ' + night.id);
  const { id, name, theme, bracketSize, phase, organizer, createdAt, archived } = night;
  const extra = stripKnown_(night);
  let winner = '';
  if (phase === 'complete' && extra.results && extra.results.length) {
    const top = extra.results[0].votes;
    winner = extra.results.filter((r) => r.votes === top).map((r) => r.title).join(' & ');
  }
  sheet.getRange(row, 1, 1, NIGHTS_HEADER.length).setValues([[id, name, theme, bracketSize, phase, organizer, createdAt, winner, JSON.stringify(extra), !!archived]]);
  return night;
}

function deleteNight_(id) {
  const sheet = getSheet_(NIGHTS_SHEET);
  const row = findRow_(sheet, id);
  if (row === -1) return false;
  sheet.deleteRow(row);
  return true;
}

function stripKnown_(night) {
  const extra = {};
  Object.keys(night).forEach((k) => { if (NIGHT_KNOWN_FIELDS.indexOf(k) === -1) extra[k] = night[k]; });
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

function removeFromRoster_(name) {
  const sheet = getSheet_(ROSTER_SHEET);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === name) { sheet.deleteRow(i + 1); break; }
  }
  return getRoster_();
}

// ---------- pure game logic (mirrors the client's copy) ----------

function genId_() {
  return Math.random().toString(36).slice(2, 10);
}
function shuffle_(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}
function buildRound1_(entries, bracketSize) {
  let pool = shuffle_(entries.map((e) => ({ id: e.id, title: e.title })));
  while (pool.length < bracketSize) pool.push({ id: 'BYE-' + genId_(), title: 'BYE', bye: true });
  if (pool.length > bracketSize) pool = pool.slice(0, bracketSize);
  const matchups = [];
  for (let i = 0; i < pool.length; i += 2) {
    const a = pool[i], b = pool[i + 1];
    let winner = null;
    if (a.bye && !b.bye) winner = b.id;
    else if (b.bye && !a.bye) winner = a.id;
    matchups.push({ id: genId_(), aId: a.id, aTitle: a.title, bId: b.id, bTitle: b.title, votes: {}, winner, tied: false });
  }
  return matchups;
}
function buildNextRound_(prevMatchups) {
  const winners = prevMatchups.map((m) => ({ id: m.winner, title: m.winner === m.aId ? m.aTitle : m.bTitle }));
  const matchups = [];
  for (let i = 0; i < winners.length; i += 2) {
    const a = winners[i], b = winners[i + 1];
    matchups.push({ id: genId_(), aId: a.id, aTitle: a.title, bId: b.id, bTitle: b.title, votes: {}, winner: null, tied: false });
  }
  return matchups;
}
function closeRoundVotes_(matchups) {
  return matchups.map((m) => {
    if (m.winner) return m;
    const counts = { a: 0, b: 0 };
    Object.keys(m.votes).forEach((k) => { const v = m.votes[k]; counts[v] = (counts[v] || 0) + 1; });
    if (counts.a > counts.b) return Object.assign({}, m, { winner: m.aId, tied: false });
    if (counts.b > counts.a) return Object.assign({}, m, { winner: m.bId, tied: false });
    if (counts.a === 0 && counts.b === 0) {
      return Object.assign({}, m, { winner: Math.random() < 0.5 ? m.aId : m.bId, tied: false, undecided: true });
    }
    return Object.assign({}, m, { winner: null, tied: true });
  });
}
function reshuffleTied_(matchups) {
  const tiedOnes = matchups.filter((m) => m.tied);
  if (tiedOnes.length === 0) return matchups;
  let pool = [];
  tiedOnes.forEach((m) => { pool.push({ id: m.aId, title: m.aTitle }); pool.push({ id: m.bId, title: m.bTitle }); });
  pool = shuffle_(pool);
  const newPairs = [];
  for (let i = 0; i < pool.length; i += 2) {
    newPairs.push({ id: genId_(), aId: pool[i].id, aTitle: pool[i].title, bId: pool[i + 1].id, bTitle: pool[i + 1].title, votes: {}, winner: null, tied: false });
  }
  let idx = 0;
  return matchups.map((m) => (m.tied ? newPairs[idx++] : m));
}
function tallyFinalFour_(finalFour, finalFourVotes) {
  const counts = {};
  finalFour.forEach((m) => { counts[m.id] = 0; });
  Object.keys(finalFourVotes).forEach((name) => {
    (finalFourVotes[name] || []).forEach((id) => { if (counts[id] !== undefined) counts[id]++; });
  });
  return counts;
}

// ---------- atomic action handlers ----------
// Each loads the night fresh from the sheet, applies one change, saves it —
// all while doPost still holds the lock, so this whole sequence can't
// interleave with any other device's action.

function loadNightForMutation_(id) {
  const night = getNight_(id);
  if (!night) throw new Error('Movie night not found: ' + id);
  return night;
}

function addEntry_(id, title, submittedBy) {
  const night = loadNightForMutation_(id);
  night.entries = night.entries.concat([{ id: genId_(), title, submittedBy }]);
  return updateNight_(night);
}
function removeEntryAction_(id, entryId) {
  const night = loadNightForMutation_(id);
  night.entries = night.entries.filter((e) => e.id !== entryId);
  return updateNight_(night);
}
function editEntryAction_(id, entryId, title) {
  const night = loadNightForMutation_(id);
  night.entries = night.entries.map((e) => (e.id === entryId ? Object.assign({}, e, { title }) : e));
  return updateNight_(night);
}
function lockSubmissionsAction_(id) {
  const night = loadNightForMutation_(id);
  if (night.bracketSize === 4) {
    if (night.entries.length < 4) throw new Error('Need at least 4 entries');
    night.phase = 'final-four';
    night.finalFour = shuffle_(night.entries).slice(0, 4).map((e) => ({ id: e.id, title: e.title }));
  } else {
    if (night.entries.length === 0) throw new Error('No entries yet');
    night.phase = 'bracket';
    night.rounds = [buildRound1_(night.entries, night.bracketSize)];
    night.currentRoundIndex = 0;
  }
  return updateNight_(night);
}
function castVoteAction_(id, matchupId, voterName, side) {
  const night = loadNightForMutation_(id);
  night.rounds = night.rounds.map((round, i) => {
    if (i !== night.currentRoundIndex) return round;
    return round.map((m) => {
      if (m.id !== matchupId) return m;
      const votes = Object.assign({}, m.votes);
      votes[voterName] = side;
      return Object.assign({}, m, { votes });
    });
  });
  return updateNight_(night);
}
function closeRoundAction_(id) {
  const night = loadNightForMutation_(id);
  night.rounds = night.rounds.map((r, i) => (i === night.currentRoundIndex ? closeRoundVotes_(r) : r));
  return updateNight_(night);
}
function reshuffleAction_(id) {
  const night = loadNightForMutation_(id);
  night.rounds = night.rounds.map((r, i) => (i === night.currentRoundIndex ? reshuffleTied_(r) : r));
  return updateNight_(night);
}
function advanceRoundAction_(id) {
  const night = loadNightForMutation_(id);
  const currentRound = night.rounds[night.currentRoundIndex];
  const winners = currentRound.map((m) => ({ id: m.winner, title: m.winner === m.aId ? m.aTitle : m.bTitle }));
  if (winners.length === 4) {
    night.phase = 'final-four';
    night.finalFour = winners;
  } else {
    night.rounds = night.rounds.concat([buildNextRound_(currentRound)]);
    night.currentRoundIndex = night.currentRoundIndex + 1;
  }
  return updateNight_(night);
}
function submitBallotAction_(id, voterName, picks) {
  const night = loadNightForMutation_(id);
  const votes = Object.assign({}, night.finalFourVotes);
  votes[voterName] = picks;
  night.finalFourVotes = votes;
  return updateNight_(night);
}
function revealResultsAction_(id) {
  const night = loadNightForMutation_(id);
  const counts = tallyFinalFour_(night.finalFour, night.finalFourVotes);
  const results = night.finalFour.map((m) => Object.assign({}, m, { votes: counts[m.id] || 0 })).sort((a, b) => b.votes - a.votes);
  const top = results[0].votes;
  const tiedTop = results.filter((r) => r.votes === top);
  night.results = results;
  if (tiedTop.length > 1) {
    night.phase = 'tiebreaker';
    night.tiebreaker = { options: tiedTop.map((t) => ({ id: t.id, title: t.title })), votes: {}, tied: false };
  } else {
    night.phase = 'complete';
  }
  return updateNight_(night);
}
function castTiebreakerVoteAction_(id, voterName, optionId) {
  const night = loadNightForMutation_(id);
  const votes = Object.assign({}, night.tiebreaker.votes);
  votes[voterName] = optionId;
  night.tiebreaker = Object.assign({}, night.tiebreaker, { votes });
  return updateNight_(night);
}
function closeTiebreakerAction_(id) {
  const night = loadNightForMutation_(id);
  const tb = night.tiebreaker;
  const counts = {};
  tb.options.forEach((o) => { counts[o.id] = 0; });
  Object.keys(tb.votes).forEach((name) => { const optId = tb.votes[name]; if (counts[optId] !== undefined) counts[optId]++; });
  const tallied = tb.options.map((o) => Object.assign({}, o, { votes: counts[o.id] || 0 })).sort((a, b) => b.votes - a.votes);
  const top = tallied[0].votes;
  const stillTied = tallied.filter((t) => t.votes === top);
  if (stillTied.length > 1) {
    night.tiebreaker = Object.assign({}, tb, { tied: true });
  } else {
    const winnerId = tallied[0].id;
    night.results = night.results.slice().sort((a, b) => {
      if (a.id === winnerId) return -1;
      if (b.id === winnerId) return 1;
      return b.votes - a.votes;
    });
    night.tiebreakerWinnerId = winnerId;
    night.tiebreakerTally = tallied;
    night.phase = 'complete';
  }
  return updateNight_(night);
}
function revoteTiebreakerAction_(id) {
  const night = loadNightForMutation_(id);
  night.tiebreaker = Object.assign({}, night.tiebreaker, { votes: {}, tied: false });
  return updateNight_(night);
}
function transferOrganizerAction_(id, newOrganizer) {
  const night = loadNightForMutation_(id);
  night.organizer = newOrganizer;
  return updateNight_(night);
}
function setArchivedAction_(id, archived) {
  const night = loadNightForMutation_(id);
  night.archived = !!archived;
  return updateNight_(night);
}
