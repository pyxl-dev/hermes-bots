// @ts-check
// Navigation entre les vues, appui long, retour.

import { closeChat, openBot } from './chat.js';
import { openGroup, renderGroups } from './groups.js';
import { togglePin } from './prefs.js';
import { loadRoster, renderRoster } from './roster.js';
import { state } from './state.js';
import { store } from './store.js';
import { $ } from './util.js';

// ---------- view plumbing ----------
export function show(v) { $('#roster').hidden = v !== 'roster'; $('#chat').hidden = v !== 'chat'; $('#settings').hidden = v !== 'settings'; }

export const pinGuard = { at: 0 }; // the click that follows a long-press must not open the chat
$('#bots').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('.bot'); if (!li) return;
  e.preventDefault(); pinGuard.at = Date.now();
  togglePin(li.dataset.name);
});
$('#pins').addEventListener('contextmenu', (e) => {
  const t = e.target.closest('.pin-tile'); if (!t) return;
  e.preventDefault(); pinGuard.at = Date.now();
  togglePin(t.dataset.room ? 'room:' + t.dataset.room : t.dataset.name);
});
$('#pins').addEventListener('click', (e) => {
  if (Date.now() - pinGuard.at < 700) return;
  const t = e.target.closest('.pin-tile'); if (!t) return;
  if (t.dataset.room) openGroup(t.dataset.room); else openBot(t.dataset.name);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
});
$('#chat-who').addEventListener('click', () => { const b = state.group ? $('#group-settings') : $('#bot-edit'); if (!b.hidden) b.click(); });
$('#bots').addEventListener('click', (e) => {
  if (Date.now() - pinGuard.at < 700) return;
  const li = e.target.closest('.bot'); if (li) openBot(li.dataset.name);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
});
$('#q').addEventListener('input', () => { renderRoster(); renderGroups(); });
$('#back').addEventListener('click', () => history.back());
window.addEventListener('popstate', () => { if (!location.hash) { store.set('last-chat', null); closeChat(); show('roster'); loadRoster(); } });
