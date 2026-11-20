// Parcours réel des versions figées sur le VRAI server.ts, dans une copie jetable : stage, candidate sous /bots-next/,
// promote, rollback, second rollback (retour en avant), refus d'une version modifiée sous le même numéro.
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alert, log } from "../lib/journal";

const SRC = join(import.meta.dir, ".."),
  box = mkdtempSync(join(tmpdir(), "bots-rel-")),
  home = join(box, "home"),
  dir = join(box, "repo");
mkdirSync(home);
mkdirSync(dir);
for (const f of ["server.ts", "lib", "app", "package.json"]) cpSync(join(SRC, f), join(dir, f), { recursive: true });
symlinkSync(join(SRC, "node_modules"), join(dir, "node_modules"));
const PORT = 19300 + Math.floor(Math.random() * 100),
  NEXT = PORT + 1;
// GIT_CEILING_DIRECTORIES : `stage` lance git tag puis git push ; sans plafond, git remontait du dossier jetable jusqu'à un vrai dépôt
// (TMPDIR dans un worktree) et poussait release/t-a et t-b sur origin (2026-11-16). Ici le tag échoue, c'est journalisé et attendu.
// Lancé par le hook pre-push, le test héritait de GIT_DIR : git tag et git push de `stage` visaient le vrai dépôt quel que soit le
// dossier courant (release/t-a et t-b sur origin, 2026-11-16), et un `git init` de la copie avait mis core.bare=true dans la config partagée.
// Aucune variable GIT_* ne passe ; et rien ici ne lance git avec l'environnement brut.
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_"))),
  HOME: home,
  PORT: String(PORT),
  NEXT_PORT: String(NEXT),
  GIT_CEILING_DIRECTORIES: box,
};
const setVersion = (v: string) => writeFileSync(join(dir, "app/version.js"), `self.APP_VERSION = '${v}';\n`);
const cli = (a: string) => spawnSync("bun", ["server.ts", a], { cwd: dir, env, encoding: "utf8" });
const ver = async (port: number, prefix: string) => /'([^']+)'/.exec(await (await fetch(`http://127.0.0.1:${port}${prefix}/version.js`)).text())?.[1];
let failure = "";
const expect = (cond: boolean, msg: string) => {
  if (!cond && !failure) failure = msg;
};
const srv = spawn("bun", ["server.ts"], { cwd: dir, env, stdio: "ignore" });
try {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`http://127.0.0.1:${PORT}/index.html`);
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  setVersion("t-a");
  expect(cli("stage").status === 0 && cli("promote").status === 0, "stage + promote de t-a");
  expect((await ver(PORT, "/bots")) === "t-a", "la prod doit servir t-a");
  setVersion("t-b");
  expect(cli("stage").status === 0, "stage de t-b");
  expect((await ver(NEXT, "/bots-next")) === "t-b", "/bots-next/ doit servir la candidate t-b");
  expect((await ver(PORT, "/bots")) === "t-a", "la prod ne doit pas bouger au stage");
  const html = await (await fetch(`http://127.0.0.1:${NEXT}/bots-next/`)).text();
  expect(html.includes('<base href="/bots-next/">'), "la candidate doit pointer son <base> sur /bots-next/");
  expect((await (await fetch(`http://127.0.0.1:${PORT}/bots/`)).text()).match(/<base href="\/bots\/"\s*\/?>/) !== null, "la prod garde <base href=/bots/>");
  writeFileSync(join(dir, "app/manifest.webmanifest"), readFileSync(join(dir, "app/manifest.webmanifest"), "utf8") + "\n");
  const clash = cli("stage");
  expect(clash.status === 1 && /déjà figée/.test(clash.stderr), "une version modifiée sous le même numéro doit être refusée");
  cpSync(join(SRC, "app/manifest.webmanifest"), join(dir, "app/manifest.webmanifest"));
  expect(cli("promote").status === 0 && (await ver(PORT, "/bots")) === "t-b", "promote de t-b sans redémarrage");
  expect(cli("rollback").status === 0 && (await ver(PORT, "/bots")) === "t-a", "rollback vers t-a sans redémarrage");
  expect(cli("rollback").status === 0 && (await ver(PORT, "/bots")) === "t-b", "second rollback : retour en avant sur t-b");
  expect(/prod t-b, candidate t-b, précédente t-a/.test(cli("status").stdout), "status doit lister les versions");
} finally {
  srv.kill();
}
if (failure) {
  console.error("releases ÉCHEC : " + failure);
  log("releases_test", false, failure);
  alert("releases_test", failure);
  process.exit(1);
}
log("releases_test", true);
console.log("releases : stage, /bots-next/, promote, rollback et retour en avant vérifiés sans redémarrage");
