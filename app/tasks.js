// @ts-check
// Tableau du groupe et voie rapide (GLOSSARY.md « Tâche de groupe », « Tableau du groupe » ; revu le 2026-11-16).
// Les tâches vivent dans le plugin bot-groups (plugin.bot-groups.tasks.*) : le meneur inscrit les demandes de Yoan
// (un message n'en crée plus à l'envoi), elles se ferment seules à la fin de leur discussion. Ici : le bouton du haut
// avec le nombre de tâches ouvertes et le kanban (à faire, en cours, bloquée, faite ; une colonne par écran sur
// téléphone), filtre par bot, archives des faites de plus de 7 jours, lien vers le message, fil du bot au travail.
// Voie rapide : un message qui cite un membre libre pendant qu'une discussion occupe le groupe part tout de
// suite chez ce membre (plugin.bot-groups.side.send) au lieu d'attendre la fin de la discussion.

import { avatarHtml } from './avatars.js';
import { userEventId } from './groups.js';
import { addBubble } from './render.js';
import { botLabel, memberName } from './roster.js';
import { state } from './state.js';
import { openTraceFor, runningTraces } from './trace.js';
import { $, asText, esc, log, report } from './util.js';

const COLS = /** @type {const} */ (['todo', 'doing', 'blocked', 'done']);
const TASK_LABEL = { todo: 'À faire', doing: 'En cours', blocked: 'Bloquée', done: 'Faite' };
const ARCHIVE_MS = 7 * 864e5;
let tasksRpc = true, sideRpc = true, inboxRpc = true;
let filter = '', showArchive = false, openCard = '', dragId = '';
const rpcMissing = (e) => /method|not found|unknown|introuvable/i.test(e?.message || '');

export async function pollTasks(g) {
  if (!tasksRpc) { $('#group-tasks').hidden = true; return; }
  try {
    g.tasks = (await state.roster.call('plugin.bot-groups.tasks.list', { room_id: g.room.room_id }, 8000))?.tasks || [];
  } catch (e) { if (rpcMissing(e)) tasksRpc = false; return; }
  if (state.group !== g) return;
  const open = g.tasks.filter((t) => t.status !== 'done').length;
  $('#group-tasks').hidden = false;
  $('#gt-n').textContent = open ? String(open) : '';
  $('#gt-n').hidden = !open;
  if ($('#tasks-dlg').open) renderTasks(g);
}

