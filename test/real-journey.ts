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
import { COMPAT_INIT } from "./compat";
import { chromium, type Page } from "playwright-core";
import { alert, log } from "../lib/journal";
import { openTestSession } from "./test-session";
import { holdTestGateway } from "./gateway-lock";

const arg = (n: string, d: string) => {
  const i = process.argv.indexOf("--" + n);
  return i > 0 ? process.argv[i + 1] : d;
};
const TARGET = arg("target", "test");
if (TARGET !== "test" && TARGET !== "prod") {
  console.error("--target test|prod");
  process.exit(2);
}
const PATH = arg("path", "/bots-next/"),
  CDP = arg("cdp", "http://127.0.0.1:9334"),
  PROD_ORIGIN = process.env.PROD_ORIGIN || "http://127.0.0.1:9131",
  APP = arg("app", "");
const steps: string[] = [];
const mark = (s: string) => {
  steps.push(s);
  console.log("  ok  " + s);
};
const fail = (s: string): never => {
  throw new Error(s);
};

async function run() {
  let page: Page, origin: string, close: () => Promise<void>;
  if (TARGET === "test") {
    await holdTestGateway("real-journey");
    const s = await openTestSession(APP || undefined);
    origin = s.origin;
    page = await s.ctx.newPage();
    close = s.close;
  } else {
    const browser = await chromium.connectOverCDP(CDP);
    const ctx = browser.contexts()[0] ?? fail("aucun contexte dans le navigateur de la prod (remote-login serve --target headless)");
    origin = PROD_ORIGIN;
    await ctx.addInitScript(COMPAT_INIT);
    page = await ctx.newPage();
    close = async () => {};
  }
  try {
    const errors: string[] = [];
    let bytes = 0;
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("response", async (r) => {
      try {
        if (r.url().includes("/api/")) bytes += (await r.body()).length;
      } catch {}
    });
    page.on("websocket", (ws) =>
      ws.on("framereceived", (f) => {
        bytes += f.payload.length;
      })
    );
    await page.goto(origin + PATH);
    // l'accueil OU la conversation rouverte (l'app rouvre la dernière) : l'accueil est alors présent mais caché ; un sélecteur
    // « home, chat » n'attend que le premier trouvé et échouait sur un navigateur qui avait une conversation ouverte (2026-11-18)
    await page.locator("[data-testid=home]:visible, [data-testid=chat]:visible").first().waitFor({ timeout: 20000 });
    if (await page.evaluate(() => !!document.querySelector(".pane-list.hide"))) {
      await page.click('[data-testid=chat] header [aria-label="Retour"]');
      await page.waitForSelector("[data-testid=home]");
    } // l'app rouvre la dernière conversation
    await page
      .waitForSelector("[data-testid=entry][data-kind=bot]", { timeout: 20000 })
      .catch(() => fail("liste des bots absente : session de test expirée ? (" + page.url() + ")"));
    const version = await page.evaluate("self.APP_VERSION");
    mark(`liste des bots affichée (${await page.locator("[data-testid=entry][data-kind=bot]").count()} bots, ${version}, ${TARGET} ${PATH})`);
    if (!(await page.locator('[data-testid=entry][data-key=\"bots-test\"], [data-testid=pin][data-key=\"bots-test\"]').count()))
      fail("le bot bots-test n'est pas dans la liste");
    const back = async () => {
      await page.click('[data-testid=chat] header [aria-label="Retour"]');
      await page.waitForSelector("[data-testid=home]");
    };
    const settled = () =>
      page.waitForFunction(() => !/mise à jour|connexion/.test(document.querySelector("[data-testid=status]")?.textContent || ""), null, { timeout: 30000 });

    // la plus grosse vraie conversation (Hermes par défaut : ~18 000 messages) : ouverture, puis réouverture depuis le cache
    bytes = 0;
    const t0 = Date.now();
    await page.evaluate("window.__compat('chat').then((m) => m.openBot('default'))"); // le bot par défaut est épinglé, hors de la liste #bots
    await page.waitForSelector("[data-testid=thread] [data-testid=bubble]", { timeout: 30000 });
    await settled();
    const dt = Date.now() - t0,
      n = await page.locator("[data-testid=thread] [data-testid=bubble]").count();
    if (dt > 8000 || bytes > 5_000_000) fail(`ouverture de la grosse conversation : ${dt} ms, ${(bytes / 1e6).toFixed(1)} Mo`);
    if (TARGET === "test" && !((await page.locator("[data-testid=thread] [data-testid=bubble]").last().textContent()) || "").includes("FIN-DU-FIL"))
      fail("la conversation de 20 000 messages du gateway de test n'est pas celle qui s'ouvre (FIN-DU-FIL absent)");
    mark(`vraie grosse conversation ouverte en ${dt} ms, ${(bytes / 1e6).toFixed(2)} Mo, ${n} bulles`);
    await back();
    bytes = 0;
    const t1 = Date.now();
    await page.evaluate("window.__compat('chat').then((m) => m.openBot('default'))");
    await page.waitForSelector("[data-testid=thread] [data-testid=bubble]");
    await settled();
    mark(`réouverture : ${Date.now() - t1} ms, ${(bytes / 1000).toFixed(0)} Ko transférés`);
    if (bytes > 400_000) fail(`la réouverture a transféré ${(bytes / 1000).toFixed(0)} Ko : le cache IndexedDB ne sert pas`);
    await back();
    if (TARGET === "prod") {
      // lecture seule : on n'écrit rien dans la prod
      if (errors.length) fail("erreurs JavaScript : " + errors.slice(0, 2).join(" | "));
      mark("prod : lecture seule, aucun message envoyé, aucune erreur JavaScript");
      return;
    }

    // bot de test : ouvrir (création de sa conversation), envoyer, voir l'état, rouvrir
    await page.click('[data-testid=entry][data-key=\"bots-test\"], [data-testid=pin][data-key=\"bots-test\"]');
    await settled();
    mark("bots-test ouvert : " + (await page.textContent("[data-testid=status]")));
    const msg = "ping parcours réel " + new Date().toISOString().slice(11, 19);
    await page.fill("[data-testid=input]", msg);
    await page.click("[data-testid=send]");
    await page.locator("[data-testid=thread] [data-testid=bubble]", { hasText: msg }).first().waitFor({ timeout: 15000 });
    mark("message envoyé à bots-test et affiché");
    await page
      .waitForFunction(() => !/travaille/.test(document.querySelector("[data-testid=status]")?.textContent || ""), null, { timeout: 120000 })
      .catch(() => fail("bots-test travaille encore après 120 s : tour de modèle non terminé"));
    const after = (m: string) => {
      const rows = [...document.querySelectorAll("[data-testid=thread] .row")];
      const i = rows.findIndex((r) => r.textContent?.includes(m));
      const r = i < 0 ? null : rows.slice(i + 1).find((x) => x.classList.contains("assistant"));
      return r?.querySelector("[data-testid=bubble]")?.textContent?.trim() || "";
    };
    // 60 s : le modèle gratuit du profil de test répond en 3 à 40 s selon l'heure (mesuré le 2026-11-18 dans son state.db)
    await page.waitForFunction(after, msg, { timeout: 60000 }).catch(() => fail("aucune réponse de bots-test 60 s après le message envoyé"));
    await page
      .waitForFunction(() => !/travaille/.test(document.querySelector("[data-testid=status]")?.textContent || ""), null, { timeout: 120000 })
      .catch(() => fail("bots-test travaille encore après 120 s"));
    const reply = await page.evaluate(after, msg);
    if (!reply) fail("bots-test n'a rien répondu : pas de tour de modèle réussi");
    if (/No usable credentials|model-guard|bloqu[ée]|Autorisés :|credits exhausted|Insufficient balance|HTTP 4\d\d/i.test(reply))
      fail("le tour de modèle a échoué : " + reply.slice(0, 160));
    mark("tour de modèle réussi, réponse de bots-test : " + reply.slice(0, 100));
    await back();
    await page.click('[data-testid=entry][data-key=\"bots-test\"], [data-testid=pin][data-key=\"bots-test\"]');
    await settled();
    const kept = await page
      .locator("[data-testid=thread] [data-testid=bubble]", { hasText: msg })
      .first()
      .waitFor({ timeout: 5000 })
      .then(
        () => 1,
        async () => {
          console.log(
            "  fil rouvert : " +
              JSON.stringify((await page.locator("[data-testid=thread] [data-testid=bubble]").allTextContents()).slice(-5).map((t) => t.slice(0, 50)))
          );
          return 0;
        }
      );
    if (!kept) fail("le message envoyé n'est plus là après réouverture");
    mark("bots-test rouvert : l'échange est conservé");
    if (errors.length) fail("erreurs JavaScript : " + errors.slice(0, 2).join(" | "));
    mark("aucune erreur JavaScript");
  } finally {
    await page.close();
    await close();
  }
}
const t = Date.now();
try {
  await run();
  log("real_journey", true, `${steps.length} étapes en ${Date.now() - t} ms`);
  console.log(`real-journey : ${steps.length} étapes, ${((Date.now() - t) / 1000).toFixed(1)} s`);
  process.exit(0);
} catch (e) {
  const m = (e as Error).message.split("\n")[0].slice(0, 300);
  console.error("real-journey ÉCHEC : " + m);
  log("real_journey", false, m);
  alert("real_journey", m);
  process.exit(1);
}
