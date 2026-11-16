// @ts-check
// Conversation d'un bot : ouverture, attache au gateway, événements, état occupé.

import { settleClarify, showApproval, showClarify } from './approvals.js';
import { avatarHtml, avatarOf, groupAvatarHtml } from './avatars.js';
import { updateSendBtn } from './composer.js';
import { closeFind } from './find.js';
import { AuthError, Gateway, LOGIN_URL } from './gateway.js';
import { closeGroup } from './groups.js';
import { HISTORY_PAGE, loadHistory, renderHistory } from './history.js';
import { show } from './nav.js';
import { flushOutbox } from './outbox.js';
import { addBubble, addNote, addTool, fold, scrollDown, setBubble, setToolState, streamBubble } from './render.js';
import { clearReply } from './reply.js';
import { botName, markMentionsSeen } from './roster.js';
import { restoreDraft, savePos, scrollPos } from './scroll.js';
import { notify } from './settings.js';
import { seen, state, ui } from './state.js';
import { cacheKey, cachePush, idb, rowKey, store } from './store.js';
import { $, asText, esc, isSilent, log } from './util.js';

const CANONICAL_TITLE = 'Bot Chat';

export function setBusy(busy) {
  const c = state.chat; if (!c) return;
  c.busy = busy;
  updateSendBtn();
  $('#chat-sub').textContent = busy ? 'travaille…' : (c.bot.model || c.bot.description || '');
  chatLook();
}
setInterval(() => { if (!$('#chat').hidden && !document.hidden) chatLook(); }, 1000); // accord ou question réglés : l'état d'attente retombe
// Halo de la couleur du bot (plus fort pendant qu'il travaille), avatar de l'en-tête, anneau « travaille »
let lookKey = '';
export function resetLook() { lookKey = ''; chatLook(); }
export function chatLook() {
  const g = state.group, c = state.chat, v = $('#chat');
  if (!g && !c) return;
  const keys = g ? g.room.members.map((m) => m.profile) : [c.bot.name], busy = !!(g ? g.busy : c.busy);
  // attend Yoan : un accord ou une question en suspens (bot), une action en attente (groupe)
  const waiting = !busy && (g ? !!g.driver?.pending_actions?.length : [...c.prompts.values()].some((b) => b.isConnected && b.querySelector('button:not(:disabled)')));
  const stt = busy ? 'work' : waiting ? 'wait' : 'idle';
  const cols = keys.map((k) => avatarOf(k).color);
  v.style.setProperty('--bc', cols[0]); v.style.setProperty('--bc2', cols[1] || cols[0]);
  v.classList.toggle('grp', !!g); v.classList.toggle('busy', busy);
  $('#chat-sub').classList.toggle('work', busy);
  const sig = keys.join() + cols.join() + stt + (g ? 'g' : 'b');
  if (sig !== lookKey) { lookKey = sig; $('#chat-av').innerHTML = g ? groupAvatarHtml(keys, 40, { act: busy ? ' act-working' : waiting ? ' act-waiting' : '' }) : avatarHtml(keys[0], 38, { ring: busy, st: stt }); }
}

