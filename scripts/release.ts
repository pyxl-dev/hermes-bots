// Unique chemin de livraison : contrôles, merge, version figée, candidate vérifiée, bascule (retour arrière si KO).
//   bun run release [N] [--dry-run] [--stage-only] | bun run release --resume
// N = numéro de la PR (par défaut, celle de la branche courante). --dry-run : les contrôles, sans merge. --stage-only : merge et version figée, candidate sur /bots-next/, sans bascule.
// Les parcours réels (réel + groupe, avec redémarrage pendant une tâche) passent d'abord sur le gateway de TEST (test/test-gateway.ts) : sans eux, rien n'est mergé.
// Si le gateway de prod a démarré avant l arrivée sur main du dernier changement de plugins/bot-groups, la prod doit le recharger : après le merge, la release
// le recharge à chaud (scripts/prod-plugin-reload.ts, sans redémarrage). Si ce rechargement échoue, elle s'arrête sur « redémarrage prod requis »
// (alerte Hub) ; Yoan redémarre le gateway, puis `bun run release --resume`
// reprend à la version figée, rejoue GatewayRestartCheck.ts et ouvre en lecture seule la plus grosse conversation de la prod.
// Refuse au moindre échec ; chaque étape laisse une ligne dans actions.jsonl, un échec envoie une alerte Hub.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { holdTestGateway } from "../test/gateway-lock";
import { join } from "node:path";
import { alert, log, LOG_DIR } from "../lib/journal";

const ROOT = join(import.meta.dir, "..");
const dry = process.argv.includes("--dry-run"),
  stageOnly = process.argv.includes("--stage-only"),
  resume = process.argv.includes("--resume");
