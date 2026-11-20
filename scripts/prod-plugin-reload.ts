// Recharge à chaud bot-groups dans le gateway de PROD, sans redémarrage (Yoan, 2026-11-18 : « des releases sans restart le gateway »).
//   bun scripts/prod-plugin-reload.ts [--dir <dossier du plugin servi>]
// Passe par le socket local du gateway (scripts/prod-rpc.py, python du venv hermes-agent), plus par le navigateur CDP :9334 :
// un navigateur bloqué faisait annoncer « redémarrage prod requis » alors que la prod répondait (issue 91, 2026-11-18).
// 1. plugin.bot-groups.health : empreinte du code chargé (prise au chargement) ; égale à celle du dossier servi -> rien à faire.
//    Un plugin sans champ `disk` (avant le 2026-11-18) annonce l'empreinte du disque, pas du code chargé : rechargé d'office.
// 2. sinon plugin.bot-groups.reload, puis health : code chargé = dossier servi, une seule boucle resume et sweeper.
// Sortie 0 : la prod tourne avec le plugin servi. 3 : rechargement impossible (plugin sans health/reload, échec), redémarrer.
// 1 : contrôle impossible (python du venv absent, gateway muet). Chaque passage écrit une ligne dans actions.jsonl ; un échec envoie une alerte Hub.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alert, log } from "../lib/journal";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf("--" + k);
  return i > 0 ? process.argv[i + 1] : d;
};
const DIR = arg("dir", join(import.meta.dir, "..", "plugins", "bot-groups"));
const PY = join(homedir(), ".hermes", "hermes-agent", "venv", "bin", "python");

// même calcul que lifecycle.code_id() : sha256 de « nom\0contenu » des *.py, triés par nom, 12 caractères
function codeId(dir: string): string {
  const h = createHash("sha256");
  for (const f of readdirSync(dir)
    .filter((n) => n.endsWith(".py"))
    .sort()) {
    h.update(f + "\0");
    h.update(readFileSync(join(dir, f)));
  }
  return h.digest("hex").slice(0, 12);
}

const end = (code: number, ok: boolean, msg: string): never => {
  log("prod_plugin_reload", ok, msg);
  if (!ok) alert("prod_plugin_reload", msg, { windowMs: 0 });
  console[ok ? "log" : "error"]((ok ? "rechargement prod : " : "rechargement prod ÉCHEC : ") + msg);
  process.exit(code);
};

const want = codeId(DIR);
if (!existsSync(PY)) end(1, false, `python du venv hermes-agent absent (${PY})`);
// erreur RPC (méthode inconnue, refus) : rejet avec le message du gateway ; gateway injoignable : rejet « injoignable »
const rpc = async (method: string, ms = 20000): Promise<any> => {
  const r = spawnSync(PY, [join(import.meta.dir, "prod-rpc.py"), DIR, method, String(ms / 1000)], { encoding: "utf8", timeout: ms + 15000 });
  const out = (r.stdout || "").trim().split("\n").pop() || "";
  if (r.status === 0) return JSON.parse(out);
  if (r.status === 2) throw new Error(JSON.parse(out).error);
  throw new Error(`gateway injoignable : ${(r.stderr || r.error?.message || "").trim().split("\n").pop()?.slice(0, 160)}`);
};
{
  let h: any,
    err = "";
  for (const t = Date.now() + 30000; Date.now() < t && !h; await Bun.sleep(1000)) {
    h = await rpc("plugin.bot-groups.health").catch((e) => {
      err = String(e.message || e);
      return null;
    });
    if (!h && /unknown|not found|method/i.test(err)) break; // plugin d'avant le rechargement à chaud : seul un redémarrage le remplace
  }
  if (!h && /injoignable/.test(err)) end(1, false, `contrôle impossible, ${err.slice(0, 200)}`);
  if (!h) end(3, false, `plugin.bot-groups.health indisponible (${err.slice(0, 160)}) : redémarrage de la prod requis`);
  // 2026-11-18 : l'ancien health relisait le disque ; après le git pull il disait « déjà à jour » sans rien recharger
  if (h.disk !== undefined && h.code === want) end(0, true, `déjà à jour (code chargé ${want}, génération ${h.gen})`);
  const r = await rpc("plugin.bot-groups.reload", 60000).catch((e) => ({ ok: false, error: String(e.message || e) }));
  if (!r.ok) end(3, false, `reload refusé : ${r.error || JSON.stringify(r).slice(0, 200)}`);
  if (r.after !== want) end(3, false, `code chargé ${r.after}, attendu ${want} (dossier servi)`);
  let th: Record<string, number> = {},
    h2: any = {};
  for (const t = Date.now() + 15000; Date.now() < t; await Bun.sleep(500)) {
    h2 = (await rpc("plugin.bot-groups.health").catch(() => ({}))) || {};
    th = h2.threads || {};
    if (th["bot-groups-resume"] === 1 && th["bot-groups-trace-sweeper"] === 1) break;
  }
  if (th["bot-groups-resume"] !== 1 || th["bot-groups-trace-sweeper"] !== 1) end(3, false, `boucles de fond après rechargement : ${JSON.stringify(th)}`);
  if (h2.code !== want) end(3, false, `après rechargement, code chargé ${h2.code}, attendu ${want} (dossier servi)`);
  end(0, true, `${r.copies} copie(s) rechargée(s) en ${r.ms} ms, code ${h.code} -> ${r.after}`);
}
