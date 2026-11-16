// @ts-check
// Répondre à un message de bot, et retrouver le message cité.

import { avatarOf } from './avatars.js';
import { loadOlder } from './history.js';
import { addNote, replyExcerpt, soloWho } from './render.js';
import { state } from './state.js';
import { $, esc, log } from './util.js';

// ---------- répondre à un message de bot (groupes) ----------
// La passerelle n'accepte que du texte : la réponse voyage en tête du message sous la forme
// « > ↩ @handle : « extrait » » suivie d'une ligne vide. La mention adresse ce bot ; l'app
// l'affiche en petit cadre au-dessus de mon texte au lieu de l'écrire dans la bulle.

let replyTo = null;

// Toucher le cadre d'une réponse : défile jusqu'au message cité (en chargeant le passé s'il le faut) et le fait briller.
const excerptOf = (b) => { const c = b.cloneNode(true); c.querySelector('.author')?.remove(); c.querySelector('.rq')?.remove(); return replyExcerpt(c.innerText || c.textContent); };
function findQuoted(from, want) {
  const key = want.replace(/…$/, ''), all = [...log().querySelectorAll('.bubble')], end = all.indexOf(from);
  for (let i = (end < 0 ? all.length : end) - 1; i >= 0; i--) {
    const e = excerptOf(all[i]).replace(/…$/, '');
    if (e && (e.startsWith(key) || key.startsWith(e))) return all[i];
  }
  return null;
}
async function goToQuoted(rq) {
  const from = rq.closest('.bubble'), want = rq.querySelector('span')?.textContent || ''; if (!from || !want) return;
  let hit = findQuoted(from, want);
  for (let n = 0; !hit && n < 10; n++) {
    const c = state.chat; if (state.group || !c?.moreOlder) break;
    await loadOlder(c); hit = findQuoted(from, want);
  }
  if (!hit) return addNote('Message cité introuvable dans l\u2019historique chargé.');
  hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  hit.classList.remove('hl'); void hit.offsetWidth; hit.classList.add('hl');
  setTimeout(() => hit.classList.remove('hl'), 1600);
}
$('#log').addEventListener('click', (e) => { const rq = e.target.closest('.bubble .rq.in'); if (rq) { e.preventDefault(); goToQuoted(rq); } });
export function replyPrefix() { return replyTo ? `> ↩ @${replyTo.handle} : « ${replyTo.excerpt} »\n\n` : ''; }
export function clearReply() { replyTo = null; const c = $('#reply'); if (c) { c.hidden = true; c.innerHTML = ''; } }
// Conversation d'un bot : on répond à lui (@nom du profil) ou à soi-même (@toi), sans membre de groupe.

export function startReply(b) {
  const g = state.group, excerpt = replyExcerpt((() => { const c = b.cloneNode(true); c.querySelector('.author')?.remove(); c.querySelector('.rq')?.remove(); return c.innerText || c.textContent; })());
  if (g) {
    const m = g.room.members.find((x) => x.member_id === b.dataset.mid); if (!m?.handle) return;
    replyTo = { handle: m.handle, excerpt, name: b.querySelector('.author')?.firstChild?.textContent || m.handle, color: avatarOf(m.profile || m.member_id).color };
  } else {
    if (!state.chat) return;
    const handle = b.closest('.row.user') ? 'toi' : state.chat.bot.name;
    replyTo = { handle, excerpt, ...soloWho(handle) };
  }
  const c = $('#reply');
  c.style.setProperty('--c', replyTo.color);
  c.innerHTML = `<div class="rq"><b>Réponse à ${esc(replyTo.name)}</b><span>${esc(replyTo.excerpt.replace(/\u200b/g, ''))}</span></div><button type="button" class="rx" aria-label="Annuler la réponse">×</button>`;
  c.hidden = false; c.querySelector('.rx').onclick = () => { clearReply(); $('#input').focus(); };
  $('#input').focus();
}
