// Version publique propre : exporte main vers le dépôt public pyxl-dev/hermes-bots, sans l'historique privé.
//   bun scripts/public-sync.ts build [--ref REF] [--out DOSSIER]   construit l'arbre public et le scanne, sans rien envoyer
//   bun scripts/public-sync.ts push [--ref REF] [--dry-run]         construit, commite par-dessus le dépôt public, audite, pousse
//   bun scripts/public-sync.ts status                               derniers envois, réussis ou refusés
// Règles (lues dans REF, pas dans la copie de travail) : `.publicignore` (fichiers qui restent privés), `public/config.json`
// (déplacements, réécritures, motifs interdits), `public/overlay/` (fichiers propres au public : README, LICENSE...).
// Refuse au moindre doute : une réécriture qui ne trouve plus son texte (le code a bougé), un motif interdit restant, ou un
// contrôle de PublicReady.ts (skill OpenSourceManagement) qui n'est pas vert. Chaque refus : ligne public_sync dans
// actions.jsonl et alerte Hub. Lancé par `bun run release` après la mise en prod.
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { alert, log, LOG, LOG_OLD } from "../lib/journal";

const ROOT = join(import.meta.dir, "..");
const PUBLIC_READY = join(homedir(), ".claude", "skills", "OpenSourceManagement", "Tools", "PublicReady.ts");
const MUST_PASS = ["deny-list", "gitleaks", "home-paths", "license"]; // « unavailable » n'est jamais un succès
const MUST_NOT_FAIL = ["private-ips", "large-files", "readme"];

type Rewrite = { file: string; from: string; to: string };
type Config = { repo: string; branch: string; author: { name: string; email: string }; move: Record<string, string>; rewrites: Rewrite[]; forbidden: string[] };

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const git = (args: string[], cwd = ROOT) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 28 }).trim();

class Refus extends Error {}
const refuse = (why: string): never => {
  throw new Refus(why);
};

function walk(dir: string, base = dir): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === ".git" ? [] : walk(p, base);
    return e.isFile() ? [relative(base, p)] : [];
  });
}
const isText = (buf: Buffer) => !buf.subarray(0, 8000).includes(0);
const asRegex = (s: string) => {
  const m = /^\/(.+)\/([gimsuy]*)$/s.exec(s);
  return m ? new RegExp(m[1], m[2].includes("g") ? m[2] : m[2] + "g") : null;
};

