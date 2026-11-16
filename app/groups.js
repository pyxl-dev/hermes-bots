// @ts-check
// Gateway-owned group chats (contract: hermes-agent apps/desktop/docs/canonical-groups.md,
// tui_gateway/contracts/groups_bot_relay.py). The gateway owns the log and runs the turns;
// this client polls groups.state + groups.log every 2 s while a room is open, offers a
// control only when groups.capabilities lists its method, and never runs a round itself.

import { DOTS, avatarHtml, avatarOf, groupAvatarHtml, mascot } from './avatars.js';
import { lead } from './blocks.js';
import { chatLook, closeChat, resetLook } from './chat.js';
import { updateSendBtn } from './composer.js';
import { closeTrace, pollTraces } from './trace.js';
import { AuthError, LOGIN_URL } from './gateway.js';
import { pinGuard, show } from './nav.js';
import { isPinned, togglePin } from './prefs.js';
import { addBubble, addNote, addRow, fold, md, quiet, scrollDown } from './render.js';
import { clearReply, replyPrefix } from './reply.js';
import { actClass, actLine, botLabel, botName, isHidden, loadRoster, markMentionsSeen, meBadge, memberName, renderPins } from './roster.js';
import { restoreDraft, restorePos, saveDraft } from './scroll.js';
import { notify } from './settings.js';
import { activity, seen, state, ui } from './state.js';
import { idb, store } from './store.js';
import { fastLaneMembers, heldBubbles, markQueued, pollTasks, sendFastLane, sendHeld, sideBubbles } from './tasks.js';
import { $, asText, esc, isSilent, log, report, toMs, when } from './util.js';

const GROUP_POLL_MS = 2000;
const groupCaps = { socket: null, value: null, error: null };
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
export const can = (m) => !!groupCaps.value?.methods?.includes(m);
const homeProfile = () => state.bots.find((b) => b.is_default)?.name || 'default';
export const gparams = (o) => ({ profile: homeProfile(), ...o });

// ---------- capabilities + list ----------
async function groupCapabilities() {
  const gw = state.roster;
  if (groupCaps.socket === gw && (groupCaps.value || groupCaps.error)) return groupCaps.value;
  groupCaps.socket = gw; groupCaps.value = null; groupCaps.error = null;
  try {
    const v = await gw.call('groups.capabilities', gparams({}), 15000);
    if (v && v.driver === true) groupCaps.value = v;
    else groupCaps.error = 'Le moteur de groupes de Hermes ne tourne pas : redémarre ou mets à jour Hermes.';
  } catch (e) {
    groupCaps.error = e.code === -32601 ? 'Ce Hermes est trop ancien pour les groupes.' : 'Groupes injoignables : ' + e.message;
    if (e.code !== -32601) groupCaps.socket = null; // retry next poll
  }
  return groupCaps.value;
}

export async function loadGroups() {
  try {
    const caps = await groupCapabilities();
    $('#new-group').hidden = !(caps && can('groups.create'));
    if (!caps) { renderGroups(); return; }
    if (!teamCfg.loaded) loadTeamCfg();
    const res = await state.roster.call('groups.list', gparams({ limit: 50 }), 20000);
    state.groups = (res.rooms || []).filter((r) => !r.disbanded_at);
    for (const r of state.groups) if (seen['room:' + r.room_id] === undefined) seen['room:' + r.room_id] = r.latest_seq || 0;
    store.set('seen', seen); store.set('groups-cache', state.groups);
  } catch { /* keep the last good list, never show transport text */ }
  renderGroups();
}

export function renderGroups() {
  const q = $('#q').value.trim().toLowerCase();
  const list = state.groups.filter((r) => !isPinned('room:' + r.room_id)) // les épinglés sont des tuiles en haut
    .filter((r) => !q || (r.name + ' ' + r.members.map(memberName).join(' ')).toLowerCase().includes(q));
  $('#groups-h').hidden = !list.length && !groupCaps.error;
  $('#groups-msg').textContent = groupCaps.error && !state.groups.length ? groupCaps.error : '';
  $('#groups').innerHTML = list.map((r) => {
    const unread = (r.latest_seq || 0) > (seen['room:' + r.room_id] || 0);
    const st = state.group?.room.room_id === r.room_id && state.group.busy ? 'working' : activity.rooms[r.room_id];
    return `<li class="bot" data-room="${esc(r.room_id)}" style="--c:${avatarOf(r.members[0]?.profile || r.room_id).color}">
      ${groupAvatarHtml(r.members.map((m) => m.profile), 50, { act: actClass(st) })}
      <div class="mid"><div class="top"><span class="nm">${esc(r.name)}</span><span class="tm">${esc(when(r.updated_at))}</span></div>
      <div class="pv">${actLine(st, r.members.map(memberName).join(', '))}${meBadge('room:' + r.room_id) || (unread ? '<i class="badge">•</i>' : '')}</div></div></li>`;
  }).join('');
  renderPins();
}

// ---------- room view ----------
export async function openGroup(roomId) {
  clearReply();
  const room = state.groups.find((r) => r.room_id === roomId); if (!room) return;
  closeChat();
  const g = state.group = { room, cursor: 0, shown: 0, epoch: null, timer: null, driver: null, busy: false, actions: new Map(), stopping: null };
  ui.posLock = true;
  $('#chat-name').textContent = room.name;
  $('#chat-sub').textContent = room.members.map(memberName).join(', ');
  resetLook();
  log().innerHTML = '';
  $('#input').placeholder = 'Message au groupe';
  restoreDraft();
  $('#bot-edit').hidden = true;
  $('#group-settings').hidden = !(can('groups.rename') || can('groups.context') || can('groups.disband'));
  $('#group-tasks').hidden = true; $('#gt-n').hidden = true;
  show('chat');
  history.pushState({ room: roomId }, '', '#room-' + encodeURIComponent(roomId));
  store.set('last-chat', { kind: 'room', name: roomId, ts: Date.now() });
  const held = store.get('group-intent-' + roomId, null);
  if (held) offerRetry(g, held);
  await showCachedGroup(g);
  await pollGroup(g);
}

