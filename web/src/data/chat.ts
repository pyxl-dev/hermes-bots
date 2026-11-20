// Conversation d'un bot : ouverture, attache au gateway, événements, historique paginé et en cache, envoi
// (direct, demande suivante, recadrage), file hors ligne, arrêt, accords et questions, commandes à confirmation.
// Identité : (profil, session titrée « Bot Chat »), résolue à chaque ouverture, jamais un id de session gardé.
import { batch } from "solid-js";
import { createStore } from "solid-js/store";
import { AuthError, Gateway, LOGIN_URL } from "../lib/gateway";
import { cacheKey, cachePush, cacheSave, idb, rowId, rowKey, store } from "../lib/store";
import { SYNTHETIC_KINDS, TASK_RE, apiErr, asText, isSilent, looksSynthetic, newSubId, report, toMs } from "../lib/util";
import { app, botName, findBot, markMentionsSeen, setApp, setSeen } from "./app";
import { type Staged, clearReply, insertText, replyPrefix, takeStaged } from "./composer";
import { type ConvBase, type ConvUi, conv, notify, rememberChat, setConv, show } from "./conv";
import { type Card, type Item, type Msg, Thread, actionVerb, answerCard } from "./thread";
import { LiveTurn } from "./turn";

const CANONICAL_TITLE = "Bot Chat";
export const HISTORY_PAGE = 200,
  SYNC_PAGE = 40,
  OLDER_PAGE = 100,
  IDB_KEEP = 2000;

export type BotConv = ConvBase & {
  kind: "bot";
  bot: any;
  gw: Gateway | null;
  sid: string | null;
  durable: string | null;
  gen: number | null;
  turn: LiveTurn | null;
  prompts: Map<string, number>;
  queued: number[];
  rows: any[] | null;
  moreOlder: boolean;
  olderBusy: boolean;
  attaching: boolean;
  syncing: boolean;
  retries: number;
  retryTimer: any;
  failNoted: boolean;
  lastEvent: number;
  unsolicited: boolean;
  flushing: boolean;
};

const idle = (c: BotConv) => c.bot.model || c.bot.description || "";
function makeConv(bot: any): BotConv {
  const [ui, setUi] = createStore<ConvUi>({ busy: false, sub: "", streaming: false, tool: "", flash: "", online: false });
  return {
    kind: "bot",
    key: bot.name,
    bot,
    thread: new Thread(),
    ui,
    setUi: (p) => setUi(p),
    gw: null,
    sid: null,
    durable: null,
    gen: null,
    turn: null,
    prompts: new Map(),
    queued: [],
    rows: null,
    moreOlder: false,
    olderBusy: false,
    attaching: false,
    syncing: false,
    retries: 0,
    retryTimer: null,
    failNoted: false,
    lastEvent: 0,
    unsolicited: false,
    flushing: false,
  };
}
export const current = (): BotConv | null => {
  const c = conv();
  return c?.kind === "bot" ? c : null;
};
const live = (c: BotConv) => current() === c;
// pendant la synchro d'attach, un envoi passe par la file : sinon l'instantané d'attach écrase l'état du tour qu'il vient de lancer
export const chatUp = (c: BotConv) => !!c.sid && !!c.gw?.up && !c.syncing;
export const isLinkErr = (e: any) => /non connecté|socket fermé|délai dépassé/.test(String(e?.message || ""));
const note = (c: BotConv, t: string) => c.thread.addNote(t);

export function setBusy(c: BotConv, busy: boolean) {
  batch(() => {
    c.setUi({ busy, ...(busy ? {} : { streaming: false, tool: "" }) });
    if (live(c)) setApp("live", { key: c.key, busy });
  });
}
function flash(c: BotConv, text: string) {
  c.setUi({ flash: text });
  setTimeout(() => {
    if (c.ui.flash === text) c.setUi({ flash: "" });
  }, 2500);
}
export const subLine = (c: BotConv) => c.ui.flash || c.ui.sub || idle(c);

// ---------- historique -> éléments du fil ----------
function rowsToItems(t: Thread, messages: any[]): Item[] {
  const out: Item[] = [];
  const tmp = new Thread(); // fabrique les éléments sans toucher le fil affiché
  const args = new Map<string, any>(); // arguments des appels, rangés par Hermes dans tool_calls du message assistant
  for (const m of messages || []) {
    if (m.role === "assistant" && Array.isArray(m.tool_calls))
      for (const tc of m.tool_calls) {
        if (!tc?.id) continue;
        try {
          args.set(tc.id, JSON.parse(tc.function?.arguments || "{}"));
        } catch {
          args.set(tc.id, {});
        }
      }
    const text = asText(m.text ?? m.content);
    if (SYNTHETIC_KINDS.has(m.display_kind)) continue;
    if (m.role === "user") {
      const tk = TASK_RE.exec(text);
      if (tk) tmp.addTask(tk[1], tk[2], m.timestamp);
      else if (!looksSynthetic(text)) tmp.addMsg("user", text, { ts: m.timestamp, rid: rowId(m) } as any);
    } else if (m.role === "assistant") {
      if (text.trim() && !isSilent(text)) tmp.addMsg("assistant", text, { ts: m.timestamp, rid: rowId(m) } as any);
    } else if (m.role === "tool")
      tmp.addTool(m.tool_call_id, m.name || m.tool_name || "outil", toolArg(m, args.get(m.tool_call_id)), "done", text ? text.slice(0, 4000) : undefined);
  }
  for (const it of tmp.items) out.push(JSON.parse(JSON.stringify(it)));
  // réutilise les éléments déjà affichés (même ligne, même texte) : pas de redessin à la synchronisation
  const old = new Map<string, Item>();
  for (const it of t.items) if ((it as any).rid != null && it.k === "msg") old.set(it.role + (it as any).rid, it);
  return out.map((it) => {
    const o = it.k === "msg" && (it as any).rid != null ? old.get(it.role + (it as any).rid) : null;
    return o && o.k === "msg" && o.text === (it as any).text && !o.st ? o : it;
  });
}
// Argument court d'un appel d'outil gardé dans l'historique (tool_calls du message assistant absent : le nom suffit).
const ARG_KEYS = ["path", "file_path", "filename", "url", "query", "pattern", "command"];
const toolArg = (m: any, a?: any) => {
  const k = a && ARG_KEYS.find((x) => typeof a[x] === "string" && a[x]);
  return String(m.preview || m.context || (k ? a[k] : "") || "").slice(0, 120);
};

