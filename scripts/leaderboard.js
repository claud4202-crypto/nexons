/* ============================================================
   HEXON BETA — Online leaderboards
   ============================================================
   The board is hosted in a public JSONBlob bin and polled every
   60 seconds while the player is in the app. When the player
   finishes a run we push their best score back to the bin so
   the rest of the network can see it the next time they refresh.

   Network failures are silent: if the device is offline we just
   show the local "me" row and a small "no internet" hint.
   Nothing in this module ever produces synthetic players any
   more — the previous fake leaderboard generator has been
   removed entirely.
   ============================================================ */
"use strict";

/* JSONBlob bin used as the shared scoreboard.
   Created with `POST https://jsonblob.com/api/jsonBlob` returning
   { version, updatedAt, entries: [] }.  The bin allows anonymous
   GET / PUT so no API key is required from the client. */
const LB_BLOB_ID    = "019e3032-3649-7bb6-8acb-de8e5696e8c2";
const LB_BLOB_URL   = "https://jsonblob.com/api/jsonBlob/" + LB_BLOB_ID;
const LB_REFRESH_MS = 60_000;   // poll cadence (the user asked for 1m)
const LB_TIMEOUT_MS = 8_000;    // give up on a slow request
const LB_MAX_ENTRIES = 100;     // cap to keep the bin small

/* In-memory cache so repeated renders don't re-fetch. */
const lbCache = { entries: [], updatedAt: 0, online: false, error: null, lastFetchAt: 0 };
let   lbTimer = null;

async function _lbFetchJSON(url, init){
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), LB_TIMEOUT_MS);
  try {
    const res = await fetch(url, Object.assign({ signal: ctrl.signal, cache: "no-store" }, init || {}));
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(tm);
  }
}

/* Parse the bin and normalise into [{name,id,score,at}]. We accept
   both the v1 schema (object with .entries) and a bare-array
   schema (older bins) so the code keeps working if the bin is
   manually edited. */
function _lbParseRemote(data){
  let entries;
  if (data && Array.isArray(data.entries))      entries = data.entries;
  else if (Array.isArray(data))                  entries = data;
  else                                            entries = [];
  return entries
    .filter(e => e && typeof e === "object")
    .map(e => ({
      name:  String(e.name || "").slice(0, 24),
      id:    String(e.id   || ""),
      score: Math.max(0, Math.floor(Number(e.score) || 0)),
      at:    Number(e.at)  || 0,
    }))
    .filter(e => e.id && e.score > 0);
}

/* Merge the remote list with the local "me" record so the
   current player is always shown even before the first POST
   round-trips. The remote copy of "me" wins if it has a higher
   score (e.g. the player set a record on another device). */
function _lbMergeMe(remote){
  const out = (remote || []).map(e => Object.assign({}, e, { me: e.id === state.profile.id }));
  const myId    = state.profile.id;
  const myScore = state.stats.best || 0;
  const myName  = state.profile.nickname || "";
  if (myId && myScore > 0){
    const idx = out.findIndex(e => e.id === myId);
    if (idx < 0){
      out.push({ name: myName || "—", id: myId, score: myScore, at: Date.now(), me: true });
    } else if (out[idx].score < myScore){
      out[idx] = { name: myName || out[idx].name, id: myId, score: myScore, at: Date.now(), me: true };
    }
  }
  out.sort((a, b) => (b.score | 0) - (a.score | 0));
  return out;
}

/* GET — refresh the cache from the server. Called by the polling
   timer and by renderLeaderboards() on first paint. */
async function fetchLeaderboard(){
  lbCache.lastFetchAt = Date.now();
  try {
    const data = await _lbFetchJSON(LB_BLOB_URL, { method: "GET", headers: { "Accept": "application/json" } });
    const parsed = _lbParseRemote(data);
    parsed.sort((a, b) => (b.score | 0) - (a.score | 0));
    lbCache.entries  = parsed.slice(0, LB_MAX_ENTRIES);
    lbCache.updatedAt = data && data.updatedAt ? Number(data.updatedAt) : Date.now();
    lbCache.online   = true;
    lbCache.error    = null;
  } catch (e) {
    lbCache.online = false;
    lbCache.error  = String((e && e.message) || e);
  }
  /* Keep state.leaderboards in sync so other modules (e.g. the
     menu badge) read the latest list. */
  state.leaderboards = _lbMergeMe(lbCache.entries);
  if (typeof currentScreen !== "undefined" && currentScreen === "leaderboards"){
    _lbPaint(); // repaint live without scrolling
  }
}

/* PUT — push the player's best score into the shared bin. We
   read-modify-write because the bin has no server-side merge.
   This is racy across players but for a casual game leaderboard
   that's acceptable. */
