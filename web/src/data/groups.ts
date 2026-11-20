// Groupes tenus par le gateway (contrat : hermes-agent apps/desktop/docs/canonical-groups.md). Le gateway tient le
// journal et joue les tours ; ici on relève groups.state + groups.log (depuis le dernier seq, avec un cache IndexedDB)
// toutes les 2 s quand un groupe est ouvert, un contrôle n'apparaît que si groups.capabilities liste sa méthode.
// Plugin bot-groups : table ronde (dispatch), voie rapide, recadrage, demandes suivantes, tableau des tâches, fils.
import { batch } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { AuthError, LOGIN_URL } from "../lib/gateway";
import { idb, store } from "../lib/store";
import { asText, isSilent, newSubId, report, toMs } from "../lib/util";
import { avatarOf } from "../lib/avatars";
import {
  app,
  botLabel,
  botName,
  findRoom,
  isHidden,
  loadRoster,
  markMentionsSeen,
  memberName,
  roster,
  setApp,
  setGroupsHook,
  setRoomPreview,
  setSeen,
} from "./app";
import { clearReply, replyPrefix, typed } from "./composer";
import { type ConvBase, type ConvUi, conv, notify, rememberChat, setConv, show } from "./conv";
import { type Card, type Msg, type ToolRun, Thread, answerCard } from "./thread";
import { LiveTurn } from "./turn";

const GROUP_POLL_MS = 2000,
  GROUP_KEEP = 400;
const groupKey = (id: string) => "room:" + id;
const uuid = newSubId;
export const can = (m: string) => !!app.caps?.methods?.includes(m);
const homeProfile = () => app.bots.find((b) => b.is_default)?.name || "default";
export const gparams = (o: Record<string, any>) => ({ profile: homeProfile(), ...o });
const rpcMissing = (e: any) => /method|not found|unknown|introuvable/i.test(e?.message || "");
const call = (method: string, params: any, ms = 20000) => roster.gw!.call(method, params, ms);

export type GroupState = { room: any; context: any; driver: any; dispatch: any[]; tasks: any[]; traces: any[]; busy: boolean };
export type GroupConv = ConvBase & {
  kind: "room";
  id: string;
  gs: GroupState;
  setGs: (...a: any[]) => void;
  cursor: number;
  shown: number;
  epoch: any;
  events: any[];
  timer: any;
  restored: boolean;
  stopping: string | null;
  actions: Map<string, number>;
  traceByEvent: Map<string, any>;
  liveTr?: Map<string, LiveTr>;
  turns?: Map<string, LiveTurn>;
  draftOf?: Map<string, number>;
  drafts?: Map<number, string>;
  liveLoop?: boolean;
  heldLoaded: boolean;
  settingsIds?: { rename: string; context: string };
  disbandId?: string;
};
export const currentGroup = (): GroupConv | null => {
  const c = conv();
  return c?.kind === "room" ? c : null;
};
const live = (g: GroupConv) => currentGroup() === g;
const note = (g: GroupConv, t: string, o: any = {}) => g.thread.addNote(t, o);

// ---------- capacités + liste ----------
const caps = { socket: null as any, done: false };
async function groupCapabilities() {
  const gw = roster.gw;
  if (caps.socket === gw && caps.done) return app.caps;
  caps.socket = gw;
  caps.done = false;
  try {
    const v = await gw!.call("groups.capabilities", gparams({}), 15000);
    caps.done = true;
    if (v && v.driver === true)
      batch(() => {
        setApp("caps", v);
        setApp("capsError", "");
      });
    else
      batch(() => {
        setApp("caps", null);
        setApp("capsError", "Le moteur de groupes de Hermes ne tourne pas : redémarre ou mets à jour Hermes.");
      });
  } catch (e: any) {
    setApp("capsError", e.code === -32601 ? "Ce Hermes est trop ancien pour les groupes." : "Groupes injoignables : " + e.message);
    if (e.code === -32601) caps.done = true;
    else caps.socket = null; // nouvel essai au prochain relevé
  }
  return app.caps;
}
export async function loadGroups() {
  try {
    const v = await groupCapabilities();
    if (!v) return;
    if (!app.team.loaded) loadTeamCfg();
    const res = await call("groups.list", gparams({ limit: 50 }));
    const rooms = (res.rooms || []).filter((r: any) => !r.disbanded_at);
    batch(() => {
      setApp("groups", reconcile(rooms, { key: "room_id" }));
      for (const r of rooms) if (app.seen["room:" + r.room_id] === undefined) setApp("seen", "room:" + r.room_id, r.latest_seq || 0);
    });
    store.set("seen", app.seen);
    store.set("groups-cache", rooms);
  } catch {
    /* garde la dernière liste, jamais de texte de transport */
  }
}
setGroupsHook(loadGroups);
function setGroups(rooms: any[]) {
  setApp("groups", rooms);
  store.set("groups-cache", rooms);
}

// ---------- vue d'un groupe ----------
function makeGroup(room: any): GroupConv {
  const [ui, setUi] = createStore<ConvUi>({ busy: false, sub: "", streaming: false, tool: "", flash: "", online: true });
  const [gs, setGs] = createStore<GroupState>({ room, context: null, driver: undefined, dispatch: [], tasks: [], traces: [], busy: false });
  return {
    kind: "room",
    key: groupKey(room.room_id),
    id: room.room_id,
    thread: new Thread(),
    ui,
    setUi: (p) => setUi(p),
    gs,
    setGs: setGs as any,
    cursor: 0,
    shown: 0,
    epoch: null,
    events: [],
    timer: null,
    restored: false,
    stopping: null,
    actions: new Map(),
    traceByEvent: new Map(),
    heldLoaded: false,
  };
}
export async function openGroup(roomId: string, closeOthers: () => void) {
  clearReply();
  const room = findRoom(roomId);
  if (!room) return;
  closeOthers();
  const g = makeGroup(JSON.parse(JSON.stringify(room)));
  batch(() => {
    setConv(g);
    setApp("open", { kind: "room", id: roomId });
    setApp("live", { key: g.key, busy: false });
    show("chat");
  });
  history.pushState({ room: roomId }, "", "#room-" + encodeURIComponent(roomId));
  rememberChat("room", roomId);
  await showCachedGroup(g);
  for (const it of intents(roomId)) {
    if (it.failed) {
      offerRetry(g, it);
      continue;
    }
    const eid = await userEventId(it.event_id);
    if (!g.thread.findMsg((m) => m.eid === eid)) g.thread.addMsg("user", it.text, { eid, textKey: it.text, st: "outbox" });
  }
  await pollGroup(g);
}
// Cache : les derniers événements restent sur le téléphone ; le relevé ne demande que la suite (since_seq).
async function showCachedGroup(g: GroupConv) {
  const saved = await idb.get(groupKey(g.id));
  if (!live(g) || g.cursor || !saved?.events?.length) return;
  g.epoch = saved.epoch ?? null;
  g.cursor = saved.cursor || 0;
  g.events = saved.events;
  batch(() => {
    for (const ev of saved.events) {
      if (Number.isInteger(ev.seq)) g.shown = Math.max(g.shown, ev.seq);
      renderRoomEvent(g, ev);
    }
  });
  g.restored = true;
}
const saveGroup = (g: GroupConv) => idb.put(groupKey(g.id), { epoch: g.epoch, cursor: g.cursor, events: (g.events || []).slice(-GROUP_KEEP) });

export function closeGroup(g: GroupConv) {
  clearTimeout(g.timer);
  markMentionsSeen(g.key);
}

