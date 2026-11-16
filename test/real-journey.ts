// Parcours réel contre un VRAI gateway Hermes.
//   bun test/real-journey.ts                  (par défaut) gateway de TEST (test/test-gateway.ts) : Chromium headless isolé, connexion
//                                             avec le mot de passe de ~/.hermes-test, PWA servie depuis app/ de ce dépôt (--app <dossier figé>).
//                                             Ouvre la conversation de 20 000 messages, puis envoie un message au seul bot `bots-test` :
//                                             le modèle doit répondre pour de vrai (clé de modèle de test) et l'échange doit être conservé.
//   bun test/real-journey.ts --target prod    LECTURE SEULE sur la prod, dans le navigateur déjà connecté par Yoan (remote-login, CDP
//                                             127.0.0.1:9334) : liste des bots, ouverture et réouverture de la plus grosse conversation.
//                                             Aucun message envoyé, aucun mot de passe saisi (la session vient du cookie de ce navigateur).
// Options : [--path /bots-next/] [--cdp http://127.0.0.1:9334] [--app dossier]. Sortie 1 au moindre écart ;
// ligne `real_journey` dans le journal, alerte Hub en cas d'échec.
import { chromium, type Page } from "playwright-core";
import { alert, log } from "../lib/journal";
import { openTestSession } from "./test-session";
import { holdTestGateway } from "./gateway-lock";

const arg = (n: string, d: string) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const TARGET = arg("target", "test");
if (TARGET !== "test" && TARGET !== "prod") { console.error("--target test|prod"); process.exit(2); }
const PATH = arg("path", "/bots-next/"), CDP = arg("cdp", "http://127.0.0.1:9334"), PROD_ORIGIN = process.env.PROD_ORIGIN || "http://127.0.0.1:9131", APP = arg("app", "");
const steps: string[] = []; const mark = (s: string) => { steps.push(s); console.log("  ok  " + s); };
const fail = (s: string): never => { throw new Error(s); };

