// Gateway Hermes de TEST, isolé de la prod (docs/adr/0001-gateway-de-test-sur-le-mac.md).
//   bun test/test-gateway.ts start | stop | restart [--hard] | status | reset | ensure
// - HERMES_HOME=~/.hermes-test, webapp lié à 127.0.0.1:9320 seulement (adressé par http://hermes-test.localhost:9320) (la prod : ~/.hermes, :9120, jamais touchée).
// - Lancé directement (`hermes gateway run`), jamais par `hermes gateway restart/stop`, launchctl ou un LaunchAgent.
// - HOME du processus = ~/.hermes-test/_home, dont `.hermes` pointe sur ~/.hermes-test : les plugins qui codent
//   Path.home()/".hermes" en dur (model-guard, bot-groups) lisent et écrivent le dossier de test, jamais la prod.
// - `reset` recrée ~/.hermes-test depuis test/fixtures/hermes-test/ (profils bots-test, chiffres, travel-prep, visuels, fx-* sans modèle,
//   model-guard limité au modèle gratuit hy4-flash-free, plugin bot-groups lié à plugins/bot-groups de CE dépôt), génère le mot de
//   passe du webapp et copie la seule clé OPENCODE_GO_API_KEY (par script, sans jamais l'afficher ni la journaliser).
// - `start` génère au besoin la conversation « Bot Chat » de 20 000 messages (outils, images) du profil par défaut.
// - Seconde instance, pour deux sessions qui testent en même temps sans se couper : HERMES_TEST_HOME=~/.hermes-test-<nom>
//   et HERMES_TEST_PORT=<port> (le webapp de la fixture est réécrit sur ce port). Le nom doit commencer par ~/.hermes-test.
// Journal : une ligne par action dans actions.jsonl (test_gateway_*), alerte Hub sur chaque échec ; `status` résume.
import { holdTestGateway } from "./gateway-lock";
import { Database } from "bun:sqlite";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { alert, log } from "../lib/journal";