export async function pollGroup(g: GroupConv) {
  if (!live(g)) return;
  clearTimeout(g.timer);
  try {
    if (!roster.gw?.up) await loadRoster();
    const st = await call("groups.state", gparams({ room_id: g.id }));
    if (!live(g)) return;
    const room = st.room || g.gs.room;
    // Journal repris de zéro (autre époque, ou salon recréé avec un seq plus bas que notre curseur) : le cache ne vaut plus,
    // sinon les nouveaux événements resteraient sous le curseur et n'apparaîtraient jamais.
    const latest = Number.isInteger(room.latest_seq) ? room.latest_seq : null;
    if ((g.epoch !== null && room.authority_epoch !== g.epoch) || (latest !== null && latest < g.cursor)) {
      g.cursor = 0;
      g.shown = 0;
      g.events = [];
      g.thread.clear();
      g.actions.clear();
    }
    g.epoch = room.authority_epoch;
    g.setGs("room", reconcile(room));
    let added = false;
    for (let more = true; more;) {
      const page = await call("groups.log", gparams({ room_id: g.id, since_seq: g.cursor, limit: 200 }));
      if (!live(g)) return;
      // deux relevés peuvent se croiser avec le même curseur : un événement déjà affiché (seq <= shown) est ignoré
      batch(() => {
        for (const ev of page.events || []) {
          if (Number.isInteger(ev.seq)) {
            if (ev.seq <= g.shown) continue;
            g.shown = ev.seq;
          }
          g.events.push(ev);
          added = true;
          renderRoomEvent(g, ev);
        }
      });
      g.cursor = Math.max(g.cursor, page.cursor ?? 0);
      more = !!page.has_more && (page.events || []).length > 0;
    }
    if (added) saveGroup(g);
    setSeen(g.key, Math.max(app.seen[g.key] || 0, g.cursor));
    markMentionsSeen(g.key);
    g.restored = true;
    g.setGs("context", st.context || g.gs.context || null);
    leadWarn(g);
    await pollDispatch(g);
    await pollTraces(g);
    pollLiveTraces(g);
    if (!g.liveLoop && runningTraces(g).length) liveLoop(g);
    pollTasks(g);
    renderDriver(g, st.driver_status || null);
    g.setUi({ online: true });
    // un message écrit hors ligne attend : il part maintenant, avec son event_id d'origine
    flushIntents(g);
  } catch (e) {
    if (e instanceof AuthError) {
      location.href = LOGIN_URL;
      return;
    }
    g.setUi({ sub: "le gateway attend peut-être un bot… nouvel essai", online: false });
  }
  if (live(g) && !g.gs.room.disbanded_at) g.timer = setTimeout(() => !document.hidden && pollGroup(g), GROUP_POLL_MS);
}
export const groupSub = (g: GroupConv) => {
  const d = g.gs.driver;
  if (d === null) return "moteur de groupe indisponible";
  if (d?.last_error) return "erreur de préparation : " + String(d.last_error).slice(0, 80);
  return g.ui.sub || (g.gs.room.members || []).map(memberName).join(", ");
};

// Tout groupe doit avoir un meneur : sinon une note le dit, avec un bouton vers les réglages.
export const groupUi = { openSettings: () => {}, openTasks: () => {} };
function leadWarn(g: GroupConv) {
  const ctx = g.gs.context;
  if (!ctx || !can("groups.context") || g.gs.room.disbanded_at) return;
  const ok = ctx.routing === "lead" && g.gs.room.members.some((m: any) => m.member_id === ctx.lead_member_id);
  const el = g.thread.items.find((i) => i.k === "note" && i.tag === "lead-warn");
  if (ok) {
    if (el) g.thread.remove(el.key);
    return;
  }
  if (!el) note(g, "Ce groupe n’a pas de meneur.", { tag: "lead-warn", action: { label: "Choisir un meneur", run: () => groupUi.openSettings() } });
}
export function actorName(g: GroupConv, actor: any) {
  if (!actor) return "?";
  if (actor.kind === "user") return "Toi";
  const m = g.gs.room.members.find((x: any) => x.member_id === actor.id);
  return actor.display_name || (m && memberName(m)) || botLabel(actor.profile) || actor.id;
}
function memberMsg(g: GroupConv, name: string, text: string, mid: string, ts: any, eid = "") {
  const prof = g.gs.room.members.find((m: any) => m.member_id === mid)?.profile || mid;
  // la réponse arrive dans le groupe : sa bulle en direct s'efface, la réponse postée prend sa place (même texte)
  for (const [key, who] of g.drafts || [])
    if (sameMember(g, who, mid)) {
      g.thread.remove(key);
      g.drafts!.delete(key);
    }
  return g.thread.addMsg("assistant", text || "", { ts, eid, inert: true, who: { name, color: avatarOf(prof).color, mid, profile: prof } });
}

// Résultat d'une table ronde (group_dispatch) ou group_post : « [profil] texte », posté par le moteur au nom du bot.
// Yaia, l'assistante Claude de Yoan, parle dans un groupe par la RPC yaia.send du plugin : « [yaia] texte ».
// Elle n'est pas membre du groupe (aucun tour de bot) ; sa bulle porte son nom pour que Yoan voie qui a écrit.
export const YAIA = { member_id: "yaia", profile: "yaia", handle: "yaia", display_name: "Yaia" };
function botPost(g: GroupConv, text: string): { member: any; body: string } | null {
  const bp = /^\[([\w.-]+)\] ([\s\S]*)$/.exec(text);
  const member = bp && (bp[1] === "yaia" ? YAIA : g.gs.room.members.find((m: any) => [m.profile, m.member_id, m.handle].includes(bp[1])));
  return member ? { member, body: bp![2] } : null;
}

const FAIL_REASON: Record<string, string> = { member_unavailable: "bot indisponible", superseded_by_newer_user_event: "remplacé par ton message suivant" };
export function renderRoomEvent(g: GroupConv, ev: any) {
  const p = ev.payload || {},
    t = g.thread;
  switch (ev.kind) {
    case "message.user": {
      const text = asText(p.text);
      const mine = t.findMsg((m) => m.eid === ev.event_id) || t.findMsg((m) => m.st === "pending" && m.textKey === text);
      if (mine) {
        t.patch(mine.key, { st: "", eid: ev.event_id, textKey: undefined });
        break;
      }
      // résultat d'une table ronde (group_dispatch) ou group_post : « [profil] texte », posté au nom du bot
      const bp = botPost(g, text),
        bm = bp?.member;
      if (bp) {
        // la mention finale du meneur sert à le réveiller : inutile à l'affichage
        const tail = /\s*@([\w.:-]+)\s*$/.exec(bp.body),
          body = tail && g.gs.room.members.some((m: any) => m.handle === tail[1]) ? bp.body.slice(0, tail.index) : bp.body;
        memberMsg(g, memberName(bm), body.replace(/​/g, ""), bm.member_id, ev.created_at, ev.event_id);
        setRoomPreview(g.id, body, memberName(bm), toMs(ev.created_at) / 1000);
        break;
      }
      t.addMsg("user", text, { ts: ev.created_at, eid: ev.event_id });
      setRoomPreview(g.id, text, "Toi", toMs(ev.created_at) / 1000);
      break;
    }
    case "message.member": {
      const text = asText(p.text);
      if (isSilent(text)) break;
      const who = actorName(g, ev.actor);
      memberMsg(g, who, text, ev.actor?.id || "", ev.created_at, ev.event_id);
      setRoomPreview(g.id, text, who, toMs(ev.created_at) / 1000);
      if (document.hidden && ev.seq > (app.seen[g.key] || 0)) notify(g.gs.room.name, who + " : " + text.slice(0, 120), g.key);
      break;
    }
    // tours : l'auteur est le gateway, le membre concerné est dans payload.member_id
    case "turn.failed":
    case "turn.deferred":
    case "turn.cancelled":
      if (ev.actor?.kind === "gateway" && p.member_id) ev = { ...ev, actor: { kind: "member", id: p.member_id } };
  }
  switch (ev.kind) {
    case "turn.failed":
      note(g, `${actorName(g, ev.actor)} : échec${p.reason_code ? " (" + p.reason_code + ")" : ""}`);
      break;
    case "turn.deferred":
      note(g, `${actorName(g, ev.actor)} : en attente${p.reason ? " (" + (FAIL_REASON[p.reason] || p.reason) + ")" : ""}`);
      break;
    case "turn.cancelled":
      if (p.reason !== "superseded_by_newer_user_event") note(g, `${actorName(g, ev.actor)} : arrêté`);
      break;
    case "room.stop_requested":
      note(g, "Arrêt demandé");
      break;
    case "room.activity":
      if (p.status === "bounded") note(g, "Limite de discussion atteinte");
      break;
    case "room.renamed":
      if (p.name) g.setGs("room", "name", p.name);
      break;
    case "room.disbanded":
      note(g, "Groupe dissous");
      g.setGs("room", "disbanded_at", ev.created_at);
      break;
    case "member.unavailable":
      note(
        g,
        p.reason_code === "prepare_failed" || ev.actor?.kind === "gateway"
          ? "Bots non réveillés" + (p.error ? " : " + String(p.error).replace(/^Members could not be woken: /, "") : "")
          : `${actorName(g, ev.actor)} indisponible${p.error ? " : " + p.error : ""}`
      );
      break;
    case "room.created":
      note(g, "Groupe créé : " + g.gs.room.members.map(memberName).join(", "));
      break;
  }
  t.scrollDown();
}

