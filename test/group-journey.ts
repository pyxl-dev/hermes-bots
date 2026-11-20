// Parcours réel d'un groupe de bots contre le gateway de TEST (test/test-gateway.ts).
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
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { alert, log } from "../lib/journal";
import { openTestSession } from "./test-session";
import { TEST_HOME } from "./test-gateway";
import { holdTestGateway } from "./gateway-lock";
import { startFakeModel, type Msg } from "./fake-model";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const PATH = arg("path", "/bots-next/"),
  APP = arg("app", "");
if (process.argv.includes("--cdp") || process.argv.includes("--target")) {
  console.error("group-journey ne tourne que sur le gateway de test (il le redémarre) : ni --cdp ni --target");
  process.exit(2);
}
// Parcours indépendants, chacun un contrôle sous 60 s (règle de Yoan, 60 s depuis le 2026-11-17) : une partie qui dépasse échoue.
// Sans --part : les parties l'une après l'autre. Jouées en même temps sur un seul gateway, elles se ralentissaient (parallel 14 s seule,
// 47 s en vague) et cassaient au hasard (drain de plus de 25 s, arrêt du fil manqué ; trois échecs différents le 2026-11-18).
//   parallel : message du meneur, les deux bots en même temps, barre, mention visible, résultats, aucun tour en échec
//   restart  : le gateway de test redémarre (drain) pendant les tâches des deux bots, les deux résultats arrivent quand même
//   reload   : le plugin est rechargé à chaud (plugin.bot-groups.reload) pendant les tâches des deux bots : nouveau code pris,
//              une seule boucle de fond de chaque sorte, les deux résultats arrivent (2026-11-18)
//   fil      : fil de travail ouvert en direct, arrêt d'un seul bot, fil rouvert depuis sa bulle
//   immediate: pendant le tour d'un membre, un message sans @ part au meneur libre en réponse immédiate (pas « en attente »),
//              sa réponse ne le cite pas lui-même, et son tour de discussion attend la fin de cette réponse (GLOSSARY.md, 2026-11-17)
//   yaia     : Yaia (session Claude de Yoan) poste par scripts/yaia.py : affiché à son nom dans la PWA, le meneur répond avec la
//              règle YAIA_RULE, yaia.py read lit l'échange (2026-11-18)
//   steer    : pendant le tour du meneur (en plein outil), un message le recadre (il le lit dans ce tour, aucune réponse à part) ;
//              « /q » en garde deux, l'un annulé (texte rendu à la zone de saisie), l'autre part seul après la discussion
//              (GLOSSARY.md « Recadrage », « Demande suivante », 2026-11-17) ; enfin, pendant une tâche en coulisse de A, un message
//              sans @ part au meneur, qui recadre A avec group_steer : A le lit dans son tour, le fil montre le recadrage signé du meneur
const argPart = process.argv.indexOf("--part"),
  PART = argPart > 0 ? process.argv[argPart + 1] : "";
const RELOAD = PART === "reload",
  RESTART = PART === "restart",
  FIL = PART === "fil",
  IMM = PART === "immediate",
  STEER = PART === "steer",
  YAIA = PART === "yaia";
const NO_RESTART = process.argv.includes("--no-restart"),
  NO_FIL = process.argv.includes("--no-fil");
// réponses de B écrites mot par mot (réponse en direct dans le groupe, 2026-11-18) : parallel passe par le moteur (hooks
// on_stream_*), fil par la table ronde (flux stream-json). Pas de « : » en tête de morceau (voir test/fake-model.ts).
const MADRID = "Madrid, ville retenue après vérification, rien d'autre à ajouter pour ce test parallèle.";
const FINI_B = "fini-B, la commande sleep est terminée sans erreur, rien d'autre à signaler de mon côté pour ce test du fil de travail.";
const ROOM_NAME =
    "Test enchaînement" +
    (RELOAD ? " rechargement" : PART === "restart" ? " redémarrage" : FIL ? " fil" : IMM ? " immédiat" : STEER ? " recadrage" : YAIA ? " yaia" : ""),
  SLEEP = 3,
  SLEEP_FIL = 5;
// Sans modèle (décidé par Yoan le 2026-11-16) : on prouve le plugin et la PWA (répartition parallèle, barre, fil, arrêt, redémarrage),
// pas la compréhension d'un vrai modèle. fil tourne en même temps que parallel : ses propres profils et son propre port.
// une partie = ses bots et son port : des tours relancés d'une partie précédente ne doivent jamais frapper le faux modèle de la suivante
const FX = RELOAD
  ? { p: "fu", port: 9335 }
  : FIL
    ? { p: "fy", port: 9330 }
    : RESTART
      ? { p: "fz", port: 9331 }
      : IMM
        ? { p: "fw", port: 9332 }
        : STEER
          ? { p: "fv", port: 9333 }
          : { p: "fx", port: 9329 };
const LEAD = `${FX.p}-meneur`,
  A = `${FX.p}-a`,
  B = `${FX.p}-b`;
const HERMES = TEST_HOME,
  DB = join(HERMES, "state.db"),
  BIN = import.meta.dir;
const steps: string[] = [];
const T0 = Date.now();
const mark = (s: string) => {
  steps.push(s);
  console.log(`  ok  [${((Date.now() - T0) / 1000).toFixed(0)} s] ` + s);
};
const fail = (s: string): never => {
  throw new Error(s);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// asynchrone : le faux modèle (restart) tourne dans CE processus ; un spawnSync gèlerait sa boucle, les bots attendraient sa réponse
// et le drain du gateway attendrait les bots (interblocage vu le 2026-11-16)
// env explicite : sans lui Bun.spawn (1.4.4) transmet l'environnement du démarrage, sans TEST_GATEWAY_LOCK=tenu posé par
// holdTestGateway ; `test-gateway restart` attendait alors le verrou de ce processus même (`--part restart` lancé seul, 2026-11-17)
const sh = async (cmd: string[]) => {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", env: process.env });
  const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, out: o + e };
};

function db<T>(f: (d: Database) => T): T {
  const d = new Database(DB, { readonly: true });
  try {
    return f(d);
  } finally {
    d.close();
  }
}
const queuedFor = (roomId: string) =>
  db((d) =>
    (
      d
        .query(
          `select json_extract(payload_json,'$.target_member_id') m from hosted_room_driver_tasks
    where room_id = ? and status = 'queued'`
        )
        .all(roomId) as any[]
    ).map((r) => r.m as string)
  );
// réponses du moteur (tour d'un membre) : message.member, à la différence des résultats de table ronde « [bot] ... »
const said = (roomId: string, since: number) =>
  db((d) =>
    (
      d
        .query(
          `select json_extract(payload_json,'$.text') t from hosted_room_events
    where room_id = ? and kind = 'message.member' and created_at >= ? order by seq`
        )
        .all(roomId, since) as any[]
    ).map((r) => r.t as string)
  );
const posted = (roomId: string, bot: string, since: number) =>
  db((d) =>
    (
      d
        .query(
          `select json_extract(payload_json,'$.text') t from hosted_room_events
    where room_id = ? and kind = 'message.user' and created_at >= ? and json_extract(payload_json,'$.text') like ?`
        )
        .all(roomId, since, `[${bot}] %`) as any[]
    ).map((r) => r.t as string)
  );

// page.waitForFunction ne lit pas le résultat d'une promesse (import()) : une promesse est vraie, l'attente passait aussitôt.
async function waitUntil(page: Page, expr: string, timeout: number) {
  for (const end = Date.now() + timeout; Date.now() < end; await Bun.sleep(250)) if (await page.evaluate(expr).catch(() => false)) return;
  throw new Error("attente dépassée : " + expr.slice(0, 80));
}

async function rpc(page: Page, method: string, params: object, ms = 20000): Promise<any> {
  // `state` et `gparams` sont des const du script de la page : visibles par une expression évaluée, pas par globalThis
  return page.evaluate(
    `Promise.all([window.__compat('state'), window.__compat('groups')]).then(([s, g]) => s.state.roster.call(${JSON.stringify(method)}, g.gparams(${JSON.stringify(params)}), ${ms}))`
  );
}

