// Garde du dépôt public : rien de privé n'entre dans un commit, un message, un push, une PR ou une issue.
//   bun scripts/public-guard.ts staged          lignes ajoutées à l'index (hook pre-commit)
//   bun scripts/public-guard.ts msg FICHIER     message de commit (hook commit-msg)
//   bun scripts/public-guard.ts push REMOTE     refs lues sur stdin comme le hook pre-push : chaque commit poussé
//                                               (contenu ajouté et message) et refus de tout commit hors de l'histoire publique
//   bun scripts/public-guard.ts tree            tous les fichiers suivis (CI)
//   bun scripts/public-guard.ts text            texte lu sur stdin
//   bun scripts/public-guard.ts claude-hook     hook PreToolUse de Claude Code : texte des commandes gh pr|issue
// Motifs : génériques ci-dessous (publics), plus ceux de ~/.config/hermes-bots/forbidden.txt (une expression par ligne,
// propres à une installation, jamais dans le dépôt). Code de sortie 1 (2 pour claude-hook) au moindre motif trouvé.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_DIR } from "../lib/local-config";

// Premier commit du dépôt public : tout commit poussé doit en descendre. Un commit de l'ancien dépôt privé
// (pyxl-dev/hermes-bots-pwa, même .git possible sur le Mac) n'en descend pas et publierait tout son historique.
export const PUBLIC_ROOT = "edd6fa9c8c03a2da1f012031a6b595f48e559b84";
const ZERO = /^0+$/;

type Rule = { name: string; re: RegExp; local?: boolean };
const GENERIC: Rule[] = [
  { name: "domaine de tailnet", re: /\b[a-z0-9-]+\.[a-z0-9-]+\.ts\.net\b/i },
  { name: "chemin personnel", re: /\/(Users|home)\/(?!linuxbrew\b|runner\b|USER\b|user\b|me\b|toi\b|you\b)[a-z][a-z0-9_.-]*\//i },
  {
    name: "adresse IP privée",
    re: /\b(10\.(?!0\.0\.1\b)\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.(?!(0|1)\.1\b)\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3})\b/,
  },
  {
    name: "adresse e-mail",
    re: /\b[\w.+-]+@(?!(?:[\w-]+\.)*(?:example\.(?:com|org|net)|invalid|test|users\.noreply\.github\.com|anthropic\.com|github\.com)\b)[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i,
  },
];
const FORBIDDEN = process.env.HERMES_BOTS_FORBIDDEN || join(LOCAL_DIR, "forbidden.txt");
function rules(): Rule[] {
  const local = existsSync(FORBIDDEN)
    ? readFileSync(FORBIDDEN, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#"))
        .map((l) => ({ name: "motif perso", re: new RegExp(l), local: true }))
    : [];
  return [...GENERIC, ...local];
}
// Exception visible dans le diff, pour un motif générique seulement (jamais pour un motif perso).
const ALLOW = "public-guard: ok";

type Hit = { where: string; rule: string; line: string };
export function scan(lines: { where: string; text: string }[], rs = rules()): Hit[] {
  const hits: Hit[] = [];
  for (const { where, text } of lines)
    for (const r of rs) if (r.re.test(text) && (r.local || !text.includes(ALLOW))) hits.push({ where, rule: r.name, line: text.trim().slice(0, 120) });
  return hits;
}

const git = (args: string[]) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });

// Lignes ajoutées d'un diff unifié (git diff ou git log -p), avec fichier et numéro de ligne.
function addedLines(diff: string, prefix = ""): { where: string; text: string }[] {
  const out: { where: string; text: string }[] = [];
  let file = "",
    n = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) file = l.replace(/^\+\+\+ (b\/)?/, "");
    else if (l.startsWith("@@")) n = Number(/\+(\d+)/.exec(l)?.[1] ?? 0);
    else if (l.startsWith("+")) out.push({ where: `${prefix}${file}:${n++}`, text: l.slice(1) });
    else if (!l.startsWith("-")) n++;
  }
  return out;
}

function commitsOf(range: string[]): string[] {
  return git(["rev-list", ...range])
    .split("\n")
    .filter(Boolean);
}