// ---------- table ronde (plugin : dispatch.status) et moteur ----------
let dispatchRpc = true;
async function pollDispatch(g: GroupConv) {
  if (!dispatchRpc) return;
  try {
    g.setGs(
      "dispatch",
      reconcile(((await call("plugin.bot-groups.dispatch.status", { room_id: g.id }, 8000))?.jobs || []).filter((j: any) => j.status === "running"))
    );
  } catch (e) {
    if (rpcMissing(e)) dispatchRpc = false;
    g.setGs("dispatch", []);
  }
}
export type Worker = { prof: string; id: string; nm: string };
/** Qui travaille (tour du groupe + table ronde) et qui attend son tour (file du moteur). */
export function workers(g: GroupConv) {
  const d = g.gs.driver,
    members = g.gs.room.members || [];
  const liveActs = (d?.member_activity || []).filter((a: any) => ["running", "queued", "stopping"].includes(a.status));
  const par = g.gs.dispatch || [];
  const out: Worker[] = [];
  const add = (m: any, fallback?: string) => {
    const prof = m?.profile || fallback;
    if (prof && !out.some((w) => w.prof === prof)) out.push({ prof, id: m?.member_id || prof, nm: m ? memberName(m) : botLabel(prof) || prof });
  };
  for (const a of liveActs.filter((x: any) => x.status !== "queued")) add(members.find((x: any) => x.member_id === a.member_id));
  for (const j of par)
    add(
      members.find((x: any) => [x.profile, x.member_id].includes(j.bot)),
      j.bot
    );
  // en file sans personne au travail : il démarre, il n'attend personne
  if (!out.length) for (const a of liveActs) add(members.find((x: any) => x.member_id === a.member_id));
  const waiting: any[] = [];
  for (const a of liveActs) {
    if (a.status !== "queued") continue;
    const m = members.find((x: any) => x.member_id === a.member_id);
    if (m && !waiting.includes(m) && !out.some((w) => w.prof === (m.profile || m.member_id))) waiting.push(m);
  }
  const typing = liveActs
    .map((a: any) => {
      const m = members.find((x: any) => x.member_id === a.member_id),
        n = m ? memberName(m) : a.member_id;
      return a.status === "queued" ? n + " en file" : a.status === "stopping" ? n + " s’arrête" : n + " écrit" + (a.tool ? " (" + a.tool + ")" : "");
    })
    .concat(
      par.map((j: any) => {
        const m = members.find((x: any) => [x.profile, x.member_id].includes(j.bot));
        return (m ? memberName(m) : j.name) + " travaille en parallèle";
      })
    );
  return { out, waiting, typing, par };
}
export function renderDriver(g: GroupConv, d: any) {
  batch(() => {
    g.setGs("driver", d === null ? null : reconcile(d || {}));
    // `running` = moteur allumé, pas un tour en cours : seul `working` dit qu'un bot répond
    const busy = !!d?.working || !!g.stopping;
    g.setGs("busy", busy);
    g.setUi({ busy });
    if (live(g)) setApp("live", { key: g.key, busy });
    // actions en attente : seulement ce que driver_status propose
    const want = new Map<string, any>();
    for (const a of d?.pending_actions || []) want.set([a.kind, a.member_id, a.task_id, a.execution_generation, a.request_id || ""].join("|"), a);
    // Action réglée : une carte d'accord reste en une ligne (réglée ici, ou ailleurs : « Réglé »), les autres s'effacent.
    for (const [key, k] of g.actions)
      if (!want.has(key)) {
        const card = g.thread.items.find((i) => i.key === k) as Card | undefined;
        if (card?.kind === "approval") {
          if (!card.done) g.thread.patch(k, { done: "Réglé", busy: false } as any);
        } else g.thread.remove(k);
        g.actions.delete(key);
      }
    for (const [key, a] of want)
      if (!g.actions.has(key)) {
        const k = actionCard(g, a);
        if (k) g.actions.set(key, k);
      }
    markQueued(g);
  });
  sideBubbles(g);
  heldBubbles(g);
}
function approvalPreview(a: any) {
  const ap = a.approval || {},
    cmd = String(ap.command || "").trim(),
    desc = String(ap.description || "").trim();
  const labelled = /^<[^>]+> \(/.test(cmd);
  const matching = !!a.request_id && (!ap.request_id || ap.request_id === a.request_id) && (!ap.prompt_id || ap.prompt_id === a.request_id);
  return { cmd: labelled ? "" : cmd, desc, reviewable: matching && !!(labelled ? desc : cmd) };
}
function actionCard(g: GroupConv, a: any): number | null {
  const m = g.gs.room.members.find((x: any) => x.member_id === a.member_id),
    who = m ? memberName(m) : a.member_id;
  const buttons: { c: string; label: string; cls: string }[] = [];
  let notifyLater: ((k: number) => void) | null = null;
  let title = "",
    body = "",
    cmd = "";
  if (a.kind === "approval" && can("groups.approve")) {
    const pv = approvalPreview(a),
      offered = a.approval?.choices || [];
    title = "Besoin de ton OK";
    body = pv.desc;
    cmd = pv.cmd;
    if (offered.includes("once") && pv.reviewable) buttons.push({ c: "once", label: "Autoriser", cls: "yes" });
    if (offered.includes("deny")) buttons.push({ c: "deny", label: "Refuser", cls: "no" });
    if (document.hidden)
      notifyLater = (k) =>
        notify(
          g.gs.room.name,
          who + " demande ton accord" + (pv.cmd ? " : " + pv.cmd.slice(0, 80) : ""),
          g.key,
          offered.includes("once") && pv.reviewable ? (ch) => answerCard(g.thread, k, ch, ch === "deny" ? "Refuser" : "Autoriser") : undefined
        );
  } else if (a.kind === "retry" && can("groups.retry")) {
    title = "Tour bloqué";
    body = "Le tour n’a pas pu aboutir.";
    buttons.push({ c: "retry", label: "Réessayer", cls: "yes" });
  } else if (a.kind === "discard" && can("groups.discard")) {
    title = "Tour en attente";
    body = "Abandonner ce tour ? Ses effets déjà faits ne sont pas annulés.";
    buttons.push({ c: "discard", label: "Abandonner", cls: "no" });
  } else return null;
  if (!buttons.length) return null;
  const made = g.thread.addCard({ kind: a.kind === "approval" ? "approval" : "action", title, sub: "Demandé par " + who, body, cmd, buttons }, async (ch) => {
    if (ch === "discard" && !confirm("Abandonner ce tour ? Ce qui a déjà été fait n’est pas annulé.")) throw Object.assign(new Error(""), { silent: true });
    const params: any = { room_id: g.id, member_id: a.member_id, task_id: a.task_id, execution_generation: a.execution_generation };
    let method = "groups." + ch;
    if (ch === "once" || ch === "deny") {
      method = "groups.approve";
      Object.assign(params, { request_id: a.request_id, choice: ch });
    }
    try {
      await call(method, gparams(params), 30000);
    } catch (e: any) {
      throw new Error(
        /unknown_execution/.test(e.message)
          ? "Réessai refusé : le gateway a perdu ce tour en redémarrant et ne sait pas s’il tourne encore. Il faut d’abord le clore côté serveur."
          : e.message
      );
    }
    pollGroup(g);
    return ({ once: "Autorisé", deny: "Refusé", retry: "Relancé", discard: "Abandonné" } as Record<string, string>)[ch] || "Réponse envoyée";
  }).key;
  notifyLater?.(made);
  return made;
}

// ---------- envoi / arrêt ----------
export async function userEventId(clientId: string) {
  try {
    const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(clientId));
    return "user:" + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return clientId;
  }
}
// Messages pas encore confirmés par le gateway : une liste par groupe, dans l'ordre d'écriture, chacun avec son event_id
// (un renvoi garde le même : jamais de doublon). Avant la v99, un seul emplacement : un second message hors ligne
// écrasait le premier, resté en attente sans rien pour le renvoyer (piste 2, E3).
const intentsKey = (id: string) => "group-intents-" + id;
function intents(id: string): any[] {
  const old = store.get<any>("group-intent-" + id, null);
  if (old?.event_id) {
    store.del("group-intent-" + id);
    keepIntent(id, old);
  }
  return store.get<any[]>(intentsKey(id), []);
}
function keepIntent(id: string, it: any) {
  const list = store.get<any[]>(intentsKey(id), []).filter((x) => x.event_id !== it.event_id);
  store.set(intentsKey(id), [...list, it]);
}
function dropIntent(id: string, eventId: string) {
  const list = store.get<any[]>(intentsKey(id), []).filter((x) => x.event_id !== eventId);
  if (list.length) store.set(intentsKey(id), list);
  else store.del(intentsKey(id));
}
/** Au retour de la connexion : les messages restés hors ligne partent un par un, dans l'ordre ; arrêt à la première coupure. */
let flushingIntents = false;
async function flushIntents(g: GroupConv) {
  if (flushingIntents) return;
  flushingIntents = true;
  try {
    for (const it of intents(g.id)) {
      if (it.failed) continue;
      const eid = await userEventId(it.event_id),
        b = g.thread.findMsg((m) => m.eid === eid);
      if (b && b.st !== "outbox") continue;
      await groupSend(g, it.text, it, !!it.next);
      if (!roster.gw?.up || !live(g)) break;
    }
  } finally {
    flushingIntents = false;
  }
}
async function groupSend(g: GroupConv, text: string, held?: any, next = false) {
  if (!can("groups.send")) {
    note(g, "Ce gateway n’accepte pas l’envoi dans les groupes.");
    return;
  }
  const intent = { ...(held || { event_id: uuid(), text, ...(next ? { next: true } : {}) }), failed: undefined };
  keepIntent(g.id, intent);
  // le gateway range le message sous user:sha256(event_id) : la bulle porte cet id avant l'envoi (pas de doublon)
  const serverId = await userEventId(intent.event_id);
  let b = g.thread.findMsg((m) => m.eid === serverId);
  if (!b) b = g.thread.addMsg("user", intent.text, { eid: serverId, textKey: intent.text });
  g.thread.patch(b.key, { st: "pending" });
  g.thread.scrollDown();
  const key = b.key,
    working = g.gs.busy || g.gs.dispatch.length > 0;
  // hors ligne : l'intention est gardée (même event_id), la bulle attend et part seule au prochain relevé réussi
  if (!roster.gw?.up) {
    g.thread.patch(key, { st: "outbox" });
    pollGroup(g);
    return;
  }
  // « /q » : demande suivante, gardée par le plugin jusqu'à la fin de la discussion et de ses tables rondes
  if (intent.next && working) {
    // un échec du plugin laisse la demande suivante en échec avec Réessayer : avant la v99 elle partait en silence tout de suite
    let kept: boolean;
    try {
      kept = await sendNext(g, intent.event_id, intent.text);
    } catch (e: any) {
      if (!roster.gw?.up) {
        g.thread.patch(key, { st: "outbox" });
        return;
      }
      offerRetry(g, intent, e.message);
      return;
    }
    if (kept) {
      dropIntent(g.id, intent.event_id);
      g.thread.patch(key, { next: intent.event_id });
      markHeld(g, key, "next");
      markQueued(g);
      pollGroup(g);
      return;
    }
  }
  try {
    // le groupe travaille : le message recadre le bot visé (cité, sinon le meneur), ou il répond tout de suite s'il est libre
    const st = !held && !intent.next && working ? await sendSteer(g, intent.event_id, intent.text) : null;
    if (st && st.mode !== "fallback") {
      dropIntent(g.id, intent.event_id);
      g.thread.patch(key, { st: "" });
      if (st.mode === "side") g.thread.patch(key, { side: intent.event_id });
      else markHeld(g, key, st.mode === "steered" ? "steer" : "user", st.who);
      markQueued(g);
      pollGroup(g);
      return;
    }
    // groupe au repos et plusieurs bots cités : ils partent ensemble en coulisse
    const fast = !held && !working && fastLaneMembers(g, intent.text);
    if (fast && (await sendFastLane(g, intent.text, intent.event_id, fast))) {
      dropIntent(g.id, intent.event_id);
      g.thread.patch(key, { side: intent.event_id });
      pollGroup(g);
      return;
    }
    const r = await call(
      "groups.send",
      gparams({ room_id: g.id, event_id: intent.event_id, payload: { text: intent.text, thread_id: intent.event_id } }),
      45000
    );
    if (r.client_event_id && r.client_event_id !== intent.event_id) throw new Error("reçu inattendu");
    if (r.accepted === false) throw new Error("refusé par le gateway");
    dropIntent(g.id, intent.event_id);
    if (r.event?.event_id) g.thread.patch(key, { eid: r.event.event_id });
    pollGroup(g);
  } catch (e: any) {
    if (/non connecté|socket fermé|délai dépassé|Cannot read/.test(String(e?.message)) || !roster.gw?.up) {
      g.thread.patch(key, { st: "outbox" });
      return;
    }
    if (e.data?.admitted === false) {
      // preuve que rien n'est parti : le texte revient pour être corrigé
      dropIntent(g.id, intent.event_id);
      g.thread.remove(key);
      typed(intent.text);
      note(g, "Non envoyé : " + e.message);
    } else offerRetry(g, intent, e.message);
  }
}
function offerRetry(g: GroupConv, intent: any, why?: string) {
  keepIntent(g.id, { ...intent, failed: true }); // pas de renvoi automatique : Réessayer seulement
  // la bulle elle-même passe en échec avec Réessayer (même event_id : jamais de doublon)
  void userEventId(intent.event_id).then((eid) => {
    const b = g.thread.findMsg((m) => m.eid === eid);
    if (b) {
      g.thread.patch(b.key, {
        st: "err",
        retry: () => {
          g.thread.patch(b.key, { retry: undefined });
          groupSend(g, intent.text, intent);
        },
      });
      return;
    }
    const n = note(g, `Envoi non confirmé${why ? " (" + why + ")" : ""}.`, {
      action: {
        label: "Réessayer",
        run: () => {
          g.thread.remove(n.key);
          groupSend(g, intent.text, intent);
        },
      },
    });
  });
}
export async function groupStop(g: GroupConv) {
  if (!can("groups.stop")) return;
  g.stopping = g.stopping || uuid();
  try {
    const r = await call("groups.stop", gparams({ room_id: g.id, cancel_id: g.stopping }), 30000);
    // groups.stop ne connaît pas la table ronde : le plugin arrête ses tâches
    const rt = await call("plugin.bot-groups.dispatch.stop", { room_id: g.id }, 30000).catch((e: any) => (rpcMissing(e) ? { stopped: 0 } : Promise.reject(e)));
    const n = (r.cancelled ?? 0) + (rt?.stopped ?? 0);
    note(g, "Arrêt demandé (" + n + " tour" + (n > 1 ? "s" : "") + ")");
    g.stopping = null;
  } catch (e: any) {
    note(g, "Arrêt non confirmé : " + e.message);
  }
  pollGroup(g);
}
function groupNext(g: GroupConv, text: string) {
  const t = (text || "").trim();
  if (!t) {
    note(g, "Écris le message après /q.");
    return;
  }
  groupSend(g, replyPrefix() + t, undefined, true);
  clearReply();
}
export function groupSubmit(g: GroupConv, text: string) {
  if (!text && g.gs.busy) return groupStop(g);
  if (text && groupCommand(g, text)) return;
  if (text) {
    groupSend(g, replyPrefix() + text);
    clearReply();
  }
}