export function renderHistory(c: BotConv, messages: any[], opts: { cached?: boolean } = {}) {
  if (!opts.cached) cacheSave(c.bot.name, messages);
  const items = rowsToItems(c.thread, messages);
  c.thread.replace(items);
  for (const m of [...c.thread.items]) if (m.k === "msg" && m.st === "queued") c.thread.patch(m.key, { st: "" });
  renderOutbox(c, opts.cached ? null : messages);
}

function slimRow(m: any) {
  return {
    id: rowId(m),
    row_id: rowId(m),
    role: m.role,
    text: asText(m.text ?? m.content).slice(0, 20000),
    name: m.name || m.tool_name,
    tool_call_id: m.tool_call_id,
    timestamp: m.timestamp,
    display_kind: m.display_kind,
    // arguments des appels gardés en court (chemin, requête) : la ligne d'action et la fiche du bot nomment le fichier
    ...(Array.isArray(m.tool_calls)
      ? {
          tool_calls: m.tool_calls.map((tc: any) => ({
            id: tc?.id,
            function: { name: tc?.function?.name, arguments: String(tc?.function?.arguments || "").length <= 600 ? tc.function.arguments : "{}" },
          })),
        }
      : {}),
  };
}
export async function fetchPage(c: BotConv, params: Record<string, string>) {
  const id = c.durable || c.sid!;
  const q = new URLSearchParams({ order: "latest", inline_images: "false", ...params });
  if (!c.bot.is_default) q.set("profile", c.bot.name);
  const r = await fetch("/api/sessions/" + encodeURIComponent(id) + "/messages?" + q, { credentials: "same-origin" });
  if (r.status === 401 || r.status === 403) throw new AuthError("login");
  if (!r.ok) throw await apiErr(r);
  return ((await r.json()).messages || []).map((m: any) => ({ ...m, text: m.display_content ?? m.content, row_id: rowId(m) }));
}
// Seule la dernière page est lue (la Bot Chat de Hermes fait 18 000 messages) ; le cache IndexedDB garde les lignes
// avec leur id, et à l'ouverture on ne demande qu'une petite page qu'on recolle au cache par id.
export async function loadHistory(c: BotConv) {
  try {
    const key = rowKey(c.bot.name),
      saved = await idb.get(key);
    const cached: any[] = saved && saved.sid === (c.durable || c.sid) && Array.isArray(saved.rows) ? saved.rows.filter((m: any) => Number.isInteger(m.id)) : [];
    const lastId = cached.length ? cached[cached.length - 1].id : null;
    let page = await fetchPage(c, { limit: String(lastId === null ? HISTORY_PAGE : SYNC_PAGE) });
    let rows: any[];
    const overlap = lastId !== null && page.some((m: any) => m.id === lastId);
    if (overlap) rows = cached.filter((m) => m.id <= lastId).concat(page.filter((m: any) => m.id > lastId).map(slimRow));
    else {
      if (page.length === SYNC_PAGE && lastId !== null) page = await fetchPage(c, { limit: String(HISTORY_PAGE) }); // beaucoup de nouveautés, ou fil réécrit
      const ov = lastId !== null && page.some((m: any) => m.id === lastId);
      rows = ov ? cached.filter((m) => m.id <= lastId).concat(page.filter((m: any) => m.id > lastId).map(slimRow)) : page.map(slimRow);
      c.moreOlder = page.length >= HISTORY_PAGE;
    }
    if (overlap) c.moreOlder = rows.length >= HISTORY_PAGE || !!saved?.more;
    c.rows = rows;
    idb.put(key, { sid: c.durable || c.sid, rows: rows.slice(-IDB_KEEP), more: !!c.moreOlder });
    return rows;
  } catch (e) {
    if (e instanceof AuthError) throw e;
    // repli : le cache du téléphone (jamais session.history, qui renvoie tout le fil)
    c.rows = null;
    c.moreOlder = false;
    report("rpc", "historique paginé indisponible : " + ((e as any)?.message || e), "loadHistory");
    const saved = await idb.get(rowKey(c.bot.name));
    const rows = saved?.sid === (c.durable || c.sid) && Array.isArray(saved.rows) && saved.rows.length ? saved.rows : store.get(cacheKey(c.bot.name), []);
    if (!rows.length) throw e;
    return rows;
  }
}
/** Page plus ancienne collée en tête du fil (offset = lignes déjà connues). Renvoie true si du passé est arrivé. */
export async function loadOlder(c: BotConv) {
  if (c.olderBusy || !c.moreOlder || !c.rows?.length) return false;
  c.olderBusy = true;
  try {
    const first = c.rows[0].id;
    const page = await fetchPage(c, { limit: String(OLDER_PAGE), offset: String(c.rows.length) });
    if (!live(c)) return false;
    const older = page.filter((m: any) => m.id < first).map(slimRow);
    c.moreOlder = page.length >= OLDER_PAGE && older.length > 0;
    if (!older.length) return false;
    c.rows = older.concat(c.rows);
    idb.put(rowKey(c.bot.name), { sid: c.durable || c.sid, rows: c.rows.slice(-IDB_KEEP), more: !!c.moreOlder });
    const items = rowsToItems(new Thread(), older);
    c.thread.set("items", (a) => [...items, ...a]);
    c.thread.setWin(c.thread.win() + items.length);
    return true;
  } catch (e) {
    if (e instanceof AuthError) location.href = LOGIN_URL;
    return false;
  } finally {
    c.olderBusy = false;
  }
}

