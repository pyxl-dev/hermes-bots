// @ts-check
// Fil de travail d'un bot dans un groupe (demandé le 2026-11-16, besoin : docs/fil-de-travail.md).
// Un appui sur l'avatar d'un bot dans la barre « qui travaille », ou sur la bulle d'un résultat, ouvre un volet bas
// (deux tiers de l'écran, le groupe reste visible derrière) : outil + argument court, textes intermédiaires, sortie
// repliée dépliable ; pas de réflexion. Un onglet par fil en cours du bot, le plus récent ouvert. « Arrêter ce bot »
// ne coupe que lui. Les fils vivent dans le plugin bot-groups (plugin.bot-groups.trace.*), 30 jours.

import { avatarHtml, avatarOf } from './avatars.js';
import { addNote } from './render.js';
import { botLabel, memberName } from './roster.js';
import { state } from './state.js';
import { $, esc, toMs } from './util.js';

const API = 'plugin.bot-groups.';
const KEEP_MS = 30 * 864e5, READ_MS = 1500;
let traceRpc = true;
const rpcMissing = (e) => /method|not found|unknown|introuvable/i.test(e?.message || '');

/** @type {null | { g: any, member: string, active: string, tabs: string[], els: Map<number, HTMLElement>, after: number, timer: any, busy: boolean, expired?: boolean, live?: boolean }} */
let cur = null;

const sameMember = (g, a, b) => {
  if (a === b) return true;
  const ms = g.room.members.filter((m) => [m.member_id, m.profile].includes(a));
  return ms.some((m) => [m.member_id, m.profile].includes(b));
};
const memberOf = (g, id) => g.room.members.find((m) => [m.member_id, m.profile].includes(id));
const nameOf = (g, id) => { const m = memberOf(g, id); return m ? memberName(m) : botLabel(id) || id; };

// ---------- liste des fils du groupe (relevée avec le groupe, toutes les 2 s) ----------
export async function pollTraces(g) {
  if (!traceRpc) return;
  try {
    const r = await state.roster.call(API + 'trace.list', { room_id: g.room.room_id }, 8000);
    if (state.group !== g) return;
    g.traces = r?.traces || [];
    g.traceByEvent = new Map(g.traces.filter((t) => t.event_id).map((t) => [t.event_id, t]));
  } catch (e) { if (rpcMissing(e)) traceRpc = false; return; }
  markTraceBubbles(g);
  if (cur?.g === g) syncTabs();
}
export const runningTraces = (g, member) => (g.traces || []).filter((t) => t.status === 'running' && (!member || sameMember(g, t.member_id, member)));

/** Réaction sur les bulles qui ont un fil ; une bulle de bot de plus de 30 jours dit « fil expiré ». */
export function markTraceBubbles(g) {
  for (const b of document.querySelectorAll('#log .bubble[data-eid]')) {
    const el = /** @type {HTMLElement} */ (b), t = g.traceByEvent?.get(el.dataset.eid);
    el.classList.toggle('has-trace', !!t);
    el.classList.toggle('trace-expired', !t && !!el.dataset.mid && Date.now() - Number(el.dataset.ts || Date.now()) > KEEP_MS);
  }
}

// ---------- ouverture ----------
export async function openTraceFor(g, member) {
  await pollTraces(g);
  const running = runningTraces(g, member).sort((a, b) => b.started - a.started);
  const last = (g.traces || []).filter((t) => sameMember(g, t.member_id, member)).sort((a, b) => b.started - a.started)[0];
  const first = running[0] || last;
  if (!first) { addNote(nameOf(g, member) + ' : aucun fil de travail pour l’instant'); return; }
  open(g, member, first.trace_id);
}
export async function openTraceOfBubble(b) {
  const g = state.group; if (!g) return;
  const t = g.traceByEvent?.get(b.dataset.eid);
  if (t) { open(g, t.member_id, t.trace_id); return; }
  if (b.classList.contains('trace-expired')) open(g, b.dataset.mid, null, true);
}
function open(g, member, traceId, expired = false) {
  stopTimer();
  cur = { g, member, active: traceId || '', tabs: traceId ? [traceId] : [], els: new Map(), after: -1, timer: null, busy: false, expired };
  const sh = $('#trace-sheet'); sh.hidden = false; sh.style.transform = '';
  requestAnimationFrame(() => sh.classList.add('on'));
  document.body.classList.add('trace-open');
  if (!expired) syncTabs(true);
  draw();
  if (!expired) readNow();
}
export function closeTrace() {
  stopTimer(); cur = null;
  const sh = $('#trace-sheet'); sh.classList.remove('on'); sh.style.transform = '';
  document.body.classList.remove('trace-open');
  setTimeout(() => { if (!cur) sh.hidden = true; }, 220);
}
const stopTimer = () => { if (cur?.timer) clearTimeout(cur.timer); };

