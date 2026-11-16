// Journal JSONL et alerte Hub partagés par server.ts et les scripts de livraison.
// Chaque action : { ts, action, ok, cause? } dans ~/.local/state/hermes-bots-pwa/actions.jsonl.
import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOG_DIR = join(homedir(), ".local", "state", "hermes-bots-pwa");
export const LOG = join(LOG_DIR, "actions.jsonl");
mkdirSync(LOG_DIR, { recursive: true });

// Rotation : au-delà de LOG_MAX octets, le journal devient actions.jsonl.1 (l'ancien .1 est remplacé). Sans elle, chaque
// 404 et chaque erreur client l'allongeaient pour toujours, et `status` le relit en entier.
export const LOG_OLD = LOG + ".1";
const LOG_MAX = Number(process.env.HERMES_BOTS_LOG_MAX || 5 * 1024 * 1024);
export const log = (action: string, ok: boolean, cause?: string, extra?: Record<string, unknown>) => {
  try { if (statSync(LOG).size > LOG_MAX) renameSync(LOG, LOG_OLD); } catch {}
  appendFileSync(LOG, JSON.stringify({ ts: new Date().toISOString(), action, ok, ...(cause ? { cause } : {}), ...(extra ?? {}) }) + "\n");
};

// Alerte Hub sur un vrai échec : au plus une par heure et par clé, pour qu'une boucle de redémarrage ne spamme pas.
// `key` vaut l'action par défaut ; les erreurs client passent une clé par version (alerte au premier échec d'une version).
const ALERTS = join(LOG_DIR, "alerts.json");
const HUB_NOTIFY = join(homedir(), "bin", "hub-notify");
export function alert(action: string, cause: string, opts: { key?: string; windowMs?: number } = {}) {
  const key = opts.key ?? action;
  let last: Record<string, number> = {};
  try { last = JSON.parse(readFileSync(ALERTS, "utf8")); } catch {}
  if (Date.now() - (last[key] ?? 0) < (opts.windowMs ?? 3600_000)) return;
  last[key] = Date.now();
  const tmp = `${ALERTS}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(last)); renameSync(tmp, ALERTS); // atomique
  execFile(HUB_NOTIFY, ["-t", "hermes-bots", "-T", `PWA Hermes Bots : échec ${action}`, "-p", "4", cause.slice(0, 500)], (e) => {
    log("alert", !e, e ? e.message : key);
  });
}