// Cache : les derniers événements du groupe restent sur le téléphone. À l'ouverture on les affiche tout de suite,
// puis le relevé ne demande que la suite (since_seq = curseur du cache) ; un changement d'epoch repart de zéro.
const GROUP_KEEP = 400, groupKey = (id) => 'room:' + id;
async function showCachedGroup(g) {
  const saved = await idb.get(groupKey(g.room.room_id));
  if (state.group !== g || g.cursor || !saved?.events?.length) return;
  g.epoch = saved.epoch ?? null; g.cursor = saved.cursor || 0; g.events = saved.events;
  quiet(() => { for (const ev of saved.events) { if (Number.isInteger(ev.seq)) g.shown = Math.max(g.shown, ev.seq); renderRoomEvent(g, ev); } });
  g.restored = true; restorePos(groupKey(g.room.room_id));
}
function saveGroup(g) {
  idb.put(groupKey(g.room.room_id), { epoch: g.epoch, cursor: g.cursor, events: (g.events || []).slice(-GROUP_KEEP) });
}

export function closeGroup() {
  if (!state.group) return;
  closeTrace(); clearTimeout(state.group.timer); state.group = null; $('#grp-bar').hidden = true;
  $('#group-settings').hidden = true; $('#group-tasks').hidden = true;
  if ($('#tasks-dlg').open) $('#tasks-dlg').close();
  $('#input').placeholder = 'Message';
}

export async function pollGroup(g) {
  if (state.group !== g) return;
  clearTimeout(g.timer);
  try {
    if (!state.roster || state.roster.ws?.readyState !== 1) { await loadRoster(); }
    const gw = state.roster;
    const st = await gw.call('groups.state', gparams({ room_id: g.room.room_id }), 20000);
    if (state.group !== g) return;
    g.room = st.room || g.room;
    if (g.epoch !== null && g.room.authority_epoch !== g.epoch) { g.cursor = 0; g.shown = 0; g.events = []; log().innerHTML = ''; }
    g.epoch = g.room.authority_epoch;
    let added = false;
    for (let more = true; more;) {
      const page = await gw.call('groups.log', gparams({ room_id: g.room.room_id, since_seq: g.cursor, limit: 200 }), 20000);
      if (state.group !== g) return;
      const firstLoad = g.cursor === 0;
      // Deux relevés peuvent se croiser (envoi + minuterie) avec le même curseur : un événement déjà affiché
      // (seq <= g.shown) est ignoré, sinon le même message apparaît deux fois.
      for (const ev of page.events || []) {
        if (Number.isInteger(ev.seq)) { if (ev.seq <= g.shown) continue; g.shown = ev.seq; }
        (g.events ||= []).push(ev); added = true;
        firstLoad ? quiet(() => renderRoomEvent(g, ev)) : renderRoomEvent(g, ev);
      }
      g.cursor = Math.max(g.cursor, page.cursor ?? 0);
      more = !!page.has_more && (page.events || []).length > 0;
    }
    if (added) saveGroup(g);
    seen['room:' + g.room.room_id] = Math.max(seen['room:' + g.room.room_id] || 0, g.cursor); store.set('seen', seen);
    markMentionsSeen('room:' + g.room.room_id);
    if (!g.restored) { g.restored = true; restorePos('room:' + g.room.room_id); }
    g.context = st.context || g.context || null;
    leadWarn(g);
    await pollDispatch(g);
    await pollTraces(g);
    pollTasks(g);
    renderDriver(g, st.driver_status || null);
    $('#chat-sub').textContent = g.room.members.map(memberName).join(', ');
  } catch (e) {
    if (e instanceof AuthError) { location.href = LOGIN_URL; return; }
    $('#chat-sub').textContent = 'le gateway attend peut-être un bot… nouvel essai';
  }
  if (state.group === g && !g.room.disbanded_at) g.timer = setTimeout(() => !document.hidden && pollGroup(g), GROUP_POLL_MS);
}

// Tout groupe doit avoir un meneur : un groupe sans meneur valide le dit, avec un bouton vers les réglages.
function leadWarn(g) {
  const ctx = g.context; if (!ctx || !can('groups.context') || g.room.disbanded_at) return;
  const ok = ctx.routing === 'lead' && g.room.members.some((m) => m.member_id === ctx.lead_member_id);
  const el = log().querySelector('.note.lead-warn');
  if (ok) { el?.remove(); return; }
  if (el) return;
  const n = document.createElement('div'); n.className = 'note lead-warn';
  n.innerHTML = 'Ce groupe n’a pas de meneur. <button type="button" class="link">Choisir un meneur</button>';
  n.querySelector('button').onclick = openGroupSettings;
  log().appendChild(n);
}
function actorName(g, actor) {
  if (!actor) return '?';
  if (actor.kind === 'user') return 'Toi';
  const m = g.room.members.find((x) => x.member_id === actor.id);
  return actor.display_name || (m && memberName(m)) || botLabel(actor.profile) || actor.id;
}

function addMemberBubble(name, text, key, ts, eid = '') {
  const row = document.createElement('div'); row.className = 'row assistant member';
  const b = /** @type {any} */ (document.createElement('div')); b.className = 'bubble'; b.dataset.mid = key; b.dataset.ts = String(toMs(ts) || Date.now()); if (eid) b.dataset.eid = eid;
  b._raw = text || '';
  const g = state.group, ctx = g?.context, prof = g?.room.members.find((m) => m.member_id === key)?.profile || key, col = avatarOf(prof).color;
  const lead = ctx?.routing === 'lead' && ctx.lead_member_id && ctx.lead_member_id === key ? `<span class="lead-tag" style="--c:${col}">meneur</span>` : '';
  b.innerHTML = `<div class="author" style="color:${col}">${esc(name)}${lead}</div>` + inertMd(text);
  row.insertAdjacentHTML('beforeend', avatarHtml(prof, 30));
  addRow(row, b, ts); fold(b); return b;
}
// Room text may come from another machine: no images, no local links; only public http(s) links.
function inertMd(text) {
  const html = md(String(text || '').replace(/!\[([^\]]*)\]\([^)]*\)/g, '[image: $1]').replace(/^MEDIA:.*$/gm, '[fichier]'));
  const box = document.createElement('div'); box.innerHTML = html;
  for (const img of box.querySelectorAll('img')) img.replaceWith(document.createTextNode('[image]'));
  for (const a of box.querySelectorAll('a')) {
    let ok = false;
    try { const u = new URL(a.getAttribute('href'), location.href); ok = /^https?:$/.test(u.protocol) && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(u.hostname) && !u.hostname.endsWith('.ts.net'); } catch {}
    if (ok) { a.target = '_blank'; a.rel = 'noopener noreferrer'; } else a.replaceWith(document.createTextNode(a.textContent));
  }
  return box.innerHTML;
}

