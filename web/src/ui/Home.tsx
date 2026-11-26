// Accueil : épinglés en grandes tuiles, puis récents (bots et groupes mêlés par dernière activité) avec un aperçu.
import { For, Show, createMemo } from "solid-js";
import { type Entry, app, connLabel, isPinned, loginUrl, pinnedEntries, recentEntries, setApp, togglePin } from "../data/app";
import { can } from "../data/groups";
import { goKey } from "../data/nav";
import { type Hit, hits, openHit, searchAll, searching } from "../data/search";
import { isOpen } from "../data/conv";
import { DOTS, avatarOf, mascot, moodOf } from "../lib/avatars";
import { vibrate, when } from "../lib/util";
import { Av, GAv } from "./Av";
import { IcPlus, IcSearch, IcSettings } from "./icons";

const ACT_LABEL: Record<string, string> = { working: "travaille", waiting: "attend ta réponse", starting: "démarre…" };
const Badge = (p: { e: Entry }) => (
  <Show
    when={p.e.mention}
    fallback={
      <Show when={p.e.unread}>
        <i class="badge">•</i>
      </Show>
    }
  >
    <i class="badge me" title="Tu es mentionné">
      @{p.e.mention > 9 ? "9+" : p.e.mention}
    </i>
  </Show>
);

// Appui long (menu contextuel) = épingler ou désépingler ; le clic qui suit est ignoré.
let pressAt = 0;
function press(e: Entry) {
  return {
    onContextMenu: (ev: MouseEvent) => {
      ev.preventDefault();
      pressAt = Date.now();
      vibrate();
      togglePin(e.key);
    },
    onClick: () => {
      if (Date.now() - pressAt < 700) return;
      goKey(e.key);
    },
  };
}

function Tile(p: { e: Entry }) {
  const color = () => (p.e.kind === "bot" ? avatarOf(p.e.key).color : "#B7A6FF");
  return (
    <button
      type="button"
      class={"pin-tile" + (p.e.st && p.e.st !== "idle" ? " act-" + p.e.st : "")}
      classList={{ on: isOpen(p.e.key) }}
      style={{ "--c": color() }}
      data-testid="pin"
      data-key={p.e.key}
      aria-label={p.e.name}
      {...press(p.e)}
    >
      <Show when={p.e.st === "working"}>
        <i class="dotw" />
      </Show>
      <Show
        when={p.e.mention}
        fallback={
          <Show when={p.e.unread}>
            <i class="dotu" />
          </Show>
        }
      >
        <span class="bd">
          <i class="badge me">@{p.e.mention > 9 ? "9+" : p.e.mention}</i>
        </span>
      </Show>
      <Show when={p.e.kind === "bot"} fallback={<GAv keys={(p.e.room?.members || []).map((m: any) => m.profile)} s={58} st={p.e.st} />}>
        <span
          style={{ display: "contents" }}
          innerHTML={(void app.avatars[p.e.key], mascot(avatarOf(p.e.key).kind, color(), 54, { key: p.e.key, st: moodOf(p.e.st) }))}
        />
      </Show>
      <span class="tn">{p.e.name}</span>
    </button>
  );
}

function Row(p: { e: Entry }) {
  return (
    <li
      class="bot"
      classList={{ on: isOpen(p.e.key) }}
      style={{ "--c": avatarOf(p.e.kind === "bot" ? p.e.key : p.e.room?.members?.[0]?.profile || p.e.key).color }}
      data-testid="entry"
      data-key={p.e.key}
      data-kind={p.e.kind}
      {...press(p.e)}
    >
      <Show when={p.e.kind === "bot"} fallback={<GAv keys={(p.e.room?.members || []).map((m: any) => m.profile)} s={50} st={p.e.st} />}>
        <Av k={p.e.key} s={50} st={p.e.st} live={p.e.live} />
      </Show>
      <div class="mid">
        <div class="top">
          <span class="nm">{p.e.name}</span>
          <span class="tm">{when(p.e.at)}</span>
        </div>
        <div class="pv">
          <Show when={ACT_LABEL[p.e.st || ""]} fallback={<span>{p.e.preview}</span>}>
            <span class={"act " + p.e.st}>
              {ACT_LABEL[p.e.st!]}
              <Show when={p.e.st === "working"}>
                <span style={{ display: "contents" }} innerHTML={DOTS} />
              </Show>
            </span>
          </Show>
          <Badge e={p.e} />
        </div>
      </div>
    </li>
  );
}