/** Longueurs successives de la bulle en direct (curseur) qui contient `marker`, relevées dans la page toutes les 50 ms. */
const watchLive = (page: Page, marker: string) =>
  page.evaluate((mk) => {
    const w = window as any;
    w.__grow = [];
    clearInterval(w.__growT);
    w.__growT = setInterval(() => {
      const n = [...document.querySelectorAll("[data-testid=thread] .row.member [data-testid=bubble].cursor")]
        .map((b) => b.textContent || "")
        .filter((t) => t.includes(mk))
        .reduce((a, t) => Math.max(a, t.length), 0);
      if (n && w.__grow[w.__grow.length - 1] !== n) w.__grow.push(n);
    }, 50);
  }, marker);
const liveGrowth = (page: Page): Promise<number[]> =>
  page.evaluate(() => {
    const w = window as any;
    clearInterval(w.__growT);
    return w.__grow || [];
  });
async function oneLiveBubble(page: Page, marker: string, who: string) {
  await page
    .waitForFunction(
      (mk) =>
        [...document.querySelectorAll("[data-testid=thread] .row.member [data-testid=bubble]")].filter((b) => (b.textContent || "").includes(mk)).length ===
          1 && !document.querySelector("[data-testid=thread] .row.member [data-testid=bubble].cursor"),
      marker,
      { timeout: 15000 }
    )
    .catch(async () =>
      fail(
        `réponse de ${who} : bulle en direct en double ou curseur resté après le post (${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("[data-testid=thread] .row.member [data-testid=bubble]")].map((b) => b.className + " " + (b.textContent || "").slice(0, 30))))})`
      )
    );
}

async function ensureRoom(page: Page): Promise<string> {
  await page.evaluate("window.__compat('groups').then((g) => g.loadGroups())");
  const rooms: any[] = (await rpc(page, "groups.list", { limit: 200 })).rooms || [];
  // Un groupe NEUF à chaque passage. Réutiliser le groupe d'un passage précédent rendait le parcours instable (un passage sur deux, 2026-11-16) :
  // le meneur voit dans son fil ses anciens messages réécrits par le plugin (« @​travel-prep » neutralisés, « _En parallèle : ... »), les recopie
  // tels quels, et le plugin, ne trouvant plus de @ à traiter, ne lance rien. C'est un défaut du banc d'essai, pas du plugin.
  for (const old of rooms.filter((r) => r.name === ROOM_NAME && !r.disbanded_at)) {
    let d: any; // « work is still stopping » : le moteur finit d'arrêter le tour précédent, on réessaie
    for (const end = Date.now() + 90000; Date.now() < end; await sleep(2000)) {
      d = await rpc(page, "groups.disband", { room_id: old.room_id, cancel_id: crypto.randomUUID() }, 60000).catch((e) =>
        /still stopping/.test(String(e.message)) ? null : Promise.reject(e)
      );
      if (d?.tombstone) break;
    }
    if (!d?.tombstone) fail(`ancien groupe de test ${old.room_id.slice(0, 8)} non supprimé`);
  }
  const roomId = crypto.randomUUID();
  const members = (IMM || STEER || YAIA ? [LEAD, A] : [LEAD, A, B]).map((p) => ({
    member_id: p,
    profile: p,
    handle: p,
    target: { kind: "local", profile: p },
  }));
  await rpc(page, "groups.create", { room_id: roomId, name: ROOM_NAME, members }, 30000);
  await rpc(
    page,
    "groups.context",
    {
      room_id: roomId,
      event_id: crypto.randomUUID(),
      routing: "lead",
      lead_member_id: LEAD,
      purpose: "Groupe de test automatique de l'enchaînement des bots (test/group-journey.ts). Réponses courtes.",
      notes: "",
    },
    30000
  );
  await page.evaluate("window.__compat('groups').then((g) => g.loadGroups())");
  mark(`groupe de test créé (${roomId.slice(0, 8)})`);
  return roomId;
}