const FAIL_REASON = { member_unavailable: 'bot indisponible', superseded_by_newer_user_event: 'remplacé par ton message suivant' };
export function renderRoomEvent(g, ev) {
  const p = ev.payload || {};
  switch (ev.kind) {
    case 'message.user': {
      const mine = log().querySelector(`[data-eid="${CSS.escape(ev.event_id)}"]`)
        || [...log().querySelectorAll('.bubble.pending[data-text]')].find((b) => b.dataset.text === asText(p.text));
      if (mine) { mine.classList.remove('pending'); mine.dataset.eid = ev.event_id; delete mine.dataset.text; break; }
      // Résultat d'une table ronde (outil group_dispatch) ou group_post : « [profil] texte », posté au nom du bot
      const bp = /^\[([\w.-]+)\] ([\s\S]*)$/.exec(asText(p.text)), bm = bp && g.room.members.find((m) => [m.profile, m.member_id, m.handle].includes(bp[1]));
      if (bm) {
        // la mention finale du meneur sert à le réveiller : inutile à l'affichage
        const tail = /\s*@([\w.:-]+)\s*$/.exec(bp[2]), body = tail && g.room.members.some((m) => m.handle === tail[1]) ? bp[2].slice(0, tail.index) : bp[2];
        addMemberBubble(memberName(bm), body.replace(/\u200b/g, ''), bm.member_id, ev.created_at, ev.event_id); break;
      }
      addBubble('user', asText(p.text), { ts: ev.created_at }).dataset.eid = ev.event_id; break;
    }
    case 'message.member': {
      if (isSilent(asText(p.text))) break;
      addMemberBubble(actorName(g, ev.actor), asText(p.text), ev.actor?.id || '', ev.created_at, ev.event_id);
      if (document.hidden && ev.seq > (seen['room:' + g.room.room_id] || 0)) notifyRoom(g.room, actorName(g, ev.actor) + ' : ' + asText(p.text).slice(0, 120));
      break;
    }
    // tours : l'auteur est le gateway, le membre concerné est dans payload.member_id (« install:… : en attente » le 2026-11-15)
    case 'turn.failed': case 'turn.deferred': case 'turn.cancelled': if (ev.actor?.kind === 'gateway' && p.member_id) ev = { ...ev, actor: { kind: 'member', id: p.member_id } };
  }
  switch (ev.kind) {
    case 'turn.failed': addNote(`${actorName(g, ev.actor)} : échec${p.reason_code ? ' (' + p.reason_code + ')' : ''}`); break;
    case 'turn.deferred': addNote(`${actorName(g, ev.actor)} : en attente${p.reason ? ' (' + (FAIL_REASON[p.reason] || p.reason) + ')' : ''}`); break;
    case 'turn.cancelled': if (p.reason !== 'superseded_by_newer_user_event') addNote(`${actorName(g, ev.actor)} : arrêté`); break;
    case 'room.stop_requested': addNote('Arrêt demandé'); break;
    case 'room.activity': if (p.status === 'bounded') addNote('Limite de discussion atteinte'); break;
    case 'room.renamed': if (p.name) { g.room.name = p.name; $('#chat-name').textContent = p.name; } break;
    case 'room.disbanded': addNote('Groupe dissous'); g.room.disbanded_at = ev.created_at; break;
    case 'member.unavailable': addNote(`${actorName(g, ev.actor)} indisponible`); break;
    case 'room.created': addNote('Groupe créé : ' + g.room.members.map(memberName).join(', ')); break;
  }
  scrollDown();
}

