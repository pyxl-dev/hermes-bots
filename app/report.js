'use strict';
// Remontée des erreurs du client vers POST /bots/log (journal du serveur, alerte Hub au premier échec d'une version).
// Chargé avant les modules (script classique). Jamais bloquant, jamais récursif : un échec d'envoi est ignoré.
(() => {
  const seen = new Map(); let sent = 0;
  // États normaux d'un RPC (file d'attente, génération périmée, réseau coupé) : pas des erreurs de l'app.
  const BENIGN = /session_busy|profile_mismatch|stale_generation|stale_revision|non connecté|socket fermé|socket refusé/;
  window.reportError = function (kind, msg, where, extra) {
    try {
      msg = String(msg ?? '').slice(0, 500);
      if (!msg || BENIGN.test(msg) || sent >= 30) return;
      const key = kind + msg, now = Date.now();
      if (now - (seen.get(key) || 0) < 60000) return;
      seen.set(key, now); sent++;
      fetch('log', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: self.APP_VERSION || '?', kind, msg, where: String(where || '').slice(0, 200), ...(extra || {}) }) }).catch(() => {});
    } catch {}
  };
  window.addEventListener('error', (e) => window.reportError('error', e.message || (e.error && e.error.message), (e.filename || '').split('/').pop() + ':' + e.lineno));
  window.addEventListener('unhandledrejection', (e) => { const r = e.reason; window.reportError('rejection', (r && r.message) || r, r && r.stack ? String(r.stack).split('\n')[1] : ''); });
})();
