// @ts-check
// Hermes Bots: a phone client for Hermes Bot Mode.
// Served on the same origin as the Hermes Webapp (tailscale serve, /bots/), so the Webapp login
// cookie authenticates us. Each socket dial mints a one-use ticket (POST /api/webapp/socket-ticket)
// and speaks the gateway JSON-RPC on /api/ws, the same contract the desktop Bot Mode uses:
// one bot = one profile = one canonical forever-chat, the session titled exactly "Bot Chat".
//
// Point d'entrée : charge chaque module (ceux qui posent des écouteurs au chargement), réveil, reconnexion,
// service worker, démarrage. Carte des modules : voir README.md, « Client en modules ».

import { attach, openBot, resyncBusy } from './chat.js';
import { initGroups, openGroup } from './groups.js';
import { loadRoster, renderRoster } from './roster.js';
import { openShare, sharedText } from './share.js';
import { state } from './state.js';
import { store } from './store.js';
import { $ } from './util.js';

// Modules à écouteurs ou minuteries posés au chargement (le reste arrive par imports).
import './approvals.js';
import './attachments.js';
import './botedit.js';
import './chat.js';
import './commands.js';
import './composer.js';
import './find.js';
import './groups.js';
import './history.js';
import './mentions.js';
import './msgmenu.js';
import './nav.js';
import './outbox.js';
import './prefs.js';
import './reply.js';
import './roster.js';
import './scroll.js';
import './send.js';
import './settings.js';
import './tasks.js';

window.addEventListener('online', () => { const c = state.chat; if (c && c.gw?.ws?.readyState !== 1) { clearTimeout(c.retryTimer); c.retryTimer = null; c.retries = 0; attach(c); } });
document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('bg', document.hidden); // animations en pause
  if (document.hidden) return;
  if (!$('#roster').hidden) loadRoster();
  else if (state.chat && state.chat.gw?.ws?.readyState !== 1) attach(state.chat);
  else if (state.chat?.busy) resyncBusy(state.chat);
});
setInterval(() => { if (!document.hidden && !$('#roster').hidden) loadRoster(); }, 30000);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
navigator.serviceWorker?.addEventListener('message', (e) => {
  const b = e.data?.bot; if (!b) return;
  if (b.startsWith('room:')) openGroup(b.slice(5)); else openBot(b);
});

// boot
initGroups();
state.bots = store.get('roster-cache', []);
renderRoster();
// iOS kills a backgrounded PWA and restarts it on the roster: reopen the chat you left (within the hour).
const LAST_CHAT_MS = 3600 * 1000;
const lastChat = store.get('last-chat', null);
const shared = sharedText(); // arrivée par le menu Partager d'Android : on choisit la destination, pas de réouverture auto
const bootTarget = shared ? '' : decodeURIComponent(location.hash.slice(1))
  || (lastChat && Date.now() - lastChat.ts < LAST_CHAT_MS ? (lastChat.kind === 'room' ? 'room-' + lastChat.name : lastChat.name) : '');
history.replaceState(null, '', location.pathname);
// A known bot opens at once from the roster cache (its messages from the chat cache); groups wait for the roster.
const earlyBot = bootTarget && !bootTarget.startsWith('room-') && state.bots.some((b) => b.name === bootTarget);
if (earlyBot) openBot(bootTarget);
Promise.resolve(loadRoster()).then(() => { if (shared) return openShare(shared); if (bootTarget && !earlyBot) (bootTarget.startsWith('room-') ? openGroup(bootTarget.slice(5)) : openBot(bootTarget)); }).catch(() => {});
