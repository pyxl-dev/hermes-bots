// @ts-check
// Petits outils sans état partagés par tous les modules.

export const $ = (s) => document.querySelector(s);

// Hermes' "nothing to say" reply ([SILENT], SILENT, NO_REPLY): the desktop app hides it, so do we.
const SILENT_RE = /^\s*\[?\s*(silent|no[_ ]reply)\s*\]?\s*$/i;
export const isSilent = (t) => SILENT_RE.test(String(t || ''));
export const toMs = (t) => (!t ? 0 : t > 1e12 ? t : t * 1000);
export function when(t) {
  const ms = toMs(t); if (!ms) return '';
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (+now - +d < 6 * 864e5) return d.toLocaleDateString('fr-FR', { weekday: 'short' });
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function asText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  if (typeof v === 'object') return v.text ?? JSON.stringify(v);
  return String(v);
}

export const log = () => $('#log');

// Synthetic user turns (background process done, delegation results, auto-continue...) are not
// the person speaking: the gateway tags them with display_kind, as the desktop reads them.
export const SYNTHETIC_KINDS = new Set(['hidden', 'process_complete', 'async_delegation_complete', 'auto_continue', 'model_switch', 'personality_switch', 'failed_turn']);
export const looksSynthetic = (t) => /^\s*\[(IMPORTANT|SYSTEM|Background process|Async)[^\]]{0,40}:/i.test(t);

export const newSubId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export async function apiErr(r) { let d = ''; try { d = (await r.json()).detail; } catch {} return new Error(`${r.status}${d ? ' ' + d : ''}`); }

/** Remontée d'erreur vers /bots/log (report.js, chargé en script classique avant les modules). */
export const report = (/** @type {any[]} */ ...a) => /** @type {any} */ (window).reportError?.(...a);
