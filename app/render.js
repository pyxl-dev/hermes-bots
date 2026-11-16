// @ts-check
// Rendu : markdown, bulles, cartes de tâche, outils, pli des longs messages.

import { avatarOf } from './avatars.js';
import { UiBlocks } from './blocks.js';
import { botName, memberName } from './roster.js';
import { state } from './state.js';
import { esc, log, toMs } from './util.js';

// Minimal, escape-first markdown: fenced code, inline code, bold, italics, links, headings, lists.
// Full GitHub-flavoured Markdown (tables, headings, lists, code) via vendored marked, sanitized by
// DOMPurify before it touches the DOM. Falls back to the tiny renderer if the libs failed to load.
// Blocs ```bots-ui (app/blocks.js) : rendus par l'app, à part du markdown ; le reste passe par marked + DOMPurify.
export function md(src) {
  const text = String(src || '');
  const parts = UiBlocks.split(text);
  const { marked, DOMPurify } = /** @type {any} */ (window);
  const full = !!(marked && DOMPurify);
  const html = parts.map((p) => p.html ?? (full ? DOMPurify.sanitize(marked.parse(p.md, { gfm: true, breaks: true, async: false }),
    { FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe'], FORBID_ATTR: ['style'] }) : mdLite(p.md))).join('');
  const box = document.createElement('div'); box.innerHTML = html;
  for (const a of /** @type {NodeListOf<HTMLAnchorElement>} */ (box.querySelectorAll('a[href]'))) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  for (const t of box.querySelectorAll('table')) { if (t.parentElement.classList.contains('tbl')) continue; const w = document.createElement('div'); w.className = 'tbl'; t.replaceWith(w); w.appendChild(t); }
  markMentions(box);
  UiBlocks.sections(box);
  return box.innerHTML;
}
// @yoan inside prose (not code, not links) becomes a highlighted pill, like a Discord mention.
const ME_RE = /(^|[^\w@.])(@yoan)\b/gi;
function markMentions(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => n.parentElement.closest('code, pre, a') || !/@yoan\b/i.test(n.nodeValue) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    const frag = document.createDocumentFragment(); let last = 0; const v = n.nodeValue;
    v.replace(ME_RE, (m, pre, at, i) => {
      frag.append(v.slice(last, i + pre.length));
      const s = document.createElement('span'); s.className = 'mention-me'; s.textContent = at; frag.append(s);
      last = i + m.length; return m;
    });
    frag.append(v.slice(last)); n.replaceWith(frag);
  }
}
function mdLite(src) {
  const blocks = String(src || '').split(/```/);
  return blocks.map((b, i) => {
    if (i % 2) { const nl = b.indexOf('\n'); return '<pre><code>' + esc(nl >= 0 ? b.slice(nl + 1) : b).replace(/\n$/, '') + '</code></pre>'; }
    const lines = b.split('\n'); let html = '', list = null, para = [];
    const flush = () => { if (para.length) { html += '<p>' + para.join('<br>') + '</p>'; para = []; } };
    const close = () => { if (list) { html += `</${list}>`; list = null; } };
    const inl = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
    for (const line of lines) {
      let m;
      if ((m = line.match(/^\s*[-*•]\s+(.*)/))) { flush(); if (list !== 'ul') { close(); html += '<ul>'; list = 'ul'; } html += '<li>' + inl(m[1]) + '</li>'; }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) { flush(); if (list !== 'ol') { close(); html += '<ol>'; list = 'ol'; } html += '<li>' + inl(m[1]) + '</li>'; }
      else if ((m = line.match(/^#{1,4}\s+(.*)/))) { flush(); close(); html += '<h3>' + inl(m[1]) + '</h3>'; }
      else if (!line.trim()) { flush(); close(); }
      else { close(); para.push(inl(line)); }
    }
    flush(); close(); return html;
  }).join('');
}

export function scrollDown(force) {
  const el = log();
  if (force || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
}
// Message time under each bubble, and a day line when the day changes (history keeps its real times).
function dayLabel(d) {
  const now = new Date(), y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Aujourd’hui';
  if (d.toDateString() === y.toDateString()) return 'Hier';
  return d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}) });
}
// Date et heure sous chaque message (« 14 nov. 20:54 », l'année en plus si ce n'est pas l'année en cours) :
// sans la date, un vieux message à 17:50 se lit comme celui d'aujourd'hui.
function stampText(d) {
  const day = d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
  return day + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function stampRow(row, ts) {
  const ms = toMs(ts) || Date.now(), d = new Date(ms), day = d.toDateString(), el = log();
  const seps = el.querySelectorAll(':scope > .day');
  if (seps[seps.length - 1]?.dataset.day !== day) {
    const sep = document.createElement('div'); sep.className = 'day'; sep.dataset.day = day; sep.textContent = dayLabel(d); el.appendChild(sep);
  }
  const t = document.createElement('time'); t.className = 'ts'; t.dateTime = d.toISOString();
  t.textContent = stampText(d);
  t.title = d.toLocaleString('fr-FR');
  return t;
}
// Messages en direct : glissent vers le haut. Rendu depuis le cache, l'historique ou la file : sans animation.
let noRise = 0;
export const quiet = (fn) => { noRise++; try { return fn(); } finally { noRise--; } };
// Boutons de choix déjà répondus : un groupe de boutons suivi d'un message de Yoan est figé, à chaque rendu
// (direct, cache, historique, groupe rouvert). Le choix retenu est celui dont le texte égale ce premier message.
let settleQueued = false;
function settleChoices() {
  if (settleQueued) return; settleQueued = true;
  requestAnimationFrame(() => {
    settleQueued = false;
    let open = [];
    for (const row of log().children) {
      if (row.classList.contains('user')) {
        if (!open.length) continue;
        const b = row.querySelector('.bubble'), said = String(b?._raw ?? b?.textContent ?? '').trim();
        for (const g of open) for (const x of g.querySelectorAll('.ui-choice')) { x.disabled = true; if (x.dataset.say?.trim() === said) x.classList.add('chosen'); }
        open = [];
      } else for (const g of row.querySelectorAll('.ui-btns')) if (g.querySelector('.ui-choice:not(:disabled)')) open.push(g);
    }
  });
}
new MutationObserver(settleChoices).observe(log(), { childList: true });
export function addRow(row, b, ts) { if (!noRise) row.classList.add('rise'); const t = stampRow(row, ts); row.appendChild(b); row.appendChild(t); log().appendChild(row); return b; }

const REPLY_RE = /^> ↩ @([A-Za-z0-9][A-Za-z0-9._:-]*) : « (.*) »\n\n([\s\S]*)$/;

export function replyExcerpt(t) {
  const s = String(t || '').replace(/```[\s\S]*?```/g, ' ').replace(/[`*_#>|\[\]]/g, '').replace(/\s+/g, ' ').trim();
  return (s.length > 140 ? s.slice(0, 140).replace(/\s\S*$/, '') + '…' : s).replace(/@/g, '@\u200b').replace(/»/g, '"');
}

export function soloWho(handle) {
  const bot = state.chat?.bot, mine = handle.toLowerCase() === 'toi';
  return { name: mine ? 'Toi' : bot ? botName(bot) : '@' + handle, color: mine || !bot ? '#8A8A8A' : avatarOf(bot.name).color };
}

function replyFrame(handle, excerpt) {
  const g = state.group, m = g?.room.members.find((x) => (x.handle || '').toLowerCase() === handle.toLowerCase());
  const solo = !g && soloWho(handle);
  const name = m ? memberName(m) : solo ? solo.name : '@' + handle, col = m ? avatarOf(m.profile || m.member_id).color : solo ? solo.color : '#8A8A8A';
  const d = document.createElement('div'); d.className = 'rq in'; d.style.setProperty('--c', col);
  d.innerHTML = `<b>${esc(name)}</b><span>${esc(excerpt.replace(/\u200b/g, ''))}</span>`;
  return d;
}
/** @param {string} role @param {string} text @param {{ stream?: boolean, ts?: any }} [o] */
export function addBubble(role, text, { stream = false, ts } = {}) {
  const row = document.createElement('div'); row.className = 'row ' + role;
  const b = /** @type {any} */ (document.createElement('div')); b.className = 'bubble';
  b._raw = text || '';
  const rp = role === 'user' && REPLY_RE.exec(b._raw);
  if (rp) { b._raw = rp[3]; b.append(replyFrame(rp[1], rp[2]), document.createTextNode(rp[3])); }
  else if (role === 'user') b.textContent = b._raw; else b.innerHTML = md(b._raw);
  if (stream) b.classList.add('cursor');
  return addRow(row, b, ts);
}
// Tâche automatique : un cron livré par Hermes dans la conversation du bot (deliver: bot-chat),
// tour entrant « [Cronjob "nom" output — …] » ; affiché en carte repliable, la réponse du bot dessous.
export const TASK_RE = /^\[Cronjob "([^"]*)" output[^\]]*\]\s*([\s\S]*)$/;
export function addTask(name, body, ts) {
  const failed = /^\s*(⚠|\[CRON_FAILURE\])/.test(body);
  const row = document.createElement('div'); row.className = 'row task';
  const d = /** @type {any} */ (document.createElement('details')); d.className = 'task-card' + (failed ? ' fail' : '');
  d.innerHTML = `<summary><span class="tk">${failed ? 'Tâche automatique en échec' : 'Tâche automatique'}</span><b>${esc(name)}</b></summary><div class="tb"></div>`;
  d.querySelector('.tb').innerHTML = md(body.replace(/^\s*\[CRON_FAILURE\]\s*/, ''));
  d._raw = body;
  return addRow(row, d, ts);
}
export function setBubble(b, text) { if (b._rq) { cancelAnimationFrame(b._rq); b._rq = 0; } b._raw = text; b.innerHTML = md(text); }
// Streaming : le texte brut suit chaque morceau, le rendu markdown (marked + DOMPurify + sections) au plus une fois par image.
// Reparser toute la bulle à chaque morceau coûtait le carré de sa longueur et figeait le téléphone sur les longues réponses.
export function streamBubble(b, text) {
  b._raw = text; if (b._rq) return;
  b._rq = requestAnimationFrame(() => { b._rq = 0; b.innerHTML = md(b._raw); scrollDown(); });
}
export function addNote(text) { const n = document.createElement('div'); n.className = 'note'; n.textContent = text; log().appendChild(n); scrollDown(); }
// Consecutive tool calls fold into one quiet line ("3 outils"), expandable, like chat apps do.
function toolGroup() {
  const last = log().lastElementChild;
  if (last?.classList.contains('tools')) return last;
  const g = document.createElement('details'); g.className = 'tools';
  g.innerHTML = '<summary></summary><div class="items"></div>';
  log().appendChild(g); return g;
}
function refreshGroup(g) {
  const items = [...g.querySelectorAll('.tool')];
  const running = items.filter((t) => t.classList.contains('run'));
  const failed = items.filter((t) => t.classList.contains('fail')).length;
  const n = items.length;
  g.classList.toggle('run', running.length > 0);
  g.querySelector('summary').textContent = running.length
    ? (running.at(-1).dataset.name || 'outil') + '…' + (n > 1 ? ' · ' + n + ' outils' : '')
    : n + (n > 1 ? ' outils utilisés' : ' outil utilisé') + (failed ? ' · ' + failed + ' en échec' : '');
}
export function addTool(id, name, detail) {
  const g = toolGroup();
  const d = document.createElement('details'); d.className = 'tool run'; d.dataset.toolId = id || ''; d.dataset.name = name || 'outil';
  d.innerHTML = `<summary>${esc(name || 'outil')}${detail ? ' · ' + esc(detail) : ''}</summary>`;
  g.querySelector('.items').appendChild(d); refreshGroup(g); return d;
}
export function setToolState(t, cls) { t.className = 'tool ' + cls; const g = t.closest('.tools'); if (g) refreshGroup(g); }

// ---------- long messages fold ----------
export function fold(b) {
  if (!b || b.closest('.row')?.classList.contains('user')) return b;
  if (b.querySelector('.mention-me')) b.classList.add('mentions-me');
  if (b.dataset.foldChecked || b.querySelector('.ui, .ui-sec')) return b; // des cartes se lisent d'un coup d'œil : pas de pli
  requestAnimationFrame(() => {
    if (b.scrollHeight <= 480 || b.dataset.foldChecked) return;
    b.dataset.foldChecked = '1'; b.classList.add('folded');
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'fold-btn'; btn.textContent = 'Afficher tout';
    btn.onclick = () => {
      const folded = b.classList.toggle('folded'); btn.textContent = folded ? 'Afficher tout' : 'Réduire';
      if (folded) b.scrollIntoView({ block: 'nearest' });
    };
    b.after(btn);
  });
  return b;
}
