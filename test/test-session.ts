// Session de navigateur sur le gateway de test, partagée par les parcours réels.
// Chromium headless isolé (jamais le navigateur de Yoan) : connexion avec le mot de passe de ~/.hermes-test (généré par
// `test-gateway.ts reset`), PWA servie depuis app/ de CE dépôt (ou --app <dossier figé>) par interception des requêtes
// /bots/ et /bots-next/ ; tout le reste (API, WebSocket) va au vrai gateway de test sur 127.0.0.1.
import { chromium, type Browser, type BrowserContext } from "playwright-core";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { PASSWORD_FILE, TEST_ORIGIN } from "./test-gateway";

const APP = resolve(import.meta.dir, "..", "app");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

export function chromePath(): string {
  const root = join(homedir(), "Library", "Caches", "ms-playwright");
  for (const d of readdirSync(root).filter((x) => x.startsWith("chromium_headless_shell-")).sort().reverse())
    for (const sub of readdirSync(join(root, d))) { const exe = join(root, d, sub, "chrome-headless-shell"); if (existsSync(exe)) return exe; }
  throw new Error("aucun chrome-headless-shell dans " + root + " (bunx playwright-core install chromium-headless-shell)");
}

export type TestSession = { browser: Browser; ctx: BrowserContext; origin: string; close: () => Promise<void> };
export async function openTestSession(appDir = APP): Promise<TestSession> {
  const password = existsSync(PASSWORD_FILE) ? readFileSync(PASSWORD_FILE, "utf8").trim() : "";
  if (!password) throw new Error(`mot de passe de test absent (${PASSWORD_FILE}) : bun test/test-gateway.ts reset`);
  const browser = await chromium.launch({ executablePath: chromePath(), args: ["--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,BlockInsecurePrivateNetworkRequests"] });
  const ctx = await browser.newContext({ baseURL: TEST_ORIGIN, serviceWorkers: "block", viewport: { width: 390, height: 800 } });
  const r = await ctx.request.post("/auth/password-login", { data: { provider: "basic", username: "test", password, next: "/" } }).catch((e) => { throw new Error(`gateway de test injoignable sur ${TEST_ORIGIN} (bun test/test-gateway.ts start) : ${e.message.split("\n")[0]}`); });
  if (!r.ok()) throw new Error(`connexion au gateway de test refusée (${r.status()})`);
  const me = await ctx.request.get("/api/auth/me");
  if (!me.ok()) throw new Error(`session de test non reconnue par /api/auth/me (${me.status()})`);
  await ctx.route((u) => /^\/bots(-next)?\//.test(u.pathname), async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname.replace(/^\/bots(-next)?\//, "");
    if (req.method() !== "GET") return route.fulfill({ status: path === "log" ? 204 : 501, contentType: "application/json", body: "{}" }); // log, recap, push : pas de serveur PWA ici
    const file = normalize(join(appDir, path || "index.html"));
    if (!file.startsWith(appDir) || !existsSync(file)) return route.fulfill({ status: path === "prefs" ? 200 : 404, contentType: "application/json", body: "{}" });
    return route.fulfill({ status: 200, contentType: TYPES[extname(file)] || "application/octet-stream", body: readFileSync(file) });
  });
  return { browser, ctx, origin: TEST_ORIGIN, close: () => browser.close() };
}