// ---------- commandes / d'un groupe (exécutées par l'app) ----------
type Cmd = { name: string; args?: string; meta: string; cap?: string; run: (g: GroupConv, arg: string) => any };
const GROUP_COMMANDS: Cmd[] = [
  { name: "stop", meta: "Arrêter les bots qui travaillent", cap: "groups.stop", run: (g) => groupStop(g) },
  { name: "q", args: "<message>", meta: "Demande suivante : part après la discussion en cours", run: (g, arg) => groupNext(g, arg) },
  { name: "queue", args: "<message>", meta: "Demande suivante : part après la discussion en cours", run: (g, arg) => groupNext(g, arg) },
  { name: "reglages", meta: "Ouvrir les réglages du groupe", run: () => groupUi.openSettings() },
  { name: "renommer", args: "<nom>", meta: "Renommer le groupe", cap: "groups.rename", run: (g, arg) => renameGroup(g, arg) },
  { name: "meneur", args: "@bot", meta: "Changer le meneur du groupe", cap: "groups.context", run: (g, arg) => setLead(g, arg) },
  {
    name: "aide",
    meta: "Lister les commandes du groupe",
    run: (g) =>
      note(
        g,
        "Commandes : " +
          groupCommands()
            .map((c) => "/" + c.name + (c.args ? " " + c.args : ""))
            .join(", ")
      ),
  },
];
export const groupCommands = () => GROUP_COMMANDS.filter((c) => !c.cap || can(c.cap));
function groupCommand(g: GroupConv, text: string) {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return false;
  const cmd = groupCommands().find((c) => c.name === m[1].toLowerCase());
  if (!cmd) return false;
  Promise.resolve(cmd.run(g, (m[2] || "").trim())).catch((e) => note(g, "Échec : " + e.message));
  return true;
}
async function applyRename(g: GroupConv, name: string, eventId: string) {
  const r = await call("groups.rename", gparams({ room_id: g.id, event_id: eventId, name }), 30000);
  g.setGs("room", "name", r.room?.name || name);
  const i = app.groups.findIndex((x) => x.room_id === g.id);
  if (i >= 0) setApp("groups", i, "name", g.gs.room.name);
}
async function renameGroup(g: GroupConv, name: string) {
  if (!name) return note(g, "Usage : /renommer <nouveau nom>");
  if (name === g.gs.room.name) return note(g, "Le groupe s’appelle déjà « " + name + " ».");
  await applyRename(g, name, uuid());
  note(g, "Groupe renommé en « " + g.gs.room.name + " ».");
}
async function setLead(g: GroupConv, arg: string) {
  const q = arg.replace(/^@/, "").toLowerCase();
  const m = q && g.gs.room.members.find((x: any) => x.handle?.toLowerCase() === q || memberName(x).toLowerCase() === q);
  if (!m) return note(g, q ? "Aucun membre « " + arg + " » dans ce groupe." : "Usage : /meneur @bot");
  const ctx = g.gs.context || { purpose: "", notes: "" };
  if (ctx.routing === "lead" && ctx.lead_member_id === m.member_id) return note(g, memberName(m) + " mène déjà le groupe.");
  const r = await call(
    "groups.context",
    gparams({ room_id: g.id, event_id: uuid(), purpose: ctx.purpose || "", notes: ctx.notes || "", routing: "lead", lead_member_id: m.member_id }),
    30000
  );
  g.setGs("context", r.context || { ...ctx, routing: "lead", lead_member_id: m.member_id });
  note(g, memberName(m) + " mène maintenant le groupe.");
  pollGroup(g);
}

