// Static server for the Hermes Bots PWA, published on the tailnet by:
//   tailscale serve --bg --set-path /bots http://127.0.0.1:9131
// It only serves app/; auth and the gateway socket stay on the Hermes Webapp (same origin).
//   bun server.ts          run the server
//   bun server.ts status   last actions, failures, client errors per version and a live health check
//   bun server.ts stage | promote | rollback   versions figées (releases/<version>), voir README
//   bun server.ts push --title T --body B [--url U] [--tag X]
//                          Web Push to every subscribed device (exit 0 sent, 2 no device, 1 all failed)
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { LOG_DIR, LOG, LOG_OLD, log, alert } from "./lib/journal";
import webpush from "web-push";
import { join, normalize } from "node:path";

const PORT = Number(process.env.PORT || 9131);
const ROOT = import.meta.dir;
const APP = join(ROOT, "app"); // la copie de travail : ne sert qu'à figer une version (stage) et de repli tant que `current` n'existe pas
const NEXT_PORT = Number(process.env.NEXT_PORT || PORT + 1);

// ---------- Versions figées : releases/<version>, liens current (prod), next (candidate), previous (retour arrière) ----------
// Le serveur résout les liens à chaque requête : promote et rollback prennent effet sans redémarrage.
const RELEASES = join(ROOT, "releases");
const link = (name: string) => join(ROOT, name);
const linkTarget = (name: string) => {
  try {
    return readlinkSync(link(name)).replace(/^releases\//, "");
  } catch {
    return null;
  }
};
function setLink(name: string, version: string | null) {
  if (version === null) {
    rmSync(link(name), { force: true });
    return;
  }
  const tmp = link(name) + ".tmp";
  rmSync(tmp, { force: true });
  symlinkSync("releases/" + version, tmp);
  renameSync(tmp, link(name)); // remplacement atomique
}
function dirDigest(dir: string): string {
  const h = new Bun.CryptoHasher("sha256");
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const f = join(d, e.name);
      if (e.isDirectory()) walk(f);
      else {
        h.update(f.slice(dir.length));
        h.update(readFileSync(f));
      }
    }
  };
  walk(dir);
  return h.digest("hex");
}
const appVersion = (dir: string) => /APP_VERSION = ["']([^"']+)["']/.exec(readFileSync(join(dir, "version.js"), "utf8"))?.[1] ?? null;
/** Dossier servi pour un canal ; `current` retombe sur app/ tant qu'aucune version n'est figée. */
function channelRoot(channel: "current" | "next"): string | null {
  try {
    return realpathSync(link(channel));
  } catch {
    return channel === "current" ? APP : null;
  }
}
// journal et alerte Hub : lib/journal.ts
// ---------- Web Push (remplace Hub pour les notifs des bots, demandé le 2026-11-13) ----------
// Clés VAPID et abonnements dans LOG_DIR, en 0600. L'abonnement exige la session de la webapp Hermes
// (cookie relayé à /api/auth/me sur le gateway), l'envoi ne se fait qu'en local (commande push).
const VAPID = join(LOG_DIR, "vapid.json");
const SUBS = join(LOG_DIR, "push-subscriptions.json");
const GATEWAY = process.env.HERMES_GATEWAY || "http://127.0.0.1:9120"; // la variable ne sert qu'aux essais locaux
const SUBJECT = process.env.PWA_URL || "http://127.0.0.1:9131/bots/"; // origine publique de la PWA, à poser chez soi
// Écriture atomique (fichier temporaire puis rename) : un arrêt en pleine écriture laissait un JSON tronqué.
function writeSecret(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
// Fichier absent : la valeur par défaut. Fichier illisible : une erreur, jamais la valeur par défaut, sinon la prochaine
// écriture effaçait tout (un abonnement push recréé remplaçait les abonnements de tous les appareils).
function readJson<T>(file: string, absent: T): T {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return absent;
    throw e;
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} illisible : ${(e as Error).message}`);
  }
}
function vapidKeys(): { publicKey: string; privateKey: string } {
  if (existsSync(VAPID)) return JSON.parse(readFileSync(VAPID, "utf8"));
  const k = webpush.generateVAPIDKeys();
  writeSecret(VAPID, k);
  log("vapid_create", true);
  return k;
}
type Sub = { endpoint: string; keys: { p256dh: string; auth: string }; device?: string; added: string };
const readSubs = (): Sub[] => readJson<Sub[]>(SUBS, []);
const saveSubs = (subs: Sub[]) => writeSecret(SUBS, subs);
async function sendPush(subs: Sub[], payload: Record<string, unknown>) {
  const k = vapidKeys();
  webpush.setVapidDetails(SUBJECT, k.publicKey, k.privateKey);
  let sent = 0;
  const gone: string[] = [];
  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      sent++;
    } catch (e: any) {
      const code = e?.statusCode;
      if (code === 404 || code === 410) gone.push(sub.endpoint);
      log("push_send", false, `${code ?? ""} ${(e?.body || e?.message || "").toString().slice(0, 200)} ${sub.device ?? ""}`);
    }
  }
  if (gone.length) {
    saveSubs(readSubs().filter((s) => !gone.includes(s.endpoint)));
    log("push_prune", true, `${gone.length} abonnement(s) expiré(s)`);
  }
  return { sent, total: subs.length };
}
async function signedIn(req: Request) {
  const cookie = req.headers.get("cookie");
  if (!cookie) return false;
  try {
    const r = await fetch(GATEWAY + "/api/auth/me", {
      headers: { cookie, ...(req.headers.get("host") ? { "x-forwarded-host": req.headers.get("host")! } : {}) },
    });
    return r.ok;
  } catch {
    return false;
  }
}
function validSub(x: any): x is Sub {
  return (
    x &&
    typeof x.endpoint === "string" &&
    /^https:\/\//.test(x.endpoint) &&
    x.endpoint.length < 2048 &&
    typeof x.keys?.p256dh === "string" &&
    typeof x.keys?.auth === "string"
  );
}
async function pushRoute(path: string, req: Request): Promise<Response | null> {
  if (path === "/push/key" && req.method === "GET") return Response.json({ key: vapidKeys().publicKey });
  if (!["/push/subscribe", "/push/unsubscribe", "/push/test"].includes(path) || req.method !== "POST") return null;
  if (!(await signedIn(req))) {
    log("push_auth", false, path);
    return Response.json({ detail: "connexion à Hermes requise" }, { status: 401 });
  }
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ detail: "JSON attendu" }, { status: 400 });
  }
  const sub = body?.subscription;
  if (!validSub(sub)) return Response.json({ detail: "abonnement invalide" }, { status: 400 });
  const others = readSubs().filter((s) => s.endpoint !== sub.endpoint);
  if (path === "/push/unsubscribe") {
    saveSubs(others);
    log("push_unsubscribe", true, String(body.device || ""));
    return Response.json({ ok: true });
  }
  if (path === "/push/subscribe") {
    saveSubs([
      ...others,
      {
        endpoint: sub.endpoint,
        keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
        device: String(body.device || "").slice(0, 120),
        added: new Date().toISOString(),
      },
    ]);
    log("push_subscribe", true, String(body.device || ""));
    return Response.json({ ok: true, devices: others.length + 1 });
  }
  const r = await sendPush([sub as Sub], { title: "Hermes Bots", body: "Les notifications marchent.", url: "/bots/", tag: "test" });
  log("push_test", r.sent === 1);
  return Response.json({ ok: r.sent === 1 });
}

// ---------- Erreurs du client (app/report.js) : POST /log, journal + alerte Hub au premier échec d'une version ----------
// Pas de session exigée (une erreur de connexion doit pouvoir remonter) ; tailnet seulement, champs bornés, débit limité.
const clip = (v: unknown, n: number) =>
  String(v ?? "")
    .replace(/[\u0000-\u001f]+/g, " ")
    .slice(0, n);
const hits: number[] = [];
async function logRoute(path: string, req: Request): Promise<Response | null> {
  if (path !== "/log" || req.method !== "POST") return null;
  const now = Date.now();
  while (hits.length && now - hits[0] > 600_000) hits.shift();
  if (hits.length >= 120) return new Response(null, { status: 429 });
  let b: any;
  try {
    b = JSON.parse((await req.text()).slice(0, 4000));
  } catch {
    return new Response(null, { status: 400 });
  }
  const version = clip(b?.version, 40);
  if (!/^[\w.\-]{1,40}$/.test(version) || !["error", "rejection", "rpc"].includes(b?.kind) || !clip(b?.msg, 500)) return new Response(null, { status: 400 });
  hits.push(now);
  const kind = b.kind as string,
    msg = clip(b.msg, 500);
  log("client_error", false, `${kind} ${msg}`, {
    version,
    kind,
    where: clip(b.where, 200),
    ...(b.rpc ? { rpc: clip(b.rpc, 80), code: Number.isFinite(b.code) ? b.code : undefined } : {}),
  });
  alert(`client ${version}`, `${kind} ${msg}`, { key: `client:${version}`, windowMs: 10 * 365 * 86400_000 }); // une seule fois par version
  return new Response(null, { status: 204 });
}

// ---------- Récap d'un groupe recréé (demandé le 2026-11-15) ----------
// Recréer un groupe pour changer ses membres recopiait les 30 derniers messages coupés à 600 signes : diffs de fichiers,
// JSON tronqué, rien d'utilisable. Ici le meneur du groupe lit tout l'historique et écrit un vrai résumé.
// Session Hermes marquée « tool » : elle n'apparaît pas dans la liste des conversations du bot.
const HERMES = join(homedir(), ".local/bin/hermes");
const RECAP_PROMPT = (
  room: string,
  transcript: string
) => `Tu prépares la reprise du groupe de travail « ${room} ». Il est recréé pour changer ses membres : les bots du nouveau groupe ne verront que ton résumé, pas l'historique.

Écris en français, en Markdown, 300 à 600 mots, sans bloc bots-ui, sans outil, sans rien inventer :
- **Cadre** : l'objectif et les règles fixées par Yoan, telles quelles.
- **Fait et vérifié** : les résultats acquis, avec chemins de fichiers, chiffres et sources cités dans l'échange.
- **Décisions** : ce qui a été tranché, et par qui.
- **En cours et prochaines étapes** : qui fait quoi, ce qui bloque.
- **Points ouverts** : contradictions ou questions non résolues.

Ignore les diffs de fichiers et le bruit technique. Réponds uniquement avec le résumé.

Historique du groupe :

${transcript}`;
let recapBusy = 0;
async function recapRoute(path: string, req: Request): Promise<Response | null> {
  if (path !== "/recap" || req.method !== "POST") return null;
  if (!(await signedIn(req))) {
    log("recap_auth", false);
    return Response.json({ detail: "connexion à Hermes requise" }, { status: 401 });
  }
  let b: any;
  try {
    b = JSON.parse((await req.text()).slice(0, 130_000));
  } catch {
    return Response.json({ detail: "JSON attendu" }, { status: 400 });
  }
  const profile = String(b?.profile || ""),
    room = clip(b?.room, 120),
    transcript = String(b?.transcript || "").slice(0, 120_000);
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(profile) || !existsSync(join(homedir(), ".hermes/profiles", profile)) || !transcript.trim())
    return Response.json({ detail: "profil ou historique invalide" }, { status: 400 });
  if (recapBusy >= 2) return Response.json({ detail: "un récap est déjà en cours" }, { status: 429 });
  recapBusy++;
  const qfile = join(tmpdir(), `recap-${crypto.randomUUID()}.txt`);
  const t0 = Date.now();
  try {
    writeFileSync(qfile, RECAP_PROMPT(room, transcript), { mode: 0o600 });
    const out: string = await new Promise((ok, ko) =>
      execFile(
        HERMES,
        ["-p", profile, "chat", "-Q", "--format", "stream-json", "--source", "tool", "--query-file", qfile],
        { cwd: homedir(), timeout: 180_000, maxBuffer: 20 * 1024 * 1024 },
        (err, stdout) => (stdout ? ok(stdout) : ko(err || new Error("sortie vide")))
      )
    );
    let res: any = {};
    for (const line of out.split("\n")) {
      try {
        const ev = JSON.parse(line);
        if (ev?.type === "result") res = ev;
      } catch {}
    }
    const text = String(res.text || "").trim();
    if (!text || res.error) throw new Error(String(res.error || "réponse vide"));
    log("recap", true, `${profile} ${room} ${Date.now() - t0} ms`);
    return Response.json({ text });
  } catch (e: any) {
    const cause = clip(e?.message || e, 300);
    log("recap", false, `${profile} ${room} ${cause}`);
    alert("récap de groupe", `${room} : ${cause}`, { key: "recap" });
    return Response.json({ detail: cause }, { status: 502 });
  } finally {
    recapBusy--;
    rmSync(qfile, { force: true });
  }
}

// ---------- Préférences partagées entre appareils (épingles, demandé le 2026-11-13) ----------
const PREFS = join(LOG_DIR, "prefs.json");
type Avatar = { color: string; kind: string };
const AVATAR_KINDS = ["drop", "round", "block", "ghost"];
type Prefs = { pinned: string[]; labels?: Record<string, string>; avatars?: Record<string, Avatar>; bubble?: string; updated: string | null };
const readPrefs = (): Prefs => readJson<Prefs>(PREFS, { pinned: [], updated: null });
async function prefsRoute(path: string, req: Request): Promise<Response | null> {
  if (path !== "/prefs" || !["GET", "POST"].includes(req.method)) return null;
  if (!(await signedIn(req))) {
    log("prefs_auth", false, req.method);
    return Response.json({ detail: "connexion à Hermes requise" }, { status: 401 });
  }
  if (req.method === "GET") return Response.json(readPrefs());
  let body: any;
  try {
    body = await req.json();
  } catch {
    return Response.json({ detail: "JSON attendu" }, { status: 400 });
  }
  const pinned = body?.pinned;
  if (!Array.isArray(pinned) || pinned.length > 200 || !pinned.every((n) => typeof n === "string" && n.length > 0 && n.length <= 120))
    return Response.json({ detail: "liste d'épingles invalide" }, { status: 400 });
  // noms affichables des épingles (pour les raccourcis d'app) : { clé: nom }, facultatif
  const rawLabels = body?.labels,
    labels: Record<string, string> = {};
  if (rawLabels && typeof rawLabels === "object" && !Array.isArray(rawLabels))
    for (const [k, v] of Object.entries(rawLabels)) if (typeof v === "string" && v.trim() && pinned.includes(k)) labels[k] = v.trim().slice(0, 60);
  // personnages choisis par bot : { clé: { color: "#rrggbb", kind } }. Absent du corps = on garde ceux du serveur (anciens clients).
  const rawAv = body?.avatars;
  let avatars: Record<string, Avatar> | undefined = readPrefs().avatars;
  if (rawAv !== undefined) {
    if (!rawAv || typeof rawAv !== "object" || Array.isArray(rawAv) || Object.keys(rawAv).length > 200)
      return Response.json({ detail: "personnages invalides" }, { status: 400 });
    avatars = {};
    for (const [k, v] of Object.entries(rawAv as Record<string, any>)) {
      if (!k || k.length > 120 || !/^#[0-9a-fA-F]{6}$/.test(v?.color) || !AVATAR_KINDS.includes(v?.kind))
        return Response.json({ detail: "personnage invalide : " + k.slice(0, 40) }, { status: 400 });
      avatars[k] = { color: v.color.toLowerCase(), kind: v.kind };
    }
  }
  // couleur des bulles de Yoan : "#rrggbb". Absente du corps = on garde celle du serveur.
  let bubble = readPrefs().bubble;
  if (body?.bubble !== undefined) {
    if (typeof body.bubble !== "string" || !/^#[0-9a-fA-F]{6}$/.test(body.bubble))
      return Response.json({ detail: "couleur de bulle invalide" }, { status: 400 });
    bubble = body.bubble.toLowerCase();
  }
  const out: Prefs = {
    pinned: [...new Set(pinned as string[])],
    labels,
    ...(avatars ? { avatars } : {}),
    ...(bubble ? { bubble } : {}),
    updated: new Date().toISOString(),
  };
  writeSecret(PREFS, out);
  log("prefs_set", true, `${out.pinned.length} épingle(s)`);
  return Response.json(out);
}

// ---------- Manifest dynamique : raccourcis d'app vers les 4 premiers éléments épinglés ----------
// Le reste du manifest est celui du fichier statique. Sans session Hermes, sans prefs.json ou sans épingle,
// c'est le fichier statique tel quel (repli). Le lien du manifest demande les cookies (crossorigin=use-credentials).
const MANIFEST_TYPE = "application/manifest+json";
async function manifestRoute(path: string, req: Request, root: string): Promise<Response | null> {
  const MANIFEST = join(root, "manifest.webmanifest");
  if (path !== "/manifest.webmanifest" || req.method !== "GET") return null;
  const fallback = () => new Response(Bun.file(MANIFEST), { headers: { "Content-Type": MANIFEST_TYPE, "Cache-Control": "no-cache" } });
  try {
    if (!existsSync(PREFS)) return fallback();
    const pinned = readPrefs().pinned;
    if (!Array.isArray(pinned) || !pinned.length) return fallback();
    if (!(await signedIn(req))) return fallback();
    const labels = readPrefs().labels ?? {};
    const shortcuts = pinned
      .filter((k) => typeof k === "string" && k)
      .slice(0, 4)
      .map((k) => {
        const room = k.startsWith("room:"),
          id = room ? k.slice(5) : k;
        const name = (typeof labels[k] === "string" && labels[k]) || (room ? "Groupe " + id : id);
        return { name, short_name: name.slice(0, 12), url: "./#" + (room ? "room-" : "") + encodeURIComponent(id) };
      });
    const m = JSON.parse(readFileSync(MANIFEST, "utf8"));
    m.shortcuts = shortcuts;
    return new Response(JSON.stringify(m, null, 2), { headers: { "Content-Type": MANIFEST_TYPE, "Cache-Control": "no-cache" } });
  } catch (e) {
    log("manifest", false, (e as Error).message);
    return fallback();
  }
}

if (process.argv[2] === "push") {
  const arg = (n: string) => {
    const i = process.argv.indexOf("--" + n);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const title = arg("title"),
    body = arg("body") ?? "";
  if (!title) {
    console.error("usage: bun server.ts push --title T --body B [--url U] [--tag X]");
    process.exit(64);
  }
  const subs = readSubs();
  if (!subs.length) {
    log("push", false, "aucun appareil abonné");
    console.log("aucun appareil abonné");
    process.exit(2);
  }
  const r = await sendPush(subs, { title, body: body.slice(0, 600), url: arg("url") || "/bots/", tag: arg("tag") });
  log("push", r.sent > 0, `${r.sent}/${r.total} ${title.slice(0, 80)}`);
  if (!r.sent) alert("push", `Aucune notif livrée (${r.total} appareil(s)) : ${title}`);
  console.log(`${r.sent}/${r.total} envoyée(s)`);
  process.exit(r.sent ? 0 : 1);
}

// ---------- Livraison : stage, promote, rollback ----------
//   bun server.ts stage      fige app/ dans releases/<version>, tag git release/<version>, la candidate (/bots-next/)
//   bun server.ts promote    la candidate devient la prod ; l'ancienne prod devient `previous`
//   bun server.ts rollback   la prod redevient `previous` (et `previous` l'ancienne prod : un second rollback revient)
const cmd = process.argv[2];
if (cmd === "stage" || cmd === "promote" || cmd === "rollback") {
  const die = (why: string): never => {
    console.error(cmd + " : " + why);
    log(cmd, false, why);
    alert(cmd, why);
    process.exit(1);
  };
  try {
    if (cmd === "stage") {
      const v = appVersion(APP) ?? die("app/version.js sans APP_VERSION");
      const dest = join(RELEASES, v);
      mkdirSync(RELEASES, { recursive: true });
      if (existsSync(dest)) {
        if (dirDigest(dest) !== dirDigest(APP)) die(`${v} est déjà figée avec un autre contenu : incrémente APP_VERSION dans app/version.js`);
      } else {
        const tmp = dest + ".tmp";
        rmSync(tmp, { recursive: true, force: true });
        cpSync(APP, tmp, { recursive: true });
        renameSync(tmp, dest);
      }
      setLink("next", v);
      try {
        execFileSync("git", ["tag", "-f", "release/" + v], { cwd: ROOT, stdio: "pipe" });
        execFileSync("git", ["push", "-f", "origin", "release/" + v], { cwd: ROOT, stdio: "pipe" });
      } catch (e) {
        log("tag", false, `${v} : ${String((e as any).stderr || e).slice(0, 200)}`);
        console.error("tag git non poussé (voir le journal)");
      }
      log("stage", true, v);
      console.log(`candidate : ${v} (/bots-next/), prod : ${linkTarget("current") ?? "app/ (rien de figé)"}`);
    } else if (cmd === "promote") {
      const n = linkTarget("next") ?? die("aucune candidate : `bun server.ts stage` d'abord");
      const cur = linkTarget("current");
      if (cur === n) {
        console.log(`${n} est déjà la prod`);
        process.exit(0);
      }
      if (cur) setLink("previous", cur);
      setLink("current", n);
      log("promote", true, `${cur ?? "app/"} -> ${n}`);
      console.log(`prod : ${cur ?? "app/"} -> ${n}`);
    } else {
      const prev = linkTarget("previous") ?? die("aucune version précédente");
      const cur = linkTarget("current");
      setLink("current", prev);
      if (cur) setLink("previous", cur);
      log("rollback", true, `${cur} -> ${prev}`);
      console.log(`prod : ${cur} -> ${prev}`);
    }
  } catch (e) {
    die((e as Error).message);
  }
  process.exit(0);
}

if (process.argv[2] === "status") {
  // une ligne tronquée (arrêt en pleine écriture) est comptée, pas fatale
  let bad = 0;
  const rows = [LOG_OLD, LOG]
    .flatMap((f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []))
    .flatMap((l) => {
      try {
        const r = JSON.parse(l);
        return r && typeof r === "object" ? [r] : [];
      } catch {
        bad++;
        return [];
      }
    });
  if (bad) console.log(`lignes illisibles dans le journal : ${bad}`);
  const clientErrs = rows.filter((r) => r.action === "client_error");
  const fails = rows.filter((r) => !r.ok && r.action !== "client_error");
  console.log(`entrées: ${rows.length}, échecs: ${fails.length}`);
  const byVer: Record<string, any[]> = {};
  for (const r of clientErrs) (byVer[r.version ?? "?"] ??= []).push(r);
  console.log(clientErrs.length ? "erreurs du client par version :" : "erreurs du client : aucune");
  for (const [v, rs] of Object.entries(byVer))
    console.log(`  ${v} : ${rs.length}, dernière ${rs.at(-1).ts} ${rs.at(-1).kind} ${String(rs.at(-1).cause).slice(0, 100)}`);
  for (const r of fails.slice(-5)) console.log(`  ÉCHEC ${r.ts} ${r.action} ${r.cause ?? ""}`);
  const last = rows.filter((r) => r.action === "start").at(-1);
  console.log(`dernier démarrage: ${last?.ts ?? "jamais"}`);
  for (const a of ["smoke", "release"]) {
    const l = rows.filter((r) => r.action === a).at(-1);
    console.log(`dernier ${a}: ${l ? `${l.ts} ${l.ok ? "ok" : "ÉCHEC"} ${l.cause ?? ""}` : "jamais"}`);
  }
  const cur = linkTarget("current"),
    nx = linkTarget("next"),
    pv = linkTarget("previous");
  console.log(`versions : prod ${cur ?? "app/ (non figée)"}, candidate ${nx ?? "aucune"}, précédente ${pv ?? "aucune"}`);
  const lp = rows.filter((r) => r.action === "push").at(-1);
  let nsubs: number | string;
  try {
    nsubs = readSubs().length;
  } catch (e) {
    nsubs = "ILLISIBLE (" + (e as Error).message + ")";
  }
  console.log(`notifs push: ${nsubs} appareil(s), dernier envoi ${lp ? `${lp.ts} ${lp.ok ? "ok" : "ÉCHEC"} ${lp.cause ?? ""}` : "jamais"}`);
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/index.html`);
    console.log(`santé locale: ${r.status === 200 ? "ok" : "KO " + r.status}`);
  } catch (e) {
    console.log(`santé locale: KO (${(e as Error).message})`);
    process.exit(1);
  }
  process.exit(0);
}