function onChatEvent(ev) {
  const c = state.chat; if (!c) return;
  if (ev.session_id && c.sid && ev.session_id !== c.sid) return;
  const p = ev.payload || {};
  c.lastEvent = Date.now();
  switch (ev.type) {
    case 'message.start': {
      if (Number.isInteger(p.execution_generation)) c.gen = p.execution_generation;
      const next = c.queued.shift(); if (next) next.classList.remove('queued'); // a queued prompt is now running
      const lastRow = log().lastElementChild; c.unsolicited = !next && !(lastRow?.classList.contains('user'));
      setBusy(true); c.streamEl = null; c.lastSeg = null; break;
    }
    case 'message.delta': {
      if (typeof p.text !== 'string' || !p.text) { if (p.text === null && c.streamEl) { c.streamEl.classList.remove('cursor'); c.lastSeg = c.streamEl; c.streamEl = null; } break; }
      if (!c.streamEl) { c.streamEl = addBubble('assistant', '', { stream: true }); }
      streamBubble(c.streamEl, c.streamEl._raw + p.text); break;
    }
    case 'message.interim': { // seals the streamed segment
      if (c.streamEl) { c.streamEl.classList.remove('cursor'); c.lastSeg = c.streamEl; }
      c.streamEl = null; break;
    }
    case 'tool.start':
      if (c.streamEl) { c.streamEl.classList.remove('cursor'); c.lastSeg = null; } c.streamEl = null;
      c.tools.set(p.tool_id, addTool(p.tool_id, p.name, p.preview || p.context || '')); scrollDown(); break;
    case 'tool.complete': {
      const t = c.tools.get(p.tool_id) || addTool(p.tool_id, p.name, '');
      setToolState(t, p.result && typeof p.result === 'object' && p.result.error ? 'fail' : 'done');
      const out = p.summary || p.result_text || '';
      if (out) t.insertAdjacentHTML('beforeend', '<pre>' + esc(String(out).slice(0, 4000)) + '</pre>');
      break;
    }
    case 'message.complete': {
      const text = asText(p.text);
      let last = c.streamEl || null;
      const same = (a, b) => String(a || '').trim() === String(b || '').trim();
      if (!last && c.lastSeg && text && same(c.lastSeg._raw, text)) last = c.lastSeg; // final answer already sealed as interim: don't show it twice
      if (last && isSilent(text || last._raw)) { last.closest('.row')?.remove(); last = null; }
      else if (last) { setBubble(last, text && !p.response_reused ? text : last._raw); last.classList.remove('cursor'); } // rendu final, même si une image est en attente
      else if (text && !p.response_reused && !isSilent(text)) addBubble('assistant', text);
      if (p.status === 'error' && (last || log().lastElementChild?.querySelector?.('.bubble'))) (last || log().lastElementChild.querySelector('.bubble')).classList.add('err');
      if (p.warning) addNote(p.warning);
      fold(last || log().lastElementChild?.querySelector?.('.row.assistant > .bubble, .bubble'));
      c.streamEl = null; setBusy(false); scrollDown();
      if (!p.response_reused) cachePush(c.bot.name, 'assistant', text || last?._raw);
      seen[c.bot.name] = Date.now() / 1000; store.set('seen', seen);
      if (document.hidden && !isSilent(text)) notify(c.bot, text.slice(0, 140) || 'Réponse terminée');
      if (c.unsolicited) { c.unsolicited = false; loadHistory(c).then((m) => { if (state.chat === c) { renderHistory(m); scrollDown(true); } }).catch(() => {}); }
      break;
    }
    case 'error':
      addNote('Erreur : ' + (p.message || p.text || JSON.stringify(p).slice(0, 200))); setBusy(false); break;
    case 'approval.request':
      if (p.kind === 'clarify') { showClarify(p); break; }
      if (Number.isInteger(p.execution_generation)) c.gen = p.execution_generation;
      if (!c.prompts.has(p.prompt_id)) showApproval(p);
      break;
    case 'clarify.request': if (Number.isInteger(p.execution_generation)) c.gen = p.execution_generation; showClarify(p); break;
    case 'clarify.settled': settleClarify(c.prompts.get(p.prompt_id), 'Question réglée'); break;
    case 'approval.settled': case 'approval.cancelled': {
      const box = c.prompts.get(p.prompt_id);
      if (box?.querySelector('.btns')) { box.querySelector('.t').textContent = 'Validation réglée'; box.querySelector('.btns').remove(); }
      break;
    }
    case 'request.cancel':
      addNote('Demande annulée' + (p.reason ? ' (' + p.reason + ')' : '')); break;
  }
}

function onChatRequest(frame) {
  const c = state.chat; if (!c) return;
  const prm = frame.params || {};
  if (frame.method === 'approval' || frame.method === 'approval.request') return showApproval({ ...prm, _rpcId: frame.id });
  addNote(`Le bot attend une réponse « ${frame.method} » : réponds-y depuis le desktop.`);
}

