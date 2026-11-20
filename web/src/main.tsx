// Démarrage : coquille hors ligne, liste depuis le cache, réouverture de la dernière conversation, puis la vraie liste.
import "./style.css";
import { ErrorBoundary, type JSX, Show, createEffect } from "solid-js";
import { report } from "./lib/util";
import { render } from "solid-js/web";
import { app, applyBubble, findBot, handleError, loadRoster, roster, setConn, syncPins } from "./data/app";
import * as G from "./data/groups";
import { UiBlocks } from "./lib/blocks";
import { Gateway } from "./lib/gateway";
import { conv, notifAnswers, onSwMessage, show } from "./data/conv";
import { goBot, goKey, goRoom, syncDraft } from "./data/nav";
import { store } from "./lib/store";
import { Chat } from "./ui/Chat";
import { Home } from "./ui/Home";
import { Settings } from "./ui/Settings";
import { Sheets } from "./ui/Sheets";
import { setShareText, setSheet } from "./ui/state";

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
navigator.serviceWorker?.addEventListener("message", (e) => onSwMessage(e.data, goKey));

// Limite d'erreur par vue : une vue qui plante affiche sa panne et un bouton, le reste de l'app continue ; la panne est remontée.
const CACHES = /^(roster-cache|groups-cache|room-preview|cache:|scroll-pos|outbox-dead)/;
function resetCaches() {
  for (const k of Object.keys(localStorage)) if (CACHES.test(k)) localStorage.removeItem(k);
  try {
    indexedDB.deleteDatabase("hermes-bots");
  } catch {}
  location.reload();
}
function Guard(p: { name: string; children: JSX.Element }) {
  return (
    <ErrorBoundary
      fallback={(err, reset) => {
        const msg = String(err?.message || err);
        report("error", p.name + " : " + msg, "main.tsx");
        return (
          <div class="crash" role="alert" data-testid="crash">
            <p>
              <b>Cette partie de l’app a planté.</b> Le reste marche toujours.
            </p>
            <code>{msg.slice(0, 200)}</code>
            <div class="crash-btns">
              <button type="button" class="pill" onClick={reset}>
                Réessayer
              </button>
              <button type="button" class="pill g" onClick={() => location.reload()}>
                Recharger
              </button>
              <button type="button" class="pill g" onClick={resetCaches}>
                Vider le cache
              </button>
            </div>
          </div>
        );
      }}
    >
      {p.children}
    </ErrorBoundary>
  );
}

function openSettings() {
  history.pushState({ settings: 1 }, "", "#settings");
  show("settings");
}

function App() {
  createEffect(syncDraft);
  return (
    <div class="app" classList={{ split: true, "has-conv": !!conv() }} data-view={app.view}>
      <div class="pane-list" classList={{ hide: app.view !== "home" }}>
        <Guard name="accueil">
          <Home onSettings={openSettings} onNewGroup={() => setSheet("newGroup")} />
        </Guard>
      </div>
      <div class="pane-main" classList={{ hide: app.view === "home" && !conv() }}>
        <Show
          when={app.view === "settings"}
          fallback={
            <Show
              when={conv()}
              keyed
              fallback={
                <div class="empty-pane">
                  <p class="hint">Choisis un bot ou un groupe</p>
                </div>
              }
            >
              {(c) => (
                <Guard name="conversation">
                  <Chat c={c} />
                </Guard>
              )}
            </Show>
          }
        >
          <Guard name="réglages">
            <Settings onBack={() => history.back()} />
          </Guard>
        </Show>
      </div>
      <Guard name="volets">
        <Sheets />
      </Guard>
    </div>
  );
}

applyBubble();
render(() => <App />, document.getElementById("root")!);

// partage reçu (Android) : on choisit la destination, pas de réouverture automatique
function sharedText() {
  const q = new URLSearchParams(location.search),
    parts: string[] = [];
  for (const k of ["title", "text", "url"]) {
    const v = (q.get(k) || "").trim();
    if (v && !parts.some((p) => p.includes(v))) parts.push(v);
  }
  return parts.join("\n");
}
const LAST_CHAT_MS = 3600 * 1000;
const lastChat = store.get<any>("last-chat", null);
const shared = sharedText();
const bootTarget = shared
  ? ""
  : decodeURIComponent(location.hash.slice(1)) ||
    (lastChat && Date.now() - lastChat.ts < LAST_CHAT_MS ? (lastChat.kind === "room" ? "room-" + lastChat.name : lastChat.name) : "");
history.replaceState(null, "", location.pathname);
const earlyBot = !!bootTarget && !bootTarget.startsWith("room-") && bootTarget !== "settings" && !!findBot(bootTarget);
if (earlyBot) goBot(bootTarget);
syncPins();
Promise.resolve(loadRoster())
  .then(() => {
    if (shared) {
      setShareText(shared);
      setSheet("share");
      return;
    }
    if (bootTarget && !earlyBot && bootTarget !== "settings") return bootTarget.startsWith("room-") ? goRoom(bootTarget.slice(5)) : goBot(bootTarget);
  })
  .catch(() => {});

// Poignée de test (smoke) : seulement si le test l'a demandée avant le chargement. Documentée dans l'ADR 0004.
if (store.get("bots-test", false))
  (window as any).__bots = {
    app,
    roster,
    handleError,
    setConn,
    conv,
    goKey,
    groups: G,
    UiBlocks,
    Gateway,
    notifAnswers,
    onSwMessage: (d: any) => onSwMessage(d, goKey),
  };
