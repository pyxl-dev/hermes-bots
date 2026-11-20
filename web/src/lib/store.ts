// Stockage local : localStorage (réglages, petit cache de messages) et IndexedDB (historique par bot et par groupe).
import { SYNTHETIC_KINDS, asText, isSilent, looksSynthetic } from "./util";

const sameShape = (v: any, d: any) =>
  Array.isArray(d) ? Array.isArray(v) : typeof d === "object" ? !!v && typeof v === "object" && !Array.isArray(v) : typeof v === typeof d;
export const store = {
  // Cache corrompu (JSON invalide, ou d'une autre forme que la valeur par défaut) : la valeur par défaut, jamais un plantage au démarrage.
  get<T = any>(k: string, d?: T): T {
    try {
      const raw = localStorage.getItem(k);
      if (raw === null) return d as T;
      const v = JSON.parse(raw);
      if (d !== undefined && d !== null && !sameShape(v, d)) return d as T;
      return v;
    } catch {
      return d as T;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {}
  },
  del(k: string) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

// Derniers messages par bot, gardés sur le téléphone : le fil s'affiche tout de suite pendant la reconnexion.
const CACHE_MAX = 60,
  CACHE_TEXT = 6000;
export const cacheKey = (name: string) => "cache:" + name;
function cacheSlim(m: any) {
  const text = asText(m.text ?? m.content);
  if (SYNTHETIC_KINDS.has(m.display_kind)) return null;
  if (m.role === "user") return looksSynthetic(text) ? null : { role: "user", text: text.slice(0, CACHE_TEXT), timestamp: m.timestamp };
  if (m.role === "assistant") return text.trim() && !isSilent(text) ? { role: "assistant", text: text.slice(0, CACHE_TEXT), timestamp: m.timestamp } : null;
  if (m.role === "tool") return { role: "tool", name: m.name || m.tool_name || "outil", text: text.slice(0, 400) };
  return null;
}
export function cacheSave(name: string, messages: any[]) {
  if (!name) return;
  const slim: any[] = [];
  for (const m of messages || []) {
    const x = cacheSlim(m);
    if (x) slim.push(x);
  }
  store.set(cacheKey(name), slim.slice(-CACHE_MAX));
}
export function cachePush(name: string, role: string, text: string | undefined) {
  if (!name || !text || !String(text).trim() || isSilent(text)) return;
  const list = store.get<any[]>(cacheKey(name), []);
  list.push({ role, text: String(text).slice(0, CACHE_TEXT), timestamp: Date.now() / 1000 });
  store.set(cacheKey(name), list.slice(-CACHE_MAX));
}

export const idb = (() => {
  let db: Promise<IDBDatabase> | null = null;
  const open = () =>
    db ||
    (db = new Promise((resolve, reject) => {
      const r = indexedDB.open("hermes-bots", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("history");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    }));
  const tx = async (mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void) => {
    const d = await open();
    return new Promise<any>((resolve, reject) => {
      const t = d.transaction("history", mode);
      const out = fn(t.objectStore("history"));
      t.oncomplete = () => resolve(out ? out.result : undefined);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    get: (k: string): Promise<any> => tx("readonly", (st) => st.get(k)).catch(() => null),
    put: (k: string, v: unknown): Promise<void> => tx("readwrite", (st) => st.put(v, k)).catch(() => {}),
    del: (k: string): Promise<void> => tx("readwrite", (st) => st.delete(k)).catch(() => {}),
  };
})();
export const rowKey = (name: string) => "bot:" + name;
export const rowId = (m: any) => m.row_id ?? m.id;