let st: any;
function HitRow(p: { h: Hit }) {
  const parts = () => {
    const q = app.q.trim(),
      i = p.h.text.toLowerCase().indexOf(q.toLowerCase());
    return i < 0 ? [p.h.text, "", ""] : [p.h.text.slice(0, i), p.h.text.slice(i, i + q.length), p.h.text.slice(i + q.length)];
  };
  return (
    <li class="hit" data-testid="search-hit" data-key={p.h.key} onClick={() => openHit(p.h)}>
      <div class="top">
        <span class="nm">{p.h.name}</span>
        <span class="tm">{when(p.h.at)}</span>
      </div>
      <div class="pv">
        <b>{p.h.who} : </b>
        {parts()[0]}
        <mark>{parts()[1]}</mark>
        {parts()[2]}
      </div>
    </li>
  );
}

export function Home(p: { onSettings: () => void; onNewGroup: () => void }) {
  const pins = createMemo(pinnedEntries);
  const recents = createMemo(recentEntries);
  const working = () =>
    pins()
      .filter((e) => e.st === "working")
      .map((e) => e.name + " travaille")
      .join(" · ");
  return (
    <section id="roster" class="view home" data-testid="home">
      <header class="bar top">
        <h1>Bots</h1>
        <Show
          when={app.conn.why === "auth"}
          fallback={
            <span class={"conn " + (app.conn.on ? "on" : app.conn.why ? "off restart" : "off")} title="Connexion" data-testid="conn">
              <i />
              <b>{connLabel()}</b>
            </span>
          }
        >
          <a class="conn off restart" href={loginUrl} title="Se reconnecter à Hermes" data-testid="conn">
            <i />
            <b>{connLabel()}</b>
          </a>
        </Show>
        <button class="icon-btn" type="button" aria-label="Réglages" onClick={p.onSettings}>
          <IcSettings />
        </button>
        <Show when={can("groups.create")}>
          <button class="icon-btn plus" type="button" aria-label="Nouveau groupe" onClick={p.onNewGroup}>
            <IcPlus />
          </button>
        </Show>
      </header>
      <div class="search">
        <label>
          <IcSearch />
          <input
            type="search"
            placeholder="Rechercher un bot ou un groupe"
            aria-label="Rechercher"
            autocomplete="off"
            value={app.q}
            onInput={(e) => {
              setApp("q", e.currentTarget.value);
              clearTimeout(st);
              const v = e.currentTarget.value;
              st = setTimeout(() => searchAll(v), 180);
            }}
          />
        </label>
      </div>
      <div class="lists">
        <Show when={pins().length}>
          <h2 class="sect">Épinglés</h2>
          <div class="pins" data-testid="pins">
            <For each={pins()}>{(e) => <Tile e={e} />}</For>
          </div>
          <Show when={working()}>
            <p class="pins-live">{working()}</p>
          </Show>
        </Show>
        <h2 class="sect">Récents</h2>
        <ul class="bots" data-testid="recents">
          <For each={recents()}>{(e) => <Row e={e} />}</For>
        </ul>
        <Show when={app.q.trim().length >= 3}>
          <h2 class="sect">Messages{searching() ? "…" : ""}</h2>
          <ul class="hits" data-testid="search-hits">
            <For
              each={hits()}
              fallback={
                <li class="hint">{searching() ? "Recherche dans les fils du téléphone…" : "Aucun message trouvé dans les fils gardés sur ce téléphone."}</li>
              }
            >
              {(h) => <HitRow h={h} />}
            </For>
          </ul>
        </Show>
        <Show when={app.groupsMsg}>
          <p class="msg small">{app.groupsMsg}</p>
        </Show>
        <Show when={app.bots.length && !pins().length && !recents().length && app.q}>
          <p class="msg">Aucun bot ne correspond.</p>
        </Show>
        <p class="hint">Appui long sur un bot ou un groupe pour l’épingler</p>
      </div>
      <Show when={app.rosterMsg.text}>
        <p class="msg" data-testid="roster-msg">
          {app.rosterMsg.text}
          <Show when={app.rosterMsg.login}>
            {" "}
            <a href={loginUrl}>Se connecter</a>
          </Show>
        </p>
      </Show>
    </section>
  );
}
export { isPinned };