// Onglets : les fils en cours du bot (le plus récent d'abord) + celui qu'on a ouvert.
function syncTabs(initial = false) {
  if (!cur || cur.expired) return;
  const { g, member } = cur;
  const live = runningTraces(g, member).sort((a, b) => b.started - a.started).map((t) => t.trace_id);
  const tabs = [...new Set([cur.active, ...live])].filter(Boolean);
  if (tabs.join() !== cur.tabs.join()) { cur.tabs = tabs; if (!initial) draw(); }
}
const traceOf = (id) => (cur?.g.traces || []).find((t) => t.trace_id === id);
const fmtTime = (s) => new Date(toMs(s)).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

// ---------- affichage ----------
function draw() {
  if (!cur) return;
  const { g, member } = cur, prof = memberOf(g, member)?.profile || member;
  $('#tr-who').innerHTML = avatarHtml(prof, 28) + `<b style="color:${avatarOf(prof).color}">${esc(nameOf(g, member))}</b><span id="tr-state" class="tr-state"></span>`;
  const tabs = $('#tr-tabs'); tabs.innerHTML = '';
  if (cur.tabs.length > 1) {
    for (const id of cur.tabs) {
      const t = traceOf(id), b = document.createElement('button'); b.type = 'button'; b.className = 'tr-tab' + (id === cur.active ? ' on' : '');
      b.textContent = (t?.status === 'running' ? 'En cours ' : 'Fini ') + (t ? fmtTime(t.started) : '');
      b.onclick = () => { if (!cur || cur.active === id) return; cur.active = id; cur.after = -1; cur.live = undefined; cur.els.clear(); draw(); readNow(); };
      tabs.appendChild(b);
    }
  }
  tabs.hidden = cur.tabs.length < 2;
  const body = $('#tr-body');
  if (cur.expired) { body.innerHTML = '<p class="tr-empty">Fil expiré : les fils sont gardés 30 jours.</p>'; }
  else if (!cur.els.size) body.innerHTML = '<p class="tr-empty">Chargement…</p>';
  $('#tr-stop').hidden = true;
}

const SHORT_KEYS = ['command', 'cmd', 'path', 'file_path', 'filepath', 'query', 'pattern', 'url', 'name', 'prompt', 'task', 'text'];
/** Argument court d'un outil : « git status », un chemin, une requête. */
export function shortArg(args) {
  if (!args || typeof args !== 'object') return '';
  let v = SHORT_KEYS.map((k) => args[k]).find((x) => typeof x === 'string' && x.trim());
  if (v === undefined) v = Object.values(args).find((x) => typeof x === 'string' && x.trim());
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  return s.length > 90 ? s.slice(0, 90) + '…' : s;
}
const stateClass = { running: 'run', done: 'done', error: 'fail' };
function entryEl(e) {
  if (e.k === 'text') { const d = document.createElement('div'); d.className = 'tr-text'; d.textContent = e.text; return d; }
  if (e.k === 'retry') { const d = document.createElement('div'); d.className = 'tr-note'; d.textContent = 'Relancé après une coupure'; return d; }
  const d = /** @type {HTMLDetailsElement} */ (document.createElement('details')); d.className = 'tool'; d.dataset.toolId = e.id;
  d.innerHTML = '<summary></summary>';
  setTool(d, e); return d;
}
function setTool(d, e) {
  d.className = 'tool ' + (stateClass[e.state] || 'run');
  const arg = shortArg(e.args);
  d.querySelector('summary').textContent = e.name + (arg ? ' : ' + arg : '');
  let pre = d.querySelector('pre');
  if (e.output) {
    if (!pre) { pre = document.createElement('pre'); d.appendChild(pre); }
    pre.textContent = e.output;
  }
}

