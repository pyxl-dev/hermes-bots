// État de l'application (un seul store Solid) : roster, groupes, épingles, personnages, activité en direct,
// mentions @yoan, connexion. Les conversations ouvertes vivent dans chat.ts et groups.ts.
import { batch } from "solid-js";
import { createStore, produce, reconcile } from "solid-js/store";
import { AuthError, Gateway, LOGIN_URL } from "../lib/gateway";
import { store } from "../lib/store";
import { TASK_RE, isSilent, toMs, vibrate } from "../lib/util";

export type Bot = any;
export type Room = any;
export type View = "home" | "chat" | "settings";
export type Open = { kind: "bot"; name: string } | { kind: "room"; id: string } | null;

const ME_COLORS = ["#1f1f1f", "#3b82f6", "#7c5cff", "#22a06b", "#e8508e", "#f07b3f", "#f2b33d", "#e5484d"];

export const [app, setApp] = createStore({
  view: "home" as View,
  open: null as Open,
  bots: store.get<Bot[]>("roster-cache", []).filter((b: Bot) => b && typeof b.name === "string"),
  groups: store.get<Room[]>("groups-cache", []).filter((r: Room) => r && typeof r.room_id === "string" && !r.disbanded_at),
  pinned: store.get<string[]>("pinned", []).filter((k) => typeof k === "string"),
  pinDirty: store.get<boolean>("pinned-dirty", false),
  avatars: store.get<Record<string, any>>("avatars", {}) || {},
  bubble: store.get<string | null>("bubble", null),
  seen: store.get<Record<string, number>>("seen", {}) || {},
  meSeen: store.get<Record<string, number>>("mention-seen", {}) || {},
  roomPreview: store.get<Record<string, { text: string; who: string; ts: number }>>("room-preview", {}) || {},
  activity: { bots: {} as Record<string, string>, rooms: {} as Record<string, string> },
  /** conversation ouverte qui travaille (clé : nom du bot ou room:<id>) */
  live: { key: "", busy: false },
  conn: { on: false, why: "" as "" | "retry" | "restart" | "unreachable" },
  rosterMsg: { text: "", login: false },
  groupsMsg: "",
  q: "",
  caps: null as any,
  capsError: "",
  team: { max_members: 10, max_rounds: 5, max_messages: 50, loaded: false, bounds: null as any },
});

// ---------- noms ----------
export function botName(b: Bot) {
  return (b?.ui_meta?.["hermes-bots"]?.title || "").trim() || b?.display_name || (b?.is_default ? "Hermes" : b?.name) || "?";
}
export function isHidden(b: Bot) {
  const m = b?.ui_meta?.["hermes-bots"];
  return !!(m && (m.hidden === true || m.hide === true));
}
export function botLabel(profile: string) {
  const b = app.bots.find((x) => x.name === profile);
  return b ? botName(b) : null;
}
export const memberName = (m: any) => m.display_name || botLabel(m.profile) || m.handle || m.member_id;
export const findBot = (name: string) => app.bots.find((b) => b.name === name);
export const findRoom = (id: string) => app.groups.find((r) => r.room_id === id);
const botSession = (b: Bot) => b.canonical_session || null;
export const botLastActive = (b: Bot) => toMs(botSession(b)?.last_active || b.last_session?.last_active);

export function setSeen(key: string, v: number) {
  setApp("seen", key, v);
  store.set("seen", app.seen);
}

// ---------- mentions @yoan (écrites par le plugin bot-groups dans ui_meta['hermes-bots-mentions']) ----------
function mentionList() {
  const out: { key: string; ts: number }[] = [];
  for (const b of app.bots)
    for (const it of b.ui_meta?.["hermes-bots-mentions"]?.items || [])
      if (Number.isFinite(it?.ts)) out.push({ ts: it.ts, key: it.room_id ? "room:" + it.room_id : b.name });
  return out;
}
export const unseenMentions = (key: string) => mentionList().filter((m) => m.key === key && m.ts > (app.meSeen[key] || 0)).length;
export function markMentionsSeen(key: string) {
  setApp("meSeen", key, Date.now() / 1000);
  store.set("mention-seen", app.meSeen);
  updateAppBadge();
}
function updateAppBadge() {
  const n = mentionList().filter((m) => m.ts > (app.meSeen[m.key] || 0)).length;
  try {
    n ? (navigator as any).setAppBadge?.(n) : (navigator as any).clearAppBadge?.();
  } catch {}
}

