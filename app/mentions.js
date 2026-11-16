// @ts-check
// Complétions @ et / dans la zone de saisie.

import { memberName } from './roster.js';
import { state } from './state.js';
import { $, esc } from './util.js';

// ---------- @ completions: group members by handle; in a bot chat, the gateway's complete.path (same list as desktop) ----------
const mention = { seq: 0, items: [], at: -1, timer: null };
function mentionToken() {
  const i = $('#input'), pos = i.selectionStart ?? i.value.length;
  const m = /(^|\s)(@[^\s@]*)$/.exec(i.value.slice(0, pos));
  return m ? { word: m[2], start: pos - m[2].length, end: pos } : null;
}
function hideMention() { mention.items = []; $('#mention').hidden = true; $('#mention').innerHTML = ''; }
function showMention(items, tok) {
  if (!items.length) return hideMention();
  mention.items = items.slice(0, 30); mention.tok = tok;
  const box = $('#mention'); box.innerHTML = '';
  mention.items.forEach((it, k) => {
    const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'option');
    b.innerHTML = `<span>${esc(it.display || it.text)}</span>${it.meta ? `<span class="m">${esc(it.meta)}</span>` : ''}`;
    b.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the keyboard open
    b.addEventListener('click', () => pickMention(k));
    box.append(b);
  });
  box.hidden = false;
}
function pickMention(k) {
  const it = mention.items[k], tok = mention.tok, i = $('#input'); if (!it || !tok) return;
  const open = /[:/]$/.test(it.text); // @file: or a folder: keep completing
  const ins = it.text + (open ? '' : ' ');
  i.value = i.value.slice(0, tok.start) + ins + i.value.slice(tok.end);
  const caret = tok.start + ins.length; i.setSelectionRange(caret, caret); i.focus();
  i.dispatchEvent(new Event('input'));
}
function groupMentionItems(word) {
  const q = word.slice(1).toLowerCase();
  const rows = (state.group.room.members || []).map((m) => ({ text: '@' + m.handle, display: '@' + m.handle, meta: memberName(m) }));
  rows.push({ text: '@all', display: '@all', meta: 'tout le groupe' });
  return rows.filter((r) => r.text.slice(1).toLowerCase().startsWith(q) || r.meta.toLowerCase().includes(q));
}
// / en début de message : complete.slash du gateway (même liste que le desktop), moins les commandes
// réservées au terminal (cli_only du registre hermes_cli/commands.py, relevé le 2026-11-13) et /new,
// /reset, qu'un Bot Chat permanent refuse.
const SLASH_HIDDEN = new Set('battery browser clear compose config copy cron exit export focus gateway generate-pet handoff hatch history image import indicator journey learning memory-graph palette paste pet platforms plugins prompt quit redraw reload rewind sb skin snap snapshot statusbar subscription timestamps tools toolsets ts upgrade wake worktree new reset'.split(' '));
function slashToken() {
  const i = $('#input'), pos = i.selectionStart ?? i.value.length, head = i.value.slice(0, pos);
  return /^\/[^\n]*$/.test(head) ? { text: head, end: pos } : null;
}
function updateSlash(st) {
  const c = state.chat; if (!c?.gw) return hideMention();
  const seq = ++mention.seq;
  mention.timer = setTimeout(async () => {
    try {
      const r = await c.gw.call('complete.slash', { text: st.text, ...(c.sid ? { session_id: c.sid } : {}) }, 10000);
      if (seq !== mention.seq || state.chat !== c) return;
      const start = Number.isInteger(r?.replace_from) ? r.replace_from : 1;
      const naming = !/\s/.test(st.text);
      const items = (r?.items || []).filter((it) => !(naming && SLASH_HIDDEN.has(it.text)))
        .map((it) => ({ text: it.text, display: it.display || it.text, meta: it.meta ? it.meta.replace(/\s*\(usage:[^)]*\)\s*$/, '') : '' }));
      if (items.length === 1 && '/' + items[0].text === st.text.trim()) return hideMention(); // déjà tapée en entier
      showMention(items, { start, end: st.end });
    } catch { if (seq === mention.seq) hideMention(); }
  }, 120);
}
function updateMention() {
  clearTimeout(mention.timer);
  const st = !state.group && slashToken(); if (st) return updateSlash(st);
  const tok = mentionToken(); if (!tok) return hideMention();
  if (state.group) return showMention(groupMentionItems(tok.word), tok);
  const c = state.chat; if (!c?.gw) return hideMention();
  const seq = ++mention.seq;
  mention.timer = setTimeout(async () => {
    try {
      const r = await c.gw.call('complete.path', { word: tok.word, ...(c.sid ? { session_id: c.sid } : {}) }, 10000);
      if (seq === mention.seq && state.chat === c) showMention(r?.items || [], tok);
    } catch { if (seq === mention.seq) hideMention(); }
  }, 120);
}
$('#input').addEventListener('input', updateMention);
$('#input').addEventListener('click', updateMention);
$('#input').addEventListener('blur', () => setTimeout(hideMention, 150));
$('#input').addEventListener('keydown', (e) => {
  if ($('#mention').hidden) return;
  if (e.key === 'Escape') { hideMention(); e.preventDefault(); }
  else if ((e.key === 'Enter' || e.key === 'Tab') && mention.items.length) { pickMention(0); e.preventDefault(); e.stopImmediatePropagation(); }
});