function apply(res) {
  if (!cur) return;
  const body = $('#tr-body');
  if (!cur.els.size) body.innerHTML = '';
  const near = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
  for (const e of res.entries || []) {
    const old = cur.els.get(e.n);
    if (old) { if (e.k === 'tool') setTool(old, e); }
    else { const el = entryEl(e); cur.els.set(e.n, el); body.appendChild(el); }
    cur.after = Math.max(cur.after, e.n);
  }
  if (!cur.els.size) body.innerHTML = `<p class="tr-empty">${res.status === 'running' ? 'Aucune action pour l’instant…' : 'Ce fil est vide : le bot a répondu sans outil.'}</p>`;
  if (near) body.scrollTop = body.scrollHeight;
  const live = res.status === 'running';
  $('#tr-state').textContent = live ? 'travaille…' : res.status === 'stopped' ? 'arrêté' : res.status === 'failed' ? 'en échec' : 'fini';
  $('#tr-state').classList.toggle('live', live);
  $('#tr-stop').hidden = !live;
  cur.live = live;
}

async function readNow() {
  if (!cur || cur.expired || cur.busy) return;
  const me = cur, id = me.active; me.busy = true; stopTimer();
  try {
    const open = [...me.els.values()].filter((el) => el.classList.contains('run')).map((el) => el.dataset.toolId);
    const res = await state.roster.call(API + 'trace.read', { room_id: me.g.room.room_id, trace_id: id, after: me.after, open }, 10000);
    if (cur === me && me.active === id) apply(res);
  } catch (e) {
    if (cur === me && !me.els.size) $('#tr-body').innerHTML = `<p class="tr-empty">${/introuvable|expir/i.test(e.message || '') ? 'Fil expiré : les fils sont gardés 30 jours.' : 'Lecture impossible : ' + esc(e.message || '')}</p>`;
  } finally {
    me.busy = false;
    // un fil fini n'a plus rien à lire ; un fil en cours se relit
    if (cur === me && (me.live !== false)) me.timer = setTimeout(readNow, READ_MS);
  }
}

async function stopBot() {
  if (!cur) return;
  const { g, member } = cur, btn = /** @type {HTMLButtonElement} */ ($('#tr-stop')); btn.disabled = true; btn.textContent = 'Arrêt demandé…';
  try { await state.roster.call(API + 'member.stop', { room_id: g.room.room_id, member_id: member }, 30000); }
  catch (e) { addNote('Arrêt de ' + nameOf(g, member) + ' non confirmé : ' + e.message); }
  btn.disabled = false; btn.textContent = 'Arrêter ce bot';
  if (cur) { cur.live = undefined; readNow(); }
  pollTraces(g);
}
$('#tr-stop').addEventListener('click', stopBot);
$('#tr-close').addEventListener('click', closeTrace);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cur) closeTrace(); });

// Glisser la poignée vers le bas ferme le volet.
{
  const head = $('#tr-head'), sh = $('#trace-sheet'); let y0 = null, dy = 0;
  head.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; dy = 0; sh.style.transition = 'none'; }, { passive: true });
  head.addEventListener('touchmove', (e) => { if (y0 === null) return; dy = Math.max(0, e.touches[0].clientY - y0); sh.style.transform = `translateY(${dy}px)`; }, { passive: true });
  const end = () => { if (y0 === null) return; y0 = null; sh.style.transition = ''; if (dy > 90) closeTrace(); else sh.style.transform = ''; };
  head.addEventListener('touchend', end); head.addEventListener('touchcancel', end);
}

// Appui sur une bulle de résultat (hors liens, boutons et cartes) : ouvre son fil.
$('#log').addEventListener('click', (e) => {
  const t = /** @type {HTMLElement} */ (e.target), b = /** @type {HTMLElement | null} */ (t.closest?.('.bubble.has-trace, .bubble.trace-expired'));
  if (!b || t.closest('a, button, summary, .ui, .fold-btn')) return;
  if (getSelection()?.toString()) return;
  openTraceOfBubble(b);
});
// Avatar de la barre « qui travaille ».
$('#grp-av').addEventListener('click', (e) => {
  const w = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-worker]')); const g = state.group;
  if (w && g) openTraceFor(g, w.dataset.worker);
});
export const closeTraceOnLeave = () => { if (cur) closeTrace(); };
