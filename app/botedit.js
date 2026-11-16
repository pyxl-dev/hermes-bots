// @ts-check
// Fiche d'un bot : nom, personnage, tâches planifiées.

import { KINDS, KIND_LABEL, SWATCH, avatarOf, mascot } from './avatars.js';
import { chatLook } from './chat.js';
import { renderGroups } from './groups.js';
import { setAvatar } from './prefs.js';
import { botName, renderRoster } from './roster.js';
import { state } from './state.js';
import { store } from './store.js';
import { $, esc } from './util.js';

// ---------- rename (same field as the desktop: ui_meta['hermes-bots'].title) ----------
let bdDraft = null;
function openBotEdit() {
  const c = state.chat; if (!c || state.group) return;
  bdDraft = { ...avatarOf(c.bot.name) };
  $('#bd-name').value = botName(c.bot); $('#bd-title').textContent = botName(c.bot); $('#bd-profile').textContent = c.bot.name; $('#bd-msg').textContent = '';
  $('#bd-pills').innerHTML = [c.bot.model].filter(Boolean).map((m) => `<span>${esc(m)}</span>`).join('');
  paintBdPick();
  $('#bot-dlg').showModal();
  loadCron(c.bot);
}
function paintBdPick() {
  const { color, kind } = bdDraft;
  $('#bd-hero').style.setProperty('--c', color);
  $('#bd-big').innerHTML = mascot(kind, color, 92, { key: state.chat?.bot.name });
  $('#bd-colors').innerHTML = SWATCH.map((x) => `<button type="button" role="radio" aria-checked="${x === color}" aria-label="Couleur ${x}" data-c="${x}" style="background:${x}"></button>`).join('');
  $('#bd-kinds').innerHTML = KINDS.map((k) => `<button type="button" role="radio" aria-checked="${k === kind}" aria-label="${KIND_LABEL[k]}" data-k="${k}">${mascot(k, color, 40, { st: 'still' })}</button>`).join('');
}
$('#bd-colors').addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) { bdDraft.color = b.dataset.c; paintBdPick(); } });
$('#bd-kinds').addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) { bdDraft.kind = b.dataset.k; paintBdPick(); } });