export async function openBot(name) {
  const bot = state.bots.find((b) => b.name === name); if (!bot) return;
  closeChat();
  ui.posLock = true;
  const c = state.chat = { bot, gw: null, sid: null, busy: false, streamEl: null, tools: new Map(), prompts: new Map(), gen: null, queued: [] };
  $('#chat-name').textContent = botName(bot);
  resetLook();
  restoreDraft();
  $('#bot-edit').hidden = false;
  log().innerHTML = '';
  const cached = store.get(cacheKey(name), []);
  if (cached.length) renderHistory(cached, { cached: true });
  // le cache IndexedDB est plus long (jusqu'à 200 messages affichés) : il remplace le petit cache s'il en sait plus
  idb.get(rowKey(name)).then((saved) => { if (state.chat === c && !c.sid && saved?.rows?.length > cached.length) renderHistory(saved.rows.slice(-HISTORY_PAGE), { cached: true }); });
  $('#chat-sub').textContent = cached.length ? 'mise à jour…' : 'connexion…';
  show('chat');
  history.pushState({ bot: name }, '', '#' + encodeURIComponent(name));
  store.set('last-chat', { kind: 'bot', name, ts: Date.now() });
  await attach(c);
}

export async function attach(c) {
  if (c.attaching) return; // wake + socket close both reconnect: one socket only, or every delta arrives twice
  c.attaching = true;
  const bot = c.bot;
  try {
    const gw = await new Gateway(bot.is_default ? null : bot.name).connect();
    if (state.chat !== c) return gw.close();
    const old = c.gw; c.gw = gw;
    if (old && old !== gw) { old.onEvent = old.onRequest = old.onClose = () => {}; try { old.close(); } catch {} }
    gw.onEvent = (ev) => c.gw === gw && onChatEvent(ev); gw.onRequest = (r) => c.gw === gw && onChatRequest(r);
    gw.onClose = () => { if (state.chat === c && c.gw === gw) scheduleReattach(c); }; // c.gw !== gw : une reconnexion (online, retour d'onglet) a déjà eu lieu
    // Identity is (profile, title "Bot Chat"), resolved every time; never a stored session id.
    let stored = bot.canonical_session?.resolved_id || bot.canonical_session?.id || null;
    if (!stored) {
      const found = await gw.call('session.list', { title: CANONICAL_TITLE, include_hidden: true, limit: 5 });
      const row = (found.sessions || []).find((s) => (s.root_title || s.title) === CANONICAL_TITLE) || null;
      stored = row?.resolved_id || row?.id || null;
    }
    let snap;
    if (stored) snap = await gw.call('session.resume', { session_id: stored, omit_messages: true }, 120000);
    else {
      // request_id makes the create idempotent on the gateway (same id -> same session).
      const ids = store.get('create-ids', {});
      ids[bot.name] = ids[bot.name] || (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(16) + Math.random().toString(16).slice(2));
      store.set('create-ids', ids);
      snap = await gw.call('session.create', { title: CANONICAL_TITLE, hidden: true, source: 'gui', request_id: ids[bot.name] });
    }
    c.sid = snap.session_id; c.durable = stored || snap.session_key || null;
    let msgs = snap.messages;
    if ((!msgs || !msgs.length || snap.messages_omitted) && c.sid) {
      try { msgs = await loadHistory(c); } catch (e) { if (e instanceof AuthError) throw e; }
    }
    // sans historique lisible, on garde le fil déjà affiché (cache) au lieu de l'effacer, et le cache avec
    if (Array.isArray(msgs)) renderHistory(msgs); else addNote('Historique indisponible pour l’instant : affichage depuis le téléphone.');
    setBusy(!!snap.running);
    if (Number.isInteger(snap.execution_generation)) c.gen = snap.execution_generation;
    if (snap.pending_approval) showApproval(snap.pending_approval);
    for (const pr of snap.prompts || []) pr.kind === 'clarify' ? showClarify(pr) : !c.prompts.has(pr.prompt_id) && showApproval(pr);
    for (const pr of snap.prompts || []) if (pr.kind === 'approval' && !c.prompts.has(pr.prompt_id)) showApproval(pr);
    seen[bot.name] = Date.now() / 1000; store.set('seen', seen);
    markMentionsSeen(bot.name);
    c.failNoted = false;
    clearTimeout(c.retryTimer); c.retryTimer = null;
    if (c.retries) flashState(c, 'à jour');
    c.retries = 0;
    flushOutbox(c);
  } catch (e) {
    if (e instanceof AuthError) { location.href = LOGIN_URL; return; }
    if (!c.failNoted) { c.failNoted = true; addNote('Connexion impossible : ' + e.message + ' (nouvel essai avec recul progressif)'); }
    scheduleReattach(c);
  } finally { c.attaching = false; }
}