// ---------- réglages du groupe ----------
export function settingsIds(g: GroupConv) {
  g.settingsIds = { rename: uuid(), context: uuid() };
  return g.settingsIds;
}
export async function saveGroupSettings(
  g: GroupConv,
  name: string,
  next: { purpose: string; notes: string; lead_member_id: string },
  picked: string[] | null,
  step: (t: string) => void
) {
  if (!name) throw new Error("Le nom ne peut pas être vide.");
  if (new Blob([next.notes]).size > 4096) throw new Error("Notes trop longues (4 Ko max).");
  const before = g.gs.room.members
    .map((m: any) => m.profile)
    .sort()
    .join(",");
  if (picked && picked.slice().sort().join(",") !== before) return recreateGroup(g, name, next, picked, step);
  const ctx = g.gs.context || { purpose: "", notes: "", routing: "everyone", lead_member_id: "" },
    ids = g.settingsIds || settingsIds(g);
  step("Enregistrement…");
  if (can("groups.rename") && name !== g.gs.room.name) await applyRename(g, name, ids.rename);
  const changed =
    next.purpose !== (ctx.purpose || "") || next.notes !== (ctx.notes || "") || ctx.routing !== "lead" || next.lead_member_id !== ctx.lead_member_id;
  if (can("groups.context") && changed) {
    const r = await call(
      "groups.context",
      gparams({ room_id: g.id, event_id: ids.context, purpose: next.purpose, notes: next.notes, routing: "lead", lead_member_id: next.lead_member_id }),
      30000
    );
    g.setGs("context", r.context || { ...next, routing: "lead" });
  }
  pollGroup(g);
  return "saved";
}
const memberDescriptor = (p: string) => {
  const b = app.bots.find((x) => x.name === p);
  return { member_id: p, profile: p, handle: b?.is_default ? "hermes" : p, target: { kind: "local", profile: p }, ...(b ? { display_name: botName(b) } : {}) };
};
// Publications de table ronde d'avant bot-groups 1.11.0 : des diffs de fichiers, du bruit pour un résumé.
const isDiffPost = (t: string) => /^\[[\w-]+\] │/.test(t) || (t.match(/^│/gm) || []).length > 3;
async function roomTranscript(g: GroupConv) {
  const msgs: string[] = [];
  for (let since = 0, more = true; more;) {
    const page = await call("groups.log", gparams({ room_id: g.id, since_seq: since, limit: 500 }), 30000);
    for (const ev of page.events || []) {
      const t = ev.kind === "message.user" || ev.kind === "message.member" ? asText(ev.payload?.text).trim() : "";
      if (!t || isDiffPost(t) || t.startsWith("[Reprise du groupe")) continue;
      // un résultat de bot passe par message.user : attribué au bot, pas à Yoan (issue 91 point 7)
      const bp = ev.kind === "message.user" ? botPost(g, t) : null;
      msgs.push(bp ? memberName(bp.member) + " : " + bp.body : (ev.kind === "message.user" ? "Yoan" : actorName(g, ev.actor)) + " : " + t);
    }
    since = Math.max(since, page.cursor ?? 0);
    more = !!page.has_more && (page.events || []).length > 0;
  }
  return msgs;
}
const RECAP_HEAD = (name: string, who: string) =>
  `[Reprise du groupe « ${name} », recréé pour changer ses membres. Résumé des échanges${who ? " écrit par " + who : ""}. Ne réponds pas à ce message.]\n\n`;