// ---------- accueil : épinglés puis récents (bots et groupes mêlés par dernière activité) ----------
export type Entry = {
  key: string;
  kind: "bot" | "room";
  name: string;
  at: number;
  preview: string;
  unread: boolean;
  mention: number;
  st?: string;
  live?: boolean;
  bot?: Bot;
  room?: Room;
};
export function botStatus(name: string) {
  return app.live.key === name && app.live.busy ? "working" : app.activity.bots[name];
}
export function roomStatus(id: string) {
  return app.live.key === "room:" + id && app.live.busy ? "working" : app.activity.rooms[id];
}
export function botEntry(b: Bot): Entry {
  const c = botSession(b);
  const tk = TASK_RE.exec(c?.preview || ""),
    pv0 = tk ? "Tâche automatique · " + tk[1] : c?.preview;
  const st = botStatus(b.name);
  const recent = Date.now() - Math.max(toMs(c?.last_active), toMs(b.worker_session?.last_active)) < 90_000;
  return {
    key: b.name,
    kind: "bot",
    name: botName(b),
    at: botLastActive(b),
    bot: b,
    preview: (isSilent(pv0) ? "" : pv0) || b.description || (c ? "" : "Pas encore de discussion"),
    unread: !!c && app.seen[b.name] !== undefined && toMs(c.last_active) > toMs(app.seen[b.name] || 0),
    mention: unseenMentions(b.name),
    st,
    live: st === undefined && recent,
  };
}
export function roomEntry(r: Room): Entry {
  const pv = app.roomPreview[r.room_id];
  return {
    key: "room:" + r.room_id,
    kind: "room",
    name: r.name,
    at: Math.max(toMs(r.updated_at), toMs(pv?.ts)),
    room: r,
    preview: pv?.text ? (pv.who ? pv.who + " : " : "") + pv.text : (r.members || []).map(memberName).join(", "),
    unread: (r.latest_seq || 0) > (app.seen["room:" + r.room_id] || 0),
    mention: unseenMentions("room:" + r.room_id),
    st: roomStatus(r.room_id),
  };
}
const matches = (e: Entry, q: string) =>
  !q || (e.name + " " + (e.bot ? e.bot.name + " " + (e.bot.description || "") : (e.room?.members || []).map(memberName).join(" "))).toLowerCase().includes(q);
export function pinnedEntries() {
  const q = app.q.trim().toLowerCase(),
    out: Entry[] = [];
  for (const k of app.pinned) {
    if (k.startsWith("room:")) {
      const r = findRoom(k.slice(5));
      if (r) out.push(roomEntry(r));
    } else {
      const b = findBot(k);
      if (b && !isHidden(b)) out.push(botEntry(b));
    }
  }
  return out.filter((e) => matches(e, q));
}
export function recentEntries() {
  const q = app.q.trim().toLowerCase();
  const all = [
    ...app.bots.filter((b) => !isHidden(b) && !isPinned(b.name)).map(botEntry),
    ...app.groups.filter((r) => !isPinned("room:" + r.room_id)).map(roomEntry),
  ];
  return all.filter((e) => matches(e, q)).sort((a, b) => b.at - a.at);
}

// ---------- activité en direct : session.active_list par profil ----------
const ACT_RANK: Record<string, number> = { idle: 0, starting: 1, working: 2, waiting: 3 };
const activity = { socks: {} as Record<string, Gateway>, direct: null as boolean | null, busy: false };
async function activeList(name: string) {
  if (activity.direct !== false && roster.gw?.up) {
    try {
      const r = await roster.gw.call("session.active_list", { profile: name }, 8000);
      activity.direct = true;
      return r.sessions || [];
    } catch {
      activity.direct = false;
    } // un ticket lié à un profil refuse les autres : un socket par bot
  }
  let gw = activity.socks[name];
  if (!gw || !gw.up) gw = activity.socks[name] = await new Gateway(name).connect();
  return (await gw.call("session.active_list", {}, 8000)).sessions || [];
}
export async function refreshActivity() {
  if (activity.busy || !app.bots.length) return;
  activity.busy = true;
  try {
    const bots = app.bots.filter((b) => !isHidden(b));
    const res = await Promise.all(
      bots.map((b) =>
        activeList(b.name).then(
          (rows: any[]) => [b.name, rows] as const,
          () => [b.name, null] as const
        )
      )
    );
    const next: Record<string, string> = {},
      rooms: Record<string, string> = {};
    for (const [name, rows] of res) {
      if (!rows) {
        if (app.activity.bots[name]) next[name] = app.activity.bots[name];
        continue;
      }
      let best = "idle";
      for (const r of rows) {
        const st = ACT_RANK[r.status] !== undefined ? r.status : "idle";
        const m = /^Group: (.+)$/.exec(r.title || "");
        if (m) {
          if (ACT_RANK[st] > ACT_RANK[rooms[m[1]] || "idle"]) rooms[m[1]] = st;
        } // le travail de groupe s'affiche sur le groupe
        else if (ACT_RANK[st] > ACT_RANK[best]) best = st;
      }
      next[name] = best;
    }
    setApp("activity", reconcile({ bots: next, rooms }));
  } finally {
    activity.busy = false;
  }
}

