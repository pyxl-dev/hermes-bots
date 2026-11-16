// @ts-check
// Actions sur un message (appui long).

import { addNote } from './render.js';
import { startReply } from './reply.js';
import { botName } from './roster.js';
import { state } from './state.js';
import { $ } from './util.js';

// ---------- actions sur un message (appui long = contextmenu, comme l'épinglage) ----------
const msgMenu = { bubble: null };
const bubbleText = (b) => String(b._raw ?? b.innerText ?? '').trim();
function closeMsgMenu() { $('#msg-menu').hidden = true; msgMenu.bubble?.classList.remove('menu-on'); msgMenu.bubble = null; }
function openMsgMenu(b, x, y) {
  closeMsgMenu(); msgMenu.bubble = b; b.classList.add('menu-on');
  const m = $('#msg-menu');
  m.querySelector('[data-a=share]').hidden = !navigator.share;
  m.querySelector('[data-a=speak]').hidden = !('speechSynthesis' in window);
  const canReply = state.group ? !!b.dataset.mid : !!state.chat;
  m.querySelector('[data-a=reply]').hidden = !canReply; m.querySelector('[data-a=quote]').hidden = canReply;
  m.querySelector('[data-a=speak] .l').textContent = speechSynthesis?.speaking && speaking === b ? 'Arrêter' : 'Lire';
  const who = b.querySelector('.author')?.textContent || (b.closest('.row.user') ? 'Toi' : state.chat ? botName(state.chat.bot) : ''), ts = b.parentElement?.querySelector('.ts')?.textContent || '';
  $('#mm-who').textContent = [who, ts].filter(Boolean).join(' · ');
  const t = bubbleText(b); $('#mm-prev').textContent = t.length > 500 ? t.slice(0, 500) + '…' : t;
  m.hidden = false;
  try { navigator.vibrate?.(15); } catch {}
}
let speaking = null;
function speak(b) {
  if (!('speechSynthesis' in window)) return;
  if (speechSynthesis.speaking && speaking === b) { speechSynthesis.cancel(); speaking = null; return; }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(bubbleText(b).replace(/[`*_#>|]/g, ''));
  u.lang = 'fr-FR'; const v = speechSynthesis.getVoices().find((x) => /^fr[-_]FR/i.test(x.lang)); if (v) u.voice = v;
  u.onend = u.onerror = () => { if (speaking === b) speaking = null; };
  speaking = b; speechSynthesis.speak(u);
}
async function msgAction(a) {
  const b = msgMenu.bubble; if (!b) return; const text = bubbleText(b); closeMsgMenu();
  if (a === 'copy') {
    try { await navigator.clipboard.writeText(text); addNote('Message copié.'); } catch (e) { addNote('Copie impossible : ' + e.message); }
  } else if (a === 'share') {
    try { await navigator.share({ text }); } catch (e) { if (e.name !== 'AbortError') addNote('Partage impossible : ' + e.message); }
  } else if (a === 'speak') speak(b);
  else if (a === 'reply') startReply(b);
  else if (a === 'quote') {
    const i = $('#input'), q = text.split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
    i.value = i.value ? i.value.replace(/\s*$/, '\n\n') + q : q;
    i.dispatchEvent(new Event('input')); i.focus(); i.setSelectionRange(i.value.length, i.value.length);
  }
}
$('#log').addEventListener('contextmenu', (e) => {
  const b = e.target.closest('.bubble'); if (!b) return;
  e.preventDefault(); openMsgMenu(b, e.clientX, e.clientY);
});
$('#msg-menu').addEventListener('click', (e) => { const a = e.target.closest('[data-a]')?.dataset.a; if (a) msgAction(a); else if (e.target.classList.contains('mm-back')) closeMsgMenu(); });
document.addEventListener('pointerdown', (e) => { if (!$('#msg-menu').hidden && !/** @type {any} */ (e.target).closest('.mm-sheet')) closeMsgMenu(); }, true);
$('#log').addEventListener('scroll', closeMsgMenu, { passive: true });
