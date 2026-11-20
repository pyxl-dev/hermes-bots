// Bascule de la mémoire partagée (Hindsight) sur le gateway de PROD (~/.hermes). Validé par Yoan le 2026-11-16.
//   bun scripts/memory-prod.ts status | stage | key-help | apply | hygiene | rollback
// - stage   : installe le plugin hindsight dans ~/.hermes/plugins et écrit ~/.hindsight/config.json. Ne touche à
//             aucun config.yaml : Hermes relit config.yaml à chaud, la ligne provider activerait la mémoire avant
//             le redémarrage. Sauvegarde et compare les config.yaml avant et après l'installation.
// - key-help: affiche la commande que Yoan lance lui-même pour poser la clé LLM du démon (jamais copiée par ce script).
// - apply   : à lancer JUSTE AVANT `hermes gateway restart --yes` : sauvegarde, lie le plugin dans chaque profil,
//             ajoute `provider: hindsight` au bloc memory de chaque config.yaml.
// - hygiene : pose sur chaque banque (existantes + une par profil + equipe) les réglages de nettoyage : les souvenirs
//             consolidés remplacent au rappel les faits bruts dont ils viennent (doublons, faits périmés), et la
//             consigne de rétention écarte les non-réponses (« inconnu »). Réglage du démon, sans redémarrage.
// - rollback: remet les config.yaml de la dernière sauvegarde d'apply et retire les liens (puis redémarrage).
// Montage (prouvé sur le gateway de test, test/memory-group-journey.ts) : banque privée `hermes-{profile}`, banque
// commune `equipe` lue et écrite par tous, démon local_embedded du profil `hermes-prod`, LLM deepseek-v4.1-flash
// sur opencode-go. Journal : lignes memory_prod_* dans actions.jsonl, alerte Hub sur échec.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alert, log } from "../lib/journal";

// MEMORY_PROD_HOME=~/.hermes-test-<nom> : répétition sur une instance du gateway de test (HOME simulé dans _home).
const SIM = process.env.MEMORY_PROD_HOME;
if (SIM && !/^\/.+\/\.hermes-test-[\w-]+$/.test(SIM)) {
  console.error("MEMORY_PROD_HOME doit être ~/.hermes-test-<nom>");
  process.exit(2);
}
const PROD = SIM ?? join(homedir(), ".hermes");
const HOME = SIM ? join(SIM, "_home") : homedir();
const ENV = { ...process.env, HERMES_HOME: PROD, HOME };
const HERMES_BIN = join(homedir(), ".hermes", "hermes-agent", ".hermes", "bin", "hermes");
const PLUGIN = join(PROD, "plugins", "hindsight");
const HS_DIR = join(HOME, ".hindsight");
// nom distinct en répétition : le port du démon dérive du nom, deux démons « hermes-prod » se disputeraient le port
const DAEMON_PROFILE = SIM ? "hermes-prodsim" : "hermes-prod";
const KEY_FILE = join(HS_DIR, "profiles", `${DAEMON_PROFILE}.env`);
const BACKUPS = join(PROD, "backups");
const say = (s: string) => console.log(s);

export const HINDSIGHT = {
  mode: "local_embedded",
  profile: DAEMON_PROFILE,
  bank_id: "hermes",
  bank_id_template: "hermes-{profile}",
  additional_banks: ["equipe"],
  memory_mode: "hybrid",
  auto_recall: true,
  auto_retain: true,
  retain_async: false,
  observation_scopes: "shared",
  recall_types: "observation,world,experience",
  llm_provider: "openai_compatible",
  llm_model: "deepseek-v4.1-flash",
  llm_base_url: "https://opencode.ai/zen/go/v1",
};

const profiles = () =>
  readdirSync(join(PROD, "profiles"))
    .filter((p) => existsSync(join(PROD, "profiles", p, "config.yaml")))
    .sort();
const homes = () => [PROD, ...profiles().map((p) => join(PROD, "profiles", p))];
const cfgOf = (home: string) => join(home, "config.yaml");
const hasProvider = (yaml: string) => /^memory:\s*\n(?:[ \t]+.*\n)*?[ \t]+provider:\s*hindsight\b/m.test(yaml);

