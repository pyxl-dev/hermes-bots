// Parcours réel de POST /bots/log sur le VRAI server.ts, dans un HOME jetable avec un faux hub-notify :
// une erreur de la v-test est écrite dans le journal, alerte Hub une seule fois, `status` la compte par version.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alert, log } from "../lib/journal";

const home = mkdtempSync(join(tmpdir(), "bots-log-")), PORT = 19100 + Math.floor(Math.random() * 100);
mkdirSync(join(home, "bin")); const calls = join(home, "hub-calls.txt");
writeFileSync(join(home, "bin", "hub-notify"), `#!/bin/sh\necho "$@" >> ${calls}\n`); chmodSync(join(home, "bin", "hub-notify"), 0o755);
const env = { ...process.env, HOME: home, PORT: String(PORT) };
const srv = spawn("bun", [join(import.meta.dir, "..", "server.ts")], { env, stdio: "ignore" });
const post = (b: unknown) => fetch(`http://127.0.0.1:${PORT}/bots/log`, { method: "POST", body: JSON.stringify(b) });
let failure = "";
try {
  for (let i = 0; i < 100 && !failure; i++) { try { await fetch(`http://127.0.0.1:${PORT}/bots/index.html`); break; } catch { await Bun.sleep(100); } }
  const bad = await post({ version: "v-test", kind: "nope", msg: "x" });
  if (bad.status !== 400) failure = "un corps invalide doit donner 400, reçu " + bad.status;
  const a = await post({ version: "v-test", kind: "rpc", msg: "session.resume : invalid_params (inline_images)", rpc: "session.resume", code: -32602 });
  const b = await post({ version: "v-test", kind: "error", msg: "x is not a function", where: "app.js:10" });
  const c = await post({ version: "v-autre", kind: "rejection", msg: "boom" });
  if (!failure && ![a, b, c].every((r) => r.status === 204)) failure = "POST /log attendu 204";
  // URL mal encodée : 400, sans erreur 500 ni alerte Hub
  const enc = await fetch(`http://127.0.0.1:${PORT}/bots/%E0`);
  if (!failure && enc.status !== 400) failure = "une URL mal encodée doit donner 400, reçu " + enc.status;
  await Bun.sleep(600);
  const rows = readFileSync(join(home, ".local/state/hermes-bots-pwa/actions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const ce = rows.filter((r) => r.action === "client_error");
  if (!failure && ce.length !== 3) failure = `3 client_error attendus, ${ce.length} trouvés`;
  const alerts = existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n") : [];
  if (!failure && alerts.length !== 2) failure = `une alerte par version attendue (2), ${alerts.length} envoyée(s)`;
  // une ligne tronquée dans le journal ne fait plus planter status
  appendFileSync(join(home, ".local/state/hermes-bots-pwa/actions.jsonl"), '{"ts":"2026-11-16T0\n');
  const st = spawnSync("bun", [join(import.meta.dir, "..", "server.ts"), "status"], { env, encoding: "utf8" }).stdout;
  if (!failure && !(/v-test : 2/.test(st) && /v-autre : 1/.test(st))) failure = "status ne compte pas les erreurs par version :\n" + st;
  if (!failure && !/lignes illisibles dans le journal : 1/.test(st)) failure = "status doit compter la ligne illisible :\n" + st;
} finally { srv.kill(); }
if (failure) { console.error("client-log ÉCHEC : " + failure); log("client_log_test", false, failure.split("\n")[0]); alert("client_log_test", failure.split("\n")[0]); process.exit(1); }
log("client_log_test", true); console.log("client-log : erreurs journalisées, alerte une fois par version, status par version");