// Table ronde : les bots que le meneur fait travailler en même temps (plugin bot-groups, dispatch.status)
let dispatchRpc = true;
async function pollDispatch(g) {
  if (!dispatchRpc) return;
  try { g.dispatch = ((await state.roster.call('plugin.bot-groups.dispatch.status', { room_id: g.room.room_id }, 8000))?.jobs || []).filter((j) => j.status === 'running'); }
  catch (e) { if (/method|not found|unknown/i.test(e.message || '')) dispatchRpc = false; g.dispatch = []; }
}
export function renderDriver(g, d) {
  g.driver = d;
  // typing rows
  let t = log().querySelector('.typing');
  const live = (d?.member_activity || []).filter((a) => a.status === 'running' || a.status === 'queued' || a.status === 'stopping');
  const par = g.dispatch || [];
  if (live.length || par.length) {
    if (!t) { t = document.createElement('div'); t.className = 'note typing'; }
    t.innerHTML = esc(live.map((a) => {
      const m = g.room.members.find((x) => x.member_id === a.member_id);
      const n = m ? memberName(m) : a.member_id;
      return a.status === 'queued' ? n + ' en file' : a.status === 'stopping' ? n + ' s’arrête' : n + ' écrit' + (a.tool ? ' (' + a.tool + ')' : '') + '…';
    }).concat(par.map((j) => { const m = g.room.members.find((x) => [x.profile, x.member_id].includes(j.bot)); return (m ? memberName(m) : j.name) + ' travaille en parallèle'; })).join(' · ')) + DOTS;
    log().appendChild(t); scrollDown();
  } else t?.remove();
  if (d === null) { $('#chat-sub').textContent = 'moteur de groupe indisponible'; }
  if (d?.last_error) $('#chat-sub').textContent = 'erreur de préparation : ' + d.last_error.slice(0, 80);
  // Stop shows while the room works or a Stop is settling
  // `running` = moteur de groupe allumé, pas un tour en cours : seul `working` dit qu'un bot répond
  g.busy = !!d?.working || !!g.stopping;
  chatLook();
  // barre au-dessus du composeur : tous les bots qui travaillent (tour du groupe + table ronde), et Arrêter.
  // Plusieurs avatars côte à côte = travail en parallèle (demandé le 2026-11-15).
  const bar = $('#grp-bar'), workers = [];
  const add = (m, fallback) => { const prof = m?.profile || fallback; if (prof && !workers.some((w) => w.prof === prof)) workers.push({ prof, id: m?.member_id || prof, nm: m ? memberName(m) : botLabel(prof) || prof }); };
  for (const a of live.filter((x) => x.status !== 'queued')) add(g.room.members.find((x) => x.member_id === a.member_id));
  for (const j of par) add(g.room.members.find((x) => [x.profile, x.member_id].includes(j.bot)), j.bot);
  // en file sans personne au travail : il démarre, il n'attend personne (« chiffres attend son tour » seul, vu en vrai le 2026-11-16)
  if (!workers.length) for (const a of live) add(g.room.members.find((x) => x.member_id === a.member_id));
  const waiting = waitingTurn(g, live).filter((m) => !workers.some((w) => w.prof === (m.profile || m.member_id)));
  bar.hidden = !g.busy && !workers.length;
  if (!bar.hidden) {
    if (!workers.length) workers.push({ prof: g.room.members[0]?.profile, nm: 'Le groupe' });
    const wait = waiting.filter((m) => !workers.some((w) => w.prof === m.profile)).slice(0, Math.max(0, 4 - workers.length));
    $('#grp-av').innerHTML = `<span class="grp-stack">${workers.slice(0, 4).map((w) => `<button type="button" class="grp-av" data-worker="${esc(w.id)}" aria-label="Fil de travail de ${esc(w.nm)}">${avatarHtml(w.prof, 30, { ring: true })}</button>`).join('')}`
      + wait.map((m) => `<span class="grp-wait">${avatarHtml(m.profile || m.member_id, 30)}</span>`).join('') + '</span>';
    const names = workers.map((w) => `<b style="color:${avatarOf(w.prof).color}">${esc(w.nm)}</b>`);
    // en file dans le moteur : il les fait parler l'un après l'autre
    const wn = waiting.map((m) => esc(memberName(m)));
    const after = !wn.length ? '' : ' · ' + (wn.length === 1 ? `${wn[0]} attend son tour` : `${wn.slice(0, -1).join(', ')} et ${wn.at(-1)} attendent leur tour`);
    $('#grp-txt').innerHTML = (workers.length === 1 ? `${names[0]} répond${DOTS}`
      : `${names.slice(0, -1).join(', ')} et ${names.at(-1)} travaillent en parallèle${DOTS}`) + after;
    $('#grp-bar').classList.toggle('par', workers.length > 1);
    $('#grp-stop').hidden = !(g.busy || par.length) || !can('groups.stop'); // la table ronde seule compte aussi : Arrêter doit l'arrêter
  }
  updateSendBtn();
  // pending actions: only what driver_status offers
  const want = new Map();
  for (const a of d?.pending_actions || []) {
    const key = [a.kind, a.member_id, a.task_id, a.execution_generation, a.request_id || ''].join('|');
    want.set(key, a);
  }
  for (const [key, el] of g.actions) if (!want.has(key)) { el.remove(); g.actions.delete(key); }
  for (const [key, a] of want) if (!g.actions.has(key)) { const el = actionCard(g, a); if (el) { g.actions.set(key, el); log().appendChild(el); scrollDown(true); } }
  markQueued(g); sideBubbles(g); heldBubbles(g);
}

// Membres que le moteur a vraiment mis en file (member_activity « queued ») et qui ne travaillent pas déjà en
// parallèle. L'ancienne version devinait la file en relisant les @ du fil et affichait « attend son tour » pour des
// bots que le moteur ne relancerait jamais (défaut 1 du 2026-11-16).
function waitingTurn(g, live) {
  const out = [];
  for (const a of live) {
    if (a.status !== 'queued') continue;
    const m = g.room.members.find((x) => x.member_id === a.member_id);
    if (m && !out.includes(m)) out.push(m);
  }
  return out;
}

