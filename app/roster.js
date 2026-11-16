// @ts-check
// Liste des bots : activité, mentions @yoan, rendu, chargement, état de connexion.

import { DOTS, avatarHtml, avatarOf, groupAvatarHtml, mascot, mascotState } from './avatars.js';
import { AuthError, Gateway, LOGIN_URL } from './gateway.js';
import { loadGroups, renderGroups } from './groups.js';
import { isPinned, syncPins } from './prefs.js';
import { TASK_RE } from './render.js';
import { activity, prefs, seen, state } from './state.js';
import { store } from './store.js';
import { $, esc, isSilent, toMs, when } from './util.js';

export const memberName = (m) => m.display_name || botLabel(m.profile) || m.handle || m.member_id;
export function botLabel(profile) {
  const b = state.bots.find((x) => x.name === profile);
  return b ? botName(b) : null;
}

function botSession(b) { return b.canonical_session || null; }
function botActive(b) {
  const c = botSession(b), w = b.worker_session;
  const t = Math.max(toMs(c?.last_active), toMs(w?.last_active));
  return Date.now() - t < 90_000;
}
export function botName(b) { return (b?.ui_meta?.['hermes-bots']?.title || '').trim() || b?.display_name || (b?.is_default ? 'Hermes' : b?.name) || '?'; }
export function isHidden(b) { const m = b.ui_meta?.['hermes-bots']; return !!(m && (m.hidden === true || m.hide === true)); }

// ---------- @yoan mentions: written by the bot-groups plugin into ui_meta['hermes-bots-mentions'] ----------
const meSeen = store.get('mention-seen') || {};
function mentionList() {
  const out = [];
  for (const b of state.bots || []) for (const it of b.ui_meta?.['hermes-bots-mentions']?.items || [])
    if (Number.isFinite(it?.ts)) out.push({ ...it, key: it.room_id ? 'room:' + it.room_id : b.name, bot: b.name });
  return out;
}
function unseenMentions(key) { return mentionList().filter((m) => m.key === key && m.ts > (meSeen[key] || 0)).length; }
export function meBadge(key) { const n = unseenMentions(key); return n ? `<i class="badge me" title="Tu es mentionné">@${n > 9 ? '9+' : n}</i>` : ''; }
export function markMentionsSeen(key) {
  meSeen[key] = Date.now() / 1000; store.set('mention-seen', meSeen); updateAppBadge();
}
function updateAppBadge() {
  const n = mentionList().filter((m) => m.ts > (meSeen[m.key] || 0)).length;
  try { n ? navigator.setAppBadge?.(n) : navigator.clearAppBadge?.(); } catch {}
}

// ---------- live activity: session.active_list per profile (working / waiting / starting / idle) ----------
const ACT_RANK = { idle: 0, starting: 1, working: 2, waiting: 3 };
const ACT_LABEL = { working: 'travaille', waiting: 'attend ta réponse', starting: 'démarre…' };
async function activeList(name) {
  if (activity.direct !== false && state.roster?.ws?.readyState === 1) {
    try { const r = await state.roster.call('session.active_list', { profile: name }, 8000); activity.direct = true; return r.sessions || []; }
    catch { activity.direct = false; } // a ticket bound to one profile refuses the others: one socket per bot
  }
  let gw = activity.socks[name];
  if (!gw || gw.ws?.readyState !== 1) gw = activity.socks[name] = await new Gateway(name).connect();
  return (await gw.call('session.active_list', {}, 8000)).sessions || [];
}
function botStatus(b) {
  if (state.chat?.bot.name === b.name && state.chat.busy) return 'working';
  return activity.bots[b.name];
}
export function actClass(st) { return st && st !== 'idle' ? ' act-' + st : ''; }
export function actLine(st, fallback) {
  return ACT_LABEL[st] ? `<span class="act ${st}">${ACT_LABEL[st]}${st === 'working' ? DOTS : ''}</span>` : `<span>${esc(fallback)}</span>`;
}
async function refreshActivity() {
  if (activity.busy || !state.bots.length) return;
  activity.busy = true;
  try {
    const bots = state.bots.filter((b) => !isHidden(b));
    const res = await Promise.all(bots.map((b) => activeList(b.name).then((rows) => [b.name, rows], () => [b.name, null])));
    const next = {}, rooms = {};
    for (const [name, rows] of res) {
      if (!rows) { next[name] = activity.bots[name]; continue; }
      let best = 'idle';
      for (const r of rows) {
        const st = ACT_RANK[r.status] !== undefined ? r.status : 'idle';
        const m = /^Group: (.+)$/.exec(r.title || '');
        if (m) { if (ACT_RANK[st] > ACT_RANK[rooms[m[1]] || 'idle']) rooms[m[1]] = st; } // group work shows on the group only
        else if (ACT_RANK[st] > ACT_RANK[best]) best = st;
      }
      next[name] = best;
    }
    const changed = JSON.stringify([next, rooms]) !== JSON.stringify([activity.bots, activity.rooms]);
    activity.bots = next; activity.rooms = rooms;
    if (changed) { renderRoster(); renderGroups(); }
  } finally { activity.busy = false; }
}
setInterval(() => { if (!document.hidden && !$('#roster').hidden) refreshActivity(); }, 5000);

