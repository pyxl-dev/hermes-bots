// Parcours du tableau du groupe (GLOSSARY.md « Tâche de groupe ») contre le gateway de TEST, SANS MODÈLE (test/fake-model.ts).
//   bun test/tasks-journey.ts [--path /bots-next/] [--app dossier]
// Groupe neuf « Test tableau » (meneur fx-meneur, membres fx-a, fx-b). Vérifie, avec la valeur observée :
//   1. une demande : le meneur crée UNE tâche, elle se ferme seule à la fin de la discussion, sa réponse en preuve ;
//   2. « go » : aucune nouvelle tâche, le meneur rattache le message, la tâche se rouvre puis se referme ;
//   3. le meneur garde la tâche en cours (doing) : elle reste ouverte après la discussion ;
//   4. le kanban : 4 colonnes, la carte dans « En cours », « Voir le message » ramène à la bulle.
// Sortie 1 au moindre écart ; ligne `tasks_journey` dans le journal, alerte Hub en cas d'échec. Moins de 30 s.
import type { Page } from "playwright-core";
import { alert, log } from "../lib/journal";
import { openTestSession } from "./test-session";
import { startFakeModel, type Msg } from "./fake-model";

const arg = (n: string, d: string) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const PATH = arg("path", "/bots-next/"), APP = arg("app", "");
const ROOM_NAME = "Test tableau", LEAD = "fx-meneur", A = "fx-a", B = "fx-b";
const SHOT = process.env.TASKS_SHOT || "";
const steps: string[] = []; const T0 = Date.now();
const mark = (s: string) => { steps.push(s); console.log(`  ok  [${((Date.now() - T0) / 1000).toFixed(1)} s] ` + s); };
const fail = (s: string): never => { throw new Error(s); };

const text = (c: unknown) => typeof c === "string" ? c : JSON.stringify(c ?? "");
const lastUser = (m: Msg[]) => text(m.filter((x) => x.role === "user").pop()?.content);
const roomOf = (t: string) => /room_id ([0-9a-f-]{36})/.exec(t)?.[1] || "";
// les outils des plugins sont différés côté gateway : un bot les appelle par tool_call
const board = (args: Record<string, unknown>) => ({ name: "tool_call", args: { calls: [{ name: "group_tasks", arguments: args }] } });

async function waitUntil(page: Page, expr: string, timeout: number) {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(200)) if (await page.evaluate(expr).catch(() => false)) return;
  throw new Error("attente dépassée : " + expr.slice(0, 80));
}
async function rpc(page: Page, method: string, params: object, ms = 20000): Promise<any> {
  return page.evaluate(`Promise.all([import(new URL('state.js', document.baseURI).href), import(new URL('groups.js', document.baseURI).href)]).then(([s, g]) => s.state.roster.call(${JSON.stringify(method)}, g.gparams(${JSON.stringify(params)}), ${ms}))`);
}