function approvalPreview(a) {
  const ap = a.approval || {}, cmd = String(ap.command || '').trim(), desc = String(ap.description || '').trim();
  const labelled = /^<[^>]+> \(/.test(cmd);
  const matching = !!a.request_id && (!ap.request_id || ap.request_id === a.request_id) && (!ap.prompt_id || ap.prompt_id === a.request_id);
  return { cmd: labelled ? '' : cmd, desc, reviewable: matching && !!(labelled ? desc : cmd) };
}

function actionCard(g, a) {
  const m = g.room.members.find((x) => x.member_id === a.member_id);
  const who = m ? memberName(m) : a.member_id;
  const box = document.createElement('div'); box.className = 'approval';
  let buttons = [], title = '', body = '';
  if (a.kind === 'approval' && can('groups.approve')) {
    const pv = approvalPreview(a), offered = a.approval?.choices || [];
    title = 'Validation demandée · ' + who;
    body = (pv.desc ? '<div>' + esc(pv.desc) + '</div>' : '') + (pv.cmd ? '<pre>' + esc(pv.cmd) + '</pre>' : '');
    if (offered.includes('once') && pv.reviewable) buttons.push(['once', 'Autoriser une fois', 'yes']);
    if (offered.includes('deny')) buttons.push(['deny', 'Refuser', 'no']);
    if (document.hidden) notifyRoom(g.room, who + ' demande une validation' + (pv.cmd ? ' : ' + pv.cmd.slice(0, 80) : ''));
  } else if (a.kind === 'retry' && can('groups.retry')) {
    title = 'Tour bloqué · ' + who; body = '<div>Le tour n’a pas pu aboutir.</div>';
    buttons.push(['retry', 'Réessayer', 'yes']);
  } else if (a.kind === 'discard' && can('groups.discard')) {
    title = 'Tour en attente · ' + who; body = '<div>Abandonner ce tour ? Ses effets déjà faits ne sont pas annulés.</div>';
    buttons.push(['discard', 'Abandonner', 'no']);
  } else return null;
  if (!buttons.length) return null;
  box.innerHTML = `<div class="t">${esc(title)}</div>${body}<div class="btns">${buttons.map(([v, l, c]) => `<button data-c="${v}" class="${c}">${l}</button>`).join('')}</div>`;
  box.addEventListener('click', async (ev) => {
    const ch = /** @type {any} */ (ev.target)?.dataset?.c; if (!ch) return;
    if (ch === 'discard' && !confirm('Abandonner ce tour ? Ce qui a déjà été fait n’est pas annulé.')) return;
    box.querySelectorAll('button').forEach((b) => (b.disabled = true));
    const params = { room_id: g.room.room_id, member_id: a.member_id, task_id: a.task_id, execution_generation: a.execution_generation };
    let method = 'groups.' + ch;
    if (ch === 'once' || ch === 'deny') { method = 'groups.approve'; Object.assign(params, { request_id: a.request_id, choice: ch }); }
    try {
      await state.roster.call(method, gparams(params), 30000);
      box.querySelector('.t').textContent = 'Réponse envoyée'; box.querySelector('.btns').remove();
      pollGroup(g);
    } catch (e) {
      box.querySelectorAll('button').forEach((b) => (b.disabled = false));
      addNote(/unknown_execution/.test(e.message)
        ? 'Réessai refusé : le gateway a perdu ce tour en redémarrant et ne sait pas s’il tourne encore. Il faut d’abord le clore côté serveur (demande à Yaia).'
        : 'Échec : ' + e.message);
    }
  });
  return box;
}

// ---------- send / stop ----------
export async function userEventId(clientId) {
  try {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(clientId));
    return 'user:' + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return clientId; }
}
function intentKey(g) { return 'group-intent-' + g.room.room_id; }
async function groupSend(g, text, held) {
  if (!can('groups.send')) { addNote('Ce gateway n’accepte pas l’envoi dans les groupes.'); return; }
  const intent = held || { event_id: uuid(), text };
  store.set(intentKey(g), intent);
  // The gateway files the message as user:sha256(event_id): tag the bubble with that id before sending,
  // so a poll that lands while groups.send is still in flight recognizes it (no double bubble).
  const serverId = await userEventId(intent.event_id);
  let bubble = log().querySelector(`[data-eid="${CSS.escape(serverId)}"]`);
  if (!bubble) { bubble = addBubble('user', intent.text); bubble.dataset.eid = serverId; bubble.dataset.text = intent.text; }
  bubble.classList.add('pending'); scrollDown(true);
  // voie rapide : le membre cité est libre alors que le groupe travaille, il répond tout de suite en coulisse
  const fast = !held && fastLaneMembers(g, intent.text);
  if (fast && await sendFastLane(g, intent.text, intent.event_id, fast)) {
    store.set(intentKey(g), null); bubble.dataset.side = intent.event_id;
    pollGroup(g); return;
  }
  try {
    // pendant une discussion : gardé par le plugin, il passe avant les relances et les résultats des bots
    if (!held && await sendHeld(g, intent.event_id, intent.text)) {
      store.set(intentKey(g), null); bubble.classList.add('held');
      markQueued(g); pollGroup(g); return;
    }
    const r = await state.roster.call('groups.send', gparams({ room_id: g.room.room_id, event_id: intent.event_id, payload: { text: intent.text, thread_id: intent.event_id } }), 45000);
    if (r.client_event_id && r.client_event_id !== intent.event_id) throw new Error('reçu inattendu');
    if (r.accepted === false) throw new Error('refusé par le gateway');
    store.set(intentKey(g), null);
    if (r.event?.event_id) bubble.dataset.eid = r.event.event_id;
    pollGroup(g);
  } catch (e) {
    if (e.data?.admitted === false) { // proof nothing was posted: words come back for editing
      store.set(intentKey(g), null); bubble.parentElement?.remove();
      $('#input').value = intent.text; saveDraft(); addNote('Non envoyé : ' + e.message);
    } else offerRetry(g, intent, e.message);
  }
}
function offerRetry(g, intent, why) {
  const n = document.createElement('div'); n.className = 'note';
  n.innerHTML = `Envoi non confirmé${why ? ' (' + esc(why) + ')' : ''}. <button class="link">Réessayer</button>`;
  n.querySelector('button').onclick = () => { n.remove(); groupSend(g, intent.text, intent); };
  log().appendChild(n); scrollDown(true);
}
async function groupStop(g) {
  if (!can('groups.stop')) return;
  g.stopping = g.stopping || uuid();
  try {
    const r = await state.roster.call('groups.stop', gparams({ room_id: g.room.room_id, cancel_id: g.stopping }), 30000);
    // groups.stop ne connaît pas la table ronde : le plugin arrête ses tâches (sinon les bots continuaient à travailler)
    const rt = await state.roster.call('plugin.bot-groups.dispatch.stop', { room_id: g.room.room_id }, 30000).catch((e) => (/method|not found|unknown/i.test(e.message || '') ? { stopped: 0 } : Promise.reject(e)));
    const n = (r.cancelled ?? 0) + (rt?.stopped ?? 0);
    addNote('Arrêt demandé (' + n + ' tour' + (n > 1 ? 's' : '') + ')');
    g.stopping = null;
  } catch (e) { addNote('Arrêt non confirmé : ' + e.message); }
  pollGroup(g);
}
export function groupSubmit(text) {
  const g = state.group; if (!g) return;
  if (!text && g.busy) return groupStop(g);
  if (text) { groupSend(g, replyPrefix() + text); clearReply(); }
}

