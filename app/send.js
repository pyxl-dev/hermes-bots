// @ts-check
// Envoi d'un message : direct, en file, guidage.

import { showAttached } from './attachments.js';
import { setBusy } from './chat.js';
import { updateSendBtn } from './composer.js';
import { chatUp, isLinkErr, outboxAdd } from './outbox.js';
import { addBubble, addNote, scrollDown } from './render.js';
import { saveDraft } from './scroll.js';
import { state } from './state.js';
import { cachePush } from './store.js';
import { $, newSubId } from './util.js';

export async function send(text, opts = {}) {
  const c = state.chat; if (!c) return;
  if (!opts.attachments && /^\/(new|reset)\b/i.test(text)) { addNote('Un Bot Chat est permanent : utilise /compact pour repartir d’un contexte frais.'); return; }
  const submission_id = newSubId();
  const b = addBubble('user', opts.display ?? text); if (opts.files) showAttached(b, opts.files); scrollDown(true);
  const item = { id: submission_id, text, display: opts.display, ts: Date.now(), ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) };
  if (!chatUp(c)) { outboxAdd(c, item, b); return; }
  cachePush(c.bot.name, 'user', opts.display ?? text);
  setBusy(true);
  try {
    const r = await c.gw.call('prompt.submit', { session_id: c.sid, text, submission_id, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) }, 30000);
    if (Number.isInteger(r?.execution_generation)) c.gen = r.execution_generation;
  }
  catch (e) {
    if (isLinkErr(e) && state.chat === c) { outboxAdd(c, item, b); setBusy(false); return; }
    addNote('Envoi échoué : ' + e.message); setBusy(false);
  }
}

export async function queueSend(text, opts = {}) {
  const c = state.chat; if (!c) return;
  const b = addBubble('user', opts.display ?? text); if (opts.files) showAttached(b, opts.files); scrollDown(true);
  const submission_id = newSubId();
  const item = { id: submission_id, text, display: opts.display, ts: Date.now(), ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) };
  if (!chatUp(c)) { outboxAdd(c, item, b); return; }
  b.classList.add('queued'); c.queued.push(b);
  try {
    const r = await c.gw.call('prompt.submit', { session_id: c.sid, text, submission_id, queued: true, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) }, 30000);
    if (r?.status === 'started') { b.classList.remove('queued'); c.queued = c.queued.filter((x) => x !== b); }
  } catch (e) {
    c.queued = c.queued.filter((x) => x !== b);
    if (isLinkErr(e) && state.chat === c) { outboxAdd(c, item, b); return; }
    b.classList.remove('queued'); b.classList.add('err');
    addNote('Mise en file échouée : ' + e.message);
  }
}

export async function steerSend() {
  const c = state.chat, input = $('#input'), text = input.value.trim();
  if (!c || !c.sid || !text) return;
  input.value = ''; input.style.height = 'auto'; saveDraft(); updateSendBtn();
  if (!c.busy || !Number.isInteger(c.gen)) return c.busy ? queueSend(text) : send(text);
  const b = addBubble('user', text); b.classList.add('steering'); scrollDown(true);
  try {
    const r = await c.gw.call('session.steer', { session_id: c.sid, execution_generation: c.gen, text }, 30000);
    if (r?.status === 'rejected') {
      b.remove();
      if (r.delivered === false) { addNote('Le tour venait de finir : message mis en file.'); return c.busy ? queueSend(text) : send(text); }
      addNote('Guidage refusé par l’agent (il a peut-être déjà été lu, je ne le renvoie pas).');
    }
  } catch (e) { b.classList.remove('steering'); b.classList.add('err'); addNote('Guidage échoué : ' + e.message); }
}