const TYPES: Record<string, string> = { webmanifest: "application/manifest+json" };
// Un listener par canal : PORT sert la prod (current, /bots/), NEXT_PORT la candidate (next, /bots-next/).
function makeHandler(channel: "current" | "next", prefix: string) {
  return async function fetchHandler(req: Request): Promise<Response> {
    let path: string;
    try {
      path = decodeURIComponent(new URL(req.url).pathname);
    } catch {
      return new Response("bad request", { status: 400 });
    } // %E0 et autres : plus de 500 ni d'alerte Hub pour une URL mal encodée
    if (path.startsWith(prefix)) path = path.slice(prefix.length); // au cas où le préfixe de montage n'est pas retiré
    const root = channelRoot(channel);
    if (!root) return new Response("aucune version candidate", { status: 404 });
    const pr = await pushRoute(path, req);
    if (pr) return pr;
    const pf = await prefsRoute(path, req);
    if (pf) return pf;
    const mf = await manifestRoute(path, req, root);
    if (mf) return mf;
    const lg = await logRoute(path, req);
    if (lg) return lg;
    const rc = await recapRoute(path, req);
    if (rc) return rc;
    if (path === "" || path.endsWith("/")) path += "index.html";
    const file = normalize(join(root, path));
    if (file !== root && !file.startsWith(root + "/")) return new Response("forbidden", { status: 403 }); // pas un dossier voisin au nom plus long
    const f = Bun.file(file);
    if (!(await f.exists())) {
      log("serve", false, `404 ${channel} ${path}`);
      return new Response("not found", { status: 404 });
    }
    const ext = file.split(".").pop() || "";
    // Fichiers du build nommés par leur empreinte (assets/) : jamais modifiés, gardés un an. Le reste se revalide.
    const headers: Record<string, string> = {
      "Cache-Control": file.startsWith(join(root, "assets") + "/") ? "public, max-age=31536000, immutable" : "no-cache",
    };
    if (TYPES[ext]) headers["Content-Type"] = TYPES[ext];
    // La candidate vit sous /bots-next/ : la balise <base> de la page doit suivre, sinon elle chargerait les fichiers de la prod.
    if (channel === "next" && file === join(root, "index.html")) {
      headers["Content-Type"] = "text/html; charset=utf-8";
      return new Response((await f.text()).replace(/<base href="\/bots\/"\s*\/?>/, `<base href="${prefix}/">`), { headers });
    }
    return new Response(f, { headers });
  };
}
const onError = (e: Error) => {
  log("serve", false, e.message);
  alert("serve", e.message);
  return new Response("error", { status: 500 });
};
try {
  Bun.serve({ hostname: "127.0.0.1", port: PORT, fetch: makeHandler("current", "/bots"), error: onError });
  log("start", true);
} catch (e) {
  const msg = (e as Error).message;
  log("start", false, msg);
  alert("start", `Le serveur ne démarre pas sur le port ${PORT} : ${msg}`);
  setTimeout(() => process.exit(1), 2000); // let the alert leave before launchd retries
}
try {
  Bun.serve({ hostname: "127.0.0.1", port: NEXT_PORT, fetch: makeHandler("next", "/bots-next"), error: onError });
} catch (e) {
  log("start_next", false, (e as Error).message);
  alert("start_next", `La candidate ne démarre pas sur le port ${NEXT_PORT} : ${(e as Error).message}`);
} // la prod continue
console.log(`hermes-bots-pwa sur http://127.0.0.1:${PORT}`);
