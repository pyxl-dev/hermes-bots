// Labo mémoire collective (Hindsight), isolé de la prod ET du gateway de test partagé.
//   bun test/memory-lab.ts setup | journey | status
// - HERMES_HOME=~/.hermes-hindsight-lab, HOME du processus = ~/.hermes-hindsight-lab/_home (dont .hermes pointe sur le labo) :
//   Hindsight lit ~/.hindsight/config.json et range son démon sous ~/.hindsight, donc rien n'atterrit dans le vrai HOME.
// - Deux profils de la fixture du gateway de test (chiffres, visuels), sans bot-groups, sans webapp : pas de gateway,
//   des tours one-shot `hermes -p <profil> chat -q ... --oneshot`.
// - Config Hindsight : banque privée par bot (`hermes-{profile}`) + banque commune `equipe` (additional_banks), mode
//   local_embedded, LLM opencode-go. La clé n'est jamais copiée par ce script : Yoan la pose lui-même (commande affichée).
// - `journey` : un bot apprend un fait inédit, l'autre bot, dans une session neuve, doit le retrouver. Journal : une ligne
//   par action (memory_lab_*) dans actions.jsonl, alerte Hub sur échec.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { alert, log } from "../lib/journal";

const ROOT = resolve(import.meta.dir, "..");
const LAB = join(homedir(), ".hermes-hindsight-lab");
const FAKE_HOME = join(LAB, "_home");
const FIXTURE = join(ROOT, "test", "fixtures", "hermes-test");
const HERMES_BIN = join(homedir(), ".hermes", "hermes-agent", ".hermes", "bin", "hermes");
const GUARD = join(homedir(), ".hermes", "plugins", "model-guard");
const PROFILES = ["chiffres", "visuels"];
const ENV = { ...process.env, HOME: FAKE_HOME, HERMES_HOME: LAB };
const say = (s: string) => console.log(s);

const HINDSIGHT = {
  mode: "local_embedded",
  profile: "lab",
  bank_id: "hermes",
  bank_id_template: "hermes-{profile}",
  additional_banks: ["equipe"],
  memory_mode: "hybrid",
  auto_recall: true,
  auto_retain: true,
  retain_async: false,
  observation_scopes: "shared",
  llm_provider: "openai_compatible",
  llm_model: "hy4-flash-free",
  llm_base_url: "https://opencode.ai/zen/go/v1",
};

function hermes(args: string[], timeoutMs = 240_000) {
  const t = Date.now();
  const r = spawnSync(HERMES_BIN, args, { cwd: LAB, env: ENV, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), ms: Date.now() - t };
}

function setup() {
  if (LAB.startsWith(join(homedir(), ".hermes") + "/") || LAB === join(homedir(), ".hermes")) throw new Error("LAB pointe dans la prod");
  rmSync(LAB, { recursive: true, force: true });
  for (const d of [FAKE_HOME, join(LAB, "plugins"), join(LAB, "logs"), join(FAKE_HOME, ".hindsight")]) mkdirSync(d, { recursive: true });
  symlinkSync(LAB, join(FAKE_HOME, ".hermes"));
  cpSync(join(FIXTURE, "SOUL.md"), join(LAB, "SOUL.md"));
  cpSync(join(FIXTURE, "model-guard.json"), join(LAB, "model-guard.json"));
  const memory = "memory:\n  memory_enabled: true\n  provider: hindsight\n";
  const strip = (s: string) => s.replace(/^webapp:[\s\S]*?public_url:.*\n/m, "").replace(/^\s+- bot-groups\n/m, "");
  writeFileSync(join(LAB, "config.yaml"), strip(readFileSync(join(FIXTURE, "config.yaml"), "utf8")) + memory);
  symlinkSync(GUARD, join(LAB, "plugins", "model-guard"));
  const inst = hermes(["plugins", "install", "hindsight", "--yes-deps", "--no-enable"], 600_000);
  if (!inst.ok) throw new Error("installation du plugin hindsight : " + inst.err.slice(-300));
  for (const p of PROFILES) {
    const dir = join(LAB, "profiles", p);
    cpSync(join(FIXTURE, "profiles", p), dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), strip(readFileSync(join(dir, "config.yaml"), "utf8")) + memory);
    mkdirSync(join(dir, "plugins"), { recursive: true });
    symlinkSync(join(LAB, "plugins", "hindsight"), join(dir, "plugins", "hindsight"));
    symlinkSync(GUARD, join(dir, "plugins", "model-guard"));
  }
  writeFileSync(join(FAKE_HOME, ".hindsight", "config.json"), JSON.stringify(HINDSIGHT, null, 2) + "\n");
  log("memory_lab_setup", true, LAB);
  say(`labo prêt : ${LAB}\nClé à poser par Yoan (copie sans affichage) :\n  bun test/memory-lab.ts key-help`);
}