const PENDING = join(LOG_DIR, "release-pending.json"); // release arrêtée en attente du redémarrage de la prod
const RESTART_CHECK = join(homedir(), ".claude", "LIFEOS", "TOOLS", "GatewayRestartCheck.ts");
const sh = (cmd: string, args: string[], cwd = ROOT) => execFileSync(cmd, args, { cwd, encoding: "utf8" }).trim();
const gate = (name: string, cmd: string, args: string[]) => {
  console.log(`\n== ${name}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) stop(`${name} : échec (code ${r.status})`);
  log("release_gate", true, name);
};
function stop(why: string): never {
  console.error("\nrelease REFUSÉE : " + why);
  log("release", false, why);
  alert("release", why);
  process.exit(1);
}

/** Heure de démarrage du gateway de PROD (lecture seule : gateway.pid et ps), ou 0 si illisible. */
function prodGatewayStart(): number {
  try {
    const pid = JSON.parse(readFileSync(join(homedir(), ".hermes", "gateway.pid"), "utf8")).pid;
    return Date.parse(execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1000 || 0;
  } catch {
    return 0;
  }
}

const VERSION_FILE = "web/public/version.js"; // le client se construit depuis web/ (v88) ; app/ est la sortie du build, non versionnée
const readVersion = (dir: string) => /APP_VERSION = ["']([^"']+)["']/.exec(readFileSync(join(dir, VERSION_FILE), "utf8"))?.[1]; // hors du bloc else : la suite (après le merge) la relit (ReferenceError en reprise, 2026-11-18)
let branch = "",
  pr = 0,
  version = "?",
  pluginChanged = false,
  resumed = false,
  before = "";
if (resume) {
  if (!existsSync(PENDING)) stop("rien à reprendre : aucune release en attente du redémarrage de la prod");
  ({ pr, version, pluginChanged, before = "" } = JSON.parse(readFileSync(PENDING, "utf8")));
  resumed = true;
  console.log(`release : reprise de la PR ${pr}, version ${version}`);
} else {
  branch = sh("git", ["branch", "--show-current"]);
  if (!branch || branch === "main") stop("on ne livre pas depuis main : travaille sur une branche avec une PR");
  if (sh("git", ["status", "--porcelain"])) stop("des changements ne sont pas commités");
  const arg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  pr = Number(arg);
  if (!pr)
    try {
      pr = Number(sh("gh", ["pr", "view", "--json", "number", "-q", ".number"]));
    } catch {
      stop("aucune PR pour cette branche (gh pr create --draft d'abord)");
    }
  version = readVersion(ROOT) ?? "?";
  // Gardes (2026-11-16 : la v76 arrivait avec un version.js vide, et sa PR, empilée sur une autre branche, a été mergée ailleurs que dans main)
  if (version === "?") stop(VERSION_FILE + " ne contient pas APP_VERSION = '...' : la version est illisible");
  const base = sh("gh", ["pr", "view", String(pr), "--json", "baseRefName", "-q", ".baseRefName"]);
  if (base !== "main") stop(`la PR ${pr} vise ${base}, pas main : gh pr edit ${pr} --base main`);
  console.log(`release : PR ${pr}, branche ${branch}, version ${version}${dry ? " (essai à blanc)" : ""}`);

  gate("instantané des contrats à jour (gateway installé)", "bun", ["run", "check:fresh"]);
  gate("contrat (bun run check)", "bun", ["run", "check"]);
  gate("types du client (tsc, web/)", "bunx", ["tsc", "-p", "web/tsconfig.json"]);
  gate("versions figées (server.ts réel)", "bun", ["test/releases.ts"]);
  gate("remontée des erreurs (server.ts réel)", "bun", ["test/client-log.ts"]);
  gate("smoke sur le mock", "bun", ["test/smoke.ts"]);
  // Parcours réels sur le gateway de TEST : la prod ne sert plus de banc d'essai (docs/adr/0001). `ensure` crée ~/.hermes-test s'il manque,
  // lie le plugin à CE dossier et (re)démarre le gateway de test si besoin.
  // une seule session à la fois sur le gateway de test, jusqu'à la fin de la release (test/gateway-lock.ts) ; les portails suivants en héritent
  await holdTestGateway(`release PR ${pr}`);
  // Depuis le 2026-11-17 (ADR 0001, révision) ces parcours tournent sur la Fedora via scripts/fedora-test.sh ; TEST_HOST=local les rejoue sur le Mac.
  const onTest = (args: string[]): [string, string[]] => (process.env.TEST_HOST === "local" ? ["bun", args] : ["sh", ["scripts/fedora-test.sh", ...args]]);
  gate("gateway de test prêt (test-gateway.ts ensure)", ...onTest(["test/test-gateway.ts", "ensure"]));
  gate("parcours réel sur le gateway de test (modèle réel, grosse conversation)", ...onTest(["test/real-journey.ts"]));
  // une étape par partie, l'une après l'autre : chacune est un contrôle sous 60 s (2026-11-18)
  for (const [part, what] of [
    ["parallel", "deux bots en même temps"],
    ["fil", "fil en direct et arrêt d'un bot"],
    ["immediate", "réponse immédiate du meneur"],
    ["restart", "redémarrage pendant la tâche"],
  ])
    gate(`groupe sur le gateway de test : ${what} (--part ${part})`, ...onTest(["test/group-journey.ts", "--part", part]));
  gate("recadrage et demandes suivantes dans un groupe sur le gateway de test (faux modèle)", ...onTest(["test/group-journey.ts", "--part", "steer"]));
  gate("parcours du tableau du groupe sur le gateway de test (faux modèle)", ...onTest(["test/tasks-journey.ts"]));
  {
    // annonce seulement : la garde réelle est après le merge, sans état (date de démarrage de la prod contre arrivée du plugin sur main)
    pluginChanged = sh("git", ["diff", "--name-only", "origin/main...HEAD", "--", "plugins/bot-groups"]) !== "";
    console.log(
      `\nplugins/bot-groups ${pluginChanged ? "change dans cette PR : la prod le rechargera à chaud après le merge (redémarrage seulement si le rechargement échoue)" : "inchangé dans cette PR (la garde vérifie quand même que la prod a chargé le plugin de main)"}`
    );
  }
  if (dry) {
    log("release", true, `essai à blanc PR ${pr} ${version}`);
    console.log(
      `\nessai à blanc : tout est vert, rien n'est mergé${pluginChanged ? " (la vraie release rechargerait bot-groups sur la prod après le merge)" : ""}`
    );
    process.exit(0);
  }

  // Le client change : la version doit changer, sinon les téléphones gardent l'ancien cache et stage refuserait la version.
  sh("git", ["fetch", "-q", "origin", "main"]);
  const touched = sh("git", ["diff", "--name-only", "origin/main...HEAD", "--", "web/", "app/"]).split("\n").filter(Boolean);
  const mainVersion = (() => {
    try {
      return sh("git", ["show", "origin/main:" + VERSION_FILE]);
    } catch {
      return sh("git", ["show", "origin/main:app/version.js"]);
    }
  })();
  const onMain = /APP_VERSION = ["']([^"']+)["']/.exec(mainVersion)?.[1];
  if (touched.length && onMain === version)
    stop(`le client change (${touched.slice(0, 3).join(", ")}) mais APP_VERSION reste ${version} : incrémente-la dans ${VERSION_FILE}`);

  // la copie servie (premier worktree, d'où la prod charge aussi plugins/bot-groups) doit être propre AVANT le merge :
  // sinon le pull d'après échoue et laisse une PR mergée sans version servie (vu le 2026-11-16, mention.py modifié à la main).
  const servedDir = sh("git", ["worktree", "list", "--porcelain"]).split("\n")[0].replace("worktree ", "");
  const dirty = sh("git", ["status", "--porcelain", "--untracked-files=no"], servedDir);
  if (dirty)
    stop(
      `la copie servie ${servedDir} a des modifications non commitées (${dirty.split("\n").slice(0, 3).join(", ")}) : à commiter ailleurs ou annuler avant la release`
    );

  sh("git", ["push", "-u", "origin", "HEAD"]);
  sh("gh", ["pr", "ready", String(pr)]);
  sh("gh", ["pr", "merge", String(pr), "--merge"]);
  log("release_merge", true, `PR ${pr}`);
} // fin de la partie avant merge (sautée par --resume)