async function run() {
  let page: Page, origin: string, close: () => Promise<void>;
  if (TARGET === "test") {
    await holdTestGateway("real-journey");
    const s = await openTestSession(APP || undefined); origin = s.origin; page = await s.ctx.newPage(); close = s.close;
  } else {
    const browser = await chromium.connectOverCDP(CDP);
    const ctx = browser.contexts()[0] ?? fail("aucun contexte dans le navigateur de la prod (remote-login serve --target headless)");
    origin = PROD_ORIGIN; page = await ctx.newPage(); close = async () => {};
  }
  try {
    const errors: string[] = []; let bytes = 0;
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", async (r) => { try { if (r.url().includes("/api/")) bytes += (await r.body()).length; } catch {} });
    page.on("websocket", (ws) => ws.on("framereceived", (f) => { bytes += f.payload.length; }));
    await page.goto(origin + PATH);
    await page.waitForSelector("#roster:not([hidden]), #chat:not([hidden])", { timeout: 20000 });
    if (await page.locator("#roster").isHidden()) { await page.click("#back"); await page.waitForSelector("#roster:not([hidden])"); } // l'app rouvre la dernière conversation
    await page.waitForSelector("#bots li.bot", { timeout: 20000 }).catch(() => fail("liste des bots absente : session de test expirée ? (" + page.url() + ")"));
    const version = await page.evaluate("self.APP_VERSION");
    mark(`liste des bots affichée (${await page.locator("#bots li.bot").count()} bots, ${version}, ${TARGET} ${PATH})`);
    if (!(await page.locator('#bots li.bot[data-name="bots-test"]').count())) fail("le bot bots-test n'est pas dans la liste");
    const back = async () => { await page.click("#back"); await page.waitForSelector("#roster:not([hidden])"); };
    const settled = () => page.waitForFunction(() => !/mise à jour|connexion/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 30000 });

    // la plus grosse vraie conversation (Hermes par défaut : ~18 000 messages) : ouverture, puis réouverture depuis le cache
    bytes = 0; const t0 = Date.now();
    await page.evaluate("import(new URL('chat.js', document.baseURI).href).then((m) => m.openBot('default'))"); // le bot par défaut est épinglé, hors de la liste #bots
    await page.waitForSelector("#log .bubble", { timeout: 30000 }); await settled();
    const dt = Date.now() - t0, n = await page.locator("#log .bubble").count();
    if (dt > 8000 || bytes > 5_000_000) fail(`ouverture de la grosse conversation : ${dt} ms, ${(bytes / 1e6).toFixed(1)} Mo`);
    if (TARGET === "test" && !((await page.locator("#log .bubble").last().textContent()) || "").includes("FIN-DU-FIL")) fail("la conversation de 20 000 messages du gateway de test n'est pas celle qui s'ouvre (FIN-DU-FIL absent)");
    mark(`vraie grosse conversation ouverte en ${dt} ms, ${(bytes / 1e6).toFixed(2)} Mo, ${n} bulles`);
    await back();
    bytes = 0; const t1 = Date.now();
    await page.evaluate("import(new URL('chat.js', document.baseURI).href).then((m) => m.openBot('default'))"); await page.waitForSelector("#log .bubble"); await settled();
    mark(`réouverture : ${Date.now() - t1} ms, ${(bytes / 1000).toFixed(0)} Ko transférés`);
    if (bytes > 400_000) fail(`la réouverture a transféré ${(bytes / 1000).toFixed(0)} Ko : le cache IndexedDB ne sert pas`);
    await back();
    if (TARGET === "prod") { // lecture seule : on n'écrit rien dans la prod
      if (errors.length) fail("erreurs JavaScript : " + errors.slice(0, 2).join(" | "));
      mark("prod : lecture seule, aucun message envoyé, aucune erreur JavaScript");
      return;
    }

    // bot de test : ouvrir (création de sa conversation), envoyer, voir l'état, rouvrir
    await page.click('#bots li.bot[data-name="bots-test"]'); await settled();
    mark("bots-test ouvert : " + (await page.textContent("#chat-sub")));
    const msg = "ping parcours réel " + new Date().toISOString().slice(11, 19);
    await page.fill("#input", msg); await page.click("#send");
    await page.locator("#log .bubble", { hasText: msg }).first().waitFor({ timeout: 15000 });
    mark("message envoyé à bots-test et affiché");
    await page.waitForFunction(() => !/travaille/.test(document.querySelector("#chat-sub")?.textContent || ""), null, { timeout: 120000 }).catch(() => fail("bots-test travaille encore après 120 s : tour de modèle non terminé"));
    const reply = ((await page.locator("#log .row.assistant .bubble").last().textContent().catch(() => "")) || "").trim();
    if (!reply) fail("bots-test n'a rien répondu : pas de tour de modèle réussi");
    if (/No usable credentials|model-guard|bloqu[ée]|Autorisés :/i.test(reply)) fail("le tour de modèle a échoué : " + reply.slice(0, 160));
    mark("tour de modèle réussi, réponse de bots-test : " + reply.slice(0, 100));
    await back();
    await page.click('#bots li.bot[data-name="bots-test"]'); await settled();
    const kept = await page.locator("#log .bubble", { hasText: msg }).count();
    if (!kept) fail("le message envoyé n'est plus là après réouverture");
    mark("bots-test rouvert : l'échange est conservé");
    if (errors.length) fail("erreurs JavaScript : " + errors.slice(0, 2).join(" | "));
    mark("aucune erreur JavaScript");
  } finally { await page.close(); await close(); }
}
const t = Date.now();
try { await run(); log("real_journey", true, `${steps.length} étapes en ${Date.now() - t} ms`); console.log(`real-journey : ${steps.length} étapes, ${((Date.now() - t) / 1000).toFixed(1)} s`); process.exit(0); }
catch (e) { const m = (e as Error).message.split("\n")[0].slice(0, 300); console.error("real-journey ÉCHEC : " + m); log("real_journey", false, m); alert("real_journey", m); process.exit(1); }