// ---------- file d'envoi hors ligne (même submission_id au renvoi : jamais de doublon côté gateway) ----------
const outboxKey = (n: string) => "outbox:" + n;
const outboxGet = (n: string): any[] => store.get(outboxKey(n), []);
function outboxSet(n: string, list: any[]) {
  if (list.length) store.set(outboxKey(n), list);
  else store.del(outboxKey(n));
}
function outboxAdd(c: BotConv, item: any, key?: number) {
  outboxSet(c.bot.name, [...outboxGet(c.bot.name).filter((x) => x.id !== item.id), item]);
  if (key) c.thread.patch(key, { st: "outbox", sub: item.id });
}
const outboxDrop = (c: BotConv, id: string) =>
  outboxSet(
    c.bot.name,
    outboxGet(c.bot.name).filter((x) => x.id !== id)
  );
function renderOutbox(c: BotConv, msgs: any[] | null) {
  for (const it of outboxGet(c.bot.name)) {
    // déjà dans l'historique reçu (accusé perdu, mais admis) : rien à renvoyer
    if (msgs && msgs.some((m) => m.role === "user" && asText(m.text ?? m.content) === it.text && toMs(m.timestamp) >= it.ts - 5000)) {
      outboxDrop(c, it.id);
      cachePush(c.bot.name, "user", it.display ?? it.text);
      continue;
    }
    if (!c.thread.findMsg((m) => m.sub === it.id)) c.thread.addMsg("user", it.display ?? it.text, { ts: it.ts / 1000, st: "outbox", sub: it.id });
  }
}
// Échec franc (pas une coupure) : la bulle passe en échec avec Réessayer ; le renvoi garde le même submission_id.
function failed(c: BotConv, key: number, item: any, why: string) {
  c.thread.patch(key, { st: "err", sub: undefined, retry: () => retrySend(c, key, item) });
  note(c, "Envoi échoué : " + why);
}
export function retrySend(c: BotConv, key: number, item: any) {
  c.thread.patch(key, { retry: undefined });
  outboxAdd(c, item, key);
  if (chatUp(c)) flushOutbox(c);
}
async function flushOutbox(c: BotConv) {
  if (c.flushing) return;
  c.flushing = true;
  try {
    for (const it of outboxGet(c.bot.name)) {
      if (!live(c) || !chatUp(c)) break;
      const b = c.thread.findMsg((m) => m.sub === it.id);
      const call = (queued: boolean) =>
        c.gw!.call(
          "prompt.submit",
          {
            session_id: c.sid,
            text: it.text,
            submission_id: it.id,
            ...(queued ? { queued: true } : {}),
            ...(it.attachments?.length ? { attachments: it.attachments } : {}),
          },
          30000
        );
      try {
        let r: any;
        try {
          r = await call(c.ui.busy);
        } catch (e: any) {
          if (/session_busy/.test(e.message)) r = await call(true);
          else throw e;
        }
        if (Number.isInteger(r?.execution_generation)) c.gen = r.execution_generation;
        outboxDrop(c, it.id);
        cachePush(c.bot.name, "user", it.display ?? it.text);
        if (b) {
          c.thread.patch(b.key, { st: r?.status === "queued" ? "queued" : "", sub: undefined });
          if (r?.status === "queued") c.queued.push(b.key);
        }
      } catch (e: any) {
        if (isLinkErr(e)) break; // reste en file, repart au prochain attach avec le même id
        outboxDrop(c, it.id);
        if (b) failed(c, b.key, it, e.message);
        else note(c, "Envoi échoué : " + e.message);
      }
    }
  } finally {
    c.flushing = false;
  }
}