// ---- après le merge : copie servie, version figée, candidate vérifiée, bascule, contrôle, retour arrière si KO ----
const served = sh("git", ["worktree", "list", "--porcelain"]).split("\n")[0].replace("worktree ", ""); // la copie servie = le premier worktree
if (!resumed) before = sh("git", ["rev-parse", "HEAD"], served);
if (!resumed) sh("git", ["pull", "--ff-only"], served);
// en reprise, `before` vient du fichier de reprise : un server.ts ou un package.json changés relancent encore le serveur
const changed = before ? sh("git", ["diff", "--name-only", before, "HEAD"], served).split("\n") : [];
// la version livrée est celle de main après le merge, pas celle de la branche : main a pu passer à v80 pendant qu'une PR sans app/ restait en v79 (2026-11-16)
version = readVersion(served) ?? version;
// app/ n'est plus versionnée : la copie servie reconstruit le client depuis web/ avant de figer la version (stage copie app/).
sh("bun", ["install", "--frozen-lockfile"], served);
sh("bun", ["run", "build"], served);
// reprise possible dès le merge : sans ça, un échec après le merge (ex. CDP :9334 absent) laissait « rien à reprendre » (vu le 2026-11-17, PR 74)
if (!resumed) writeFileSync(PENDING, JSON.stringify({ pr, version, pluginChanged, before, ts: new Date().toISOString() }));
const port = process.env.PORT || "9131",
  nextPort = process.env.NEXT_PORT || String(Number(port) + 1);
const get = (u: string) =>
  fetch(u)
    .then((r) => r.text())
    .catch(() => "");