// ---------- roster ----------
export const roster = { gw: null as Gateway | null, retry: 0 as any };
let groupsHook: () => Promise<void> = async () => {};
export const setGroupsHook = (f: () => Promise<void>) => {
  groupsHook = f;
};

export async function loadRoster() {
  try {
    if (!roster.gw?.up) {
      const gw = await new Gateway(null).connect();
      roster.gw = gw;
      // fermeture (drain du gateway, réseau) : on reconnecte quelle que soit la vue
      gw.onClose = () => {
        if (roster.gw === gw) {
          setConn(false, navigator.onLine === false ? "" : "retry");
          retryRoster(3000);
        }
      };
    }
    setConn(true);
    const res = await roster.gw!.call("profiles.list", { include_sessions: true });
    const bots = (res.profiles || []).sort((a: Bot, b: Bot) => botLastActive(b) - botLastActive(a));
    batch(() => {
      setApp("bots", reconcile(bots, { key: "name" }));
      setApp("rosterMsg", { text: "", login: false });
      setApp(
        "seen",
        produce((s) => {
          for (const b of bots) if (s[b.name] === undefined) s[b.name] = botSession(b)?.last_active || 0;
        })
      );
    });
    store.set("seen", app.seen);
    store.set("roster-cache", bots);
    if (app.open) markMentionsSeen(app.open.kind === "room" ? "room:" + app.open.id : app.open.name);
    updateAppBadge();
    await groupsHook();
    syncPins(); // après les groupes : leurs noms partent avec les épingles (raccourcis de l'app)
    refreshActivity();
  } catch (e) {
    handleError(e);
  }
}

// « hors ligne » seulement si le réseau manque ; pendant un redémarrage du gateway : « gateway en redémarrage ».
const isDraining = (e: any) => /ticket 50[234]|runtime_draining|draining|gateway_not_ready/i.test(String(e?.message || e || ""));
// requête qui n'atteint pas le Mac (téléphone sorti de Tailscale, Mac éteint) : fetch rejette un TypeError, libellé selon le
// navigateur (« Failed to fetch » Chrome, « Load failed » Safari, « NetworkError » Firefox). Vu le 2026-11-18 : Tailscale coupé.
const isUnreachable = (e: any) => e instanceof TypeError && /failed to fetch|load failed|networkerror|network request failed/i.test(e.message);
export const UNREACHABLE_MSG = "Mac injoignable : vérifie que Tailscale est connecté sur ce téléphone. L'app se reconnecte seule.";
export function setConn(on: boolean, why: "" | "retry" | "restart" | "unreachable" = "") {
  setApp("conn", { on, why: on ? "" : why });
}
export function connLabel() {
  const c = app.conn;
  return c.on
    ? "en ligne"
    : c.why === "restart"
      ? "gateway en redémarrage"
      : c.why === "unreachable"
        ? "Mac injoignable"
        : c.why === "retry"
          ? "reconnexion…"
          : "hors ligne";
}
function retryRoster(ms: number) {
  clearTimeout(roster.retry);
  roster.retry = setTimeout(() => {
    roster.retry = 0;
    if (!roster.gw?.up) loadRoster();
  }, ms);
}
export function handleError(e: any) {
  if (e instanceof AuthError) {
    setApp("rosterMsg", { text: "Session Hermes expirée.", login: true });
    return;
  }
  if (isDraining(e)) {
    setConn(false, "restart");
    setApp("rosterMsg", { text: "Le gateway Hermes redémarre : reconnexion automatique dans quelques instants.", login: false });
    retryRoster(10000);
    return;
  }
  if (navigator.onLine !== false && isUnreachable(e)) {
    setConn(false, "unreachable");
    setApp("rosterMsg", { text: UNREACHABLE_MSG, login: false });
    retryRoster(15000);
    return;
  }
  setConn(false, navigator.onLine === false ? "" : "retry");
  setApp("rosterMsg", { text: "Erreur : " + (e?.message || e), login: false });
  retryRoster(15000);
}
export const loginUrl = LOGIN_URL;

