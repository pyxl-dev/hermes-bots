// @ts-check
// Connexion JSON-RPC au gateway Hermes (un socket par ticket).

import { report } from './util.js';

export const LOGIN_URL = '/login?next=' + encodeURIComponent(location.pathname);

export class AuthError extends Error {}

// Paramètres de base des méthodes d'ouverture (repli d'un invalid_params sans détail de champ).
const BASE_PARAMS = { 'session.resume': ['session_id', 'omit_messages'], 'session.history': ['session_id'], 'profiles.list': [] };

// ---------- gateway connection ----------
export class Gateway {
  constructor(profile) {
    this.profile = profile || null;
    this.ws = null; this.seq = 0; this.pending = new Map();
    /** @type {(...a: any[]) => any} */
    this.onEvent = () => {};
    /** @type {(...a: any[]) => any} */
    this.onRequest = () => {};
    /** @type {(...a: any[]) => any} */
    this.onClose = () => {};
  }
  async connect() {
    const q = new URLSearchParams({ socket: 'gateway' });
    if (this.profile) q.set('profile', this.profile);
    const r = await fetch('/api/webapp/socket-ticket?' + q, { method: 'POST', credentials: 'same-origin' });
    if (r.status === 401 || r.status === 403) throw new AuthError('login');
    if (!r.ok) throw new Error('ticket ' + r.status + ' ' + (await r.text()).slice(0, 200));
    const { ticket } = await r.json();
    if (!ticket) throw new Error('ticket vide');
    const u = new URL('/api/ws', location.href);
    u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('ticket', ticket);
    if (this.profile) u.searchParams.set('profile', this.profile);
    await new Promise((/** @type {any} */ resolve, reject) => {
      const ws = new WebSocket(u);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('socket refusé'));
      ws.onmessage = (m) => this._frame(m.data);
      ws.onclose = (e) => {
        for (const p of this.pending.values()) p.reject(new Error('socket fermé'));
        this.pending.clear();
        reject(new Error('socket fermé ' + e.code));
        this.onClose(e);
      };
    });
    return this;
  }
  _frame(raw) {
    let d; try { d = JSON.parse(raw); } catch { return; }
    if (d.method === 'event') return this.onEvent(d.params || {});
    if (d.method && d.id !== undefined) return this.onRequest(d); // server -> client request
    const p = this.pending.get(d.id);
    if (!p) return;
    this.pending.delete(d.id);
    if (d.error) {
      const f = d.error.data?.fields || d.error.data?.field;
      const err = Object.assign(new Error(p.method + ' : ' + (d.error.message || 'erreur RPC') + (f ? ' (' + [].concat(f).join(', ') + ')' : '')), { code: d.error.code, data: d.error.data });
      report('rpc', err.message, p.method, { rpc: p.method, code: d.error.code });
      p.reject(err);
    }
    else p.resolve(d.result);
  }
  // Un invalid_params sur une méthode d'ouverture est réessayé une fois sans les champs refusés (data.fields), ou, à défaut,
  // avec les seuls paramètres de base : une panne de contrat (inline_images, 2026-11-14) ne doit pas bloquer l'ouverture.
  // L'échec d'origine est déjà remonté à /bots/log par _frame.
  call(method, params = {}, timeoutMs = 60000) {
    return this._call(method, params, timeoutMs).catch((e) => {
      if (!/invalid_params/.test(e.message) || !(method in BASE_PARAMS)) throw e;
      const bad = new Set([].concat(e.data?.fields || e.data?.field || []));
      const slim = {}; for (const k of Object.keys(params)) if (bad.size ? !bad.has(k) : BASE_PARAMS[method].includes(k)) slim[k] = params[k];
      if (Object.keys(slim).length === Object.keys(params).length) throw e;
      return this._call(method, slim, timeoutMs);
    });
  }
  _call(method, params, timeoutMs) {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error('non connecté'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); report('rpc', method + ' : délai dépassé', method, { rpc: method }); reject(new Error(method + ' : délai dépassé')); }, timeoutMs);
      this.pending.set(id, { method, resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  reply(id, result) { this.ws?.readyState === 1 && this.ws.send(JSON.stringify({ jsonrpc: '2.0', id, result })); }
  close() { if (this.ws) { this.onClose = () => {}; this.ws.close(); } }
}
