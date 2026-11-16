// @ts-check
// Zone de saisie : bouton envoyer/stop, dictée, soumission.

import { sendWithFiles, staged } from './attachments.js';
import { UiBlocks } from './blocks.js';
import { stopTurn } from './chat.js';
import { slashConfirm } from './commands.js';
import { can, groupSubmit } from './groups.js';
import { addNote } from './render.js';
import { clearReply, replyPrefix } from './reply.js';
import { saveDraft } from './scroll.js';
import { queueSend, send, steerSend } from './send.js';
import { state } from './state.js';
import { $ } from './util.js';

// While a turn runs: empty composer = Stop, text = queue (send) or steer (busy bar).
export function updateSendBtn() {
  const c = state.chat, g = state.group, typing = !!$('#input').value.trim() || (!g && staged.length > 0);
  const stop = !typing && (g ? !!g.busy && can('groups.stop') : !!(c && c.busy));
  const s = $('#send'); s.classList.toggle('stop', stop);
  s.setAttribute('aria-label', stop ? 'Arrêter' : c?.busy && !g ? 'Mettre en file' : 'Envoyer');
  $('#busy-bar').hidden = !(c && c.busy && !state.group && typing);
  $('#mic').hidden = !SpeechRec || (typing && !dictation);
}

// ---------- dictée vocale (Web Speech API ; le bouton reste masqué si elle manque) ----------
const SpeechRec = /** @type {any} */ (window).SpeechRecognition || /** @type {any} */ (window).webkitSpeechRecognition;
let dictation = null;
function toggleDictation() {
  if (dictation) { dictation.stop(); return; }
  const i = $('#input'), base = i.value, r = new SpeechRec();
  r.lang = 'fr-FR'; r.interimResults = true; r.continuous = false;
  r.onresult = (e) => {
    let t = ''; for (const res of e.results) t += res[0].transcript;
    i.value = (base && !/\s$/.test(base) ? base + ' ' : base) + t;
    i.dispatchEvent(new Event('input')); // taille, brouillon, bouton envoyer
  };
  r.onerror = (e) => { if (e.error !== 'no-speech' && e.error !== 'aborted') addNote('Dictée impossible : ' + (e.error === 'not-allowed' ? 'micro refusé' : e.error)); };
  r.onend = () => { dictation = null; $('#mic').classList.remove('on'); $('#mic').setAttribute('aria-label', 'Dicter'); updateSendBtn(); };
  try { r.start(); } catch (e) { addNote('Dictée impossible : ' + e.message); return; }
  dictation = r; $('#mic').classList.add('on'); $('#mic').setAttribute('aria-label', 'Arrêter la dictée');
}
$('#mic').addEventListener('click', toggleDictation);

const input = $('#input');
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = input.scrollHeight + 'px'; });
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && $('#mention').hidden && !matchMedia('(pointer: coarse)').matches) { e.preventDefault(); $('#composer').requestSubmit(); }
});
$('#input').addEventListener('input', updateSendBtn);
$('#input').addEventListener('input', saveDraft);
// Le brouillon s'enregistre après TOUS les gestionnaires d'envoi : sur un vrai appui, le navigateur vide
// les microtâches entre deux gestionnaires, et un queueMicrotask lisait la zone encore pleine (le message
// envoyé revenait en brouillon). setTimeout passe après le gestionnaire qui vide la zone.
$('#composer').addEventListener('submit', () => setTimeout(saveDraft, 0));

$('#steer').addEventListener('click', steerSend);
// Bouton de choix d'un bloc : part comme un message tapé (file d'attente, groupe, citation), le brouillon reste.
UiBlocks.onChoose = (text) => {
  if (!state.chat && !state.group) return false;
  const draft = input.value; input.value = text; $('#composer').requestSubmit();
  input.value = draft; input.style.height = 'auto'; return true;
};
$('#composer').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.group) { const t = input.value.trim(); input.value = ''; input.style.height = 'auto'; return groupSubmit(t); }
  const c = state.chat; if (!c) return;
  const raw = input.value.trim(), text = raw ? replyPrefix() + raw : raw;
  if (raw) clearReply();
  if (staged.length) { input.value = ''; input.style.height = 'auto'; return sendWithFiles(c, text); }
  if (!text && c.busy) return stopTurn(c);
  if (!text) return;
  input.value = ''; input.style.height = 'auto';
  if (slashConfirm(c, text)) return;
  if (c.busy) queueSend(text); else send(text);
  updateSendBtn();
});
