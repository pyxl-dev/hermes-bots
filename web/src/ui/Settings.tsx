// Page Réglages : notifications push de cet appareil, équipes, couleur de mes messages, état de la synchro.
import { For, Show, createSignal, onMount } from "solid-js";
import { ME_COLORS, app, previewBubble, setMyBubble } from "../data/app";
import { saveTeam } from "../data/groups";
import { IcBack } from "./icons";

const pushOk = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const b64u = (s: string) => {
  const p = "=".repeat((4 - (s.length % 4)) % 4),
    r = atob((s + p).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(r, (ch) => ch.charCodeAt(0));
};
const deviceName = () =>
  (/iPhone|iPad|Android|Macintosh|Windows/.exec(navigator.userAgent)?.[0] || "appareil") +
  (matchMedia("(display-mode: standalone)").matches ? " (app)" : " (navigateur)");
async function pushSub() {
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager.getSubscription();
}
async function pushPost(path: string, sub: PushSubscription) {
  const r = await fetch("push/" + path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub.toJSON(), device: deviceName() }),
  });
  if (!r.ok) {
    let d = "";
    try {
      d = (await r.json()).detail;
    } catch {}
    throw new Error(d || "erreur " + r.status);
  }
  return r.json();
}

function Step(p: { label: string; hint: string; value: number; min: number; max: number; set: (v: number) => void }) {
  return (
    <div class="srow">
      <span class="lbl">
        <b>{p.label}</b>
        <small>{p.hint}</small>
      </span>
      <div class="step">
        <button type="button" aria-label="Moins" onClick={() => p.set(Math.max(p.min, p.value - 1))}>
          −
        </button>
        <input
          type="number"
          inputmode="numeric"
          min={p.min}
          max={p.max}
          value={p.value}
          onInput={(e) => p.set(Number(e.currentTarget.value))}
          aria-label={p.label}
        />
        <button type="button" aria-label="Plus" onClick={() => p.set(Math.min(p.max, p.value + 1))}>
          +
        </button>
      </div>
    </div>
  );
}