// Le meneur lit tout l'historique et écrit le résumé (server.ts /recap) ; en cas d'échec, les derniers messages sont copiés.
async function roomRecap(g: GroupConv, ctx: any, step: (t: string) => void) {
  const msgs = await roomTranscript(g);
  if (!msgs.length) return null;
  let lines = msgs.map((t) => (t.length > 6000 ? t.slice(0, 6000) + "…" : t));
  while (lines.length > 1 && lines.join("\n\n").length > 100000) lines = lines.slice(1);
  const members = g.gs.room.members || [],
    lead = members.find((m: any) => m.member_id === ctx.lead_member_id) || members[0];
  if (lead?.profile) {
    const who = memberName(lead) || lead.profile;
    step(`${who} écrit le résumé des échanges (jusqu'à 2 min)…`);
    try {
      const r = await fetch("recap", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: lead.profile, room: g.gs.room.name, transcript: lines.join("\n\n") }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.text) return RECAP_HEAD(g.gs.room.name, who) + j.text;
      report("error", `recap ${r.status} ${j.detail || ""}`, "groups.ts");
    } catch (e: any) {
      report("error", "recap " + e.message, "groups.ts");
    }
  }
  step("Résumé indisponible : copie des derniers messages…");
  let tail = msgs.slice(-30).map((t) => (t.length > 1500 ? t.slice(0, 1500) + "…" : t));
  while (tail.join("\n\n").length > 12000) tail = tail.slice(1);
  return (
    `[Reprise du groupe « ${g.gs.room.name} », recréé pour changer ses membres. Voici les derniers échanges pour contexte. Ne réponds pas à ce message.]\n\n` +
    tail.join("\n\n")
  );
}
async function recreateGroup(g: GroupConv, name: string, ctx: any, picked: string[], step: (t: string) => void) {
  if (picked.length < 2 || picked.length > app.team.max_members) throw new Error(`Choisis de 2 à ${app.team.max_members} bots.`);
  if (
    !confirm(
      `Recréer « ${name} » avec ${picked.length} bots ? Le but, les notes et un résumé des derniers échanges passent dans le nouveau groupe, puis l'ancien est supprimé.`
    )
  )
    return "cancel";
  // ids gardés par ancien groupe : un changement interrompu reprend sans doublon
  const key = "recreate-" + g.id,
    ids = store.get<any>(key, null) || { room_id: uuid(), context: uuid(), recap: uuid(), cancel: uuid() };
  store.set(key, ids);
  step("Création du nouveau groupe…");
  const r = await call("groups.create", gparams({ room_id: ids.room_id, name, members: picked.map(memberDescriptor) }), 30000);
  const room = r.room;
  if (can("groups.context")) {
    step("Copie du but, des notes et du meneur…");
    const lead = room.members.some((m: any) => m.member_id === ctx.lead_member_id) ? ctx.lead_member_id : room.members[0].member_id;
    await call(
      "groups.context",
      gparams({ room_id: room.room_id, event_id: ids.context, purpose: ctx.purpose || "", notes: ctx.notes || "", routing: "lead", lead_member_id: lead }),
      30000
    );
  }
  step("Résumé des échanges…");
  const recap = ids.recapText !== undefined ? ids.recapText : (ids.recapText = await roomRecap(g, ctx, step));
  store.set(key, ids);
  // Le résumé est du contexte : il entre dans le groupe déjà clos (inbox kind « context »), sans tour de bot. Envoyé par
  // groups.send, il ouvrait une discussion malgré « Ne réponds pas » (groupe dofus recréé, 2026-11-15 et 16).
  if (recap)
    await call(
      "plugin.bot-groups.inbox.send",
      { room_id: room.room_id, event_id: ids.recap, kind: "context", payload: { text: recap, thread_id: ids.recap } },
      45000
    ).catch((e: any) =>
      rpcMissing(e)
        ? call("groups.send", gparams({ room_id: room.room_id, event_id: ids.recap, payload: { text: recap, thread_id: ids.recap } }), 45000)
        : Promise.reject(e)
    );
  step("Suppression de l’ancien groupe…");
  const d = await call("groups.disband", gparams({ room_id: g.id, cancel_id: ids.cancel }), 60000);
  if (!d?.tombstone) throw new Error("ancien groupe non supprimé");
  store.set(key, null);
  store.del(intentsKey(g.id));
  setGroups([room, ...app.groups.filter((x) => x.room_id !== g.id && x.room_id !== room.room_id)]);
  return { reopen: room.room_id as string };
}
const DISBAND_REASON: Record<string, string> = {
  member_home_unknown: "un bot du groupe est introuvable sur ce Mac",
  peer_unreachable: "un bot est injoignable ; le travail a été arrêté, réessaie plus tard",
};
export async function disbandGroup(g: GroupConv) {
  if (!can("groups.disband")) return false;
  if (!confirm(`Supprimer le groupe « ${g.gs.room.name} » ? Le travail en cours est arrêté et l'historique n'est plus accessible.`)) return false;
  g.disbandId = g.disbandId || uuid(); // même cancel_id d'un essai à l'autre
  try {
    const r = await call("groups.disband", gparams({ room_id: g.id, cancel_id: g.disbandId }), 60000);
    if (!r?.tombstone) throw new Error("suppression non confirmée");
  } catch (e: any) {
    throw new Error("Suppression refusée : " + (DISBAND_REASON[e.data?.reason] || e.message) + ". Tu peux réessayer.");
  }
  setGroups(app.groups.filter((x) => x.room_id !== g.id));
  store.del(intentsKey(g.id));
  return true;
}
export function seatableBots(extra: string[] = []) {
  const seatable = app.caps?.seatable_profiles;
  return app.bots.filter((b) => !isHidden(b) && (extra.includes(b.name) || !Array.isArray(seatable) || seatable.includes(b.name)));
}
export async function createGroup(creationId: string, name: string, picked: string[], leadPick: string, step: (t: string) => void) {
  if (!name) throw new Error("Donne un nom au groupe.");
  if (picked.length < 2 || picked.length > app.team.max_members) throw new Error(`Choisis de 2 à ${app.team.max_members} bots.`);
  step("Création…");
  const r = await call("groups.create", gparams({ room_id: creationId, name, members: picked.map(memberDescriptor) }), 30000);
  let warn = "";
  if (can("groups.context")) {
    step("Choix du meneur…");
    try {
      await call(
        "groups.context",
        gparams({ room_id: r.room.room_id, event_id: creationId + "-lead", purpose: "", notes: "", routing: "lead", lead_member_id: leadPick || picked[0] }),
        30000
      );
    } catch (e: any) {
      warn = "Meneur non enregistré : " + e.message + ". Choisis-le dans les réglages du groupe.";
    }
  }
  setGroups([r.room, ...app.groups.filter((x) => x.room_id !== r.room.room_id)]);
  return { id: r.room.room_id as string, warn };
}

// ---------- réglages des équipes (plugin bot-groups : hosted_rooms.discussion) ----------
async function loadTeamCfg() {
  try {
    setApp("team", { ...(await call("plugin.bot-groups.settings.get", {}, 15000)), loaded: true });
  } catch {
    /* plugin absent ou ancien : on garde les défauts */
  }
}
export async function saveTeam(next: { max_members: number; max_rounds: number; max_messages: number }) {
  const b = app.team.bounds || { max_members: [2, 16], max_rounds: [1, 10], max_messages: [2, 200] };
  const label: Record<string, string> = { max_members: "Bots par équipe", max_rounds: "Tours", max_messages: "Messages" };
  for (const [k, v] of Object.entries(next))
    if (!Number.isInteger(v) || v < b[k][0] || v > b[k][1]) throw new Error(`${label[k]} : entre ${b[k][0]} et ${b[k][1]}.`);
  setApp("team", { ...(await call("plugin.bot-groups.settings.set", next, 90000)), loaded: true });
}

// ---------- tableau du groupe (plugin : tasks.*) ----------
let tasksRpc = true,
  sideRpc = true,
  inboxRpc = true,
  steerRpc = true;
export const tasksAvailable = () => tasksRpc;
export async function pollTasks(g: GroupConv) {
  if (!tasksRpc) return;
  try {
    const tasks = (await call("plugin.bot-groups.tasks.list", { room_id: g.id }, 8000))?.tasks || [];
    if (live(g)) g.setGs("tasks", reconcile(tasks, { key: "id" }));
  } catch (e) {
    if (rpcMissing(e)) tasksRpc = false;
  }
}
export async function taskCall(g: GroupConv, verb: "update" | "remove" | "add", params: any) {
  try {
    await call("plugin.bot-groups.tasks." + verb, { room_id: g.id, ...params }, 15000);
  } catch (e: any) {
    report("error", "tasks." + verb + " " + (e.message || e), "groups.ts");
    await pollTasks(g);
    throw e;
  }
  await pollTasks(g);
}

// ---------- voie rapide, recadrage, demandes suivantes ----------
/** Membres cités par @handle, dans l'ordre, une fois chacun : même règle que le plugin (plugins/bot-groups/routing.py).
 *  « @dofus. » ou « @rea: » citent dofus et rea ; la ponctuation qui suit ne fait pas partie du handle. */
