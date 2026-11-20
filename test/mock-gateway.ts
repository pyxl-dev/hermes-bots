// Local stand-in for the Hermes Webapp origin: serves app/ under /bots/ and fakes
// /api/webapp/socket-ticket + the /api/ws JSON-RPC with the frame shapes of tui_gateway.
// Run: bun test/mock-gateway.ts  (port 8790)
import { join } from "node:path";
import { createHash } from "node:crypto";
const userEventId = (c: string) => "user:" + createHash("sha256").update(c).digest("hex");

const APP = process.env.APP_DIR || join(import.meta.dir, "..", "app"); // APP_DIR : servir une version figée
const now = () => Date.now() / 1000;
const profiles = [
  {
    name: "default",
    path: "~/.hermes",
    is_default: true,
    display_name: "Yaia",
    description: "Assistant principal",
    model: "deepseek-flash",
    canonical_session: {
      id: "s-default",
      resolved_id: "s-default",
      root_title: "Bot Chat",
      title: "Bot Chat",
      preview: "Tout est prêt pour demain.",
      last_active: now() - 300,
      message_count: 4,
    },
  },
  {
    name: "rea",
    path: "~/.hermes/profiles/rea",
    display_name: "Réa",
    description: "Recherche",
    model: "gpt-6-luna",
    ui_meta: {
      "hermes-bots-mentions": {
        items: [
          { id: "m1", ts: now() - 60, text: "@yoan valide le budget" },
          { id: "m2", ts: now() - 30, room_id: "r-cours", room: "Prépa cours", text: "@yoan le TP 3 est prêt" },
        ],
      },
    },
    canonical_session: {
      id: "s-rea",
      resolved_id: "s-rea",
      root_title: "Bot Chat",
      title: "Bot Chat",
      preview: "J'ai trouvé 3 sources.",
      last_active: now() - 86400 * 2,
      message_count: 2,
    },
  },
  {
    name: "archive",
    path: "~/.hermes/profiles/archive",
    display_name: "Archive",
    description: "Conversation de taille réelle",
    model: "deepseek-flash",
    canonical_session: {
      id: "s-archive",
      resolved_id: "s-archive",
      root_title: "Bot Chat",
      title: "Bot Chat",
      preview: "FIN-DU-FIL",
      last_active: now() - 60,
      message_count: 20000,
    },
  },
  { name: "hermes-hard", path: "~/.hermes/profiles/hermes-hard", display_name: "", description: "Jugements difficiles", model: "opus" },
];
const history: Record<string, any[]> = {
  "s-default": [
    { role: "user", text: "Tu peux vérifier le build ?" },
    { role: "tool", name: "terminal", text: "bun run build\nok in 2.1s" },
    { role: "assistant", text: "", tool_calls: [{ id: "tc-read", type: "function", function: { name: "read_file", arguments: '{"path": "package.json"}' } }] },
    { role: "tool", name: "read_file", tool_call_id: "tc-read", text: '{ "name": "x" }' },
    { role: "tool", name: "web_search", text: "3 résultats" },
    { role: "user", display_kind: "process_complete", text: "[IMPORTANT: Background process proc_x completed normally (exit code 0)." },
    { role: "user", text: "[IMPORTANT: Background process proc_y completed normally (exit code 0)." },
    {
      role: "assistant",
      text: "## Bilan\n\n| Génération | Date | J0 | Verdict |\n|---|---|---|---|\n| 1 | 21/08 | 5 | Hors doctrine |\n| 2 | 28/08 | 7 | Hors doctrine |\n| 3 | 05/10 | 13 | **Conforme** |\n\n> la doctrine n'a jamais été testée à froid\n\n<img src=x onerror=alert(1)>",
    },
    { role: "assistant", text: "Build **ok** en 2,1 s. Détails :\n- 0 erreur\n- 2 warnings\n\n```\nwarn: unused var\n```" },
    { role: "user", text: "Question 1" },
    { role: "assistant", text: "Réponse longue 1.\n\n" + Array.from({ length: 30 }, (_, k) => "- point " + (k + 1) + " de la réponse 1").join("\n") },
    { role: "user", text: "Question 2" },
    { role: "assistant", text: "Réponse longue 2.\n\n" + Array.from({ length: 30 }, (_, k) => "- point " + (k + 1) + " de la réponse 2").join("\n") },
    { role: "user", text: "Question 3" },
    { role: "assistant", text: "Réponse longue 3.\n\n" + Array.from({ length: 30 }, (_, k) => "- point " + (k + 1) + " de la réponse 3").join("\n") },
  ],
  "s-rea": [
    { role: "user", text: "cherche X" },
    { role: "assistant", text: "J'ai trouvé 3 sources. @yoan tu valides le budget de 40 € ? Contact `demo@example.com` inchangé." },
  ],
};
// Conversation de taille réelle (la Bot Chat de Hermes avait 18 174 messages, ~38 Mo, le 2026-11-14) :
// outils bavards, images en ligne. Le chemin lent (session.resume sans omit_messages, session.history, REST
// sans limite) renvoie tout, comme le vrai gateway : c'est le piège que la porte avant la prod doit voir.
const BIG = Number(process.env.MOCK_BIG || 20000);
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const IMG = "\n\n![capture](data:image/png;base64," + PIXEL.repeat(40) + ")";
history["s-archive"] = Array.from({ length: BIG }, (_, i) => {
  const k = i % 5,
    n = Math.floor(i / 5),
    last = i === BIG - 1;
  if (last) return { role: "assistant", text: "FIN-DU-FIL : dernier message de la conversation." };
  if (k === 0) return { role: "user", text: "Question " + n + " : peux-tu vérifier l'étape " + n + " ?" };
  if (k === 1 || k === 2) return { role: "tool", name: k === 1 ? "terminal" : "read_file", text: ("ligne de sortie d'outil " + n + "\n").repeat(30) };
  if (k === 3) return { role: "tool", name: "web_search", text: "3 résultats pour " + n };
  return { role: "assistant", text: "Réponse " + n + ". " + "Détail de la vérification. ".repeat(20), ...(n % 10 === 0 ? { image: IMG } : {}) };
});
const tickets = new Set<string>();
const sockets = new Set<any>();
const ticketLog: number[] = [];
let refuse = 0,
  failSubmit = 0,
  slowHistory = 0,
  historyPending = 0,
  raced = 0;

