// Ouverture et fermeture des conversations, retour, réveil, démarrage.
import { batch } from "solid-js";
import { store } from "../lib/store";
import { app, loadRoster, roster, setApp } from "./app";
import { attach, closeBot, current, openBot, reconnectNow, resyncBusy } from "./chat";
import { bindDraft, clearReply, takeStaged } from "./composer";
import { conv, setConv, show } from "./conv";
import { closeGroup, currentGroup, openGroup } from "./groups";

export function closeConv() {
  const c = conv();
  if (!c) return;
  clearReply();
  // les pièces jointes préparées appartiennent à la conversation quittée : elles ne partent pas dans la suivante
  for (const s of takeStaged()) if (s.url) URL.revokeObjectURL(s.url);
  if (c.kind === "bot") closeBot(c);
  else closeGroup(c);
  batch(() => {
    setConv(null);
    setApp("open", null);
    setApp("live", { key: "", busy: false });
  });
}
export function goBot(name: string) {
  return openBot(name, closeConv).then(() => undefined);
}
export function goRoom(id: string) {
  return openGroup(id, closeConv);
}
export function goKey(key: string) {
  return key.startsWith("room:") ? goRoom(key.slice(5)) : goBot(key);
}
// bindDraft suit la conversation ouverte : le brouillon est rangé par clé
let lastKey: string | null = null;
export function syncDraft() {
  const k = conv()?.key ?? null;
  if (k !== lastKey) {
    lastKey = k;
    bindDraft(k);
  }
}

export function goHome() {
  if (location.hash) history.back();
  else {
    store.set("last-chat", null);
    closeConv();
    show("home");
    loadRoster();
  }
}
window.addEventListener("popstate", () => {
  if (!location.hash) {
    store.set("last-chat", null);
    closeConv();
    show("home");
    loadRoster();
  } else if (location.hash !== "#settings" && app.view === "settings") show(conv() ? "chat" : "home");
});

// Retour du réseau ou de l'arrière-plan (y compris bfcache) : tout se reconnecte et se recale, jamais d'état figé.
function wake() {
  const c = current();
  if (!roster.gw?.up || app.view === "home") loadRoster();
  if (c && !c.gw?.up) reconnectNow(c);
  else if (c) resyncBusy(c);
}
window.addEventListener("online", wake);
window.addEventListener("pageshow", (e) => {
  if (e.persisted) wake();
});
document.addEventListener("visibilitychange", () => {
  document.documentElement.classList.toggle("bg", document.hidden); // animations en pause
  if (!document.hidden) wake();
});
// Recalage toutes les 30 s : la liste à l'accueil, l'état « travaille » de la conversation ouverte dans tous les cas.
setInterval(() => {
  if (document.hidden) return;
  if (app.view === "home") loadRoster();
  const c = current();
  if (c?.gw?.up) resyncBusy(c);
  else if (c && !c.retryTimer) attach(c);
}, 30000);
export { currentGroup, roster };
import { refreshActivity } from "./app";
export const homeShown = () => app.view === "home" || matchMedia("(min-width: 900px)").matches;
setInterval(() => {
  if (!document.hidden && homeShown()) refreshActivity();
}, 5000);
