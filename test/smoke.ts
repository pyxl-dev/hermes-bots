// Smoke headless sur le mock : le parcours de Yoan, joué dans un vrai Chromium.
// Ouvrir une conversation de taille réelle (20 000 messages), ouvrir un bot, envoyer, recevoir, rouvrir, ouvrir un groupe.
// Sortie 1 au moindre écart ; chaque exécution laisse une ligne `smoke` dans le journal, et une alerte Hub en cas d'échec.
//   bun test/smoke.ts [--app app]   (--app : dossier de l'app à servir, utile pour une version figée)
import { chromium, type Page } from "playwright-core";
import { spawn } from "node:child_process";
import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { alert, log } from "../lib/journal";

const PORT = 18790 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const argApp = process.argv.indexOf("--app"), APP_DIR = argApp > 0 ? resolve(process.argv[argApp + 1]) : "";
const argPart = process.argv.indexOf("--part"), PART = argPart > 0 ? process.argv[argPart + 1] : ""; // "" : les deux parties en parallèle ; "bots" ou "groups" : une seule
const T_OPEN_BIG_MS = 4000, MAX_BYTES = 3_000_000, MAX_BUBBLES = 1500;

function chromePath() {
  // macOS : ~/Library/Caches ; Linux (CI) : ~/.cache ; PLAYWRIGHT_BROWSERS_PATH prime
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || [join(homedir(), "Library", "Caches", "ms-playwright"), join(homedir(), ".cache", "ms-playwright")].find((d) => existsSync(d)) || join(homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(root).filter((d) => d.startsWith("chromium_headless_shell-")).sort().reverse();
  for (const d of dirs) for (const sub of readdirSync(join(root, d))) {
    const exe = join(root, d, sub, "chrome-headless-shell");
    if (existsSync(exe)) return exe;
  }
  throw new Error("aucun chrome-headless-shell dans " + root + " (bunx playwright-core install chromium-headless-shell)");
}

const steps: string[] = [];
const mark = (s: string) => { steps.push(s); console.log("  ok  " + s); };
const fail = (s: string): never => { throw new Error(s); };

async function run() {
  const mock = spawn("bun", [join(import.meta.dir, "mock-gateway.ts")], { env: { ...process.env, MOCK_TICK_MS: process.env.MOCK_TICK_MS || "60", PORT: String(PORT), ...(APP_DIR ? { APP_DIR } : {}) }, stdio: "pipe" });
  mock.stderr.on("data", (d) => process.stderr.write(d));
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + "/bots/index.html")).ok) break; } catch {} await Bun.sleep(100); if (i === 99) fail("le mock ne démarre pas"); }
    const browser = await chromium.launch({ executablePath: chromePath() });
    const ctx = await browser.newContext({ baseURL: BASE, serviceWorkers: "block", viewport: { width: 390, height: 800 } });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => { if (!/volontaire/.test(e.message)) errors.push("pageerror " + e.message); });
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push("console " + m.text()); });
    let bytes = 0, gen = 0;
    // chaque réponse compte pour l'étape où elle arrive : r.body() se résout plus tard, et un corps de l'ouverture précédente
    // tombait après la remise à zéro (0,13 Mo comptés à la réouverture en CI le 2026-11-16, 22 Ko en temps normal)
    page.on("response", async (r) => { const g = gen; try { const n = (await r.body()).length; if (g === gen) bytes += n; } catch {} });
    page.on("websocket", (ws) => ws.on("framereceived", (f) => { bytes += typeof f.payload === "string" ? f.payload.length : f.payload.length; }));

    // démarrage d'un vrai téléphone : groupes déjà en cache (v76 plantait là, memberName lu avant l'init de roster.js)
    await page.addInitScript(() => { if (!localStorage.getItem("groups-cache")) localStorage.setItem("groups-cache", JSON.stringify([{ room_id: "cache-1", name: "Groupe en cache", members: [{ member_id: "a", profile: "a", handle: "a" }] }])); });
    await page.goto("/bots/");
    await page.waitForSelector("#bots li.bot");
    if (errors.length) fail("démarrage avec groupes en cache : " + errors.slice(0, 2).join(" | "));
    mark("liste des bots affichée (démarrage avec groupes en cache, sans erreur)");

    const bubbleWith = (text: string) => page.locator("#log .bubble", { hasText: text }).first();
    const back = async () => { await page.click("#back"); await page.waitForSelector("#roster:not([hidden])"); };

    if (PART !== "groups") { // ---- partie bots : conversation de 20 000 messages, bot, blocs, reconnexion ----
    // 1. conversation de taille réelle : rapide, légère
    bytes = 0; gen++; const t0 = Date.now();
    await page.click('#bots li.bot[data-name="archive"]');
    await bubbleWith("FIN-DU-FIL").waitFor({ timeout: 30000 });
    const dt = Date.now() - t0, count = await page.locator("#log .bubble").count();
    if (dt > T_OPEN_BIG_MS) fail(`ouverture d'une conversation de 20 000 messages : ${dt} ms (limite ${T_OPEN_BIG_MS})`);
    if (bytes > MAX_BYTES) fail(`ouverture d'une conversation de 20 000 messages : ${(bytes / 1e6).toFixed(1)} Mo transférés (limite ${MAX_BYTES / 1e6})`);
    if (count > MAX_BUBBLES) fail(`${count} bulles dans le DOM (limite ${MAX_BUBBLES})`);
    mark(`conversation de 20 000 messages ouverte en ${dt} ms, ${(bytes / 1e6).toFixed(2)} Mo, ${count} bulles`);
    await back();

    // 1b. rouvrir : le cache IndexedDB affiche tout de suite, seul un petit delta est demandé
    bytes = 0; gen++; const t1 = Date.now();
    await page.click('#bots li.bot[data-name="archive"]');
    await bubbleWith("FIN-DU-FIL").waitFor({ timeout: 30000 });
    const shown2 = Date.now() - t1;
    await page.waitForFunction(() => !/mise à jour|connexion/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 15000 });
    const hits: string[] = await (await fetch(BASE + "/api/mock/rest")).json();
    const lastHit = hits.at(-1) || "";
    if (!/limit=40\b/.test(lastHit)) fail("la réouverture doit ne demander que les 40 derniers messages, reçu : " + lastHit);
    if (bytes > 100_000) fail(`la réouverture a transféré ${(bytes / 1e6).toFixed(2)} Mo, le cache devrait suffire`);
    mark(`conversation rouverte en ${shown2} ms depuis le cache, ${(bytes / 1000).toFixed(0)} Ko (${lastHit.split("?")[1]})`);

    // 1c. remonter le fil : les messages plus anciens arrivent, la position de lecture reste
    const nBefore = await page.locator("#log .bubble").count();
    await Bun.sleep(700); // la restauration de position (350 ms) finie, comme un doigt qui remonte
    const { anchorText, top0 } = await page.evaluate(() => { const l = document.querySelector("#log")!; l.scrollTop = 0; const b = l.querySelector(".row.user .bubble")!; return { anchorText: b.textContent || "", top0: b.getBoundingClientRect().top }; });
    await page.waitForFunction((n) => document.querySelectorAll("#log .bubble").length > n, nBefore, { timeout: 10000 });
    await Bun.sleep(300);
    const top1 = await page.locator("#log .row.user .bubble", { hasText: anchorText }).first().evaluate((e) => e.getBoundingClientRect().top);
    if (Math.abs(top1 - top0) > 60) fail(`la position de lecture a bougé de ${Math.round(top1 - top0)} px en chargeant les messages plus anciens`);
    mark(`messages plus anciens chargés (${nBefore} -> ${await page.locator("#log .bubble").count()} bulles), position conservée`);
    await back();

    // 2. un bot : ouvrir, envoyer, recevoir
    await page.click('#bots li.bot[data-name="default"]');
    await bubbleWith("Build").waitFor({ timeout: 10000 });
    mark("bot ouvert avec son historique");
    const stamp = await page.locator("#log .row .ts").first().textContent();
    if (!/^\d{1,2} \S+ (\d{4} )?\d{2}:\d{2}$/.test(stamp || "")) fail(`date absente sous le message : « ${stamp} »`);
    mark(`date et heure sous chaque message (« ${stamp} »)`);
    await page.fill("#input", "smoke-un");
    await page.click("#send");
    await bubbleWith("Bien reçu : « smoke-un »").waitFor({ timeout: 15000 });
    await page.waitForFunction(() => !/travaille/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 15000 });
    mark("message envoyé, réponse reçue en entier");
    // répondre à un message dans la conversation d'un bot (pas seulement en groupe)
    await bubbleWith("Bien reçu : « smoke-un »").last().click({ button: "right" });
    if (!(await page.locator('#msg-menu [data-a=reply]').isVisible())) fail("« Répondre » absent du menu d'un message de bot");
    await page.click('#msg-menu [data-a=reply]');
    await page.fill("#input", "smoke-reponse"); await page.click("#send");
    await page.locator("#log .row.user .bubble .rq", { hasText: "smoke-un" }).last().waitFor({ timeout: 10000 });
    await page.waitForFunction(() => !/travaille/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 15000 });
    mark("réponse à un message : cadre de citation dans ma bulle");
    await page.locator("#log .row.user .bubble .rq.in", { hasText: "smoke-un" }).last().click();
    await page.locator("#log .bubble.hl", { hasText: "Bien reçu : « smoke-un »" }).waitFor({ timeout: 5000 });
    mark("toucher la citation amène au message cité");

    // 2b. blocs visuels : un bloc bots-ui devient des cartes, un bloc invalide reste du texte, un bouton envoie un message
    await page.fill("#input", "recap"); await page.click("#send");
    const ui = page.locator("#log .bubble", { has: page.locator(".ui-recap") }).last();
    await ui.waitFor({ timeout: 20000 });
    await page.waitForFunction(() => !/travaille/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 15000 });
    const seen = await ui.evaluate((b) => ({
      title: b.querySelector(".ui-recap .ui-t")?.textContent, total: b.querySelector(".ui-tot b")?.textContent,
      lines: b.querySelectorAll(".ui-bl").length, steps: b.querySelectorAll(".ui-steps li").length, btns: b.querySelectorAll(".ui-choice").length,
      secs: [...b.querySelectorAll(".ui-sec-t")].map((e) => e.textContent), bad: b.querySelector("pre.ui-bad")?.textContent || "", pending: !!b.querySelector(".ui-pending"),
      raw: b.querySelector("details.ui-raw summary")?.textContent, rawOpen: (b.querySelector("details.ui-raw") as HTMLDetailsElement | null)?.open,
      rawText: b.querySelector("details.ui-raw pre")?.textContent || "", gauge: b.querySelector(".ui-gl .warn")?.textContent }));
    if (seen.title !== "Lyon" || seen.lines !== 6 || seen.steps !== 3 || seen.btns !== 2) fail("blocs mal rendus : " + JSON.stringify(seen));
    if (seen.total?.replace(/[\s\u202f]/g, " ") !== "1 196 à 1 541 €") fail(`total du budget calculé par l'app attendu « 1 196 à 1 541 € », lu « ${seen.total} »`);
    if (!/pas une liste/.test(seen.bad) || seen.pending) fail("le bloc invalide doit rester en texte brut : " + JSON.stringify(seen));
    if (seen.raw !== "Carte illisible, voir le brut" || seen.rawOpen || !/brut-garde/.test(seen.rawText)) fail("carte illisible : brut attendu replié sous « voir le brut » : " + JSON.stringify(seen));
    if (seen.secs.join("|") !== "Décidé|Écarté") fail("sections en gras non mises en cartes : " + seen.secs.join("|"));
    mark(`blocs rendus : récap, budget (total ${seen.total}, ${seen.gauge}), étapes, actions ; bloc invalide en texte ; carte illisible repliée ; sections ${seen.secs.join(", ")}`);
    await ui.locator(".ui-choice", { hasText: "Voir les messages du voyage" }).click();
    await page.locator("#log .row.user .bubble", { hasText: "bloc-choix-voyage" }).waitFor({ timeout: 10000 });
    await bubbleWith("Bien reçu : « bloc-choix-voyage »").waitFor({ timeout: 15000 });
    if (!(await ui.locator(".ui-choice:disabled").count())) fail("les boutons du bloc doivent se griser après un choix");
    if ((await page.inputValue("#input")) !== "") fail("le bouton a laissé du texte dans la saisie");
    mark("bouton de choix : message envoyé à ma place, réponse reçue, boutons grisés");
    await page.waitForFunction(() => !/travaille/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 15000 });
    await back();

    // 3. rouvrir : l'échange est là
    await page.click('#bots li.bot[data-name="default"]');
    await bubbleWith("smoke-un").waitFor({ timeout: 10000 });
    await page.waitForFunction(() => !/mise à jour|connexion/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 15000 });
    if (!(await page.locator("#log .bubble", { hasText: "Bien reçu : « smoke-un »" }).count())) fail("réponse absente après réouverture");

    // 3b. /undo : le dernier échange part, sans relire tout le fil (session.history renvoyait 38 Mo sur la conversation Hermes)
    const sentRpc: string[] = [];
    page.on("websocket", (ws) => ws.on("framesent", (f) => { const m = /"method":"([^"]+)"/.exec(String(f.payload)); if (m) sentRpc.push(m[1]); }));
    await page.fill("#input", "/undo"); await page.click("#send");
    await page.locator("#log .approval button.yes").last().click();
    await page.locator("#log .note", { hasText: "Dernier échange retiré" }).waitFor({ timeout: 15000 });
    if (await page.locator("#log .bubble", { hasText: "Bien reçu : « bloc-choix-voyage »" }).count()) fail("/undo : le dernier échange est toujours affiché");
    if (!(await page.locator("#log .bubble", { hasText: "Bien reçu : « smoke-un »" }).count())) fail("/undo a retiré plus que le dernier échange");
    if (sentRpc.includes("session.history")) fail("/undo appelle encore session.history (tout le fil)");
    mark("/undo : dernier échange retiré par la page paginée, sans session.history");
    mark("bot rouvert : l'échange est conservé");

    // 3b. le réseau tombe : reconnexion avec recul (1 s puis 2 s), état lisible, puis tout remarche
    const before = (await (await fetch(BASE + "/api/mock/tickets")).json()).length;
    await fetch(BASE + "/api/mock/refuse?n=1"); await fetch(BASE + "/api/mock/drop");
    await page.waitForFunction(() => /reconnexion dans 1 s/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 5000 });
    await page.waitForFunction(() => /reconnexion dans 2 s/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 8000 });
    await page.waitForFunction(() => /à jour/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 10000 });
    const tk: number[] = (await (await fetch(BASE + "/api/mock/tickets")).json()).slice(before);
    const g1 = tk[1] - tk[0];
    if (tk.length < 2 || g1 < 1700 || g1 > 3000) fail(`recul attendu 2 s entre le 1er et le 2e essai, mesuré ${g1} ms sur ${tk.length} essais`);
    mark(`reconnexion : états « reconnexion dans 1 s », « dans 2 s », « à jour » (écart mesuré ${g1} ms)`);
    await page.fill("#input", "smoke-deux"); await page.click("#send");
    await bubbleWith("Bien reçu : « smoke-deux »").waitFor({ timeout: 15000 });
    mark("l'envoi marche après la reconnexion");

    // 3c. contrat refusé : invalid_params est réessayé avec les paramètres de base (la panne inline_images du 2026-11-14)
    const snap = await page.evaluate(`(async () => { const { Gateway } = await import(new URL("gateway.js", document.baseURI).href); const g = await new Gateway("default").connect(); const r = await g.call("session.resume", { session_id: "s-default", omit_messages: true, inline_images: false }); g.close(); return r.session_id; })()`).catch((e) => "ERREUR " + e.message);
    if (!snap || String(snap).startsWith("ERREUR")) fail("invalid_params non réessayé : " + snap);
    mark("invalid_params réessayé sans le paramètre refusé");
    let rep: any[] = [];
    for (let i = 0; i < 30 && !rep.some((r) => /inline_images/.test(r.msg)); i++) { await Bun.sleep(100); rep = await (await fetch(BASE + "/api/mock/clientlogs")).json(); }
    if (!rep.some((r: any) => /inline_images/.test(r.msg))) fail("l'échec invalid_params aurait dû être remonté à /bots/log");
    await back();

    // bloc réel du 2026-11-15 (étiquettes de 57 à 82 signes) : dessiné en cartes, jamais en JSON brut
    const longBlock = await Bun.file(import.meta.dir + "/fixtures/bots-ui-long-labels.json").text();
    const lb = await page.evaluate(async (raw) => { const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const d = document.createElement("div"); d.innerHTML = (await M("blocks")).UiBlocks.render(raw); return { recap: !!d.querySelector(".ui-recap"), steps: !!d.querySelector(".ui-steps"), bad: d.querySelectorAll(".ui-bad").length }; }, longBlock);
    if (!lb.recap || !lb.steps || lb.bad) fail(`bloc aux textes longs mal rendu : ${JSON.stringify(lb)}`);
    mark("bloc aux étiquettes longues dessiné en cartes (récap, étapes), aucun JSON brut");
    // bloc réel du 2026-11-15 sans "type" (brief de semaine) : le type se déduit des champs
    const untyped = '{"title": "Ce que le brief disait de faux", "facts": [{"value": "2 packs", "label": "existent bien sur le Drive, 17/11 et 19/11"}, {"value": "-1 h", "label": "horaires lus en UTC et présentés comme locaux"}]}';
    const ut = await page.evaluate(async (raw) => { const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const d = document.createElement("div"); d.innerHTML = (await M("blocks")).UiBlocks.render(raw); return { recap: !!d.querySelector(".ui-recap"), bad: d.querySelectorAll(".ui-bad").length }; }, untyped);
    if (!ut.recap || ut.bad) fail(`bloc sans type mal rendu : ${JSON.stringify(ut)}`);
    mark("bloc sans type dessiné en récap, aucun JSON brut");

    // remontées du client côté bots : le bloc bots-ui invalide et le refus inline_images doivent être signalés, rien d'autre
    { let rep: any[] = []; for (let i = 0; i < 30 && !rep.some((r) => r.kind === "bots-ui"); i++) { await Bun.sleep(100); rep = await (await fetch(BASE + "/api/mock/clientlogs")).json(); }
      if (!rep.some((r) => r.kind === "bots-ui" && /budget/.test(r.msg))) fail("le bloc bots-ui invalide aurait dû être remonté à /bots/log");
      const other = rep.filter((r) => !/inline_images/.test(r.msg) && r.kind !== "bots-ui"); if (other.length) fail("le client a remonté des erreurs : " + other.slice(0, 2).map((r: any) => r.kind + " " + r.msg).join(" | ")); }
      if (errors.length) fail("erreurs du client (partie bots) : " + errors.slice(0, 3).join(" | "));
    }
    if (PART !== "bots") { // ---- partie groupes ----
    // 4. un groupe
    await page.waitForSelector('#groups li.bot[data-room="r-cours"]');
    await page.click('#groups li.bot[data-room="r-cours"]');
    await bubbleWith("déroulé").waitFor({ timeout: 10000 });
    await page.fill("#input", "smoke-groupe");
    await page.click("#send");
    await bubbleWith("bien reçu « smoke-groupe »").waitFor({ timeout: 15000 });
    mark("groupe ouvert, message envoyé, réponse d'un membre");
    // deux relevés qui se croisent sur le même curseur ne doublent aucun message
    await page.evaluate(async () => { const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { state } = await M("state"), { pollGroup } = await M("groups"); const g = (state as any).group; g.cursor = 0; await Promise.all([pollGroup(g), pollGroup(g)]); });
    const nMine = await page.locator("#log .row.user .bubble", { hasText: /^smoke-groupe$/ }).count();
    if (nMine !== 1) fail(`message du groupe affiché ${nMine} fois`);
    mark("relevés simultanés : chaque message affiché une seule fois");
    await page.fill("#input", "recap groupe"); await page.click("#send");
    const gui = page.locator("#log .row.member .bubble", { has: page.locator(".ui-todo .ui-choice") }).last();
    await gui.waitFor({ timeout: 15000 });
    await gui.locator(".ui-choice", { hasText: "Nova n'a jamais mordu" }).click();
    await bubbleWith("bien reçu « Nova n'a jamais mordu »").waitFor({ timeout: 15000 });
    mark("groupe : blocs rendus dans la bulle d'un membre, le bouton envoie au groupe");
    // deux bots au travail en même temps : deux avatars dans la barre et « en parallèle »
    const par = await page.evaluate(async () => {
      const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { state } = await M("state"), { renderDriver } = await M("groups");
      const g = (state as any).group, ms = g.room.members;
      g.dispatch = [{ bot: ms[1].profile, status: "running" }];
      renderDriver(g, { working: true, member_activity: [{ member_id: ms[0].member_id, status: "running" }] });
      const r = { av: document.querySelectorAll("#grp-av .grp-stack > *").length, txt: document.querySelector("#grp-txt")!.textContent, shown: !document.querySelector("#grp-bar")!.hidden };
      g.dispatch = []; renderDriver(g, { working: false, member_activity: [] });
      return r;
    });
    if (par.av !== 2 || !/en parallèle/.test(par.txt || "") || !par.shown) fail(`barre de travail parallèle : ${JSON.stringify(par)}`);
    mark("deux bots au travail : deux avatars et « travaillent en parallèle »");
    // « attend son tour » vient de la file réelle du moteur (member_activity queued), jamais d'une relecture des @ :
    // un bot cité sans tâche en file n'attend rien (défaut 1 du 2026-11-16)
    const seq = await page.evaluate(async () => {
      const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { state } = await M("state"), { renderDriver } = await M("groups");
      const g = (state as any).group, ms = g.room.members, keep = g.events;
      g.events = [...keep, { kind: "message.user", payload: { thread_id: "T", text: "go" } },
        { kind: "message.member", actor: { kind: "member", id: ms[0].member_id }, payload: { thread_id: "T", text: `@${ms[1].handle}, vas-y en parallèle.` } }];
      const look = () => ({ av: document.querySelectorAll("#grp-av .grp-wait").length, txt: document.querySelector("#grp-txt")!.textContent });
      renderDriver(g, { working: true, member_activity: [{ member_id: ms[0].member_id, status: "running", thread_id: "T" }] });
      const cited = look();
      renderDriver(g, { working: true, member_activity: [{ member_id: ms[0].member_id, status: "running", thread_id: "T" }, { member_id: ms[1].member_id, status: "queued", thread_id: "T" }] });
      const queued = look();
      renderDriver(g, { working: true, member_activity: [{ member_id: ms[0].member_id, status: "queued", thread_id: "T" }] });
      const alone = look();
      g.events = keep; renderDriver(g, { working: false, member_activity: [] });
      return { cited, queued, alone };
    });
    if (seq.cited.av !== 0 || /attend/.test(seq.cited.txt || "")) fail(`« attend son tour » sans tâche en file : ${JSON.stringify(seq.cited)}`);
    if (seq.queued.av !== 1 || !/attend son tour/.test(seq.queued.txt || "")) fail(`bot en file du moteur non affiché : ${JSON.stringify(seq.queued)}`);
    if (/attend/.test(seq.alone.txt || "") || seq.alone.av !== 0) fail(`seul en file, personne au travail : « ${seq.alone.txt} » (il démarre, il n'attend personne)`);
    mark("« attend son tour » seulement pour une tâche en file du moteur, derrière un bot qui travaille, pas pour un simple @");
    // deux bots cités par Yoan, groupe au repos : la voie parallèle les prend (pas la file du moteur)
    const lane = await page.evaluate(async () => {
      const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { fastLaneMembers } = await M("tasks");
      const g: any = { context: { routing: "lead", lead_member_id: "a" }, busy: false, driver: {}, dispatch: [],
        room: { members: ["a", "b", "c"].map((h) => ({ member_id: h, handle: h })) } };
      return [fastLaneMembers(g, "@b et @c, allez-y")?.length ?? 0, fastLaneMembers(g, "@b seul")?.length ?? 0];
    });
    if (lane[0] !== 2 || lane[1] !== 0) fail(`voie parallèle au repos : ${JSON.stringify(lane)}`);
    mark("deux bots cités, groupe au repos : envoyés en parallèle");
    // fil de travail 1 : la bulle d'un résultat a un fil ; un appui ouvre le volet avec l'outil, le texte et la sortie dépliable
    const reply = page.locator("#log .bubble.has-trace", { hasText: "bien reçu « smoke-groupe »" }).first();
    await reply.waitFor({ timeout: 8000 });
    await reply.click();
    await page.locator("#trace-sheet.on").waitFor({ timeout: 3000 });
    await page.locator("#tr-body .tool summary", { hasText: "web_search : sources du cours" }).waitFor({ timeout: 5000 });
    const seenText = await page.locator("#tr-body .tr-text").first().textContent();
    if (seenText !== "J'ai trouvé trois sources.") fail(`texte intermédiaire du fil : « ${seenText} »`);
    await page.locator("#tr-body .tool summary", { hasText: "web_search" }).click();
    const outShown = await page.locator("#tr-body .tool pre").first().textContent();
    if (outShown !== "3 résultats") fail(`sortie dépliée : « ${outShown} »`);
    await page.click("#tr-close"); await page.locator("#trace-sheet", { has: page.locator(":scope") }).waitFor({ state: "hidden", timeout: 3000 });
    mark("fil de travail : appui sur une bulle de résultat, outil + argument court, texte, sortie dépliée (« 3 résultats »)");
    // sans fil : aucune réaction ; au-delà de 30 jours : « fil expiré »
    const bare = page.locator("#log .bubble[data-mid]:not(.has-trace)", { hasText: "Oui, je fais le" }).first();
    await bare.click({ position: { x: 20, y: 10 } });
    if (await page.locator("#trace-sheet").isVisible()) fail("une bulle sans fil a ouvert le volet");
    await page.evaluate(async () => {
      const el = document.querySelector<HTMLElement>('#log .bubble[data-mid]:not(.has-trace)')!; el.dataset.ts = String(Date.now() - 40 * 864e5);
      const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { state } = await M("state"), { markTraceBubbles } = await M("trace");
      markTraceBubbles((state as any).group);
    });
    await page.locator("#log .bubble.trace-expired").first().click({ position: { x: 20, y: 10 } });
    await page.locator("#tr-body", { hasText: "Fil expiré" }).waitFor({ timeout: 3000 });
    await page.click("#tr-close");
    mark("fil de travail : bulle sans fil sans réaction, bulle de plus de 30 jours « fil expiré »");
    // fil de travail 2 : deux bots en table ronde ; ouvrir l'un en direct, l'arrêter seul, l'autre continue ; Arrêter du groupe arrête la table ronde
    const room = await page.evaluate(async () => { const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { state } = await M("state"); return (state as any).group.room.room_id; });
    for (const member_id of ["rea", "default"]) await fetch(BASE + "/api/mock/round-start", { method: "POST", body: JSON.stringify({ room_id: room, member_id }) });
    await page.waitForFunction(() => document.querySelectorAll("#grp-av [data-worker]").length === 2, null, { timeout: 8000 });
    await page.locator('#grp-av [data-worker="rea"]').click();
    await page.locator("#trace-sheet.on").waitFor({ timeout: 3000 });
    await page.locator("#tr-body .tool.run summary", { hasText: "bun test" }).waitFor({ timeout: 6000 });
    const filTexts = await page.locator("#tr-body .tool").allTextContents();
    if (!/terminal : git status/.test(filTexts[0]) || !/read_file : src\/main\.ts/.test(filTexts[1])) fail(`fil en direct : ${JSON.stringify(filTexts)}`);
    if (await page.locator("#tr-body .tool.done").count() !== 2) fail("les deux premiers outils devraient être finis, le troisième en cours");
    await page.click("#tr-stop");
    await page.locator("#tr-state", { hasText: "arrêté" }).waitFor({ timeout: 5000 });
    const stops = await (await fetch(BASE + "/api/mock/stops")).json();
    if (stops.length !== 1 || stops[0].method !== "member.stop" || stops[0].member_id !== "rea") fail(`arrêt d'un seul bot : ${JSON.stringify(stops)}`);
    await page.click("#tr-close");
    await page.waitForFunction(() => document.querySelectorAll("#grp-av [data-worker]").length === 1, null, { timeout: 8000 });
    const left = await page.locator("#grp-av [data-worker]").getAttribute("data-worker");
    if (left !== "default") fail(`après l'arrêt de rea, il devait rester default : ${left}`);
    mark("fil de travail : fil de rea ouvert en direct (2 outils finis, 1 en cours), arrêté seul, default continue");
    // tableau du groupe : un message envoyé ne crée plus de tâche (le meneur les inscrit) ; ajout, déplacer, rouvrir depuis le kanban
    await page.locator("#group-tasks:not([hidden])").waitFor({ timeout: 5000 });
    await page.click("#group-tasks");
    await page.locator("#tk-list .kb-col.todo").waitFor({ timeout: 5000 });
    if (await page.locator("#tk-list .kb-card", { hasText: "smoke-groupe" }).count()) fail("un message envoyé a créé une tâche (c'est au meneur de les inscrire)");
    await page.fill("#tk-new", "Recruter un expert réseau"); await page.click("#tk-add");
    const newCard = page.locator("#tk-list .kb-col.todo .kb-card", { hasText: "Recruter un expert réseau" });
    await newCard.waitFor({ timeout: 5000 });
    await newCard.click({ position: { x: 10, y: 10 } });
    await page.locator("#tk-list .kb-card.open [data-to=done]").click();
    await page.locator("#tk-list .kb-col.done .kb-card", { hasText: "Recruter un expert réseau" }).waitFor({ state: "attached", timeout: 5000 });
    const badge = await page.evaluate(() => document.querySelector("#gt-n")!.textContent);
    await page.locator("#tk-list .kb-col.done .kb-card", { hasText: "Recruter un expert réseau" }).click({ position: { x: 10, y: 10 } });
    await page.locator("#tk-list .kb-card.open [data-to=todo]").click();
    await page.locator("#tk-list .kb-col.todo .kb-card", { hasText: "Recruter un expert réseau" }).waitFor({ state: "attached", timeout: 5000 });
    await page.click("#tk-close");
    if (badge !== "" && !/^\d+$/.test(badge || "")) fail(`compteur de tâches ouvertes illisible : « ${badge} »`);
    mark("tableau : un message ne crée pas de tâche ; ajout, déplacée en « Faite » puis rouverte depuis le kanban");
    // message en file : le groupe travaille, aucun événement du moteur ne cite le message → « en attente »
    const q = await page.evaluate(async () => {
      const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { state } = await M("state"), { markQueued } = await M("tasks");
      const g = (state as any).group, last = [...g.events].reverse().find((e: any) => e.kind === "message.user");
      const saved = g.events; g.events = saved.filter((e: any) => e.payload?.discussion_event_id !== last.event_id);
      g.busy = true; markQueued(g);
      const row = document.querySelector(`#log .bubble[data-eid="${CSS.escape(last.event_id)}"]`)?.closest(".row");
      const r = { queued: !!row?.classList.contains("in-queue"), caption: row ? getComputedStyle(row.querySelector(".bubble")!, "::after").content : "" };
      g.events = saved; g.busy = false; markQueued(g);
      return { ...r, after: !!row?.classList.contains("in-queue") };
    });
    if (!q.queued || !/en attente/.test(q.caption) || q.after) fail(`message en file : ${JSON.stringify(q)}`);
    mark("message pas encore pris par le moteur : affiché « en attente »");
    const deferred = await page.evaluate(async () => { const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { state } = await M("state"), { renderRoomEvent } = await M("groups"); const g = (state as any).group, m = g.room.members[0];
      renderRoomEvent(g, { kind: "turn.deferred", actor: { kind: "gateway", id: "install:abc" }, payload: { member_id: m.member_id, reason: "member_unavailable" } });
      return [...document.querySelectorAll("#log .note")].at(-1)!.textContent; });
    if (/install:/.test(deferred || "") || !deferred) fail(`tour en attente : nom du gateway affiché au lieu du bot : « ${deferred} »`);
    mark("tour en attente : le nom du bot, pas l'identifiant du gateway");
    // (après l'étape « en attente » : Arrêter pousse un room.stop_requested qui vide la file)
    await page.click("#grp-stop");
    await page.waitForFunction(() => document.querySelectorAll("#grp-av [data-worker]").length === 0 || document.querySelector("#grp-bar")!.hidden, null, { timeout: 8000 });
    const stops2 = await (await fetch(BASE + "/api/mock/stops")).json();
    if (!stops2.some((x: any) => x.method === "dispatch.stop" && x.room_id === room)) fail(`Arrêter du groupe n'a pas arrêté la table ronde : ${JSON.stringify(stops2)}`);
    mark("fil de travail : Arrêter du groupe arrête aussi la table ronde");
    // rouvrir le groupe sans réseau : les messages viennent du cache du téléphone
    await back();
    await page.evaluate(async () => { const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { state } = await M("state"), { openGroup } = await M("groups"); const r = (state as any).roster; r._call = r.call; r.call = (m: string, ...a: any[]) => m.startsWith('groups.') ? new Promise(() => {}) : r._call(m, ...a); openGroup('r-cours'); });
    await bubbleWith("smoke-groupe").waitFor({ timeout: 3000 });
    await page.evaluate(async () => { const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { state } = await M("state"); const r = (state as any).roster; r.call = r._call; });
    mark("groupe rouvert hors ligne : messages affichés depuis le cache");
    // le choix déjà fait reste figé après réouverture : plus aucun bouton actif, le choix retenu marqué
    const reopened = page.locator("#log .row.member .bubble", { has: page.locator(".ui-todo .ui-choice") }).last();
    await reopened.locator(".ui-choice.chosen", { hasText: "Nova n'a jamais mordu" }).waitFor({ timeout: 3000 });
    const live = await reopened.locator(".ui-choice:not(:disabled)").count();
    if (live) fail(`${live} bouton(s) de choix encore actifs après réouverture`);
    mark("groupe rouvert : choix déjà fait figé, plus aucun bouton actif");

    // la remontée marche : une erreur et un rejet volontaires arrivent au serveur ; le reste doit être vide
    await page.evaluate(() => { setTimeout(() => { throw new Error("smoke-erreur-volontaire"); }); Promise.reject(new Error("smoke-rejet-volontaire")); });
    let reported: any[] = [];
    for (let i = 0; i < 50 && reported.filter((r) => /volontaire/.test(r.msg)).length < 2; i++) { await Bun.sleep(100); reported = await (await fetch(BASE + "/api/mock/clientlogs")).json(); }
    if (reported.filter((r) => /volontaire/.test(r.msg)).length < 2) fail("l'erreur et le rejet volontaires ne sont pas remontés à /bots/log");
    mark("erreur et rejet remontés au serveur avec la version " + reported[0].version);
    reported = reported.filter((r) => !/volontaire|inline_images/.test(r.msg) && r.kind !== "bots-ui");
    if (reported.length) fail("le client a remonté des erreurs : " + reported.slice(0, 2).map((r: any) => r.kind + " " + r.msg).join(" | "));
    // gateway en drain (ticket 503 runtime_draining) : l'en-tête dit « gateway en redémarrage », pas « hors ligne »
    const drain = await page.evaluate(async () => { const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { handleError, setConn } = await M("roster"); handleError(new Error('ticket 503 {"reason": "runtime_draining"}'), "#roster-msg"); const t = document.querySelector("#conn")!.textContent || ""; setConn(true); return t; });
    if (!/redémarrage/.test(drain) || /hors ligne/.test(drain)) fail(`gateway en drain affiché « ${drain} »`);
    mark("gateway en drain : « gateway en redémarrage », pas « hors ligne »");
    // websocket du roster fermé (drain) pendant qu'un salon est ouvert : pas de « hors ligne » figé, reconnexion seule
    const closed = await page.evaluate(async () => { const M = (n: string) => import(new URL(n + ".js", document.baseURI).href); const { state } = await M("state"); state.roster.ws.close(); await new Promise((r) => setTimeout(r, 300)); const t = document.querySelector("#conn")!.textContent || ""; await new Promise((r) => setTimeout(r, 4000)); return [t, document.querySelector("#conn")!.textContent || ""]; });
    if (/hors ligne/.test(closed[0]) || !/en ligne/.test(closed[1])) fail(`websocket fermé : « ${closed[0]} » puis « ${closed[1]} »`);
    mark("websocket fermé : « reconnexion… » puis « en ligne », jamais « hors ligne »");
    // redémarrage avec un cache de groupes plein (la v76 plantait au chargement : cycle roster <-> groups, vu seulement sur le vrai gateway)
    const nGroups = await page.evaluate(() => (JSON.parse(localStorage.getItem("groups-cache") || "[]") || []).length);
    if (!nGroups) fail("le cache de groupes devrait être rempli à ce stade du parcours");
    await page.evaluate(() => localStorage.setItem("last-chat", "null")); // la liste, pas la dernière conversation
    await page.goto("/bots/"); await page.waitForSelector("#bots li.bot").catch(() => fail("redémarrage : liste absente ; erreurs : " + errors.slice(-3).join(" | ")));
    await page.locator("#groups li, #groups .group, #groups > *").first().waitFor({ timeout: 10000 });
    mark(`redémarrage avec ${nGroups} groupe(s) en cache : liste affichée`);
    if (errors.length) fail("erreurs du client : " + errors.slice(0, 3).join(" | "));
    }
    mark("aucune erreur JavaScript");
    await browser.close();
  } finally { mock.kill(); }
}