// Réponse « recap » : sections en gras (mise en page) + un bloc bots-ui valide + un bloc invalide (rendu en texte).
const RECAP = [
  "**Décidé.** Lyon, 14 au 21 avril 2027, à deux avec Nova.",
  "",
  "**Écarté.** Nice et Antibes.",
  "",
  "```bots-ui",
  JSON.stringify(
    [
      {
        type: "recap",
        kicker: "Décidé",
        title: "Lyon",
        facts: [
          { value: "14 au 21", label: "avril 2027" },
          { value: "7 nuits", label: "base unique" },
          { value: "2 + Nova", label: "voyageurs" },
        ],
      },
      {
        type: "budget",
        envelope: 1500,
        lines: [
          { label: "Logement", min: 416, max: 601 },
          { label: "Train", min: 340, max: 430 },
          { label: "Billet chien", min: 40 },
          { label: "Ventimiglia", min: 20 },
          { label: "Petits trajets", min: 30, max: 50 },
          { label: "Sur place", min: 350, max: 400 },
        ],
      },
      {
        type: "steps",
        title: "Étapes",
        items: [{ label: "Choisir la ville", state: "done" }, { label: "Logement qui dit oui", state: "now" }, { label: "Réserver le train" }],
      },
      {
        type: "actions",
        items: ["Coller les messages du voyage", "Répondre sur Nova"],
        options: [{ label: "Voir les messages du voyage", send: "bloc-choix-voyage" }, { label: "Nova n'a jamais mordu" }],
      },
    ],
    null,
    1
  ),
  "```",
  "",
  "```bots-ui",
  '{ "type": "budget", "lines": "pas une liste" }',
  "```",
  "",
  "```bots-ui-brut",
  '{"type":"table","rows":[["brut-garde"]] "x"}',
  "```",
].join("\n");

// ---- hosted rooms (groups.*) ----
const GROUP_METHODS = [
  "groups.capabilities",
  "groups.list",
  "groups.create",
  "groups.state",
  "groups.log",
  "groups.send",
  "groups.stop",
  "groups.approve",
  "groups.retry",
  "groups.disband",
  "groups.rename",
  "groups.context",
];
type Ev = { room_id: string; seq: number; event_id: string; kind: string; actor: any; payload: any; created_at: number; authority_epoch: number };
const rooms: Record<string, any> = {};
const cron: Record<string, any[]> = {
  default: [
    {
      job_id: "c1",
      name: "Suivi pistes formateur : reponses et relances",
      schedule: "30 8 * * 1-5",
      enabled: true,
      state: "scheduled",
      next_run_at: new Date(Date.now() + 18 * 3600e3).toISOString(),
    },
    {
      job_id: "c2",
      name: "Prospection formateur : nouveaux organismes",
      schedule: "every monday 9am",
      enabled: true,
      state: "scheduled",
      next_run_at: new Date(Date.now() + 4 * 86400e3).toISOString(),
      last_status: "error",
      last_error: "provider timeout",
    },
    { job_id: "c3", name: "Ouverture seance U5 12/11 + VM de demo", schedule: "once at 2026-11-12 08:50", enabled: false, state: "paused" },
  ],
};
const contexts: Record<string, any> = {};
const logs: Record<string, Ev[]> = {};
const driver: Record<string, any> = {};
const member = (p: string, d?: string) => ({
  member_id: p,
  profile: p,
  handle: p === "default" ? "hermes" : p,
  display_name: d,
  target: { kind: "local", profile: p },
});
function mkRoom(room_id: string, name: string, members: any[]) {
  rooms[room_id] = {
    room_id,
    name,
    members,
    authority_gateway_id: "gw-mock",
    authority_epoch: 1,
    revision: 1,
    created_at: now(),
    updated_at: now(),
    latest_seq: 0,
  };
  logs[room_id] = [];
  driver[room_id] = { running: true, working: false, blocked: false, counts: {}, pending_actions: [], member_activity: [], peer_routes: [] };
  push(room_id, "room.created", { kind: "system", id: "gw" }, {});
  return rooms[room_id];
}
function push(room_id: string, kind: string, actor: any, payload: any, event_id = crypto.randomUUID()) {
  const ev = { room_id, seq: logs[room_id].length + 1, event_id, kind, actor, payload, created_at: now(), authority_epoch: 1 };
  logs[room_id].push(ev);
  rooms[room_id].latest_seq = ev.seq;
  rooms[room_id].updated_at = now();
  return ev;
}
function memberTurn(room_id: string, m: any, text: string, delay: number) {
  const d = driver[room_id];
  d.member_activity.push({ member_id: m.member_id, status: "running", tool: "web_search" });
  d.working = true;
  setTimeout(() => {
    d.member_activity = d.member_activity.filter((a: any) => a.member_id !== m.member_id);
    d.working = d.member_activity.length > 0 || d.pending_actions.length > 0;
    const ev = push(room_id, "message.member", { kind: "member", id: m.member_id, profile: m.profile, display_name: m.display_name }, { text });
    mkTrace(
      room_id,
      m.member_id,
      "engine",
      [
        { k: "tool", id: "w1", name: "web_search", args: { query: "sources du cours" }, at: 0, doneAt: 100, output: "3 résultats" },
        { k: "text", text: "J'ai trouvé trois sources.", at: 150 },
      ],
      { endAt: 200, event_id: ev.event_id }
    );
  }, delay);
}
// ---- fil de travail (plugin bot-groups : trace.list / trace.read / member.stop / dispatch.stop) ----
// Un fil est un script daté : chaque entrée apparaît à `at` ms après le début, un outil passe de « running » à « done » à `doneAt`.
type TEntry = { k: "tool" | "text"; id?: string; name?: string; args?: any; text?: string; at: number; doneAt?: number; output?: string };
const traces: Record<string, any[]> = {};
function mkTrace(room_id: string, member_id: string, kind: string, entries: TEntry[], opts: { endAt?: number; event_id?: string | null } = {}) {
  const t = {
    trace_id: (kind === "round" ? "r-" : "dtask:") + crypto.randomUUID().slice(0, 8),
    member_id,
    kind,
    started: now(),
    t0: Date.now(),
    entries,
    endAt: opts.endAt ?? 0,
    event_id: opts.event_id ?? null,
    stoppedAt: 0,
    label: "",
  };
  (traces[room_id] ??= []).push(t);
  return t;
}
const tStatus = (t: any) => (t.stoppedAt ? "stopped" : Date.now() - t.t0 >= t.endAt ? "done" : "running");
function tView(t: any) {
  const el = (t.stoppedAt || Date.now()) - t.t0,
    out: any[] = [];
  t.entries.forEach((e: TEntry, n: number) => {
    if (e.at > el) return;
    if (e.k === "text") out.push({ n, k: "text", text: e.text, ts: t.started + e.at / 1000 });
    else {
      const done = e.doneAt !== undefined && e.doneAt <= el;
      out.push({
        n,
        k: "tool",
        id: e.id,
        name: e.name,
        args: e.args,
        state: done ? "done" : "running",
        ...(done ? { output: e.output, ms: e.doneAt! - e.at } : {}),
        ts: t.started + e.at / 1000,
      });
    }
  });
  return out;
}
const MOCK_FIL: TEntry[] = [
  { k: "tool", id: "c1", name: "terminal", args: { command: "git status" }, at: 0, doneAt: 300, output: "On branch main\nnothing to commit" },
  { k: "text", text: "Je regarde les fichiers modifiés avant de lancer les tests.", at: 400 },
  { k: "tool", id: "c2", name: "read_file", args: { path: "src/main.ts" }, at: 500, doneAt: 900, output: "export const x = 1;" },
  { k: "tool", id: "c3", name: "terminal", args: { command: "bun test" }, at: 1000, doneAt: 60000, output: "12 pass" },
];
mkRoom("r-cours", "Prépa cours", [member("default", "Yaia"), member("rea", "Réa")]);
push("r-cours", "message.user", { kind: "user", id: "u" }, { text: "On prépare le TP 3 ?" });
push("r-cours", "message.member", { kind: "member", id: "default", profile: "default", display_name: "Yaia" }, { text: "Oui, je fais le **déroulé**." });
push(
  "r-cours",
  "message.member",
  { kind: "member", id: "rea", profile: "rea", display_name: "Réa" },
  { text: "Je cherche 2 sources : https://example.com et [local](http://127.0.0.1:9120/x)" }
);
// groupe long (300 messages) : plus que la fenêtre de 120 lignes, pour rejouer en groupe la remontée du fil (parité avec « archive »)
mkRoom("r-long", "Longue discussion", [member("default", "Yaia"), member("rea", "Réa")]);
for (let i = 0; i < 300; i++)
  push(
    "r-long",
    i % 2 ? "message.member" : "message.user",
    i % 2 ? { kind: "member", id: "default", profile: "default", display_name: "Yaia" } : { kind: "user", id: "u" },
    {
      text:
        i === 299
          ? "FIN-DU-GROUPE"
          : i % 2
            ? `Réponse ${i} :\n\n` +
              Array.from(
                { length: 1 + (i % 7) },
                (_, k) => `- point ${k} de la réponse ${i}, assez long pour tenir sur deux lignes à l'écran du téléphone`
              ).join("\n")
            : `Question de groupe ${i}`,
    }
  );