// ---------- settings (rename + purpose/notes/routing) ----------
function openGroupSettings() {
  const g = state.group; if (!g) return;
  const ctx = g.context || { purpose: '', notes: '', routing: 'everyone', lead_member_id: '' };
  $('#gs-name').value = g.room.name; $('#gs-name').disabled = !can('groups.rename');
  for (const id of ['#gs-purpose', '#gs-notes', '#gs-routing', '#gs-lead']) $(id).disabled = !can('groups.context');
  $('#gs-purpose').value = ctx.purpose || ''; $('#gs-notes').value = ctx.notes || '';
  $('#gs-routing').value = 'lead'; // tout groupe a un meneur
  $('#gs-lead').innerHTML = g.room.members.map((m) => `<option value="${esc(m.member_id)}">${esc(memberName(m))}</option>`).join('');
  $('#gs-lead').value = g.room.members.some((m) => m.member_id === ctx.lead_member_id) ? ctx.lead_member_id : g.room.members[0]?.member_id;
  $('#gs-disband').hidden = !can('groups.disband');
  const canRecreate = can('groups.create') && can('groups.disband') && can('groups.log');
  $('#gs-members-row').hidden = !canRecreate;
  if (canRecreate) {
    const seatable = groupCaps.value?.seatable_profiles;
    const current = new Set(g.room.members.map((m) => m.profile));
    const bots = state.bots.filter((b) => !isHidden(b) && (current.has(b.name) || !Array.isArray(seatable) || seatable.includes(b.name)));
    $('#gs-members').innerHTML = bots.map((b) => `<label class="pick">${avatarHtml(b.name, 36)}<span class="nm">${esc(botName(b))}</span><input type="checkbox" value="${esc(b.name)}"${current.has(b.name) ? ' checked' : ''}></label>`).join('');
  }
  $('#gs-msg').textContent = '';
  g.settingsIds = { rename: uuid(), context: uuid() }; // one id per opening: a retried save is not applied twice
  $('#group-dlg').showModal();
}
async function saveGroupSettings() {
  const g = state.group; if (!g) return;
  const name = $('#gs-name').value.trim();
  if (!name) return ($('#gs-msg').textContent = 'Le nom ne peut pas être vide.');
  const ctx = g.context || { purpose: '', notes: '', routing: 'everyone', lead_member_id: '' };
  const next = { purpose: $('#gs-purpose').value.trim(), notes: $('#gs-notes').value.trim(), routing: $('#gs-routing').value, lead_member_id: $('#gs-routing').value === 'lead' ? $('#gs-lead').value : '' };
  if (new Blob([next.notes]).size > 4096) return ($('#gs-msg').textContent = 'Notes trop longues (4 Ko max).');
  const picked = $('#gs-members-row').hidden ? null : [...$('#gs-members').querySelectorAll('input:checked')].map((i) => i.value);
  const before = g.room.members.map((m) => m.profile).sort().join(',');
  if (picked && picked.slice().sort().join(',') !== before) return recreateGroup(g, name, next, picked);
  const btn = $('#gs-save'); btn.disabled = true; $('#gs-msg').textContent = 'Enregistrement…';
  try {
    if (can('groups.rename') && name !== g.room.name) {
      const r = await state.roster.call('groups.rename', gparams({ room_id: g.room.room_id, event_id: g.settingsIds.rename, name }), 30000);
      g.room = r.room || { ...g.room, name }; $('#chat-name').textContent = g.room.name;
      const row = state.groups.find((x) => x.room_id === g.room.room_id); if (row) row.name = g.room.name;
    }
    const changed = next.purpose !== (ctx.purpose || '') || next.notes !== (ctx.notes || '') || ctx.routing !== 'lead' || next.lead_member_id !== ctx.lead_member_id;
    if (can('groups.context') && changed) {
      const params = { room_id: g.room.room_id, event_id: g.settingsIds.context, purpose: next.purpose, notes: next.notes, routing: next.routing };
      if (next.routing === 'lead') params.lead_member_id = next.lead_member_id;
      const r = await state.roster.call('groups.context', gparams(params), 30000);
      g.context = r.context || next;
    }
    $('#group-dlg').close(); pollGroup(g);
  } catch (e) {
    $('#gs-msg').textContent = 'Échec : ' + e.message + ' (réessayer est sans risque)';
  } finally { btn.disabled = false; }
}

