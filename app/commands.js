// @ts-check
// Commandes slash à confirmation (/undo, /model, /reload-mcp).

import { SYNC_PAGE, fetchPage, loadHistory, renderHistory } from './history.js';
import { addBubble, addNote, scrollDown } from './render.js';
import { log } from './util.js';

// Commandes slash à confirmation (/reload-mcp, /undo, /model vers un modèle cher). En texte, la
// confirmation du gateway attend une réponse /approve que la file des messages ne lui transmet pas
// (garde volontaire : un tour admis ne répond pas à un prompt). On fait comme le desktop : carte à
// boutons, puis l'appel RPC direct.
function confirmCard(c, { title, q, buttons, run }) {
  const box = document.createElement('div'); box.className = 'approval';
  const t = document.createElement('div'); t.className = 't'; t.textContent = title; box.appendChild(t);
  if (q) { const d = document.createElement('div'); d.className = 'q'; d.textContent = q; box.appendChild(d); }
  const btns = document.createElement('div'); btns.className = 'btns'; box.appendChild(btns);
  for (const b of buttons) {
    const el = document.createElement('button'); el.type = 'button'; el.dataset.c = b.c; el.textContent = b.label;
    if (b.cls) el.className = b.cls; btns.appendChild(el);
  }
  btns.addEventListener('click', async (ev) => {
    const choice = /** @type {any} */ (ev.target)?.dataset?.c; if (!choice) return;
    btns.querySelectorAll('button').forEach((x) => (x.disabled = true));
    try {
      const msg = await run(choice);
      btns.remove(); const a = document.createElement('div'); a.className = 'a'; a.textContent = msg; box.appendChild(a);
    } catch (e) { btns.querySelectorAll('button').forEach((x) => (x.disabled = false)); addNote('Échec : ' + e.message); }
  });
  log().appendChild(box); scrollDown(true);
}

function reloadMcp(c, text) {
  addBubble('user', text); scrollDown(true);
  confirmCard(c, {
    title: 'Recharger les serveurs MCP ?',
    q: 'Les outils du bot sont reconstruits. Le prochain message renvoie tout le contexte au modèle, ce qui coûte plus cher sur les longues conversations.',
    buttons: [{ c: 'once', label: 'Recharger', cls: 'yes' }, { c: 'always', label: 'Toujours, sans demander' }, { c: 'cancel', label: 'Annuler', cls: 'no' }],
    run: async (choice) => {
      if (choice === 'cancel') return 'Annulé : outils inchangés.';
      const r = await c.gw.call('reload.mcp', { session_id: c.sid, confirm: true, always: choice === 'always' }, 120000);
      const st = r?.status || 'fait';
      return st === 'reloaded' ? 'Serveurs MCP rechargés.' + (choice === 'always' ? ' Plus de confirmation à l’avenir.' : '') : 'Résultat : ' + st;
    },
  });
}

// Le vrai gateway n'expose ni session.undo ni config.set model : les deux passent par session.mutate,
// gardé par la révision et la génération du moment (relues juste avant).
async function mutate(c, operation, payload) {
  const snap = await c.gw.call('session.resume', { session_id: c.sid, omit_messages: true }, 30000);
  if (Number.isInteger(snap?.execution_generation)) c.gen = snap.execution_generation;
  const request_id = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  return c.gw.call('session.mutate', { session_id: c.sid, request_id, expected_revision: snap?.revision, expected_generation: snap?.execution_generation, operation, payload }, 120000);
}
const mutateErr = (e) => { const k = String(e?.message || '').split(' : ').pop().trim(); return ({ model_resolution_failed: 'modèle inconnu', session_busy: 'le bot travaille encore', stale_revision: 'la conversation a changé entre-temps, réessaie' }[k] || k || 'erreur'); };

function undoTurn(c, text) {
  if (c.busy) { addNote('Le bot répond encore : arrête-le avant /undo.'); return; }
  addBubble('user', text); scrollDown(true);
  confirmCard(c, {
    title: 'Annuler le dernier échange ?',
    q: 'Ton dernier message et la réponse du bot sont retirés de la conversation. Impossible à rattraper.',
    buttons: [{ c: 'once', label: 'Retirer l’échange', cls: 'yes' }, { c: 'cancel', label: 'Garder', cls: 'no' }],
    run: async (choice) => {
      if (choice === 'cancel') return 'Annulé : conversation inchangée.';
      // La dernière page paginée suffit (même id de ligne que session.history, qui renvoyait tout le fil : 38 Mo sur Hermes).
      const before = await fetchPage(c, { limit: String(SYNC_PAGE) });
      const target = [...before].reverse().find((m) => m.role === 'user' && Number.isInteger(m.row_id));
      if (!target) return 'Rien à retirer.';
      try { await mutate(c, 'rewind', { target_message_id: target.row_id }); }
      catch (e) { throw new Error(mutateErr(e)); }
      const removed = before.filter((m) => Number.isInteger(m.row_id) && m.row_id >= target.row_id).length;
      const after = await loadHistory(c);
      const msg = `Dernier échange retiré (${Math.max(removed, 1)} messages).`;
      // L'historique rechargé remplace la carte : le résultat part en note, après lui.
      renderHistory(after); addNote(msg);
      return msg;
    },
  });
}

async function switchModel(c, text, arg) {
  addBubble('user', text); scrollDown(true);
  const done = (r) => 'Modèle de ce chat : ' + (r?.model || r?.target_model || arg) + '.';
  let r;
  try { r = await mutate(c, 'model', { model: arg }); } catch (e) { addNote('Changement de modèle échoué : ' + mutateErr(e)); return; }
  if (r?.status !== 'confirmation_required') { addNote(done(r)); return; }
  confirmCard(c, {
    title: 'Passer sur ' + (r.target_model || arg) + ' ?',
    q: r.confirm_message || 'Ce modèle coûte plus cher.',
    buttons: [{ c: 'once', label: 'Confirmer', cls: 'yes' }, { c: 'cancel', label: 'Annuler', cls: 'no' }],
    run: async (choice) => {
      if (choice === 'cancel') return 'Annulé : modèle inchangé.';
      try { return done(await mutate(c, 'model', { model: arg, confirm: r.confirm })); } catch (e) { throw new Error(mutateErr(e)); }
    },
  });
}

// Renvoie true si la commande a été prise en charge ici.
export function slashConfirm(c, text) {
  if (/^\/reload-mcp\b/i.test(text)) { reloadMcp(c, text); return true; }
  if (/^\/undo\s*$/i.test(text)) { undoTurn(c, text); return true; }
  const m = text.match(/^\/model\s+(\S[\s\S]*)$/i);
  if (m) { switchModel(c, text, m[1].trim()); return true; }
  return false;
}