// ---------- événements du gateway ----------
/** Tour en direct du bot (module partagé avec les groupes) ; un événement arrivé sans début de tour en ouvre un. */
const turnOf = (c: BotConv) => (c.turn ||= new LiveTurn(c.thread, { adopt: true, onStatus: (st) => c.setUi(st) }));
function onEvent(c: BotConv, ev: any) {
  if (ev.session_id && c.sid && ev.session_id !== c.sid) return;
  const p = ev.payload || {},
    t = c.thread;
  c.lastEvent = Date.now();
  switch (ev.type) {
    case "message.start": {
      if (Number.isInteger(p.execution_generation)) c.gen = p.execution_generation;
      const next = c.queued.shift();
      if (next) t.patch(next, { st: "" }); // une demande en file démarre
      const last = t.last();
      c.unsolicited = !next && !(last?.k === "msg" && last.role === "user");
      setBusy(c, true);
      c.turn = null;
      turnOf(c);
      break;
    }
    case "message.delta": {
      if (typeof p.text !== "string" || !p.text) {
        if (p.text === null) turnOf(c).seal(true);
        break;
      }
      turnOf(c).append(p.text);
      break;
    }
    case "message.interim":
      turnOf(c).seal(true);
      break;
    case "tool.start":
      turnOf(c).tool({ id: p.tool_id || "", name: p.name || "outil", detail: p.preview || p.context || "", st: "run" });
      t.scrollDown();
      break;
    case "tool.complete": {
      const st = p.result && typeof p.result === "object" && p.result.error ? "fail" : "done";
      const out = String(p.summary || p.result_text || "").slice(0, 4000) || undefined;
      turnOf(c).tool({ id: p.tool_id || "", name: p.name || "", detail: "", st, ...(out ? { out } : {}) });
      break;
    }
    case "message.complete": {
      const text = asText(p.text);
      const turn = turnOf(c),
        lastSeg = turn.lastSeg;
      let last: Msg | null = turn.end() || null;
      const same = (a: string, b: string) => String(a || "").trim() === String(b || "").trim();
      if (!last && lastSeg && text) {
        const seg = t.get(lastSeg) as Msg;
        if (seg && same(seg.text, text)) last = seg;
      } // réponse déjà scellée en interim
      if (last && isSilent(text || last.text)) {
        t.remove(last.key);
        last = null;
      } else if (last) t.patch(last.key, { text: text && !p.response_reused ? text : last.text, stream: false });
      else if (text && !p.response_reused && !isSilent(text)) last = t.addMsg("assistant", text);
      if (p.status === "error") {
        const lm = last || t.findMsg(() => true);
        if (lm) t.patch(lm.key, { err: true });
      }
      if (p.warning) note(c, p.warning);
      c.turn = null;
      setBusy(c, false);
      t.scrollDown();
      if (!p.response_reused) cachePush(c.bot.name, "assistant", text || last?.text);
      setSeen(c.bot.name, Date.now() / 1000);
      if (document.hidden && !isSilent(text)) notify(botName(c.bot), text.slice(0, 140) || "Réponse terminée", c.bot.name);
      if (c.unsolicited) {
        c.unsolicited = false;
        loadHistory(c)
          .then((m) => {
            if (live(c)) {
              renderHistory(c, m);
              t.scrollDown();
            }
          })
          .catch(() => {});
      }
      break;
    }
    case "error":
      note(c, "Erreur : " + (p.message || p.text || JSON.stringify(p).slice(0, 200)));
      setBusy(c, false);
      break;
    case "approval.request":
      if (p.kind === "clarify") {
        showClarify(c, p);
        break;
      }
      if (Number.isInteger(p.execution_generation)) c.gen = p.execution_generation;
      if (!c.prompts.has(p.prompt_id)) showApproval(c, p);
      break;
    case "clarify.request":
      if (Number.isInteger(p.execution_generation)) c.gen = p.execution_generation;
      showClarify(c, p);
      break;
    case "clarify.settled":
      settle(c, p.prompt_id, "Question réglée");
      break;
    case "approval.settled":
    case "approval.cancelled":
      settle(c, p.prompt_id, "Accord réglé");
      break;
    case "request.cancel":
      note(c, "Demande annulée" + (p.reason ? " (" + p.reason + ")" : ""));
      break;
  }
}
function settle(c: BotConv, promptId: string, text: string) {
  const k = c.prompts.get(promptId);
  const card = k ? (c.thread.get(k) as Card) : null;
  if (card && !card.done) c.thread.patch(k!, { done: text });
}
function onRequest(c: BotConv, frame: any) {
  const prm = frame.params || {};
  if (frame.method === "approval" || frame.method === "approval.request") return showApproval(c, { ...prm, _rpcId: frame.id });
  note(c, `Le bot attend une réponse « ${frame.method} » : réponds-y depuis le desktop.`);
}

// ---------- accords (« Besoin de ton OK ») et questions ----------
const CHOICE_LABEL: Record<string, string> = { once: "Autoriser", session: "Pour la session", always: "Toujours", deny: "Refuser" };
function showApproval(c: BotConv, p: any) {
  const choices: string[] = (p.choices && p.choices.length ? p.choices : ["once", "session", "deny"]).map((x: any) =>
    typeof x === "string" ? x : x.value || x.id || x
  );
  const main = ["once", "deny"].filter((x) => choices.includes(x)),
    other = choices.filter((x) => !main.includes(x));
  const btn = (ch: string) => ({ c: ch, label: CHOICE_LABEL[ch] || ch, cls: ch === "deny" ? "no" : ch === "once" ? "yes" : "" });
  const card = c.thread.addCard(
    {
      kind: "approval",
      id: p.prompt_id,
      title: "Besoin de ton OK",
      sub: p.tool_name ? actionVerb(p.tool_name) : "",
      body: p.description || "",
      cmd: p.command || "",
      buttons: (main.length ? main : choices.slice(0, 2)).map(btn),
      more: (main.length ? other : choices.slice(2)).map(btn),
    },
    async (ch) => {
      if (p._rpcId !== undefined) c.gw!.reply(p._rpcId, { choice: ch });
      else
        await c.gw!.call("approval.respond", {
          session_id: c.sid,
          execution_generation: Number.isInteger(p.execution_generation) ? p.execution_generation : c.gen,
          prompt_id: p.prompt_id || p.request_id,
          choice: ch,
        });
      return ch === "deny" ? "Refusé" : "Autorisé" + (ch === "once" ? "" : " · " + (CHOICE_LABEL[ch] || ch).toLowerCase());
    }
  );
  if (p.prompt_id) c.prompts.set(p.prompt_id, card.key);
  if (document.hidden)
    notify(botName(c.bot), "Besoin de ton OK" + (p.command ? " : " + p.command.slice(0, 80) : ""), c.bot.name, (ch) =>
      answerCard(c.thread, card.key, ch, CHOICE_LABEL[ch])
    );
}
function showClarify(c: BotConv, p: any) {
  if (!p?.prompt_id || c.prompts.has(p.prompt_id)) return;
  const choices = (p.choices || []).map(String);
  const card = c.thread.addCard(
    { kind: "clarify", id: p.prompt_id, title: "Question", question: p.question || "", choices, multi: !!p.multi_select && choices.length > 0, buttons: [] },
    async (answer, label) => {
      await c.gw!.call("clarify.respond", {
        session_id: c.sid,
        execution_generation: Number.isInteger(p.execution_generation) ? p.execution_generation : c.gen,
        prompt_id: p.prompt_id,
        answer,
      });
      return "Réponse envoyée : " + label;
    }
  );
  c.prompts.set(p.prompt_id, card.key);
  if (document.hidden) notify(botName(c.bot), "Question : " + String(p.question || "").slice(0, 120), c.bot.name);
}