// la version entre guillemets simples ou doubles : Prettier écrit des doubles depuis la v96 (release v100 refusée à tort)
const served_ = (v: string) => new RegExp(`["']${v}["']`);
const waitFor = async (u: string, needle: RegExp) => {
  for (let i = 0; i < 40; i++) {
    if (needle.test(await get(u))) return true;
    await Bun.sleep(500);
  }
  return false;
};
if (changed.some((f) => f === "server.ts" || f.startsWith("lib/") || f === "package.json")) {
  // le serveur lui-même change : relance (une seconde de coupure)
  console.log("\n== server.ts a changé : launchctl kickstart");
  if (!process.env.PWA_SERVICE) stop("server.ts a changé : relance le service à la main, PWA_SERVICE n'est pas posé");
  sh("launchctl", ["kickstart", "-k", `gui/${process.getuid!()}/${process.env.PWA_SERVICE}`]);
  if (!(await waitFor(`http://127.0.0.1:${port}/bots/index.html`, "<html"))) stop("le serveur ne répond pas après kickstart");
}
{
  // la prod doit avoir chargé le plugin de main. Plus de comparaison à un tag (2026-11-16) : `stage` repose le tag en -f, et une release
  // arrêtée après le stage laissait un tag qui contenait déjà le plugin non rechargé (prod de 19:38, plugin mergé à 19:52 : vu « inchangé »).
  // --first-parent : la date d'arrivée sur main (le merge), pas celle du commit, qui peut précéder le démarrage de la prod.
  const pluginTime = Number(sh("git", ["log", "-1", "--first-parent", "--format=%ct", "--", "plugins/bot-groups"], served));
  const started = prodGatewayStart();
  // rechargement à chaud d'abord (2026-11-18) : la prod recharge bot-groups depuis la copie servie, sans redémarrage, et prouve
  // par l'empreinte du code qu'elle tourne avec. S'il échoue (plugin d'avant le rechargement, gateway injoignable), la date de démarrage décide. Socket local, plus de navigateur (issue 91).
  let reloaded = false;
  if (!started || started < pluginTime) {
    console.log("\n== rechargement à chaud de bot-groups sur la prod");
    reloaded =
      spawnSync("bun", ["scripts/prod-plugin-reload.ts", "--dir", join(served, "plugins", "bot-groups")], { cwd: ROOT, stdio: "inherit" }).status === 0;
  }
  if (!reloaded && (!started || started < pluginTime)) {
    writeFileSync(PENDING, JSON.stringify({ pr, version, pluginChanged, before, ts: new Date().toISOString() }));
    const why = `redémarrage prod requis : plugins/bot-groups a changé (PR ${pr}, ${version}) et le gateway de prod ${started ? "tourne depuis avant ce changement" : "n'a pas pu être daté"}. Redémarre-le (hermes gateway restart --yes), puis : bun run release --resume`;
    console.error("\nrelease EN ATTENTE : " + why);
    log("release", false, why);
    alert("release_prod_restart", why, { windowMs: 0 });
    process.exit(3);
  }
  // GatewayRestartCheck seulement si cette PR change le plugin (Yoan, 2026-11-18) : une release client seul ne redémarre rien,
  // et un bot de prod en échec (quota du fournisseur) bloquait la livraison sans rapport avec elle. La date de démarrage reste vérifiée.
  if (pluginChanged) gate(`GatewayRestartCheck (prod ${reloaded ? "rechargée" : "redémarrée"} avec le plugin)`, "bun", [RESTART_CHECK]);
  else console.log("GatewayRestartCheck ignoré : plugins/bot-groups inchangé dans cette PR (la prod tourne depuis après son dernier changement)");
}
// PENDING reste jusqu'au succès : un échec plus loin (ex. navigateur CDP :9334 absent) se reprend par --resume (2026-11-16)
const server = (a: string) => sh("bun", ["server.ts", a], served);
console.log("\n== version figée : " + server("stage"));
if (!(await waitFor(`http://127.0.0.1:${nextPort}/bots-next/version.js`, served_(version))))
  stop(`la candidate ${version} n'est pas servie sur /bots-next/ (:${nextPort})`);
gate("smoke sur la version figée", "bun", ["test/smoke.ts", "--app", join(served, "releases", version)]);
gate("ouverture de la grosse conversation sur la prod, lecture seule (navigateur de remote-login, CDP :9334)", "bun", [
  "test/real-journey.ts",
  "--target",
  "prod",
  "--path",
  "/bots-next/",
]);
if (stageOnly) {
  // préproduction : la candidate attend sur /bots-next/ (vérification contre le vrai gateway), la prod ne bouge pas
  rmSync(PENDING, { force: true });
  log("release", true, `PR ${pr} ${version} en candidate (stage-only)`);
  console.log(
    `\nrelease partielle : PR ${pr} mergée, ${version} candidate sur /bots-next/. Vérifie, puis : bun server.ts promote (retour : bun server.ts rollback)`
  );
  process.exit(0);
}
console.log("\n== bascule : " + server("promote"));
if (!(await waitFor(`http://127.0.0.1:${port}/bots/version.js`, served_(version)))) {
  let rb = "";
  try {
    rb = server("rollback");
  } catch (e) {
    rb = "rollback impossible : " + (e as Error).message;
  }
  stop(`PR ${pr} mergée mais ${version} n'est pas servie sur :${port} ; ${rb}`);
}
rmSync(PENDING, { force: true });
log("release", true, `PR ${pr} ${version}`);
console.log(`\nrelease ok : PR ${pr} mergée, ${version} figée, promue et servie`);
// Version publique (pyxl-dev/hermes-bots) : exportée depuis le commit servi, nettoyée et auditée par public-sync.ts.
// La prod est déjà livrée : un refus ici ne la touche pas, il est journalisé et alerté par public-sync.ts lui-même.
console.log("\n== version publique");
const pub = spawnSync("bun", ["scripts/public-sync.ts", "push", "--ref", sh("git", ["rev-parse", "HEAD"], served)], { cwd: ROOT, stdio: "inherit" });
if (pub.status !== 0) console.error("version publique NON envoyée (alerte Hub envoyée) : relancer `bun scripts/public-sync.ts push` une fois corrigé");
