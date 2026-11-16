// @ts-check
// Partage Android (share_target).

import { avatarHtml, groupAvatarHtml } from './avatars.js';
import { openBot } from './chat.js';
import { openGroup } from './groups.js';
import { isPinned } from './prefs.js';
import { botName, isHidden } from './roster.js';
import { prefs, state } from './state.js';
import { store } from './store.js';
import { $, esc } from './util.js';

// ---------- partage Android (share_target GET : title, text, url) ----------
// Le texte reçu est rangé comme brouillon de la destination choisie : il apparaît dans le composeur, jamais envoyé.
export function sharedText() {
  const q = new URLSearchParams(location.search), parts = [];
  for (const k of ['title', 'text', 'url']) { const v = (q.get(k) || '').trim(); if (v && !parts.some((p) => p.includes(v))) parts.push(v); }
  return parts.join('\n');
}
export function openShare(text) {
  $('#sh-text').textContent = text.length > 600 ? text.slice(0, 600) + '…' : text;
  const box = $('#sh-list'); box.innerHTML = '';
  const dest = (key, open) => () => {
    const old = store.get('draft:' + key, '') || '';
    store.set('draft:' + key, old.trim() ? old.replace(/\s*$/, '\n\n') + text : text);
    $('#share-dlg').close(); open();
  };
  const rows = [
    ...(state.groups || []).filter((r) => !r.disbanded_at).map((r) => ({ key: 'room:' + r.room_id, label: r.name, kind: 'groupe', av: (s) => groupAvatarHtml(r.members.map((m) => m.profile), s), open: () => openGroup(r.room_id) })),
    ...state.bots.filter((b) => !isHidden(b)).map((b) => ({ key: b.name, label: botName(b), kind: '', av: (s) => avatarHtml(b.name, s), open: () => openBot(b.name) })),
  ];
  const pins = prefs.pinned.map((k) => rows.find((r) => r.key === k)).filter(Boolean), rest = rows.filter((r) => !isPinned(r.key));
  const head = (t) => { const h = document.createElement('h4'); h.textContent = t; box.append(h); };
  if (pins.length) {
    head('Épinglés');
    const wrap = document.createElement('div'); wrap.className = 'shp';
    for (const r of pins) { const b = document.createElement('button'); b.type = 'button'; b.innerHTML = r.av(62) + `<span class="tn">${esc(r.label)}</span>`; b.addEventListener('click', dest(r.key, r.open)); wrap.append(b); }
    box.append(wrap);
  }
  if (rest.length) {
    head('Tous');
    for (const r of rest) { const b = document.createElement('button'); b.type = 'button'; b.className = 'shr'; b.innerHTML = r.av(42) + `<span class="tn">${esc(r.label)}</span><span class="k">${r.kind}</span>`; b.addEventListener('click', dest(r.key, r.open)); box.append(b); }
  }
  if (!box.children.length) box.innerHTML = '<p class="msg small">Aucun bot disponible : ouvre l’app, puis repartage.</p>';
  $('#share-dlg').showModal();
}
$('#sh-cancel').addEventListener('click', () => $('#share-dlg').close());
