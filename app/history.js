// @ts-check
// Historique : cache IndexedDB par bot, synchronisation incrémentale, pages plus anciennes.

import { find, runFind } from './find.js';
import { AuthError, LOGIN_URL } from './gateway.js';
import { renderOutbox } from './outbox.js';
import { TASK_RE, addBubble, addTask, addTool, fold, quiet, setToolState } from './render.js';
import { convKey, restorePos, savePos } from './scroll.js';
import { state, ui } from './state.js';
import { cacheKey, cacheSave, idb, rowId, rowKey, store } from './store.js';
import { $, SYNTHETIC_KINDS, apiErr, asText, esc, isSilent, log, looksSynthetic, report } from './util.js';

// ---------- historique : cache IndexedDB par bot, synchronisation incrémentale, pages plus anciennes ----------
// Seule la dernière page est chargée (session.resume et session.history renvoient tout, ancêtres compris : la Bot Chat de
// Hermes, 18 000 messages et ~38 Mo, ne passait plus sur le téléphone, 2026-11-14). La route REST paginée est celle de l'app de
// bureau ; elle n'expose ni after_id ni before_id (incompatibles avec include_ancestors) : on lit limit, offset et order.
// Cache : les lignes du serveur (avec leur id) restent sur le téléphone ; à l'ouverture on affiche le cache, puis on ne demande
// qu'une petite page des derniers messages, qu'on recolle au cache par id.
export const HISTORY_PAGE = 200, SYNC_PAGE = 40, OLDER_PAGE = 100, IDB_KEEP = 2000;

export function renderHistory(...args) { return quiet(() => renderHistory0(...args)); }
function renderHistory0(messages, opts = {}) {
  if (!opts.cached && !opts.older && state.chat) cacheSave(state.chat.bot.name, messages);
  savePos(); ui.posLock = true; // re-render keeps your place (restored below)
  find.hits = []; find.cur = -1;
  log().innerHTML = '';
  for (const m of messages || []) {
    const text = asText(m.text ?? m.content);
    if (SYNTHETIC_KINDS.has(m.display_kind)) continue;
    if (m.role === 'user') { const tk = TASK_RE.exec(text); if (tk) addTask(tk[1], tk[2], m.timestamp); else if (!looksSynthetic(text)) addBubble('user', text, { ts: m.timestamp }); }
    else if (m.role === 'assistant') { if (text.trim() && !isSilent(text)) fold(addBubble('assistant', text, { ts: m.timestamp })); }
    else if (m.role === 'tool') { const t = addTool(m.tool_call_id, m.name || m.tool_name || 'outil', ''); setToolState(t, 'done'); if (text) t.insertAdjacentHTML('beforeend', '<pre>' + esc(text.slice(0, 4000)) + '</pre>'); }
  }
  if (state.chat && !state.group) renderOutbox(state.chat, opts.cached || opts.older ? null : messages);
  const k = convKey(); if (opts.older) {} else if (k) restorePos(k); else ui.posLock = false;
  if (!$('#find-bar').hidden && $('#find-q').value.trim()) setTimeout(runFind, 400); // la recherche ouverte suit le fil rechargé
}

