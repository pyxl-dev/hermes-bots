// @ts-check
// Pièces jointes.

import { updateSendBtn } from './composer.js';
import { addNote } from './render.js';
import { queueSend, send } from './send.js';
import { state } from './state.js';
import { $, apiErr } from './util.js';

export const staged = []; // pièces jointes en attente d'envoi (voir « pièces jointes »)

// ---------- pièces jointes ----------
// Comme le desktop en mode navigateur : une image passe par /api/chat/image-upload (dossier de transit
// du profil, le seul que l'admission accepte) puis part en attachments [{path, mime}] de prompt.submit.
// Les autres fichiers passent par /api/chat/file-upload ; le bot reçoit leur chemin dans le texte.
const SENDABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function renderTray() {
  const t = $('#tray'); t.innerHTML = ''; t.hidden = !staged.length;
  staged.forEach((s, k) => {
    const chip = document.createElement('div'); chip.className = 'chip';
    if (s.url) { const im = document.createElement('img'); im.src = s.url; im.alt = s.file.name; chip.append(im); }
    else { const n = document.createElement('span'); n.className = 'n'; n.textContent = s.file.name; chip.append(n); }
    const x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.setAttribute('aria-label', 'Retirer');
    x.addEventListener('click', () => { if (s.url) URL.revokeObjectURL(s.url); staged.splice(k, 1); renderTray(); updateSendBtn(); });
    chip.append(x); t.append(chip);
  });
}
$('#attach').addEventListener('click', () => {
  if (state.group) { addNote('Les pièces jointes ne marchent pas encore dans les groupes.'); return; }
  $('#file').click();
});
$('#file').addEventListener('change', (e) => {
  for (const f of e.target.files || []) {
    const img = f.type.startsWith('image/') && !/svg|icon/.test(f.type);
    staged.push({ file: f, img, url: img ? URL.createObjectURL(f) : null });
  }
  e.target.value = ''; renderTray(); updateSendBtn();
});
export function showAttached(b, files) {
  const box = document.createElement('div'); box.className = 'att';
  for (const s of files) {
    if (s.url) { const im = document.createElement('img'); im.src = s.url; im.alt = s.file.name; box.append(im); }
    else { const f = document.createElement('div'); f.className = 'f'; f.textContent = 'Fichier : ' + s.file.name; box.append(f); }
  }
  b.prepend(box);
}
const readDataUrl = (blob) => new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = () => ko(r.error); r.readAsDataURL(blob); });
// HEIC, BMP, très grandes photos : recodées en JPEG (2560 px max) pour rester dans ce que le gateway admet.
async function imageDataUrl(file) {
  if (SENDABLE.has(file.type) && file.size <= 6 * 1024 * 1024) return readDataUrl(file);
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.round(bmp.width * k); cv.height = Math.round(bmp.height * k);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
  return cv.toDataURL('image/jpeg', 0.85);
}

async function uploadOne(profile, s) {
  const q = profile ? '?profile=' + encodeURIComponent(profile) : '';
  if (s.img) {
    const r = await fetch('/api/chat/image-upload' + q, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data_url: await imageDataUrl(s.file), filename: s.file.name }) });
    if (!r.ok) throw await apiErr(r);
    const j = await r.json();
    if (!SENDABLE.has(j.mime_type)) throw new Error('format refusé : ' + j.mime_type);
    return { attachment: { path: j.path, mime: j.mime_type } };
  }
  const fd = new FormData(); fd.append('file', s.file, s.file.name);
  const r = await fetch('/api/chat/file-upload' + q, { method: 'POST', credentials: 'same-origin', body: fd });
  if (!r.ok) throw await apiErr(r);
  return { line: `[Fichier joint : ${s.file.name}, déposé ici : ${(await r.json()).path}]` };
}
export async function sendWithFiles(c, text) {
  const files = staged.splice(0); renderTray(); updateSendBtn();
  const attach = $('#attach'); attach.disabled = true;
  try {
    const out = [];
    for (const s of files) {
      try { out.push(await uploadOne(c.gw.profile, s)); }
      catch (e) { addNote(`Pièce jointe ${s.file.name} non envoyée : ${e.message}`); }
    }
    const attachments = out.map((o) => o.attachment).filter(Boolean);
    const lines = out.map((o) => o.line).filter(Boolean);
    if (!attachments.length && !lines.length) return;
    const full = [text, ...lines].filter(Boolean).join('\n\n') || 'Voici une image.';
    const opts = { attachments, files, display: text };
    if (c.busy) queueSend(full, opts); else send(full, opts);
  } finally { attach.disabled = false; }
}
