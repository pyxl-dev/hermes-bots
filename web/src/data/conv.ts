// Conversation ouverte (bot ou groupe) et navigation entre les vues.
import { createSignal } from "solid-js";
import { store } from "../lib/store";
import type { Thread } from "./thread";
import { type View, app, setApp } from "./app";

/** Ce que la vue lit d'une conversation, bot ou groupe. */
export type ConvUi = { busy: boolean; sub: string; streaming: boolean; tool: string; flash: string; online: boolean };
export type ConvBase = { kind: "bot" | "room"; key: string; thread: Thread; ui: ConvUi; setUi: (p: Partial<ConvUi>) => void };
export const [conv, setConv] = createSignal<any>(null);

export function show(v: View) {
  setApp("view", v);
}
export const convKey = () => {
  const c = conv();
  return c ? c.key : null;
};

// Notifications locales (onglet ouvert mais caché) : même forme que les Web Push de server.ts.
// Accord depuis la notification : les boutons Autoriser et Refuser de la notif répondent à la carte sans ouvrir l'app.
export const notifAnswers = new Map<string, (choice: string) => Promise<boolean>>();
export async function notify(title: string, body: string, key: string, answer?: (choice: string) => Promise<boolean>) {
  let id = "";
  if (answer) {
    id = key + ":" + Date.now().toString(36);
    notifAnswers.set(id, answer);
  }
  try {
    if (!("Notification" in window) || Notification.permission !== "granted") return id;
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg)
      reg.showNotification(title, {
        body,
        tag: "bot-" + key + (id ? "-ok" : ""),
        icon: "icon-192.png",
        badge: "badge-96.png",
        data: { bot: key, answer: id || undefined },
        ...(id
          ? {
              requireInteraction: true,
              actions: [
                { action: "once", title: "Autoriser" },
                { action: "deny", title: "Refuser" },
              ],
            }
          : {}),
      } as NotificationOptions);
    else new Notification(title, { body });
  } catch {}
  return id;
}
/** Message du service worker : ouvrir une conversation, ou appliquer le choix fait dans une notification. */
export async function onSwMessage(d: any, open: (key: string) => void) {
  if (d?.answer) {
    const f = notifAnswers.get(d.answer);
    notifAnswers.delete(d.answer);
    const ok = f ? await f(d.choice) : false;
    if (!ok && d.bot) open(d.bot); // carte déjà réglée ou page rechargée : on montre la conversation
    return ok;
  }
  if (d?.bot) open(d.bot);
  return false;
}
export function askNotifyOnce() {
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
}
export function rememberChat(kind: "bot" | "room", name: string) {
  store.set("last-chat", { kind, name, ts: Date.now() });
}
export const isOpen = (key: string) => (app.open ? (app.open.kind === "room" ? "room:" + app.open.id : app.open.name) === key : false);