export function citedMembers(members: any[], text: string) {
  const hs = members
    .map((m) => String(m.handle || ""))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!hs.length) return [];
  const rx = new RegExp("(?<![\\w@])@(" + hs.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?![\\w-])", "gi");
  const out: any[] = [];
  for (const m of text.matchAll(rx)) {
    const who = members.find((x) => String(x.handle || "").toLowerCase() === m[1].toLowerCase());
    if (who && !out.includes(who)) out.push(who);
  }
  return out;
}
// Les membres cités (meneur par défaut), s'ils sont tous libres : quand le groupe travaille, ou dès que deux bots sont cités.
export function fastLaneMembers(g: GroupConv, text: string) {
  const ctx = g.gs.context || {};
  if (!sideRpc || ctx.routing !== "lead" || !ctx.lead_member_id) return null;
  let ms = citedMembers(g.gs.room.members, text);
  if (!ms.length) ms = g.gs.room.members.filter((m: any) => m.member_id === ctx.lead_member_id);
  if (!ms.length) return null;
  const working = new Set((g.gs.driver?.member_activity || []).map((a: any) => a.member_id));
  for (const j of g.gs.dispatch || []) {
    const m = g.gs.room.members.find((x: any) => [x.profile, x.member_id].includes(j.bot));
    if (m) working.add(m.member_id);
  }
  if (ms.some((m: any) => working.has(m.member_id))) return null;
  return g.gs.busy || ms.length > 1 ? ms : null;
}
async function sendFastLane(g: GroupConv, text: string, sideId: string, ms: any[]) {
  try {
    await call("plugin.bot-groups.side.send", { room_id: g.id, text, members: ms.map((m) => m.handle), side_id: sideId }, 30000);
    return true;
  } catch (e) {
    if (rpcMissing(e)) sideRpc = false;
    return false;
  }
}
async function sendSteer(g: GroupConv, eventId: string, text: string) {
  if (!steerRpc) return null;
  try {
    return await call("plugin.bot-groups.steer.send", { room_id: g.id, event_id: eventId, text }, 30000);
  } catch (e) {
    if (rpcMissing(e)) {
      steerRpc = false;
      return null;
    }
    throw e;
  }
}
async function sendNext(g: GroupConv, eventId: string, text: string) {
  if (!inboxRpc) return false;
  try {
    await call("plugin.bot-groups.inbox.send", { room_id: g.id, event_id: eventId, kind: "next", payload: { text, thread_id: eventId } }, 30000);
    return true;
  } catch (e) {
    if (rpcMissing(e)) {
      inboxRpc = false;
      return false;
    }
    throw e;
  }
}
function markHeld(g: GroupConv, key: number, kind: string, who?: string) {
  if (kind === "steer") g.thread.patch(key, { held: true, heldKind: kind, st: "steered", ...(who ? { heldWho: who } : {}) });
  else g.thread.patch(key, { held: true, heldKind: kind, st: "pending" });
}
/** Annuler une demande suivante pas encore partie : son texte revient dans la zone de saisie. */
export async function cancelNext(g: GroupConv, m: Msg) {
  const r = await call("plugin.bot-groups.inbox.cancel", { room_id: g.id, event_id: m.next }, 15000);
  if (!r?.cancelled) {
    g.thread.patch(m.key, { next: undefined });
    return;
  } // déjà partie
  typed(r.text || m.textKey || m.text);
  g.thread.remove(m.key);
}
async function heldBubbles(g: GroupConv) {
  if (!inboxRpc || g.heldLoaded) return;
  g.heldLoaded = true;
  let held: any[] = [];
  try {
    held = (await call("plugin.bot-groups.inbox.status", { room_id: g.id }, 8000))?.held || [];
  } catch (e) {
    if (rpcMissing(e)) inboxRpc = false;
    return;
  }
  for (const h of held) {
    const eid = await userEventId(h.event_id);
    if (!live(g) || g.thread.findMsg((m) => m.eid === eid)) continue;
    const b = g.thread.addMsg("user", h.text, { eid, textKey: h.text, ...(h.kind === "next" ? { next: h.event_id } : {}) });
    markHeld(g, b.key, h.kind || "user", h.who);
  }
  markQueued(g);
}
async function sideBubbles(g: GroupConv) {
  for (const j of (g.gs.dispatch || []).filter((x: any) => x.kind === "side" && x.question)) {
    if (g.thread.findMsg((m) => m.side === j.side_id)) continue;
    const eid = await userEventId(j.side_id);
    if (!live(g) || g.thread.findMsg((m) => m.eid === eid)) continue;
    g.thread.addMsg("user", j.question, { st: "pending", side: j.side_id, eid, textKey: j.question });
    markQueued(g);
  }
}
function waitLabel(g: GroupConv) {
  const a = (g.gs.driver?.member_activity || []).find((x: any) => x.status === "running" || x.status === "stopping");
  const m = a && g.gs.room.members.find((x: any) => x.member_id === a.member_id);
  if (m) return memberName(m) + " finit son tour";
  return (g.gs.dispatch || []).length ? "les tables rondes sont rendues" : "la discussion se termine";
}
// Messages de Yoan qui attendent leur tour (gardés par le plugin, ou dans le groupe sans réponse du moteur).
// Une discussion se ferme par son room.activity ou un arrêt ; la plus ancienne encore ouverte est en cours.
export function markQueued(g: GroupConv) {
  const evs = g.events || [];
  const stopAt = Math.max(0, ...evs.filter((e) => e.kind === "room.stop_requested").map((e) => e.seq || 0));
  const closed = new Set(
    evs
      .filter((e) => e.kind === "room.activity")
      .map((e) => e.payload?.discussion_event_id)
      .filter(Boolean)
  );
  const inRoom = new Set(evs.map((e) => e.event_id));
  const lastInThread = new Map();
  for (const e of evs) if (e.kind === "message.user") lastInThread.set(e.payload?.thread_id, e.event_id);
  const open = evs
    .filter((e) => e.kind === "message.user" && (e.seq || 0) > stopAt && !closed.has(e.event_id) && lastInThread.get(e.payload?.thread_id) === e.event_id)
    .sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const waiting = new Set<string>();
  if (g.gs.busy) for (const e of open.slice(1)) if (!/^\[[\w.-]+\] /.test(asText(e.payload?.text))) waiting.add(e.event_id);
  const side = new Set((g.gs.dispatch || []).filter((j: any) => j.kind === "side").map((j: any) => j.side_id));
  const wait = waitLabel(g),
    par = (g.gs.dispatch || []).length;
  batch(() => {
    for (const b of g.thread.items) {
      if (b.k !== "msg" || b.role !== "user" || !b.eid) continue;
      let held = !!b.held;
      if (held && inRoom.has(b.eid)) {
        g.thread.patch(b.key, { held: false, st: b.st === "pending" ? "" : b.st, next: undefined });
        held = false;
      }
      const q = waiting.has(b.eid) || (held && b.heldKind !== "steer");
      const kind = held ? b.heldKind : "";
      const w = q
        ? kind === "next"
          ? "demande suivante, part après la discussion" + (par ? " et les tables rondes" : "")
          : (kind === "user" ? "passe en tête dès que " : "en attente : ") + wait
        : undefined;
      const inSide = !!b.side && side.has(b.side);
      if (b.inQueue !== q || b.wait !== w || b.inSide !== inSide) g.thread.patch(b.key, { inQueue: q, wait: w, inSide });
    }
  });
}

// ---------- fils de travail (plugin : trace.*) ----------
const KEEP_MS = 30 * 864e5;
let traceRpc = true;
const sameMember = (g: GroupConv, a: string, b: string) => {
  if (a === b) return true;
  return g.gs.room.members.filter((m: any) => [m.member_id, m.profile].includes(a)).some((m: any) => [m.member_id, m.profile].includes(b));
};
export const memberOf = (g: GroupConv, id: string) => id && g.gs.room.members.find((m: any) => [m.member_id, m.profile, m.handle].includes(id));
export const nameOf = (g: GroupConv, id: string) => {
  const m = memberOf(g, id);
  return m ? memberName(m) : botLabel(id) || id;
};
export async function pollTraces(g: GroupConv) {
  if (!traceRpc) return;
  try {
    const r = await call("plugin.bot-groups.trace.list", { room_id: g.id }, 8000);
    if (!live(g)) return;
    g.setGs("traces", reconcile(r?.traces || [], { key: "trace_id" }));
    g.traceByEvent = new Map(g.gs.traces.filter((t: any) => t.event_id).map((t: any) => [t.event_id, t]));
  } catch (e) {
    if (rpcMissing(e)) traceRpc = false;
    return;
  }
  batch(() => {
    for (const b of g.thread.items) {
      if (b.k !== "msg" || !b.eid) continue;
      const has = g.traceByEvent.has(b.eid),
        expired = !has && !!b.who && Date.now() - b.ts * 1000 > KEEP_MS;
      const v = has ? "has" : expired ? "expired" : "";
      if ((b.trace || "") !== v) g.thread.patch(b.key, { trace: v });
    }
  });
  pollPastActs(g);
}
// ---------- fil en direct dans le groupe : le même tour en direct qu'en conversation seule (turn.ts) ----------
// Chaque fil en cours est un tour en direct : son texte arrive par trace.live (relevé toutes les 500 ms pendant qu'un bot
// travaille), ses outils et son texte intermédiaire par trace.read. La réponse finale arrive par le groupe : la bulle en
// direct lui laisse alors la place (memberMsg), ou s'efface DRAFT_KEEP_MS après la fin du fil.
type LiveTr = { after: number; done: boolean; busy: boolean };
const LIVE_MS = 500,
  DRAFT_KEEP_MS = 30000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let liveRpc = true;
