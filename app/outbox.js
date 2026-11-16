// @ts-check
// File d'envoi hors ligne.

import { addBubble, addNote, quiet, scrollDown } from './render.js';
import { state } from './state.js';
import { cachePush, store } from './store.js';
import { asText, log, toMs } from './util.js';

// ---------- file d'envoi hors ligne ----------
// Socket fermé (ou chat pas encore attaché) au moment d'envoyer : le message va dans une file locale par bot,
// avec son submission_id. Il part à l'attach suivant avec le MÊME id, donc un envoi dont l'accusé s'est perdu
// n'est jamais doublé côté gateway.
const outboxKey = (n) => 'outbox:' + n;
const outboxGet = (n) => store.get(outboxKey(n), []);
function outboxSet(n, list) { if (list.length) store.set(outboxKey(n), list); else try { localStorage.removeItem(outboxKey(n)); } catch {} }

export const isLinkErr = (e) => /non connecté|socket fermé|délai dépassé/.test(String(e?.message || ''));
export const chatUp = (c) => !!c.sid && c.gw?.ws?.readyState === 1;
export function outboxAdd(c, item, bubble) {
  outboxSet(c.bot.name, [...outboxGet(c.bot.name).filter((x) => x.id !== item.id), item]);
  if (bubble) { bubble.classList.remove('queued', 'pending'); bubble.classList.add('outbox'); bubble.dataset.sub = item.id; }
}
function outboxDrop(c, id) { outboxSet(c.bot.name, outboxGet(c.bot.name).filter((x) => x.id !== id)); }
// Appelé après chaque rendu de l'historique : remet les messages en attente sous les bulles reçues.
export function renderOutbox(...args) { return quiet(() => renderOutbox0(...args)); }
function renderOutbox0(c, msgs) {
  const mine = outboxGet(c.bot.name); if (!mine.length) return;
  for (const it of mine) {
    // déjà dans l'historique reçu (accusé perdu, mais le gateway l'a bien admis) : rien à renvoyer
    if (msgs && msgs.some((m) => m.role === 'user' && asText(m.text ?? m.content) === (it.text) && toMs(m.timestamp) >= it.ts - 5000)) { outboxDrop(c, it.id); cachePush(c.bot.name, 'user', it.display ?? it.text); continue; }
    const b = addBubble('user', it.display ?? it.text, { ts: it.ts / 1000 }); b.classList.add('outbox'); b.dataset.sub = it.id;
  }
  scrollDown(true);
}
export async function flushOutbox(c) {
  if (c.flushing) return; c.flushing = true;
  try {
    for (const it of outboxGet(c.bot.name)) {
      if (state.chat !== c || !chatUp(c)) break;
      const b = log().querySelector(`.bubble[data-sub="${CSS.escape(it.id)}"]`);
      const call = (queued) => c.gw.call('prompt.submit', { session_id: c.sid, text: it.text, submission_id: it.id, ...(queued ? { queued: true } : {}), ...(it.attachments?.length ? { attachments: it.attachments } : {}) }, 30000);
      try {
        let r; try { r = await call(!!c.busy); } catch (e) { if (/session_busy/.test(e.message)) r = await call(true); else throw e; }
        if (Number.isInteger(r?.execution_generation)) c.gen = r.execution_generation;
        outboxDrop(c, it.id); cachePush(c.bot.name, 'user', it.display ?? it.text);
        if (b) { b.classList.remove('outbox'); delete b.dataset.sub; if (r?.status === 'queued') { b.classList.add('queued'); c.queued.push(b); } }
      } catch (e) {
        if (isLinkErr(e)) break; // reste en file, repart au prochain attach avec le même id
        outboxDrop(c, it.id); if (b) { b.classList.remove('outbox'); b.classList.add('err'); delete b.dataset.sub; }
        addNote('Envoi échoué : ' + e.message);
      }
    }
  } finally { c.flushing = false; }
}