// ---------- scheduled tasks (cron.manage, per-profile store, same as the desktop) ----------
function inWords(iso) {
  const t = Date.parse(iso || ''); if (!t) return '';
  const d = t - Date.now(), a = Math.abs(d), m = 60000, h = 60 * m, j = 24 * h;
  const n = a < h ? `${Math.max(1, Math.round(a / m))} min` : a < j ? `${Math.round(a / h)} h` : `${Math.round(a / j)} j`;
  return d >= 0 ? `dans ${n}` : `il y a ${n}`;
}
function cronRow(bot, job) {
  const on = job.enabled !== false && job.state !== 'paused';
  const err = job.last_status === 'error' || job.last_status === 'failed' ? (job.last_error || job.last_fire_error || 'dernier passage en échec') : '';
  const el = document.createElement('div');
  el.className = 'cron' + (on ? '' : ' off') + (err ? ' err' : '');
  el.innerHTML = `<div class="nm"><span class="dot"></span><span>${esc(job.name || job.job_id)}</span></div>
    <button class="sw" role="switch" aria-checked="${on}" aria-label="Activer"></button>
    <span class="sched">${esc(job.schedule)}</span>
    <span class="next">${on ? (job.next_run_at ? 'Prochaine : ' + esc(inWords(job.next_run_at)) : '') : (job.state === 'completed' ? 'terminée' : 'en pause')}</span>
    ${err ? `<span class="lasterr">${esc(String(err).slice(0, 200))}</span>` : ''}`;
  const sw = /** @type {any} */ (el.querySelector('.sw'));
  sw.addEventListener('click', async () => {
    sw.disabled = true;
    try {
      const r = await state.roster.call('cron.manage', { action: on ? 'pause' : 'resume', name: job.job_id, profile: bot.name }, 30000);
      if (r?.error || r?.success === false) throw new Error(r.error || 'refusé');
      el.replaceWith(cronRow(bot, { ...job, ...(r?.job || {}), enabled: !on, state: on ? 'paused' : 'scheduled' }));
    } catch (e) { sw.disabled = false; $('#bd-msg').textContent = 'Échec : ' + e.message; }
  });
  return el;
}
async function loadCron(bot) {
  const box = $('#bd-cron'); box.innerHTML = '<p class="msg small">Chargement…</p>';
  try {
    const r = await state.roster.call('cron.manage', { action: 'list', include_disabled: true, profile: bot.name }, 30000);
    if (r?.error) throw new Error(r.error);
    let jobs = r?.jobs || [];
    if (r?.scoped !== bot.name) jobs = jobs.filter((j) => (j.name || '').startsWith(`[bot:${bot.name}]`)); // older gateway: unscoped store
    if (state.chat?.bot?.name !== bot.name) return;
    box.innerHTML = jobs.length ? '' : '<p class="msg small">Aucune tâche planifiée.</p>';
    jobs.sort((a, b) => (Date.parse(a.next_run_at) || 9e15) - (Date.parse(b.next_run_at) || 9e15));
    for (const j of jobs) box.append(cronRow(bot, j));
  } catch (e) { box.innerHTML = `<p class="msg small">Impossible de lire les tâches : ${esc(e.message)}</p>`; }
}
async function saveBotName() {
  const c = state.chat; if (!c) return;
  const title = $('#bd-name').value.trim();
  if (!title) return ($('#bd-msg').textContent = 'Le nom ne peut pas être vide.');
  const btn = $('#bd-save'); btn.disabled = true; $('#bd-msg').textContent = 'Enregistrement…';
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = (await state.roster.call('profiles.list', { include_sessions: false })).profiles?.find((p) => p.name === c.bot.name) || c.bot;
      const meta = { ...(fresh.ui_meta?.['hermes-bots'] || {}), title };
      const params = { name: c.bot.name, ui_meta: { 'hermes-bots': meta } };
      const rev = fresh.ui_meta_revisions?.['hermes-bots'];
      if (Number.isInteger(rev)) params.ui_meta_expected_revisions = { 'hermes-bots': rev };
      const r = await state.roster.call('profiles.configure', params, 30000);
      if (r?.applied?.ui_meta_conflicts) continue; // edited elsewhere meanwhile: reread and retry once
      if (r?.applied && r.applied.ui_meta === false) throw new Error('le gateway n’a pas enregistré le nom');
      c.bot.ui_meta = { ...(c.bot.ui_meta || {}), 'hermes-bots': meta };
      const row = state.bots.find((b) => b.name === c.bot.name); if (row) row.ui_meta = c.bot.ui_meta;
      store.set('roster-cache', state.bots);
      $('#chat-name').textContent = title; $('#bd-title').textContent = title; renderRoster(); $('#bd-msg').textContent = 'Nom enregistré.';
      return true;
    }
    throw new Error('modifié ailleurs en même temps, réessaie');
  } catch (e) { $('#bd-msg').textContent = 'Échec : ' + e.message; }
  finally { btn.disabled = false; }
  return false;
}
async function saveBotEdit() {
  const c = state.chat; if (!c || !bdDraft) return;
  const cur = avatarOf(c.bot.name);
  if (bdDraft.color !== cur.color || bdDraft.kind !== cur.kind) { setAvatar(c.bot.name, { ...bdDraft }); renderRoster(); renderGroups(); chatLook(); }
  const title = $('#bd-name').value.trim();
  if (!title) return ($('#bd-msg').textContent = 'Le nom ne peut pas être vide.');
  if (title !== botName(c.bot) && !(await saveBotName())) return;
  $('#bot-dlg').close();
}
$('#bot-edit').addEventListener('click', openBotEdit);
$('#bd-cancel').addEventListener('click', () => $('#bot-dlg').close());
$('#bd-save').addEventListener('click', saveBotEdit);
