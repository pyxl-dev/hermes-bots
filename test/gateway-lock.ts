// Verrou du gateway de TEST (~/.hermes-test), partagé par toutes les sessions et tous les worktrees de la machine.
// Sans lui, la release d'une autre session relançait `ensure` (plugin relié à SON worktree, gateway redémarré) en plein parcours
// d'une autre, d'où des parcours lents, des drains ratés et des 503 (2026-11-16). Le prennent : test-gateway.ts (sauf status),
// real-journey.ts, group-journey.ts et le portail de scripts/release.ts. Les processus enfants héritent du verrou par
// TEST_GATEWAY_LOCK=tenu ; il saute à la sortie du processus qui le tient, et un verrou dont le pid est mort est repris.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = process.env.HERMES_TEST_HOME || join(homedir(), ".hermes-test");
export const LOCK = join(HOME, "test-gateway.lock");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const holder = () => Number((() => { try { return readFileSync(join(LOCK, "pid"), "utf8"); } catch { return "0"; } })()) || 0;

/** Attend le gateway de test (10 min au plus) puis le garde jusqu'à la sortie du processus. Renvoie les ms d'attente. */
export async function holdTestGateway(who: string, maxMs = 600_000): Promise<number> {
  if (process.env.TEST_GATEWAY_LOCK === "tenu") return 0;
  const t0 = Date.now();
  let said = false;
  mkdirSync(HOME, { recursive: true });
  while (Date.now() - t0 < maxMs) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, "pid"), String(process.pid));
      writeFileSync(join(LOCK, "who"), `${who} (${process.cwd()})`);
      process.on("exit", () => { if (holder() === process.pid) rmSync(LOCK, { recursive: true, force: true }); });
      for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => process.exit(130));
      process.env.TEST_GATEWAY_LOCK = "tenu";
      return Date.now() - t0;
    } catch {
      const pid = holder();
      if (pid && !alive(pid)) { rmSync(LOCK, { recursive: true, force: true }); continue; } // verrou d'un processus mort
      if (!pid && Date.now() - t0 > 3000) { rmSync(LOCK, { recursive: true, force: true }); continue; } // dossier sans pid (crash entre mkdir et write)
      if (!said) {
        const by = (() => { try { return readFileSync(join(LOCK, "who"), "utf8"); } catch { return "?"; } })();
        console.log(`  ..  gateway de test occupé par pid ${pid || "?"} : ${by} ; attente`);
        said = true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(`gateway de test toujours occupé après ${Math.round(maxMs / 60000)} min (verrou ${LOCK}, pid ${holder() || "?"})`);
}
