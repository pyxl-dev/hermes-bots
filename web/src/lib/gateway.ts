// Connexion JSON-RPC au gateway Hermes (un socket par ticket).
import { report } from "./util";

export const LOGIN_URL = "/login?next=" + encodeURIComponent(location.pathname);
export class AuthError extends Error {}
export type RpcError = Error & { code?: number; data?: any };

// Paramètres de base des méthodes d'ouverture (repli d'un invalid_params sans détail de champ).
const BASE_PARAMS: Record<string, string[]> = { "session.resume": ["session_id", "omit_messages"], "session.history": ["session_id"], "profiles.list": [] };

export class Gateway {
  profile: string | null;
  ws: WebSocket | null = null;
  seq = 0;
  pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: any) => void }>();
  onEvent: (ev: any) => void = () => {};
  onRequest: (frame: any) => void = () => {};
  onClose: (e?: CloseEvent) => void = () => {};
  constructor(profile?: string | null) {
    this.profile = profile || null;
  }
  get up() {
    return this.ws?.readyState === 1;
  }
  async connect() {
    const q = new URLSearchParams({ socket: "gateway" });
    if (this.profile) q.set("profile", this.profile);
    const r = await fetch("/api/webapp/socket-ticket?" + q, { method: "POST", credentials: "same-origin" });
    if (r.status === 401 || r.status === 403) throw new AuthError("login");
    if (!r.ok) throw new Error("ticket " + r.status + " " + (await r.text()).slice(0, 200));
    const { ticket } = await r.json();
    if (!ticket) throw new Error("ticket vide");
    const u = new URL("/api/ws", location.href);
    u.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    u.searchParams.set("ticket", ticket);
    if (this.profile) u.searchParams.set("profile", this.profile);
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(u);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("socket refusé"));
      ws.onmessage = (m) => this.frame(m.data);
      ws.onclose = (e) => {
        for (const p of this.pending.values()) p.reject(new Error("socket fermé"));
        this.pending.clear();
        reject(new Error("socket fermé " + e.code));
        this.onClose(e);
      };
    });
    return this;
  }
  private frame(raw: string) {
    let d: any;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    if (d.method === "event") return this.onEvent(d.params || {});
    if (d.method && d.id !== undefined) return this.onRequest(d); // requête serveur -> client
    const p = this.pending.get(d.id);
    if (!p) return;
    this.pending.delete(d.id);
    if (d.error) {
      const f = d.error.data?.fields || d.error.data?.field;
      const err: RpcError = Object.assign(
        new Error(p.method + " : " + (d.error.message || "erreur RPC") + (f ? " (" + ([] as any[]).concat(f).join(", ") + ")" : "")),
        { code: d.error.code, data: d.error.data }
      );
      report("rpc", err.message, p.method, { rpc: p.method, code: d.error.code });
      p.reject(err);
    } else p.resolve(d.result);
  }
  // Un invalid_params sur une méthode d'ouverture est réessayé une fois sans les champs refusés (data.fields), ou, à défaut,
  // avec les seuls paramètres de base : une panne de contrat ne doit pas bloquer l'ouverture.
  call<T = any>(method: string, params: Record<string, any> = {}, timeoutMs = 60000): Promise<T> {
    return this.rawCall(method, params, timeoutMs).catch((e: RpcError) => {
      if (!/invalid_params/.test(e.message) || !(method in BASE_PARAMS)) throw e;
      const bad = new Set(([] as string[]).concat(e.data?.fields || e.data?.field || []));
      const slim: Record<string, any> = {};
      for (const k of Object.keys(params)) if (bad.size ? !bad.has(k) : BASE_PARAMS[method].includes(k)) slim[k] = params[k];
      if (Object.keys(slim).length === Object.keys(params).length) throw e;
      return this.rawCall(method, slim, timeoutMs);
    });
  }
  private rawCall(method: string, params: Record<string, any>, timeoutMs: number): Promise<any> {
    if (!this.ws || this.ws.readyState !== 1) return Promise.reject(new Error("non connecté"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        report("rpc", method + " : délai dépassé", method, { rpc: method });
        reject(new Error(method + " : délai dépassé"));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws!.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }
  reply(id: unknown, result: unknown) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
  }
  close() {
    if (this.ws) {
      this.onClose = () => {};
      this.ws.close();
    }
  }
}