// ---------- ouverture et attache ----------
export async function openBot(name: string, closeOthers: () => void) {
  const bot = findBot(name);
  if (!bot) return;
  closeOthers();
  const c = makeConv(bot);
  batch(() => {
    setConv(c);
    setApp("open", { kind: "bot", name });
    setApp("live", { key: name, busy: false });
    show("chat");
  });
  const cached = store.get<any[]>(cacheKey(name), []);
  if (cached.length) renderHistory(c, cached, { cached: true });
  // le cache IndexedDB est plus long : il remplace le petit cache s'il en sait plus
  idb.get(rowKey(name)).then((saved) => {
    if (live(c) && !c.sid && saved?.rows?.length > cached.length) renderHistory(c, saved.rows, { cached: true });
  });
  c.setUi({ sub: cached.length ? "mise à jour…" : "connexion…" });
  history.pushState({ bot: name }, "", "#" + encodeURIComponent(name));
  rememberChat("bot", name);
  await attach(c);
}

export async function attach(c: BotConv) {
  if (c.attaching) return; // réveil + fermeture du socket : un seul socket, sinon chaque morceau arrive deux fois
  c.attaching = true;
  c.syncing = true;
  const bot = c.bot;
  try {
    const gw = await new Gateway(bot.is_default ? null : bot.name).connect();
    if (!live(c)) return gw.close();
    const old = c.gw;
    c.gw = gw;
    if (old && old !== gw) {
      old.onEvent = old.onRequest = old.onClose = () => {};
      try {
        old.close();
      } catch {}
    }
    gw.onEvent = (ev) => c.gw === gw && onEvent(c, ev);
    gw.onRequest = (r) => c.gw === gw && onRequest(c, r);
    gw.onClose = () => {
      if (live(c) && c.gw === gw) {
        c.setUi({ online: false });
        scheduleReattach(c);
      }
    };
    let stored = bot.canonical_session?.resolved_id || bot.canonical_session?.id || null;
    if (!stored) {
      const found = await gw.call("session.list", { title: CANONICAL_TITLE, include_hidden: true, limit: 5 });
      const row = (found.sessions || []).find((s: any) => (s.root_title || s.title) === CANONICAL_TITLE) || null;
      stored = row?.resolved_id || row?.id || null;
    }
    let snap: any;
    if (stored) snap = await gw.call("session.resume", { session_id: stored, omit_messages: true }, 120000);
    else {
      // request_id rend la création idempotente côté gateway (même id -> même session)
      const ids = store.get<Record<string, string>>("create-ids", {});
      ids[bot.name] = ids[bot.name] || newSubId().replace(/-/g, "");
      store.set("create-ids", ids);
      snap = await gw.call("session.create", { title: CANONICAL_TITLE, hidden: true, source: "gui", request_id: ids[bot.name] });
    }
    c.sid = snap.session_id;
    c.durable = stored || snap.session_key || null;
    let msgs = snap.messages;
    if ((!msgs || !msgs.length || snap.messages_omitted) && c.sid) {
      try {
        msgs = await loadHistory(c);
      } catch (e) {
        if (e instanceof AuthError) throw e;
      }
    }
    if (!live(c)) return;
    // sans historique lisible, on garde le fil déjà affiché (cache) au lieu de l'effacer
    if (Array.isArray(msgs)) renderHistory(c, msgs);
    else note(c, "Historique indisponible pour l’instant : affichage depuis le téléphone.");
    setBusy(c, !!snap.running);
    c.setUi({ online: true, sub: "" });
    if (Number.isInteger(snap.execution_generation)) c.gen = snap.execution_generation;
    if (snap.pending_approval) showApproval(c, snap.pending_approval);
    for (const pr of snap.prompts || []) {
      if (pr.kind === "clarify") showClarify(c, pr);
      else if (!c.prompts.has(pr.prompt_id)) showApproval(c, pr);
    }
    setSeen(bot.name, Date.now() / 1000);
    markMentionsSeen(bot.name);
    c.failNoted = false;
    clearTimeout(c.retryTimer);
    c.retryTimer = null;
    if (c.retries) flash(c, "à jour");
    c.retries = 0;
    c.syncing = false;
    flushOutbox(c);
  } catch (e: any) {
    if (e instanceof AuthError) {
      location.href = LOGIN_URL;
      return;
    }
    if (!c.failNoted) {
      c.failNoted = true;
      note(c, "Connexion impossible : " + e.message + " (nouvel essai avec recul progressif)");
    }
    scheduleReattach(c);
  } finally {
    c.attaching = false;
    c.syncing = false;
  }
}
// Reconnexion avec recul progressif (1, 2, 5, 10, 30 s) et un état lisible dans l'en-tête.
const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
function scheduleReattach(c: BotConv) {
  if (c.retryTimer) return;
  const n = (c.retries = (c.retries || 0) + 1),
    d = BACKOFF_MS[Math.min(n - 1, BACKOFF_MS.length - 1)];
  c.setUi({ sub: navigator.onLine === false ? "hors ligne" : `reconnexion dans ${d / 1000} s (essai ${n})` });
  c.retryTimer = setTimeout(() => {
    c.retryTimer = null;
    if (live(c) && !c.gw?.up) attach(c);
  }, d);
}
export function reconnectNow(c: BotConv) {
  clearTimeout(c.retryTimer);
  c.retryTimer = null;
  c.retries = 0;
  attach(c);
}