// ---------- épingles, couleur de mes bulles, personnages : synchronisés avec le serveur (/bots/prefs) ----------
export const isPinned = (key: string) => app.pinned.includes(key);
function setDirty(v: boolean) {
  setApp("pinDirty", v);
  store.set("pinned-dirty", v);
}
export function togglePin(key: string) {
  setApp("pinned", isPinned(key) ? app.pinned.filter((n) => n !== key) : [...app.pinned, key]);
  store.set("pinned", app.pinned);
  setDirty(true);
  vibrate();
  syncPins();
}
export function applyBubble() {
  const c = /^#[0-9a-f]{6}$/i.test(app.bubble || "") ? app.bubble! : ME_COLORS[0];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  document.documentElement.style.setProperty("--me", c);
  document.documentElement.style.setProperty("--me-text", lum > 0.4 ? "#0A0A0A" : "#fff");
}
export { ME_COLORS };
export function previewBubble(c: string) {
  setApp("bubble", c.toLowerCase());
  applyBubble();
}
export function setMyBubble(c: string) {
  setApp("bubble", c.toLowerCase());
  store.set("bubble", app.bubble);
  applyBubble();
  setDirty(true);
  syncPins();
}
export function setAvatar(key: string, av: { color: string; kind: string }) {
  setApp("avatars", key, { ...av });
  store.set("avatars", app.avatars);
  setDirty(true);
  syncPins();
}
// Noms affichables des épingles, envoyés avec la liste : le serveur en fait les raccourcis de l'icône de l'app.
function pinLabels() {
  const out: Record<string, string> = {};
  for (const k of app.pinned) {
    const name = k.startsWith("room:") ? findRoom(k.slice(5))?.name : botName(findBot(k));
    if (name && name !== "?") out[k] = name;
  }
  return out;
}
let pinSync: Promise<void> | null = null,
  pinRetry = 0;
export function syncPins(): Promise<unknown> {
  if (pinSync) return pinSync.then(() => app.pinDirty && syncPins());
  pinSync = (async () => {
    try {
      const dirty = app.pinDirty,
        avatars = JSON.parse(JSON.stringify(app.avatars));
      const r = await fetch(
        "prefs",
        dirty
          ? {
              method: "POST",
              credentials: "same-origin",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                pinned: [...app.pinned],
                labels: pinLabels(),
                ...(store.get("avatars-synced", false) || Object.keys(avatars).length ? { avatars } : {}),
                ...(app.bubble ? { bubble: app.bubble } : {}),
              }),
            }
          : { credentials: "same-origin", cache: "no-store" }
      );
      if (!r.ok) return;
      const d = await r.json();
      store.set("avatars-synced", true);
      const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
      if (dirty && same(d.pinned, app.pinned)) setDirty(false);
      // personnages : le serveur fait foi ; ceux d'avant la synchro partent une fois
      if (!dirty && d.avatars === undefined && Object.keys(app.avatars).length) {
        setDirty(true);
        return;
      }
      if (!dirty && d.avatars && !same(d.avatars, app.avatars)) {
        setApp("avatars", reconcile(d.avatars));
        store.set("avatars", d.avatars);
      }
      // couleur de mes bulles : le serveur fait foi ; une couleur choisie avant la synchro part une fois
      if (!dirty && d.bubble === undefined && app.bubble) {
        setDirty(true);
        return;
      }
      if (!dirty && d.bubble && d.bubble !== app.bubble) {
        setApp("bubble", d.bubble);
        store.set("bubble", d.bubble);
        applyBubble();
      }
      // serveur jamais écrit : les épingles locales de cet appareil deviennent la liste partagée
      if (!dirty && !d.updated && app.pinned.length) {
        setDirty(true);
        return;
      }
      const lab = pinLabels();
      if (!dirty && same(d.pinned, app.pinned) && Object.keys(lab).length && !same(d.labels || {}, lab)) {
        setDirty(true);
        return;
      }
      if (!dirty && Array.isArray(d.pinned) && !same(d.pinned, app.pinned)) {
        setApp("pinned", d.pinned);
        store.set("pinned", d.pinned);
      }
    } catch {
    } finally {
      pinSync = null;
    }
  })();
  return pinSync.then(() => app.pinDirty && !pinRetry++ && syncPins());
}
export function setRoomPreview(id: string, text: string, who: string, ts: number) {
  const t = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  if (!t || app.roomPreview[id]?.text === t) return;
  setApp("roomPreview", id, { text: t, who, ts });
  store.set("room-preview", app.roomPreview);
}

applyBubble();
