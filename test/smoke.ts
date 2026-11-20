// Smoke headless sur le mock : le parcours de Yoan, joué dans un vrai Chromium, piloté par data-testid et rôles.
// Les états synthétiques passent par la poignée window.__bots (activée par localStorage bots-test, ADR 0004).
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
const argApp = process.argv.indexOf("--app"),
  APP_DIR = argApp > 0 ? resolve(process.argv[argApp + 1]) : "";
const argPart = process.argv.indexOf("--part"),
  PART = argPart > 0 ? process.argv[argPart + 1] : ""; // "" : les deux parties en parallèle ; "bots" ou "groups" : une seule
const T_OPEN_BIG_MS = 1000,
  MAX_BYTES = 3_000_000,
  MAX_BUBBLES = 1500; // cible v88 (PORTEE-v88.md) : 20 000 messages en moins de 1 s

function chromePath() {
  // macOS : ~/Library/Caches ; Linux (CI) : ~/.cache ; PLAYWRIGHT_BROWSERS_PATH prime
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    [join(homedir(), "Library", "Caches", "ms-playwright"), join(homedir(), ".cache", "ms-playwright")].find((d) => existsSync(d)) ||
    join(homedir(), ".cache", "ms-playwright");
  const dirs = readdirSync(root)
    .filter((d) => d.startsWith("chromium_headless_shell-"))
    .sort()
    .reverse();
  for (const d of dirs)
    for (const sub of readdirSync(join(root, d))) {
      const exe = join(root, d, sub, "chrome-headless-shell");
      if (existsSync(exe)) return exe;
    }
  throw new Error("aucun chrome-headless-shell dans " + root + " (bunx playwright-core install chromium-headless-shell)");
}

const steps: string[] = [];
const mark = (s: string) => {
  steps.push(s);
  console.log("  ok  " + s);
};
const fail = (s: string): never => {
  throw new Error(s);
};