// Arrêt du tour : le gateway n'interrompt que la génération courante ; une génération périmée est relue une fois.
export async function stopTurn(c: BotConv) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await c.gw!.call("session.interrupt", { session_id: c.sid, execution_generation: c.gen }, 30000);
      return;
    } catch (err: any) {
      if (!/stale_generation/.test(err.message) || attempt) {
        note(c, "Arrêt échoué : " + err.message);
        return;
      }
      let snap: any;
      try {
        snap = await c.gw!.call("session.resume", { session_id: c.sid, omit_messages: true }, 30000);
      } catch (e: any) {
        note(c, "Arrêt échoué : " + e.message);
        return;
      }
      if (!live(c)) return;
      if (Number.isInteger(snap.execution_generation)) c.gen = snap.execution_generation;
      if (!snap.running) {
        c.turn?.end();
        c.turn = null;
        setBusy(c, false);
        try {
          renderHistory(c, await loadHistory(c));
        } catch {}
        return;
      }
    }
  }
}
// Un tour peut finir pendant que le téléphone dort (socket gardé, événements perdus) : on demande au gateway.
export async function resyncBusy(c: BotConv) {
  if (!c?.gw || !c.sid) return;
  try {
    const snap = await c.gw.call("session.resume", { session_id: c.sid, omit_messages: true }, 30000);
    if (!live(c)) return;
    if (Number.isInteger(snap.execution_generation)) c.gen = snap.execution_generation;
    if (!snap.running && c.ui.busy) {
      c.turn?.end();
      c.turn = null;
      setBusy(c, false);
      try {
        renderHistory(c, await loadHistory(c));
      } catch {}
    } else if (snap.running && !c.ui.busy) setBusy(c, true); // tour lancé ailleurs (autre appareil, cron) pendant qu'on dormait
  } catch {}
}
// Garde-fou : occupé sans événement depuis 45 s, on vérifie.
setInterval(() => {
  const c = current();
  if (c?.ui.busy && !document.hidden && Date.now() - (c.lastEvent || 0) > 45000) {
    c.lastEvent = Date.now();
    resyncBusy(c);
  }
}, 15000);

export function closeBot(c: BotConv) {
  markMentionsSeen(c.bot.name);
  clearTimeout(c.retryTimer);
  c.gw?.close();
  c.gw = null;
}

// ---------- envoi ----------
type SendOpts = { display?: string; attachments?: any[]; files?: Staged[] };
const filesOf = (o: SendOpts) => o.files?.map((s) => ({ url: s.url, name: s.file.name }));
export async function send(c: BotConv, text: string, opts: SendOpts = {}) {
  if (!opts.attachments && /^\/(new|reset)\b/i.test(text)) {
    note(c, "Un Bot Chat est permanent : utilise /compact pour repartir d’un contexte frais.");
    return;
  }
  const submission_id = newSubId();
  const b = c.thread.addMsg("user", opts.display ?? text, { files: filesOf(opts) });
  c.thread.scrollDown();
  const item = { id: submission_id, text, display: opts.display, ts: Date.now(), ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) };
  if (!chatUp(c)) {
    outboxAdd(c, item, b.key);
    return;
  }
  cachePush(c.bot.name, "user", opts.display ?? text);
  setBusy(c, true);
  try {
    const r = await c.gw!.call(
      "prompt.submit",
      { session_id: c.sid, text, submission_id, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) },
      30000
    );
    if (Number.isInteger(r?.execution_generation)) c.gen = r.execution_generation;
  } catch (e: any) {
    if (isLinkErr(e) && live(c)) {
      outboxAdd(c, item, b.key);
      setBusy(c, false);
      return;
    }
    failed(c, b.key, item, e.message);
    setBusy(c, false);
  }
}
export async function queueSend(c: BotConv, text: string, opts: SendOpts = {}) {
  const b = c.thread.addMsg("user", opts.display ?? text, { files: filesOf(opts) });
  c.thread.scrollDown();
  const submission_id = newSubId();
  const item = { id: submission_id, text, display: opts.display, ts: Date.now(), ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) };
  if (!chatUp(c)) {
    outboxAdd(c, item, b.key);
    return;
  }
  c.thread.patch(b.key, { st: "queued" });
  c.queued.push(b.key);
  try {
    const r = await c.gw!.call(
      "prompt.submit",
      { session_id: c.sid, text, submission_id, queued: true, ...(opts.attachments?.length ? { attachments: opts.attachments } : {}) },
      30000
    );
    if (r?.status === "started") {
      c.thread.patch(b.key, { st: "" });
      c.queued = c.queued.filter((x) => x !== b.key);
    }
  } catch (e: any) {
    c.queued = c.queued.filter((x) => x !== b.key);
    if (isLinkErr(e) && live(c)) {
      outboxAdd(c, item, b.key);
      return;
    }
    failed(c, b.key, { ...item, queued: true }, e.message);
  }
}
// Recadrage : le message s'ajoute au tour en cours (session.redirect) ; tour fini entre-temps : envoi ou file.
export async function steerSend(c: BotConv, text: string) {
  if (!c.sid || !text) return;
  if (!c.ui.busy || !Number.isInteger(c.gen)) return c.ui.busy ? queueSend(c, text) : send(c, text);
  const b = c.thread.addMsg("user", text, { st: "steering" });
  c.thread.scrollDown();
  const again = () => {
    c.thread.remove(b.key);
    return c.ui.busy ? queueSend(c, text) : send(c, text);
  };
  try {
    const r = await c.gw!.call("session.redirect", { session_id: c.sid, execution_generation: c.gen, text }, 30000);
    if (r?.status === "rejected") return again();
    c.thread.patch(b.key, { st: "steered" });
    cachePush(c.bot.name, "user", text);
  } catch (e: any) {
    if (/stale_generation|unknown_execution/.test(String(e?.message))) return again();
    // la bulle garde Réessayer (avant la v99, l'échec n'offrait rien : le texte était perdu)
    c.thread.patch(b.key, { st: "err", retry: () => again() });
    note(c, "Recadrage échoué : " + e.message);
  }
}
/** « /q texte » ou « /queue texte » : demande suivante. Renvoie le texte sans la commande, ou null. */
export function nextRequest(text: string) {
  const m = /^\/(?:q|queue)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? (m[1] || "").trim() : null;
}
/** Soumission du composeur dans une conversation de bot. */
export async function submitBot(c: BotConv, raw: string) {
  const pre = raw ? replyPrefix() : "",
    text = pre + raw;
  if (raw) clearReply();
  const files = takeStaged();
  if (files.length) return sendWithFiles(c, text, files);
  if (!text && c.ui.busy) return stopTurn(c);
  if (!text) return;
  if (slashConfirm(c, text)) return;
  const later = nextRequest(raw);
  if (later !== null) {
    if (later) (c.ui.busy ? queueSend : send)(c, pre + later);
  } else if (c.ui.busy) steerSend(c, text);
  else send(c, text);
}

