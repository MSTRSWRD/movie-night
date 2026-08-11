// Movie Night Bracket — app logic
// Talks to a Google Apps Script web app (see Code.gs) for storage/history.

const CONFIG = {
  // Paste your Apps Script Web App URL here after deploying (see README.md).
  API_URL: "https://script.google.com/macros/s/AKfycbzybglshqb3Y8aGz-RqIpw2cXoPOyR7AXpjMAcrE5nrjse5Wmc_aQ1UsaA8C9Tw8buSkA/exec",
};

// ---------- small utils ----------
const genId = () => Math.random().toString(36).slice(2, 10);
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
function roundLabel(enteringCount) {
  if (enteringCount >= 32) return "Round of 32";
  if (enteringCount === 16) return "Round of 16";
  if (enteringCount === 8) return "Quarterfinals";
  return `Round of ${enteringCount}`;
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------- bracket logic ----------
function buildRound1(entries, bracketSize) {
  let pool = shuffle(entries.map((e) => ({ id: e.id, title: e.title })));
  while (pool.length < bracketSize) pool.push({ id: `BYE-${genId()}`, title: "BYE", bye: true });
  if (pool.length > bracketSize) pool = pool.slice(0, bracketSize);
  const matchups = [];
  for (let i = 0; i < pool.length; i += 2) {
    const a = pool[i], b = pool[i + 1];
    let winner = null;
    if (a.bye && !b.bye) winner = b.id;
    else if (b.bye && !a.bye) winner = a.id;
    matchups.push({ id: genId(), aId: a.id, aTitle: a.title, bId: b.id, bTitle: b.title, votes: {}, winner, tied: false });
  }
  return matchups;
}
function buildNextRound(prevMatchups) {
  const winners = prevMatchups.map((m) => ({ id: m.winner, title: m.winner === m.aId ? m.aTitle : m.bTitle }));
  const matchups = [];
  for (let i = 0; i < winners.length; i += 2) {
    const a = winners[i], b = winners[i + 1];
    matchups.push({ id: genId(), aId: a.id, aTitle: a.title, bId: b.id, bTitle: b.title, votes: {}, winner: null, tied: false });
  }
  return matchups;
}
function closeRoundVotes(matchups) {
  return matchups.map((m) => {
    if (m.winner) return m;
    const counts = { a: 0, b: 0 };
    Object.values(m.votes).forEach((v) => { counts[v] = (counts[v] || 0) + 1; });
    if (counts.a > counts.b) return { ...m, winner: m.aId, tied: false };
    if (counts.b > counts.a) return { ...m, winner: m.bId, tied: false };
    return { ...m, winner: null, tied: true };
  });
}
function reshuffleTied(matchups) {
  const tiedOnes = matchups.filter((m) => m.tied);
  if (tiedOnes.length === 0) return matchups;
  const pool = shuffle(tiedOnes.flatMap((m) => [{ id: m.aId, title: m.aTitle }, { id: m.bId, title: m.bTitle }]));
  const newPairs = [];
  for (let i = 0; i < pool.length; i += 2) {
    newPairs.push({ id: genId(), aId: pool[i].id, aTitle: pool[i].title, bId: pool[i + 1].id, bTitle: pool[i + 1].title, votes: {}, winner: null, tied: false });
  }
  let idx = 0;
  return matchups.map((m) => (m.tied ? newPairs[idx++] : m));
}
function tallyFinalFour(finalFour, finalFourVotes) {
  const counts = {};
  finalFour.forEach((m) => { counts[m.id] = 0; });
  Object.values(finalFourVotes).forEach((picks) => {
    (picks || []).forEach((id) => { if (counts[id] !== undefined) counts[id]++; });
  });
  return counts;
}

// ---------- API layer ----------
async function apiGet(action, params = {}) {
  const qs = new URLSearchParams({ action, ...params }).toString();
  const res = await fetch(`${CONFIG.API_URL}?${qs}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Request failed");
  return data;
}
async function apiPost(action, payload = {}) {
  const res = await fetch(CONFIG.API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" }, // avoids CORS preflight on Apps Script
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "Request failed");
  return data;
}

// ---------- app state ----------
const state = {
  screen: "loading", // loading | login | home | night
  identity: JSON.parse(localStorage.getItem("mnb-identity") || "null"),
  roster: [],
  nightsIndex: [],
  night: null,
  err: "",
  creating: false,
  loginMode: null,
  organizerTransferOpen: false,
  finalFourPicks: null,
  manageRosterOpen: false,
};
let pollHandle = null;

function setState(patch) {
  Object.assign(state, patch);
  render();
}

async function boot() {
  if (CONFIG.API_URL.indexOf("PASTE_YOUR") === 0) {
    setState({ screen: "config-error" });
    return;
  }
  try {
    const [rosterRes, indexRes] = await Promise.all([apiGet("getRoster"), apiGet("listNights")]);
    setState({ roster: rosterRes.roster, nightsIndex: indexRes.nights, screen: state.identity ? "home" : "login" });
  } catch (e) {
    setState({ screen: "login", err: "Couldn't reach the server. Check the app is deployed." });
  }
}

async function refreshHome() {
  try {
    const [rosterRes, indexRes] = await Promise.all([apiGet("getRoster"), apiGet("listNights")]);
    setState({ roster: rosterRes.roster, nightsIndex: indexRes.nights });
  } catch (e) { /* ignore transient errors */ }
}

async function login(name, isNew) {
  try {
    let roster = state.roster;
    if (isNew && !roster.includes(name)) {
      const r = await apiPost("addToRoster", { name });
      roster = r.roster;
    }
    const identity = { name };
    localStorage.setItem("mnb-identity", JSON.stringify(identity));
    setState({ identity, roster, screen: "home", err: "" });
    refreshHome();
  } catch (e) {
    setState({ err: "Couldn't sign in — try again." });
  }
}

async function removeRosterName(name) {
  try {
    const r = await apiPost("removeFromRoster", { name });
    setState({ roster: r.roster });
  } catch (e) {
    setState({ err: "Couldn't remove that name." });
  }
}

function logout() {
  localStorage.removeItem("mnb-identity");
  stopPolling();
  setState({ identity: null, screen: "login", night: null });
}

async function openNight(id) {
  stopPolling();
  setState({ screen: "night", night: null, finalFourPicks: null });
  await fetchNight(id);
  pollHandle = setInterval(() => fetchNight(id), 4000);
}
function stopPolling() {
  if (pollHandle) clearInterval(pollHandle);
  pollHandle = null;
}
async function fetchNight(id) {
  try {
    const res = await apiGet("getNight", { id });
    if (res.night) setState({ night: res.night });
  } catch (e) { /* ignore transient poll errors */ }
}
function goHome() {
  stopPolling();
  setState({ screen: "home", night: null });
  refreshHome();
}

async function createNight({ name, theme, bracketSize }) {
  const doc = {
    id: genId(), name, theme, bracketSize,
    phase: "submitting", organizer: state.identity.name,
    entries: [], rounds: [], currentRoundIndex: 0,
    finalFour: [], finalFourVotes: {}, results: null,
    createdAt: Date.now(),
  };
  try {
    await apiPost("createNight", { night: doc });
    setState({ creating: false });
    await openNight(doc.id);
  } catch (e) {
    setState({ err: "Couldn't create the movie night." });
  }
}

async function updateNight(mutator) {
  const current = state.night;
  if (!current) return;
  const next = mutator(current);
  setState({ night: next }); // optimistic
  try {
    await apiPost("updateNight", { night: next });
  } catch (e) {
    setState({ err: "Couldn't save that — refreshing." });
    fetchNight(current.id);
  }
}

// ---------- actions ----------
async function submitEntry(title) {
  await updateNight((cur) => ({ ...cur, entries: [...cur.entries, { id: genId(), title, submittedBy: state.identity.name }] }));
}
async function removeEntry(entryId) {
  await updateNight((cur) => ({ ...cur, entries: cur.entries.filter((e) => e.id !== entryId) }));
}
async function editEntry(entryId, newTitle) {
  await updateNight((cur) => ({ ...cur, entries: cur.entries.map((e) => (e.id === entryId ? { ...e, title: newTitle } : e)) }));
}
async function lockSubmissions() {
  const night = state.night;
  if (night.bracketSize === 4) {
    if (night.entries.length < 4) return;
    const finalFour = shuffle(night.entries).slice(0, 4).map((e) => ({ id: e.id, title: e.title }));
    await updateNight((cur) => ({ ...cur, phase: "final-four", finalFour }));
    return;
  }
  if (night.entries.length === 0) return;
  const round1 = buildRound1(night.entries, night.bracketSize);
  await updateNight((cur) => ({ ...cur, phase: "bracket", rounds: [round1], currentRoundIndex: 0 }));
}
async function castVote(matchupId, side) {
  await updateNight((cur) => {
    const rounds = cur.rounds.map((r, i) => {
      if (i !== cur.currentRoundIndex) return r;
      return r.map((m) => (m.id === matchupId ? { ...m, votes: { ...m.votes, [state.identity.name]: side } } : m));
    });
    return { ...cur, rounds };
  });
}
async function closeRound() {
  await updateNight((cur) => {
    const rounds = cur.rounds.map((r, i) => (i === cur.currentRoundIndex ? closeRoundVotes(r) : r));
    return { ...cur, rounds };
  });
}
async function doReshuffle() {
  await updateNight((cur) => {
    const rounds = cur.rounds.map((r, i) => (i === cur.currentRoundIndex ? reshuffleTied(r) : r));
    return { ...cur, rounds };
  });
}
async function advanceRound() {
  await updateNight((cur) => {
    const currentRound = cur.rounds[cur.currentRoundIndex];
    const winners = currentRound.map((m) => ({ id: m.winner, title: m.winner === m.aId ? m.aTitle : m.bTitle }));
    if (winners.length === 4) return { ...cur, phase: "final-four", finalFour: winners };
    const nextRound = buildNextRound(currentRound);
    return { ...cur, rounds: [...cur.rounds, nextRound], currentRoundIndex: cur.currentRoundIndex + 1 };
  });
}
async function submitFinalFourBallot(picks) {
  await updateNight((cur) => ({ ...cur, finalFourVotes: { ...cur.finalFourVotes, [state.identity.name]: picks } }));
}
async function revealResults() {
  await updateNight((cur) => {
    const counts = tallyFinalFour(cur.finalFour, cur.finalFourVotes);
    const results = cur.finalFour.map((m) => ({ ...m, votes: counts[m.id] || 0 })).sort((a, b) => b.votes - a.votes);
    const top = results[0].votes;
    const tiedTop = results.filter((r) => r.votes === top);
    if (tiedTop.length > 1) {
      return { ...cur, phase: "tiebreaker", results, tiebreaker: { options: tiedTop.map((t) => ({ id: t.id, title: t.title })), votes: {}, tied: false } };
    }
    return { ...cur, phase: "complete", results };
  });
}
async function castTiebreakerVote(optionId) {
  await updateNight((cur) => ({ ...cur, tiebreaker: { ...cur.tiebreaker, votes: { ...cur.tiebreaker.votes, [state.identity.name]: optionId } } }));
}
async function closeTiebreaker() {
  await updateNight((cur) => {
    const counts = {};
    cur.tiebreaker.options.forEach((o) => { counts[o.id] = 0; });
    Object.values(cur.tiebreaker.votes).forEach((id) => { if (counts[id] !== undefined) counts[id]++; });
    const tallied = cur.tiebreaker.options.map((o) => ({ ...o, votes: counts[o.id] || 0 })).sort((a, b) => b.votes - a.votes);
    const top = tallied[0].votes;
    const stillTied = tallied.filter((t) => t.votes === top);
    if (stillTied.length > 1) {
      return { ...cur, tiebreaker: { ...cur.tiebreaker, tied: true } };
    }
    const winnerId = tallied[0].id;
    // keep original approval counts for display, just float the tiebreaker winner to the top
    const reordered = [...cur.results].sort((a, b) => {
      if (a.id === winnerId) return -1;
      if (b.id === winnerId) return 1;
      return b.votes - a.votes;
    });
    return { ...cur, phase: "complete", results: reordered, tiebreakerWinnerId: winnerId, tiebreakerTally: tallied };
  });
}
async function revoteTiebreaker() {
  await updateNight((cur) => ({ ...cur, tiebreaker: { ...cur.tiebreaker, votes: {}, tied: false } }));
}
async function transferOrganizer(newOrganizer) {
  await updateNight((cur) => ({ ...cur, organizer: newOrganizer }));
  setState({ organizerTransferOpen: false });
}

// ---------- rendering ----------
const PHASE_LABEL = { submitting: "Taking submissions", bracket: "Voting", "final-four": "Final four vote", complete: "Decided" };

function render() {
  const app = document.getElementById("app");
  if (state.screen === "loading") { app.innerHTML = loadingView(); }
  else if (state.screen === "config-error") { app.innerHTML = configErrorView(); }
  else if (state.screen === "login") { app.innerHTML = loginView(); bindLoginEvents(); }
  else if (state.screen === "home") { app.innerHTML = homeView(); bindHomeEvents(); }
  else if (state.screen === "night") {
    if (!state.night) { app.innerHTML = loadingView(); }
    else { app.innerHTML = nightView(); bindNightEvents(); }
  }
  renderIcons();
}

function shell(inner) {
  return `<div class="mnb-shell">${inner}</div>`;
}
function headerHtml(title, sub) {
  return `<div class="mnb-header">
    <div class="mnb-seal"><i data-icon="film"></i></div>
    <div>
      <h1 class="mnb-display mnb-title">${esc(title)}</h1>
      ${sub ? `<p class="mnb-mono mnb-sub">${esc(sub)}</p>` : ""}
    </div>
  </div>`;
}
function loadingView() {
  return shell(`<div style="padding:60px 0;text-align:center;"><i data-icon="film" style="font-size:28px;color:var(--marquee)"></i><p class="mnb-mono" style="margin-top:10px;color:var(--smoke);font-size:13px;">Loading&hellip;</p></div>`);
}
function configErrorView() {
  return shell(`${headerHtml("Movie Night", "Setup needed")}
  <div class="mnb-card">
    <p style="font-size:13.5px;color:var(--smoke);margin:0 0 10px;">This app isn't connected to a backend yet. Open <code>app.js</code> and set <code>CONFIG.API_URL</code> to your deployed Apps Script web app URL — see README.md.</p>
  </div>`);
}

function loginView() {
  const roster = state.roster;
  const mode = state.loginMode || (roster.length ? "pick" : "new");
  return shell(`${headerHtml("Movie Night", "Who's watching?")}
  <div class="mnb-card" style="display:flex;flex-direction:column;gap:12px;">
    ${roster.length ? `<div style="display:flex;gap:8px;">
      <button class="mnb-btn mnb-btn-ghost" data-mode="pick" style="flex:1;${mode === "pick" ? "background:rgba(227,167,46,0.12);" : ""}">My name's listed</button>
      <button class="mnb-btn mnb-btn-ghost" data-mode="new" style="flex:1;${mode === "new" ? "background:rgba(227,167,46,0.12);" : ""}">I'm new</button>
    </div>` : ""}
    ${mode === "pick" && roster.length ? `<select class="mnb-select" id="login-select">${roster.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("")}</select>`
      : `<input class="mnb-input" id="login-name" placeholder="Your display name" />`}
    ${state.err ? `<p style="color:var(--velvet);font-size:12.5px;margin:0;">${esc(state.err)}</p>` : ""}
    <button class="mnb-btn mnb-btn-gold" id="login-submit"><i data-icon="arrow-right"></i> Enter</button>
  </div>`);
}
function bindLoginEvents() {
  document.querySelectorAll("[data-mode]").forEach((btn) => btn.addEventListener("click", () => setState({ loginMode: btn.dataset.mode })));
  document.getElementById("login-submit").addEventListener("click", () => {
    const mode = state.loginMode || (state.roster.length ? "pick" : "new");
    const name = mode === "pick" ? document.getElementById("login-select").value : document.getElementById("login-name").value.trim();
    if (!name) return;
    login(name, mode === "new");
  });
}

function homeView() {
  const nights = state.nightsIndex;
  return shell(`
  <div style="display:flex;justify-content:space-between;align-items:flex-start;">
    ${headerHtml("Movie Night", `Signed in as ${state.identity.name}`)}
    <button class="mnb-btn mnb-btn-ghost" id="logout-btn" style="padding:8px 12px;"><i data-icon="logout"></i></button>
  </div>
  ${state.creating ? createFormHtml() : `<button class="mnb-btn mnb-btn-gold" id="start-night" style="width:100%;margin-bottom:12px;"><i data-icon="plus"></i> Start a movie night</button>`}
  ${!state.creating ? rosterPanelHtml() : ""}
  <p class="mnb-mono" style="font-size:11px;color:var(--smoke);margin:18px 0 10px;letter-spacing:0.05em;">ON THE MARQUEE</p>
  ${nights.length === 0 ? `<p style="font-size:13.5px;color:var(--smoke);">No movie nights yet. Start one above.</p>` : ""}
  <div style="display:flex;flex-direction:column;gap:10px;">
    ${nights.map((n) => `<button class="mnb-card mnb-night-row" data-id="${esc(n.id)}" style="text-align:left;cursor:pointer;display:flex;justify-content:space-between;align-items:center;width:100%;">
      <div>
        <p style="margin:0;font-weight:600;font-size:14.5px;">${esc(n.name)}${n.winner ? ` <span style="color:var(--marquee);font-weight:400;">&mdash; ${esc(n.winner)}</span>` : ""}</p>
        <p class="mnb-mono" style="margin:3px 0 0;font-size:11px;color:var(--smoke);">${esc(n.theme)} &middot; ${esc(n.bracketSize)} films &middot; ${new Date(n.createdAt).toLocaleDateString()}</p>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="mnb-badge" style="background:rgba(227,167,46,0.14);color:var(--marquee);">${esc(PHASE_LABEL[n.phase] || n.phase)}</span>
        <i data-icon="chevron-right" style="color:var(--smoke);"></i>
      </div>
    </button>`).join("")}
  </div>`);
}
function rosterPanelHtml() {
  if (!state.manageRosterOpen) {
    return `<button class="mnb-btn mnb-btn-ghost" id="open-roster" style="width:100%;margin-bottom:18px;font-size:12px;"><i data-icon="users"></i> Manage roster</button>`;
  }
  return `<div class="mnb-card" style="margin-bottom:18px;display:flex;flex-direction:column;gap:8px;">
    <p class="mnb-mono" style="font-size:11px;color:var(--smoke);margin:0 0 4px;">ROSTER &mdash; remove anyone who shouldn't be listed</p>
    ${state.roster.map((n) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;">
      <span style="font-size:14px;">${esc(n)}</span>
      <button class="roster-remove" data-name="${esc(n)}" style="background:transparent;border:none;color:var(--smoke);cursor:pointer;padding:4px;" title="Remove"><i data-icon="trash" style="font-size:13px;"></i></button>
    </div>`).join("")}
    <button class="mnb-btn mnb-btn-ghost" id="close-roster" style="margin-top:6px;font-size:12px;">Done</button>
  </div>`;
}
function createFormHtml() {
  return `<div class="mnb-card" style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px;">
    <input class="mnb-input" id="new-name" placeholder="Movie night name (e.g. August pick)" />
    <input class="mnb-input" id="new-theme" placeholder="Theme / category (e.g. 90s action)" />
    <div>
      <p class="mnb-mono" style="font-size:11px;color:var(--smoke);margin:0 0 6px;">Bracket size</p>
      <div style="display:flex;gap:8px;" id="bracket-size-group">
        ${[4, 8, 16, 32].map((n) => `<button class="mnb-btn mnb-btn-ghost bsize-btn" data-size="${n}" style="flex:1;${n === 16 ? "background:rgba(227,167,46,0.14);border-color:var(--marquee);" : ""}">${n}</button>`).join("")}
      </div>
    </div>
    <div style="display:flex;gap:8px;">
      <button class="mnb-btn mnb-btn-ghost" id="cancel-create" style="flex:1;">Cancel</button>
      <button class="mnb-btn mnb-btn-gold" id="submit-create" style="flex:1;">Create</button>
    </div>
  </div>`;
}
function bindHomeEvents() {
  document.getElementById("logout-btn").addEventListener("click", logout);
  const startBtn = document.getElementById("start-night");
  if (startBtn) startBtn.addEventListener("click", () => setState({ creating: true }));
  const cancelBtn = document.getElementById("cancel-create");
  if (cancelBtn) cancelBtn.addEventListener("click", () => setState({ creating: false }));
  const openRoster = document.getElementById("open-roster");
  if (openRoster) openRoster.addEventListener("click", () => setState({ manageRosterOpen: true }));
  const closeRoster = document.getElementById("close-roster");
  if (closeRoster) closeRoster.addEventListener("click", () => setState({ manageRosterOpen: false }));
  document.querySelectorAll(".roster-remove").forEach((btn) => btn.addEventListener("click", () => {
    if (confirm(`Remove ${btn.dataset.name} from the roster?`)) removeRosterName(btn.dataset.name);
  }));
  let chosenSize = 16;
  document.querySelectorAll(".bsize-btn").forEach((btn) => btn.addEventListener("click", () => {
    chosenSize = Number(btn.dataset.size);
    document.querySelectorAll(".bsize-btn").forEach((b) => { b.style.background = ""; b.style.borderColor = "#4A4237"; });
    btn.style.background = "rgba(227,167,46,0.14)"; btn.style.borderColor = "var(--marquee)";
  }));
  const submitBtn = document.getElementById("submit-create");
  if (submitBtn) submitBtn.addEventListener("click", () => {
    const name = document.getElementById("new-name").value.trim();
    const theme = document.getElementById("new-theme").value.trim();
    if (!name || !theme) return;
    createNight({ name, theme, bracketSize: chosenSize });
  });
  document.querySelectorAll(".mnb-night-row").forEach((row) => row.addEventListener("click", () => openNight(row.dataset.id)));
}

function nightView() {
  const night = state.night;
  const isOrganizer = night.organizer === state.identity.name;
  let phaseHtml = "";
  if (night.phase === "submitting") phaseHtml = submitPhaseHtml(night, isOrganizer);
  else if (night.phase === "bracket") phaseHtml = bracketPhaseHtml(night, isOrganizer);
  else if (night.phase === "final-four") phaseHtml = finalFourPhaseHtml(night, isOrganizer);
  else if (night.phase === "tiebreaker") phaseHtml = tiebreakerPhaseHtml(night, isOrganizer);
  else if (night.phase === "complete") phaseHtml = resultsPhaseHtml(night);
  const showTransfer = (night.phase === "bracket" || night.phase === "final-four" || night.phase === "tiebreaker") && isOrganizer;
  return shell(`
  <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
    <button class="mnb-btn mnb-btn-ghost" id="back-home" style="padding:7px 11px;font-size:12px;">&larr; All nights</button>
    <button class="mnb-btn mnb-btn-ghost" id="logout-btn" style="padding:7px 11px;"><i data-icon="logout"></i></button>
  </div>
  <div style="margin:18px 0 6px;">
    <h1 class="mnb-display" style="font-size:26px;margin:0;color:var(--marquee);">${esc(night.name)}</h1>
    <p class="mnb-mono" style="margin:4px 0 0;font-size:12px;color:var(--smoke);">${esc(night.theme)} &middot; organized by ${esc(night.organizer)}${isOrganizer ? " (you)" : ""}</p>
  </div>
  ${phaseHtml}
  ${showTransfer ? organizerTransferHtml(night) : ""}
  `);
}

function submitPhaseHtml(night, isOrganizer) {
  const disableLock = night.bracketSize === 4 ? night.entries.length < 4 : night.entries.length === 0;
  return `
  <div class="mnb-card" style="display:flex;gap:8px;margin-bottom:16px;">
    <input class="mnb-input" id="entry-title" placeholder="Submit a film for &quot;${esc(night.theme)}&quot;" />
    <button class="mnb-btn mnb-btn-gold" id="entry-submit"><i data-icon="plus"></i></button>
  </div>
  <p class="mnb-mono" style="font-size:11px;color:var(--smoke);margin:0 0 10px;">${night.entries.length} submitted &middot; bracket needs ${night.bracketSize}</p>
  <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px;">
    ${night.entries.map((e) => `<div class="mnb-card" style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;">
      <div style="min-width:0;">
        <span class="entry-title" data-id="${e.id}" data-title="${esc(e.title)}" style="font-size:14px;${isOrganizer ? "cursor:pointer;border-bottom:1px dashed #4A4237;" : ""}">${esc(e.title)}</span>
        <span class="mnb-mono" style="font-size:11px;color:var(--smoke);margin-left:8px;">${esc(e.submittedBy)}</span>
      </div>
      ${isOrganizer ? `<button class="entry-delete" data-id="${e.id}" style="background:transparent;border:none;color:var(--smoke);cursor:pointer;padding:4px;flex-shrink:0;" title="Remove"><i data-icon="trash" style="font-size:14px;"></i></button>` : ""}
    </div>`).join("")}
  </div>
  ${isOrganizer
      ? `<button class="mnb-btn mnb-btn-velvet" id="lock-submissions" style="width:100%;" ${disableLock ? "disabled" : ""}><i data-icon="ticket"></i> Lock submissions${night.bracketSize !== 4 ? " and build bracket" : ""}</button>`
      : `<p style="font-size:12.5px;color:var(--smoke);">Waiting on ${esc(night.organizer)} to lock submissions once everyone's in.</p>`}
  `;
}

function matchupHtml(m) {
  const myVote = m.votes[state.identity.name];
  const resolved = !!m.winner;
  const votesA = Object.values(m.votes).filter((v) => v === "a").length;
  const votesB = Object.values(m.votes).filter((v) => v === "b").length;
  const isByeA = m.aTitle === "BYE", isByeB = m.bTitle === "BYE";
  const clickable = !resolved && !isByeA && !isByeB;
  const sideClass = (side, id) => {
    let cls = "mnb-side";
    if (myVote === side) cls += " mine";
    if (resolved) cls += m.winner === id ? " win" : " lose";
    return cls;
  };
  const winTag = `<span class="mnb-win-tag">Winner</span>`;
  return `<div class="mnb-ticket" data-matchup="${m.id}">
    <div style="display:flex;align-items:stretch;">
      <div class="${sideClass("a", m.aId)}" data-side="a" style="cursor:${clickable ? "pointer" : "default"};">
        <p style="margin:0;font-weight:600;font-size:14.5px;display:flex;align-items:center;gap:6px;flex-wrap:wrap;">${esc(m.aTitle)}${resolved && m.winner === m.aId ? winTag : ""}</p>
        <p class="mnb-mono" style="margin:4px 0 0;font-size:11px;color:var(--smoke);">${votesA} vote${votesA !== 1 ? "s" : ""}</p>
      </div>
      <div class="mnb-perf" style="display:flex;align-items:center;padding:0 6px;"><span class="mnb-mono" style="font-size:10px;color:var(--smoke);">vs</span></div>
      <div class="${sideClass("b", m.bId)}" data-side="b" style="cursor:${clickable ? "pointer" : "default"};">
        <p style="margin:0;font-weight:600;font-size:14.5px;text-align:right;display:flex;align-items:center;justify-content:flex-end;gap:6px;flex-wrap:wrap;">${resolved && m.winner === m.bId ? winTag : ""}${esc(m.bTitle)}</p>
        <p class="mnb-mono" style="margin:4px 0 0;font-size:11px;color:var(--smoke);text-align:right;">${votesB} vote${votesB !== 1 ? "s" : ""}</p>
      </div>
    </div>
  </div>`;
}

function bracketPhaseHtml(night, isOrganizer) {
  const round = night.rounds[night.currentRoundIndex];
  const allResolved = round.every((m) => m.winner);
  const anyTied = round.some((m) => m.tied);
  const anyVotesCast = round.some((m) => Object.keys(m.votes).length > 0 && !m.winner);
  let controls = "";
  if (isOrganizer) {
    if (!allResolved && !anyTied) controls = `<button class="mnb-btn mnb-btn-velvet" id="close-round" ${!anyVotesCast ? "disabled" : ""}><i data-icon="check"></i> Close round and tally votes</button>`;
    else if (anyTied) controls = `<button class="mnb-btn mnb-btn-gold" id="reshuffle-btn"><i data-icon="shuffle"></i> Reshuffle tied matchups</button>`;
    else if (allResolved) controls = `<button class="mnb-btn mnb-btn-velvet" id="advance-round"><i data-icon="arrow-right"></i> ${round.length === 4 ? "Advance to final four" : "Advance to next round"}</button>`;
  } else if (!allResolved) {
    controls = `<p style="font-size:12.5px;color:var(--smoke);">Vote above. ${esc(night.organizer)} will close the round once everyone's in.</p>`;
  }
  return `
  <p class="mnb-mono" style="font-size:12px;color:var(--marquee);letter-spacing:0.05em;margin:0 0 14px;">${roundLabel(round.length * 2).toUpperCase()}</p>
  <div style="display:flex;flex-direction:column;gap:16px;margin-bottom:20px;">${round.map(matchupHtml).join("")}</div>
  <div style="display:flex;flex-direction:column;gap:10px;">${controls}</div>
  `;
}

function finalFourPhaseHtml(night, isOrganizer) {
  const myBallot = night.finalFourVotes[state.identity.name] || [];
  if (state.finalFourPicks === null) state.finalFourPicks = [...myBallot];
  const picks = state.finalFourPicks;
  const votedCount = Object.keys(night.finalFourVotes).length;
  return `
  <p class="mnb-mono" style="font-size:12px;color:var(--marquee);letter-spacing:0.05em;margin:0 0 4px;">THE FINAL FOUR</p>
  <p style="font-size:13px;color:var(--smoke);margin:0 0 16px;">Check every film you'd be happy watching tonight. No need to pick just one.</p>
  <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px;">
    ${night.finalFour.map((m) => `<div class="mnb-card ff-pick" data-id="${m.id}" style="display:flex;align-items:center;gap:12px;cursor:pointer;border:1px solid ${picks.includes(m.id) ? "var(--marquee)" : "#3A332A"};">
      <div class="mnb-punch ${picks.includes(m.id) ? "on" : ""}">${picks.includes(m.id) ? '<i data-icon="check"></i>' : ""}</div>
      <p style="margin:0;font-weight:600;font-size:15px;">${esc(m.title)}</p>
    </div>`).join("")}
  </div>
  <button class="mnb-btn mnb-btn-gold" id="submit-ballot" style="width:100%;margin-bottom:16px;" ${picks.length === 0 ? "disabled" : ""}><i data-icon="ticket"></i> ${myBallot.length ? "Update my picks" : "Submit my picks"}</button>
  <p class="mnb-mono" style="font-size:11px;color:var(--smoke);margin:0 0 12px;">${votedCount} of ${state.roster.length} people have voted</p>
  ${isOrganizer ? `<button class="mnb-btn mnb-btn-velvet" id="reveal-results" style="width:100%;"><i data-icon="crown"></i> Reveal tonight's pick</button>` : ""}
  `;
}

function tiebreakerPhaseHtml(night, isOrganizer) {
  const tb = night.tiebreaker;
  const myVote = tb.votes[state.identity.name];
  const votedCount = Object.keys(tb.votes).length;
  let controls;
  if (isOrganizer) {
    controls = tb.tied
      ? `<button class="mnb-btn mnb-btn-gold" id="revote-tiebreaker"><i data-icon="shuffle"></i> Still tied \u2014 revote</button>`
      : `<button class="mnb-btn mnb-btn-velvet" id="close-tiebreaker"><i data-icon="check"></i> Close tiebreaker vote</button>`;
  } else {
    controls = `<p style="font-size:12.5px;color:var(--smoke);">Pick one below. ${esc(night.organizer)} will close voting once everyone's in.</p>`;
  }
  return `
  <p class="mnb-mono" style="font-size:12px;color:var(--marquee);letter-spacing:0.05em;margin:0 0 4px;">TIEBREAKER</p>
  <p style="font-size:13px;color:var(--smoke);margin:0 0 16px;">${tb.options.length} films tied for the win. Pick the one you want most tonight.${tb.tied ? " Still tied last round \u2014 vote again." : ""}</p>
  <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:16px;">
    ${tb.options.map((o) => {
      const count = Object.values(tb.votes).filter((v) => v === o.id).length;
      const mine = myVote === o.id;
      return `<div class="tb-pick mnb-card" data-id="${o.id}" style="display:flex;justify-content:space-between;align-items:center;gap:12px;cursor:pointer;border:1px solid ${mine ? "var(--marquee)" : "#3A332A"};${mine ? "box-shadow:inset 0 0 0 1.5px var(--marquee);" : ""}">
        <p style="margin:0;font-weight:600;font-size:15px;">${esc(o.title)}</p>
        <span class="mnb-mono" style="font-size:11px;color:var(--smoke);">${count} vote${count !== 1 ? "s" : ""}</span>
      </div>`;
    }).join("")}
  </div>
  <p class="mnb-mono" style="font-size:11px;color:var(--smoke);margin:0 0 12px;">${votedCount} of ${state.roster.length} people have voted</p>
  <div style="display:flex;flex-direction:column;gap:10px;">${controls}</div>
  `;
}

function resultsPhaseHtml(night) {
  let winners, subtitle;
  if (night.tiebreakerWinnerId) {
    winners = night.results.filter((r) => r.id === night.tiebreakerWinnerId);
    const tb = (night.tiebreakerTally || []).find((t) => t.id === night.tiebreakerWinnerId);
    subtitle = `Won a tiebreaker vote${tb ? ` (${tb.votes} of ${(night.tiebreakerTally || []).reduce((s, t) => s + t.votes, 0)})` : ""}`;
  } else {
    const top = night.results[0] ? night.results[0].votes : 0;
    winners = night.results.filter((r) => r.votes === top);
    subtitle = `${top} of the room would watch it${winners.length > 1 ? " (tie)" : ""}`;
  }
  return `
  <p class="mnb-mono" style="font-size:12px;color:var(--marquee);letter-spacing:0.05em;margin:0 0 14px;">TONIGHT'S PICK</p>
  <div class="mnb-card" style="text-align:center;padding:26px 18px;margin-bottom:18px;border:1px solid var(--marquee);">
    <i data-icon="award" style="font-size:26px;color:var(--marquee);"></i>
    <h2 class="mnb-display" style="font-size:24px;margin:10px 0 4px;color:var(--paper);">${esc(winners.map((w) => w.title).join(" & "))}</h2>
    <p class="mnb-mono" style="margin:0;font-size:12px;color:var(--smoke);">${esc(subtitle)}</p>
  </div>
  <p class="mnb-mono" style="font-size:11px;color:var(--smoke);margin:0 0 10px;">FULL RESULTS</p>
  <div style="display:flex;flex-direction:column;gap:8px;">
    ${night.results.map((r, i) => `<div class="mnb-card" style="display:flex;justify-content:space-between;padding:10px 14px;">
      <span style="font-size:14px;">${i + 1}. ${esc(r.title)}${night.tiebreakerWinnerId === r.id ? ` <span class="mnb-mono" style="color:var(--marquee);font-size:10px;">(tiebreaker winner)</span>` : ""}</span>
      <span class="mnb-mono" style="font-size:12px;color:var(--marquee);">${r.votes} votes</span>
    </div>`).join("")}
  </div>`;
}

function organizerTransferHtml(night) {
  if (!state.organizerTransferOpen) {
    return `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #3A332A;">
      <button class="mnb-btn mnb-btn-ghost" id="open-transfer" style="font-size:12px;"><i data-icon="users"></i> Hand off organizer duties</button>
    </div>`;
  }
  const others = state.roster.filter((r) => r !== state.identity.name);
  return `<div style="margin-top:24px;padding-top:16px;border-top:1px solid #3A332A;display:flex;gap:8px;align-items:center;">
    <select class="mnb-select" id="transfer-select">${others.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join("")}</select>
    <button class="mnb-btn mnb-btn-gold" id="confirm-transfer">Make organizer</button>
    <button class="mnb-btn mnb-btn-ghost" id="cancel-transfer"><i data-icon="x"></i></button>
  </div>`;
}

function bindNightEvents() {
  document.getElementById("back-home").addEventListener("click", goHome);
  document.getElementById("logout-btn").addEventListener("click", logout);
  const night = state.night;

  if (night.phase === "submitting") {
    const submit = () => {
      const input = document.getElementById("entry-title");
      const title = input.value.trim();
      if (!title) return;
      submitEntry(title);
    };
    document.getElementById("entry-submit").addEventListener("click", submit);
    document.getElementById("entry-title").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
    const lockBtn = document.getElementById("lock-submissions");
    if (lockBtn) lockBtn.addEventListener("click", lockSubmissions);
    document.querySelectorAll(".entry-delete").forEach((btn) => btn.addEventListener("click", () => removeEntry(btn.dataset.id)));
    document.querySelectorAll(".entry-title").forEach((el) => {
      if (!el.style.cursor) return; // only editable when organizer (cursor set inline)
      el.addEventListener("click", () => {
        const next = prompt("Edit title", el.dataset.title);
        if (next && next.trim() && next.trim() !== el.dataset.title) editEntry(el.dataset.id, next.trim());
      });
    });
  }

  if (night.phase === "bracket") {
    document.querySelectorAll(".mnb-side").forEach((el) => {
      if (el.style.cursor === "pointer") {
        el.addEventListener("click", () => {
          const matchupId = el.closest(".mnb-ticket").dataset.matchup;
          castVote(matchupId, el.dataset.side);
        });
      }
    });
    const closeBtn = document.getElementById("close-round");
    if (closeBtn) closeBtn.addEventListener("click", closeRound);
    const reshuffleBtn = document.getElementById("reshuffle-btn");
    if (reshuffleBtn) reshuffleBtn.addEventListener("click", doReshuffle);
    const advanceBtn = document.getElementById("advance-round");
    if (advanceBtn) advanceBtn.addEventListener("click", advanceRound);
  }

  if (night.phase === "final-four") {
    document.querySelectorAll(".ff-pick").forEach((el) => el.addEventListener("click", () => {
      const id = el.dataset.id;
      const idx = state.finalFourPicks.indexOf(id);
      if (idx === -1) state.finalFourPicks.push(id); else state.finalFourPicks.splice(idx, 1);
      render();
    }));
    const submitBtn = document.getElementById("submit-ballot");
    if (submitBtn) submitBtn.addEventListener("click", () => submitFinalFourBallot([...state.finalFourPicks]));
    const revealBtn = document.getElementById("reveal-results");
    if (revealBtn) revealBtn.addEventListener("click", revealResults);
  }

  if (night.phase === "tiebreaker") {
    document.querySelectorAll(".tb-pick").forEach((el) => el.addEventListener("click", () => castTiebreakerVote(el.dataset.id)));
    const closeBtn = document.getElementById("close-tiebreaker");
    if (closeBtn) closeBtn.addEventListener("click", closeTiebreaker);
    const revoteBtn = document.getElementById("revote-tiebreaker");
    if (revoteBtn) revoteBtn.addEventListener("click", revoteTiebreaker);
  }

  const openTransfer = document.getElementById("open-transfer");
  if (openTransfer) openTransfer.addEventListener("click", () => setState({ organizerTransferOpen: true }));
  const cancelTransfer = document.getElementById("cancel-transfer");
  if (cancelTransfer) cancelTransfer.addEventListener("click", () => setState({ organizerTransferOpen: false }));
  const confirmTransfer = document.getElementById("confirm-transfer");
  if (confirmTransfer) confirmTransfer.addEventListener("click", () => transferOrganizer(document.getElementById("transfer-select").value));
}

document.addEventListener("DOMContentLoaded", () => {
  boot();
});
