// @ts-check
// Validations de commandes et questions du bot.

import { addNote, md, scrollDown } from './render.js';
import { notify } from './settings.js';
import { state } from './state.js';
import { esc, log } from './util.js';

export function showApproval(p) {
  const c = state.chat; if (!c) return;
  const box = document.createElement('div'); box.className = 'approval';
  const choices = (p.choices && p.choices.length ? p.choices : ['once', 'session', 'deny']).map((x) => (typeof x === 'string' ? x : x.value || x.id || x));
  const label = { once: 'Autoriser une fois', session: 'Pour la session', always: 'Toujours', deny: 'Refuser' };
  box.innerHTML = `<div class="t">Validation demandée${p.tool_name ? ' · ' + esc(p.tool_name) : ''}</div>
    ${p.description ? '<div>' + esc(p.description) + '</div>' : ''}${p.command ? '<pre>' + esc(p.command) + '</pre>' : ''}
    <div class="btns">${choices.map((ch) => `<button data-c="${esc(ch)}" class="${ch === 'deny' ? 'no' : ch === 'once' ? 'yes' : ''}">${esc(label[ch] || ch)}</button>`).join('')}</div>`;
  box.addEventListener('click', async (ev) => {
    const ch = /** @type {any} */ (ev.target)?.dataset?.c; if (!ch) return;
    box.querySelectorAll('button').forEach((b) => (b.disabled = true));
    try {
      if (p._rpcId !== undefined) c.gw.reply(p._rpcId, { choice: ch });
      else await c.gw.call('approval.respond', { session_id: c.sid, execution_generation: Number.isInteger(p.execution_generation) ? p.execution_generation : c.gen, prompt_id: p.prompt_id || p.request_id, choice: ch });
      box.querySelector('.t').textContent = 'Réponse envoyée : ' + (label[ch] || ch);
      box.querySelector('.btns').remove();
    } catch (e) { box.querySelectorAll('button').forEach((b) => (b.disabled = false)); addNote('Échec : ' + e.message); }
  });
  if (p.prompt_id) c.prompts.set(p.prompt_id, box);
  log().appendChild(box); scrollDown(true);
  if (document.hidden) notify(c.bot, 'Validation demandée' + (p.command ? ' : ' + p.command.slice(0, 80) : ''));
}

// Clarify: the bot asks Yoan a question (choices, multi-select or free text) and waits for the answer.
export function showClarify(p) {
  const c = state.chat; if (!c || !p?.prompt_id || c.prompts.has(p.prompt_id)) return;
  const box = document.createElement('div'); box.className = 'approval clarify';
  const choices = (p.choices || []).map(String), multi = !!p.multi_select && choices.length > 0;
  box.innerHTML = `<div class="t">Question</div><div class="q">${md(p.question || '')}</div>
    <div class="btns${multi ? ' multi' : ''}">${choices.map((ch, i) => `<button type="button" data-i="${i}" class="${multi ? 'opt' : i === 0 ? 'yes' : ''}">${esc(ch)}</button>`).join('')}</div>
    <form class="other"><input type="text" placeholder="${choices.length ? 'Autre réponse…' : 'Ta réponse…'}" enterkeyhint="send"><button type="submit" class="yes">${multi ? 'Valider' : 'Envoyer'}</button></form>
    <button type="button" class="skip">Passer</button>`;
  const picked = new Set();
  const finish = async (answer, label) => {
    box.querySelectorAll('button, input').forEach((/** @type {any} */ b) => (b.disabled = true));
    try {
      await c.gw.call('clarify.respond', { session_id: c.sid, execution_generation: Number.isInteger(p.execution_generation) ? p.execution_generation : c.gen, prompt_id: p.prompt_id, answer });
      settleClarify(box, 'Réponse envoyée : ' + label);
    } catch (e) { box.querySelectorAll('button, input').forEach((/** @type {any} */ b) => (b.disabled = false)); addNote('Échec : ' + e.message); }
  };
  box.querySelector('.btns').addEventListener('click', (ev) => {
    const i = /** @type {any} */ (ev.target)?.dataset?.i; if (i === undefined) return;
    if (!multi) return finish(choices[i], choices[i]);
    picked.has(i) ? picked.delete(i) : picked.add(i); /** @type {any} */ (ev.target).classList.toggle('on', picked.has(i));
  });
  box.querySelector('.other').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const typed = /** @type {any} */ (box.querySelector('.other input')).value.trim();
    if (multi) {
      const list = [...picked].sort().map((i) => choices[i]).concat(typed ? [typed] : []);
      if (list.length) finish(JSON.stringify(list), list.join(', '));
    } else if (typed) finish(typed, typed);
  });
  box.querySelector('.skip').addEventListener('click', () => finish('', 'passée'));
  c.prompts.set(p.prompt_id, box);
  log().appendChild(box); scrollDown(true);
  if (document.hidden) notify(c.bot, 'Question : ' + String(p.question || '').slice(0, 120));
}
export function settleClarify(box, text) {
  if (!box || !box.querySelector('.btns')) return;
  box.querySelectorAll('.btns, .other, .skip').forEach((el) => el.remove());
  const a = document.createElement('div'); a.className = 'a'; a.textContent = text; box.appendChild(a); // answer under the question
}