// ---------- pièces jointes : image -> /api/chat/image-upload puis attachments ; autre fichier -> chemin dans le texte ----------
const SENDABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const readDataUrl = (blob: Blob) =>
  new Promise<string>((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(r.result as string);
    r.onerror = () => ko(r.error);
    r.readAsDataURL(blob);
  });
async function imageDataUrl(file: File) {
  if (SENDABLE.has(file.type) && file.size <= 6 * 1024 * 1024) return readDataUrl(file);
  const bmp = await createImageBitmap(file); // HEIC, BMP, très grandes photos : JPEG 2560 px
  const k = Math.min(1, 2560 / Math.max(bmp.width, bmp.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(bmp.width * k);
  cv.height = Math.round(bmp.height * k);
  cv.getContext("2d")!.drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  return cv.toDataURL("image/jpeg", 0.85);
}
async function uploadOne(profile: string | null, s: Staged) {
  const q = profile ? "?profile=" + encodeURIComponent(profile) : "";
  if (s.img) {
    const r = await fetch("/api/chat/image-upload" + q, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data_url: await imageDataUrl(s.file), filename: s.file.name }),
    });
    if (!r.ok) throw await apiErr(r);
    const j = await r.json();
    if (!SENDABLE.has(j.mime_type)) throw new Error("format refusé : " + j.mime_type);
    return { attachment: { path: j.path, mime: j.mime_type } };
  }
  const fd = new FormData();
  fd.append("file", s.file, s.file.name);
  const r = await fetch("/api/chat/file-upload" + q, { method: "POST", credentials: "same-origin", body: fd });
  if (!r.ok) throw await apiErr(r);
  return { line: `[Fichier joint : ${s.file.name}, déposé ici : ${(await r.json()).path}]` };
}
export async function sendWithFiles(c: BotConv, text: string, files: Staged[]) {
  const out: any[] = [];
  for (const s of files) {
    try {
      out.push(await uploadOne(c.gw?.profile ?? null, s));
    } catch (e: any) {
      note(c, `Pièce jointe ${s.file.name} non envoyée : ${e.message}`);
    }
  }
  const attachments = out.map((o) => o.attachment).filter(Boolean),
    lines = out.map((o) => o.line).filter(Boolean);
  // rien n'est parti : le texte revient dans la zone de saisie (avant la v99 il était perdu)
  if (!attachments.length && !lines.length) {
    if (text) insertText(text);
    return;
  }
  const full = [text, ...lines].filter(Boolean).join("\n\n") || "Voici une image.";
  const opts = { attachments, files, display: text };
  if (c.ui.busy) queueSend(c, full, opts);
  else send(c, full, opts);
}