const t = Date.now();
// Sans --part : la partie bots et la partie groupes tournent en même temps (chacune son mock, son port et son Chromium), pour tenir sous 30 s.
async function both() {
  const args = process.argv.slice(2).filter((a, i, all) => a !== "--part" && all[i - 1] !== "--part");
  const parts = ["bots", "groups"].map(async (part) => {
    const p = Bun.spawn(["bun", import.meta.path, ...args, "--part", part], { stdout: "pipe", stderr: "pipe", env: process.env });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { part, out, err, code };
  });
  const res = await Promise.all(parts);
  let n = 0;
  for (const r of res) {
    const lines = r.out.split("\n").filter((l) => l.startsWith("  ok  ")); n += lines.length;
    console.log(`-- partie ${r.part} : ${lines.length} étapes, code ${r.code}`); console.log(r.out.trimEnd()); if (r.err.trim()) console.error(r.err.trimEnd());
  }
  const bad = res.find((r) => r.code !== 0);
  if (bad) fail("partie " + bad.part + " : " + (bad.err.split("\n").find((l) => /ÉCHEC/.test(l)) || "échec").replace(/^smoke ÉCHEC : /, ""));
  steps.length = 0; for (let i = 0; i < n; i++) steps.push("");
}
try {
  await (PART ? run() : both());
  if (PART) { console.log(`smoke (${PART}) : ${steps.length} étapes, ${((Date.now() - t) / 1000).toFixed(1)} s`); process.exit(0); }
  log("smoke", true, `${steps.length} étapes en ${Date.now() - t} ms`);
  console.log(`smoke : ${steps.length} étapes, ${((Date.now() - t) / 1000).toFixed(1)} s`);
  process.exit(0);
} catch (e) {
  const m = (e as Error).message.split("\n")[0].slice(0, 300);
  console.error("smoke ÉCHEC : " + m);
  if (!PART) { log("smoke", false, m); alert("smoke", m); }
  process.exit(1);
}
