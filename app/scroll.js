// @ts-check
// Boutons de saut, position de lecture par conversation, brouillons.

import { updateSendBtn } from './composer.js';
import { state, ui } from './state.js';
import { store } from './store.js';
import { $, log } from './util.js';

// ---------- jump buttons ----------
function updateJump() {
  const el = log(), far = el.scrollHeight - el.scrollTop - el.clientHeight > 300;
  $('#to-bottom').hidden = !far;
  $('#prev-prompt').hidden = !el.querySelector('.row.user') || el.scrollTop < 40;
}
function prevPrompt() {
  const el = log(), top = el.getBoundingClientRect().top;
  const users = [...el.querySelectorAll('.row.user')];
  const target = users.reverse().find((r) => r.getBoundingClientRect().top < top - 8);
  if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  else el.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#log').addEventListener('scroll', updateJump, { passive: true });

// ---------- per-conversation scroll position: reopen where you left; bottom the first time or if you were at the bottom ----------
export const scrollPos = store.get('scroll-pos') || {};
let posSaveTimer = null;
export function convKey() { return state.group ? 'room:' + state.group.room.room_id : state.chat ? state.chat.bot.name : null; }
// ---------- brouillons : le texte du composeur est gardé par conversation ----------
export function saveDraft() {
  const k = convKey(); if (!k) return;
  const v = $('#input').value;
  if (v.trim()) store.set('draft:' + k, v); else try { localStorage.removeItem('draft:' + k); } catch {}
}
export function restoreDraft() {
  const k = convKey(), i = $('#input'); if (!k) return;
  i.value = store.get('draft:' + k, '') || ''; i.style.height = 'auto'; if (i.value) i.style.height = i.scrollHeight + 'px';
  updateSendBtn();
}
export function savePos() {
  const k = convKey(); if (ui.posLock || !k) return;
  const el = log(); if (!el.clientHeight) return;
  scrollPos[k] = { top: Math.round(el.scrollTop), bottom: el.scrollHeight - el.scrollTop - el.clientHeight < 80 };
  clearTimeout(posSaveTimer); posSaveTimer = setTimeout(() => store.set('scroll-pos', scrollPos), 400);
}
export function restorePos(k) {
  ui.posLock = true;
  const apply = () => { const el = log(), p = scrollPos[k]; el.scrollTop = !p || p.bottom ? el.scrollHeight : p.top; };
  // folds collapse long messages a frame later: apply twice, then let scrolling be recorded again
  requestAnimationFrame(() => requestAnimationFrame(() => { apply(); setTimeout(() => { if (convKey() === k) apply(); ui.posLock = false; updateJump(); }, 350); }));
}
$('#log').addEventListener('scroll', savePos, { passive: true });
new MutationObserver(updateJump).observe($('#log'), { childList: true });
$('#to-bottom').addEventListener('click', () => { const el = log(); el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }); });
$('#prev-prompt').addEventListener('click', prevPrompt);