export function checkPush(remote: string, input: string): string[] {
  const errors: string[] = [];
  const lines: { where: string; text: string }[] = [];
  for (const row of input.split("\n").filter(Boolean)) {
    const [localRef, localSha, , remoteSha] = row.split(" ");
    if (!localSha || ZERO.test(localSha)) continue; // suppression d'une branche distante
    const commit = git(["rev-parse", `${localSha}^{commit}`]).trim();
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", PUBLIC_ROOT, commit], { stdio: "ignore" });
    } catch {
      errors.push(
        `${localRef} ne descend pas de la racine publique ${PUBLIC_ROOT.slice(0, 7)} : c'est l'histoire de l'ancien dépôt privé, la pousser publierait tout ce qu'elle contient`
      );
      continue;
    }
    const range = remoteSha && !ZERO.test(remoteSha) ? [commit, `^${remoteSha}`] : [commit, "--not", `--remotes=${remote}`];
    for (const c of commitsOf(range)) {
      const short = c.slice(0, 7);
      git(["log", "-1", "--format=%an <%ae>%n%cn <%ce>%n%B", c])
        .split("\n")
        .forEach((text, i) => lines.push({ where: `${short} message:${i + 1}`, text }));
      lines.push(...addedLines(git(["show", "--format=", "--no-color", "-U0", "--no-ext-diff", c]), `${short} `));
    }
  }
  return [...errors, ...scan(lines).map(fmt)];
}

const fmt = (h: Hit) => `${h.where} (${h.rule}) ${h.line}`;
const textLines = (s: string, where: string) => s.split("\n").map((text, i) => ({ where: `${where}:${i + 1}`, text }));

function report(problems: string[], what: string, code = 1): never {
  if (!problems.length) process.exit(0);
  console.error(`REFUSÉ (dépôt public) : ${what}`);
  for (const p of problems.slice(0, 30)) console.error("  " + p);
  if (problems.length > 30) console.error(`  ... ${problems.length - 30} de plus`);
  console.error("Retire la donnée privée (réglage dans ~/.config/hermes-bots/config.json, données de test fictives), ne contourne pas la garde.");
  try {
    const { log } = require("../lib/journal");
    log("public_guard", false, `${what} : ${problems.length} problème(s)`);
  } catch {}
  process.exit(code);
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  const stdin = () => readFileSync(0, "utf8");
  if (cmd === "staged") {
    const diff = git(["diff", "--cached", "--no-color", "-U0", "--no-ext-diff", "--diff-filter=ACMR"]);
    const names = git(["diff", "--cached", "--name-only", "--diff-filter=ACR"]).split("\n").filter(Boolean);
    report(scan([...addedLines(diff), ...names.map((n) => ({ where: "nom de fichier", text: n }))]).map(fmt), "lignes ajoutées");
  } else if (cmd === "msg") {
    const text = readFileSync(arg, "utf8")
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .join("\n");
    report(scan(textLines(text, "message")).map(fmt), "message de commit");
  } else if (cmd === "push") report(checkPush(arg || "origin", stdin()), "commits poussés");
  else if (cmd === "tree") {
    const lines = git(["ls-files"])
      .split("\n")
      .filter(Boolean)
      .flatMap((f) => {
        if (!existsSync(f)) return [];
        const buf = readFileSync(f);
        return buf.subarray(0, 8000).includes(0) ? [] : textLines(buf.toString("utf8"), f);
      });
    report(scan(lines).map(fmt), "fichiers suivis");
  } else if (cmd === "text") report(scan(textLines(stdin(), "texte")).map(fmt), "texte");
  else if (cmd === "claude-hook") {
    // Claude Code passe {tool_input: {command}} ; seules les commandes qui publient du texte sur GitHub sont lues.
    let command = "";
    try {
      command = JSON.parse(stdin()).tool_input?.command ?? "";
    } catch {}
    if (!/\bgh\s+(pr|issue)\s+(create|edit|comment|review)\b|\bgh\s+api\b.*\b(issues|pulls|comments)\b/.test(command)) process.exit(0);
    const lines = textLines(command, "commande");
    for (const m of command.matchAll(/--body-file[= ]+("([^"]+)"|'([^']+)'|(\S+))/g)) {
      const f = m[2] || m[3] || m[4];
      if (f && f !== "-" && existsSync(f)) lines.push(...textLines(readFileSync(f, "utf8"), f));
    }
    report(scan(lines).map(fmt), "texte publié sur GitHub (PR, issue, commentaire)", 2);
  } else {
    console.error("usage : bun scripts/public-guard.ts staged | msg FICHIER | push REMOTE | tree | text | claude-hook");
    process.exit(2);
  }
}