const memberOf = (g, id) => id && g.room.members.find((m) => [m.member_id, m.profile, m.handle].includes(id));
const nameOf = (g, id) => { const m = memberOf(g, id); return m ? memberName(m) : botLabel(id) || id; };
function ago(sec) {
  const s = Math.max(0, Date.now() / 1000 - (sec || 0));
  if (s < 60) return 'à l’instant';
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return 'hier';
  return new Date(sec * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}
// Le bot de la tâche travaille-t-il en ce moment ? (tour du moteur, table ronde ou fil en cours)
function working(g, t) {
  const m = memberOf(g, t.owner); if (!m || t.status === 'done') return false;
  const ids = [m.member_id, m.profile];
  return (g.driver?.member_activity || []).some((a) => ids.includes(a.member_id) && ['running', 'stopping'].includes(a.status))
    || (g.dispatch || []).some((j) => ids.includes(j.bot)) || runningTraces(g, m.member_id).length > 0;
}

function card(g, t, byId) {
  const el = document.createElement('div');
  el.className = 'kb-card ' + t.status + (openCard === t.id ? ' open' : ''); el.dataset.id = t.id; el.draggable = true;
  const kids = (g.tasks || []).filter((x) => x.parent === t.id);
  const live = working(g, t);
  const parent = t.parent && byId.get(t.parent);
  const who = t.owner && t.owner !== 'yoan' && t.owner !== 'auto'
    ? `<span class="kb-who">${avatarHtml(t.owner, 18)}<span>${esc(nameOf(g, t.owner))}</span></span>` : '';
  const extra = t.status === 'done' && t.proof ? `<div class="kb-x">${esc(t.proof)}</div>`
    : t.status === 'blocked' && t.note ? `<div class="kb-x warn">${esc(t.note)}</div>` : t.note ? `<div class="kb-x">${esc(t.note)}</div>` : '';
  const msgs = [...(t.messages || []), ...(t.source && !(t.messages || []).includes(t.source) ? [t.source] : [])];
  el.innerHTML = `${parent ? `<div class="kb-parent">↳ ${esc(parent.title)}</div>` : ''}
    <div class="kb-t">${esc(t.title)}</div>
    <div class="kb-m">${who}${live ? '<span class="kb-live">travaille</span>' : ''}${kids.length ? `<span>${kids.filter((x) => x.status === 'done').length}/${kids.length} sous-tâches</span>` : ''}
      <span title="créée ${ago(t.created)}">${t.status === 'done' ? 'faite ' : ''}${ago(t.status === 'done' ? t.updated : t.created)}</span></div>
    ${extra}
    <div class="kb-acts">
      <div class="kb-move">${COLS.filter((c) => c !== t.status).map((c) => `<button type="button" class="pill s g" data-to="${c}">${TASK_LABEL[c]}</button>`).join('')}</div>
      <div class="kb-links">
        ${msgs.length ? `<button type="button" class="kb-link" data-act="msg">Voir le message${msgs.length > 1 ? `s (${msgs.length})` : ''}</button>` : ''}
        ${memberOf(g, t.owner) ? `<button type="button" class="kb-link" data-act="fil">${live ? 'Suivre son travail' : 'Voir son fil'}</button>` : ''}
        <button type="button" class="kb-link danger" data-act="del">Supprimer</button>
      </div>
    </div>`;
  el.onclick = (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button');
    if (!b) { openCard = openCard === t.id ? '' : t.id; renderTasks(g); return; }
    if (b.dataset.to) taskSet(g, t, { status: b.dataset.to });
    else if (b.dataset.act === 'msg') gotoMessage(msgs);
    else if (b.dataset.act === 'fil') { const m = memberOf(g, t.owner); if (m) { $('#tasks-dlg').close(); openTraceFor(g, m.member_id); } }
    else if (b.dataset.act === 'del') taskRemove(g, t);
  };
  el.ondragstart = (e) => { dragId = t.id; e.dataTransfer?.setData('text/plain', t.id); el.classList.add('drag'); };
  el.ondragend = () => { dragId = ''; el.classList.remove('drag'); };
  return el;
}

function gotoMessage(ids) {
  const b = ids.map((id) => log().querySelector(`.bubble[data-eid="${CSS.escape(id)}"]`)).filter(Boolean).pop();
  if (!b) { $('#tk-msg').textContent = 'Ce message n’est plus dans l’historique chargé du groupe.'; return; }
  $('#tasks-dlg').close();
  b.scrollIntoView({ block: 'center', behavior: 'smooth' });
  b.classList.remove('hl'); void b.offsetWidth; b.classList.add('hl');
}

function renderTasks(g) {
  const tasks = g.tasks || [], byId = new Map(tasks.map((t) => [t.id, t]));
  // filtre par bot : les bots qui ont au moins une tâche
  const owners = [...new Set(tasks.map((t) => t.owner).filter((o) => o && o !== 'yoan' && o !== 'auto'))];
  if (filter && !owners.includes(filter)) filter = '';
  const fl = $('#tk-filter');
  fl.hidden = owners.length < 2;
  fl.innerHTML = [['', 'Tous'], ...owners.map((o) => [o, nameOf(g, o)])]
    .map(([v, l]) => `<button type="button" class="kb-chip${filter === v ? ' on' : ''}" data-v="${esc(v)}">${esc(l)}</button>`).join('');
  fl.onclick = (e) => { const b = /** @type {HTMLElement} */ (e.target).closest('button'); if (b) { filter = b.dataset.v || ''; renderTasks(g); } };
  const shown = tasks.filter((t) => !filter || t.owner === filter);
  const now = Date.now() / 1000;
  const board = $('#tk-list'); const keepX = board.querySelector('.kb')?.scrollLeft || 0;
  board.innerHTML = '';
  const kb = document.createElement('div'); kb.className = 'kb';
  for (const c of COLS) {
    let items = shown.filter((t) => t.status === c);
    const old = c === 'done' ? items.filter((t) => now - t.updated > ARCHIVE_MS / 1000) : [];
    if (c === 'done' && !showArchive) items = items.filter((t) => !old.includes(t));
    items.sort((a, b) => c === 'done' ? b.updated - a.updated : a.created - b.created);
    const col = document.createElement('section'); col.className = 'kb-col ' + c; col.dataset.col = c;
    col.innerHTML = `<h3 class="kb-h"><span>${TASK_LABEL[c]}</span><span class="kb-n">${items.length}</span></h3>`;
    const list = document.createElement('div'); list.className = 'kb-items';
    for (const t of items) list.appendChild(card(g, t, byId));
    if (!items.length) list.innerHTML = `<p class="kb-empty">${c === 'todo' && !tasks.length ? 'Le meneur inscrit ici tes demandes de travail.' : 'Rien ici.'}</p>`;
    col.appendChild(list);
    if (old.length) {
      const a = document.createElement('button'); a.type = 'button'; a.className = 'kb-link kb-arch';
      a.textContent = showArchive ? 'Masquer les archives' : `Archives (${old.length})`;
      a.onclick = () => { showArchive = !showArchive; renderTasks(g); };
      col.appendChild(a);
    }
    col.ondragover = (e) => { if (dragId) { e.preventDefault(); col.classList.add('over'); } };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = (e) => { e.preventDefault(); col.classList.remove('over'); const t = byId.get(dragId); if (t && t.status !== c) taskSet(g, t, { status: c }); };
    kb.appendChild(col);
  }
  // onglets (téléphone) : une colonne par écran, les onglets disent où l'on est et combien il y a ailleurs
  const tabs = document.createElement('div'); tabs.className = 'kb-tabs';
  tabs.innerHTML = COLS.map((c) => `<button type="button" data-col="${c}">${TASK_LABEL[c]} <span>${kb.querySelector(`.kb-col.${c} .kb-n`)?.textContent || 0}</span></button>`).join('');
  const syncTabs = () => {
    const i = Math.round(kb.scrollLeft / Math.max(1, /** @type {HTMLElement} */ (kb.firstElementChild).offsetWidth + 12));
    tabs.querySelectorAll('button').forEach((b, j) => b.classList.toggle('on', j === Math.min(i, COLS.length - 1)));
  };
  tabs.onclick = (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('button'); if (!b) return;
    const col = /** @type {HTMLElement} */ (kb.querySelector(`.kb-col.${b.dataset.col}`));
    kb.scrollTo({ left: col.offsetLeft - kb.offsetLeft, behavior: 'smooth' });
  };
  kb.onscroll = syncTabs;
  board.appendChild(tabs); board.appendChild(kb); kb.scrollLeft = keepX; syncTabs();
  const open = tasks.filter((t) => t.status !== 'done').length;
  $('#tk-sub').textContent = `${open} ouverte${open > 1 ? 's' : ''} · ${tasks.length - open} faite${tasks.length - open > 1 ? 's' : ''}`;
}

async function taskCall(g, verb, params) {
  try { await state.roster.call('plugin.bot-groups.tasks.' + verb, { room_id: g.room.room_id, ...params }, 15000); }
  catch (e) { $('#tk-msg').textContent = 'Échec : ' + (e.message || e); report('error', 'tasks.' + verb + ' ' + (e.message || e), 'tasks.js'); }
  await pollTasks(g); renderTasks(g);
}
const taskSet = (g, t, p) => { if (p.status) openCard = ''; return taskCall(g, 'update', { id: t.id, ...p }); };
function taskRemove(g, t) {
  const kids = (g.tasks || []).some((x) => x.parent === t.id);
  if (confirm(`Supprimer « ${t.title.slice(0, 60)} »${kids ? ' et ses sous-tâches' : ''} ?`)) { openCard = ''; taskCall(g, 'remove', { id: t.id }); }
}
async function addTaskFromInput() {
  const g = state.group, v = $('#tk-new').value.trim(); if (!g || !v) return;
  $('#tk-new').value = ''; $('#tk-msg').textContent = '';
  await taskCall(g, 'add', { title: v });
}
function openTasks() {
  const g = state.group; if (!g) return;
  $('#tk-msg').textContent = ''; openCard = '';
  renderTasks(g); $('#tasks-dlg').showModal(); pollTasks(g);
  // téléphone : on arrive sur la colonne « En cours » s'il y en a, sinon « À faire »
  const kb = /** @type {HTMLElement | null} */ ($('#tk-list').querySelector('.kb'));
  const doing = /** @type {HTMLElement | null} */ (kb?.querySelector('.kb-col.doing'));
  if (kb && doing && (g.tasks || []).some((t) => t.status === 'doing') && kb.scrollWidth > kb.clientWidth) kb.scrollLeft = doing.offsetLeft - kb.offsetLeft;
}

// ---------- voie rapide ----------
// Les membres cités, s'ils sont tous libres et autres que le meneur : quand le groupe travaille déjà, ou dès que
// le message cite au moins deux bots (le moteur les ferait parler l'un après l'autre ; exigé le 2026-11-15).
export function fastLaneMembers(g, text) {
  const ctx = g.context || {};
  if (!sideRpc || ctx.routing !== 'lead' || !ctx.lead_member_id) return null;
  const cited = [...text.matchAll(/@([\w.:-]+)/g)].map((m) => m[1].toLowerCase());
  const ms = [...new Set(cited)].map((h) => g.room.members.find((m) => (m.handle || '').toLowerCase() === h)).filter(Boolean);
  if (!ms.length) return null;
  const working = new Set((g.driver?.member_activity || []).map((a) => a.member_id));
  for (const j of g.dispatch || []) { const m = g.room.members.find((x) => [x.profile, x.member_id].includes(j.bot)); if (m) working.add(m.member_id); }
  if (ms.some((m) => m.member_id === ctx.lead_member_id || working.has(m.member_id))) return null;
  return g.busy || ms.length > 1 ? ms : null;
}
export async function sendFastLane(g, text, sideId, ms) {
  try {
    await state.roster.call('plugin.bot-groups.side.send', { room_id: g.room.room_id, text, members: ms.map((m) => m.handle), side_id: sideId }, 30000);
    return true;
  } catch (e) {
    if (rpcMissing(e)) sideRpc = false;
    return false; // refus (membre occupé, pas de meneur…) : le message part dans la file normale
  }
}

// ---------- messages en attente ----------
// Un message envoyé pendant une discussion est gardé par le plugin (plugin.bot-groups.inbox.send) : le bot qui
// écrit finit son tour, puis le message entre dans le groupe avant toute relance et le meneur le lit avec les
// autres messages en attente (décidé le 2026-11-16, GLOSSARY.md « Message en attente »). Faux = envoi normal.
export async function sendHeld(g, eventId, text) {
  if (!inboxRpc || !g.busy) return false;
  try {
    await state.roster.call('plugin.bot-groups.inbox.send', { room_id: g.room.room_id, event_id: eventId, payload: { text, thread_id: eventId } }, 30000);
    return true;
  } catch (e) { if (rpcMissing(e)) { inboxRpc = false; return false; } throw e; }
}
// Après un rechargement : les messages encore gardés par le plugin reviennent en bulles (une fois par ouverture).
export async function heldBubbles(g) {
  if (!inboxRpc || g.heldLoaded) return;
  g.heldLoaded = true;
  let held = [];
  try { held = (await state.roster.call('plugin.bot-groups.inbox.status', { room_id: g.room.room_id }, 8000))?.held || []; }
  catch (e) { if (rpcMissing(e)) inboxRpc = false; return; }
  for (const h of held) {
    const eid = await userEventId(h.event_id);
    if (state.group !== g || log().querySelector(`[data-eid="${CSS.escape(eid)}"]`)) continue;
    const b = addBubble('user', h.text); b.classList.add('pending', 'held'); b.dataset.eid = eid; b.dataset.text = h.text;
  }
  markQueued(g);
}

// Ce que la bulle attend : le bot qui écrit en ce moment, sinon la discussion en cours.
function waitLabel(g) {
  const a = (g.driver?.member_activity || []).find((x) => x.status === 'running' || x.status === 'stopping');
  const m = a && g.room.members.find((x) => x.member_id === a.member_id);
  return m ? memberName(m) + ' finit son tour' : 'la discussion en cours se termine';
}

// Messages de Yoan qui attendent leur tour : gardés par le plugin (pas encore dans le groupe), ou, d'un ancien
// client, déjà dans le groupe sans qu'aucun événement du moteur ne les cite. Affichés en pointillés avec ce
// qu'ils attendent.
export function markQueued(g) {
  const evs = g.events || [];
  const stopAt = Math.max(0, ...evs.filter((e) => e.kind === 'room.stop_requested').map((e) => e.seq || 0));
  // Une discussion se ferme par son room.activity (settled ou bounded) ou par un arrêt. Le moteur n'en mène qu'une
  // à la fois, dans l'ordre : la plus ancienne encore ouverte est EN COURS (on y répond), seules les suivantes
  // attendent. L'ancienne règle (« pas encore de discussion_event_id ») marquait en attente le message auquel le
  // meneur répondait déjà (« go » après un arrêt, vu le 2026-11-16 ; GLOSSARY.md « Message en attente »).
  const closed = new Set(evs.filter((e) => e.kind === 'room.activity').map((e) => e.payload?.discussion_event_id).filter(Boolean));
  const inRoom = new Set(evs.map((e) => e.event_id));
  const lastInThread = new Map();
  for (const e of evs) if (e.kind === 'message.user') lastInThread.set(e.payload?.thread_id, e.event_id);
  const open = evs.filter((e) => e.kind === 'message.user' && (e.seq || 0) > stopAt && !closed.has(e.event_id)
    && lastInThread.get(e.payload?.thread_id) === e.event_id).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const waiting = new Set();
  if (g.busy) for (const e of open.slice(1)) if (!/^\[[\w.-]+\] /.test(asText(e.payload?.text))) waiting.add(e.event_id);
  const side = new Set((g.dispatch || []).filter((j) => j.kind === 'side').map((j) => j.side_id));
  const wait = waitLabel(g);
  for (const b of log().querySelectorAll('.row.user .bubble[data-eid]')) {
    if (b.classList.contains('held') && inRoom.has(b.dataset.eid)) b.classList.remove('held', 'pending');
    const q = waiting.has(b.dataset.eid) || b.classList.contains('held');
    const row = b.closest('.row');
    b.classList.toggle('queued', q);
    row?.classList.toggle('in-queue', q);
    if (q) b.dataset.wait = wait; else delete b.dataset.wait; // lu par le ::after de la bulle
    row?.classList.toggle('in-side', !!b.dataset.side && side.has(b.dataset.side));
  }
}

// Après un rechargement, un message en voie rapide pas encore posté revient depuis le plugin (dispatch.status).
export async function sideBubbles(g) {
  for (const j of (g.dispatch || []).filter((x) => x.kind === 'side' && x.question)) {
    if (log().querySelector(`[data-side="${CSS.escape(j.side_id)}"]`)) continue;
    const eid = await userEventId(j.side_id);
    if (state.group !== g || log().querySelector(`[data-eid="${CSS.escape(eid)}"]`)) continue;
    const b = addBubble('user', j.question); b.classList.add('pending'); b.dataset.side = j.side_id; b.dataset.eid = eid; b.dataset.text = j.question;
    markQueued(g);
  }
}

$('#group-tasks').addEventListener('click', openTasks);
$('#tk-close').addEventListener('click', () => $('#tasks-dlg').close());
$('#tk-add').addEventListener('click', addTaskFromInput);
$('#tk-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTaskFromInput(); } });