async function run() {
  // le meneur réagit au mot-clé du message de Yoan ; un seul appel d'outil par tour (faux modèle)
  const fake = startFakeModel({
    [LEAD]: (m) => {
      const t = lastUser(m), room = roomOf(t);
      if (t.includes("TACHE-A")) return { tool: board({ room_id: room, action: "add", title: "Relancer le jeu de test" }), text: "Jeu relancé, tu es sur l'écran de connexion." };
      if (t.includes("TACHE-GO")) return { tool: board({ room_id: room, action: "link", id: "t1" }), text: "C'est reparti, deuxième lancement fait." };
      if (t.includes("TACHE-GARDE")) return { tool: board({ room_id: room, action: "update", id: "t1", status: "doing" }), text: "Je continue dessus, je reviens vers toi." };
      return { text: "Reçu." };
    },
    [A]: { text: "ok" }, [B]: { text: "ok" },
  });
  const session = await openTestSession(APP || undefined);
  const page = await session.ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(session.origin + PATH);
    await waitUntil(page, "import(new URL('state.js', document.baseURI).href).then((m) => m.state.roster?.ws?.readyState === 1)", 30000)
      .catch(() => fail("PWA non connectée au gateway de test (" + page.url() + ")"));
    mark(`PWA chargée (${await page.evaluate("self.APP_VERSION")})`);

    // groupe neuf : les anciens « Test tableau » sont dissous
    const rooms: any[] = (await rpc(page, "groups.list", { limit: 200 })).rooms || [];
    for (const old of rooms.filter((r) => r.name === ROOM_NAME && !r.disbanded_at))
      await rpc(page, "groups.disband", { room_id: old.room_id, cancel_id: crypto.randomUUID() }, 60000).catch(() => {});
    const roomId = crypto.randomUUID();
    const members = [LEAD, A, B].map((p) => ({ member_id: p, profile: p, handle: p, target: { kind: "local", profile: p } }));
    await rpc(page, "groups.create", { room_id: roomId, name: ROOM_NAME, members }, 30000);
    await rpc(page, "groups.context", { room_id: roomId, event_id: crypto.randomUUID(), routing: "lead", lead_member_id: LEAD,
      purpose: "Groupe de test automatique du tableau (test/tasks-journey.ts).", notes: "" }, 30000);
    await page.evaluate("import(new URL('groups.js', document.baseURI).href).then((g) => g.loadGroups())");
    await page.evaluate(`import(new URL('groups.js', document.baseURI).href).then((g) => g.openGroup(${JSON.stringify(roomId)}))`);
    await waitUntil(page, `import(new URL('state.js', document.baseURI).href).then((m) => m.state.group?.room.room_id === ${JSON.stringify(roomId)} && !!m.state.group.context)`, 20000);
    mark(`groupe de test créé (${roomId.slice(0, 8)})`);

    const tasks = async (): Promise<any[]> => (await rpc(page, "plugin.bot-groups.tasks.list", { room_id: roomId })).tasks || [];
    const send = async (msg: string) => { await page.fill("#input", `@${LEAD} ` + msg); await page.click("#send"); };
    const until = async (what: string, ok: (ts: any[]) => boolean, ms = 9000) => {
      let ts: any[] = [];
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(300)) { ts = await tasks(); if (ok(ts)) return ts; }
      return fail(`${what} : tableau observé ${JSON.stringify(ts.map((t) => [t.id, t.status, t.hold, t.title]))}`);
    };

    // 1. demande : une tâche créée par le meneur, fermée seule à la fin de la discussion
    await send("TACHE-A relance le jeu stp");
    let ts = await until("demande non fermée", (x) => x.length === 1 && x[0].status === "done");
    if (ts[0].by !== LEAD || ts[0].title !== "Relancer le jeu de test") fail(`tâche inattendue : ${JSON.stringify(ts[0])}`);
    if (!/Jeu relancé/.test(ts[0].proof || "")) fail(`preuve absente ou fausse : « ${ts[0].proof} »`);
    mark(`demande : t1 « ${ts[0].title} » créée par ${ts[0].by}, fermée seule ; preuve « ${ts[0].proof.slice(0, 50)} »`);

    // 2. « go » : rattaché, pas de nouvelle tâche ; rouverte puis refermée
    await send("go TACHE-GO");
    ts = await until("relance non rattachée", (x) => x.length === 1 && x[0].status === "done" && (x[0].messages || []).length === 2 && /deuxième/.test(x[0].proof || ""));
    mark(`« go » : toujours 1 tâche, 2 messages rattachés, refermée (preuve « ${ts[0].proof.slice(0, 40)} »)`);

    // 3. le meneur la garde en cours : elle reste ouverte après la discussion
    await send("TACHE-GARDE tu continues ?");
    ts = await until("tâche gardée non ouverte", (x) => x[0]?.status === "doing" && x[0].hold === true);
    await page.waitForFunction(() => !(window as any).document.querySelector("#grp-bar:not([hidden])"), null, { timeout: 8000 }).catch(() => {});
    await Bun.sleep(1500); // laisse passer la fin de discussion
    ts = await tasks();
    if (ts[0].status !== "doing") fail(`tâche gardée fermée quand même : ${ts[0].status}`);
    mark("gardée par le meneur (doing) : toujours en cours après la discussion");

    // 4. kanban
    await page.click("#group-tasks");
    await page.locator("#tasks-dlg .kb-col").first().waitFor({ timeout: 5000 });
    const cols = await page.locator("#tasks-dlg .kb-col .kb-h span:first-child").allTextContents();
    if (cols.join("|") !== "À faire|En cours|Bloquée|Faite") fail(`colonnes : ${cols.join("|")}`);
    const cardEl = page.locator("#tasks-dlg .kb-col.doing .kb-card", { hasText: "Relancer le jeu de test" });
    await cardEl.waitFor({ timeout: 5000 }).catch(() => fail("la carte n'est pas dans « En cours »"));
    if (SHOT) await page.screenshot({ path: SHOT });
    await cardEl.click({ position: { x: 20, y: 12 } });
    await page.locator("#tasks-dlg .kb-card.open [data-act=msg]").click();
    if (await page.locator("#tasks-dlg").evaluate((d: any) => d.open)) fail("« Voir le message » n'a pas fermé le tableau : " + (await page.textContent("#tk-msg")));
    await page.locator("#log .bubble.hl").waitFor({ timeout: 3000 }).catch(() => fail("aucune bulle mise en avant par « Voir le message »"));
    mark(`kanban : ${cols.join(", ")} ; carte dans « En cours » ; « Voir le message » ramène à la bulle`);
    if (errors.length) fail("erreur JavaScript : " + errors.slice(0, 2).join(" | "));
    await rpc(page, "groups.disband", { room_id: roomId, cancel_id: crypto.randomUUID() }, 60000).catch(() => {});
  } finally {
    await page.close(); await session.close();
    console.log(`      faux modèle : ${fake.calls.map((c) => `${c.id}:${c.kind}(${JSON.stringify(c.said)})`).join(", ")}`);
    fake.stop();
  }
}

try {
  await run();
  const ms = Date.now() - T0;
  log("tasks_journey", true, `${steps.length} étapes en ${ms} ms`); console.log(`tasks-journey : ${steps.length} étapes, ${(ms / 1000).toFixed(1)} s`);
  if (ms > 30000) { console.error("tasks-journey : plus de 30 s"); process.exit(1); }
  process.exit(0);
} catch (e) {
  const m = (e as Error).message.split("\n")[0].slice(0, 300);
  console.error("tasks-journey ÉCHEC : " + m); log("tasks_journey", false, m); alert("tasks_journey", m); process.exit(1);
}