// Arbre public de REF dans un dossier neuf. Ne touche ni au dépôt ni à la copie de travail.
export function build(ref: string, out?: string) {
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  const dir = out ?? mkdtempSync(join(tmpdir(), "hermes-bots-public-"));
  if (existsSync(dir) && readdirSync(dir).length) refuse(`${dir} n'est pas vide`);
  mkdirSync(dir, { recursive: true });
  const tar = spawnSync("git", ["archive", "--format=tar", sha], { cwd: ROOT, maxBuffer: 1 << 30 });
  if (tar.status !== 0) refuse("git archive : " + tar.stderr.toString());
  execFileSync("tar", ["-x", "-C", dir], { input: tar.stdout });

  const cfgFile = join(dir, "public", "config.json");
  if (!existsSync(cfgFile)) refuse(`public/config.json absent de ${ref}`);
  const cfg: Config = JSON.parse(readFileSync(cfgFile, "utf8"));
  const overlay = mkdtempSync(join(tmpdir(), "hermes-bots-overlay-"));
  if (existsSync(join(dir, "public", "overlay"))) cpSync(join(dir, "public", "overlay"), overlay, { recursive: true });

  // .publicignore en syntaxe gitignore : git lui-même décide, dans un dépôt jetable, sans les exclusions globales.
  if (!existsSync(join(dir, ".publicignore"))) refuse(`.publicignore absent de ${ref}`);
  git(["init", "-q"], dir);
  const ignored = git(["ls-files", "--others", "--ignored", "--exclude-from=.publicignore"], dir).split("\n").filter(Boolean);
  rmSync(join(dir, ".git"), { recursive: true, force: true });
  for (const f of ignored) rmSync(join(dir, f), { force: true });
  for (const d of ["public", ".claude", "docs/redesign", "docs/agents", "design/shots"]) {
    const p = join(dir, d);
    if (existsSync(p) && walk(p).length === 0) rmSync(p, { recursive: true, force: true });
  }
  if (existsSync(join(dir, ".publicignore")) || existsSync(join(dir, "public"))) refuse(".publicignore n'exclut pas public/ ou lui-même");

  for (const [from, to] of Object.entries(cfg.move ?? {})) {
    if (!existsSync(join(dir, from))) refuse(`déplacement : ${from} absent`);
    mkdirSync(dirname(join(dir, to)), { recursive: true });
    renameSync(join(dir, from), join(dir, to));
  }

  // Réécritures : chacune doit trouver son texte au moins une fois, sinon le code a changé et la règle ne protège plus rien.
  const files = walk(dir);
  const text = new Map<string, string>();
  for (const f of files) {
    const buf = readFileSync(join(dir, f));
    if (isText(buf)) text.set(f, buf.toString("utf8"));
  }
  for (const r of cfg.rewrites) {
    const targets = r.file === "*" ? [...text.keys()] : [r.file];
    const re = asRegex(r.from);
    let hits = 0;
    for (const f of targets) {
      const s = text.get(f);
      if (s === undefined) {
        if (r.file !== "*") refuse(`réécriture : ${f} absent de l'arbre public`);
        continue;
      }
      const n = re ? (s.match(re) ?? []).length : s.split(r.from).length - 1;
      if (!n) continue;
      hits += n;
      text.set(f, re ? s.replace(re, r.to) : s.split(r.from).join(r.to));
    }
    if (!hits) refuse(`réécriture sans effet dans ${r.file} : « ${r.from.slice(0, 80)} » introuvable (le code a changé, mettre à jour public/config.json)`);
  }
  for (const [f, s] of text) writeFileSync(join(dir, f), s);
  cpSync(overlay, dir, { recursive: true });
  rmSync(overlay, { recursive: true, force: true });

  // Motifs interdits sur l'arbre final, overlay compris.
  const leaks: string[] = [];
  const pats = cfg.forbidden.map((p) => new RegExp(p));
  for (const f of walk(dir)) {
    if (/(^|\/)(\.)?[^/]*\.(png|jpg|jpeg|webp|ico|woff2?)$/i.test(f)) continue;
    const buf = readFileSync(join(dir, f));
    if (!isText(buf)) continue;
    buf
      .toString("utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const p of pats) if (p.test(line)) leaks.push(`${f}:${i + 1} (${p.source}) ${line.trim().slice(0, 100)}`);
      });
  }
  if (leaks.length)
    refuse(`motifs interdits dans l'arbre public :\n  ${leaks.slice(0, 20).join("\n  ")}${leaks.length > 20 ? `\n  ... ${leaks.length - 20} de plus` : ""}`);
  return { dir, sha, cfg, files: walk(dir).length };
}

function audit(repoDir: string) {
  if (!existsSync(PUBLIC_READY)) refuse(`PublicReady.ts absent (${PUBLIC_READY}) : audit impossible, envoi refusé`);
  const r = spawnSync("bun", [PUBLIC_READY, "audit", repoDir, "--history-ok", "--no-build", "--json"], { encoding: "utf8", maxBuffer: 1 << 26 });
  let report: { checks: { id: string; status: string; summary: string }[] };
  try {
    report = JSON.parse(r.stdout);
  } catch {
    return refuse("PublicReady.ts : sortie illisible " + (r.stderr || r.stdout).slice(0, 300));
  }
  const by = new Map(report.checks.map((c) => [c.id, c]));
  const bad = [
    ...MUST_PASS.filter((id) => by.get(id)?.status !== "pass"),
    ...MUST_NOT_FAIL.filter((id) => !by.get(id) || by.get(id)!.status === "fail" || by.get(id)!.status === "unavailable"),
  ];
  if (bad.length) refuse("audit PublicReady : " + bad.map((id) => `${id} ${by.get(id)?.status ?? "absent"} (${by.get(id)?.summary ?? ""})`).join(" ; "));
  return report.checks.map((c) => `${c.id}:${c.status}`).join(" ");
}

