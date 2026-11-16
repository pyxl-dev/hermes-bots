// @ts-check
// Notifications, Web Push et page Réglages.

import { fillTeam } from './groups.js';
import { show } from './nav.js';
import { applyBubble, paintMeColors, pinStateUi, setMyBubble } from './prefs.js';
import { botName } from './roster.js';
import { prefs } from './state.js';
import { $ } from './util.js';

// ---------- notifications ----------
export async function notify(bot, body) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await navigator.serviceWorker?.getRegistration();
    const title = bot._room ? bot.display_name : botName(bot);
    if (reg) reg.showNotification(title, { body, tag: 'bot-' + bot.name, icon: 'icon-192.png', badge: 'badge-96.png', data: { bot: bot.name } });
    else new Notification(title, { body });
  } catch {}
}

// ---------- Web Push : notifs envoyées par server.ts même app fermée (remplace Hub) ----------
const pushOk = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const b64u = (s) => { const p = '='.repeat((4 - (s.length % 4)) % 4), r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(r, (ch) => ch.charCodeAt(0)); };
const deviceName = () => (/iPhone|iPad|Android|Macintosh|Windows/.exec(navigator.userAgent)?.[0] || 'appareil') + (matchMedia('(display-mode: standalone)').matches ? ' (app)' : ' (navigateur)');
async function pushSub() { const reg = await navigator.serviceWorker.ready; return reg.pushManager.getSubscription(); }
async function pushPost(path, sub) {
  const r = await fetch('push/' + path, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON(), device: deviceName() }) });
  if (!r.ok) { let d = ''; try { d = (await r.json()).detail; } catch {} throw new Error(d || 'erreur ' + r.status); }
  return r.json();
}
async function refreshBell() {
  let on = false; try { on = pushOk() && Notification.permission === 'granted' && !!(await pushSub()); } catch {} return on;
}
// Page Réglages (remplace la cloche) : notifications, équipes, état de la synchro des épingles
async function refreshNotif() {
  const on = await refreshBell(), st = $('#nf-state');
  if (!pushOk()) st.textContent = /iPhone|iPad/.test(navigator.userAgent) && !matchMedia('(display-mode: standalone)').matches
    ? 'Sur iPhone, ajoute d’abord Hermes Bots à l’écran d’accueil (Partager, Sur l’écran d’accueil), puis ouvre-le de là.'
    : 'Ce navigateur ne gère pas les notifications push.';
  else if (Notification.permission === 'denied') st.textContent = 'Bloquées pour ce site : autorise-les dans les réglages du navigateur.';
  else st.textContent = on ? 'Actives sur cet appareil' : 'Coupées sur cet appareil';
  const tg = $('#nf-toggle'); tg.setAttribute('aria-checked', String(on)); tg.disabled = !pushOk() || Notification.permission === 'denied';
  $('#nf-test').hidden = !on;
}
function openSettings() {
  history.pushState({ settings: 1 }, '', '#settings');
  show('settings'); refreshNotif(); pinStateUi(); paintMeColors();
  fillTeam();
}
$('#settings-btn').addEventListener('click', openSettings);
$('#set-back').addEventListener('click', () => history.back());
$('#me-colors').addEventListener('click', (e) => { const b = e.target.closest('[data-me]'); if (b) setMyBubble(b.dataset.me); });
$('#me-colors').addEventListener('input', (e) => { if (e.target.type === 'color') { prefs.bubble = e.target.value; applyBubble(); } });
$('#me-colors').addEventListener('change', (e) => { if (e.target.type === 'color') setMyBubble(e.target.value); });
$('#teams-set').addEventListener('click', (e) => {
  const b = e.target.closest('[data-t]'); if (!b) return;
  const i = $('#' + b.dataset.t), v = Number(i.value) + Number(b.dataset.s);
  i.value = Math.max(Number(i.min), Math.min(Number(i.max), v));
});
$('#nf-toggle').addEventListener('click', async () => {
  const msg = $('#nf-msg'); msg.textContent = '…';
  try {
    let sub = await pushSub();
    if (sub) { await pushPost('unsubscribe', sub).catch(() => {}); await sub.unsubscribe(); msg.textContent = 'Coupées.'; }
    else {
      if ((await Notification.requestPermission()) !== 'granted') { msg.textContent = 'Permission refusée.'; return; }
      const { key } = await (await fetch('push/key', { credentials: 'same-origin' })).json();
      const reg = await navigator.serviceWorker.ready;
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(key) });
      const r = await pushPost('subscribe', sub);
      msg.textContent = `Activées (${r.devices} appareil${r.devices > 1 ? 's' : ''}).`;
    }
  } catch (e) { msg.textContent = 'Échec : ' + e.message; }
  refreshNotif();
});
$('#nf-test').addEventListener('click', async () => {
  const msg = $('#nf-msg'); msg.textContent = '…';
  try { const sub = await pushSub(); if (!sub) throw new Error('pas abonné'); const r = await pushPost('test', sub); msg.textContent = r.ok ? 'Envoyée : elle arrive dans quelques secondes.' : 'Le service push a refusé l’envoi.'; }
  catch (e) { msg.textContent = 'Échec : ' + e.message; }
});
