// @ts-check
// Recherche dans le fil (bulles chargées).

import { ui } from './state.js';
import { $, log } from './util.js';

// ---------- recherche dans le fil (bulles chargées) ----------
export const find = { hits: [], cur: -1 };
function clearHits() {
  for (const m of log().querySelectorAll('mark.hit')) { const p = m.parentNode; m.replaceWith(document.createTextNode(m.textContent)); p.normalize(); }
  find.hits = []; find.cur = -1;
}
export function runFind() {
  clearHits();
  const q = $('#find-q').value.trim();
  if (q) {
    const src = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), re = new RegExp(src, 'gi'), has = new RegExp(src, 'i');
    const walker = document.createTreeWalker(log(), NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.parentElement.closest('.bubble') && !n.parentElement.closest('mark, script, style') && has.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT });
    const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const v = n.nodeValue, frag = document.createDocumentFragment(); let last = 0; re.lastIndex = 0;
      for (let m; (m = re.exec(v)); ) {
        if (!m[0]) { re.lastIndex++; continue; }
        frag.append(v.slice(last, m.index));
        const k = document.createElement('mark'); k.className = 'hit'; k.textContent = m[0]; frag.append(k); find.hits.push(k);
        last = m.index + m[0].length;
      }
      frag.append(v.slice(last)); n.replaceWith(frag);
    }
    if (find.hits.length) gotoHit(find.hits.length - 1); // on part du plus récent
  }
  findCount();
}
function findCount() {
  $('#find-n').textContent = find.hits.length ? (find.cur + 1) + '/' + find.hits.length : $('#find-q').value.trim() ? '0/0' : '';
}
function gotoHit(i) {
  if (!find.hits.length) return;
  find.hits[find.cur]?.classList.remove('cur');
  find.cur = (i + find.hits.length) % find.hits.length;
  const m = find.hits[find.cur]; m.classList.add('cur');
  const b = m.closest('.bubble'); if (b?.classList.contains('folded')) b.classList.remove('folded');
  ui.posLock = true; m.scrollIntoView({ block: 'center' }); setTimeout(() => { ui.posLock = false; }, 400);
  findCount();
}
function openFind() { $('#find-bar').hidden = false; $('#find-q').focus(); $('#find-q').select(); }
export function closeFind() { if ($('#find-bar').hidden) return; clearHits(); $('#find-q').value = ''; $('#find-n').textContent = ''; $('#find-bar').hidden = true; }
$('#find-btn').addEventListener('click', () => ($('#find-bar').hidden ? openFind() : closeFind()));
$('#find-x').addEventListener('click', closeFind);
$('#find-q').addEventListener('input', runFind);
$('#find-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); gotoHit(find.cur + (e.shiftKey ? -1 : 1)); } else if (e.key === 'Escape') closeFind(); });
$('#find-next').addEventListener('click', () => gotoHit(find.cur + 1));
$('#find-prev').addEventListener('click', () => gotoHit(find.cur - 1));