// ---------- member change = recreate (the gateway has no membership edit) ----------
function memberDescriptor(p) {
  const b = state.bots.find((x) => x.name === p);
  return { member_id: p, profile: p, handle: b?.is_default ? 'hermes' : p, target: { kind: 'local', profile: p }, ...(b ? { display_name: botName(b) } : {}) };
}
// Dispatch posts from before bot-groups 1.11.0 carried file diffs (« │ +... ») : noise for a recap.
const isDiffPost = (t) => /^\[[\w-]+\] │/.test(t) || (t.match(/^│/gm) || []).length > 3;
async function roomTranscript(g) {
  const msgs = [];
  for (let since = 0, more = true; more;) {
    const page = await state.roster.call('groups.log', gparams({ room_id: g.room.room_id, since_seq: since, limit: 500 }), 30000);
    for (const ev of page.events || []) {
      const t = ev.kind === 'message.user' || ev.kind === 'message.member' ? asText(ev.payload?.text).trim() : '';
      if (!t || isDiffPost(t) || t.startsWith('[Reprise du groupe')) continue;
      msgs.push((ev.kind === 'message.user' ? 'Yoan' : actorName(g, ev.actor)) + ' : ' + t);
    }
    since = Math.max(since, page.cursor ?? 0);
    more = !!page.has_more && (page.events || []).length > 0;
  }
  return msgs;
}
const RECAP_HEAD = (name, who) => `[Reprise du groupe « ${name} », recréé pour changer ses membres. Résumé des échanges${who ? ' écrit par ' + who : ''}. Ne réponds pas à ce message.]\n\n`;
// The group lead reads the whole history and writes the recap (server.ts /recap) ; if it fails, the last messages are copied.
async function roomRecap(g, ctx, step) {
  const msgs = await roomTranscript(g);
  if (!msgs.length) return null;
  let lines = msgs.map((t) => (t.length > 6000 ? t.slice(0, 6000) + '…' : t));
  while (lines.length > 1 && lines.join('\n\n').length > 100000) lines = lines.slice(1);
  const members = g.room.members || [];
  const lead = members.find((m) => m.member_id === ctx.lead_member_id) || members[0];
  if (lead?.profile) {
    const who = memberName(lead) || lead.profile;
    step(`${who} écrit le résumé des échanges (jusqu'à 2 min)…`);
    try {
      const r = await fetch('recap', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: lead.profile, room: g.room.name, transcript: lines.join('\n\n') }) });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.text) return RECAP_HEAD(g.room.name, who) + j.text;
      report('error', `recap ${r.status} ${j.detail || ''}`, 'groups.js');
    } catch (e) { report('error', 'recap ' + e.message, 'groups.js'); }
  }
  step('Résumé indisponible : copie des derniers messages…');
  let tail = msgs.slice(-30).map((t) => (t.length > 1500 ? t.slice(0, 1500) + '…' : t));
  while (tail.join('\n\n').length > 12000) tail = tail.slice(1);
  return `[Reprise du groupe « ${g.room.name} », recréé pour changer ses membres. Voici les derniers échanges pour contexte. Ne réponds pas à ce message.]\n\n` + tail.join('\n\n');
}
async function recreateGroup(g, name, ctx, picked) {
  if (picked.length < 2 || picked.length > teamCfg.max_members) return ($('#gs-msg').textContent = `Choisis de 2 à ${teamCfg.max_members} bots.`);
  if (!confirm(`Recréer « ${name} » avec ${picked.length} bots ? Le but, les notes et un résumé des derniers échanges passent dans le nouveau groupe, puis l'ancien est supprimé.`)) return;
  // Ids kept per old room so an interrupted change resumes without duplicates.
  const key = 'recreate-' + g.room.room_id;
  const ids = store.get(key, null) || { room_id: uuid(), context: uuid(), recap: uuid(), cancel: uuid() };
  store.set(key, ids);
  const btn = $('#gs-save'); btn.disabled = true;
  const step = (t) => ($('#gs-msg').textContent = t);
  try {
    step('Création du nouveau groupe…');
    const r = await state.roster.call('groups.create', gparams({ room_id: ids.room_id, name, members: picked.map(memberDescriptor) }), 30000);
    const room = r.room;
    if (can('groups.context')) {
      // tout groupe a un meneur : celui choisi s'il reste dans le groupe, sinon le premier membre
      step('Copie du but, des notes et du meneur…');
      const lead = room.members.some((m) => m.member_id === ctx.lead_member_id) ? ctx.lead_member_id : room.members[0].member_id;
      await state.roster.call('groups.context', gparams({ room_id: room.room_id, event_id: ids.context, purpose: ctx.purpose || '', notes: ctx.notes || '', routing: 'lead', lead_member_id: lead }), 30000);
    }
    step('Résumé des échanges…');
    // kept with the ids: a retry after a failed step does not ask the lead again
    const recap = ids.recapText !== undefined ? ids.recapText : (ids.recapText = await roomRecap(g, ctx, step));
    store.set(key, ids);
    if (recap) await state.roster.call('groups.send', gparams({ room_id: room.room_id, event_id: ids.recap, payload: { text: recap, thread_id: ids.recap } }), 45000);
    step('Suppression de l\'ancien groupe…');
    const d = await state.roster.call('groups.disband', gparams({ room_id: g.room.room_id, cancel_id: ids.cancel }), 60000);
    if (!d?.tombstone) throw new Error('ancien groupe non supprimé');
    store.set(key, null); store.set(intentKey(g), null);
    state.groups = [room, ...state.groups.filter((x) => x.room_id !== g.room.room_id && x.room_id !== room.room_id)];
    store.set('groups-cache', state.groups);
    $('#group-dlg').close();
    renderGroups(); openGroup(room.room_id);
  } catch (e) {
    step('Échec : ' + e.message + '. Réessaie : les étapes déjà faites ne sont pas refaites.');
  } finally { btn.disabled = false; }
}

// ---------- disband ----------
const DISBAND_REASON = {
  member_home_unknown: 'un bot du groupe est introuvable sur ce Mac',
  peer_unreachable: 'un bot est injoignable ; le travail a été arrêté, réessaie plus tard',
};
async function disbandGroup() {
  const g = state.group; if (!g || !can('groups.disband')) return;
  if (!confirm(`Supprimer le groupe « ${g.room.name} » ? Le travail en cours est arrêté et l'historique n'est plus accessible.`)) return;
  g.disbandId = g.disbandId || uuid(); // same cancel_id across retries
  const btn = $('#gs-disband'); btn.disabled = true;
  try {
    const r = await state.roster.call('groups.disband', gparams({ room_id: g.room.room_id, cancel_id: g.disbandId }), 60000);
    if (!r?.tombstone) throw new Error('suppression non confirmée');
    state.groups = state.groups.filter((x) => x.room_id !== g.room.room_id);
    store.set('groups-cache', state.groups);
    store.set(intentKey(g), null);
    $('#group-dlg').close();
    history.back();
  } catch (e) {
    const why = DISBAND_REASON[e.data?.reason] || e.message;
    $('#gs-msg').textContent = 'Suppression refusée : ' + why + '. Tu peux réessayer.';
  } finally { btn.disabled = false; }
}