// Le plugin lit `bank_retain_mission` mais ne l'envoie jamais au démon (hindsight 1.2.4) : on règle les banques par l'API.
// Dédoublonnage et élagage au rappel (recall_decision_model_*) exigent un modèle de décision global, que le plugin ne
// transmet pas : sans effet ici, donc non posés.
export const HYGIENE = {
  recall_prefer_observations: true,
  retain_mission:
    "Retiens les faits durables : décisions, préférences, noms, codes, dates, chiffres, résultats, " +
    "qu'ils viennent de Yoan ou d'un bot. Ne retiens jamais une absence d'information : réponses du type « inconnu », " +
    "« je ne sais pas », « je n'ai pas trouvé », « pas d'information », ni les questions elles-mêmes. Quand un fait " +
    "remplace un fait plus ancien sur le même sujet, formule-le comme la valeur actuelle, datée.",
};

function daemonUrl(): string {
  const env = readdirSync(join(PROD, "installs"))
    .map((d) => join(PROD, "installs", d, "facts.json"))
    .filter(existsSync)
    .map((f) => readFileSync(f, "utf8").match(/"environment": "([^"]+\/venv)"/)?.[1])
    .find((e) => e && existsSync(join(e, "lib", "python3.14", "site-packages", "hindsight_embed")));
  if (!env) throw new Error("aucun environnement Hermes avec hindsight_embed : bun scripts/memory-prod.ts apply");
  // même calcul que hindsight_embed (port dérivé du nom de profil, surcharges du .env du profil comprises)
  const r = spawnSync(
    join(env, "bin", "python"),
    ["-c", `from hindsight_embed.profile_manager import ProfileManager\nprint(ProfileManager().resolve_profile_paths(${JSON.stringify(DAEMON_PROFILE)}).port)`],
    { env: { ...process.env, HOME }, encoding: "utf8" }
  );
  const port = Number(r.stdout.trim());
  if (!port) throw new Error("port du démon introuvable : " + (r.stderr || "").trim().slice(-200));
  return `http://127.0.0.1:${port}/v1/default/banks`;
}