const server = Bun.serve({
  port: Number(process.env.PORT || 8790),
  async fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === "/api/mock/drop") {
      for (const w of sockets) w.close();
      return Response.json({ closed: sockets.size });
    } // coupe tous les sockets (réseau mobile qui tombe)
    if (u.pathname === "/api/mock/refuse") {
      refuse = Number(u.searchParams.get("n") || 0);
      return Response.json({ refuse });
    } // refuse les n prochains tickets (503)
    if (u.pathname === "/api/mock/tickets") return Response.json(ticketLog);
    if (u.pathname === "/api/mock/slow-history") {
      slowHistory = Number(u.searchParams.get("ms") || 800);
      raced = 0;
      return Response.json({ slowHistory });
    }
    if (u.pathname === "/api/mock/raced") return Response.json({ raced }); // prompt.submit reçus pendant une lecture d'historique ralentie // la prochaine lecture d'historique attend ms (fenêtre de synchro d'attach élargie)
    if (u.pathname === "/api/mock/fail-submit") {
      failSubmit = Number(u.searchParams.get("n") || 1);
      return Response.json({ failSubmit });
    } // les n prochains prompt.submit échouent franchement (pas une coupure)
    if (u.pathname === "/api/webapp/socket-ticket" && req.method === "POST") {
      ticketLog.push(Date.now());
      if (refuse > 0) {
        refuse--;
        return new Response("indisponible", { status: 503 });
      }
      const t = crypto.randomUUID();
      tickets.add(t);
      return Response.json({ ticket: t, ttl_seconds: 30 });
    }
    if (u.pathname === "/api/chat/image-upload" && req.method === "POST") {
      const b = await req.json();
      const m = /^data:(image\/[a-z]+);base64,/.exec(b.data_url || "");
      if (!m) return Response.json({ detail: "Unsupported image type" }, { status: 400 });
      (globalThis as any).uploads = [
        ...((globalThis as any).uploads || []),
        { kind: "image", profile: u.searchParams.get("profile"), mime: m[1], name: b.filename },
      ];
      return Response.json({ ok: true, path: `/mock/${u.searchParams.get("profile")}/cache/images/up_${Date.now()}.${m[1].split("/")[1]}`, mime_type: m[1] });
    }
    if (u.pathname === "/api/chat/file-upload" && req.method === "POST") {
      const f = (await req.formData()).get("file") as File;
      (globalThis as any).uploads = [
        ...((globalThis as any).uploads || []),
        { kind: "file", profile: u.searchParams.get("profile"), name: f.name, size: f.size },
      ];
      return Response.json({ ok: true, path: `/mock/${u.searchParams.get("profile")}/uploads/${f.name}`, size: f.size });
    }
    if (u.pathname === "/api/mock/uploads") return Response.json({ uploads: (globalThis as any).uploads || [], submits: (globalThis as any).submits || [] });
    const hm = /^\/api\/sessions\/([^/]+)\/messages$/.exec(u.pathname);
    if (hm && slowHistory) {
      const ms = slowHistory;
      slowHistory = 0;
      historyPending++;
      await Bun.sleep(ms);
      historyPending--;
    }
    if (hm) {
      const g = globalThis as any;
      (g.restHits ??= []).push(u.pathname + u.search);
      const all = (history as any)[decodeURIComponent(hm[1])];
      if (!all) return Response.json({ detail: "not found" }, { status: 404 });
      // Comme la vraie route : limit (500 par défaut), offset, order latest|oldest ; pas d'after_id (incompatible avec include_ancestors).
      const order = u.searchParams.get("order"),
        lim = Math.min(Number(u.searchParams.get("limit") || 500), 500),
        off = Number(u.searchParams.get("offset") || 0);
      const inline = u.searchParams.get("inline_images") !== "false";
      const rows = all.map((m: any, i: number) => ({ m, id: i + 1 }));
      const page =
        order === "latest" || (order === null && !u.searchParams.get("limit"))
          ? rows.slice(Math.max(0, rows.length - off - lim), rows.length - off)
          : rows.slice(off, off + lim);
      return Response.json({
        session_id: hm[1],
        messages: page.map(({ m, id }: any) => ({
          role: m.role,
          content: (m.text ?? m.content) + (inline && m.image ? m.image : ""),
          id,
          name: m.name,
          timestamp: m.timestamp,
          display_kind: m.display_kind,
          ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
          ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
        })),
        pagination: { limit: lim, offset: off, order: order || "oldest", returned: page.length },
      });
    }
    if (u.pathname === "/api/mock/rest") return Response.json((globalThis as any).restHits || []);
    if (u.pathname === "/api/ws") {
      const t = u.searchParams.get("ticket") || "";
      if (!tickets.delete(t)) return new Response("bad ticket", { status: 403 });
      return srv.upgrade(req, { data: { profile: u.searchParams.get("profile") || "default" } }) ? undefined : new Response("no", { status: 400 });
    }
    if (u.pathname === "/bots/log" && req.method === "POST") {
      ((globalThis as any).clientLogs ??= []).push(await req.json());
      return new Response(null, { status: 204 });
    }
    // Lance une tâche de table ronde factice pour un membre : le fil se remplit seul (voir MOCK_FIL), la barre l'affiche.
    if (u.pathname === "/api/mock/round-start" && req.method === "POST") {
      const b = await req.json(),
        t = mkTrace(b.room_id, b.member_id, "round", MOCK_FIL, { endAt: 70000 });
      t.live = {
        at: 1200,
        cps: 30,
        text: "Les tests passent : 12 sur 12. Je résume ce qui a changé dans la branche et ce qu'il reste à vérifier avant le merge.",
      };
      const dj = ((globalThis as any).dispatchJobs ??= {});
      (dj[b.room_id] ??= []).push({
        bot: b.member_id,
        handle: b.member_id,
        name: b.member_id,
        task: "tâche factice",
        status: "running",
        seconds: 1,
        kind: "dispatch",
      });
      return Response.json({ trace_id: t.trace_id });
    }
    if (u.pathname === "/api/mock/stops") return Response.json((globalThis as any).stops || []);
    if (u.pathname === "/api/mock/clientlogs") return Response.json((globalThis as any).clientLogs || []);
    if (u.pathname === "/bots/prefs") {
      if (req.method === "POST") {
        const b = await req.json();
        mockPrefs = {
          pinned: b.pinned,
          labels: b.labels,
          avatars: b.avatars ?? (mockPrefs as any).avatars,
          bubble: b.bubble ?? (mockPrefs as any).bubble,
          updated: new Date().toISOString(),
        };
      }
      return Response.json(mockPrefs);
    }
    if (u.pathname === "/bots") return Response.redirect("/bots/", 302);
    if (u.pathname.startsWith("/bots/")) {
      const rel = u.pathname.slice(6) || "index.html";
      const f = Bun.file(join(APP, rel));
      return (await f.exists())
        ? new Response(f, { headers: { "Cache-Control": rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache" } })
        : new Response("404", { status: 404 });
    }
    return new Response("not found", { status: 404 });
  },
  websocket: {
    open(ws) {
      sockets.add(ws);
    },
    close(ws) {
      sockets.delete(ws);
    },
    message(ws, raw) {
      const d = JSON.parse(String(raw));
      const send = (o: any) => ws.send(JSON.stringify(o));
      const ok = (result: any) => send({ jsonrpc: "2.0", id: d.id, result });
      const ev = (sid: string, type: string, payload?: any) =>
        send({ jsonrpc: "2.0", method: "event", params: { type, session_id: sid, ...(payload ? { payload } : {}) } });
      const p = d.params || {};
      if (d.method === undefined && d.result) {
        // reply to our approval request
        ev("rt-1", "message.delta", { text: d.result.choice === "deny" ? " Refusé, j'arrête." : " Commande lancée, tout est vert." });
        setTimeout(() => ev("rt-1", "message.complete", { text: "", response_reused: true, status: "complete" }), 200);
        return;
      }
      if (String(d.method).startsWith("groups.") && p.room_id && !["groups.create"].includes(d.method) && !rooms[p.room_id])
        return send({ jsonrpc: "2.0", id: d.id, error: { code: 4004, message: "not_found" } });
      switch (d.method) {
        case "groups.capabilities":
          return ok({
            protocol_version: 1,
            driver: true,
            persistent_process: true,
            authority_gateway_id: "gw-mock",
            room_link: { enabled: false, reason: "off" },
            features: [],
            methods: GROUP_METHODS,
            max_log_limit: 500,
            seatable_profiles: ["default", "rea", "hermes-hard"],
          });
        case "groups.list":
          return ok({ rooms: Object.values(rooms).sort((a, b) => b.updated_at - a.updated_at) });
        case "groups.create":
          return ok({ room: rooms[p.room_id] || mkRoom(p.room_id, p.name, p.members) });
        case "groups.state":
          return ok({
            room: rooms[p.room_id],
            driver_status: driver[p.room_id],
            context: contexts[p.room_id] ?? { purpose: "", notes: "", routing: "everyone", lead_member_id: null },
          });
        case "groups.log": {
          const evs = logs[p.room_id].filter((e) => e.seq > (p.since_seq || 0));
          return ok({
            events: evs,
            cursor: evs.at(-1)?.seq ?? (p.since_seq || 0),
            latest_seq: rooms[p.room_id].latest_seq,
            has_more: false,
            authority: { gateway_id: "gw-mock", epoch: 1 },
          });
        }
        case "groups.send": {
          const r = rooms[p.room_id];
          const sid = userEventId(p.event_id);
          const dup = logs[p.room_id].find((e) => e.event_id === sid);
          const ev = dup || push(p.room_id, "message.user", { kind: "user", id: "u" }, p.payload, sid);
          if (!dup) {
            if (/rm|supprime/i.test(p.payload.text)) {
              driver[p.room_id].working = true;
              driver[p.room_id].pending_actions.push({
                kind: "approval",
                member_id: "default",
                task_id: "t-9",
                execution_generation: 1,
                request_id: "ap-1",
                approval: { request_id: "ap-1", command: "rm -rf ./old", description: "Suppression récursive", choices: ["once", "session", "deny"] },
              });
            } else
              r.members.forEach((m: any, i: number) =>
                memberTurn(
                  p.room_id,
                  m,
                  /^recap/i.test(p.payload.text) && !i ? RECAP : (m.display_name || m.profile) + " : bien reçu « " + p.payload.text + " ».",
                  900 + i * 900
                )
              );
          }
          setTimeout(() => ok({ event: ev, client_event_id: p.event_id, accepted: true, driver_started: true }), /@/.test(p.payload.text) ? 2500 : 0);
          return;
        }
        case "groups.approve": {
          const dr = driver[p.room_id];
          dr.pending_actions = dr.pending_actions.filter((a: any) => a.request_id !== p.request_id);
          if (p.choice === "deny") {
            dr.working = false;
            push(p.room_id, "turn.cancelled", { kind: "member", id: p.member_id, profile: p.member_id }, { reason: "denied" });
          } else memberTurn(p.room_id, rooms[p.room_id].members[0], "Commande lancée, dossier supprimé.", 600);
          return ok({ approved: true, result: {} });
        }
        case "groups.stop": {
          const dr = driver[p.room_id];
          const n = dr.member_activity.length;
          dr.member_activity = [];
          dr.working = false;
          push(p.room_id, "room.stop_requested", { kind: "user", id: "u" }, {});
          return ok({ cancelled: n });
        }
        case "groups.rename": {
          rooms[p.room_id].name = p.name;
          return ok({ room: rooms[p.room_id] });
        }
        case "groups.context": {
          const prev = contexts[p.room_id] ?? { purpose: "", notes: "", routing: "everyone", lead_member_id: null };
          const routing = p.routing ?? prev.routing,
            lead = p.lead_member_id ?? prev.lead_member_id;
          if (routing === "lead" && !rooms[p.room_id].members.some((m: any) => m.member_id === lead))
            return send({ jsonrpc: "2.0", id: d.id, error: { code: -32602, message: "invalid_params", data: { fields: ["lead_member_id"] } } });
          contexts[p.room_id] = { purpose: p.purpose ?? prev.purpose, notes: p.notes ?? prev.notes, routing, lead_member_id: routing === "lead" ? lead : null };
          return ok({ context: contexts[p.room_id] });
        }
        case "groups.disband": {
          const r = rooms[p.room_id];
          r.disbanded_at = now();
          return ok({ tombstone: { room_id: p.room_id, disbanded_at: now(), idempotent: false } });
        }
        case "session.active_list": {
          // strict like a profile-bound ticket: another profile is refused
          const prof = p.profile || ws.data.profile;
          if (prof !== ws.data.profile) return send({ jsonrpc: "2.0", id: d.id, error: { code: 4001, message: "profile_mismatch" } });
          const live: Record<string, any[]> = {
            default: [{ id: "s-d", title: "Bot Chat", status: "working" }],
            rea: [{ id: "s-r", title: "Bot Chat", status: "waiting" }],
            "hermes-hard": [
              { id: "s-g", title: "Group: r-cours", status: "working" },
              { id: "s-h", title: "Bot Chat", status: "idle" },
            ],
          };
          return ok({
            sessions: (live[prof] || []).map((x) => ({
              ...x,
              session_key: x.id,
              current: false,
              last_active: now(),
              started_at: now(),
              message_count: 1,
              model: "",
              preview: "",
            })),
          });
        }
        case "profiles.list":
          return ok({ profiles, bot_mode_protocol: true, install_id: "mock" });
        case "profiles.describe":
          return ok({
            name: p.name,
            description: "Bot de test du mock",
            soul: "# Âme\nTu es direct et vérificateur.",
            model: { provider: "mock", default: "mock-1" },
            skills: [
              { name: "recherche", enabled: true },
              { name: "vieux-skill", enabled: false },
            ],
            toolsets: [],
            toolsets_pinned: false,
            mcp_servers: [{ name: "drive", enabled: true, transport: "http" }],
          });
        case "profiles.configure": {
          const prof: any = profiles.find((x: any) => x.name === p.name);
          if (!prof) return send({ jsonrpc: "2.0", id: d.id, error: { code: 4004, message: "not_found" } });
          const rev = prof.ui_meta_revisions?.["hermes-bots"] ?? 0;
          if (p.ui_meta_expected_revisions && p.ui_meta_expected_revisions["hermes-bots"] !== rev)
            return ok({
              applied: { ui_meta: false, ui_meta_conflicts: { "hermes-bots": { expected: p.ui_meta_expected_revisions["hermes-bots"], actual: rev } } },
            });
          prof.ui_meta = { ...(prof.ui_meta || {}), ...p.ui_meta };
          prof.ui_meta_revisions = { ...(prof.ui_meta_revisions || {}), "hermes-bots": rev + 1 };
          return ok({ applied: { ui_meta: true, ui_meta_revisions: prof.ui_meta_revisions } });
        }
        case "complete.path": {
          const all = [
            { text: "@diff", display: "@diff", meta: "git diff" },
            { text: "@file:", display: "@file:", meta: "attach file" },
            { text: "@url:", display: "@url:", meta: "fetch url" },
            { text: "@formation", display: "@formation", meta: "Formation" },
            { text: "@knowledge", display: "@knowledge", meta: "Knowledge" },
          ];
          const q = String(p.word || "")
            .slice(1)
            .toLowerCase();
          return ok({ items: all.filter((x) => x.text.slice(1).startsWith(q)) });
        }
        case "cron.manage": {
          const store = (cron[p.profile || "default"] ??= []);
          if (p.action === "list")
            return ok({ success: true, count: store.length, jobs: store.filter((j: any) => p.include_disabled || j.enabled), scoped: p.profile });
          const j: any = store.find((x: any) => x.job_id === p.name);
          if (!j) return ok({ success: false, error: "job not found" });
          j.enabled = p.action === "resume";
          j.state = j.enabled ? "scheduled" : "paused";
          return ok({ success: true, job: j });
        }
        case "session.list":
          return ok({ sessions: [] });
        case "session.create":
          history["s-new"] = [];
          return ok({ session_id: "rt-1", stored_session_id: "s-new", message_count: 0, messages: [], info: {} });
        case "session.resume":
          {
            const extra = Object.keys(p).filter((k) => !["session_id", "omit_messages"].includes(k)); // strict comme le contrat canonique
            if (extra.length) return send({ jsonrpc: "2.0", id: d.id, error: { code: -32602, message: "invalid_params", data: { fields: extra } } });
          }
          (ws as any).stored = p.session_id;
          if ((history as any)[p.session_id]) (ws as any).durable = p.session_id;
          return ok({
            session_id: "rt-1",
            stored_session_id: p.session_id,
            message_count: (history[p.session_id] || []).length,
            messages: p.omit_messages ? [] : (history[p.session_id] || []).map((m: any) => (m.image ? { ...m, text: m.text + m.image } : m)),
            info: {},
            running: !!(ws as any).turn?.busy,
            execution_generation: 7,
            revision: 3,
          });
        case "session.history": {
          const g = globalThis as any;
          if (p.session_id === "s-archive")
            return ok({ count: BIG, messages: history["s-archive"].map((m: any) => (m.image ? { ...m, text: m.text + m.image } : m)) });
          g.undoHist ??= [
            { role: "user", text: "Bonjour", row_id: 11 },
            { role: "assistant", text: "Salut", row_id: 12 },
            { role: "user", text: "Fais X", row_id: 13 },
            { role: "assistant", text: "X fait", row_id: 14 },
            {
              role: "user",
              display_kind: "internal_notification",
              text: '[Cronjob "Brief matinal 8h00" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]\n\nAgenda du jour vide.\n\nProchaine échéance **mardi 17 novembre**, BTS2 U5, salle 103.',
              row_id: 15,
            },
            { role: "assistant", text: "Le pack du 17/11 existe déjà sur le Drive : rien à préparer.", row_id: 16 },
            {
              role: "user",
              display_kind: "internal_notification",
              text: "[Cronjob \"Marktplaats Apify\" output — scheduled job, not the user.]\n\n⚠ Cron watchdog 'Marktplaats' script failed\n\nHTTP 401",
              row_id: 17,
            },
          ];
          return ok({ count: g.undoHist.length, messages: g.undoHist });
        }
        case "session.mutate": {
          const g = globalThis as any;
          if (p.expected_revision !== 3 || p.expected_generation !== 7)
            return send({ jsonrpc: "2.0", id: d.id, error: { code: 4001, message: "stale_revision" } });
          // Comme la vraie base : l'id de ligne est celui de la route REST /messages (rang + 1 dans ce mock) ; le fil est coupé avant lui.
          if (p.operation === "rewind") {
            const sid = (ws as any).durable || p.session_id,
              h = (history as any)[sid] || [],
              i = p.payload.target_message_id - 1;
            if (!Number.isInteger(i) || h[i]?.role !== "user") return send({ jsonrpc: "2.0", id: d.id, error: { code: 4001, message: "invalid_params" } });
            (history as any)[sid] = h.slice(0, i);
            return ok({ session_id: p.session_id, operation: "rewind", revision: 4 });
          }
          if (p.operation === "model") {
            if (/inconnu/.test(p.payload.model)) return send({ jsonrpc: "2.0", id: d.id, error: { code: 4001, message: "model_resolution_failed" } });
            if (/opus/i.test(p.payload.model) && p.payload.confirm !== "tok-1")
              return ok({
                session_id: p.session_id,
                operation: "model",
                status: "confirmation_required",
                confirm_required: true,
                confirm: "tok-1",
                target_model: p.payload.model,
                confirm_message: "Opus coûte environ 10 fois plus cher.",
              });
            return ok({ session_id: p.session_id, operation: "model", revision: 4, model: p.payload.model });
          }
          return ok({});
        }
        case "complete.slash": {
          const all = [
            ["new", "Start a new session"],
            ["undo", "Remove the last exchange"],
            ["reload-mcp", "Reload MCP servers (usage: /reload-mcp)"],
            ["redraw", "Force a full UI repaint"],
            ["model", "Switch model (usage: /model <name>)"],
            ["retry", "Retry the last message"],
          ];
          const w = String(p.text).slice(1).toLowerCase();
          return ok({
            replace_from: 1,
            items: all.filter(([n]) => n.startsWith(w)).map(([n, m]) => ({ text: n, display: "/" + n, meta: m, kind: "command" })),
          });
        }
        case "reload.mcp":
          return p.confirm ? ok({ status: "reloaded" }) : ok({ status: "confirm_required", message: "x" });
        case "plugin.bot-groups.trace.list": {
          const rows = (traces[p.room_id] ?? []).map((t) => ({
            trace_id: t.trace_id,
            member_id: t.member_id,
            kind: t.kind,
            started: t.started,
            ended: null,
            status: tStatus(t),
            label: t.label,
            event_id: t.event_id,
          }));
          return ok({ room_id: p.room_id, traces: rows.sort((a, b) => b.started - a.started), keep_days: 30 });
        }
        case "plugin.bot-groups.trace.read": {
          const t = (traces[p.room_id] ?? []).find((x) => x.trace_id === p.trace_id);
          if (!t) return send({ jsonrpc: "2.0", id: d.id, error: { code: -32000, message: "fil introuvable ou expiré" } });
          const open = new Set(p.open || []),
            all = tView(t);
          return ok({
            trace_id: t.trace_id,
            member_id: t.member_id,
            kind: t.kind,
            status: tStatus(t),
            label: t.label,
            started: t.started,
            total: all.length,
            entries: all.filter((e) => e.n > (p.after ?? -1) || open.has(e.id)),
          });
        }
        case "plugin.bot-groups.trace.live": {
          // texte que chaque bot est en train d'écrire (plugin live.py) : révélé à `cps` signes par seconde
          const out: Record<string, any> = {};
          for (const t of traces[p.room_id] ?? []) {
            if (tStatus(t) !== "running" || !t.live) continue;
            const n = Math.floor(((Date.now() - t.t0 - t.live.at) / 1000) * t.live.cps);
            if (n > 0) out[t.trace_id] = { id: t.trace_id + ":final", text: t.live.text.slice(0, n), done: n >= t.live.text.length, member_id: t.member_id };
          }
          return ok({ live: out });
        }
        case "plugin.bot-groups.member.stop": {
          const mine = (traces[p.room_id] ?? []).filter((t) => t.member_id === p.member_id && tStatus(t) === "running");
          mine.forEach((t) => {
            t.stoppedAt = Date.now();
          });
          const dj = ((globalThis as any).dispatchJobs ??= {});
          dj[p.room_id] = (dj[p.room_id] ?? []).filter((j: any) => j.bot !== p.member_id);
          ((globalThis as any).stops ??= []).push({ method: "member.stop", room_id: p.room_id, member_id: p.member_id });
          return ok({ ok: true, member_id: p.member_id, engine: 0, round: mine.length });
        }
        case "plugin.bot-groups.dispatch.stop": {
          const mine = (traces[p.room_id] ?? []).filter((t) => t.kind === "round" && tStatus(t) === "running");
          mine.forEach((t) => {
            t.stoppedAt = Date.now();
          });
          ((globalThis as any).dispatchJobs ??= {})[p.room_id] = [];
          ((globalThis as any).stops ??= []).push({ method: "dispatch.stop", room_id: p.room_id });
          return ok({ ok: true, stopped: mine.length });
        }
        case "plugin.bot-groups.inbox.send": {
          // inbox.rpc_send : message gardé pendant une discussion ; ici le bot finit aussitôt, le message entre dans le groupe
          const sid = userEventId(p.event_id);
          if (!logs[p.room_id].some((e) => e.event_id === sid)) push(p.room_id, "message.user", { kind: "user", id: "u" }, p.payload, sid);
          return ok({ ok: true, held: true, client_event_id: p.event_id });
        }
        case "plugin.bot-groups.steer.send": {
          // steer.rpc_send : groupe au repos = fallback (la PWA envoie normalement) ; sinon gardé en tête, il entre aussitôt et les membres répondent
          if (!driver[p.room_id]?.working) return ok({ mode: "fallback" });
          const sid = userEventId(p.event_id);
          if (!logs[p.room_id].some((e) => e.event_id === sid)) {
            push(p.room_id, "message.user", { kind: "user", id: "u" }, { text: p.text, thread_id: p.event_id }, sid);
            rooms[p.room_id].members.forEach((m: any, i: number) =>
              memberTurn(p.room_id, m, /^recap/i.test(p.text) && !i ? RECAP : (m.display_name || m.profile) + " : bien reçu « " + p.text + " ».", 900 + i * 900)
            );
          }
          return ok({ mode: "held" });
        }
        case "plugin.bot-groups.inbox.cancel":
          return ok({ cancelled: false });
        case "plugin.bot-groups.inbox.status":
          return ok({ held: [] }); // demandes suivantes et recadrages gardés par le plugin (inbox.py)
        case "plugin.bot-groups.dispatch.status":
          return ok({ room_id: p.room_id, jobs: ((globalThis as any).dispatchJobs ?? {})[p.room_id] ?? [] });
        case "plugin.bot-groups.tasks.list":
        case "plugin.bot-groups.tasks.add":
        case "plugin.bot-groups.tasks.update":
        case "plugin.bot-groups.tasks.remove": {
          const all = ((globalThis as any).groupTasks ??= {}),
            list = (all[p.room_id] ??= []),
            verb = d.method.split(".").pop();
          if (verb === "add") {
            const hit = p.source && list.find((t: any) => t.source === p.source);
            if (hit) return ok({ task: hit });
            const t = {
              id: "t" + (list.length + 1),
              parent: p.parent ?? null,
              title: p.title,
              status: "todo",
              owner: null,
              by: "yoan",
              source: p.source ?? null,
              proof: null,
              note: null,
              created: Date.now() / 1000,
              updated: Date.now() / 1000,
            };
            list.push(t);
            return ok({ task: t });
          }
          if (verb === "update") {
            const t = list.find((x: any) => x.id === p.id);
            if (!t) return send({ jsonrpc: "2.0", id: d.id, error: { code: 4001, message: "tâche introuvable" } });
            if (p.status) {
              t.status = p.status;
              if (p.status !== "done") t.proof = null;
            }
            return ok({ task: t });
          }
          if (verb === "remove") {
            all[p.room_id] = list.filter((x: any) => x.id !== p.id && x.parent !== p.id);
            return ok({ removed: list.length - all[p.room_id].length });
          }
          return ok({ room_id: p.room_id, tasks: list });
        }
        case "plugin.bot-groups.settings.get":
          return ok({
            ...((globalThis as any).teamCfg ?? { max_members: 10, max_rounds: 5, max_messages: 50 }),
            bounds: { max_members: [2, 16], max_rounds: [1, 10], max_messages: [2, 200] },
          });
        case "plugin.bot-groups.settings.set": {
          const t = { max_members: 10, max_rounds: 5, max_messages: 50, ...(globalThis as any).teamCfg, ...p };
          (globalThis as any).teamCfg = t;
          return ok(t);
        }
        case "session.interrupt":
          if (p.execution_generation !== undefined && p.execution_generation !== 7)
            return send({ jsonrpc: "2.0", id: d.id, error: { code: 4009, message: "stale_generation" } });
          if (p.execution_generation === undefined)
            return send({ jsonrpc: "2.0", id: d.id, error: { code: -32602, message: "invalid_params", data: { fields: ["execution_generation"] } } });
          {
            const t = (ws as any).turn;
            if (t) {
              clearInterval(t.tick);
              t.busy = false;
              t.queue = [];
            }
          }
          ev("rt-1", "message.complete", { text: "", status: "interrupted" });
          return ok({ ok: true });
        case "clarify.respond": {
          if (p.prompt_id !== "cq-1" || p.execution_generation !== 7 || typeof p.answer !== "string" || !p.session_id)
            return send({ jsonrpc: "2.0", id: d.id, error: { code: 4001, message: "invalid_params" } });
          ok({ status: "resolved", prompt_id: p.prompt_id });
          ev("rt-1", "clarify.settled", { prompt_id: "cq-1" });
          const t = "Réponse reçue : " + (p.answer || "(passée)");
          ev("rt-1", "message.delta", { text: t });
          ev("rt-1", "message.complete", { text: t, status: "complete" });
          (ws as any).turn.busy = false;
          return;
        }
        case "prompt.submit": {
          (globalThis as any).submits = [
            ...((globalThis as any).submits || []),
            { id: p.submission_id, text: p.text, queued: !!p.queued, attachments: p.attachments },
          ];
          if (typeof p.submission_id !== "string")
            return send({ jsonrpc: "2.0", id: d.id, error: { code: -32602, message: "invalid_params", data: { fields: ["submission_id"] } } });
          if (historyPending) raced++;
          if (failSubmit > 0) {
            failSubmit--;
            return send({ jsonrpc: "2.0", id: d.id, error: { code: 5003, message: "provider_unavailable" } });
          }
          {
            const g = globalThis as any;
            const seenSubs: Set<string> = (g.seenSubs ??= new Set()); // même submission_id : pas de second tour (idempotence du gateway)
            if (seenSubs.has(p.submission_id)) return ok({ status: "duplicate", execution_generation: 7 });
            seenSubs.add(p.submission_id);
          }
          const turn = ((ws as any).turn ??= { busy: false, queue: [] as string[] });
          const run = (text: string) => {
            turn.busy = true;
            const hist = history[(ws as any).stored];
            hist?.push({ role: "user", text });
            ev("rt-1", "message.start", { execution_generation: 7 });
            const words = /^recap/i.test(text)
              ? (RECAP.match(/[\s\S]{1,160}/g) as string[])
              : ("Bien reçu : « " + text + " ». Je regarde ça en détail, une seconde.").split(/(?<= )/);
            let i = 0;
            const tick = (turn.tick = setInterval(
              () => {
                if (turn.steer) {
                  ev("rt-1", "message.delta", { text: " [guidage lu : " + turn.steer + "] " });
                  turn.steer = null;
                }
                if (i < words.length) return ev("rt-1", "message.delta", { text: words[i++] });
                clearInterval(tick);
                ev("rt-1", "message.complete", { text: words.join(""), status: "complete" });
                hist?.push({ role: "assistant", text: words.join("") });
                turn.busy = false;
                const next = turn.queue.shift();
                if (next) setTimeout(() => run(next), 200);
              },
              Number(process.env.MOCK_TICK_MS) || 250
            )); // le smoke l'accélère (MOCK_TICK_MS), le mock seul garde le rythme d'un vrai flux
          };
          if (turn.busy) {
            if (!p.queued) {
              (globalThis as any).seenSubs.delete(p.submission_id);
              return send({ jsonrpc: "2.0", id: d.id, error: { code: 4009, message: "session_busy" } });
            }
            turn.queue.push(p.text);
            return ok({ status: "queued", execution_generation: 7 });
          }
          if (/doublon/i.test(p.text)) {
            // final answer sealed as interim, then complete with the same text
            ok({ status: "started", execution_generation: 7 });
            const a = "Réponse finale unique.",
              b2 = "Second segment.";
            ev("rt-1", "message.start", { execution_generation: 7 });
            ev("rt-1", "message.delta", { text: a });
            ev("rt-1", "message.interim", { text: a, already_streamed: true });
            if (/doublon2/i.test(p.text)) {
              setTimeout(() => ev("rt-1", "message.complete", { text: a, status: "complete" }), 200);
              return;
            }
            ev("rt-1", "message.interim", { text: b2, already_streamed: false });
            setTimeout(() => ev("rt-1", "message.complete", { text: b2, status: "complete" }), 200);
            return;
          }
          if (/question/i.test(p.text)) {
            // clarify: wait for clarify.respond, no timeout
            ok({ status: "started", execution_generation: 7 });
            turn.busy = true;
            ev("rt-1", "message.start", { execution_generation: 7 });
            const multi = /multi/i.test(p.text);
            ev("rt-1", "clarify.request", {
              kind: "clarify",
              prompt_id: "cq-1",
              execution_generation: 7,
              question: multi ? "Quelles villes ?" : "On part sur **Lyon** ?",
              choices: multi ? ["Lyon", "Nice", "Grenoble"] : ["Oui (Recommandé)", "Non"],
              multi_select: multi,
            });
            return;
          }
          ok({ status: "started", execution_generation: 7 });
          run(p.text);
          return;
        }
        case "session.redirect": // recadrage (Entrée pendant un tour) : même chemin que le guidage, lu tout de suite
        case "session.steer": {
          if (p.execution_generation !== 7)
            return send({ jsonrpc: "2.0", id: d.id, error: { code: -32602, message: "invalid_params", data: { fields: ["execution_generation"] } } });
          const turn = (ws as any).turn;
          if (!turn?.busy) return ok({ status: "rejected", text: p.text, execution_generation: 7, authority_epoch: 1, delivered: false });
          turn.steer = p.text;
          return ok({ status: d.method === "session.redirect" ? "redirected" : "queued", text: p.text, execution_generation: 7, authority_epoch: 1 });
        }
        default:
          return send({ jsonrpc: "2.0", id: d.id, error: { code: -32601, message: "unknown " + d.method } });
      }
    },
  },
});
let mockPrefs: { pinned: string[]; labels?: Record<string, string>; updated: string | null } = { pinned: [], updated: null };
console.log("mock on http://localhost:" + server.port + "/bots/");