async function submitLeaderboardScore(){
  const myId   = state.profile && state.profile.id;
  const myName = state.profile && state.profile.nickname;
  const myBest = (state.stats && state.stats.best) || 0;
  if (!myId || !myName || myBest <= 0) return;
  try {
    const data    = await _lbFetchJSON(LB_BLOB_URL, { method: "GET" });
    const entries = _lbParseRemote(data);
    const idx     = entries.findIndex(e => e.id === myId);
    const mine    = { name: myName.slice(0, 24), id: myId, score: myBest, at: Date.now() };
    if (idx < 0)                            entries.push(mine);
    else if (entries[idx].score < myBest)    entries[idx] = mine;
    else                                    return; // nothing new to write
    entries.sort((a, b) => (b.score | 0) - (a.score | 0));
    const body = { version: 1, updatedAt: Date.now(), entries: entries.slice(0, LB_MAX_ENTRIES) };
    await _lbFetchJSON(LB_BLOB_URL, {
      method:  "PUT",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });
    lbCache.entries    = body.entries;
    lbCache.updatedAt  = body.updatedAt;
    lbCache.online     = true;
    state.leaderboards = _lbMergeMe(lbCache.entries);
  } catch {
    /* silent — we'll retry on the next 60s tick or game-over */
  }
}

/* Hook called from game.js when a run finishes. Fire-and-forget
   submit + immediate local merge so the user sees their fresh
   record without waiting for the next poll. */
function updateLeaderboardsForMe(){
  state.leaderboards = _lbMergeMe(lbCache.entries);
  if (typeof navigator === "undefined" || navigator.onLine !== false){
    submitLeaderboardScore();
  }
}

function ensureLeaderboards(){
  state.leaderboards = _lbMergeMe(lbCache.entries);
}

/* Painter — split out of renderLeaderboards so fetchLeaderboard()
   can repaint without going through the i18n re-render. */
function _lbPaint(){
  const tbl = $("#lb-table");
  if (!tbl) return;
  tbl.innerHTML = "";
  const headers = [
    { k: "lb.rank",  cls: "" },
    { k: "lb.name",  cls: "" },
    { k: "lb.id",    cls: "col-id" },
    { k: "lb.score", cls: "" },
  ];
  headers.forEach(h => {
    const hd = document.createElement("div");
    hd.className   = "hd " + h.cls;
    hd.textContent = t(h.k);
    tbl.appendChild(hd);
  });
  const list = state.leaderboards || [];
  if (list.length === 0){
    const empty = document.createElement("div");
    empty.style.gridColumn = "1 / -1";
    empty.style.padding    = "22px";
    empty.style.textAlign  = "center";
    empty.style.color      = "var(--fg-dim)";
    empty.textContent = lbCache.online === false
      ? (t("lb.offline") || "Немає інтернету — рекорди недоступні")
      : (t("lb.empty")   || "Ще немає жодного рекорду");
    tbl.appendChild(empty);
    return;
  }
  list.slice(0, 50).forEach((row, i) => {
    const me = row.me;
    const rk = document.createElement("div");
    rk.className   = "rk" + (me ? " me" : "");
    rk.textContent = "#" + (i + 1);
    const nm = document.createElement("div");
    nm.className   = (me ? "me" : "");
    nm.textContent = (me ? "[" + (t("common.you") || "you") + "] " : "") + (row.name || "—");
    const id = document.createElement("div");
    id.className   = "col-id " + (me ? "me" : "");
    id.style.fontFamily = "'JetBrains Mono', monospace";
    id.style.fontSize   = "12px";
    id.style.color      = "var(--fg-dim)";
    id.textContent = row.id || "—";
    const sc = document.createElement("div");
    sc.className   = "sc" + (me ? " me" : "");
    sc.textContent = (row.score || 0).toLocaleString();
    tbl.appendChild(rk);
    tbl.appendChild(nm);
    tbl.appendChild(id);
    tbl.appendChild(sc);
  });
}

function renderLeaderboards(){
  ensureLeaderboards();
  _lbPaint();
  /* If the cache is older than the refresh interval, kick a
     background fetch so the table self-heals when the user
     opens the screen after a long pause. */
  if (Date.now() - lbCache.lastFetchAt > LB_REFRESH_MS / 2){
    fetchLeaderboard();
  }
}

/* Start / stop the polling timer. Called from enterApp() once
   the user is logged in. */
function startLeaderboardPolling(){
  if (lbTimer) clearInterval(lbTimer);
  fetchLeaderboard();
  lbTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.hidden) return;
    fetchLeaderboard();
  }, LB_REFRESH_MS);
}
function stopLeaderboardPolling(){
  if (lbTimer){ clearInterval(lbTimer); lbTimer = null; }
}

