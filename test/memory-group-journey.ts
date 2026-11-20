// Parcours réel de mémoire collective entre bots, dans des GROUPES de la PWA, sur une instance du gateway de test.
//   HERMES_TEST_HOME=~/.hermes-test-memoire HERMES_TEST_PORT=9321 bun test/memory-group-journey.ts setup | run
// - Jamais sur la prod ni sur ~/.hermes-test par défaut (une autre session peut s'en servir) : HERMES_TEST_HOME obligatoire.
// - Mémoire : plugin Hindsight en mode local_external, branché sur le démon du labo (test/memory-lab.ts, :9720), qui porte
//   déjà la clé LLM : aucune clé n'est copiée ici. Banque privée `groupe-{profile}`, banque commune `equipe-groupe`.
// - `run` : deux groupes distincts. Dans le groupe A (chiffres seul), Yoan donne un fait inédit à @chiffres. Dans le groupe B
//   (visuels seul), il demande ce fait à @visuels. visuels ne voit pas le groupe A : s'il répond juste, le fait est passé par
//   la mémoire commune. Vérifie aussi côté démon que le fait est dans `equipe-groupe`.
// Sortie 1 au moindre écart ; ligne `memory_group_journey` dans le journal, alerte Hub en cas d'échec.
import type { Page } from "playwright-core";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alert, log } from "../lib/journal";
import { openTestSession } from "./test-session";
import { TEST_HOME } from "./test-gateway";