// Reconnexion avec recul progressif (1, 2, 5, 10, 30 s) et un état lisible dans l'en-tête : hors ligne, reconnexion, à jour.
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
function scheduleReattach(c) {
  if (c.retryTimer) return;
  const n = c.retries = (c.retries || 0) + 1, d = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)];
  $('#chat-sub').classList.remove('work');
  $('#chat-sub').textContent = navigator.onLine === false ? 'hors ligne' : `reconnexion dans ${d / 1000} s (essai ${n})`;
  c.retryTimer = setTimeout(() => { c.retryTimer = null; if (state.chat === c && c.gw?.ws?.readyState !== 1) attach(c); }, d);
}
function flashState(c, text) {
  $('#chat-sub').textContent = text;
  setTimeout(() => { if (state.chat === c && $('#chat-sub').textContent === text) $('#chat-sub').textContent = c.busy ? 'travaille…' : (c.bot.model || c.bot.description || ''); }, 2500);
}

// Stop the running turn. The gateway only interrupts its current generation; a stale one
// (turn ended, a queued prompt started, events missed) is refreshed from session.resume, once.
export async function stopTurn(c) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await c.gw.call('session.interrupt', { session_id: c.sid, execution_generation: c.gen }, 30000); return; }
    catch (err) {
      if (!/stale_generation/.test(err.message) || attempt) { addNote('Arrêt échoué : ' + err.message); return; }
      let snap;
      try { snap = await c.gw.call('session.resume', { session_id: c.sid, omit_messages: true }, 30000); }
      catch (e) { addNote('Arrêt échoué : ' + e.message); return; }
      if (state.chat !== c) return;
      if (Number.isInteger(snap.execution_generation)) c.gen = snap.execution_generation;
      if (!snap.running) { // nothing left to stop: the turn already ended
        c.streamEl?.classList.remove('cursor'); c.streamEl = null; setBusy(false);
        try { renderHistory(await loadHistory(c)); } catch {}
        return;
      }
    }
  }
}

// A turn can end while the phone sleeps (socket kept but events lost): ask the gateway.
export async function resyncBusy(c) {
  if (!c?.gw || !c.sid) return;
  try {
    const snap = await c.gw.call('session.resume', { session_id: c.sid, omit_messages: true }, 30000);
    if (state.chat !== c) return;
    if (Number.isInteger(snap.execution_generation)) c.gen = snap.execution_generation;
    if (!snap.running && c.busy) {
      c.streamEl?.classList.remove('cursor'); c.streamEl = null; setBusy(false);
      try { renderHistory(await loadHistory(c)); } catch {}
    }
  } catch {}
}
// Watchdog: busy with no event for 45 s, check with the gateway.
setInterval(() => { const c = state.chat; if (c?.busy && !document.hidden && Date.now() - (c.lastEvent || 0) > 45000) { c.lastEvent = Date.now(); resyncBusy(c); } }, 15000);

export function closeChat() {
  clearReply();
  closeFind();
  savePos(); store.set('scroll-pos', scrollPos);
  if (state.group) markMentionsSeen('room:' + state.group.room.room_id); else if (state.chat) markMentionsSeen(state.chat.bot.name);
  if (state.chat) { state.chat.gw?.close(); state.chat = null; }
  closeGroup();
}