const whoOf = (g: GroupConv, mid: string) => {
  const m = memberOf(g, mid),
    prof = m?.profile || mid;
  return { name: m ? memberName(m) : botLabel(prof) || prof, color: avatarOf(prof).color, mid: m?.member_id || mid, profile: prof };
};
function turnOf(g: GroupConv, traceId: string, mid: string) {
  const turns = (g.turns ||= new Map());
  let t = turns.get(traceId);
  if (!t) {
    t = new LiveTurn(g.thread, { who: whoOf(g, mid), trace: traceId, inert: true });
    turns.set(traceId, t);
  }
  return t;
}
async function pollLiveTraces(g: GroupConv) {
  if (!traceRpc || !live(g)) return;
  const map = (g.liveTr ||= new Map());
  const running = (g.gs.traces || []).filter((t: any) => t.status === "running");
  for (const t of running) if (!map.has(t.trace_id)) map.set(t.trace_id, { after: -1, done: false, busy: false });
  await Promise.all(
    [...map.entries()]
      .filter(([, s]) => !s.done && !s.busy)
      .map(async ([id, s]) => {
        const tr = (g.gs.traces || []).find((x: any) => x.trace_id === id),
          turn = turnOf(g, id, tr?.member_id || "");
        s.busy = true;
        try {
          const res = await call("plugin.bot-groups.trace.read", { room_id: g.id, trace_id: id, after: s.after, open: turn.running() }, 8000);
          if (!live(g)) return;
          batch(() => {
            for (const e of res.entries || []) {
              s.after = Math.max(s.after, e.n);
              if (e.k === "text" && e.text) turn.segment(e.text);
              else if (e.k === "tool") turn.tool(toRun(e));
            }
          });
          if (res.status && res.status !== "running") {
            s.done = true;
            turn.end();
          }
        } catch (e) {
          const msg = (e as any)?.message || "";
          if (/fil|trace|expir/i.test(msg) && /introuvable|expir/i.test(msg)) s.done = true;
          else if (rpcMissing(e)) traceRpc = false;
        } finally {
          s.busy = false;
        }
      })
  );
}
export const runningTraces = (g: GroupConv, member?: string) =>
  (g.gs.traces || []).filter((t: any) => t.status === "running" && (!member || sameMember(g, t.member_id, member)));
async function liveLoop(g: GroupConv) {
  g.liveLoop = true;
  const draftOf = (g.draftOf ||= new Map()),
    drafts = (g.drafts ||= new Map());
  try {
    while (liveRpc && live(g) && !document.hidden && (runningTraces(g).length || draftOf.size)) {
      let res: any;
      try {
        res = await call("plugin.bot-groups.trace.live", gparams({ room_id: g.id }), 5000);
      } catch (e) {
        if (rpcMissing(e)) liveRpc = false;
        await sleep(LIVE_MS * 2);
        continue;
      }
      if (!live(g)) break;
      const now: Record<string, any> = res?.live || {};
      batch(() => {
        for (const [tid, lv] of Object.entries(now)) {
          const mid = lv.member_id || "",
            turn = turnOf(g, tid, mid);
          turn.snapshot(lv.text || "", String(lv.id));
          const prev = draftOf.get(tid);
          if (turn.bubble && turn.bubble !== prev) {
            if (prev) drafts.delete(prev);
            drafts.set(turn.bubble, mid);
            draftOf.set(tid, turn.bubble);
          }
          if (lv.done) turn.seal(true);
        }
        for (const [tid, key] of draftOf)
          if (!(tid in now)) {
            // fil fini : la bulle attend la réponse postée
            draftOf.delete(tid);
            g.turns?.get(tid)?.seal(true);
            setTimeout(() => {
              if (drafts.delete(key)) g.thread.remove(key);
            }, DRAFT_KEEP_MS);
          }
      });
      await sleep(LIVE_MS);
    }
  } finally {
    g.liveLoop = false;
  }
}

// ---------- actions d'une réponse passée : au-dessus de la bulle, comme en conversation seule (2026-11-18) ----------
// Un fil fini ne change plus : lu une fois, gardé en mémoire. Seules les 40 dernières lignes du fil sont complétées.
const pastActs = new Map<string, ToolRun[]>(),
  pastBusy = new Set<string>();
const toRun = (e: any): ToolRun => ({
  id: e.id || "n" + e.n,
  name: e.name || "outil",
  detail: shortArg(e.args),
  st: !e.state || e.state === "running" ? "run" : e.state === "error" ? "fail" : "done",
  ...(e.output ? { out: String(e.output).slice(0, 2000) } : {}),
});
async function pollPastActs(g: GroupConv) {
  const todo: [number, any][] = [];
  for (const it of g.thread.items.slice(-40)) {
    if (it.k !== "msg" || !it.eid || it.acts) continue;
    const t = g.traceByEvent.get(it.eid);
    if (!t || t.status === "running" || g.liveTr?.has(t.trace_id)) continue;
    const known = pastActs.get(t.trace_id);
    if (known) g.thread.patch(it.key, { acts: known });
    else if (!pastBusy.has(t.trace_id)) todo.push([it.key, t]);
  }
  await Promise.all(
    todo.slice(0, 6).map(async ([key, t]) => {
      pastBusy.add(t.trace_id);
      try {
        const res = await call("plugin.bot-groups.trace.read", { room_id: g.id, trace_id: t.trace_id, after: -1, open: [] }, 8000);
        const acts = (res.entries || []).filter((e: any) => e.k === "tool").map(toRun);
        pastActs.set(t.trace_id, acts);
        g.thread.patch(key, { acts });
      } catch (e) {
        if (/introuvable|expir/i.test((e as any)?.message || "")) {
          pastActs.set(t.trace_id, []);
          g.thread.patch(key, { acts: [] });
        }
      } finally {
        pastBusy.delete(t.trace_id);
      }
    })
  );
}
/** Toucher un bot au travail : le fil défile jusqu'à ses actions en direct (ou sa dernière réponse). */
export function showWork(g: GroupConv, member: string) {
  const items = g.thread.items;
  let key = 0;
  for (let i = items.length - 1; i >= 0 && !key; i--) {
    const it: any = items[i];
    if (it.who && sameMember(g, it.who.mid, member) && (it.k === "tools" || it.k === "msg")) key = it.key;
  }
  const el = key && document.querySelector(`[data-testid=thread] [data-key="${key}"]`);
  if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
}
/** Arrêter un seul bot du groupe (bouton du bloc d'actions en direct). */
export async function stopBot(g: GroupConv, member: string) {
  try {
    await call("plugin.bot-groups.member.stop", { room_id: g.id, member_id: member }, 30000);
  } catch (e: any) {
    note(g, "Arrêt de " + nameOf(g, member) + " non confirmé : " + e.message);
  }
  pollTraces(g);
}
const SHORT_KEYS = ["command", "cmd", "path", "file_path", "filepath", "query", "pattern", "url", "name", "prompt", "task", "text"];
/** Argument court d'un outil : « git status », un chemin, une requête. */
export function shortArg(args: any) {
  if (!args || typeof args !== "object") return "";
  let v = SHORT_KEYS.map((k) => args[k]).find((x) => typeof x === "string" && x.trim());
  if (v === undefined) v = Object.values(args).find((x) => typeof x === "string" && (x as string).trim());
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
}
document.addEventListener("visibilitychange", () => {
  const g = currentGroup();
  if (!document.hidden && g) pollGroup(g);
});
window.addEventListener("online", () => {
  const g = currentGroup();
  if (g) pollGroup(g);
});