function keyHelp() {
  const dests = [LAB, ...PROFILES.map((p) => join(LAB, "profiles", p))].map((d) => `"${d}/.env"`).join(" ");
  say(
    `k=$(grep '^OPENCODE_GO_API_KEY=' ~/.hermes/.env | cut -d= -f2-); for f in ${dests}; do printf 'OPENCODE_GO_API_KEY=%s\\nHINDSIGHT_LLM_API_KEY=%s\\n' "$k" "$k" > "$f"; chmod 600 "$f"; done; unset k`
  );
}

function journey() {
  if (!existsSync(join(LAB, "plugins", "hindsight"))) throw new Error("labo absent : bun test/memory-lab.ts setup");
  // Un sujet neuf à chaque parcours : réutiliser « projet Atlas » laissait deux codes en mémoire, le bot répondait
  // l'ancien puis fouillait le disque 158 s (mesuré le 2026-11-16). Ce parcours prouve le partage, pas la mise à jour.
  const n = Math.floor(1000 + Math.random() * 9000);
  const project = `${["Héron", "Lynx", "Cèdre", "Basalte", "Corail", "Mistral"][n % 6]}-${n}`;
  const code = `ORCHIDEE-${Math.floor(1000 + Math.random() * 9000)}`;
  const teach = hermes([
    "-p",
    "chiffres",
    "chat",
    "-Q",
    "--oneshot",
    "-q",
    `Information importante pour toute l'équipe : le nom de code du projet ${project} est ${code}. Réponds seulement « noté ».`,
  ]);
  say(`chiffres apprend ${code} : ${teach.ok ? "ok" : "échec"} en ${Math.round(teach.ms / 1000)} s, réponse « ${teach.out.slice(-80)} »`);
  if (!teach.ok) return fail("memory_lab_teach", teach.err.slice(-400));
  let found = false,
    last = "",
    askMs = 0;
  for (let i = 0; i < 3 && !found; i++) {
    const ask = hermes(
      [
        "-p",
        "visuels",
        "chat",
        "-Q",
        "--oneshot",
        "-q",
        `Quel est le nom de code du projet ${project} ? Réponds de mémoire, sans chercher dans les fichiers : seulement le code, ou « inconnu ».`,
      ],
      120_000
    );
    last = ask.ok ? ask.out : ask.err;
    askMs = ask.ms;
    found = ask.ok && ask.out.includes(code);
    say(`visuels, essai ${i + 1} : « ${last.slice(-120)} » en ${Math.round(ask.ms / 1000)} s`);
  }
  if (!found) return fail("memory_lab_recall", `visuels ne retrouve pas ${code} : ${last.slice(-200)}`);
  log("memory_lab_journey", true, undefined, { code, teach_ms: teach.ms, ask_ms: askMs });
  say(`OK : visuels retrouve ${code}, appris par chiffres.`);
}

function fail(action: string, cause: string) {
  log(action, false, cause);
  alert(action, cause);
  say(`ÉCHEC ${action} : ${cause}`);
  process.exitCode = 1;
}

function status() {
  say(existsSync(LAB) ? `labo : ${LAB}` : "labo absent");
  try {
    const lines = readFileSync(join(homedir(), ".local", "state", "hermes-bots-pwa", "actions.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes('"memory_lab_'))
      .slice(-8);
    for (const l of lines) {
      const j = JSON.parse(l);
      say(`  ${j.ts} ${j.action} ${j.ok ? "ok" : "ÉCHEC"} ${j.cause ?? ""}`);
    }
  } catch {}
}

const cmd = process.argv[2];
try {
  if (cmd === "setup") setup();
  else if (cmd === "journey") journey();
  else if (cmd === "status") status();
  else if (cmd === "key-help") keyHelp();
  else {
    say("usage : bun test/memory-lab.ts setup | key-help | journey | status");
    process.exitCode = 2;
  }
} catch (e) {
  fail(`memory_lab_${cmd}`, (e as Error).message);
}