export function renderRoster() {
  const q = $('#q').value.trim().toLowerCase();
  const list = state.bots.filter((b) => !isHidden(b) && !isPinned(b.name))
    .filter((b) => !q || (botName(b) + ' ' + b.name + ' ' + b.description).toLowerCase().includes(q));
  $('#bots').innerHTML = list.map((b) => {
    const c = botSession(b), name = botName(b);
    const unread = c && toMs(c.last_active) > toMs(seen[b.name] || 0) && seen[b.name] !== undefined;
    const tk = TASK_RE.exec(c?.preview || ''); const pv0 = tk ? 'Tâche automatique · ' + tk[1] : c?.preview;
    const preview = (isSilent(pv0) ? '' : pv0) || b.description || (c ? '' : 'Pas encore de discussion');
    const st = botStatus(b), live = st === undefined ? botActive(b) : false;
    return `<li class="bot" data-name="${esc(b.name)}" style="--c:${avatarOf(b.name).color}">
      ${avatarHtml(b.name, 50, { act: actClass(st), live })}
      <div class="mid"><div class="top"><span class="nm">${esc(name)}</span><span class="tm">${esc(when(c?.last_active))}</span></div>
      <div class="pv">${actLine(st, preview)}${meBadge(b.name) || (unread ? '<i class="badge">•</i>' : '')}</div></div></li>`;
  }).join('');
  $('#roster-msg').textContent = state.bots.length && !list.length && !prefs.pinned.length ? 'Aucun bot ne correspond.' : '';
  renderPins();
}
// Épinglés : tuiles en haut (bots et groupes, même liste synchronisée). Appui long = désépingler.
export function renderPins() {
  const q = $('#q').value.trim().toLowerCase(), items = [];
  for (const k of prefs.pinned) {
    if (k.startsWith('room:')) {
      const r = state.groups?.find((x) => 'room:' + x.room_id === k);
      if (r && !r.disbanded_at && (!q || r.name.toLowerCase().includes(q))) items.push({ k, r });
    } else {
      const b = state.bots.find((x) => x.name === k && !isHidden(x));
      if (b && (!q || (botName(b) + ' ' + b.name).toLowerCase().includes(q))) items.push({ k, b });
    }
  }
  const working = [];
  $('#pins').innerHTML = items.map(({ k, b, r }) => {
    if (b) {
      const st = botStatus(b), c = avatarOf(b.name), unread = botSession(b) && toMs(botSession(b).last_active) > toMs(seen[b.name] || 0) && seen[b.name] !== undefined;
      if (st === 'working') working.push(botName(b) + ' travaille');
      return `<button type="button" class="pin-tile${actClass(st)}" data-name="${esc(b.name)}" style="--c:${c.color}">${st === 'working' ? '<i class="dotw"></i>' : ''}${meBadge(b.name) ? `<span class="bd">${meBadge(b.name)}</span>` : unread ? '<i class="dotu"></i>' : ''}${mascot(c.kind, c.color, 54, { key: b.name, st: mascotState(st === 'working' ? 'working' : st === 'waiting' ? 'waiting' : '') })}<span class="tn">${esc(botName(b))}</span></button>`;
    }
    const st = state.group?.room.room_id === r.room_id && state.group.busy ? 'working' : activity.rooms[r.room_id], unread = (r.latest_seq || 0) > (seen['room:' + r.room_id] || 0);
    if (st === 'working') working.push(r.name + ' travaille');
    return `<button type="button" class="pin-tile${actClass(st)}" data-room="${esc(r.room_id)}" style="--c:#B7A6FF">${meBadge(k) ? `<span class="bd">${meBadge(k)}</span>` : unread ? '<i class="dotu"></i>' : ''}${groupAvatarHtml(r.members.map((m) => m.profile), 58, { act: actClass(st) })}<span class="tn">${esc(r.name)}</span></button>`;
  }).join('');
  $('#pins-h').hidden = !items.length;
  const live = $('#pins-live'); live.hidden = !working.length; live.textContent = working.join(' · ');
}

