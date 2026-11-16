// @ts-check
// Épingles, couleur des bulles, personnages : stockés ici, synchronisés avec le serveur (/bots/prefs).

import { chatLook } from './chat.js';
import { renderGroups } from './groups.js';
import { botName, renderRoster } from './roster.js';
import { prefs, state } from './state.js';
import { store } from './store.js';
import { $ } from './util.js';

// Pinned bots stay on top of the roster (kept on this phone). Long-press (or right-click) a bot to pin it.
prefs.pinned = store.get('pinned', []);
export const isPinned = (name) => prefs.pinned.includes(name);
export function togglePin(name) {
  prefs.pinned = isPinned(name) ? prefs.pinned.filter((n) => n !== name) : [...prefs.pinned, name];
  store.set('pinned', prefs.pinned); store.set('pinned-dirty', true);
  try { navigator.vibrate?.(15); } catch {}
  renderPinned();
  syncPins();
}
// Pins live on the PWA server (prefs) so every device shows the same ones. A change made offline
// stays "dirty" and is pushed on the next sync; otherwise the server's list wins.
let pinSync = null, pinRetry = 0;
// Couleur de mes bulles (réglages) : --me et --me-text sur :root, texte foncé sur fond clair.
const ME_COLORS = ['#1f1f1f', '#3b82f6', '#7c5cff', '#22a06b', '#e8508e', '#f07b3f', '#f2b33d', '#e5484d'];
prefs.bubble = store.get('bubble', null);
export function applyBubble() {
  const c = /^#[0-9a-f]{6}$/i.test(prefs.bubble || '') ? prefs.bubble : ME_COLORS[0];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  document.documentElement.style.setProperty('--me', c);
  document.documentElement.style.setProperty('--me-text', lum > 0.4 ? '#0A0A0A' : '#fff');
}
export function paintMeColors() {
  const cur = (prefs.bubble || ME_COLORS[0]).toLowerCase(), custom = !ME_COLORS.includes(cur);
  $('#me-colors').innerHTML = ME_COLORS.map((x, i) => `<button type="button" role="radio" aria-checked="${x === cur}" aria-label="${i ? 'Couleur ' + x : 'Gris (par défaut)'}" data-me="${x}" style="background:${x}${i ? '' : ';box-shadow:inset 0 0 0 1px #3A3A3A'}"></button>`).join('')
    + `<label class="custom" role="radio" aria-checked="${custom}" aria-label="Couleur libre" style="display:inline-block;width:36px;height:36px;border-radius:50%;${custom ? 'box-shadow:0 0 0 3px var(--panel),0 0 0 5px #fff' : ''}"><input type="color" value="${cur}"></label>`;
}
export function setMyBubble(c) { prefs.bubble = c.toLowerCase(); store.set('bubble', prefs.bubble); applyBubble(); paintMeColors(); store.set('pinned-dirty', true); syncPins(); }
applyBubble();
export function syncPins() {
  if (pinSync) return pinSync.then(() => store.get('pinned-dirty', false) && syncPins());
  pinSync = (async () => {
    try {
      const dirty = store.get('pinned-dirty', false);
      const r = await fetch('prefs', dirty
        ? { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pinned: prefs.pinned, labels: pinLabels(), ...(store.get('avatars-synced', false) || Object.keys(prefs.avatars).length ? { avatars: prefs.avatars } : {}), ...(prefs.bubble ? { bubble: prefs.bubble } : {}) }) }
        : { credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) return;
      const d = await r.json();
      store.set('avatars-synced', true);
      if (dirty && JSON.stringify(d.pinned) === JSON.stringify(prefs.pinned)) store.set('pinned-dirty', false);
      // personnages : le serveur fait foi (comme les épingles) ; ceux d'avant la synchro partent une fois
      if (!dirty && d.avatars === undefined && Object.keys(prefs.avatars).length) { store.set('pinned-dirty', true); return; }
      if (!dirty && d.avatars && JSON.stringify(d.avatars) !== JSON.stringify(prefs.avatars)) { prefs.avatars = d.avatars; store.set('avatars', prefs.avatars); renderPinned(); }
      // couleur de mes bulles : le serveur fait foi ; une couleur choisie avant la synchro part une fois
      if (!dirty && d.bubble === undefined && prefs.bubble) { store.set('pinned-dirty', true); return; }
      if (!dirty && d.bubble && d.bubble !== prefs.bubble) { prefs.bubble = d.bubble; store.set('bubble', prefs.bubble); applyBubble(); }
      // server never written yet: this device's earlier (local-only) pins become the shared list
      if (!dirty && !d.updated && prefs.pinned.length) { store.set('pinned-dirty', true); return; }
      // épingles déjà là mais serveur sans les noms (ancienne version) : on les lui envoie une fois
      const lab = pinLabels();
      if (!dirty && JSON.stringify(d.pinned) === JSON.stringify(prefs.pinned) && Object.keys(lab).length && JSON.stringify(d.labels || {}) !== JSON.stringify(lab)) { store.set('pinned-dirty', true); return; }
      if (!dirty && Array.isArray(d.pinned) && JSON.stringify(d.pinned) !== JSON.stringify(prefs.pinned)) {
        prefs.pinned = d.pinned; store.set('pinned', prefs.pinned); renderPinned();
      }
    } catch {} finally { pinSync = null; pinStateUi(); }
  })();
  return pinSync.then(() => store.get('pinned-dirty', false) && !pinRetry++ && syncPins());
}
// Noms affichables des épingles, envoyés avec la liste : le serveur en fait les raccourcis de l'icône de l'app.
function pinLabels() {
  const out = {};
  for (const k of prefs.pinned) {
    const name = k.startsWith('room:') ? state.groups?.find((r) => r.room_id === k.slice(5))?.name : botName(state.bots.find((b) => b.name === k));
    if (name && name !== '?') out[k] = name;
  }
  return out;
}
// Bots are pinned by name, groups as 'room:<id>' (same list, same sync).
const pinOrder = (key) => (isPinned(key) ? prefs.pinned.indexOf(key) : 1e6);
function renderPinned() { renderRoster(); renderGroups(); chatLook(); }
// Personnage choisi pour un bot : stocké ici, envoyé avec les épingles (prefs serveur, champ avatars)
export function setAvatar(key, av) {
  prefs.avatars = { ...prefs.avatars, [key]: av }; store.set('avatars', prefs.avatars); store.set('pinned-dirty', true);
  syncPins();
}
export function pinStateUi() {
  const dirty = store.get('pinned-dirty', false), n = prefs.pinned.length;
  $('#pin-state').textContent = dirty ? 'En attente de connexion : envoyés dès que possible' : `${n} épingle${n > 1 ? 's' : ''}, partagées entre tes appareils`;
  $('#pin-dot').className = 'dot' + (dirty ? '' : ' ok');
}
const PIN_SVG = '<svg class="pin" viewBox="0 0 24 24" aria-label="épinglé"><path d="M16 3l5 5-3 1-4 4 1 5-2 2-4-4-5 5-1-1 5-5-4-4 2-2 5 1 4-4z" fill="currentColor"/></svg>';