async function hygiene() {
  const base = daemonUrl();
  const res = await fetch(base, { signal: AbortSignal.timeout(5000) }).catch(() => null);
  if (!res?.ok) throw new Error(`démon injoignable (${base}) : il démarre au premier tour d'un bot`);
  const existing = ((await res.json()) as any).banks.map((b: any) => b.bank_id as string);
  const banks = [...new Set([...existing, "equipe", ...profiles().map((p) => `hermes-${p}`)])].sort();
  const bad: string[] = [];
  for (const b of banks) {
    const r = await fetch(`${base}/${encodeURIComponent(b)}/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: HYGIENE }),
      signal: AbortSignal.timeout(10000),
    });
    const c = r.ok ? ((await r.json()) as any).config : null;
    if (!c || c.recall_prefer_observations !== true || c.retain_mission !== HYGIENE.retain_mission) bad.push(`${b} (${r.status})`);
  }
  if (bad.length) throw new Error("réglage refusé ou non relu sur " + bad.join(", "));
  log("memory_prod_hygiene", true, undefined, { banks: banks.length });
  say(`nettoyage posé et relu sur ${banks.length} banques (${base})`);
}

function backup(tag: string): string {
  const dir = join(BACKUPS, `memory-${tag}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  for (const h of homes()) {
    const rel = h === PROD ? "root" : h.slice(PROD.length + 1);
    mkdirSync(join(dir, rel), { recursive: true });
    cpSync(cfgOf(h), join(dir, rel, "config.yaml"));
  }
  return dir;
}
function sameAsBackup(dir: string): string[] {
  return homes().filter(
    (h) => readFileSync(cfgOf(h), "utf8") !== readFileSync(join(dir, h === PROD ? "root" : h.slice(PROD.length + 1), "config.yaml"), "utf8")
  );
}
function keyPresent(): boolean {
  // lit seulement la présence du nom de variable, jamais la valeur
  try {
    return /^HINDSIGHT_API_LLM_API_KEY=.+/m.test(readFileSync(KEY_FILE, "utf8"));
  } catch {
    return false;
  }
}

function depsReady(): boolean {
  for (const f of readdirSync(join(PROD, "installs"))
    .map((d) => join(PROD, "installs", d, "facts.json"))
    .filter(existsSync)) {
    const env = readFileSync(f, "utf8").match(/"environment": "([^"]+\/venv)"/)?.[1];
    if (env && existsSync(join(env, "lib", "python3.14", "site-packages", "hindsight_embed"))) return true;
  }
  return false;
}

function stage() {
  const dir = backup("stage");
  if (!existsSync(PLUGIN)) {
    const t = Date.now();
    const r = spawnSync(HERMES_BIN, ["plugins", "install", "hindsight", "--yes-deps", "--no-enable"], {
      env: ENV,
      encoding: "utf8",
      timeout: 900_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.status !== 0) throw new Error("installation du plugin : " + (r.stderr || r.stdout || "").trim().slice(-400));
    say(`plugin hindsight installé en ${Math.round((Date.now() - t) / 1000)} s`);
  } else say("plugin hindsight déjà présent");
  const changed = sameAsBackup(dir);
  if (changed.length) throw new Error(`l'installation a modifié ${changed.join(", ")} (sauvegarde : ${dir})`);
  mkdirSync(join(HS_DIR, "profiles"), { recursive: true });
  writeFileSync(join(HS_DIR, "config.json"), JSON.stringify(HINDSIGHT, null, 2) + "\n");
  log("memory_prod_stage", true, undefined, { backup: dir });
  say(`prêt : ${PLUGIN}, ${join(HS_DIR, "config.json")} ; aucun config.yaml modifié (sauvegarde ${dir})`);
  if (!keyPresent()) say("clé LLM absente : bun scripts/memory-prod.ts key-help");
}

function keyHelp() {
  // une seule commande pour la prod et, si elle existe, l'instance de répétition ~/.hermes-test-prodsim
  const sim = join(homedir(), ".hermes-test-prodsim");
  const files = [
    join(homedir(), ".hindsight", "profiles", "hermes-prod.env"),
    ...(existsSync(sim) ? [join(sim, "_home", ".hindsight", "profiles", "hermes-prodsim.env")] : []),
  ];
  say(
    `k=$(grep '^OPENCODE_GO_API_KEY=' ~/.hermes/.env | cut -d= -f2-); for f in ${files.map((f) => `"${f}"`).join(" ")}; do mkdir -p "$(dirname "$f")"; printf 'HINDSIGHT_API_LLM_API_KEY=%s\\n' "$k" > "$f"; chmod 600 "$f"; done; unset k`
  );
}

function apply() {
  if (!existsSync(PLUGIN)) throw new Error("plugin absent : bun scripts/memory-prod.ts stage");
  if (!keyPresent() && !SIM) throw new Error(`clé LLM absente de ${KEY_FILE} : bun scripts/memory-prod.ts key-help`);
  const dir = backup("apply");
  let n = 0;
  for (const h of homes()) {
    if (h !== PROD) {
      const link = join(h, "plugins", "hindsight");
      mkdirSync(join(h, "plugins"), { recursive: true });
      if (!existsSync(link)) symlinkSync(PLUGIN, link);
    }
    const yaml = readFileSync(cfgOf(h), "utf8");
    if (hasProvider(yaml)) continue;
    if (/^memory:\s*\n[ \t]+provider:/m.test(yaml)) throw new Error(`${cfgOf(h)} a déjà un autre memory.provider`);
    const next = /^memory:\s*$/m.test(yaml)
      ? yaml.replace(/^memory:\s*\n/m, "memory:\n  provider: hindsight\n")
      : yaml.replace(/\n?$/, "\n") + "memory:\n  provider: hindsight\n";
    writeFileSync(cfgOf(h), next);
    n++;
  }
  const missing = homes().filter((h) => !hasProvider(readFileSync(cfgOf(h), "utf8")));
  if (missing.length) throw new Error("provider non posé dans " + missing.join(", "));
  // Les dépendances Python d'un plugin inactif ne sont pas installées (« inactive plugin ») ; sans cette étape
  // elles s'installeraient paresseusement au premier tour, sous verrou, pendant que les bots répondent.
  const t = Date.now();
  const pm = spawnSync(HERMES_BIN, ["pm", "install"], { env: ENV, encoding: "utf8", timeout: 900_000, stdio: ["ignore", "pipe", "pipe"] });
  if (pm.status !== 0) throw new Error("hermes pm install : " + (pm.stderr || pm.stdout || "").trim().slice(-400));
  if (!depsReady()) throw new Error("hermes pm install n'a pas installé hindsight_embed dans l'environnement courant");
  say(`dépendances Hindsight installées en ${Math.round((Date.now() - t) / 1000)} s`);
  log("memory_prod_apply", true, undefined, { backup: dir, changed: n, profiles: homes().length });
  say(`${n} config.yaml modifiés sur ${homes().length} (sauvegarde ${dir}). Redémarrage : hermes gateway restart --yes`);
}

function rollback() {
  const last = readdirSync(BACKUPS)
    .filter((d) => d.startsWith("memory-apply-"))
    .sort()
    .pop();
  if (!last) throw new Error("aucune sauvegarde memory-apply-*");
  const dir = join(BACKUPS, last);
  for (const h of homes()) {
    const src = join(dir, h === PROD ? "root" : h.slice(PROD.length + 1), "config.yaml");
    if (existsSync(src)) cpSync(src, cfgOf(h));
    const link = join(h, "plugins", "hindsight");
    if (h !== PROD && existsSync(link) && lstatSync(link).isSymbolicLink()) rmSync(link);
  }
  log("memory_prod_rollback", true, undefined, { backup: dir });
  say(`config.yaml restaurés depuis ${dir}, liens retirés. Redémarrage : hermes gateway restart --yes`);
}

async function status() {
  const on = homes().filter((h) => hasProvider(readFileSync(cfgOf(h), "utf8"))).length;
  say(`plugin        : ${existsSync(PLUGIN) ? "installé" : "absent"}`);
  say(`config        : ${existsSync(join(HS_DIR, "config.json")) ? "écrite" : "absente"}`);
  say(`clé LLM       : ${keyPresent() ? "posée" : "absente"}`);
  say(`dépendances   : ${existsSync(join(PROD, "installs")) && depsReady() ? "installées" : "absentes"}`);
  say(`profils actifs: ${on}/${homes().length} (memory.provider: hindsight)`);
  try {
    const base = daemonUrl();
    const banks = (((await (await fetch(base, { signal: AbortSignal.timeout(5000) })).json()) as any).banks as any[]).map((b) => b.bank_id as string);
    const missing: string[] = [];
    for (const b of banks) {
      const c = ((await (await fetch(`${base}/${encodeURIComponent(b)}/config`)).json()) as any).config;
      if (c?.recall_prefer_observations !== true || c?.retain_mission !== HYGIENE.retain_mission) missing.push(b);
    }
    say(
      `nettoyage     : ${banks.length - missing.length}/${banks.length} banques${missing.length ? " ; sans réglage : " + missing.join(", ") + " (bun scripts/memory-prod.ts hygiene)" : ""}`
    );
  } catch {
    say("nettoyage     : démon arrêté (il démarre au premier tour d'un bot)");
  }
  try {
    const lines = readFileSync(join(homedir(), ".local", "state", "hermes-bots-pwa", "actions.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes('"memory_prod_'))
      .slice(-6);
    for (const l of lines) {
      const j = JSON.parse(l);
      say(`  ${j.ts} ${j.action} ${j.ok ? "ok" : "ÉCHEC"} ${j.cause ?? ""}`);
    }
  } catch {}
}

if (import.meta.main) {
  const cmd = process.argv[2];
  const run: Record<string, () => unknown> = { status, stage, "key-help": keyHelp, apply, hygiene, rollback };
  Promise.resolve()
    .then(() =>
      run[cmd] ? run[cmd]() : (say("usage : bun scripts/memory-prod.ts status | stage | key-help | apply | hygiene | rollback"), (process.exitCode = 2))
    )
    .catch((e) => {
      const cause = (e as Error).message;
      log(`memory_prod_${cmd}`, false, cause);
      alert(`memory_prod_${cmd}`, cause);
      say("ÉCHEC : " + cause);
      process.exitCode = 1;
    });
}
