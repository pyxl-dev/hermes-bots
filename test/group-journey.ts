// Parcours réel d'un groupe de bots contre le gateway de TEST (test/test-gateway.ts ; défauts listés dans docs/GOAL-enchainement-bots.md).
// Il ne tourne QUE sur le gateway de test : il le redémarre pendant une tâche (`test-gateway.ts restart`), ce qu'on ne fait jamais
// à la prod. Chromium headless isolé, connexion avec le mot de passe de ~/.hermes-test, PWA servie depuis app/ de ce dépôt.
// SANS MODÈLE : les bots du groupe (profils fx-* pour parallel, fy-* pour fil, fz-* pour restart) appellent le faux modèle déterministe de
// test/fake-model.ts, lancé par chaque partie. Groupes « Test enchaînement… » neufs à chaque passage.
//   bun test/group-journey.ts [--path /bots-next/] [--app dossier] [--no-restart] [--no-fil]
// Vérifie : le meneur nomme 2 bots sans @ → les 2 démarrent en même temps (dispatch.status) et la barre les affiche ;
// « attend son tour » n'apparaît jamais sans tâche `queued` du moteur pour ce bot ; la mention reste visible ;
// un redémarrage du gateway pendant une tâche parallèle ne perd pas son résultat ; aucun tour `failed` non relancé.
// Sortie 1 au moindre écart ; ligne `group_journey` dans le journal, alerte Hub en cas d'échec.
import type { Page } from "playwright-core";
import { Database } from "bun:sqlite";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alert, log } from "../lib/journal";
import { openTestSession } from "./test-session";
import { TEST_HOME } from "./test-gateway";
import { holdTestGateway } from "./gateway-lock";
import { startFakeModel, type Msg } from "./fake-model";