export function Settings(p: { onBack: () => void }) {
  const [on, setOn] = createSignal(false);
  const [nfMsg, setNfMsg] = createSignal("Envoie une notification d’essai");
  const [state, setState] = createSignal("");
  async function refresh() {
    let v = false;
    try {
      v = pushOk() && Notification.permission === "granted" && !!(await pushSub());
    } catch {}
    setOn(v);
    if (!pushOk())
      setState(
        /iPhone|iPad/.test(navigator.userAgent) && !matchMedia("(display-mode: standalone)").matches
          ? "Sur iPhone, ajoute d’abord Hermes Bots à l’écran d’accueil (Partager, Sur l’écran d’accueil), puis ouvre-le de là."
          : "Ce navigateur ne gère pas les notifications push."
      );
    else if (Notification.permission === "denied") setState("Bloquées pour ce site : autorise-les dans les réglages du navigateur.");
    else setState(v ? "Actives sur cet appareil" : "Coupées sur cet appareil");
  }
  onMount(refresh);
  async function toggle() {
    setNfMsg("…");
    try {
      let sub = await pushSub();
      if (sub) {
        await pushPost("unsubscribe", sub).catch(() => {});
        await sub.unsubscribe();
        setNfMsg("Coupées.");
      } else {
        if ((await Notification.requestPermission()) !== "granted") {
          setNfMsg("Permission refusée.");
          return;
        }
        const { key } = await (await fetch("push/key", { credentials: "same-origin" })).json();
        const reg = await navigator.serviceWorker.ready;
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(key) });
        const r = await pushPost("subscribe", sub);
        setNfMsg(`Activées (${r.devices} appareil${r.devices > 1 ? "s" : ""}).`);
      }
    } catch (e: any) {
      setNfMsg("Échec : " + e.message);
    }
    refresh();
  }
  async function test() {
    setNfMsg("…");
    try {
      const sub = await pushSub();
      if (!sub) throw new Error("pas abonné");
      const r = await pushPost("test", sub);
      setNfMsg(r.ok ? "Envoyée : elle arrive dans quelques secondes." : "Le service push a refusé l’envoi.");
    } catch (e: any) {
      setNfMsg("Échec : " + e.message);
    }
  }
  const [team, setTeam] = createSignal({ max_members: app.team.max_members, max_rounds: app.team.max_rounds, max_messages: app.team.max_messages });
  const [tsMsg, setTsMsg] = createSignal("");
  const [tsBusy, setTsBusy] = createSignal(false);
  async function saveT() {
    setTsBusy(true);
    setTsMsg("Enregistrement…");
    try {
      await saveTeam(team());
      setTsMsg("Enregistré.");
    } catch (e: any) {
      setTsMsg(e.message.includes(":") ? e.message : "Échec : " + e.message);
    } finally {
      setTsBusy(false);
    }
  }
  const cur = () => (app.bubble || ME_COLORS[0]).toLowerCase();
  const custom = () => !ME_COLORS.includes(cur());
  return (
    <section id="settings" class="view" data-testid="settings">
      <header class="bar">
        <button class="icon-btn" type="button" aria-label="Retour" onClick={p.onBack}>
          <IcBack />
        </button>
        <h1>Réglages</h1>
      </header>
      <div class="page-body">
        <h2 class="sect">Notifications sur cet appareil</h2>
        <div class="card">
          <div class="srow">
            <span class="lbl">
              <b>Mentions @yoan</b>
              <small>{state()}</small>
            </span>
            <button
              class="switch"
              type="button"
              role="switch"
              aria-checked={on()}
              aria-label="Notifications des mentions"
              disabled={!pushOk() || ("Notification" in window && Notification.permission === "denied")}
              onClick={toggle}
            />
          </div>
          <div class="srow">
            <span class="lbl">
              <b>Ce téléphone</b>
              <small>{nfMsg()}</small>
            </span>
            <Show when={on()}>
              <button class="pill g s" type="button" onClick={test}>
                Tester
              </button>
            </Show>
          </div>
        </div>
        <Show when={app.team.loaded}>
          <h2 class="sect">Équipes</h2>
          <div class="card">
            <Step
              label="Bots par groupe"
              hint="au plus, de 2 à 16"
              value={team().max_members}
              min={2}
              max={16}
              set={(v) => setTeam({ ...team(), max_members: v })}
            />
            <Step label="Tours de discussion" hint="de 1 à 10" value={team().max_rounds} min={1} max={10} set={(v) => setTeam({ ...team(), max_rounds: v })} />
            <Step
              label="Messages par discussion"
              hint="au plus, de 2 à 200"
              value={team().max_messages}
              min={2}
              max={200}
              set={(v) => setTeam({ ...team(), max_messages: v })}
            />
          </div>
          <p class="msg small left">Une discussion s’arrête au premier plafond atteint. Les nouvelles valeurs valent dès la prochaine discussion.</p>
          <p class="msg small left">{tsMsg()}</p>
          <button class="pill wide" type="button" disabled={tsBusy()} onClick={saveT}>
            Enregistrer les équipes
          </button>
        </Show>
        <h2 class="sect">Mes messages</h2>
        <div class="card">
          <div class="me-prev">
            <div class="bubble">Voilà à quoi ressemblent mes messages.</div>
          </div>
          <div class="colors me-colors" role="radiogroup" aria-label="Couleur de mes messages">
            <For each={ME_COLORS}>
              {(x, i) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={x === cur()}
                  aria-label={i() ? "Couleur " + x : "Gris (par défaut)"}
                  style={{ background: x, "box-shadow": i() ? undefined : "inset 0 0 0 1px #3A3A3A" }}
                  onClick={() => setMyBubble(x)}
                />
              )}
            </For>
            <label
              class="custom"
              role="radio"
              aria-checked={custom()}
              aria-label="Couleur libre"
              style={{
                display: "inline-block",
                width: "36px",
                height: "36px",
                "border-radius": "50%",
                "box-shadow": custom() ? "0 0 0 3px var(--panel),0 0 0 5px #fff" : undefined,
              }}
            >
              <input type="color" value={cur()} onInput={(e) => previewBubble(e.currentTarget.value)} onChange={(e) => setMyBubble(e.currentTarget.value)} />
            </label>
          </div>
        </div>
        <h2 class="sect">Épinglés et personnages</h2>
        <div class="card">
          <div class="srow">
            <span class="lbl">
              <b>Synchronisés</b>
              <small>
                {app.pinDirty
                  ? "En attente de connexion : envoyés dès que possible"
                  : `${app.pinned.length} épingle${app.pinned.length > 1 ? "s" : ""}, partagées entre tes appareils`}
              </small>
            </span>
            <i class="dot" classList={{ ok: !app.pinDirty }} />
          </div>
        </div>
      </div>
    </section>
  );
}