// MEMORY_DAEMON / MEMORY_SHARED : répétition du montage de prod (scripts/memory-prod.ts, démon embarqué, banque `equipe`)
const DAEMON = process.env.MEMORY_DAEMON ?? "http://127.0.0.1:9720";
const LAB_PLUGIN = join(homedir(), ".hermes-hindsight-lab", "plugins", "hindsight");
const PROFILES = ["bots-test", "chiffres", "travel-prep", "visuels"];
const SHARED = process.env.MEMORY_SHARED ?? "equipe-groupe";
const T0 = Date.now();
const mark = (s: string) => console.log(`  ok  [${((Date.now() - T0) / 1000).toFixed(0)} s] ${s}`);
const fail = (s: string): never => {
  throw new Error(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (!process.env.HERMES_TEST_HOME || TEST_HOME === join(homedir(), ".hermes-test")) {
  console.error("memory-group-journey : HERMES_TEST_HOME=~/.hermes-test-<nom> obligatoire (jamais l'instance partagée)");
  process.exit(2);
}

async function daemonUp() {
  try {
    return (await fetch(DAEMON + "/v1/default/banks", { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

async function setup() {
  if (!existsSync(join(TEST_HOME, ".hermes-test-marker"))) fail(`${TEST_HOME} absent : bun test/test-gateway.ts reset avec la même HERMES_TEST_HOME`);
  if (!existsSync(LAB_PLUGIN)) fail("plugin Hindsight du labo absent : bun test/memory-lab.ts setup");
  if (!(await daemonUp())) fail(`démon Hindsight injoignable sur ${DAEMON} : bun test/memory-lab.ts journey le démarre`);
  const memory = "memory:\n  memory_enabled: true\n  provider: hindsight\n";
  for (const dir of [TEST_HOME, ...PROFILES.map((p) => join(TEST_HOME, "profiles", p))]) {
    const cfg = join(dir, "config.yaml");
    if (existsSync(cfg) && !readFileSync(cfg, "utf8").includes("provider: hindsight")) writeFileSync(cfg, readFileSync(cfg, "utf8") + memory);
    const link = join(dir, "plugins", "hindsight");
    mkdirSync(join(dir, "plugins"), { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(LAB_PLUGIN, link);
  }
  const conf = {
    mode: "local_external",
    api_url: DAEMON,
    bank_id: "groupe",
    bank_id_template: "groupe-{profile}",
    additional_banks: [SHARED],
    memory_mode: "hybrid",
    auto_recall: true,
    auto_retain: true,
    retain_async: false,
    observation_scopes: "shared",
    // défaut du plugin : `observation` seul, c.-à-d. les souvenirs consolidés par le LLM ; la consolidation passait ~70 s après
    // l'écriture et l'autre bot répondait « inconnu » jusque-là (mesuré le 2026-11-16). Les faits bruts sont lisibles en ~10 s.
    recall_types: "observation,world,experience",
  };
  mkdirSync(join(TEST_HOME, "hindsight"), { recursive: true });
  writeFileSync(join(TEST_HOME, "hindsight", "config.json"), JSON.stringify(conf, null, 2) + "\n");
  for (const p of PROFILES) {
    mkdirSync(join(TEST_HOME, "profiles", p, "hindsight"), { recursive: true });
    writeFileSync(join(TEST_HOME, "profiles", p, "hindsight", "config.json"), JSON.stringify(conf, null, 2) + "\n");
  }
  log("memory_group_setup", true, TEST_HOME);
  console.log(`Hindsight branché sur ${TEST_HOME} (démon ${DAEMON}) ; redémarrer l'instance : bun test/test-gateway.ts restart`);
}

async function waitUntil(page: Page, expr: string, timeout: number) {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(250)) if (await page.evaluate(expr).catch(() => false)) return;
  fail("attente dépassée : " + expr.slice(0, 80));
}
async function rpc(page: Page, method: string, params: object, ms = 20000): Promise<any> {
  return page.evaluate(
    `Promise.all([window.__compat('state'), window.__compat('groups')]).then(([s, g]) => s.state.roster.call(${JSON.stringify(method)}, g.gparams(${JSON.stringify(params)}), ${ms}))`
  );
}
const replies = (roomId: string, bot: string, since: number) => {
  const d = new Database(join(TEST_HOME, "state.db"), { readonly: true });
  try {
    // réponse directe d'un bot cité = message.member (les publications de la voie parallèle sont des message.user « [bot] ... »)
    return (
      d
        .query(
          `select json_extract(payload_json,'$.text') t from hosted_room_events where room_id = ? and created_at >= ? and (
      (kind = 'message.member' and json_extract(payload_json,'$.member_id') = ?) or (kind = 'message.user' and json_extract(payload_json,'$.text') like ?))
      order by seq`
        )
        .all(roomId, since, bot, `[${bot}] %`) as any[]
    ).map((r) => r.t as string);
  } finally {
    d.close();
  }
};

async function room(page: Page, name: string, bot: string, other: string): Promise<string> {
  const roomId = crypto.randomUUID(); // un groupe exige deux membres : `other` n'est jamais cité, il reste inactif
  const members = [bot, other].map((p) => ({ member_id: p, profile: p, handle: p, target: { kind: "local", profile: p } }));
  await rpc(page, "groups.create", { room_id: roomId, name, members }, 30000);
  await rpc(
    page,
    "groups.context",
    {
      room_id: roomId,
      event_id: crypto.randomUUID(),
      routing: "lead",
      lead_member_id: bot,
      purpose: "Groupe de test automatique de la mémoire collective (test/memory-group-journey.ts). Réponses courtes.",
      notes: "",
    },
    30000
  );
  await page.evaluate("window.__compat('groups').then((g) => g.loadGroups())");
  await waitUntil(page, `window.__compat('state').then((m) => (m.state.groups || []).some((r) => r.room_id === ${JSON.stringify(roomId)}))`, 20000);
  await page.evaluate(`window.__compat('groups').then((g) => g.openGroup(${JSON.stringify(roomId)}))`);
  await waitUntil(page, `window.__compat('state').then((m) => m.state.group?.room.room_id === ${JSON.stringify(roomId)} && !!m.state.group.context)`, 20000);
  return roomId;
}
async function say(page: Page, text: string) {
  await page.fill("[data-testid=input]", text);
  await page.click("[data-testid=send]");
  await page
    .locator("[data-testid=thread] [data-testid=bubble]", { hasText: text.slice(0, 30) })
    .last()
    .waitFor({ timeout: 15000 });
}
async function reply(roomId: string, bot: string, since: number, timeoutMs: number): Promise<string> {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(500)) {
    const r = replies(roomId, bot, since);
    if (r.length) return r[r.length - 1];
  }
  return fail(`${bot} n'a pas répondu en ${timeoutMs / 1000} s`);
}

async function run() {
  if (!(await daemonUp())) fail(`démon Hindsight injoignable sur ${DAEMON}`);
  const n = Math.floor(1000 + Math.random() * 9000);
  const project = `${["Héron", "Lynx", "Cèdre", "Basalte", "Corail", "Mistral"][n % 6]}-${n}`,
    code = `ORCHIDEE-${Math.floor(1000 + Math.random() * 9000)}`;
  const session = await openTestSession();
  const page = await session.ctx.newPage();
  try {
    await page.goto(session.origin + "/bots-next/");
    await waitUntil(page, "window.__compat('state').then((m) => m.state.roster?.ws?.readyState === 1)", 30000);
    mark(`PWA chargée (${await page.evaluate("self.APP_VERSION")})`);
    const a = await room(page, `Mémoire A ${n}`, "chiffres", "travel-prep");
    let t = Date.now() / 1000;
    await say(page, `@chiffres Information importante pour toute l'équipe : le nom de code du projet ${project} est ${code}. Réponds seulement « noté ».`);
    const ra = await reply(a, "chiffres", t, 90000);
    mark(`groupe A : chiffres apprend ${code} (« ${ra.slice(0, 60)} »)`);
    // On attend que le fait soit ÉCRIT dans la banque commune avant de questionner : questionner trop tôt fait répondre
    // « inconnu », et ce « inconnu » retenu dans la banque de visuels le trompe ensuite (mesuré le 2026-11-16). Une seule question.
    const recall = () =>
      fetch(`${DAEMON}/v1/default/banks/${SHARED}/memories/recall`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: `nom de code du projet ${project}`, max_tokens: 300, types: ["world", "experience", "observation"] }),
      })
        .then((r) => r.text())
        .catch(() => "");
    const tw = Date.now();
    while (!(await recall()).includes(code)) {
      if (Date.now() - tw > 60000) fail(`${code} toujours absent de la banque ${SHARED} après 60 s`);
      await sleep(1000);
    }
    const propagation = Math.round((Date.now() - tw) / 1000);
    mark(`banque ${SHARED} : contient ${code} (${propagation} s après la réponse de chiffres)`);
    const b = await room(page, `Mémoire B ${n}`, "visuels", "bots-test");
    t = Date.now() / 1000;
    await say(
      page,
      `@visuels Quel est le nom de code du projet ${project} ? Réponds de mémoire, sans chercher dans les fichiers : seulement le code, ou « inconnu ».`
    );
    const found = await reply(b, "visuels", t, 90000),
      tries = 1;
    mark(`groupe B : visuels répond « ${found.slice(0, 80)} » (${Math.round(Date.now() / 1000 - t)} s)`);
    if (!found.includes(code)) fail(`visuels ne retrouve pas ${code} depuis un autre groupe, alors qu'il est dans ${SHARED}`);
    for (const id of [a, b]) await rpc(page, "groups.disband", { room_id: id, cancel_id: crypto.randomUUID() }, 60000).catch(() => {});
    log("memory_group_journey", true, undefined, { project, code, tries, total_s: Math.round((Date.now() - T0) / 1000) });
    console.log(`OK : fait appris dans le groupe A, retrouvé dans le groupe B (${tries} essai(s), ${Math.round((Date.now() - T0) / 1000)} s)`);
  } finally {
    await session.close();
  }
}

const cmd = process.argv[2];
(cmd === "setup" ? setup() : cmd === "run" ? run() : Promise.reject(new Error("usage : setup | run"))).catch((e) => {
  const cause = (e as Error).message;
  log(`memory_group_${cmd}`, false, cause);
  alert(`memory_group_${cmd}`, cause);
  console.error("ÉCHEC : " + cause);
  process.exit(1);
});
