// @ts-check
// Stockage local : localStorage (réglages, petit cache de messages) et IndexedDB (historique par bot).

import { SYNTHETIC_KINDS, asText, isSilent, looksSynthetic } from './util.js';

export const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// Recent messages per bot, kept on the phone so a chat shows at once while the gateway reconnects.
const CACHE_MAX = 60, CACHE_TEXT = 6000;
export const cacheKey = (name) => 'cache:' + name;
function cacheSlim(m) {
  const text = asText(m.text ?? m.content);
  if (SYNTHETIC_KINDS.has(m.display_kind)) return null;
  if (m.role === 'user') return looksSynthetic(text) ? null : { role: 'user', text: text.slice(0, CACHE_TEXT), timestamp: m.timestamp };
  if (m.role === 'assistant') return text.trim() && !isSilent(text) ? { role: 'assistant', text: text.slice(0, CACHE_TEXT), timestamp: m.timestamp } : null;
  if (m.role === 'tool') return { role: 'tool', name: m.name || m.tool_name || 'outil', text: text.slice(0, 400) };
  return null;
}
export function cacheSave(name, messages) {
  if (!name) return;
  const slim = []; for (const m of messages || []) { const x = cacheSlim(m); if (x) slim.push(x); }
  store.set(cacheKey(name), slim.slice(-CACHE_MAX));
}
export function cachePush(name, role, text) {
  if (!name || !text || !String(text).trim() || isSilent(text)) return;
  const list = store.get(cacheKey(name), []);
  list.push({ role, text: String(text).slice(0, CACHE_TEXT), timestamp: Date.now() / 1000 });
  store.set(cacheKey(name), list.slice(-CACHE_MAX));
}

export const idb = (() => {
  let db = null;
  const open = () => db || (db = new Promise((resolve, reject) => {
    const r = indexedDB.open('hermes-bots', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('history');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  }));
  const tx = async (mode, fn) => { const d = await open(); return new Promise((resolve, reject) => { const t = d.transaction('history', mode); const out = fn(t.objectStore('history')); t.oncomplete = () => resolve(out?.result); t.onerror = () => reject(t.error); }); };
  return { get: (k) => tx('readonly', (st) => st.get(k)).catch(() => null), put: (k, v) => tx('readwrite', (st) => st.put(v, k)).catch(() => {}) };
})();
export const rowKey = (name) => 'bot:' + name;
export const rowId = (m) => m.row_id ?? m.id;