async function run() {
  const mock = spawn("bun", [join(import.meta.dir, "mock-gateway.ts")], {
    env: { ...process.env, MOCK_TICK_MS: process.env.MOCK_TICK_MS || "60", PORT: String(PORT), ...(APP_DIR ? { APP_DIR } : {}) },
    stdio: "pipe",
  });
  mock.stderr.on("data", (d) => process.stderr.write(d));
  try {
    for (let i = 0; i < 100; i++) {
      try {
        if ((await fetch(BASE + "/bots/index.html")).ok) break;
      } catch {}
      await Bun.sleep(100);
      if (i === 99) fail("le mock ne démarre pas");
    }
    const browser = await chromium.launch({ executablePath: chromePath() });
    const ctx = await browser.newContext({ baseURL: BASE, serviceWorkers: "block", viewport: { width: 390, height: 800 } });
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
    const page = await ctx.newPage();
    // SMOKE_CPU=4 : processeur ralenti 4 fois (CDP), pour rejouer les courses vues sous forte charge
    if (Number(process.env.SMOKE_CPU) > 1)
      await (await ctx.newCDPSession(page)).send("Emulation.setCPUThrottlingRate", { rate: Number(process.env.SMOKE_CPU) });
    const errors: string[] = [];
    page.on("pageerror", (e) => {
      if (!/volontaire/.test(e.message)) errors.push("pageerror " + e.message);
    });
    page.on("console", (m) => {
      if (m.type() === "error" && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push("console " + m.text());
    });
    let bytes = 0,
      gen = 0;
    // chaque réponse compte pour l'étape où elle arrive : r.body() se résout plus tard (0,13 Mo comptés à tort en CI le 2026-11-16)
    page.on("response", async (r) => {
      const g = gen;
      try {
        const n = (await r.body()).length;
        if (g === gen) bytes += n;
      } catch {}
    });
    page.on("websocket", (ws) =>
      ws.on("framereceived", (f) => {
        bytes += typeof f.payload === "string" ? f.payload.length : f.payload.length;
      })
    );

    // démarrage d'un vrai téléphone : groupes déjà en cache (v76 plantait là) ; poignée de test demandée avant le chargement
    await page.addInitScript(() => {
      localStorage.setItem("bots-test", "true");
      if (!localStorage.getItem("groups-cache"))
        localStorage.setItem(
          "groups-cache",
          JSON.stringify([{ room_id: "cache-1", name: "Groupe en cache", members: [{ member_id: "a", profile: "a", handle: "a" }] }])
        );
    });
    await page.goto("/bots/");
    await page.waitForSelector('[data-testid=entry][data-key="default"]');
    await page.waitForFunction(() => !!(window as any).__bots);
    if (errors.length) fail("démarrage avec groupes en cache : " + errors.slice(0, 2).join(" | "));
    mark("liste des bots affichée (démarrage avec groupes en cache, sans erreur)");

    const T = "[data-testid=thread]";
    const bubbles = () => page.locator(`${T} [data-testid=bubble]`);
    const bubbleWith = (text: string | RegExp) => page.locator(`${T} [data-testid=bubble]`, { hasText: text }).first();
    const sub = () =>
      page
        .locator("[data-testid=status]")
        .textContent()
        .then((t) => t || "");
    const subIs = (re: RegExp, timeout = 15000) =>
      page.waitForFunction((src) => new RegExp(src).test(document.querySelector("[data-testid=status]")?.textContent || ""), re.source, { timeout });
    const subNot = (re: RegExp, timeout = 15000) =>
      page.waitForFunction((src) => !new RegExp(src).test(document.querySelector("[data-testid=status]")?.textContent || ""), re.source, { timeout });
    const idle = () =>
      page.waitForFunction(
        () => {
          const c = (window as any).__bots.conv();
          return !!c && !(c.kind === "room" ? c.gs.busy : c.ui.busy);
        },
        null,
        { timeout: 15000 }
      );
    const open = async (key: string) => {
      await page.locator(`[data-testid=entry][data-key="${key}"], [data-testid=pin][data-key="${key}"]`).first().click();
      await page.waitForSelector("[data-testid=chat]");
    };
    const say = async (text: string) => {
      await page.fill("[data-testid=input]", text);
      await page.click("[data-testid=send]");
    };
    const back = async () => {
      await page.click('[data-testid=chat] header [aria-label="Retour"]');
      await page.waitForFunction(() => !(window as any).__bots.conv() && !document.querySelector(".pane-list.hide"));
    };
    // réponse qui s'écrit (parité seule et groupe, 2026-11-18) : longueurs successives des bulles avec curseur, relevées toutes les 40 ms
    const watchGrowth = (sel: string) =>
      page.evaluate((s) => {
        const w = window as any;
        w.__grow = {};
        clearInterval(w.__growT);
        w.__growT = setInterval(
          () =>
            document.querySelectorAll(s).forEach((b, i) => {
              const k = (b as HTMLElement).dataset.key || String(i),
                n = (b.textContent || "").length;
              const a = (w.__grow[k] ??= []);
              if (n && a[a.length - 1] !== n) a.push(n);
            }),
          40
        );
      }, sel);
    const growth = (): Promise<number[][]> =>
      page.evaluate(() => {
        const w = window as any;
        clearInterval(w.__growT);
        return Object.values(w.__grow || {}) as number[][];
      });
    const clientLogs = async () => (await (await fetch(BASE + "/api/mock/clientlogs")).json()) as any[];

    // remonter tout en haut du fil : des lignes plus anciennes apparaissent au-dessus, la bulle lue reste à sa place à l'écran.
    // Même composant en conversation seule (page demandée au gateway) et en groupe (fenêtre élargie) : le contrôle tourne dans les deux parties.
    const keepsPlace = async (what: string) => {
      const nBefore = await bubbles().count();
      await Bun.sleep(500);
      // ligne suivie : la première ligne de message visible en haut, retrouvée par sa clé (unique). Une bulle plus bas, cherchée
      // par son texte, pouvait être mesurée sur une mise en page jamais peinte (lignes encore à leur taille estimée, content-visibility).
      const { key, top0 } = await page.evaluate((t) => {
        const l = document.querySelector(t)!;
        l.scrollTop = 0;
        const lt = l.getBoundingClientRect().top;
        const r = [...l.querySelectorAll<HTMLElement>(":scope > [data-key]")].find((e) => e.getBoundingClientRect().bottom > lt)!;
        return { key: r.dataset.key!, top0: r.getBoundingClientRect().top };
      }, T);
      await page.waitForFunction(([t, n]) => document.querySelectorAll(`${t} [data-testid=bubble]`).length > (n as number), [T, nBefore] as const, {
        timeout: 10000,
      });
      await Bun.sleep(300);
      const top1 = await page.locator(`${T} > [data-key="${key}"]`).evaluate((e) => e.getBoundingClientRect().top);
      if (Math.abs(top1 - top0) > 60) fail(`${what} : la position de lecture a bougé de ${Math.round(top1 - top0)} px`);
      mark(`${what} (${nBefore} -> ${await bubbles().count()} bulles), position conservée`);
    };
    if (PART !== "groups") {
      // ---- partie bots : conversation de 20 000 messages, bot, blocs, reconnexion ----
      // 1. conversation de taille réelle : rapide, légère, fenêtrée
      bytes = 0;
      gen++;
      const t0 = Date.now();
      await open("archive");
      await bubbleWith("FIN-DU-FIL").waitFor({ timeout: 30000 });
      const dt = Date.now() - t0,
        count = await bubbles().count();
      if (dt > T_OPEN_BIG_MS) fail(`ouverture d'une conversation de 20 000 messages : ${dt} ms (limite ${T_OPEN_BIG_MS})`);
      if (bytes > MAX_BYTES) fail(`ouverture d'une conversation de 20 000 messages : ${(bytes / 1e6).toFixed(1)} Mo transférés (limite ${MAX_BYTES / 1e6})`);
      if (count > MAX_BUBBLES) fail(`${count} bulles dans le DOM (limite ${MAX_BUBBLES})`);
      mark(`conversation de 20 000 messages ouverte en ${dt} ms, ${(bytes / 1e6).toFixed(2)} Mo, ${count} bulles`);
      await back();

      // 1b. rouvrir : le cache IndexedDB affiche tout de suite, seul un petit delta est demandé
      bytes = 0;
      gen++;
      const t1 = Date.now();
      await open("archive");
      await bubbleWith("FIN-DU-FIL").waitFor({ timeout: 30000 });
      const shown2 = Date.now() - t1;
      await subNot(/mise à jour|connexion/);
      const hits: string[] = await (await fetch(BASE + "/api/mock/rest")).json();
      const lastHit = hits.at(-1) || "";
      if (!/limit=40\b/.test(lastHit)) fail("la réouverture doit ne demander que les 40 derniers messages, reçu : " + lastHit);
      if (bytes > 100_000) fail(`la réouverture a transféré ${(bytes / 1e6).toFixed(2)} Mo, le cache devrait suffire`);
      mark(`conversation rouverte en ${shown2} ms depuis le cache, ${(bytes / 1000).toFixed(0)} Ko (${lastHit.split("?")[1]})`);

      // 1c. remonter le fil : les messages plus anciens arrivent, la position de lecture reste
      await keepsPlace("messages plus anciens chargés");
      await back();

      // 2. un bot : ouvrir, envoyer, recevoir
      await open("default");
      await bubbleWith("Build").waitFor({ timeout: 10000 });
      mark("bot ouvert avec son historique");
      // fiche du bot : profil lu sur le gateway (modèle, compétences actives), fichiers touchés tirés des actions du fil
      await page.click('[data-testid=chat] [aria-label="Réglages du bot"]');
      const prof = page.locator("[data-testid=bot-profile]");
      await prof.locator(".kv", { hasText: "mock-1" }).waitFor({ timeout: 5000 });
      const pt = (await prof.textContent()) || "";
      if (!/recherche/.test(pt) || /vieux-skill/.test(pt) || !/drive/.test(pt))
        fail(`fiche du bot : compétences ou connecteurs mal lus : « ${pt.slice(0, 160)} »`);
      const nFiles = await page.locator("[data-testid=bot-files] .file-row").count();
      if (!(await page.locator("[data-testid=bot-files] .file-row", { hasText: "package.json" }).count()))
        fail("fiche du bot : package.json, lu dans le fil, absent des fichiers touchés");
      await page.click('[data-testid=bot-sheet] [aria-label="Retour"]');
      await page.locator("[data-testid=bot-sheet]").waitFor({ state: "detached", timeout: 3000 });
      mark(`fiche du bot : modèle, compétences actives, connecteurs ; ${nFiles} fichier(s) touché(s) listé(s)`);
      const stamp = await page.locator(`${T} .row time.ts`).first().textContent();
      if (!/^\d{1,2} \S+ (\d{4} )?\d{2}:\d{2}$/.test(stamp || "")) fail(`date absente sous le message : « ${stamp} »`);
      mark(`date et heure sous chaque message (« ${stamp} »)`);
      await page.evaluate(() => {
        const w = window as any;
        w.__long = [];
        new PerformanceObserver((l) => {
          for (const e of l.getEntries()) w.__long.push(Math.round(e.duration));
        }).observe({ type: "longtask" });
      });
      await watchGrowth(`${T} [data-testid=bubble].cursor`);
      await say("smoke-un");
      await bubbleWith("Bien reçu : « smoke-un »").waitFor({ timeout: 15000 });
      await idle();
      const grow1 = (await growth()).sort((a, b) => b.length - a.length)[0] || [];
      if (grow1.length < 3) fail(`conversation seule : la réponse ne s'écrit pas en direct (longueurs vues avec curseur : ${JSON.stringify(grow1)})`);
      if (await page.locator(`${T} [data-testid=bubble].cursor`).count()) fail("conversation seule : curseur resté après la fin de la réponse");
      mark(
        `conversation seule : la réponse s'écrit en direct (${grow1.length} états, ${grow1[0]} -> ${grow1[grow1.length - 1]} signes), curseur retiré à la fin`
      );
      const long: number[] = await page.evaluate(() => (window as any).__long);
      if (long.some((d) => d > 50)) fail(`image de plus de 50 ms pendant le streaming : ${long.join(", ")} ms (cible v88)`);
      mark(`message envoyé, réponse reçue en entier ; aucune tâche de plus de 50 ms pendant le streaming (plus longue : ${Math.max(0, ...long)} ms)`);
      // répondre à un message dans la conversation d'un bot (pas seulement en groupe)
      await bubbleWith("Bien reçu : « smoke-un »").click({ button: "right" });
      const replyBtn = page.locator("[data-testid=msg-menu] [data-a=reply]");
      if (!(await replyBtn.isVisible())) fail("« Répondre » absent du menu d'un message de bot");
      await replyBtn.click();
      await page.locator("[data-testid=reply]").waitFor({ timeout: 3000 });
      await say("smoke-reponse");
      await page.locator(`${T} .row.user [data-testid=bubble] .rq`, { hasText: "smoke-un" }).last().waitFor({ timeout: 10000 });
      await idle();
      mark("réponse à un message : cadre de citation dans ma bulle");
      await page.locator(`${T} .row.user [data-testid=bubble] .rq.in`, { hasText: "smoke-un" }).last().click();
      await page.locator(`${T} [data-testid=bubble].hl`, { hasText: "Bien reçu : « smoke-un »" }).waitFor({ timeout: 5000 });
      mark("toucher la citation amène au message cité");

      // 2a. ligne d'action : les outils du tour repliés en « ✓ … » (maquette v88)
      const act = page.locator(`${T} [data-testid=actions]`).last();
      if (await act.count()) {
        const line = (await act.locator("summary").first().textContent()) || "";
        if (!/^[✓✕]/.test(line.trim())) fail(`ligne d'action sans coche : « ${line} »`);
        mark(`ligne d'action repliée : « ${line.trim()} »`);
      }

      // 2b. blocs visuels : un bloc bots-ui devient des cartes, un bloc invalide reste du texte, un bouton envoie un message
      await say("recap");
      const ui = page.locator(`${T} [data-testid=bubble]`, { has: page.locator(".ui-recap") }).last();
      await ui.waitFor({ timeout: 20000 });
      await idle();
      const seen = await ui.evaluate((b) => ({
        title: b.querySelector(".ui-recap .ui-t")?.textContent,
        total: b.querySelector(".ui-tot b")?.textContent,
        lines: b.querySelectorAll(".ui-bl").length,
        steps: b.querySelectorAll(".ui-steps li").length,
        btns: b.querySelectorAll(".ui-choice").length,
        secs: [...b.querySelectorAll(".ui-sec-t")].map((e) => e.textContent),
        bad: b.querySelector("pre.ui-bad")?.textContent || "",
        pending: !!b.querySelector(".ui-pending"),
        raw: b.querySelector("details.ui-raw summary")?.textContent,
        rawOpen: (b.querySelector("details.ui-raw") as HTMLDetailsElement | null)?.open,
        rawText: b.querySelector("details.ui-raw pre")?.textContent || "",
        gauge: b.querySelector(".ui-gl .warn")?.textContent,
      }));
      if (seen.title !== "Lyon" || seen.lines !== 6 || seen.steps !== 3 || seen.btns !== 2) fail("blocs mal rendus : " + JSON.stringify(seen));
      if (seen.total?.replace(/[\s ]/g, " ") !== "1 196 à 1 541 €") fail(`total du budget calculé par l'app attendu « 1 196 à 1 541 € », lu « ${seen.total} »`);
      if (!/pas une liste/.test(seen.bad) || seen.pending) fail("le bloc invalide doit rester en texte brut : " + JSON.stringify(seen));
      if (seen.raw !== "Carte illisible, voir le brut" || seen.rawOpen || !/brut-garde/.test(seen.rawText))
        fail("carte illisible : brut attendu replié sous « voir le brut » : " + JSON.stringify(seen));
      if (seen.secs.join("|") !== "Décidé|Écarté") fail("sections en gras non mises en cartes : " + seen.secs.join("|"));
      mark(
        `blocs rendus : récap, budget (total ${seen.total}, ${seen.gauge}), étapes, actions ; bloc invalide en texte ; carte illisible repliée ; sections ${seen.secs.join(", ")}`
      );
      await ui.locator(".ui-choice", { hasText: "Voir les messages du voyage" }).click();
      await page.locator(`${T} .row.user [data-testid=bubble]`, { hasText: "bloc-choix-voyage" }).waitFor({ timeout: 10000 });
      await bubbleWith("Bien reçu : « bloc-choix-voyage »").waitFor({ timeout: 15000 });
      if (!(await ui.locator(".ui-choice:disabled").count())) fail("les boutons du bloc doivent se griser après un choix");
      if ((await page.inputValue("[data-testid=input]")) !== "") fail("le bouton a laissé du texte dans la saisie");
      mark("bouton de choix : message envoyé à ma place, réponse reçue, boutons grisés");
      await idle();
      await back();

      // 3. rouvrir : l'échange est là
      await open("default");
      await bubbleWith("smoke-un").waitFor({ timeout: 10000 });
      await subNot(/mise à jour|connexion/);
      if (!(await page.locator(`${T} [data-testid=bubble]`, { hasText: "Bien reçu : « smoke-un »" }).count())) fail("réponse absente après réouverture");

      // 3a. /undo : le dernier échange part, sans relire tout le fil (session.history renvoyait 38 Mo)
      const sentRpc: string[] = [];
      page.on("websocket", (ws) =>
        ws.on("framesent", (f) => {
          const m = /"method":"([^"]+)"/.exec(String(f.payload));
          if (m) sentRpc.push(m[1]);
        })
      );
      await say("/undo");
      await page.locator(`${T} [data-testid=card] button.yes`).last().click();
      await page.locator(`${T} [data-testid=note]`, { hasText: "Dernier échange retiré" }).waitFor({ timeout: 15000 });
      if (await page.locator(`${T} [data-testid=bubble]`, { hasText: "Bien reçu : « bloc-choix-voyage »" }).count())
        fail("/undo : le dernier échange est toujours affiché");
      if (!(await page.locator(`${T} [data-testid=bubble]`, { hasText: "Bien reçu : « smoke-un »" }).count()))
        fail("/undo a retiré plus que le dernier échange");
      if (sentRpc.includes("session.history")) fail("/undo appelle encore session.history (tout le fil)");
      mark("/undo : dernier échange retiré par la page paginée, sans session.history");
      mark("bot rouvert : l'échange est conservé");

      // 3b. le réseau tombe : reconnexion avec recul (1 s puis 2 s), état lisible, puis tout remarche
      const before = (await (await fetch(BASE + "/api/mock/tickets")).json()).length;
      await fetch(BASE + "/api/mock/refuse?n=1");
      await fetch(BASE + "/api/mock/drop");
      await subIs(/reconnexion dans 1 s/, 5000);
      await subIs(/reconnexion dans 2 s/, 8000);
      await subIs(/à jour/, 10000);
      const tk: number[] = (await (await fetch(BASE + "/api/mock/tickets")).json()).slice(before);
      const g1 = tk[1] - tk[0];
      if (tk.length < 2 || g1 < 1700 || g1 > 3000) fail(`recul attendu 2 s entre le 1er et le 2e essai, mesuré ${g1} ms sur ${tk.length} essais`);
      mark(`reconnexion : états « reconnexion dans 1 s », « dans 2 s », « à jour » (écart mesuré ${g1} ms)`);
      // coupure pendant l'envoi : le message attend sur le téléphone puis part seul à la reconnexion, une seule fois
      await fetch(BASE + "/api/mock/refuse?n=1");
      await fetch(BASE + "/api/mock/drop");
      await subIs(/reconnexion dans/, 5000);
      await say("smoke-file");
      const queuedB = page.locator(`${T} .row.user [data-testid=bubble]`, { hasText: /^smoke-file$/ });
      if (!(await queuedB.evaluate((b) => b.classList.contains("outbox")))) fail("message écrit pendant la coupure : pas marqué en attente de connexion");
      await bubbleWith("Bien reçu : « smoke-file »").waitFor({ timeout: 15000 });
      if ((await queuedB.count()) !== 1) fail("message écrit pendant la coupure : doublé");
      mark("coupure pendant l'envoi : message en attente de connexion, parti seul au retour, une seule fois");
      await idle();
      await say("smoke-deux");
      await bubbleWith("Bien reçu : « smoke-deux »").waitFor({ timeout: 15000 });
      mark("l'envoi marche après la reconnexion");
      // échec franc (pas une coupure) : la bulle passe en échec avec Réessayer ; le renvoi garde le même identifiant, une seule réponse
      await idle();
      await fetch(BASE + "/api/mock/fail-submit?n=1");
      await say("smoke-echec");
      await page.locator(`${T} [data-testid=retry]`).waitFor({ timeout: 8000 });
      if (!(await bubbleWith("smoke-echec").evaluate((b) => b.classList.contains("err")))) fail("la bulle d'un envoi échoué n'est pas marquée en échec");
      await page.click(`${T} [data-testid=retry]`);
      await bubbleWith("Bien reçu : « smoke-echec »").waitFor({ timeout: 15000 });
      await idle();
      const ids = (await (await fetch(BASE + "/api/mock/uploads")).json()).submits.filter((x: any) => x.text === "smoke-echec").map((x: any) => x.id);
      if (ids.length !== 2 || ids[0] !== ids[1]) fail(`Réessayer doit renvoyer le même identifiant : ${JSON.stringify(ids)}`);
      if (
        (await page.locator(`${T} [data-testid=retry]`).count()) ||
        (await page.locator(`${T} .row.user [data-testid=bubble]`, { hasText: /^smoke-echec$/ }).count()) !== 1
      )
        fail("après Réessayer : bouton encore là ou bulle doublée");
      mark("envoi en échec : bulle marquée, Réessayer renvoie le même identifiant, une seule bulle et une réponse");
      // pendant un tour : Entrée recadre (session.redirect, lu dans le tour), « /q texte » met en file (GLOSSARY.md, 2026-11-17)
      const subs0 = (await (await fetch(BASE + "/api/mock/uploads")).json()).submits.length;
      await idle();
      await say("smoke-long");
      await page.waitForSelector("[data-testid=send].stop", { timeout: 5000 });
      await say("change de cap");
      await bubbleWith("[guidage lu : change de cap]").waitFor({ timeout: 15000 });
      await say("/q plus tard");
      await bubbleWith("Bien reçu : « plus tard »").waitFor({ timeout: 20000 });
      const subs = (await (await fetch(BASE + "/api/mock/uploads")).json()).submits.slice(subs0);
      if (subs.some((x: any) => /change de cap/.test(x.text))) fail("le recadrage est parti comme un nouveau message : " + JSON.stringify(subs));
      const later = subs.find((x: any) => x.text === "plus tard");
      if (!later?.queued) fail("/q n'a pas mis le message en file : " + JSON.stringify(subs));
      mark("pendant un tour : Entrée recadre (lu dans le tour), /q met en file sans la commande");

      // 3c. contrat refusé : invalid_params est réessayé avec les paramètres de base (la panne inline_images du 2026-11-14)
      const snap = await page
        .evaluate(async () => {
          const g = await new (window as any).__bots.Gateway("default").connect();
          const r = await g.call("session.resume", { session_id: "s-default", omit_messages: true, inline_images: false });
          g.ws.close();
          return r.session_id;
        })
        .catch((e) => "ERREUR " + e.message);
      if (!snap || String(snap).startsWith("ERREUR")) fail("invalid_params non réessayé : " + snap);
      mark("invalid_params réessayé sans le paramètre refusé");
      let rep: any[] = [];
      for (let i = 0; i < 30 && !rep.some((r) => /inline_images/.test(r.msg)); i++) {
        await Bun.sleep(100);
        rep = await clientLogs();
      }
      if (!rep.some((r: any) => /inline_images/.test(r.msg))) fail("l'échec invalid_params aurait dû être remonté à /bots/log");
      await back();

      // recherche globale : un mot cherché dans tous les fils du téléphone, le résultat ouvre le bon message
      await page.fill("[data-testid=home] input[type=search]", "smoke-un");
      const hit = page.locator('[data-testid=search-hit][data-key="default"]').first();
      await hit.waitFor({ timeout: 5000 });
      const hitTxt = (await hit.textContent()) || "";
      await hit.click();
      await page.locator(`${T} [data-testid=bubble].hl`, { hasText: "smoke-un" }).waitFor({ timeout: 8000 });
      mark(`recherche globale : « smoke-un » trouvé hors ligne (${hitTxt.slice(0, 50)}…), le message est amené à l'écran`);
      await back();
      await page.fill("[data-testid=home] input[type=search]", "");
      // blocs réels du 2026-11-15 : étiquettes longues, bloc sans "type" ; dessinés en cartes, jamais en JSON brut
      const longBlock = await Bun.file(import.meta.dir + "/fixtures/bots-ui-long-labels.json").text();
      const blocks = (raw: string) =>
        page.evaluate((r) => {
          const d = document.createElement("div");
          d.innerHTML = (window as any).__bots.UiBlocks.render(r);
          return { recap: !!d.querySelector(".ui-recap"), steps: !!d.querySelector(".ui-steps"), bad: d.querySelectorAll(".ui-bad").length };
        }, raw);
      const lb = await blocks(longBlock);
      if (!lb.recap || !lb.steps || lb.bad) fail(`bloc aux textes longs mal rendu : ${JSON.stringify(lb)}`);
      mark("bloc aux étiquettes longues dessiné en cartes (récap, étapes), aucun JSON brut");
      const ut = await blocks(
        '{"title": "Ce que le brief disait de faux", "facts": [{"value": "2 packs", "label": "existent bien sur le Drive, 17/11 et 19/11"}, {"value": "-1 h", "label": "horaires lus en UTC et présentés comme locaux"}]}'
      );
      if (!ut.recap || ut.bad) fail(`bloc sans type mal rendu : ${JSON.stringify(ut)}`);
      mark("bloc sans type dessiné en récap, aucun JSON brut");
      // envoi pendant la synchro d'ouverture : l'instantané d'attach ne doit pas effacer l'état du tour lancé (en-tête figé, sans Arrêter)
      await fetch(BASE + "/api/mock/slow-history?ms=1200");
      await page.locator('[data-testid=entry][data-key="rea"], [data-testid=pin][data-key="rea"]').first().click();
      await page.waitForFunction(
        () => {
          const c = (window as any).__bots.conv();
          return !!c?.sid;
        },
        null,
        { timeout: 10000 }
      );
      await say("smoke-ouverture");
      await page
        .locator("[data-testid=thread] .row.assistant", { hasText: "smoke-ouverture" })
        .first()
        .waitFor({ timeout: 10000 })
        .catch(() => fail("envoi pendant l'ouverture : aucune réponse"));
      const raced = (await (await fetch(BASE + "/api/mock/raced")).json()).raced;
      if (raced) fail(`envoi pendant l'ouverture : prompt.submit parti pendant la lecture de l'historique (l'instantané d'attach écrase alors le tour)`);
      await idle();
      await back();
      mark("envoi pendant l'ouverture : la synchro n'efface ni la réponse en cours ni l'état « travaille »");

      // remontées du client côté bots : le bloc bots-ui invalide et le refus inline_images signalés, rien d'autre
      {
        let rep: any[] = [];
        for (let i = 0; i < 30 && !rep.some((r) => r.kind === "bots-ui"); i++) {
          await Bun.sleep(100);
          rep = await clientLogs();
        }
        if (!rep.some((r) => r.kind === "bots-ui" && /budget/.test(r.msg))) fail("le bloc bots-ui invalide aurait dû être remonté à /bots/log");
        const other = rep.filter((r) => !/inline_images|provider_unavailable/.test(r.msg) && r.kind !== "bots-ui");
        if (other.length)
          fail(
            "le client a remonté des erreurs : " +
              other
                .slice(0, 2)
                .map((r: any) => r.kind + " " + r.msg)
                .join(" | ")
          );
      }
      if (errors.length) fail("erreurs du client (partie bots) : " + errors.slice(0, 3).join(" | "));
    }

    if (PART !== "bots") {
      // ---- partie groupes ----
      // 3b. groupe de 300 messages : remonter le fil garde la position, comme dans « archive »
      await page.waitForSelector('[data-testid=entry][data-key="room:r-long"]');
      await open("room:r-long");
      await bubbleWith("FIN-DU-GROUPE").waitFor({ timeout: 10000 });
      await keepsPlace("groupe : messages plus anciens affichés");
      await back();
      // 4. un groupe
      await page.waitForSelector('[data-testid=entry][data-key="room:r-cours"]');
      await open("room:r-cours");
      await bubbleWith("déroulé").waitFor({ timeout: 10000 });
      await say("smoke-groupe");
      await bubbleWith("bien reçu « smoke-groupe »").waitFor({ timeout: 15000 });
      mark("groupe ouvert, message envoyé, réponse d'un membre");
      // deux relevés qui se croisent sur le même curseur ne doublent aucun message
      await page.evaluate(async () => {
        const B = (window as any).__bots,
          g = B.conv();
        g.cursor = 0;
        await Promise.all([B.groups.pollGroup(g), B.groups.pollGroup(g)]);
      });
      const nMine = await page.locator(`${T} .row.user [data-testid=bubble]`, { hasText: /^smoke-groupe$/ }).count();
      if (nMine !== 1) fail(`message du groupe affiché ${nMine} fois`);
      mark("relevés simultanés : chaque message affiché une seule fois");
      // hors ligne dans un groupe : le message attend sur le téléphone puis part seul au retour, une seule fois
      // le mock refuse la reconnexion (comme la partie bots) : coupé à la main, le socket revenait en 1 s et, Mac chargé, avant l'envoi (2026-11-18)
      await fetch(BASE + "/api/mock/refuse?n=2");
      await fetch(BASE + "/api/mock/drop");
      await page.waitForFunction(() => !(window as any).__bots.roster.gw?.up);
      // deux messages : avant la v99 le second écrasait le premier, resté en attente pour toujours
      await say("smoke-hors-ligne");
      await say("smoke-hors-ligne-2");
      for (const t of ["smoke-hors-ligne", "smoke-hors-ligne-2"]) {
        const off = page.locator(`${T} .row.user [data-testid=bubble]`, { hasText: new RegExp(`^${t}$`) });
        if (!(await off.evaluate((b) => b.classList.contains("outbox"))))
          fail(`message de groupe écrit hors ligne (${t}) : pas marqué en attente de connexion`);
      }
      for (const t of ["smoke-hors-ligne", "smoke-hors-ligne-2"]) {
        await bubbleWith(`bien reçu « ${t} »`).waitFor({ timeout: 15000 });
        const off = page.locator(`${T} .row.user [data-testid=bubble]`, { hasText: new RegExp(`^${t}$`) });
        if ((await off.count()) !== 1 || (await off.evaluate((b) => b.classList.contains("outbox"))))
          fail(`message hors ligne (${t}) : doublé ou resté en attente après le retour`);
      }
      const kept = await page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => k.startsWith("group-intent"))
          .map((k) => localStorage.getItem(k))
      );
      if (kept.length) fail(`messages hors ligne encore gardés après leur envoi : ${kept.join(" ")}`);
      mark("groupe hors ligne : deux messages gardés « en attente de connexion », partis dans l'ordre au retour, affichés une fois");
      await idle();
      // accord depuis la notification : app en arrière-plan, la notif porte Autoriser ; le choix arrive par le service worker
      await page.evaluate(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }));
      await say("supprime les vieux fichiers");
      const nid = await page.evaluate(async () => {
        const B = (window as any).__bots;
        for (let i = 0; i < 40 && !B.notifAnswers.size; i++) {
          await B.groups.pollGroup(B.conv());
          await new Promise((r) => setTimeout(r, 150));
        }
        return [...B.notifAnswers.keys()].at(-1) || "";
      });
      if (!nid) fail("accord de groupe en arrière-plan : aucune notification avec Autoriser");
      const applied = await page.evaluate(
        (id) => (window as any).__bots.onSwMessage({ answer: id, choice: "once", bot: (window as any).__bots.conv().key }),
        nid
      );
      await page.evaluate(() => {
        delete (document as any).hidden;
      });
      if (!applied) fail("le choix fait dans la notification n'a pas été appliqué");
      await page.locator(`${T} [data-testid=card] [data-testid=card-done]`, { hasText: "Autorisé" }).last().waitFor({ timeout: 5000 });
      mark("accord depuis la notification : Autoriser touché dans la notif, carte réglée « ✓ Autorisé » sans ouvrir l'app");
      await page.evaluate(() => (window as any).__bots.groups.pollGroup((window as any).__bots.conv()));
      await idle();
      // commandes / du groupe : suggérées comme les @, exécutées par la PWA, jamais envoyées aux bots
      await page.fill("[data-testid=input]", "");
      await page.type("[data-testid=input]", "/ren");
      await page.locator("[data-testid=suggest] button", { hasText: "/renommer" }).click();
      if ((await page.inputValue("[data-testid=input]")) !== "/renommer ") fail("la suggestion /renommer n'a pas rempli la saisie");
      await page.type("[data-testid=input]", "Prépa TP");
      await page.click("[data-testid=send]");
      await page.locator("[data-testid=chat-name]", { hasText: "Prépa TP" }).waitFor({ timeout: 5000 });
      if (await page.locator(`${T} .row.user [data-testid=bubble]`, { hasText: "/renommer" }).count()) fail("/renommer envoyé aux bots");
      mark("groupe : /ren suggère /renommer, la commande renomme sans rien envoyer");
      await say("recap groupe");
      const gui = page.locator(`${T} .row.member [data-testid=bubble]`, { has: page.locator(".ui-todo .ui-choice") }).last();
      await gui.waitFor({ timeout: 15000 });
      await gui.locator(".ui-choice", { hasText: "Nova n'a jamais mordu" }).click();
      await bubbleWith("bien reçu « Nova n'a jamais mordu »").waitFor({ timeout: 15000 });
      mark("groupe : blocs rendus dans la bulle d'un membre, le bouton envoie au groupe");
      await idle();
      // deux bots au travail en même temps : deux avatars dans la barre et « en parallèle »
      const par = await page.evaluate(async () => {
        const B = (window as any).__bots,
          g = B.conv(),
          ms = g.gs.room.members;
        g.setGs("dispatch", [{ bot: ms[1].profile, status: "running" }]);
        B.groups.renderDriver(g, { working: true, member_activity: [{ member_id: ms[0].member_id, status: "running" }] });
        await new Promise(requestAnimationFrame);
        const bar = document.querySelector("[data-testid=group-bar]");
        const r = { av: bar?.querySelectorAll(".grp-stack > *").length, txt: bar?.querySelector(".grp-txt")?.textContent, shown: !!bar };
        g.setGs("dispatch", []);
        B.groups.renderDriver(g, { working: false, member_activity: [] });
        return r;
      });
      if (par.av !== 2 || !/en parallèle/.test(par.txt || "") || !par.shown) fail(`barre de travail parallèle : ${JSON.stringify(par)}`);
      mark("deux bots au travail : deux avatars et « travaillent en parallèle »");
      // « attend son tour » vient de la file réelle du moteur (member_activity queued), jamais d'une relecture des @ (défaut 1 du 2026-11-16)
      const seq = await page.evaluate(async () => {
        const B = (window as any).__bots,
          g = B.conv(),
          ms = g.gs.room.members,
          keep = g.events;
        g.events = [
          ...keep,
          { kind: "message.user", payload: { thread_id: "T", text: "go" } },
          {
            kind: "message.member",
            actor: { kind: "member", id: ms[0].member_id },
            payload: { thread_id: "T", text: `@${ms[1].handle}, vas-y en parallèle.` },
          },
        ];
        const look = async () => {
          await new Promise(requestAnimationFrame);
          const bar = document.querySelector("[data-testid=group-bar]");
          return { av: bar?.querySelectorAll(".grp-wait").length ?? 0, txt: bar?.querySelector(".grp-txt")?.textContent || "" };
        };
        B.groups.renderDriver(g, { working: true, member_activity: [{ member_id: ms[0].member_id, status: "running", thread_id: "T" }] });
        const cited = await look();
        B.groups.renderDriver(g, {
          working: true,
          member_activity: [
            { member_id: ms[0].member_id, status: "running", thread_id: "T" },
            { member_id: ms[1].member_id, status: "queued", thread_id: "T" },
          ],
        });
        const queued = await look();
        B.groups.renderDriver(g, { working: true, member_activity: [{ member_id: ms[0].member_id, status: "queued", thread_id: "T" }] });
        const alone = await look();
        g.events = keep;
        B.groups.renderDriver(g, { working: false, member_activity: [] });
        return { cited, queued, alone };
      });
      if (seq.cited.av !== 0 || /attend/.test(seq.cited.txt)) fail(`« attend son tour » sans tâche en file : ${JSON.stringify(seq.cited)}`);
      if (seq.queued.av !== 1 || !/attend son tour/.test(seq.queued.txt)) fail(`bot en file du moteur non affiché : ${JSON.stringify(seq.queued)}`);
      if (/attend/.test(seq.alone.txt) || seq.alone.av !== 0)
        fail(`seul en file, personne au travail : « ${seq.alone.txt} » (il démarre, il n'attend personne)`);
      mark("« attend son tour » seulement pour une tâche en file du moteur, derrière un bot qui travaille, pas pour un simple @");
      // deux bots cités par Yoan, groupe au repos : la voie parallèle les prend (pas la file du moteur)
      const lane = await page.evaluate(() => {
        const { fastLaneMembers } = (window as any).__bots.groups;
        const g: any = {
          gs: {
            context: { routing: "lead", lead_member_id: "a" },
            busy: false,
            driver: {},
            dispatch: [],
            room: { members: ["a", "b", "c"].map((h) => ({ member_id: h, handle: h })) },
          },
        };
        return [fastLaneMembers(g, "@b et @c, allez-y")?.length ?? 0, fastLaneMembers(g, "@b seul")?.length ?? 0];
      });
      if (lane[0] !== 2 || lane[1] !== 0) fail(`voie parallèle au repos : ${JSON.stringify(lane)}`);
      mark("deux bots cités, groupe au repos : envoyés en parallèle");
      // actions passées : au-dessus de la réponse du bot, comme en conversation seule ; plus de panneau « Voir le fil » (Yoan, 2026-11-18)
      const replyRow = page.locator(`${T} .row`, { has: page.locator("[data-testid=bubble]", { hasText: "bien reçu « smoke-groupe »" }) }).first();
      const pastAct = replyRow.locator(".act-line", { hasText: "Recherche web" });
      await pastAct
        .waitFor({ state: "attached", timeout: 8000 })
        .catch(() => fail("réponse passée : la ligne d'action « Recherche web » n'apparaît pas au-dessus de la bulle"));
      await replyRow.scrollIntoViewIfNeeded();
      const apos = await replyRow.evaluate(async (row) => {
        for (let i = 0; i < 10; i++) await new Promise(requestAnimationFrame);
        const b = row.querySelector("[data-testid=bubble]")!.getBoundingClientRect(),
          a = row.querySelector(".act-line")!.getBoundingClientRect();
        return { bx: Math.round(b.x), bt: Math.round(b.top), ax: Math.round(a.x), ab: Math.round(a.bottom) };
      });
      if (apos.ab > apos.bt + 1 || Math.abs(apos.ax - apos.bx) > 2)
        fail(`ligne d'action mal placée (au-dessus de la bulle, alignée) : ${JSON.stringify(apos)}`);
      if (await page.locator("[data-testid=trace-btn], [data-testid=trace]").count()) fail("il reste un bouton ou un panneau « Voir le fil »");
      await pastAct.locator("summary").first().click();
      await pastAct.locator(".tool summary", { hasText: "Recherche web" }).click();
      const outShown = await pastAct.locator(".tool pre").first().textContent();
      if (outShown !== "3 résultats") fail(`sortie dépliée : « ${outShown} »`);
      mark("réponse passée : « Recherche web → sources du cours » au-dessus de la bulle, sortie dépliée (« 3 résultats »), aucun panneau « Voir le fil »");
      // long message d'un membre : replié ; le toucher l'agrandit puis le réduit ; « Afficher tout » sous la bulle, pas sous l'avatar (2026-11-18)
      const longKey = await page.evaluate(() => {
        const g = (window as any).__bots.conv(),
          who = g.thread.items.find((i: any) => i.k === "msg" && i.who && i.role === "assistant").who;
        g.thread.addMsg("assistant", "Long rapport smoke. " + "Une ligne de détail assez longue pour remplir le message. ".repeat(60));
        const m = g.thread.items.at(-1);
        g.thread.patch(m.key, { who });
        return m.key;
      });
      const longB = page.locator(`${T} [data-testid=bubble][data-key="${longKey}"]`);
      await longB.waitFor({ timeout: 5000 });
      if (!(await longB.evaluate((b) => b.classList.contains("folded")))) fail("le long message n'est pas replié");
      const foldBtn = page.locator(`${T} .row[data-key="${longKey}"] [data-testid=fold]`);
      await foldBtn.waitFor({ timeout: 5000 });
      await longB.scrollIntoViewIfNeeded(); // hors écran, content-visibility ne met pas la ligne en page
      const pos = await page.evaluate(async (k) => {
        // mesure dans la même image : le fil défile pendant l'arrivée du message
        const r = (sel: string) => {
          const x = document.querySelector(sel)!.getBoundingClientRect();
          return { x: Math.round(x.x), top: Math.round(x.top), bottom: Math.round(x.bottom) };
        };
        const m = () => ({
          b: r(`[data-testid=thread] [data-testid=bubble][data-key="${k}"]`),
          f: r(`[data-testid=thread] .row[data-key="${k}"] [data-testid=fold]`),
        });
        // content-visibility remet la ligne en page quelques images après le défilement : attendre la mise en page finale (1 s au plus)
        let v = m();
        for (let i = 0; i < 60 && v.f.top < v.b.bottom - 1; i++) {
          await new Promise(requestAnimationFrame);
          v = m();
        }
        return v;
      }, longKey);
      if (Math.abs(pos.f.x - pos.b.x) > 2 || pos.f.top < pos.b.bottom - 1) fail(`« Afficher tout » mal placé : ${JSON.stringify(pos)}`);
      await longB.click({ position: { x: 40, y: 60 } });
      if (await longB.evaluate((b) => b.classList.contains("folded"))) fail("toucher le long message ne l'a pas agrandi");
      if (await page.locator("[data-testid=trace]").count()) fail("toucher le long message a ouvert le fil");
      // agrandir le dernier message alors que le fil suit le bas ne doit pas sauter à la fin du message (2026-11-18)
      const topGap = await longB.evaluate(async (b) => {
        for (let i = 0; i < 6; i++) await new Promise(requestAnimationFrame);
        return Math.round(b.getBoundingClientRect().top - b.closest(".log")!.getBoundingClientRect().top);
      });
      if (topGap < -2) fail(`agrandir a fait défiler jusqu'à la fin du message (haut de la bulle à ${topGap} px du haut du fil)`);
      if ((await foldBtn.textContent()) !== "Réduire") fail(`bouton après agrandissement : « ${await foldBtn.textContent()} »`);
      await longB.click({ position: { x: 40, y: 60 } });
      if (!(await longB.evaluate((b) => b.classList.contains("folded")))) fail("toucher de nouveau ne l'a pas réduit");
      mark("long message : toucher l'agrandit puis le réduit, « Afficher tout » sous la bulle, aucun fil ouvert");
      // réponse sans outil : aucune ligne d'action
      const bareRow = page.locator(`${T} .row`, { has: page.locator("[data-testid=bubble]", { hasText: "Oui, je fais le" }) }).first();
      if (await bareRow.locator(".act-line").count()) fail("une réponse sans fil affiche une ligne d'action");
      mark("réponse sans outil : pas de ligne d'action");
      // fil de travail 2 : deux bots en table ronde ; ouvrir l'un en direct, l'arrêter seul, l'autre continue
      const room = await page.evaluate(() => (window as any).__bots.conv().id);
      await watchGrowth(`${T} .row.member [data-testid=bubble].cursor`);
      for (const member_id of ["rea", "default"])
        await fetch(BASE + "/api/mock/round-start", { method: "POST", body: JSON.stringify({ room_id: room, member_id }) });
      await page.waitForFunction(() => document.querySelectorAll("[data-testid=worker]").length === 2, null, { timeout: 8000 });
      // parité avec la conversation seule (Yoan, 2026-11-18) : les outils de chaque bot s'affichent en direct dans le fil du groupe, au nom du bot
      const reaActs = page.locator(`${T} [data-testid=member-actions]`, { has: page.locator(".act-line.run", { hasText: "bun test" }) });
      await page
        .waitForFunction((t) => document.querySelectorAll(`${t} [data-testid=member-actions] .act-line.run`).length >= 2, T, { timeout: 8000 })
        .catch(() => fail("fil du groupe : les outils en cours des deux bots n'apparaissent pas en direct"));
      await reaActs
        .first()
        .waitFor({ state: "attached", timeout: 6000 })
        .catch(async () =>
          fail("fil du groupe : « bun test » en cours absent : " + JSON.stringify(await page.locator(`${T} [data-testid=member-actions]`).allTextContents()))
        );
      if (!(await page.locator(`${T} .row.member [data-testid=bubble]`, { hasText: "Je regarde les fichiers modifiés" }).count()))
        fail("fil du groupe : le texte intermédiaire du bot n'apparaît pas");
      mark("fil du groupe : outils en cours des deux bots en direct (« Commande → bun test »), texte intermédiaire en bulle, comme en conversation seule");
      // réponse finale en direct dans le groupe (Yoan, 2026-11-18) : même bulle qui s'écrit qu'en conversation seule, une par bot
      await page
        .waitForFunction(
          (t) =>
            [...document.querySelectorAll(`${t} .row.member [data-testid=bubble].cursor`)].filter((b) => /Les tests/.test(b.textContent || "")).length === 2,
          T,
          { timeout: 8000 }
        )
        .catch(async () =>
          fail(
            "groupe : la réponse des deux bots ne s'écrit pas en direct : " +
              JSON.stringify(await page.locator(`${T} .row.member [data-testid=bubble]`).allTextContents())
          )
        );
      await Bun.sleep(1200);
      const gg = (await growth()).filter((a) => a.length >= 3);
      if (gg.length < 2) fail(`groupe : texte en direct figé (longueurs vues : ${JSON.stringify(await growth())})`);
      if ((await page.locator(`${T} .row.member [data-testid=bubble]`, { hasText: "Les tests passent" }).count()) !== 2)
        fail("groupe : bulle en direct en double");
      mark(
        `groupe : la réponse de chaque bot s'écrit en direct dans sa bulle, avec curseur (${gg.map((a) => a.length).join(" et ")} états), une bulle par bot`
      );
      // toucher l'avatar de rea : le fil va à ses actions en direct ; « Arrêter Réa » sur son bloc l'arrête seul
      await page.locator('[data-testid=worker][data-worker="rea"]').click();
      const reaBlock = page.locator(`${T} [data-testid=member-actions]`, { has: page.locator("[data-testid=stop-bot]", { hasText: "Réa" }) }).last();
      await page
        .waitForFunction(
          (t) => {
            const l = document.querySelector(t)!.getBoundingClientRect();
            return [...document.querySelectorAll(`${t} [data-testid=stop-bot]`)].some(
              (b) => (b.textContent || "").includes("Réa") && b.getBoundingClientRect().top > l.top && b.getBoundingClientRect().bottom < l.bottom
            );
          },
          T,
          { timeout: 4000 }
        )
        .catch(() => fail("toucher l'avatar de rea n'amène pas ses actions à l'écran"));
      const filTexts = await reaBlock.locator(".tool").allTextContents();
      // après le texte intermédiaire, un nouveau bloc : « Lu → src/main.ts » fini puis « Commande → bun test » en cours
      if (!/^Lu → src\/main\.ts/.test(filTexts[0] || "") || !/Commande → bun test/.test(filTexts[1] || "")) fail(`bloc de rea : ${JSON.stringify(filTexts)}`);
      await reaBlock.locator("[data-testid=stop-bot]").click();
      let stops: any[] = [];
      for (let i = 0; i < 30 && !stops.length; i++) {
        stops = await (await fetch(BASE + "/api/mock/stops")).json();
        if (!stops.length) await Bun.sleep(100);
      }
      if (stops.length !== 1 || stops[0].method !== "member.stop" || stops[0].member_id !== "rea") fail(`arrêt d'un seul bot : ${JSON.stringify(stops)}`);
      await page.waitForFunction(() => document.querySelectorAll("[data-testid=worker]").length === 1, null, { timeout: 8000 });
      const left = await page.locator("[data-testid=worker]").getAttribute("data-worker");
      if (left !== "default") fail(`après l'arrêt de rea, il devait rester default : ${left}`);
      mark("avatar de rea : le fil va à ses actions en direct ; « Arrêter Réa » l'arrête seul, default continue");
      // tableau du groupe : un message envoyé ne crée pas de tâche (le meneur les inscrit) ; ajout, déplacer, rouvrir depuis le kanban
      await page.locator("[data-testid=tasks-btn]").waitFor({ timeout: 5000 });
      await page.click("[data-testid=tasks-btn]");
      const tasks = page.locator("[data-testid=tasks]");
      await tasks.locator(".kb-col.todo").waitFor({ timeout: 5000 });
      if (await tasks.locator("[data-testid=task]", { hasText: "smoke-groupe" }).count())
        fail("un message envoyé a créé une tâche (c'est au meneur de les inscrire)");
      await page.fill("[data-testid=task-new]", "Recruter un expert réseau");
      await page.click("[data-testid=task-add]");
      const card = (col: string) => tasks.locator(`.kb-col.${col} [data-testid=task]`, { hasText: "Recruter un expert réseau" });
      await card("todo").waitFor({ timeout: 5000 });
      await card("todo").click({ position: { x: 10, y: 10 } });
      await tasks.locator("[data-testid=task].open [data-to=done]").click();
      await card("done").waitFor({ state: "attached", timeout: 5000 });
      const badge = await page.evaluate(() => document.querySelector("[data-testid=tasks-count]")?.textContent ?? "");
      await card("done").click({ position: { x: 10, y: 10 } });
      await tasks.locator("[data-testid=task].open [data-to=todo]").click();
      await card("todo").waitFor({ state: "attached", timeout: 5000 });
      await page.click("[data-testid=tasks-close]");
      if (badge !== "" && !/^\d+$/.test(badge)) fail(`compteur de tâches ouvertes illisible : « ${badge} »`);
      mark("tableau : un message ne crée pas de tâche ; ajout, déplacée en « Faite » puis rouverte depuis le kanban");
      // message en file : le groupe travaille, aucun événement du moteur ne cite le message → « en attente »
      const q = await page.evaluate(async () => {
        const B = (window as any).__bots,
          g = B.conv(),
          last = [...g.events].reverse().find((e: any) => e.kind === "message.user");
        const saved = g.events;
        g.events = saved.filter((e: any) => e.payload?.discussion_event_id !== last.event_id);
        g.setGs("busy", true);
        B.groups.markQueued(g);
        await new Promise(requestAnimationFrame);
        const m = g.thread.items.find((i: any) => i.k === "msg" && i.eid === last.event_id);
        const row = m && document.querySelector(`[data-testid=thread] .row[data-key="${m.key}"]`);
        const r = { queued: !!row?.classList.contains("in-queue"), caption: row?.querySelector("[data-testid=bubble]")?.getAttribute("data-wait") || "" };
        g.events = saved;
        g.setGs("busy", false);
        B.groups.markQueued(g);
        await new Promise(requestAnimationFrame);
        return { ...r, after: !!row?.classList.contains("in-queue") };
      });
      if (!q.queued || !/en attente/.test(q.caption) || q.after) fail(`message en file : ${JSON.stringify(q)}`);
      mark("message pas encore pris par le moteur : affiché « en attente »");
      const lastNote = (ev: any) =>
        page.evaluate(async (e) => {
          const B = (window as any).__bots;
          B.groups.renderRoomEvent(B.conv(), e);
          await new Promise(requestAnimationFrame);
          return [...document.querySelectorAll("[data-testid=thread] [data-testid=note]")].at(-1)?.textContent || "";
        }, ev);
      const m0 = await page.evaluate(() => (window as any).__bots.conv().gs.room.members[0].member_id);
      const deferred = await lastNote({
        kind: "turn.deferred",
        actor: { kind: "gateway", id: "install:abc" },
        payload: { member_id: m0, reason: "member_unavailable" },
      });
      if (/install:/.test(deferred) || !deferred) fail(`tour en attente : nom du gateway affiché au lieu du bot : « ${deferred} »`);
      mark("tour en attente : le nom du bot, pas l'identifiant du gateway");
      const stalled = await lastNote({
        kind: "member.unavailable",
        actor: { kind: "gateway", id: "install:abc" },
        payload: { error: "Members could not be woken: turn_id is not a Discussion coordinate", reason_code: "prepare_failed" },
      });
      if (/install:/.test(stalled) || !/turn_id is not a Discussion coordinate/.test(stalled)) fail(`préparation bloquée : cause cachée : « ${stalled} »`);
      mark("préparation bloquée : la cause du gateway est affichée");
      // Arrêter du groupe arrête aussi la table ronde
      await page.click("[data-testid=group-stop]");
      await page.waitForFunction(() => !document.querySelector("[data-testid=worker]"), null, { timeout: 8000 });
      const stops2 = await (await fetch(BASE + "/api/mock/stops")).json();
      if (!stops2.some((x: any) => x.method === "dispatch.stop" && x.room_id === room))
        fail(`Arrêter du groupe n'a pas arrêté la table ronde : ${JSON.stringify(stops2)}`);
      mark("fil de travail : Arrêter du groupe arrête aussi la table ronde");
      // rouvrir le groupe sans réseau : les messages viennent du cache du téléphone
      await back();
      await page.evaluate(() => {
        const B = (window as any).__bots,
          gw = B.roster.gw;
        gw._call = gw.call;
        gw.call = (m: string, ...a: any[]) => (m.startsWith("groups.") ? new Promise(() => {}) : gw._call(m, ...a));
        B.groups.openGroup("r-cours", () => {});
      });
      await bubbleWith("smoke-groupe").waitFor({ timeout: 3000 });
      await page.evaluate(() => {
        const gw = (window as any).__bots.roster.gw;
        gw.call = gw._call;
      });
      mark("groupe rouvert hors ligne : messages affichés depuis le cache");
      // le choix déjà fait reste figé après réouverture : plus aucun bouton actif, le choix retenu marqué
      const reopened = page.locator(`${T} .row.member [data-testid=bubble]`, { has: page.locator(".ui-todo .ui-choice") }).last();
      await reopened.locator(".ui-choice.chosen", { hasText: "Nova n'a jamais mordu" }).waitFor({ timeout: 3000 });
      const live = await reopened.locator(".ui-choice:not(:disabled)").count();
      if (live) fail(`${live} bouton(s) de choix encore actifs après réouverture`);
      mark("groupe rouvert : choix déjà fait figé, plus aucun bouton actif");

      // la remontée marche : une erreur et un rejet volontaires arrivent au serveur ; le reste doit être vide
      await page.evaluate(() => {
        setTimeout(() => {
          throw new Error("smoke-erreur-volontaire");
        });
        Promise.reject(new Error("smoke-rejet-volontaire"));
      });
      let reported: any[] = [];
      for (let i = 0; i < 50 && reported.filter((r) => /volontaire/.test(r.msg)).length < 2; i++) {
        await Bun.sleep(100);
        reported = await clientLogs();
      }
      if (reported.filter((r) => /volontaire/.test(r.msg)).length < 2) fail("l'erreur et le rejet volontaires ne sont pas remontés à /bots/log");
      mark("erreur et rejet remontés au serveur avec la version " + reported[0].version);
      reported = reported.filter((r) => !/volontaire|inline_images/.test(r.msg) && r.kind !== "bots-ui");
      if (reported.length)
        fail(
          "le client a remonté des erreurs : " +
            reported
              .slice(0, 2)
              .map((r: any) => r.kind + " " + r.msg)
              .join(" | ")
        );
      // gateway en drain (ticket 503 runtime_draining) : « gateway en redémarrage », pas « hors ligne »
      await back().catch(() => {});
      const drain = await page.evaluate(async () => {
        const B = (window as any).__bots;
        B.handleError(new Error('ticket 503 {"reason": "runtime_draining"}'));
        await new Promise(requestAnimationFrame);
        const t = document.querySelector("[data-testid=conn]")!.textContent || "";
        B.setConn(true);
        return t;
      });
      if (!/redémarrage/.test(drain) || /hors ligne/.test(drain)) fail(`gateway en drain affiché « ${drain} »`);
      mark("gateway en drain : « gateway en redémarrage », pas « hors ligne »");
      // websocket du roster fermé (drain) : pas de « hors ligne » figé, reconnexion seule
      const closed = await page.evaluate(async () => {
        const B = (window as any).__bots;
        B.roster.gw.ws.close();
        await new Promise((r) => setTimeout(r, 300));
        const t = document.querySelector("[data-testid=conn]")!.textContent || "";
        await new Promise((r) => setTimeout(r, 4000));
        return [t, document.querySelector("[data-testid=conn]")!.textContent || ""];
      });
      if (/hors ligne/.test(closed[0]) || !/en ligne/.test(closed[1])) fail(`websocket fermé : « ${closed[0]} » puis « ${closed[1]} »`);
      mark("websocket fermé : « reconnexion… » puis « en ligne », jamais « hors ligne »");
      // Mac injoignable (téléphone sorti de Tailscale, 2026-11-18) : les requêtes /api échouent au niveau réseau ; message clair, pas « Failed to fetch »
      await ctx.route(/\/api\//, (r) => r.abort("internetdisconnected"));
      await page.goto("/bots/");
      await page
        .locator("[data-testid=roster-msg]", { hasText: "Tailscale" })
        .waitFor({ timeout: 10000 })
        .catch(async () =>
          fail(
            `Mac injoignable : message « ${await page
              .locator("[data-testid=roster-msg]")
              .textContent()
              .catch(() => "absent")} »`
          )
        );
      const unreach = await page.textContent("[data-testid=conn]");
      if (!/Mac injoignable/.test(unreach || "") || /Failed to fetch/.test((await page.textContent("[data-testid=home]")) || ""))
        fail(`Mac injoignable : état « ${unreach} »`);
      await ctx.unroute(/\/api\//);
      errors.length = 0; // échecs réseau provoqués
      mark("Mac injoignable : « Mac injoignable » et consigne Tailscale, jamais « Failed to fetch »");
      // redémarrage avec un cache de groupes plein (la v76 plantait au chargement)
      const nGroups = await page.evaluate(() => (JSON.parse(localStorage.getItem("groups-cache") || "[]") || []).length);
      if (!nGroups) fail("le cache de groupes devrait être rempli à ce stade du parcours");
      // démarrage avec un cache corrompu (autre forme, JSON cassé, entrées nulles) : la liste s'affiche quand même
      await page.evaluate(() => {
        localStorage.setItem("last-chat", "null");
        localStorage.setItem("roster-cache", "[null, 3]");
        localStorage.setItem("pinned", '"abc"');
        localStorage.setItem("seen", "{cassé");
        localStorage.setItem("room-preview", "[1]");
        localStorage.setItem("avatars", "42");
      });
      await page.goto("/bots/");
      await page.waitForSelector("[data-testid=entry]").catch(() => fail("redémarrage : liste absente ; erreurs : " + errors.slice(-3).join(" | ")));
      await page.locator('[data-testid=entry][data-kind="room"]').first().waitFor({ timeout: 10000 });
      mark(`redémarrage avec ${nGroups} groupe(s) en cache et un cache corrompu : liste affichée`);
      // une vue qui plante : la limite d'erreur l'affiche, le reste de l'app vit, la panne est remontée
      await open("default");
      await page.evaluate(() => {
        const c = (window as any).__bots.conv();
        c.thread.addMsg("assistant", "x");
        c.thread.patch(c.thread.items.at(-1).key, { files: [null] as any });
      });
      await page.locator("[data-testid=crash]").waitFor({ timeout: 5000 });
      if (!(await page.locator("[data-testid=home]").count())) fail("la panne d'une vue a emporté l'accueil");
      {
        let rep: any[] = [];
        for (let i = 0; i < 30 && !rep.some((r) => /conversation :/.test(r.msg)); i++) {
          await Bun.sleep(100);
          rep = await clientLogs();
        }
        if (!rep.some((r) => /conversation :/.test(r.msg))) fail("la panne de la vue n'a pas été remontée");
      }
      errors.length = 0; // erreur provoquée
      mark("vue en panne : message et boutons à sa place, l'accueil reste, panne remontée");
      if (errors.length) fail("erreurs du client : " + errors.slice(0, 3).join(" | "));
    }
    mark("aucune erreur JavaScript");
    await browser.close();
  } finally {
    mock.kill();
  }
}

