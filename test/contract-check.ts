// Chaque appel RPC du client (web/src) validé contre l'instantané versionné des contrats du gateway Hermes (test/fixtures/contracts.json).
// Une méthode inconnue ou un paramètre refusé est un écart (sortie 1). Le mock accepte tout : deux pannes en prod (2026-11-14) venaient d appels jamais confrontés au gateway.
// L'instantané est régénéré par `bun run check:snapshot` ; `bun run check:fresh` vérifie qu il correspond au gateway installé (portail de release).
import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const snap: { methods: Record<string, string[]>; canonical: Record<string, string[]> } = JSON.parse(
  readFileSync(join(import.meta.dir, "fixtures/contracts.json"), "utf8")
);
// `x.call('m', { … })` (gateway) et `call('m', gparams({ … }))` (groupes) : le nom est toujours vérifié, les clés quand l'objet est littéral.
const CALL = /(?:\.|(?<![\w$]))call\(\s*['"]([\w.\-]+)['"]\s*(?:,\s*(?:gparams\(\s*)?\{([^{}]*)\})?/g;
const KEY = /(?:^|,)\s*(?:\.\.\.[^,]+|([A-Za-z_]\w*)\s*(?::|(?=,|$)))/g;

const bad: string[] = [];
let seen = 0;
const SRC = join(ROOT, "web", "src");
const files = (readdirSync(SRC, { recursive: true }) as string[]).filter((n) => /\.tsx?$/.test(n)).sort();
for (const rel of files) {
  const f = relative(ROOT, join(SRC, rel)),
    src = readFileSync(join(SRC, rel), "utf8");
  for (const m of src.matchAll(CALL)) {
    const name = m[1],
      body = m[2] ?? "",
      line = src.slice(0, m.index).split("\n").length;
    const keys = new Set([...body.matchAll(KEY)].map((k) => k[1]).filter(Boolean));
    seen++;
    if (name.startsWith("plugin.")) continue; // RPC de plugin : contrat porté par le plugin, hors registre
    const canonical = name in snap.canonical,
      fields = snap.canonical[name] ?? snap.methods[name];
    if (!fields) {
      bad.push(`${f}:${line} ${name} : méthode inconnue du gateway`);
      continue;
    }
    const extra = [...keys].filter((k) => !fields.includes(k));
    if (extra.length) bad.push(`${f}:${line} ${name} (${canonical ? "canonique" : "classique"}) : paramètre(s) refusé(s) ${JSON.stringify(extra.sort())}`);
  }
}
console.log(`${seen} appels RPC vérifiés contre l'instantané, ${bad.length} écart(s)`);
for (const b of bad) console.log("  ÉCART " + b);
process.exit(bad.length ? 1 : 0);