export async function loadRoster() {
  try {
    if (!state.roster || state.roster.ws?.readyState !== 1) {
      state.roster = await new Gateway(null).connect();
      // fermeture (drain du gateway, réseau) : on reconnecte quelle que soit la vue ; « hors ligne » restait affiché dans un salon (2026-11-16)
      state.roster.onClose = () => { setConn(false, navigator.onLine === false ? '' : 'retry'); retryRoster(3000); };
    }
    setConn(true);
    const res = await state.roster.call('profiles.list', { include_sessions: true });
    state.bots = (res.profiles || []).sort((a, b) =>
      toMs(botSession(b)?.last_active || b.last_session?.last_active) - toMs(botSession(a)?.last_active || a.last_session?.last_active));
    for (const b of state.bots) if (seen[b.name] === undefined) seen[b.name] = botSession(b)?.last_active || 0;
    store.set('seen', seen);
    store.set('roster-cache', state.bots);
    if (state.group) markMentionsSeen('room:' + state.group.room.room_id); else if (state.chat) markMentionsSeen(state.chat.bot.name);
    updateAppBadge();
    renderRoster();
    await loadGroups();
    syncPins(); // après les groupes : leurs noms partent avec les épingles (raccourcis de l'app)
    refreshActivity();
  } catch (e) { handleError(e, '#roster-msg'); }
}

// « hors ligne » seulement si le réseau manque : pendant un redémarrage du gateway (ticket 503 runtime_draining), Yoan lisait
// « hors ligne » alors que Tailscale marchait (2026-11-16).
const isDraining = (e) => /ticket 50[234]|runtime_draining|draining|gateway_not_ready/i.test(String(e?.message || e || ''));
export function setConn(on, why) {
  const el = $('#conn'), restarting = !on && why === 'restart';
  const retrying = !on && why === 'retry';
  el.className = 'conn ' + (on ? 'on' : restarting || retrying ? 'off restart' : 'off');
  el.lastElementChild.textContent = on ? 'en ligne' : restarting ? 'gateway en redémarrage' : retrying ? 'reconnexion…' : 'hors ligne';
}
let rosterRetry = null;
function retryRoster(ms) {
  clearTimeout(rosterRetry);
  rosterRetry = setTimeout(() => { rosterRetry = null; if (state.roster?.ws?.readyState !== 1) loadRoster(); }, ms);
}

export function handleError(e, where) {
  if (e instanceof AuthError) {
    $(where).innerHTML = 'Session Hermes expirée. <a href="' + LOGIN_URL + '">Se connecter</a>';
    return;
  }
  if (isDraining(e)) {
    setConn(false, 'restart');
    $(where).textContent = 'Le gateway Hermes redémarre : reconnexion automatique dans quelques instants.';
    retryRoster(10000);
    return;
  }
  // « hors ligne » seulement sans réseau ; sinon le gateway répond mal : on le dit et on réessaie
  setConn(false, navigator.onLine === false ? '' : 'retry');
  $(where).textContent = 'Erreur : ' + e.message;
  if (where === '#roster-msg') retryRoster(15000);
}