function push(ref: string, dry: boolean) {
  const t0 = Date.now();
  const { dir: tree, sha, cfg } = build(ref);
  const work = mkdtempSync(join(tmpdir(), "hermes-bots-clone-"));
  try {
    const clone = spawnSync("gh", ["repo", "clone", cfg.repo, work, "--", "-q", "--branch", cfg.branch], { encoding: "utf8" });
    if (clone.status !== 0) refuse(`clone de ${cfg.repo} : ${clone.stderr.trim()}`);
    for (const e of readdirSync(work)) if (e !== ".git") rmSync(join(work, e), { recursive: true, force: true });
    cpSync(tree, work, { recursive: true });
    git(["add", "-A"], work);
    const stat = git(["diff", "--cached", "--stat"], work);
    if (!stat) {
      log("public_sync", true, `déjà à jour avec ${sha.slice(0, 7)}`);
      console.log(`public : ${cfg.repo} déjà à jour avec ${sha.slice(0, 7)}`);
      return;
    }
    const version = /APP_VERSION = "([^"]+)"/.exec(readFileSync(join(tree, "web", "public", "version.js"), "utf8"))?.[1] ?? sha.slice(0, 7);
    const date = new Date().toISOString().replace(/\.\d+Z$/, "+0000"); // fuseau neutre : l'heure locale dirait où était l'auteur
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: cfg.author.name,
      GIT_AUTHOR_EMAIL: cfg.author.email,
      GIT_COMMITTER_NAME: cfg.author.name,
      GIT_COMMITTER_EMAIL: cfg.author.email,
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    };
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", `Version ${version}`], { cwd: work, env });
    const checks = audit(work);
    console.log(stat.split("\n").slice(-1)[0] + `\naudit : ${checks}`);
    if (dry) {
      log("public_sync", true, `essai : ${version} prêt, non envoyé`, { sha: sha.slice(0, 7) });
      console.log(`essai : rien envoyé. Clone prêt dans ${work}`);
      return;
    }
    const p = spawnSync("git", ["push", "-q", "origin", `HEAD:${cfg.branch}`], { cwd: work, encoding: "utf8" });
    if (p.status !== 0) refuse(`push vers ${cfg.repo} : ${p.stderr.trim()}`);
    const remote = git(["ls-remote", "origin", cfg.branch], work).split(/\s/)[0];
    const local = git(["rev-parse", "HEAD"], work);
    if (remote !== local) refuse(`après push, ${cfg.repo} ${cfg.branch} vaut ${remote.slice(0, 7)} au lieu de ${local.slice(0, 7)}`);
    log("public_sync", true, `${version} envoyé`, { sha: sha.slice(0, 7), public: local.slice(0, 7), ms: Date.now() - t0 });
    console.log(`public : ${version} envoyé vers ${cfg.repo} (${local.slice(0, 7)}), ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally {
    rmSync(tree, { recursive: true, force: true });
    if (!dry) rmSync(work, { recursive: true, force: true });
  }
}

function status() {
  const lines = [LOG_OLD, LOG].flatMap((f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n") : []));
  const rows = lines.filter((l) => l.includes('"public_sync"')).map((l) => JSON.parse(l) as { ts: string; ok: boolean; cause?: string });
  if (!rows.length) return console.log("public_sync : aucun envoi journalisé");
  const lastOk = rows.findLast((r) => r.ok),
    lastKo = rows.findLast((r) => !r.ok);
  console.log(`public_sync : ${rows.filter((r) => r.ok).length} réussis, ${rows.filter((r) => !r.ok).length} refusés`);
  console.log(`  dernier succès : ${lastOk ? `${lastOk.ts} ${lastOk.cause}` : "aucun"}`);
  console.log(`  dernier refus  : ${lastKo ? `${lastKo.ts} ${lastKo.cause?.split("\n")[0]}` : "aucun"}`);
  for (const r of rows.slice(-5)) console.log(`  ${r.ts} ${r.ok ? "ok " : "KO "} ${r.cause?.split("\n")[0] ?? ""}`);
}

if (import.meta.main) {
  const cmd = argv[0];
  const ref = opt("ref") ?? (cmd === "push" ? "origin/main" : "HEAD");
  try {
    if (cmd === "build") {
      const r = build(ref, opt("out"));
      console.log(`arbre public de ${r.sha.slice(0, 7)} : ${r.files} fichiers dans ${r.dir}, aucun motif interdit`);
    } else if (cmd === "push") {
      if (ref === "origin/main") git(["fetch", "-q", "origin", "main"]);
      push(ref, argv.includes("--dry-run"));
    } else if (cmd === "status") status();
    else {
      console.error("usage : bun scripts/public-sync.ts build|push|status [--ref REF] [--out DOSSIER] [--dry-run]");
      process.exit(2);
    }
  } catch (e) {
    const why = (e as Error).message;
    console.error("public_sync REFUSÉ : " + why);
    log("public_sync", false, why);
    if (cmd === "push" && !argv.includes("--dry-run")) alert("public_sync", why);
    process.exit(1);
  }
}