// ---------- commandes à confirmation (/reload-mcp, /undo, /model) : carte à boutons, puis le RPC direct ----------
function confirmCard(c: BotConv, title: string, q: string, buttons: { c: string; label: string; cls?: string }[], run: (ch: string) => Promise<string>) {
  c.thread.addCard({ kind: "confirm", title, body: q, buttons }, run);
}
async function mutate(c: BotConv, operation: string, payload: any) {
  const snap = await c.gw!.call("session.resume", { session_id: c.sid, omit_messages: true }, 30000);
  if (Number.isInteger(snap?.execution_generation)) c.gen = snap.execution_generation;
  return c.gw!.call(
    "session.mutate",
    { session_id: c.sid, request_id: newSubId(), expected_revision: snap?.revision, expected_generation: snap?.execution_generation, operation, payload },
    120000
  );
}
const mutateErr = (e: any) => {
  const k = String(e?.message || "")
    .split(" : ")
    .pop()!
    .trim();
  return (
    (
      {
        model_resolution_failed: "modèle inconnu",
        session_busy: "le bot travaille encore",
        stale_revision: "la conversation a changé entre-temps, réessaie",
      } as Record<string, string>
    )[k] ||
    k ||
    "erreur"
  );
};
export function slashConfirm(c: BotConv, text: string) {
  if (/^\/reload-mcp\b/i.test(text)) {
    c.thread.addMsg("user", text);
    c.thread.scrollDown();
    confirmCard(
      c,
      "Recharger les serveurs MCP ?",
      "Les outils du bot sont reconstruits. Le prochain message renvoie tout le contexte au modèle, ce qui coûte plus cher sur les longues conversations.",
      [
        { c: "once", label: "Recharger", cls: "yes" },
        { c: "always", label: "Toujours, sans demander" },
        { c: "cancel", label: "Annuler", cls: "no" },
      ],
      async (choice) => {
        if (choice === "cancel") return "Annulé : outils inchangés.";
        const r = await c.gw!.call("reload.mcp", { session_id: c.sid, confirm: true, always: choice === "always" }, 120000);
        const st = r?.status || "fait";
        return st === "reloaded" ? "Serveurs MCP rechargés." + (choice === "always" ? " Plus de confirmation à l’avenir." : "") : "Résultat : " + st;
      }
    );
    return true;
  }
  if (/^\/undo\s*$/i.test(text)) {
    if (c.ui.busy) {
      note(c, "Le bot répond encore : arrête-le avant /undo.");
      return true;
    }
    c.thread.addMsg("user", text);
    c.thread.scrollDown();
    confirmCard(
      c,
      "Annuler le dernier échange ?",
      "Ton dernier message et la réponse du bot sont retirés de la conversation. Impossible à rattraper.",
      [
        { c: "once", label: "Retirer l’échange", cls: "yes" },
        { c: "cancel", label: "Garder", cls: "no" },
      ],
      async (choice) => {
        if (choice === "cancel") return "Annulé : conversation inchangée.";
        const before = await fetchPage(c, { limit: String(SYNC_PAGE) });
        const target = [...before].reverse().find((m: any) => m.role === "user" && Number.isInteger(m.row_id));
        if (!target) return "Rien à retirer.";
        try {
          await mutate(c, "rewind", { target_message_id: target.row_id });
        } catch (e) {
          throw new Error(mutateErr(e));
        }
        const removed = before.filter((m: any) => Number.isInteger(m.row_id) && m.row_id >= target.row_id).length;
        const msg = `Dernier échange retiré (${Math.max(removed, 1)} messages).`;
        renderHistory(c, await loadHistory(c));
        note(c, msg); // l'historique rechargé remplace la carte
        return msg;
      }
    );
    return true;
  }
  const m = text.match(/^\/model\s+(\S[\s\S]*)$/i);
  if (m) {
    const arg = m[1].trim();
    c.thread.addMsg("user", text);
    c.thread.scrollDown();
    const done = (r: any) => "Modèle de ce chat : " + (r?.model || r?.target_model || arg) + ".";
    (async () => {
      let r: any;
      try {
        r = await mutate(c, "model", { model: arg });
      } catch (e) {
        note(c, "Changement de modèle échoué : " + mutateErr(e));
        return;
      }
      if (r?.status !== "confirmation_required") {
        note(c, done(r));
        return;
      }
      confirmCard(
        c,
        "Passer sur " + (r.target_model || arg) + " ?",
        r.confirm_message || "Ce modèle coûte plus cher.",
        [
          { c: "once", label: "Confirmer", cls: "yes" },
          { c: "cancel", label: "Annuler", cls: "no" },
        ],
        async (choice) => {
          if (choice === "cancel") return "Annulé : modèle inchangé.";
          try {
            return done(await mutate(c, "model", { model: arg, confirm: r.confirm }));
          } catch (e) {
            throw new Error(mutateErr(e));
          }
        }
      );
    })();
    return true;
  }
  return false;
}

// ---------- complétions @ et / (gateway) ----------
// Commandes réservées au terminal (cli_only de hermes_cli/commands.py, relevé le 2026-11-13), et /new, /reset.
const SLASH_HIDDEN = new Set(
  "battery browser clear compose config copy cron exit export focus gateway generate-pet handoff hatch history image import indicator journey learning memory-graph palette paste pet platforms plugins prompt quit redraw reload rewind sb skin snap snapshot statusbar subscription timestamps tools toolsets ts upgrade wake worktree new reset".split(
    " "
  )
);
export async function completeSlash(c: BotConv, text: string) {
  const r = await c.gw!.call("complete.slash", { text, ...(c.sid ? { session_id: c.sid } : {}) }, 10000);
  const start = Number.isInteger(r?.replace_from) ? r.replace_from : 1,
    naming = !/\s/.test(text);
  const items = (r?.items || [])
    .filter((it: any) => !(naming && SLASH_HIDDEN.has(it.text)))
    .map((it: any) => ({ text: it.text, display: it.display || it.text, meta: it.meta ? it.meta.replace(/\s*\(usage:[^)]*\)\s*$/, "") : "" }));
  return { start, items };
}
export async function completePath(c: BotConv, word: string) {
  const r = await c.gw!.call("complete.path", { word, ...(c.sid ? { session_id: c.sid } : {}) }, 10000);
  return (r?.items || []) as { text: string; display?: string; meta?: string }[];
}
export { app };