const t = Date.now();
// Sans --part : la partie bots et la partie groupes tournent en même temps (chacune son mock, son port et son Chromium), pour tenir sous 60 s.
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
    const lines = r.out.split("\n").filter((l) => l.startsWith("  ok  "));
    n += lines.length;
    console.log(`-- partie ${r.part} : ${lines.length} étapes, code ${r.code}`);
    console.log(r.out.trimEnd());
    if (r.err.trim()) console.error(r.err.trimEnd());
  }
  const bad = res.find((r) => r.code !== 0);
  if (bad) fail("partie " + bad.part + " : " + (bad.err.split("\n").find((l) => /ÉCHEC/.test(l)) || "échec").replace(/^smoke ÉCHEC : /, ""));
  steps.length = 0;
  for (let i = 0; i < n; i++) steps.push("");
}
try {
  await (PART ? run() : both());
  if (PART) {
    console.log(`smoke (${PART}) : ${steps.length} étapes, ${((Date.now() - t) / 1000).toFixed(1)} s`);
    process.exit(0);
  }
  log("smoke", true, `${steps.length} étapes en ${Date.now() - t} ms`);
  console.log(`smoke : ${steps.length} étapes, ${((Date.now() - t) / 1000).toFixed(1)} s`);
  process.exit(0);
} catch (e) {
  const m = (e as Error).message.split("\n")[0].slice(0, 300);
  console.error("smoke ÉCHEC : " + m);
  if (!PART) {
    log("smoke", false, m);
    alert("smoke", m);
  }
  process.exit(1);
}
