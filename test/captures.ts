// Captures de preuve de la portée v88 sur le mock : accueil mobile, fil en direct mobile, deux volets à 1280 px.
//   bun test/captures.ts   → docs/redesign/captures/*.png
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { join } from "node:path";

const PORT = 18990 + Math.floor(Math.random() * 100),
  BASE = `http://127.0.0.1:${PORT}`,
  OUT = join(import.meta.dir, "..", "docs", "redesign", "captures");
const mock = spawn("bun", [join(import.meta.dir, "mock-gateway.ts")], { env: { ...process.env, MOCK_TICK_MS: "400", PORT: String(PORT) }, stdio: "ignore" });
try {
  for (
    let i = 0;
    i < 100 &&
    !(await fetch(BASE + "/bots/index.html").then(
      (r) => r.ok,
      () => false
    ));
    i++
  )
    await Bun.sleep(100);
  const { chromePath } = await import("./test-session");
  const browser = await chromium.launch({ executablePath: chromePath() });
  const shoot = async (w: number, h: number, name: string, act: (p: any) => Promise<void>) => {
    const ctx = await browser.newContext({ baseURL: BASE, serviceWorkers: "block", viewport: { width: w, height: h }, deviceScaleFactor: 2 });
    await ctx.addInitScript(() => {
      localStorage.setItem("bots-test", "true");
      localStorage.setItem("pinned", JSON.stringify(["default", "rea", "archive"]));
    });
    const p = await ctx.newPage();
    await p.goto("/bots/");
    await p.waitForSelector("[data-testid=entry], [data-testid=pin]");
    await act(p);
    await p.screenshot({ path: join(OUT, name) });
    console.log("  ok  " + name);
    await ctx.close();
  };
  const work = async (p: any, key: string, msg = "Lance le build et dis-moi ce qui casse") => {
    await p.locator(`[data-key="${key}"]`).first().click();
    await p.waitForSelector("[data-testid=chat]");
    await p.waitForFunction(() => !(window as any).__bots.conv()?.syncing && !!(window as any).__bots.conv()?.sid);
    await p.fill("[data-testid=input]", msg);
    await p.click("[data-testid=send]");
    await p.waitForTimeout(600);
    await p.waitForFunction(() => !!document.querySelector(`[aria-label="Arrêter"]`), null, { timeout: 8000 });
  };
  await shoot(390, 844, "accueil-mobile.png", async (p) => {
    await work(p, "rea");
    await p.click('[data-testid=chat] header [aria-label="Retour"]');
    await p.waitForSelector("[data-testid=home]");
    await p.waitForTimeout(300);
  });
  await shoot(390, 844, "fil-direct-mobile.png", async (p) => {
    await work(p, "default");
    await p.waitForTimeout(900);
  });
  await shoot(1280, 800, "deux-volets-1280.png", async (p) => {
    await work(p, "default", "Et maintenant, relis le diff");
    await p.waitForTimeout(900);
  });
  // v89 : long message d'un membre de groupe, replié, avec « Afficher tout » et « Voir le fil » sous la bulle
  await shoot(390, 844, "groupe-message-long-mobile.png", async (p) => {
    await p.locator('[data-testid=entry][data-kind="room"]').first().click();
    await p.waitForSelector("[data-testid=chat] [data-testid=bubble]");
    await p.evaluate(() => {
      const g = (window as any).__bots.conv(),
        who = g.thread.items.find((i: any) => i.k === "msg" && i.who && i.role === "assistant")?.who;
      g.thread.addMsg(
        "assistant",
        "**Aucune des trois hypothèses ne tient.** Les lignes citées viennent du journal de la veille.\n\n" +
          "Détail de l'analyse, ligne après ligne, avec les journaux relus et les horodatages vérifiés. ".repeat(40)
      );
      g.thread.patch(g.thread.items.at(-1).key, { who, trace: "has" });
    });
    await p.waitForTimeout(400);
    await p.locator("[data-testid=fold]").last().scrollIntoViewIfNeeded();
    await p.waitForTimeout(400);
  });
  await browser.close();
} finally {
  mock.kill();
}
