// Effet des réglages de nettoyage (scripts/memory-prod.ts hygiene) sur un démon Hindsight de TEST, sans bot :
//   MEMORY_DAEMON=http://127.0.0.1:<port> bun test/memory-hygiene-check.ts
// 1. Non-réponse : un échange où le bot répond « inconnu » ne doit laisser aucun fait sur ce sujet.
// 2. Fait remplacé : code A puis code B pour le même projet ; après consolidation, le rappel donne B et plus A.
// Banque jetable `hygiene-<n>`, supprimée à la fin. Jamais sur le démon de prod (port 9144 refusé).
import { log } from "../lib/journal";
import { HYGIENE } from "../scripts/memory-prod";

const D = process.env.MEMORY_DAEMON;
if (!D || D.includes(":9144")) {
  console.error("MEMORY_DAEMON=<démon de test> obligatoire (jamais la prod, :9144)");
  process.exit(2);
}
const n = Math.floor(1000 + Math.random() * 9000),
  bank = `hygiene-${n}`,
  B = `${D}/v1/default/banks/${bank}`;
const T0 = Date.now(),
  at = () => `${Math.round((Date.now() - T0) / 1000)} s`;
const j = (url: string, method = "GET", body?: object) =>
  fetch(url, { method, headers: { "content-type": "application/json" }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(120_000) }).then(
    async (r) => {
      if (!r.ok) throw new Error(`${method} ${url} : ${r.status} ${(await r.text()).slice(0, 200)}`);
      return r.json() as any;
    }
  );
const recall = (query: string) =>
  j(`${B}/memories/recall`, "POST", { query, max_tokens: 600, types: ["observation", "world", "experience"] }).then((r) =>
    (r.results ?? []).map((x: any) => String(x.text))
  );
const retain = (content: string) => j(`${B}/memories`, "POST", { items: [{ content, timestamp: new Date().toISOString() }] });
const fails: string[] = [];

try {
  if (!process.env.SANS_REGLAGE) await j(`${B}/config`, "PATCH", { updates: HYGIENE }); // SANS_REGLAGE=1 : témoin
  const p = `Héron-${n}`,
    q = `Lynx-${n}`;
  await retain(`user: Quel est le nom de code du projet ${q} ?\nassistant: inconnu`);
  const unk = await recall(`nom de code du projet ${q}`);
  const leak = unk.filter((t: string) => t.includes(q));
  console.log(
    `  ${leak.length ? "ÉCHEC" : "ok  "} [${at()}] non-réponse : ${leak.length} fait(s) retenu(s) sur ${q}${leak.length ? " : " + leak.join(" | ").slice(0, 200) : ""}`
  );
  if (leak.length) fails.push("non-réponse retenue");

  await retain(`user: Le nom de code du projet ${p} est ORCHIDEE-1111.\nassistant: noté`);
  await retain(`user: Changement : le nom de code du projet ${p} est désormais ORCHIDEE-2222, l'ancien est abandonné.\nassistant: noté`);
  await j(`${B}/consolidate`, "POST", {});
  let got: string[] = [];
  for (const end = Date.now() + 150_000; Date.now() < end; await Bun.sleep(3000)) {
    got = await recall(`nom de code du projet ${p}`);
    if (got.some((t) => t.includes("2222")) && !got.some((t) => t.includes("1111") && !t.includes("2222"))) break;
  }
  const stale = got.filter((t) => t.includes("1111") && !t.includes("2222"));
  console.log(`  ${stale.length ? "ÉCHEC" : "ok  "} [${at()}] fait remplacé : ${got.length} résultat(s), ${stale.length} ancien(s) seul(s)`);
  for (const t of got) console.log(`        - ${t.slice(0, 140)}`);
  if (stale.length || !got.some((t) => t.includes("2222"))) fails.push("fait périmé encore rappelé");
} finally {
  await fetch(B, { method: "DELETE" }).catch(() => {});
}
log("memory_hygiene_check", !fails.length, fails.join(", ") || undefined, { total_s: Math.round((Date.now() - T0) / 1000) });
console.log(fails.length ? `ÉCHEC : ${fails.join(", ")}` : `OK (${at()})`);
process.exitCode = fails.length ? 1 : 0;