function slimRow(m) {
  return { id: rowId(m), row_id: rowId(m), role: m.role, text: asText(m.text ?? m.content).slice(0, 20000), name: m.name || m.tool_name, tool_call_id: m.tool_call_id, timestamp: m.timestamp, display_kind: m.display_kind };
}
export async function fetchPage(c, params) {
  const id = c.durable || c.sid;
  const q = new URLSearchParams({ order: 'latest', inline_images: 'false', ...params });
  if (!c.bot.is_default) q.set('profile', c.bot.name);
  const r = await fetch('/api/sessions/' + encodeURIComponent(id) + '/messages?' + q, { credentials: 'same-origin' });
  if (r.status === 401 || r.status === 403) throw new AuthError('login');
  if (!r.ok) throw await apiErr(r);
  return ((await r.json()).messages || []).map((m) => ({ ...m, text: m.display_content ?? m.content, row_id: rowId(m) }));
}
// Renvoie la fenêtre à afficher (les HISTORY_PAGE derniers messages) ; c.rows en garde la liste, c.moreOlder dit s'il reste du passé.
export async function loadHistory(c) {
  try {
    const key = rowKey(c.bot.name), saved = await idb.get(key);
    let cached = saved && saved.sid === (c.durable || c.sid) && Array.isArray(saved.rows) ? saved.rows.filter((m) => Number.isInteger(m.id)) : [];
    const lastId = cached.length ? cached[cached.length - 1].id : null;
    let page = await fetchPage(c, { limit: String(lastId === null ? HISTORY_PAGE : SYNC_PAGE) });
    let rows;
    const overlap = lastId !== null && page.some((m) => m.id === lastId);
    if (overlap) rows = cached.filter((m) => m.id <= lastId).concat(page.filter((m) => m.id > lastId).map(slimRow)); // le cas courant : quelques nouveaux messages
    else {
      if (page.length === SYNC_PAGE && lastId !== null) page = await fetchPage(c, { limit: String(HISTORY_PAGE) }); // trop de nouveautés, ou fil réécrit (undo, compaction)
      const ov = lastId !== null && page.some((m) => m.id === lastId);
      rows = ov ? cached.filter((m) => m.id <= lastId).concat(page.filter((m) => m.id > lastId).map(slimRow)) : page.map(slimRow);
      c.moreOlder = page.length >= HISTORY_PAGE;
    }
    if (overlap) c.moreOlder = rows.length >= HISTORY_PAGE || !!saved?.more;
    c.rows = rows;
    idb.put(key, { sid: c.durable || c.sid, rows: rows.slice(-IDB_KEEP), more: !!c.moreOlder });
    return rows.slice(-HISTORY_PAGE);
  } catch (e) {
    if (e instanceof AuthError) throw e;
    // Repli : le cache du téléphone. Plus jamais session.history, qui renvoie tout le fil (38 Mo sur la conversation Hermes).
    c.rows = null; c.moreOlder = false;
    report('rpc', 'historique paginé indisponible : ' + (e?.message || e), 'loadHistory');
    const saved = await idb.get(rowKey(c.bot.name));
    const rows = saved?.sid === (c.durable || c.sid) && Array.isArray(saved.rows) && saved.rows.length ? saved.rows : store.get(cacheKey(c.bot.name), []);
    if (!rows.length) throw e;
    return rows.slice(-HISTORY_PAGE);
  }
}
// Remonter le fil : la page plus ancienne est lue (offset = lignes déjà connues, depuis le plus récent), collée en tête, et la
// position de lecture est conservée.
export async function loadOlder(c) {
  if (c.olderBusy || !c.moreOlder || !c.rows?.length) return;
  c.olderBusy = true;
  try {
    const first = c.rows[0].id;
    const page = await fetchPage(c, { limit: String(OLDER_PAGE), offset: String(c.rows.length) });
    if (state.chat !== c) return;
    const older = page.filter((m) => m.id < first).map(slimRow);
    c.moreOlder = page.length >= OLDER_PAGE && older.length > 0;
    if (!older.length) return;
    c.rows = older.concat(c.rows);
    idb.put(rowKey(c.bot.name), { sid: c.durable || c.sid, rows: c.rows.slice(-IDB_KEEP), more: !!c.moreOlder });
    const el = log(), h0 = el.scrollHeight, t0 = el.scrollTop;
    renderHistory(c.rows, { older: true });
    el.scrollTop = el.scrollHeight - h0 + t0; ui.posLock = false;
  } catch (e) { if (e instanceof AuthError) location.href = LOGIN_URL; } // le prochain défilement réessaie ; l'échec est remonté par report.js si c'est un rejet
  finally { c.olderBusy = false; }
}
$('#log').addEventListener('scroll', () => { const c = state.chat; if (c && !state.group && !ui.posLock && $('#log').scrollTop < 400) loadOlder(c); }, { passive: true });