const ROOT = resolve(import.meta.dir, "..");
const PROD_HOME = join(homedir(), ".hermes");
// HERMES_TEST_HOME + HERMES_TEST_PORT : une seconde instance quand une autre session occupe ~/.hermes-test (2026-11-16)
export const TEST_HOME = process.env.HERMES_TEST_HOME ? resolve(process.env.HERMES_TEST_HOME) : join(homedir(), ".hermes-test");
export const TEST_PORT = Number(process.env.HERMES_TEST_PORT || 9320);
export const TEST_ORIGIN = `http://hermes-test.localhost:${TEST_PORT}`; // nom du webapp : public_url de la fixture (engage la connexion par mot de passe, comme la prod)
const LOCAL_URL = `http://127.0.0.1:${TEST_PORT}`;
export const PASSWORD_FILE = join(TEST_HOME, "webapp-password");
const FAKE_HOME = join(TEST_HOME, "_home");
const PIDFILE = join(TEST_HOME, "test-gateway.pid");
const GW_LOG = join(TEST_HOME, "logs", "gateway.log");
const MARKER = join(TEST_HOME, ".hermes-test-marker");
const FIXTURE = join(ROOT, "test", "fixtures", "hermes-test");
// Sur le Mac, le code est celui de la prod (partagé, les données non). Sur la Fedora (scripts/fedora-test.sh), une
// copie du Hermes du Mac : HERMES_TEST_BIN la désigne, HERMES_TEST_SOURCE le dossier qui fournit la clé de modèle
// (.env) et le plugin model-guard à la place de la prod, absente là-bas.
const HERMES_BIN = process.env.HERMES_TEST_BIN || join(PROD_HOME, "hermes-agent", ".hermes", "bin", "hermes");
const SOURCE_HOME = process.env.HERMES_TEST_SOURCE ? resolve(process.env.HERMES_TEST_SOURCE) : PROD_HOME;
const PROFILES = [
  "bots-test",
  "chiffres",
  "travel-prep",
  "visuels",
  "fx-meneur",
  "fx-a",
  "fx-b",
  "fy-meneur",
  "fy-a",
  "fy-b",
  "fz-meneur",
  "fz-a",
  "fz-b",
  "fw-meneur",
  "fw-a",
  "fv-meneur",
  "fv-a",
  "fu-meneur",
  "fu-a",
  "fu-b",
];
const KEY_NAME = "OPENCODE_GO_API_KEY";
const BIG = Number(process.env.TEST_BIG || 20000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const say = (s: string) => console.log(s);
class Fail extends Error {}
const must = (cond: unknown, why: string): void => {
  if (!cond) throw new Fail(why);
};

// ---------- garde-fous : on ne touche jamais à la prod ----------
function assertIsolated() {
  must(TEST_HOME !== PROD_HOME && !TEST_HOME.startsWith(PROD_HOME + "/"), "TEST_HOME pointe dans la prod");
  must(
    TEST_HOME.startsWith(join(homedir(), ".hermes-test")) && !TEST_HOME.slice(homedir().length).includes("/", 1),
    "HERMES_TEST_HOME doit être ~/.hermes-test ou ~/.hermes-test-<nom>"
  );
  must(TEST_PORT !== 9120 && TEST_PORT !== 8642 && TEST_PORT !== 9900, `le port ${TEST_PORT} est un port de la prod`);
}
function psCommand(pid: number): string {
  return spawnSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}
function psEnv(pid: number): string {
  return spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" }).stdout;
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const readPid = () => {
  try {
    return Number(readFileSync(PIDFILE, "utf8").trim()) || 0;
  } catch {
    return 0;
  }
};
// repli : le gateway.pid qu'écrit Hermes lui-même (JSON). Une autre session dont le démarrage a raté a pu effacer notre fichier pid.
const hermesPid = () => {
  try {
    const j = JSON.parse(readFileSync(join(TEST_HOME, "gateway.pid"), "utf8"));
    return j.hermes_home === TEST_HOME ? Number(j.pid) || 0 : 0;
  } catch {
    return 0;
  }
};
// fin de valeur = espace OU fin de ligne : sous Linux, `ps eww` met HERMES_HOME en dernier (Fedora, 2026-11-17 :
// le gateway n'était pas reconnu, `stop` le disait arrêté et `reset` effaçait le dossier d'un gateway vivant)
const isOurs = (pid: number) => !!pid && alive(pid) && psEnv(pid).split(/\s+/).includes(`HERMES_HOME=${TEST_HOME}`);
/** Le pid du gateway de test, seulement s'il vit ET que c'est bien un gateway lancé avec HERMES_HOME=~/.hermes-test. */
function ourPid(): number {
  const pid = [readPid(), hermesPid()].find(isOurs) || 0;
  if (pid && readPid() !== pid) writeFileSync(PIDFILE, String(pid) + "\n");
  return pid;
}
/** Efface le fichier pid seulement s'il désigne encore ce pid : un démarrage raté ne doit pas effacer celui du gateway qui tourne. */
const dropPid = (pid: number) => {
  if (readPid() === pid) rmSync(PIDFILE, { force: true });
};
async function webappUp(): Promise<boolean> {
  // prêt = ni 5xx (503 pendant le démarrage : le port répond avant que le webapp serve) ni coupure
  try {
    const r = await fetch(LOCAL_URL + "/api/status", { redirect: "manual", signal: AbortSignal.timeout(3000) });
    return r.status < 500;
  } catch {
    return false;
  }
}
function portBusy(): boolean {
  return spawnSync("lsof", ["-nP", `-iTCP:${TEST_PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().length > 0;
}

// ---------- reset ----------
function setKey(): boolean {
  // Copie de UNE clé du .env de la prod vers le .env de test, sans l'afficher ni la journaliser. Si le test a déjà une clé, on la garde.
  const src = join(SOURCE_HOME, ".env");
  if (!existsSync(src)) return false;
  const line = readFileSync(src, "utf8")
    .split("\n")
    .find((l) => l.startsWith(KEY_NAME + "="));
  if (!line || line.length <= KEY_NAME.length + 1) return false;
  for (const dir of [TEST_HOME, ...PROFILES.map((p) => join(TEST_HOME, "profiles", p))]) writeFileSync(join(dir, ".env"), line + "\n", { mode: 0o600 });
  return true;
}
function hashPassword(pw: string): string {
  // scrypt, même format que plugins/dashboard_auth/basic (hash_password)
  const r = spawnSync(
    "bun",
    [
      "-e",
      `
    import { scryptSync, randomBytes } from "node:crypto";
    const salt = randomBytes(16), dk = scryptSync(process.env.TG_PW, salt, 32, { N: 16384, r: 8, p: 1 });
    console.log("scrypt$16384$8$1$" + salt.toString("base64") + "$" + dk.toString("base64"));`,
    ],
    { encoding: "utf8", env: { ...process.env, TG_PW: pw } }
  ); // par l'environnement : un mot de passe qui commence par « - » serait pris pour une option de bun
  must(r.status === 0, "hash du mot de passe impossible");
  return r.stdout.trim();
}
async function reset() {
  assertIsolated();
  if (existsSync(TEST_HOME)) {
    // sur une machine neuve (la Fedora, 2026-11-17), le verrou de test-gateway crée le dossier avant le premier reset :
    // vide ou réduit au verrou, il n'a rien à protéger
    const onlyLock = readdirSync(TEST_HOME).every((f) => f === "test-gateway.lock");
    must(existsSync(MARKER) || onlyLock, `${TEST_HOME} existe sans marqueur : je ne l'efface pas`);
    must(!ourPid(), "le gateway de test tourne : `bun test/test-gateway.ts stop` d'abord");
    rmSync(TEST_HOME, { recursive: true, force: true });
  }
  mkdirSync(TEST_HOME, { recursive: true, mode: 0o700 });
  writeFileSync(MARKER, "créé par test/test-gateway.ts reset\n");
  cpSync(FIXTURE, TEST_HOME, { recursive: true });
  for (const p of PROFILES) for (const d of ["logs", "sessions", "memories"]) mkdirSync(join(TEST_HOME, "profiles", p, d), { recursive: true });
  mkdirSync(join(TEST_HOME, "logs"), { recursive: true });
  // HOME de test : `.hermes` y pointe sur le dossier de test
  mkdirSync(FAKE_HOME, { recursive: true });
  symlinkSync(TEST_HOME, join(FAKE_HOME, ".hermes"));
  // bot-groups lance ~/.local/bin/hermes pour ses tâches parallèles. Sur le Mac, le lanceur de Hermes l'écrit ; le
  // Hermes copié sur la Fedora ne le fait pas (dispatch « No such file », group-journey du 2026-11-17)
  if (process.env.HERMES_TEST_BIN) {
    mkdirSync(join(FAKE_HOME, ".local", "bin"), { recursive: true });
    symlinkSync(HERMES_BIN, join(FAKE_HOME, ".local", "bin", "hermes"));
  }
  // plugins : bot-groups = le dossier testé de CE dépôt ; model-guard = le code de la prod (lecture seule, ses données sont celles du test)
  mkdirSync(join(TEST_HOME, "plugins"), { recursive: true });
  symlinkSync(join(ROOT, "plugins", "bot-groups"), join(TEST_HOME, "plugins", "bot-groups"));
  const guard = join(SOURCE_HOME, "plugins", "model-guard");
  must(existsSync(guard), `plugin model-guard introuvable dans ${SOURCE_HOME}`);
  symlinkSync(guard, join(TEST_HOME, "plugins", "model-guard"));
  // chaque profil charge ses plugins depuis son propre dossier plugins/ (comme en prod) : mêmes liens
  for (const p of PROFILES) {
    mkdirSync(join(TEST_HOME, "profiles", p, "plugins"), { recursive: true });
    symlinkSync(join(ROOT, "plugins", "bot-groups"), join(TEST_HOME, "profiles", p, "plugins", "bot-groups"));
    symlinkSync(guard, join(TEST_HOME, "profiles", p, "plugins", "model-guard"));
  }
  // mot de passe du webapp : généré ici, rangé hors dépôt
  const password = Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString("base64url");
  writeFileSync(PASSWORD_FILE, password + "\n", { mode: 0o600 });
  const cfgPath = join(TEST_HOME, "config.yaml");
  writeFileSync(
    cfgPath,
    readFileSync(cfgPath, "utf8").replaceAll("9320", String(TEST_PORT)) +
      `dashboard:\n  basic_auth:\n    username: test\n    password_hash: '${hashPassword(password)}'\n    secret: '${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")}'\n`
  ); // secret fixe : les sessions survivent au redémarrage
  const keyOk = setKey();
  chmodSync(TEST_HOME, 0o700);
  log("test_gateway_reset", true, `profils ${PROFILES.join(", ")} ; clé de modèle ${keyOk ? "copiée" : "ABSENTE"}`);
  say(`reset : ${TEST_HOME} recréé depuis test/fixtures/hermes-test (profils ${PROFILES.join(", ")})`);
  say(`        plugin bot-groups -> ${join(ROOT, "plugins", "bot-groups")}`);
  say(`        mot de passe du webapp : ${PASSWORD_FILE} (utilisateur « test »)`);
  say(
    keyOk
      ? `        clé ${KEY_NAME} copiée dans les .env de test (valeur non affichée)`
      : `        ATTENTION : clé ${KEY_NAME} introuvable dans ${SOURCE_HOME}/.env : aucun tour de modèle ne réussira`
  );
}

// ---------- conversation de 20 000 messages ----------
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const IMG = "\n\n![capture](data:image/png;base64," + PIXEL.repeat(40) + ")";
function seedBigChat(): string {
  const dbPath = join(TEST_HOME, "state.db");
  must(existsSync(dbPath), "state.db absente : le gateway ne l'a pas encore créée");
  const db = new Database(dbPath);
  try {
    db.exec("pragma busy_timeout = 30000");
    const have = db.query("select id, message_count from sessions where title = 'Bot Chat'").get() as any;
    if (have) return `déjà là (${have.message_count} messages)`;
    const id = "test-bot-chat-" + crypto.randomUUID().slice(0, 8),
      t0 = Date.now() / 1000 - BIG;
    db.query(
      "insert into sessions (id, source, model, started_at, last_activity_at, message_count, title, profile_name) values (?, 'desktop', 'deepseek-v4.1-flash', ?, ?, ?, 'Bot Chat', 'default')"
    ).run(id, t0, t0 + BIG, BIG);
    const ins = db.query(
      "insert into messages (session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, active) values (?, ?, ?, ?, ?, ?, ?, 1)"
    );
    db.transaction(() => {
      for (let i = 0; i < BIG; i++) {
        const k = i % 5,
          n = Math.floor(i / 5),
          ts = t0 + i,
          call = (name: string, a: object) => ({ id: `call_${n}_${name}`, type: "function", function: { name, arguments: JSON.stringify(a) } });
        if (i === BIG - 1) ins.run(id, "assistant", "FIN-DU-FIL : dernier message de la conversation.", null, null, null, ts);
        else if (k === 0) ins.run(id, "user", `Question ${n} : peux-tu vérifier l'étape ${n} ?`, null, null, null, ts);
        else if (k === 1)
          ins.run(
            id,
            "assistant",
            "",
            null,
            JSON.stringify([call("terminal", { command: `echo étape ${n}` }), call("read_file", { path: `/tmp/etape-${n}.txt` })]),
            null,
            ts
          );
        else if (k === 2) ins.run(id, "tool", ("ligne de sortie d'outil " + n + "\n").repeat(30), `call_${n}_terminal`, null, "terminal", ts);
        else if (k === 3) ins.run(id, "tool", ("contenu du fichier " + n + "\n").repeat(30), `call_${n}_read_file`, null, "read_file", ts);
        else ins.run(id, "assistant", `Réponse ${n}. ` + "Détail de la vérification. ".repeat(20) + (n % 10 === 0 ? IMG : ""), null, null, null, ts);
      }
    })();
    return `créée : ${BIG} messages (${id})`;
  } finally {
    db.close();
  }
}

// ---------- start / stop ----------
async function start() {
  assertIsolated();
  must(existsSync(MARKER), "~/.hermes-test absent : `bun test/test-gateway.ts reset` d'abord");
  must(existsSync(HERMES_BIN), `${HERMES_BIN} introuvable`);
  if (ourPid()) {
    // déjà lancé, peut-être à l'instant par une autre session (le gateway de test est partagé) : prêt seulement quand le webapp répond
    for (let i = 0; i < 120 && !(await webappUp()); i++) await sleep(1000);
    must(await webappUp(), `le gateway de test (pid ${ourPid()}) tourne mais son webapp ne répond pas après 120 s`);
    say(`déjà démarré (pid ${ourPid()})`);
    log("test_gateway_start", true, "déjà démarré");
    return;
  }
  must(!portBusy(), `le port ${TEST_PORT} est déjà pris par autre chose que le gateway de test`);
  mkdirSync(join(TEST_HOME, "logs"), { recursive: true });
  const out = openSync(GW_LOG, "a");
  const env: Record<string, string> = {
    HOME: FAKE_HOME,
    HERMES_HOME: TEST_HOME,
    PATH: process.env.PATH || "/usr/bin:/bin",
    LANG: "fr_FR.UTF-8",
    BOT_GROUPS_RETRY_WAIT_S: "2",
    BOT_GROUPS_RESUME_DELAY_S: "2",
    BOT_GROUPS_SWEEP_S: "3",
    // redémarrages voulus et répétés : sans ça, Hermes attend 20 s au-delà de 7 démarrages en 120 s (frein anti-boucle, hermes_cli/gateway.py)
    HERMES_GATEWAY_MAX_STARTS: "0",
    // une clé de la prod ne doit jamais passer par l'environnement hérité
    ...Object.fromEntries(
      Object.entries(process.env)
        .filter(([k]) => /^(TMPDIR|USER|LOGNAME|SHELL)$/.test(k))
        .map(([k, v]) => [k, v as string])
    ),
  };
  const child = spawn(HERMES_BIN, ["gateway", "run", "--force"], { cwd: TEST_HOME, env, detached: true, stdio: ["ignore", out, out] });
  child.unref();
  closeSync(out);
  must(child.pid, "le processus du gateway n'a pas démarré");
  writeFileSync(PIDFILE, String(child.pid) + "\n");
  for (let i = 0; i < 120; i++) {
    if (!alive(child.pid!)) {
      const tail = readFileSync(GW_LOG, "utf8").trim().split("\n").slice(-6).join(" | ").slice(-400);
      dropPid(child.pid!);
      throw new Fail("le gateway de test s'est arrêté au démarrage : " + tail);
    }
    if (await webappUp()) break;
    await sleep(1000);
  }
  must(await webappUp(), `le webapp de test ne répond pas sur ${TEST_ORIGIN} après 120 s (journal : ${GW_LOG})`);
  const seeded = seedBigChat();
  log("test_gateway_start", true, `pid ${child.pid}, ${TEST_ORIGIN}, conversation ${seeded}`);
  say(`démarré : pid ${child.pid}, ${TEST_ORIGIN} (127.0.0.1 seulement), HERMES_HOME=${TEST_HOME}`);
  say(`          Bot Chat : ${seeded}`);
}
async function stop() {
  assertIsolated();
  const pid = ourPid();
  if (!pid) {
    say("déjà arrêté");
    log("test_gateway_stop", true, "déjà arrêté");
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
  for (let i = 0; i < 60 && alive(pid); i++) await sleep(500);
  if (alive(pid)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      process.kill(pid, "SIGKILL");
    }
    await sleep(500);
  }
  must(!alive(pid), `le gateway de test (pid ${pid}) ne s'arrête pas`);
  rmSync(PIDFILE, { force: true });
  log("test_gateway_stop", true, `pid ${pid}`);
  say(`arrêté (pid ${pid})`);
}
/** Les liens plugins/bot-groups (racine et profils) doivent pointer sur le dossier de CE dépôt. Faux = le gateway testerait un autre code. */
const PLUGIN_SRC = join(ROOT, "plugins", "bot-groups");
const pluginLinks = () => ["plugins", ...PROFILES.map((p) => join("profiles", p, "plugins"))].map((d) => join(TEST_HOME, d, "bot-groups"));
const linksOk = () =>
  pluginLinks().every((l) => {
    try {
      return realpathSync(l) === realpathSync(PLUGIN_SRC);
    } catch {
      return false;
    }
  });
function relink() {
  for (const l of pluginLinks()) {
    rmSync(l, { force: true });
    symlinkSync(PLUGIN_SRC, l);
  }
}
/** Pour `bun run release` : crée ~/.hermes-test s'il manque, lie le plugin à ce dépôt, démarre (ou redémarre à froid si le lien a changé). */
async function ensure() {
  assertIsolated();
  // un profil ajouté aux fixtures (ex. fx-* du parcours sans modèle) n'existe pas dans un ~/.hermes-test plus ancien : on le recrée
  const missing = PROFILES.filter((p) => !existsSync(join(TEST_HOME, "profiles", p)));
  if (existsSync(MARKER) && missing.length) {
    say(`profils absents (${missing.join(", ")}) : reset`);
    if (ourPid()) await stop();
  }
  if (!existsSync(MARKER) || missing.length) await reset();
  if (!linksOk()) {
    if (ourPid()) await stop();
    relink();
    log("test_gateway_relink", true, PLUGIN_SRC);
    say(`plugin bot-groups relié à ${PLUGIN_SRC}`);
  }
  await start();
}
/** Redémarrage comme `hermes gateway restart --yes` en prod : SIGUSR1, le gateway refuse les nouveaux tours, attend ceux en cours
 *  (le drain), sort ; puis on le relance. `--hard` : SIGTERM tout de suite (coupe les tours, comme `launchctl kickstart -k`). */
async function restart() {
  assertIsolated();
  const pid = ourPid();
  if (pid && !process.argv.includes("--hard")) {
    const wait = Number(process.env.HERMES_TEST_DRAIN_S || 300);
    process.kill(pid, "SIGUSR1");
    log("test_gateway_drain", true, `SIGUSR1 pid ${pid}, attente du drain (max ${wait} s)`);
    for (let i = 0; i < wait * 2 && alive(pid); i++) await sleep(500);
    if (alive(pid)) {
      // ne pas laisser un gateway en drain (503 pour tous les parcours suivants, 2026-11-18) : couper, relancer, puis échouer
      await stop();
      await start();
      must(false, `le gateway de test (pid ${pid}) n'a pas fini son drain en ${wait} s ; coupé et relancé pour la suite`);
    }
    rmSync(PIDFILE, { force: true });
    log("test_gateway_stop", true, `drain fini, pid ${pid}`);
    say(`drain fini, gateway arrêté (pid ${pid})`);
  } else await stop();
  await start();
}
async function status() {
  const pid = ourPid(),
    up = await webappUp();
  const rows = (() => {
    try {
      return readFileSync(join(homedir(), ".local/state/hermes-bots-pwa/actions.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .filter((r) => String(r.action).startsWith("test_gateway_"));
    } catch {
      return [];
    }
  })();
  let chat = "n/a";
  try {
    const db = new Database(join(TEST_HOME, "state.db"), { readonly: true });
    chat = String((db.query("select message_count c from sessions where title = 'Bot Chat'").get() as any)?.c ?? "absente");
    db.close();
  } catch {}
  const key = existsSync(join(TEST_HOME, ".env")) && readFileSync(join(TEST_HOME, ".env"), "utf8").includes(KEY_NAME + "=");
  const plugin = (() => {
    try {
      return realpathSync(join(TEST_HOME, "plugins", "bot-groups"));
    } catch {
      return "absent";
    }
  })();
  say(`gateway de test : ${pid ? `démarré (pid ${pid})` : "arrêté"}, webapp ${up ? "répond" : "ne répond pas"} sur ${TEST_ORIGIN}`);
  say(`HERMES_HOME : ${existsSync(MARKER) ? TEST_HOME : TEST_HOME + " (absent : reset)"} ; port ${TEST_PORT} (prod : 9120)`);
  say(
    `clé de modèle : ${key ? "présente (valeur non affichée)" : "ABSENTE"} ; mot de passe : ${existsSync(PASSWORD_FILE) ? PASSWORD_FILE : "absent"} ; Bot Chat : ${chat} messages`
  );
  say(`plugin bot-groups -> ${plugin}`);
  const last = rows.slice(-5);
  say(
    last.length
      ? "dernières actions :\n" + last.map((r) => `  ${r.ts} ${r.action} ${r.ok ? "ok" : "ÉCHEC"} ${r.cause ?? ""}`).join("\n")
      : "aucune action journalisée"
  );
  const lastFail = [...rows].reverse().find((r) => !r.ok),
    lastOk = [...rows].reverse().find((r) => r.ok && r.action === "test_gateway_start");
  if (lastFail && !(lastOk && lastOk.ts > lastFail.ts)) say(`dernier échec : ${lastFail.ts} ${lastFail.action} ${lastFail.cause ?? ""}`);
  return pid && up ? 0 : 1;
}

// ---------- point d'entrée ----------
if (import.meta.main) {
  const cmd = process.argv[2];
  const run: Record<string, () => Promise<unknown>> = { start, stop, restart, status, reset, ensure };
  if (!run[cmd]) {
    console.error("usage : bun test/test-gateway.ts start | stop | restart [--hard] | status | reset | ensure");
    process.exit(2);
  }
  try {
    if (cmd !== "status") await holdTestGateway("test-gateway " + cmd);
    const code = await run[cmd]();
    process.exit(typeof code === "number" ? code : 0);
  } catch (e) {
    const m = (e as Error).message.split("\n")[0].slice(0, 400);
    console.error(`test-gateway ${cmd} ÉCHEC : ${m}`);
    log("test_gateway_" + cmd, false, m);
    alert("test_gateway_" + cmd, m);
    process.exit(1);
  }
}