// ---------- create ----------
function openNewGroup() {
  const seatable = groupCaps.value?.seatable_profiles;
  const bots = state.bots.filter((b) => !isHidden(b) && (!Array.isArray(seatable) || seatable.includes(b.name)));
  const dlg = $('#new-group-dlg');
  $('#ng-name').value = '';
  $('#ng-bots').innerHTML = bots.map((b) => { const a = avatarOf(b.name); return `<label class="tile" style="--c:${a.color}">${mascot(a.kind, a.color, 58)}<span class="tn">${esc(botName(b))}</span><span class="tick"></span><input type="checkbox" value="${esc(b.name)}" aria-label="${esc(botName(b))}"></label>`; }).join('');
  countNg();
  $('#ng-msg').textContent = '';
  dlg.dataset.creation = uuid(); // one creation id per opened dialog: an uncertain create is safely resent
  dlg.showModal();
}
function countNg() {
  const picked = [...$('#ng-bots').querySelectorAll('input:checked')].map((i) => i.value);
  $('#ng-count').textContent = `${picked.length} sur ${teamCfg.max_members} au plus`;
  // meneur obligatoire : parmi les bots cochés, le premier par défaut
  const box = $('#ng-lead'), cur = box.querySelector('input:checked')?.value;
  const lead = picked.includes(cur) ? cur : picked[0];
  box.innerHTML = picked.map((p) => { const b = state.bots.find((x) => x.name === p), a = avatarOf(p); return `<label class="lchip" style="--c:${a.color}"><input type="radio" name="ng-lead" value="${esc(p)}"${p === lead ? ' checked' : ''}><span>${esc(b ? botName(b) : p)}</span></label>`; }).join('');
  $('#ng-lead-cap').hidden = box.hidden = !picked.length;
}
$('#ng-bots').addEventListener('change', countNg);
async function createGroup() {
  const dlg = $('#new-group-dlg');
  const name = $('#ng-name').value.trim();
  const picked = [...$('#ng-bots').querySelectorAll('input:checked')].map((i) => i.value);
  if (!name) return ($('#ng-msg').textContent = 'Donne un nom au groupe.');
  if (picked.length < 2 || picked.length > teamCfg.max_members) return ($('#ng-msg').textContent = `Choisis de 2 à ${teamCfg.max_members} bots.`);
  const leadPick = $('#ng-lead').querySelector('input:checked')?.value || picked[0];
  const members = picked.map((p) => {
    const b = state.bots.find((x) => x.name === p);
    const handle = b?.is_default ? 'hermes' : p;
    return { member_id: p, profile: p, handle, target: { kind: 'local', profile: p }, ...(b ? { display_name: botName(b) } : {}) };
  });
  $('#ng-create').disabled = true; $('#ng-msg').textContent = 'Création…';
  try {
    const r = await state.roster.call('groups.create', gparams({ room_id: dlg.dataset.creation, name, members }), 30000);
    if (can('groups.context')) {
      $('#ng-msg').textContent = 'Choix du meneur…';
      try { await state.roster.call('groups.context', gparams({ room_id: r.room.room_id, event_id: dlg.dataset.creation + '-lead', purpose: '', notes: '', routing: 'lead', lead_member_id: leadPick }), 30000); }
      catch (e) { addNote('Meneur non enregistré : ' + e.message + '. Choisis-le dans les réglages du groupe.'); }
    }
    dlg.close();
    state.groups = [r.room, ...state.groups.filter((x) => x.room_id !== r.room.room_id)];
    renderGroups(); openGroup(r.room.room_id);
  } catch (e) {
    $('#ng-msg').textContent = 'Échec : ' + e.message + ' (réessayer ne crée pas de doublon)';
  } finally { $('#ng-create').disabled = false; }
}

function notifyRoom(room, body) { notify({ name: 'room:' + room.room_id, display_name: room.name, _room: room.room_id }, body); }

// ---------- wiring ----------
$('#groups').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('[data-room]'); if (!li) return;
  e.preventDefault(); pinGuard.at = Date.now();
  togglePin('room:' + li.dataset.room);
});
$('#groups').addEventListener('click', (e) => { if (Date.now() - pinGuard.at < 700) return; const li = e.target.closest('[data-room]'); if (li) openGroup(li.dataset.room); });
$('#new-group').addEventListener('click', openNewGroup);

// ---------- réglages des équipes (plugin bot-groups : hosted_rooms.discussion dans config.yaml) ----------
const teamCfg = { max_members: 10, max_rounds: 5, max_messages: 50, loaded: false };
async function loadTeamCfg() {
  try {
    Object.assign(teamCfg, await state.roster.call('plugin.bot-groups.settings.get', {}, 15000), { loaded: true });
    $('#teams-set').hidden = false;
  } catch { $('#teams-set').hidden = true; } // plugin absent ou ancien : on garde les défauts
}
export function fillTeam() {
  if (!teamCfg.loaded) return;
  $('#ts-members').value = teamCfg.max_members; $('#ts-rounds').value = teamCfg.max_rounds; $('#ts-messages').value = teamCfg.max_messages;
  $('#ts-msg').textContent = ''; $('#ts-save').disabled = false;
}
async function saveTeamDlg() {
  const val = (id) => Number($(id).value);
  const next = { max_members: val('#ts-members'), max_rounds: val('#ts-rounds'), max_messages: val('#ts-messages') };
  const b = teamCfg.bounds || { max_members: [2, 16], max_rounds: [1, 10], max_messages: [2, 200] };
  const label = { max_members: 'Bots par équipe', max_rounds: 'Tours', max_messages: 'Messages' };
  for (const [k, v] of Object.entries(next)) {
    if (!Number.isInteger(v) || v < b[k][0] || v > b[k][1]) return ($('#ts-msg').textContent = `${label[k]} : entre ${b[k][0]} et ${b[k][1]}.`);
  }
  $('#ts-save').disabled = true; $('#ts-msg').textContent = 'Enregistrement…';
  try {
    Object.assign(teamCfg, await state.roster.call('plugin.bot-groups.settings.set', next, 90000));
    $('#ts-msg').textContent = 'Enregistré.'; $('#ts-save').disabled = false; countNg();
  } catch (e) { $('#ts-msg').textContent = 'Échec : ' + e.message; $('#ts-save').disabled = false; }
}
$('#ts-save').addEventListener('click', saveTeamDlg);
$('#gs-disband').addEventListener('click', disbandGroup);
$('#grp-stop').addEventListener('click', () => state.group && groupStop(state.group));
$('#group-settings').addEventListener('click', openGroupSettings);
$('#gs-cancel').addEventListener('click', () => $('#group-dlg').close());
$('#gs-save').addEventListener('click', saveGroupSettings);
$('#gs-routing').addEventListener('change', () => { $('#gs-lead-row').hidden = $('#gs-routing').value !== 'lead'; });
$('#ng-create').addEventListener('click', createGroup);
$('#ng-cancel').addEventListener('click', () => $('#new-group-dlg').close());
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.group) pollGroup(state.group); });
// Appelé par main.js une fois tous les modules évalués : au chargement de ce module, roster.js (memberName) peut ne pas
// l'être encore (cycle roster <-> groups), et un cache de groupes non vide plantait le démarrage (v76, 2026-11-16).
export function initGroups() { state.groups = store.get('groups-cache', []); renderGroups(); }