async function run() {
  const lastUser = (m: Msg[]) => {
    const u = m.filter((x) => x.role === "user").pop();
    return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content ?? "");
  };
  // immediate : horodatage de chaque appel du meneur (réponse immédiate ou tour de discussion) et de la fin de A
  const imm: { side: number[]; sideText: number; leadAfterA: number; aText: number } = { side: [], sideText: 0, leadAfterA: 0, aText: 0 };
  // ordre imposé par des portes (fichiers) que le parcours ouvre lui-même : aucune course de timing (release du 2026-11-17)
  const GATES = join(tmpdir(), `group-journey-imm-${process.pid}`),
    gateA = join(GATES, "a"),
    gateS = join(GATES, "side");
  if (IMM || STEER) mkdirSync(GATES, { recursive: true });
  // steer : le meneur attend sa porte dans un outil ; le recadrage arrive pendant ce temps
  const gateL = join(GATES, "lead"),
    gateC = join(GATES, "coulisse"),
    stTag = new Date().toISOString().slice(11, 19);
  const st: { steerSeen: number; firstAnswer: number; nextSeen: number; cancelledSeen: number; aSteered: number; aLead: number; relay: string } = {
    steerSeen: 0,
    firstAnswer: 0,
    nextSeen: 0,
    cancelledSeen: 0,
    aSteered: 0,
    aLead: 0,
    relay: "",
  };
  const room = { id: "" };
  const waitGate = (f: string) => `for i in $(seq 1 300); do [ -f ${f} ] && break; sleep 0.1; done`;
  const toolDone = (m: Msg[]) => m.slice(m.map((x) => x.role).lastIndexOf("user") + 1).some((x) => x.role === "tool");
  const fake = STEER
    ? startFakeModel(
        {
          [LEAD]: (m) => {
            const t = lastUser(m);
            // recadrage par le meneur : sa réponse immédiate appelle group_steer, puis il rend compte ; testé en premier, son prompt
            // reprend le fil récent, où « Demande suivante » figure encore
            if (t.includes(`Relaie ${stTag}`)) {
              if (toolDone(m)) {
                st.relay = JSON.stringify(m[m.length - 1].content ?? "");
                return { text: "relais-OK" };
              }
              return {
                tool: {
                  name: "tool_call",
                  args: { calls: [{ name: "group_steer", arguments: { room_id: room.id, bot: A, text: `Consigne meneur ${stTag}` } }] },
                },
                text: "relais-brut",
              };
            }
            if (t.includes(`Annulée ${stTag}`)) st.cancelledSeen = Date.now();
            if (t.includes(`Demande suivante ${stTag}`)) {
              st.nextSeen = Date.now();
              return { text: "suivante-OK" };
            }
            // le recadrage arrive comme un message de Yoan dans le tour en cours : réponse finale, sans relancer l'outil
            if (t.includes(`Change de cap ${stTag}`)) {
              st.steerSeen = Date.now();
              return { text: "recadré-OK" };
            }
            // le meneur n'a pas le terminal (ADR 0003) : le faux modèle retient son appel d'outil autorisé jusqu'à la porte
            if (t.includes(`Test recadrage ${stTag}`)) {
              if (toolDone(m)) st.firstAnswer = Date.now();
              return { tool: { name: "read_file", args: { path: "/etc/hostname" } }, hold: gateL, text: "premier-jet" };
            }
            return { text: "Reçu." };
          },
          // en coulisse (réponse immédiate) : le recadrage arrive dans son tour, comme pour le meneur
          [A]: (m) => {
            const t = lastUser(m);
            if (t.includes(`Ajuste ${stTag}`)) {
              st.aSteered = Date.now();
              return { text: "coulisse-recadrée" };
            }
            if (t.includes(`Consigne meneur ${stTag}`)) {
              st.aLead = Date.now();
              return { text: "coulisse-meneur-OK" };
            }
            if (t.includes(`Travail bis ${stTag}`)) return { tool: { name: "terminal", args: { command: waitGate(gateC + "2") } }, text: "bis-brut" };
            if (t.includes(`Travail coulisse ${stTag}`)) return { tool: { name: "terminal", args: { command: waitGate(gateC) } }, text: "coulisse-brut" };
            return { text: "Reçu." };
          },
        },
        FX.port
      )
    : IMM
      ? startFakeModel(
          {
            [LEAD]: (m) => {
              const t = lastUser(m);
              if (t.includes("Yoan t'écrit directement")) {
                // le meneur n'a pas le terminal (ADR 0003) : le faux modèle retient sa réponse jusqu'à la porte
                imm.side.push(Date.now());
                return { hold: gateS, text: "réponse-immédiate" };
              }
              if (t.includes("fini-A") && !imm.leadAfterA) imm.leadAfterA = Date.now();
              return { text: t.includes("Test réponse immédiate") && !t.includes("fini-A") ? `@${A} attends la porte puis réponds fini-A` : "Reçu." };
            },
            [A]: (m) => {
              if (toolDone(m)) imm.aText = Date.now();
              return { tool: { name: "terminal", args: { command: waitGate(gateA) } }, text: `@${LEAD} fini-A` };
            },
          },
          FX.port
        )
      : YAIA
        ? startFakeModel(
            {
              // le meneur répond au message de Yaia, et dit s'il a reçu la règle qui lui apprend qui parle (mention.YAIA_RULE)
              [LEAD]: (m) =>
                lastUser(m).includes("[yaia] Test canal Yaia")
                  ? { text: "yaia-vu " + (JSON.stringify(m).includes("vient de Yaia") ? "règle-ok" : "règle-absente") }
                  : { text: "Reçu." },
            },
            FX.port
          )
        : PART
          ? startFakeModel(
              {
                // le meneur recopie les deux lignes du message de test ; cité ensuite par les résultats des membres, il accuse réception
                [LEAD]: (m) => {
                  const t = lastUser(m);
                  const lines = t.split("\n").filter((l) => l.startsWith(A + " : ") || l.startsWith(B + " : "));
                  return {
                    text:
                      t.includes("Réponds uniquement par ces deux lignes") && lines.length === 2 && !t.includes(`[${A}]`) && !t.includes(`[${B}]`)
                        ? lines.join("\n")
                        : "Reçu.",
                  };
                },
                [A]: { tool: { name: "terminal", args: { command: `sleep ${FIL ? SLEEP_FIL : SLEEP}` } }, text: FIL ? "fini-A" : "391" },
                // FIL : la réponse finale de B s'écrit mot par mot (réponse en direct dans le groupe, 2026-11-18)
                [B]: {
                  tool: { name: "terminal", args: { command: `sleep ${FIL ? SLEEP_FIL : SLEEP}` } },
                  text: FIL ? FINI_B : PART === "parallel" ? MADRID : "Madrid",
                  ...(FIL || PART === "parallel" ? { streamMs: 180 } : {}),
                },
              },
              FX.port
            )
          : null;
  const session = await openTestSession(APP || undefined);
  const page = await session.ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(session.origin + PATH);
    await waitUntil(page, "window.__compat('state').then((m) => m.state).then((state) => state.roster?.ws?.readyState === 1)", 30000).catch(() =>
      fail("PWA non connectée au gateway : session de test expirée ? (" + page.url() + ")")
    );
    mark(`PWA chargée (${await page.evaluate("self.APP_VERSION")}, ${PATH})`);
    let roomId = await ensureRoom(page);
    room.id = roomId;
    const openRoom = async () => {
      await waitUntil(
        page,
        `window.__compat('state').then((m) => m.state).then((state) => (state.groups || []).some((r) => r.room_id === ${JSON.stringify(roomId)}))`,
        20000
      );
      await page.evaluate(`window.__compat('groups').then((g) => g.openGroup(${JSON.stringify(roomId)}))`);
      await waitUntil(
        page,
        `window.__compat('state').then((m) => m.state).then((state) => state.group?.room.room_id === ${JSON.stringify(roomId)} && !!state.group.context)`,
        20000
      );
    };
    await openRoom();

    // garde du défaut 1 : chaque « attend son tour » affiché doit correspondre à une tâche queued du moteur
    let watching = !FIL && !RESTART && !RELOAD && !IMM && !STEER && !YAIA,
      waitChecks = 0;
    const watcher = (async () => {
      while (watching) {
        const txt = (await page.textContent("[data-testid=group-bar] .grp-txt").catch(() => "")) || "";
        const visible = await page
          .locator("[data-testid=group-bar]")
          .isVisible()
          .catch(() => false);
        const m = visible && /(.+?) (?:attend son tour|attendent leur tour)/.exec(txt.split(" · ").slice(1).join(" · "));
        if (m) {
          waitChecks++;
          const q = queuedFor(roomId);
          const names = m[1].split(/, | et /).map((s) => s.trim());
          const members: any[] = await page.evaluate("window.__compat('state').then((s) => s.state.group.room.members)");
          for (const n of names) {
            const mem = members.find((x) => [x.display_name, x.handle, x.profile].includes(n));
            if (!mem || !q.includes(mem.member_id)) {
              watching = false;
              errors.push(`« ${n} attend son tour » affiché sans tâche queued du moteur (file : ${q.join(", ") || "vide"})`);
            }
          }
        }
        // le message envoyé groupe au repos est celui auquel le meneur répond : jamais « en attente » (vu le 2026-11-16)
        if (
          await page
            .locator("[data-testid=thread] .row.in-queue", { hasText: "Test automatique" })
            .count()
            .catch(() => 0)
        ) {
          watching = false;
          errors.push("message envoyé groupe au repos affiché « en attente » alors que le meneur y répond");
        }
        await sleep(700);
      }
    })();

    const t0 = Date.now() / 1000;
    if (YAIA) {
      // comme Yaia le fait : scripts/yaia.py, sur la maison du gateway de test (le plugin suit HOME/.hermes)
      const yaia = async (...args: string[]) => {
        const p = Bun.spawn([join(homedir(), ".hermes/hermes-agent/venv/bin/python"), join(BIN, "../scripts/yaia.py"), ...args], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, HOME: join(HERMES, "_home") },
        });
        const [o, e, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        if (code) fail(`yaia.py ${args[0]} : code ${code} ${(o + e).trim().slice(0, 200)}`);
        return o;
      };
      const say = `Test canal Yaia ${new Date().toISOString().slice(11, 19)}`;
      mark("yaia.py say : " + (await yaia("say", roomId, say)).trim().slice(0, 60));
      // la PWA l'affiche au nom de Yaia, pas comme un message de Yoan
      await page
        .locator("[data-testid=thread] .row.member", { hasText: say })
        .locator(".author", { hasText: "Yaia" })
        .waitFor({ timeout: 10000 })
        .catch(() => fail("PWA : le message de Yaia n'est pas affiché à son nom"));
      mark("PWA : message affiché au nom de Yaia");
      // le meneur se réveille, lit « [yaia] » avec la règle qui dit qui parle, et répond dans le groupe
      const reply = () => [...said(roomId, t0), ...posted(roomId, LEAD, t0)].find((x) => x.includes("yaia-vu")) || "";
      for (let i = 0; i < 60 && !reply(); i++) await sleep(500);
      if (!reply()) fail(`aucune réponse du meneur au message de Yaia en 30 s`);
      if (!reply().includes("règle-ok")) fail("le meneur a répondu sans la règle YAIA_RULE dans son tour : " + reply().slice(0, 80));
      mark(`${LEAD} répond à Yaia dans le groupe, règle YAIA_RULE reçue`);
      // Yaia lit cette réponse avec le même outil
      const log = await yaia("read", roomId);
      if (!log.includes("Yaia : " + say) || !log.includes("yaia-vu")) fail("yaia.py read ne montre pas l'échange : " + log.slice(-200));
      mark("yaia.py read : message de Yaia et réponse du meneur lus");
      return;
    }
    if (IMM) {
      const tag = new Date().toISOString().slice(11, 19);
      await page.fill("[data-testid=input]", `@${LEAD} Test réponse immédiate ${tag}`);
      await page.click("[data-testid=send]");
      // A en plein tour du moteur (pas une table ronde : un seul bot cité)
      const aRunning = async () =>
        (((await rpc(page, "groups.state", { room_id: roomId }).catch(() => ({}))).driver_status?.member_activity || []) as any[]).some(
          (x) => x.member_id === A && x.status === "running"
        );
      for (let i = 0; i < 60 && !(await aRunning()); i++) await sleep(250);
      if (!(await aRunning())) fail(`${A} n'a pas démarré son tour du moteur`);
      // la PWA doit le voir aussi (son état vient d'un sondage) : A au travail, le meneur libre
      await waitUntil(
        page,
        `window.__compat('state').then((s) => { const g = s.state.group, act = (g?.driver?.member_activity || []).map((a) => a.member_id); return g?.busy === true && act.includes(${JSON.stringify(A)}) && !act.includes(${JSON.stringify(LEAD)}); })`,
        10000
      );
      mark(`${A} écrit (tour du moteur), le groupe est occupé`);
      await page.fill("[data-testid=input]", `Question sans arobase ${tag}`);
      await page.click("[data-testid=send]");
      const q = page.locator("[data-testid=thread] .row.user [data-testid=bubble]", { hasText: `Question sans arobase ${tag}` }).last();
      await q.waitFor({ timeout: 10000 });
      let side: any = null;
      for (let i = 0; i < 40 && !side; i++) {
        side = ((await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId })).jobs || []).find((j: any) => j.kind === "side" && j.bot === LEAD);
        if (!side) await sleep(250);
      }
      if (!side) {
        const why = await page.evaluate(
          `Promise.all([window.__compat('state'), window.__compat('tasks')]).then(([s, t]) => JSON.stringify({ fast: (t.fastLaneMembers(s.state.group, 'x') || []).map((m) => m.handle), busy: s.state.group.busy, act: s.state.group.driver?.member_activity?.map((a) => a.member_id + ':' + a.status), ctx: s.state.group.context?.routing }))`
        );
        const probe = await rpc(page, "plugin.bot-groups.side.send", { room_id: roomId, text: "sonde", members: [LEAD], side_id: crypto.randomUUID() }).then(
          () => "accepté",
          (e) => "refus : " + e.message
        );
        fail("le message sans @ n'est pas parti en réponse immédiate du meneur (aucune tâche side pour " + LEAD + ") ; app " + why + " ; plugin " + probe);
      }
      if (await q.evaluate((b) => b.classList.contains("held"))) fail("le message au meneur libre est affiché « en attente »");
      mark(`message sans @ : réponse immédiate de ${LEAD} lancée (${side.status}), pas « en attente »`);
      // A finit pendant la réponse immédiate du meneur, qui le cite : le tour de discussion du meneur doit attendre
      for (let i = 0; i < 40 && !imm.side.length; i++) await sleep(250);
      writeFileSync(gateA, "");
      for (let i = 0; i < 40 && !imm.aText; i++) await sleep(250);
      if (!imm.aText) fail(`${A} n'a pas fini après l'ouverture de sa porte`);
      await sleep(2500);
      if (imm.leadAfterA) fail(`le tour de discussion de ${LEAD} a démarré pendant sa réponse immédiate`);
      mark(`${A} a fini et cite ${LEAD} : son tour de discussion attend sa réponse immédiate (2,5 s d'observation)`);
      writeFileSync(gateS, "");
      imm.sideText = Date.now();
      for (let i = 0; i < 60 && !(posted(roomId, LEAD, t0).some((x) => x.includes("réponse-immédiate")) && imm.leadAfterA); i++) await sleep(250);
      const rep = posted(roomId, LEAD, t0).find((x) => x.includes("réponse-immédiate")) || "";
      if (!rep) fail(`réponse immédiate de ${LEAD} absente du groupe`);
      if (rep.includes("@" + LEAD)) fail("la réponse immédiate du meneur le cite lui-même : " + rep.slice(-80));
      mark(`réponse immédiate postée sans se citer : « ${rep.slice(0, 40)} »`);
      // le meneur a déjà répondu : sa question et sa réponse n'ouvrent pas un tour de plus (il répondrait deux fois)
      const repAt = db(
        (d) =>
          (
            d
              .query(`select created_at c from hosted_room_events where room_id = ? and kind = 'message.user' and json_extract(payload_json,'$.text') like ?`)
              .get(roomId, `[${LEAD}] réponse-immédiate%`) as any
          )?.c || 0
      );
      await sleep(2000);
      const extra = db(
        (d) =>
          d
            .query(
              `select count(*) n from hosted_room_driver_tasks where room_id = ? and json_extract(payload_json,'$.target_member_id') = ? and created_at > ?`
            )
            .get(roomId, LEAD, repAt) as any
      ).n;
      if (extra) fail(`${LEAD} reprend ${extra} tour(s) après sa propre réponse immédiate`);
      mark(`aucun tour du meneur après sa réponse immédiate (2 s d'observation)`);
      if (!imm.aText || !imm.sideText || !imm.leadAfterA)
        fail(`chronologie incomplète (A fini : ${!!imm.aText}, réponse immédiate finie : ${!!imm.sideText}, tour du meneur après A : ${!!imm.leadAfterA})`);
      if (imm.leadAfterA < imm.sideText)
        fail(`le tour de discussion du meneur a démarré ${((imm.sideText - imm.leadAfterA) / 1000).toFixed(1)} s avant la fin de sa réponse immédiate`);
      mark(
        `tour de discussion du meneur lancé ${((imm.leadAfterA - imm.sideText) / 1000).toFixed(1)} s après la fin de sa réponse immédiate (${A} avait fini ${((imm.sideText - imm.aText) / 1000).toFixed(1)} s avant)`
      );
    }
    if (STEER) {
      await page.fill("[data-testid=input]", `@${LEAD} Test recadrage ${stTag}`);
      await page.click("[data-testid=send]");
      const leadRunning = async () =>
        (((await rpc(page, "groups.state", { room_id: roomId }).catch(() => ({}))).driver_status?.member_activity || []) as any[]).some(
          (x) => x.member_id === LEAD && x.status === "running"
        );
      for (let i = 0; i < 80 && !((await leadRunning()) && fake!.calls.some((c) => c.id === LEAD && c.kind === "tool")); i++) await sleep(250);
      if (!fake!.calls.some((c) => c.id === LEAD && c.kind === "tool")) fail(`${LEAD} n'est pas entré dans son outil`);
      await waitUntil(page, `window.__compat('state').then((s) => s.state.group?.busy === true)`, 10000);
      mark(`${LEAD} tient son tour du moteur, bloqué dans un outil`);
      // deux demandes suivantes, la seconde annulée : son texte revient dans la zone de saisie
      await page.fill("[data-testid=input]", `/q Demande suivante ${stTag}`);
      await page.click("[data-testid=send]");
      await page.fill("[data-testid=input]", `/q Annulée ${stTag}`);
      await page.click("[data-testid=send]");
      const nextB = page.locator("[data-testid=thread] .row.user", { hasText: `Demande suivante ${stTag}` }).last();
      const cancelRow = page.locator("[data-testid=thread] .row.user", { hasText: `Annulée ${stTag}` }).last();
      await cancelRow.locator(".next-cancel").waitFor({ timeout: 10000 });
      if (
        !(await nextB.evaluate((r) => r.classList.contains("in-queue") && /demande suivante/.test(r.querySelector(".bubble")?.getAttribute("data-wait") || "")))
      )
        fail(
          "la demande suivante n'est pas affichée comme telle : " +
            (await nextB.evaluate((r) => r.className + " / " + r.querySelector(".bubble")?.getAttribute("data-wait")))
        );
      await cancelRow.locator(".next-cancel").click();
      await cancelRow.waitFor({ state: "detached", timeout: 10000 });
      if ((await page.inputValue("[data-testid=input]")).trim() !== `Annulée ${stTag}`)
        fail(`texte annulé non rendu à la zone de saisie : « ${await page.inputValue("[data-testid=input]")} »`);
      await page.fill("[data-testid=input]", "");
      const heldNow = ((await rpc(page, "plugin.bot-groups.inbox.status", { room_id: roomId })).held || []) as any[];
      if (heldNow.length !== 1 || heldNow[0].kind !== "next" || !heldNow[0].text.includes("Demande suivante"))
        fail("après annulation, le plugin garde : " + JSON.stringify(heldNow));
      mark("deux /q gardés en demande suivante, l'un annulé : texte rendu, le plugin n'en garde plus qu'un");
      // le recadrage : Entrée pendant son tour, sans @
      await page.fill("[data-testid=input]", `Change de cap ${stTag}`);
      await page.click("[data-testid=send]");
      const sb = page.locator("[data-testid=thread] .row.user [data-testid=bubble]", { hasText: `Change de cap ${stTag}` }).last();
      await page
        .waitForFunction(
          (t) =>
            [...document.querySelectorAll("[data-testid=thread] .row.user [data-testid=bubble]")].some(
              (b) => b.textContent?.includes(t) && b.classList.contains("steered")
            ),
          `Change de cap ${stTag}`,
          { timeout: 10000 }
        )
        .catch(async () => {
          const j = join(HERMES, "data", "bot-groups", "actions.jsonl");
          const last = existsSync(j)
            ? readFileSync(j, "utf8")
                .trim()
                .split("\n")
                .filter((l) => l.includes('"steer_send"'))
                .pop()
            : "";
          fail("bulle de recadrage non marquée : " + (await sb.evaluate((b) => b.className)) + " ; plugin : " + last);
        });
      const side = ((await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId })).jobs || []).filter((j: any) => j.kind === "side");
      if (side.length) fail("le recadrage a lancé une réponse à part : " + JSON.stringify(side));
      mark(
        `message sans @ pendant le tour de ${LEAD} : recadrage (bulle « ${await sb.evaluate((b) => getComputedStyle(b, "::after").content)} »), aucune réponse à part`
      );
      // un bot en coulisse : @A libre part en réponse immédiate ; un second @A pendant son outil le recadre dans ce tour
      await page.fill("[data-testid=input]", `@${A} Travail coulisse ${stTag}`);
      await page.click("[data-testid=send]");
      for (let i = 0; i < 80 && !fake!.calls.some((c) => c.id === A && c.kind === "tool"); i++) await sleep(250);
      if (!fake!.calls.some((c) => c.id === A && c.kind === "tool")) fail(`${A} n'a pas démarré sa réponse immédiate en coulisse`);
      await page.fill("[data-testid=input]", `@${A} Ajuste ${stTag}`);
      await page.click("[data-testid=send]");
      await page
        .waitForFunction(
          (t) =>
            [...document.querySelectorAll("[data-testid=thread] .row.user [data-testid=bubble]")].some(
              (b) => b.textContent?.includes(t) && b.classList.contains("steered")
            ),
          `Ajuste ${stTag}`,
          { timeout: 10000 }
        )
        .catch(() => fail(`le second @${A} n'a pas recadré sa tâche en coulisse`));
      for (let i = 0; i < 120 && !st.aSteered; i++) await sleep(250);
      if (!st.aSteered) fail(`${A} n'a pas lu le recadrage dans sa tâche en coulisse`);
      mark(`${A} en coulisse recadré dans son tour, sans relance`);
      writeFileSync(gateL, "");
      for (let i = 0; i < 60 && !said(roomId, t0).some((x) => x.includes("recadré-OK") || x.includes("premier-jet")); i++) await sleep(250);
      const first = said(roomId, t0);
      if (!st.steerSeen || !first.some((x) => x.includes("recadré-OK")))
        fail(`${LEAD} n'a pas lu le recadrage dans son tour (vu : ${!!st.steerSeen}, réponses : ${JSON.stringify(first).slice(0, 160)})`);
      if (first.some((x) => x.includes("premier-jet"))) fail(`${LEAD} a fini sa première réponse sans tenir compte du recadrage`);
      mark(`${LEAD} a lu le recadrage dans le même tour et répond « recadré-OK »`);
      for (let i = 0; i < 60 && !said(roomId, t0).some((x) => x.includes("suivante-OK")); i++) await sleep(250);
      const answers = said(roomId, t0).filter((x) => x.includes("suivante-OK")).length;
      if (answers !== 1) fail(`la demande suivante a reçu ${answers} réponse(s) du meneur au lieu d'une`);
      if (!st.nextSeen) fail("la demande suivante n'est jamais partie après la discussion");
      const aOut = posted(roomId, A, t0);
      if (!aOut.some((x) => x.includes("coulisse-recadrée")) || aOut.some((x) => x.includes("coulisse-brut")))
        fail(`résultat en coulisse de ${A} : ${JSON.stringify(aOut).slice(0, 200)}`);
      const aAt = db(
        (d) =>
          (
            d
              .query(`select created_at c from hosted_room_events where room_id = ? and kind = 'message.user' and json_extract(payload_json,'$.text') like ?`)
              .get(roomId, `[${A}] coulisse-recadrée%`) as any
          )?.c || 0
      );
      const nAt = db(
        (d) =>
          (
            d
              .query(`select created_at c from hosted_room_events where room_id = ? and kind = 'message.user' and json_extract(payload_json,'$.text') like ?`)
              .get(roomId, `Demande suivante ${stTag}%`) as any
          )?.c || 0
      );
      if (!aAt || nAt < aAt) fail("la demande suivante est partie avant le résultat de la tâche en coulisse");
      if (st.nextSeen < st.steerSeen) fail("la demande suivante est partie avant la fin de la discussion");
      if (st.cancelledSeen) fail("la demande annulée a été envoyée au meneur");
      const users = db((d) =>
        (
          d
            .query(
              `select json_extract(payload_json,'$.text') t from hosted_room_events where room_id = ? and kind = 'message.user' and created_at >= ? order by seq`
            )
            .all(roomId, t0) as any[]
        ).map((r) => r.t as string)
      );
      const iSteer = users.findIndex((x) => x.includes("Change de cap")),
        iNext = users.findIndex((x) => x.includes("Demande suivante"));
      if (iSteer < 0) fail("le recadrage n'est pas entré dans le fil du groupe");
      if (iNext < iSteer) fail("ordre du fil : demande suivante avant le recadrage");
      if (users.some((x) => x.includes(`Annulée ${stTag}`))) fail("la demande annulée est entrée dans le groupe");
      mark(
        `demande suivante partie seule après la discussion (${((st.nextSeen - st.steerSeen) / 1000).toFixed(1)} s après le recadrage), réponse « suivante-OK »`
      );
      // recadrage par le meneur (GLOSSARY.md « Recadrage », 2026-11-17)
      const nTool = fake!.calls.filter((c) => c.id === A && c.kind === "tool").length;
      await page.fill("[data-testid=input]", `@${A} Travail bis ${stTag}`);
      await page.click("[data-testid=send]");
      for (let i = 0; i < 80 && fake!.calls.filter((c) => c.id === A && c.kind === "tool").length <= nTool; i++) await sleep(250);
      if (fake!.calls.filter((c) => c.id === A && c.kind === "tool").length <= nTool) fail(`${A} n'a pas démarré sa seconde tâche en coulisse`);
      await page.fill("[data-testid=input]", `Relaie ${stTag}`);
      await page.click("[data-testid=send]");
      // A travaille en coulisse ou dans un tour du moteur (selon que le groupe est occupé) : sa réponse est l'un ou l'autre
      const aBisOut = () => [...posted(roomId, A, t0), ...said(roomId, t0)];
      for (let i = 0; i < 120 && !(st.aLead && aBisOut().some((x) => x.includes("coulisse-meneur-OK"))); i++) await sleep(250);
      writeFileSync(gateC + "2", "");
      if (!st.aLead) fail(`${A} n'a pas reçu le recadrage du meneur dans son tour (réponse de group_steer : ${st.relay.slice(0, 200)})`);
      const aBis = aBisOut();
      if (!aBis.some((x) => x.includes("coulisse-meneur-OK")) || aBis.some((x) => x.includes("bis-brut")))
        fail(`résultat de ${A} après le recadrage du meneur : ${JSON.stringify(aBis).slice(0, 200)}`);
      // le plugin poste ce recadrage par sa boîte d'envoi (inbox.submit), après coup : il peut suivre la réponse de A (2026-11-18)
      const signed = () => posted(roomId, LEAD, t0).some((x) => x.includes(`Recadrage pour ${A} : Consigne meneur ${stTag}`));
      for (let i = 0; i < 20 && !signed(); i++) await sleep(250);
      if (!signed()) fail("le recadrage du meneur n'apparaît pas dans le fil, signé de lui");
      mark(`${LEAD} a recadré ${A} pendant son tour avec group_steer : ${A} répond « coulisse-meneur-OK », le fil montre le recadrage`);
    }
    if (!FIL && !IMM && !STEER) {
      // @meneur : sans mention, le meneur répartit par {"assign": [...]} au lieu d'écrire, et le cas « nomme deux bots
      // sans @ » n'est pas joué (premier passage du 2026-11-16)
      const msg =
        `@${LEAD} Test automatique ${new Date().toISOString().slice(11, 19)}. Réponds uniquement par ces deux lignes, recopiées telles quelles, sans @ et sans rien ajouter :\n` +
        `${A} : lance la commande \`sleep ${SLEEP}\` dans ton terminal et attends qu'elle finisse, puis réponds seulement par le résultat de 17 × 23 (le nombre seul).\n` +
        `${B} : lance la commande \`sleep ${SLEEP}\` dans ton terminal et attends qu'elle finisse, puis réponds seulement « Madrid ».`;
      {
        if (PART === "parallel") await watchLive(page, "Madrid,");
        await page.fill("[data-testid=input]", msg);
        await page.click("[data-testid=send]");
        await page.locator("[data-testid=thread] [data-testid=bubble]", { hasText: "Test automatique" }).last().waitFor({ timeout: 15000 });
        mark(`message envoyé au meneur ${LEAD}`);
      }

      if (!RESTART && !RELOAD) {
        // 1. les deux en parallèle, vus par le plugin et par la barre
        let both = false,
          barBoth = false;
        for (let i = 0; i < 360 && !(both && barBoth); i++) {
          // au travail = tâche parallèle en cours (plugin) ou tour du moteur en cours (member_activity running)
          const jobs: any[] = ((await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId }).catch(() => ({}))).jobs || []).filter(
            (j: any) => j.status === "running"
          );
          const st = await rpc(page, "groups.state", { room_id: roomId }).catch(() => ({}));
          const busy = new Set([
            ...jobs.map((j) => j.bot),
            ...((st.driver_status?.member_activity || []) as any[]).filter((a) => a.status === "running").map((a) => a.member_id),
          ]);
          if (busy.has(A) && busy.has(B)) both = true;
          const txt = (await page.textContent("[data-testid=group-bar] .grp-txt").catch(() => "")) || "";
          if (txt.includes(A) && txt.includes(B) && /parallèle/.test(txt)) barBoth = true;
          if (errors.length) break;
          await sleep(500);
        }
        if (errors.length) fail("erreur pendant l'attente du parallèle : " + errors.slice(0, 3).join(" | "));
        if (!both) fail(`${A} et ${B} n'ont jamais tourné en même temps (dispatch.status + moteur)`);
        mark(`${A} et ${B} au travail en même temps (dispatch.status + moteur)`);
        if (!barBoth)
          fail(`la barre n'a jamais affiché ${A} et ${B} en parallèle (dernier texte : ${await page.textContent("[data-testid=group-bar] .grp-txt")})`);
        mark("la barre affiche les deux noms en parallèle");

        // 2. la mention du meneur reste visible (neutralisée), pas retirée
        // lu jusqu'à 10 s : quatre parties en même temps, le message du meneur peut être publié après le départ des bots
        const leadMsg = () =>
          db(
            (d) =>
              d
                .query(
                  `select json_extract(payload_json,'$.text') t from hosted_room_events where room_id = ? and kind = 'message.member'
        and json_extract(actor_json,'$.id') = ? and created_at >= ? order by seq desc limit 1`
                )
                .get(roomId, LEAD, t0) as any
          )?.t || "";
        let lead = leadMsg();
        for (let i = 0; i < 40 && !lead; i++) {
          await sleep(250);
          lead = leadMsg();
        }
        if (!lead.includes("@​" + A) || !lead.includes("@​" + B)) fail("message du meneur sans @ visible devant les bots : " + lead.slice(0, 200));
        mark("message du meneur : @ ajoutés puis neutralisés, visibles");
      }
      // 3. redémarrage du gateway pendant les tâches des deux bots
      if (RESTART) {
        // le redémarrage ne doit tomber qu'une fois les DEUX bots en plein tour (outil en cours, trace.list) : un tour qui démarre pendant le drain échoue (« Gateway draining : not_ready »)
        const tracing = async (m: string) =>
          ((await rpc(page, "plugin.bot-groups.trace.list", { room_id: roomId }).catch(() => ({}))).traces || []).some(
            (x: any) => x.status === "running" && x.member_id === m && x.started >= t0 - 5
          );
        // avec le faux modèle, prêt = les deux bots ont reçu leur outil (sleep en cours) ; une trace « running » apparaît avant le premier appel au modèle
        const inTool = (m: string) => !!fake?.calls.some((c) => c.id === m && c.kind === "tool");
        for (let i = 0; i < 150 && !(fake ? inTool(A) && inTool(B) : (await tracing(A)) && (await tracing(B))); i++) await sleep(200);
        const jobs: any[] = (await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId })).jobs || [];
        if (!jobs.some((j) => j.bot === B && j.status === "running")) fail(`${B} a fini avant le redémarrage : scénario non joué`);
        if (fake && !(inTool(A) && inTool(B)))
          fail(`${A} et ${B} n'ont pas lancé leur outil : scénario non joué (${fake.calls.map((c) => c.id + ":" + c.kind).join(", ")})`);
        const r = await sh(["env", "HERMES_TEST_DRAIN_S=25", "bun", join(BIN, "test-gateway.ts"), "restart"]); // drain : durée de la tâche (15 s) + marge // le gateway de TEST, jamais celui de la prod
        if (r.code !== 0) fail("redémarrage du gateway de test en échec : " + r.out.slice(-200));
        mark(`gateway de test redémarré pendant la tâche de ${B}`);
        const chk = await sh(["bun", join(BIN, "test-gateway.ts"), "status"]);
        console.log(
          chk.out
            .trim()
            .split("\n")
            .map((l) => "      " + l)
            .join("\n")
        );
        if (chk.code !== 0) fail("le gateway de test ne répond pas après le redémarrage");
        mark("test-gateway status : sain");
      }

      // 3 bis. rechargement à chaud du plugin pendant les tâches des deux bots (Yoan, 2026-11-18 : releases sans redémarrage)
      if (RELOAD) {
        const inTool = (m: string) => !!fake?.calls.some((c) => c.id === m && c.kind === "tool");
        for (let i = 0; i < 150 && !(inTool(A) && inTool(B)); i++) await sleep(200);
        const jobs: any[] = (await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId })).jobs || [];
        if (!jobs.some((j) => j.bot === B && j.status === "running")) fail(`${B} a fini avant le rechargement : scénario non joué`);
        const h0 = await rpc(page, "plugin.bot-groups.health", {});
        // nouveau code : un fichier de plus dans le plugin change son empreinte ; le rechargement doit la prendre
        const probe = join(import.meta.dir, "..", "plugins", "bot-groups", "_reload_probe.py");
        writeFileSync(probe, `# sonde du parcours reload (${new Date().toISOString()}), supprimée à la fin\n`);
        let r: any;
        try {
          // disque changé, code pas encore rechargé : health doit dire l'ancien code (2026-11-18 : il relisait le disque, la release a cru la prod à jour)
          const hd = await rpc(page, "plugin.bot-groups.health", {});
          if (hd.code !== h0.code || hd.disk === hd.code)
            fail(`health annonce le disque comme code chargé (code ${hd.code}, disque ${hd.disk}, avant ${h0.code})`);
          r = await rpc(page, "plugin.bot-groups.reload", {}, 30000);
        } finally {
          rmSync(probe, { force: true });
        }
        if (!r?.ok || !r.copies) fail(`rechargement en échec : ${JSON.stringify(r).slice(0, 300)}`);
        if (r.after === h0.code) fail(`le rechargement n'a pas pris le nouveau code (empreinte inchangée ${h0.code})`);
        mark(`plugin rechargé à chaud pendant la tâche de ${B} : ${r.copies} copie(s), ${r.ms} ms, code ${h0.code} -> ${r.after}`);
        // une seule boucle de chaque sorte, de la nouvelle génération ; les anciennes se sont arrêtées
        let h: any = {};
        for (let i = 0; i < 30; i++) {
          h = await rpc(page, "plugin.bot-groups.health", {});
          if (h.threads["bot-groups-resume"] === 1 && h.threads["bot-groups-trace-sweeper"] === 1) break;
          await sleep(250);
        }
        if (h.threads["bot-groups-resume"] !== 1 || h.threads["bot-groups-trace-sweeper"] !== 1)
          fail(`boucles de fond après rechargement : ${JSON.stringify(h.threads)} (attendu une de chaque)`);
        if (!(h.gen > h0.gen)) fail(`génération inchangée après rechargement : ${h0.gen} -> ${h.gen}`);
        mark(`boucles de fond : une de chaque après rechargement (${JSON.stringify(h.threads)}), génération ${h0.gen} -> ${h.gen}`);
      }

      // 4. les deux résultats arrivent dans le groupe
      for (let i = 0; i < 120; i++) {
        if (posted(roomId, A, t0).length && posted(roomId, B, t0).length) break;
        await sleep(1000);
      }
      const ra = posted(roomId, A, t0)[0] || "",
        rb = posted(roomId, B, t0)[0] || "";
      if (!ra.includes("391")) fail(`résultat de ${A} absent ou faux : ${ra.slice(0, 120) || "(aucun)"}`);
      if (!/madrid/i.test(rb)) fail(`résultat de ${B} absent ou faux : ${rb.slice(0, 120) || "(aucun)"}`);
      mark(`résultats postés : ${A} « 391 », ${B} « Madrid »${RESTART ? " (après redémarrage)" : RELOAD ? " (après rechargement du plugin)" : ""}`);

      // 5. la PWA les affiche sous le nom des bots
      if (RESTART) {
        await page.reload();
        await waitUntil(page, "window.__compat('state').then((s) => s.state.roster?.ws?.readyState === 1)", 60000);
        await page.evaluate("window.__compat('groups').then((g) => g.loadGroups())");
        await waitUntil(
          page,
          `window.__compat('state').then((m) => m.state).then((state) => (state.groups || []).some((r) => r.room_id === ${JSON.stringify(roomId)}))`,
          20000
        );
        await page.evaluate(`window.__compat('groups').then((g) => g.openGroup(${JSON.stringify(roomId)}))`);
      }
      await page
        .locator("[data-testid=thread] .row.member [data-testid=bubble]", { hasText: "391" })
        .last()
        .waitFor({ timeout: 30000 })
        .catch(() => fail(`bulle de ${A} absente dans la PWA`));
      await page
        .locator("[data-testid=thread] .row.member [data-testid=bubble]", { hasText: /Madrid/i })
        .last()
        .waitFor({ timeout: 30000 })
        .catch(() => fail(`bulle de ${B} absente dans la PWA`));
      mark("bulles des deux bots affichées dans la PWA");
      if (PART === "parallel") {
        // tour du moteur : texte relevé par les hooks on_stream_* du plugin
        const grow = await liveGrowth(page);
        if (grow.length < 3)
          fail(`réponse de ${B} : pas écrite en direct dans le groupe (tour du moteur ; longueurs vues avec curseur : ${JSON.stringify(grow)})`);
        await oneLiveBubble(page, "Madrid,", B);
        mark(
          `réponse de ${B} écrite en direct (tour du moteur) : ${grow.length} états, ${grow[0]} -> ${grow[grow.length - 1]} signes ; une seule bulle après le post`
        );
      }

      // 6. aucun tour du moteur en échec laissé sans relance
      await sleep(1000);
      const failed = db(
        (d) => d.query(`select task_id, result_json r from hosted_room_driver_tasks where status = 'failed' and updated_at >= ?`).all(t0) as any[]
      );
      const relaunched: string[] = existsSync(join(HERMES, "data/bot-groups/relaunched.json"))
        ? JSON.parse(readFileSync(join(HERMES, "data/bot-groups/relaunched.json"), "utf8"))
        : [];
      const orphan = failed.filter((f) => !relaunched.includes(f.task_id));
      if (orphan.length)
        fail(`tours du moteur en échec sans relance : ${orphan.map((f) => f.task_id.slice(0, 14) + " " + String(f.r).slice(0, 60)).join(" ; ")}`);
      mark(`aucun tour en échec sans relance (${failed.length} en échec, tous relancés)`);
    } // fin de la partie parallel / restart

    // 7. fil de travail : ouvrir celui d'un bot en direct, l'arrêter seul pendant que l'autre continue, rouvrir un fil après coup
    if (FIL) {
      const t1 = Date.now() / 1000,
        tag = new Date().toISOString().slice(11, 19);
      const msg2 =
        `@${LEAD} Test du fil de travail ${tag}. Réponds uniquement par ces deux lignes, recopiées telles quelles, sans @ et sans rien ajouter :\n` +
        `${A} : lance la commande \`sleep ${SLEEP_FIL}\` dans ton terminal et attends qu'elle finisse, puis réponds seulement « fini-A ».\n` +
        `${B} : lance la commande \`sleep ${SLEEP_FIL}\` dans ton terminal et attends qu'elle finisse, puis réponds seulement « fini-B ».`;
      await watchLive(page, "fini-B,");
      await page.fill("[data-testid=input]", msg2);
      await page.click("[data-testid=send]");
      await page.locator("[data-testid=thread] [data-testid=bubble]", { hasText: "Test du fil de travail" }).last().waitFor({ timeout: 15000 });
      const runningTraces = async (member: string) =>
        ((await rpc(page, "plugin.bot-groups.trace.list", { room_id: roomId })).traces as any[]).filter(
          (x) => x.status === "running" && x.member_id === member && x.started >= t1 - 5
        );
      for (let i = 0; i < 120 && !((await runningTraces(A)).length && (await runningTraces(B)).length); i++) await sleep(1000);
      if (!(await runningTraces(A)).length || !(await runningTraces(B)).length)
        fail(
          `fil de travail : ${A} et ${B} n'ont pas chacun un fil en cours (trace.list : ${JSON.stringify(((await rpc(page, "plugin.bot-groups.trace.list", { room_id: roomId })).traces as any[]).map((x) => [x.member_id, x.status, Math.round(x.started - t1)]))}, jobs : ${JSON.stringify(((await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId })).jobs || []).map((j: any) => [j.bot, j.status]))})`
        );
      mark(`trace.list : un fil en cours pour ${A} et pour ${B}`);
      // parité avec la conversation seule (2026-11-18) : l'outil en cours de chaque bot s'affiche dans le fil du groupe, au nom du bot
      await page
        .waitForFunction(
          (s) =>
            [...document.querySelectorAll("[data-testid=thread] [data-testid=member-actions] .act-line.run")].filter((e) => (e.textContent || "").includes(s))
              .length >= 2,
          `sleep ${SLEEP_FIL}`,
          { timeout: 30000 }
        )
        .catch(() => fail(`fil du groupe : « sleep ${SLEEP_FIL} » en cours n'apparaît pas pour ${A} et ${B}`));
      mark(`fil du groupe : « sleep ${SLEEP_FIL} » en cours affiché pour ${A} et ${B}, comme en conversation seule`);
      // plus de panneau « Voir le fil » (Yoan, 2026-11-18) : l'arrêt d'un seul bot se fait depuis son bloc d'actions en direct
      const aStop = page.locator(`[data-testid=thread] [data-testid=stop-bot][data-member="${A}"]`);
      await aStop
        .last()
        .waitFor({ state: "attached", timeout: 10000 })
        .catch(() => fail(`bouton « Arrêter » de ${A} absent de son bloc d'actions`));
      await aStop.last().click();
      for (let i = 0; i < 60 && (await runningTraces(A)).length; i++) await sleep(500);
      if ((await runningTraces(A)).length) fail(`le fil de ${A} tourne encore après « Arrêter »`);
      const jobsAfter: any[] = (await rpc(page, "plugin.bot-groups.dispatch.status", { room_id: roomId })).jobs || [];
      const aRunning = jobsAfter.some((j) => j.bot === A && j.status === "running");
      const st = await rpc(page, "groups.state", { room_id: roomId });
      const aEngine = ((st.driver_status?.member_activity || []) as any[]).some(
        (x) => x.member_id === A && ["running", "queued", "stopping"].includes(x.status)
      );
      if (aRunning && aEngine) fail(`${A} travaille encore après « Arrêter ce bot »`);
      if (!(await runningTraces(B)).length) fail(`${B} s'est arrêté avec ${A} : « Arrêter ce bot » doit épargner les autres`);
      mark(
        `${A} arrêté seul (dispatch.status : ${aRunning ? "tâche encore listée" : "plus de tâche"} ; moteur : ${aEngine ? "encore actif" : "inactif"}), ${B} continue`
      );
      // réponse finale de B en direct, comme en conversation seule : sa bulle s'est écrite (curseur, texte qui grandit), puis
      // laisse la place au message posté, une seule fois
      for (let i = 0; i < 90 && !posted(roomId, B, t1).some((x) => /fini-B/i.test(x)); i++) await sleep(1000);
      const grow = await liveGrowth(page);
      const kindB =
        ((await rpc(page, "plugin.bot-groups.trace.list", { room_id: roomId })).traces as any[]).find((x) => x.member_id === B && x.started >= t1 - 5)?.kind ||
        "?";
      if (grow.length < 3) fail(`réponse de ${B} : pas écrite en direct dans le groupe (longueurs vues avec curseur : ${JSON.stringify(grow)}, fil ${kindB})`);
      mark(`réponse de ${B} écrite en direct dans le groupe (fil ${kindB}) : ${grow.length} états, ${grow[0]} -> ${grow[grow.length - 1]} signes`);
      if (!posted(roomId, B, t1).some((x) => /fini-B/i.test(x))) fail(`${B} n'a pas posté « fini-B » après l'arrêt de ${A}`);
      if (posted(roomId, A, t1).some((x) => /pas pu finir/i.test(x))) fail(`${A} a posté un échec après son arrêt volontaire`);
      mark(`${B} a posté « fini-B » ; aucun post d'échec de ${A}`);
      await oneLiveBubble(page, "fini-B,", B);
      mark(`réponse de ${B} : une seule bulle après le post, curseur retiré`);
      // après coup (page rechargée) : la ligne d'action de B, « sleep » fini, au-dessus de sa réponse, comme en conversation seule
      await page.reload();
      await waitUntil(page, "window.__compat('state').then((s) => s.state.roster?.ws?.readyState === 1)", 60000);
      await page.evaluate(`window.__compat('groups').then((g) => g.openGroup(${JSON.stringify(roomId)}))`);
      const bRow = page.locator("[data-testid=thread] .row", { has: page.locator("[data-testid=bubble]", { hasText: /fini-B/i }) }).last();
      const done = bRow.locator(".act-line:not(.run)", { hasText: `sleep ${SLEEP_FIL}` });
      await done
        .waitFor({ state: "attached", timeout: 30000 })
        .catch(() => fail(`après rechargement : la ligne d'action « sleep ${SLEEP_FIL} » finie est absente au-dessus de « fini-B »`));
      mark(`${B} après rechargement : « ${((await done.locator("summary").first().textContent()) || "").trim()} » au-dessus de sa réponse`);
    }
    watching = false;
    await watcher;
    if (errors.length) fail(errors.slice(0, 2).join(" | "));
    // groupe au repos avant d'arrêter le faux modèle : un résultat arrivé tard (machine chargée) lance encore un tour ; coupé
    // de son modèle, ce tour bloquait le drain de la partie restart (release du 2026-11-17)
    const live = () =>
      db((d) => (d.query(`select count(*) n from hosted_room_driver_tasks where room_id = ? and status in ('queued','running')`).get(roomId) as any).n);
    for (let i = 0; i < 40 && live(); i++) await sleep(250);
    if (live()) fail("le groupe a encore un tour en cours 10 s après la fin du parcours");
    mark(`aucun « attend son tour » sans file réelle (${waitChecks} affichage(s) contrôlé(s)), aucune erreur JavaScript`);
  } finally {
    const tf = Date.now();
    await page.close();
    const tp = Date.now();
    await session.close();
    const ts = Date.now();
    if (Date.now() - tf > 3000) console.log(`      rangement lent : page ${tp - tf} ms, session ${ts - tp} ms`);
    if (fake) {
      console.log(`      faux modèle : ${fake.calls.length} appels (${fake.calls.map((c) => `${c.id}:${c.kind}(${JSON.stringify(c.said)})`).join(", ")})`);
    }
    if (IMM || STEER) {
      // ouvrir toutes les portes avant de les effacer : un outil encore en attente (boucle de 30 s) finissait sinon après la partie
      // et faisait déborder le drain de la suivante, puis le gateway restait en 503 (2026-11-18)
      for (const g of [gateA, gateS, gateL, gateC, gateC + "2"])
        try {
          writeFileSync(g, "");
        } catch {}
    }
    // le faux modèle se ferme APRÈS l'ouverture des portes : fermé avant, l'outil libéré ensuite rappelait un serveur mort pendant
    // 1 à 2 min et retardait le drain du redémarrage suivant au-delà de 25 s (2026-11-18)
    if (fake) {
      const live = () => {
        try {
          return !!db(
            (d) => (d.query(`select count(*) n from hosted_room_driver_tasks where room_id = ? and status in ('queued','running')`).get(room.id) as any).n
          );
        } catch {
          return false;
        }
      };
      const ms = await fake.settle(live, IMM || STEER ? 10000 : 3000); // portes : un outil libéré rappelle le modèle jusqu'à ~5 s après (fv-a, steer, 2026-11-18)
      if (ms > 15000) console.log(`      faux modèle fermé après ${(ms / 1000).toFixed(1)} s d'attente (tours restants du groupe)`);
    }
    if (IMM || STEER) rmSync(GATES, { recursive: true, force: true });
  }
}
let t = Date.now();
async function orchestrate() {
  const pass = process.argv.slice(2).filter((a, i, all) => !["--no-restart", "--no-fil", "--part"].includes(a) && all[i - 1] !== "--part");
  const one = async (part: string) => {
    const p = Bun.spawn(["bun", import.meta.path, ...pass, "--part", part], { stdout: "pipe", stderr: "pipe", env: process.env });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { part, out, err, code };
  };
  // « steer » se joue à part (--part steer, sa propre étape de release) : ajouté ici, le parcours passait les 60 s (60,6 s, 2026-11-17)
  const res: Awaited<ReturnType<typeof one>>[] = [];
  for (const part of ["parallel", ...(NO_FIL ? [] : ["fil"]), "immediate", "yaia", "reload", ...(NO_RESTART ? [] : ["restart"])]) {
    const r = await one(part);
    res.push(r);
    if (r.code !== 0) break;
  }
  for (const r of res) {
    console.log(`-- parcours ${r.part} : code ${r.code}`);
    console.log(r.out.trimEnd());
    if (r.err.trim()) console.error(r.err.trimEnd());
  }
  const bad = res.find((r) => r.code !== 0);
  if (bad) fail("parcours " + bad.part + " : " + (bad.err.split("\n").find((l) => /ÉCHEC/.test(l)) || "échec").replace(/^group-journey ÉCHEC : /, ""));
  steps.length = 0;
  for (const r of res) for (const l of r.out.split("\n")) if (l.startsWith("  ok  ")) steps.push(l);
}
try {
  if (await holdTestGateway("group-journey")) t = Date.now(); // le chrono part une fois le gateway de test à nous
  await (PART ? run() : orchestrate());
  if (PART) {
    const dt = (Date.now() - t) / 1000;
    if (dt > 60) fail(`partie ${PART} en ${dt.toFixed(1)} s : plus de 60 s, c'est un mauvais contrôle (règle de Yoan) ; la découper ou l'accélérer`);
    console.log(`group-journey (${PART}) : ${steps.length} étapes, ${dt.toFixed(1)} s`);
    process.exit(0);
  }
  log("group_journey", true, `${steps.length} étapes en ${Date.now() - t} ms`);
  console.log(`group-journey : ${steps.length} étapes, ${((Date.now() - t) / 1000).toFixed(1)} s`);
  process.exit(0);
} catch (e) {
  const m = (e as Error).message.split("\n")[0].slice(0, 300);
  console.error("group-journey ÉCHEC : " + m);
  if (!PART) {
    log("group_journey", false, m);
    alert("group_journey", m);
  }
  process.exit(1);
}