const arg = (n: string, d: string) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const PATH = arg("path", "/bots-next/"), APP = arg("app", "");
if (process.argv.includes("--cdp") || process.argv.includes("--target")) { console.error("group-journey ne tourne que sur le gateway de test (il le redémarre) : ni --cdp ni --target"); process.exit(2); }
// Trois parcours indépendants, chacun sous 30 s (règle de Yoan, 2026-11-16). Sans --part : « parallel » et « fil » en même temps (chacun son groupe),
// puis « restart » seul, car il redémarre le gateway de test, ce que les deux autres ne supportent pas en cours de route.
//   parallel : message du meneur, les deux bots en même temps, barre, mention visible, résultats, aucun tour en échec
//   restart  : le gateway de test redémarre (drain) pendant les tâches des deux bots, les deux résultats arrivent quand même
//   fil      : fil de travail ouvert en direct, arrêt d'un seul bot, fil rouvert depuis sa bulle
const argPart = process.argv.indexOf("--part"), PART = argPart > 0 ? process.argv[argPart + 1] : "";
const RESTART = PART === "restart", FIL = PART === "fil";
const NO_RESTART = process.argv.includes("--no-restart"), NO_FIL = process.argv.includes("--no-fil");
const ROOM_NAME = "Test enchaînement" + (PART === "restart" ? " redémarrage" : FIL ? " fil" : ""), SLEEP = 3, SLEEP_FIL = 5;
// Sans modèle (décidé par Yoan le 2026-11-16) : on prouve le plugin et la PWA (répartition parallèle, barre, fil, arrêt, redémarrage),
// pas la compréhension d'un vrai modèle. fil tourne en même temps que parallel : ses propres profils et son propre port.
// une partie = ses bots et son port : des tours relancés d'une partie précédente ne doivent jamais frapper le faux modèle de la suivante
const FX = FIL ? { p: "fy", port: 9330 } : RESTART ? { p: "fz", port: 9331 } : { p: "fx", port: 9329 };
const LEAD = `${FX.p}-meneur`, A = `${FX.p}-a`, B = `${FX.p}-b`;
const HERMES = TEST_HOME, DB = join(HERMES, "state.db"), BIN = import.meta.dir;
const steps: string[] = []; const T0 = Date.now(); const mark = (s: string) => { steps.push(s); console.log(`  ok  [${((Date.now() - T0) / 1000).toFixed(0)} s] ` + s); };
const fail = (s: string): never => { throw new Error(s); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// asynchrone : le faux modèle (restart) tourne dans CE processus ; un spawnSync gèlerait sa boucle, les bots attendraient sa réponse
// et le drain du gateway attendrait les bots (interblocage vu le 2026-11-16)
const sh = async (cmd: string[]) => { const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" }); const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); return { code, out: o + e }; };

function db<T>(f: (d: Database) => T): T { const d = new Database(DB, { readonly: true }); try { return f(d); } finally { d.close(); } }
const queuedFor = (roomId: string) => db((d) => (d.query(`select json_extract(payload_json,'$.target_member_id') m from hosted_room_driver_tasks
    where room_id = ? and status = 'queued'`).all(roomId) as any[]).map((r) => r.m as string));
const posted = (roomId: string, bot: string, since: number) => db((d) => (d.query(`select json_extract(payload_json,'$.text') t from hosted_room_events
    where room_id = ? and kind = 'message.user' and created_at >= ? and json_extract(payload_json,'$.text') like ?`).all(roomId, since, `[${bot}] %`) as any[]).map((r) => r.t as string));

// page.waitForFunction ne lit pas le résultat d'une promesse (import()) : une promesse est vraie, l'attente passait aussitôt.
async function waitUntil(page: Page, expr: string, timeout: number) {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(250)) if (await page.evaluate(expr).catch(() => false)) return;
  throw new Error("attente dépassée : " + expr.slice(0, 80));
}

async function rpc(page: Page, method: string, params: object, ms = 20000): Promise<any> {
  // `state` et `gparams` sont des const du script de la page : visibles par une expression évaluée, pas par globalThis
  return page.evaluate(`Promise.all([import(new URL('state.js', document.baseURI).href), import(new URL('groups.js', document.baseURI).href)]).then(([s, g]) => s.state.roster.call(${JSON.stringify(method)}, g.gparams(${JSON.stringify(params)}), ${ms}))`);
}

async function ensureRoom(page: Page): Promise<string> {
  await page.evaluate("import(new URL('groups.js', document.baseURI).href).then((g) => g.loadGroups())");
  const rooms: any[] = (await rpc(page, "groups.list", { limit: 200 })).rooms || [];
  // Un groupe NEUF à chaque passage. Réutiliser le groupe d'un passage précédent rendait le parcours instable (un passage sur deux, 2026-11-16) :
  // le meneur voit dans son fil ses anciens messages réécrits par le plugin (« @​travel-prep » neutralisés, « _En parallèle : ... »), les recopie
  // tels quels, et le plugin, ne trouvant plus de @ à traiter, ne lance rien. C'est un défaut du banc d'essai, pas du plugin.
  for (const old of rooms.filter((r) => r.name === ROOM_NAME && !r.disbanded_at)) {
    let d: any; // « work is still stopping » : le moteur finit d'arrêter le tour précédent, on réessaie
    for (const end = Date.now() + 90000; Date.now() < end; await sleep(2000)) {
      d = await rpc(page, "groups.disband", { room_id: old.room_id, cancel_id: crypto.randomUUID() }, 60000).catch((e) => (/still stopping/.test(String(e.message)) ? null : Promise.reject(e)));
      if (d?.tombstone) break;
    }
    if (!d?.tombstone) fail(`ancien groupe de test ${old.room_id.slice(0, 8)} non supprimé`);
  }
  const roomId = crypto.randomUUID();
  const members = [LEAD, A, B].map((p) => ({ member_id: p, profile: p, handle: p, target: { kind: "local", profile: p } }));
  await rpc(page, "groups.create", { room_id: roomId, name: ROOM_NAME, members }, 30000);
  await rpc(page, "groups.context", { room_id: roomId, event_id: crypto.randomUUID(), routing: "lead", lead_member_id: LEAD,
    purpose: "Groupe de test automatique de l'enchaînement des bots (test/group-journey.ts). Réponses courtes.", notes: "" }, 30000);
  await page.evaluate("import(new URL('groups.js', document.baseURI).href).then((g) => g.loadGroups())");
  mark(`groupe de test créé (${roomId.slice(0, 8)})`);
  return roomId;
}

async function run() {
  const lastUser = (m: Msg[]) => { const u = m.filter((x) => x.role === "user").pop(); return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content ?? ""); };
  const fake = PART ? startFakeModel({
    // le meneur recopie les deux lignes du message de test ; cité ensuite par les résultats des membres, il accuse réception
    [LEAD]: (m) => { const t = lastUser(m); const lines = t.split("\n").filter((l) => l.startsWith(A + " : ") || l.startsWith(B + " : "));
      return { text: t.includes("Réponds uniquement par ces deux lignes") && lines.length === 2 && !t.includes(`[${A}]`) && !t.includes(`[${B}]`) ? lines.join("\n") : "Reçu." }; },
    [A]: { tool: { name: "terminal", args: { command: `sleep ${FIL ? SLEEP_FIL : SLEEP}` } }, text: FIL ? "fini-A" : "391" },
    [B]: { tool: { name: "terminal", args: { command: `sleep ${FIL ? SLEEP_FIL : SLEEP}` } }, text: FIL ? "fini-B" : "Madrid" },
  }, FX.port) : null;
  const session = await openTestSession(APP || undefined);
  const page = await session.ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(session.origin + PATH);
    await waitUntil(page, "import(new URL('state.js', document.baseURI).href).then((m) => m.state).then((state) => state.roster?.ws?.readyState === 1)", 30000)
      .catch(() => fail("PWA non connectée au gateway : session de test expirée ? (" + page.url() + ")"));
    mark(`PWA chargée (${await page.evaluate("self.APP_VERSION")}, ${PATH})`);
    let roomId = await ensureRoom(page);
    const openRoom = async () => {
    await waitUntil(page, `import(new URL('state.js', document.baseURI).href).then((m) => m.state).then((state) => (state.groups || []).some((r) => r.room_id === ${JSON.stringify(roomId)}))`, 20000);
    await page.evaluate(`import(new URL('groups.js', document.baseURI).href).then((g) => g.openGroup(${JSON.stringify(roomId)}))`);
    await waitUntil(page, `import(new URL('state.js', document.baseURI).href).then((m) => m.state).then((state) => state.group?.room.room_id === ${JSON.stringify(roomId)} && !!state.group.context)`, 20000);
    };
    await openRoom();

    // garde du défaut 1 : chaque « attend son tour » affiché doit correspondre à une tâche queued du moteur
    let watching = !FIL && !RESTART, waitChecks = 0;
    const watcher = (async () => {
      while (watching) {
        const txt = (await page.textContent("#grp-txt").catch(() => "")) || "";
        const visible = await page.locator("#grp-bar").isVisible().catch(() => false);
        const m = visible && /(.+?) (?:attend son tour|attendent leur tour)/.exec(txt.split(" · ").slice(1).join(" · "));
        if (m) {
          waitChecks++;
          const q = queuedFor(roomId);
          const names = m[1].split(/, | et /).map((s) => s.trim());
          const members: any[] = await page.evaluate("import(new URL('state.js', document.baseURI).href).then((s) => s.state.group.room.members)");
          for (const n of names) {
            const mem = members.find((x) => [x.display_name, x.handle, x.profile].includes(n));
            if (!mem || !q.includes(mem.member_id)) { watching = false; errors.push(`« ${n} attend son tour » affiché sans tâche queued du moteur (file : ${q.join(", ") || "vide"})`); }
          }
        }
        // le message envoyé groupe au repos est celui auquel le meneur répond : jamais « en attente » (vu le 2026-11-16)
        if (await page.locator("#log .row.in-queue", { hasText: "Test automatique" }).count().catch(() => 0)) {
          watching = false; errors.push("message envoyé groupe au repos affiché « en attente » alors que le meneur y répond");
        }
        await sleep(700);
      }
    })();

    const t0 = Date.now() / 1000;
    if (!FIL) {
    // @meneur : sans mention, le meneur répartit par {"assign": [...]} au lieu d'écrire, et le cas « nomme deux bots
    // sans @ » n'est pas joué (premier passage du 2026-11-16)
    const msg = `@${LEAD} Test automatique ${new Date().toISOString().slice(11, 19)}. Réponds uniquement par ces deux lignes, recopiées telles quelles, sans @ et sans rien ajouter :\n`
      + `${A} : lance la commande \`sleep ${SLEEP}\` dans ton terminal et attends qu'elle finisse, puis réponds seulement par le résultat de 17 × 23 (le nombre seul).\n`
      + `${B} : lance la commande \`sleep ${SLEEP}\` dans ton terminal et attends qu'elle finisse, puis réponds seulement « Madrid ».`;
    {
      await page.fill("#input", msg); await page.click("#send");
      await page.locator("#log .bubble", { hasText: "Test automatique" }).last().waitFor({ timeout: 15000 });
      mark(`message envoyé au meneur ${LEAD}`);
    }

    if (!RESTART) {
    // 1. les deux en parallèle, vus par le plugin et par la barre
    let both = false, barBoth = false;
    for (let i = 0; i < 360 && !(both && barBoth); i++) {
      // au travail = tâche parallèle en cours (plugin) ou tour du moteur en cours (member_activity running)
      const jobs: any[] = ((await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId }).catch(() => ({}))).jobs || []).filter((j: any) => j.status === "running");
      const st = await rpc(page, "groups.state", { room_id: roomId }).catch(() => ({}));
      const busy = new Set([...jobs.map((j) => j.bot), ...((st.driver_status?.member_activity || []) as any[]).filter((a) => a.status === "running").map((a) => a.member_id)]);
      if (busy.has(A) && busy.has(B)) both = true;
      const txt = (await page.textContent("#grp-txt").catch(() => "")) || "";
      if (txt.includes(A) && txt.includes(B) && /parallèle/.test(txt)) barBoth = true;
      if (errors.length) break;
      await sleep(500);
    }
    if (errors.length) fail("erreur pendant l'attente du parallèle : " + errors.slice(0, 3).join(" | "));
    if (!both) fail(`${A} et ${B} n'ont jamais tourné en même temps (dispatch.status + moteur)`);
    mark(`${A} et ${B} au travail en même temps (dispatch.status + moteur)`);
    if (!barBoth) fail(`la barre n'a jamais affiché ${A} et ${B} en parallèle (dernier texte : ${await page.textContent("#grp-txt")})`);
    mark("la barre affiche les deux noms en parallèle");

    // 2. la mention du meneur reste visible (neutralisée), pas retirée
    const lead = db((d) => d.query(`select json_extract(payload_json,'$.text') t from hosted_room_events where room_id = ? and kind = 'message.member'
        and json_extract(actor_json,'$.id') = ? and created_at >= ? order by seq desc limit 1`).get(roomId, LEAD, t0) as any)?.t || "";
    if (!lead.includes("@​" + A) || !lead.includes("@​" + B)) fail("message du meneur sans @ visible devant les bots : " + lead.slice(0, 200));
    mark("message du meneur : @ ajoutés puis neutralisés, visibles");

    }
    // 3. redémarrage du gateway pendant les tâches des deux bots
    if (RESTART) {
      // le redémarrage ne doit tomber qu'une fois les DEUX bots en plein tour (outil en cours, trace.list) : un tour qui démarre pendant le drain échoue (« Gateway draining : not_ready »)
      const tracing = async (m: string) => ((await rpc(page, "plugin.bot-groups.trace.list", { room_id: roomId }).catch(() => ({}))).traces || []).some((x: any) => x.status === "running" && x.member_id === m && x.started >= t0 - 5);
      // avec le faux modèle, prêt = les deux bots ont reçu leur outil (sleep en cours) ; une trace « running » apparaît avant le premier appel au modèle
      const inTool = (m: string) => !!fake?.calls.some((c) => c.id === m && c.kind === "tool");
      for (let i = 0; i < 150 && !(fake ? inTool(A) && inTool(B) : (await tracing(A)) && (await tracing(B))); i++) await sleep(200);
      const jobs: any[] = (await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId })).jobs || [];
      if (!jobs.some((j) => j.bot === B && j.status === "running")) fail(`${B} a fini avant le redémarrage : scénario non joué`);
      if (fake && !(inTool(A) && inTool(B))) fail(`${A} et ${B} n'ont pas lancé leur outil : scénario non joué (${fake.calls.map((c) => c.id + ":" + c.kind).join(", ")})`);
      const r = await sh(["env", "HERMES_TEST_DRAIN_S=25", "bun", join(BIN, "test-gateway.ts"), "restart"]); // drain : durée de la tâche (15 s) + marge // le gateway de TEST, jamais celui de la prod
      if (r.code !== 0) fail("redémarrage du gateway de test en échec : " + r.out.slice(-200));
      mark(`gateway de test redémarré pendant la tâche de ${B}`);
      const chk = await sh(["bun", join(BIN, "test-gateway.ts"), "status"]);
      console.log(chk.out.trim().split("\n").map((l) => "      " + l).join("\n"));
      if (chk.code !== 0) fail("le gateway de test ne répond pas après le redémarrage");
      mark("test-gateway status : sain");
    }

    // 4. les deux résultats arrivent dans le groupe
    for (let i = 0; i < 120; i++) { if (posted(roomId, A, t0).length && posted(roomId, B, t0).length) break; await sleep(1000); }
    const ra = posted(roomId, A, t0)[0] || "", rb = posted(roomId, B, t0)[0] || "";
    if (!ra.includes("391")) fail(`résultat de ${A} absent ou faux : ${ra.slice(0, 120) || "(aucun)"}`);
    if (!/madrid/i.test(rb)) fail(`résultat de ${B} absent ou faux : ${rb.slice(0, 120) || "(aucun)"}`);
    mark(`résultats postés : ${A} « 391 », ${B} « Madrid »${RESTART ? " (après redémarrage)" : ""}`);

    // 5. la PWA les affiche sous le nom des bots
    if (RESTART) { await page.reload(); await waitUntil(page, "import(new URL('state.js', document.baseURI).href).then((s) => s.state.roster?.ws?.readyState === 1)", 60000); await page.evaluate("import(new URL('groups.js', document.baseURI).href).then((g) => g.loadGroups())"); await waitUntil(page, `import(new URL('state.js', document.baseURI).href).then((m) => m.state).then((state) => (state.groups || []).some((r) => r.room_id === ${JSON.stringify(roomId)}))`, 20000); await page.evaluate(`import(new URL('groups.js', document.baseURI).href).then((g) => g.openGroup(${JSON.stringify(roomId)}))`); }
    await page.locator("#log .row.member .bubble", { hasText: "391" }).last().waitFor({ timeout: 30000 }).catch(() => fail(`bulle de ${A} absente dans la PWA`));
    await page.locator("#log .row.member .bubble", { hasText: /Madrid/i }).last().waitFor({ timeout: 30000 }).catch(() => fail(`bulle de ${B} absente dans la PWA`));
    mark("bulles des deux bots affichées dans la PWA");

    // 6. aucun tour du moteur en échec laissé sans relance
    await sleep(1000);
    const failed = db((d) => d.query(`select task_id, result_json r from hosted_room_driver_tasks where status = 'failed' and updated_at >= ?`).all(t0) as any[]);
    const relaunched: string[] = existsSync(join(HERMES, "data/bot-groups/relaunched.json")) ? JSON.parse(readFileSync(join(HERMES, "data/bot-groups/relaunched.json"), "utf8")) : [];
    const orphan = failed.filter((f) => !relaunched.includes(f.task_id));
    if (orphan.length) fail(`tours du moteur en échec sans relance : ${orphan.map((f) => f.task_id.slice(0, 14) + " " + String(f.r).slice(0, 60)).join(" ; ")}`);
    mark(`aucun tour en échec sans relance (${failed.length} en échec, tous relancés)`);


    } // fin de la partie parallel / restart

    // 7. fil de travail : ouvrir celui d'un bot en direct, l'arrêter seul pendant que l'autre continue, rouvrir un fil après coup
    if (FIL) {
      const t1 = Date.now() / 1000, tag = new Date().toISOString().slice(11, 19);
      const msg2 = `@${LEAD} Test du fil de travail ${tag}. Réponds uniquement par ces deux lignes, recopiées telles quelles, sans @ et sans rien ajouter :\n`
        + `${A} : lance la commande \`sleep ${SLEEP_FIL}\` dans ton terminal et attends qu'elle finisse, puis réponds seulement « fini-A ».\n`
        + `${B} : lance la commande \`sleep ${SLEEP_FIL}\` dans ton terminal et attends qu'elle finisse, puis réponds seulement « fini-B ».`;
      await page.fill("#input", msg2); await page.click("#send");
      await page.locator("#log .bubble", { hasText: "Test du fil de travail" }).last().waitFor({ timeout: 15000 });
      const runningTraces = async (member: string) => ((await rpc(page, "plugin.bot-groups.trace.list", { room_id: roomId })).traces as any[]).filter((x) => x.status === "running" && x.member_id === member && x.started >= t1 - 5);
      for (let i = 0; i < 120 && !((await runningTraces(A)).length && (await runningTraces(B)).length); i++) await sleep(1000);
      if (!(await runningTraces(A)).length || !(await runningTraces(B)).length) fail(`fil de travail : ${A} et ${B} n'ont pas chacun un fil en cours (trace.list : ${JSON.stringify(((await rpc(page, "plugin.bot-groups.trace.list", { room_id: roomId })).traces as any[]).map((x) => [x.member_id, x.status, Math.round(x.started - t1)]))}, jobs : ${JSON.stringify(((await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId })).jobs || []).map((j: any) => [j.bot, j.status]))})`);
      mark(`trace.list : un fil en cours pour ${A} et pour ${B}`);
      await page.locator(`#grp-av [data-worker="${A}"]`).click();
      await page.locator("#trace-sheet.on").waitFor({ timeout: 5000 });
      const sleepTool = page.locator("#tr-body .tool.run summary", { hasText: `sleep ${SLEEP_FIL}` });
      await sleepTool.waitFor({ timeout: 30000 }).catch(() => fail(`fil de ${A} en direct : l'outil « sleep ${SLEEP_FIL} » n'apparaît pas `));
      const shown = (await sleepTool.first().textContent()) || "";
      mark(`fil de ${A} ouvert en direct : « ${shown.trim()} » en cours`);
      await page.click("#tr-stop");
      await page.locator("#tr-state", { hasText: "arrêté" }).waitFor({ timeout: 30000 }).catch(() => fail(`le fil de ${A} n'est pas passé à « arrêté »`));
      await page.click("#tr-close");
      const jobsAfter: any[] = (await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId })).jobs || [];
      const aRunning = jobsAfter.some((j) => j.bot === A && j.status === "running");
      const st = await rpc(page, "groups.state", { room_id: roomId });
      const aEngine = ((st.driver_status?.member_activity || []) as any[]).some((x) => x.member_id === A && ["running", "queued", "stopping"].includes(x.status));
      if (aRunning && aEngine) fail(`${A} travaille encore après « Arrêter ce bot »`);
      if (!(await runningTraces(B)).length) fail(`${B} s'est arrêté avec ${A} : « Arrêter ce bot » doit épargner les autres`);
      mark(`${A} arrêté seul (dispatch.status : ${aRunning ? "tâche encore listée" : "plus de tâche"} ; moteur : ${aEngine ? "encore actif" : "inactif"}), ${B} continue`);
      for (let i = 0; i < 90 && !posted(roomId, B, t1).some((x) => /fini-B/i.test(x)); i++) await sleep(1000);
      if (!posted(roomId, B, t1).some((x) => /fini-B/i.test(x))) fail(`${B} n'a pas posté « fini-B » après l'arrêt de ${A}`);
      if (posted(roomId, A, t1).some((x) => /pas pu finir/i.test(x))) fail(`${A} a posté un échec après son arrêt volontaire`);
      mark(`${B} a posté « fini-B » ; aucun post d'échec de ${A}`);
      // après coup : la bulle de résultat de B rouvre son fil, outil terminé
      await page.reload(); await waitUntil(page, "import(new URL('state.js', document.baseURI).href).then((s) => s.state.roster?.ws?.readyState === 1)", 60000);
      await page.evaluate(`import(new URL('groups.js', document.baseURI).href).then((g) => g.openGroup(${JSON.stringify(roomId)}))`);
      const bubble = page.locator("#log .bubble.has-trace", { hasText: /fini-B/i }).last();
      await bubble.waitFor({ timeout: 30000 }).catch(() => fail("la bulle « fini-B » n'a pas de fil (trace.list ↔ event_id)"));
      await bubble.click({ position: { x: 20, y: 10 } });
      const done = page.locator("#tr-body .tool.done summary", { hasText: `sleep ${SLEEP_FIL}` });
      await done.waitFor({ timeout: 10000 }).catch(() => fail(`fil rouvert après coup : l'outil « sleep ${SLEEP_FIL} » fini est absent`));
      mark(`fil de ${B} rouvert après coup depuis sa bulle : « ${((await done.first().textContent()) || "").trim()} » fini`);
      await page.click("#tr-close");
    }
    watching = false; await watcher;
    if (errors.length) fail(errors.slice(0, 2).join(" | "));
    mark(`aucun « attend son tour » sans file réelle (${waitChecks} affichage(s) contrôlé(s)), aucune erreur JavaScript`);
  } finally { await page.close(); await session.close(); if (fake) { console.log(`      faux modèle : ${fake.calls.length} appels (${fake.calls.map((c) => `${c.id}:${c.kind}(${JSON.stringify(c.said)})`).join(", ")})`); fake.stop(); } }
}
let t = Date.now();
async function orchestrate() {
  const pass = process.argv.slice(2).filter((a, i, all) => !["--no-restart", "--no-fil", "--part"].includes(a) && all[i - 1] !== "--part");
  const one = async (part: string) => {
    const p = Bun.spawn(["bun", import.meta.path, ...pass, "--part", part], { stdout: "pipe", stderr: "pipe", env: process.env });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { part, out, err, code };
  };
  const wave1 = await Promise.all(["parallel", ...(NO_FIL ? [] : ["fil"])].map(one));
  const res = [...wave1, ...(NO_RESTART || wave1.some((r) => r.code !== 0) ? [] : [await one("restart")])];
  for (const r of res) { console.log(`-- parcours ${r.part} : code ${r.code}`); console.log(r.out.trimEnd()); if (r.err.trim()) console.error(r.err.trimEnd()); }
  const bad = res.find((r) => r.code !== 0);
  if (bad) fail("parcours " + bad.part + " : " + (bad.err.split("\n").find((l) => /ÉCHEC/.test(l)) || "échec").replace(/^group-journey ÉCHEC : /, ""));
  steps.length = 0; for (const r of res) for (const l of r.out.split("\n")) if (l.startsWith("  ok  ")) steps.push(l);
}
try {
  if (await holdTestGateway("group-journey")) t = Date.now(); // le chrono part une fois le gateway de test à nous
  await (PART ? run() : orchestrate());
  if (PART) { console.log(`group-journey (${PART}) : ${steps.length} étapes, ${((Date.now() - t) / 1000).toFixed(1)} s`); process.exit(0); }
  log("group_journey", true, `${steps.length} étapes en ${Date.now() - t} ms`); console.log(`group-journey : ${steps.length} étapes, ${((Date.now() - t) / 1000).toFixed(1)} s`); process.exit(0);
}
catch (e) { const m = (e as Error).message.split("\n")[0].slice(0, 300); console.error("group-journey ÉCHEC : " + m); if (!PART) { log("group_journey", false, m); alert("group_journey", m); } process.exit(1); }
