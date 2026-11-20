// Conversation ouverte : en-tête avec le statut en direct (personnage animé + un mot), fil, barre du groupe, composeur.
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { app, botName, memberName } from "../data/app";
import { type BotConv, subLine } from "../data/chat";
import { type GroupConv, can, groupStop, groupSub, groupUi, showWork, tasksAvailable, workers } from "../data/groups";
import { goHome } from "../data/nav";
import { type Msg, statusWord } from "../data/thread";
import { DOTS, avatarOf } from "../lib/avatars";
import { Av, GAv } from "./Av";
import { Composer, submitText } from "./Composer";
import { IcBack, IcDown, IcMore, IcSearch, IcTasks, IcUp, IcX } from "./icons";
import { findOpen, setFindOpen, setSheet, showMsg } from "./state";
import { ThreadView } from "./Thread";

type Conv = BotConv | GroupConv;

/** Mot du statut et état du personnage : travaille, attend Yoan (accord ou question en suspens), au repos. */
function look(c: Conv) {
  if (c.kind === "room") {
    const busy = c.gs.busy,
      waiting = !busy && !!c.gs.driver?.pending_actions?.length;
    return { busy, st: busy ? "working" : waiting ? "waiting" : "" };
  }
  const busy = c.ui.busy;
  const waiting = !busy && c.thread.items.some((i) => i.k === "card" && (i.kind === "approval" || i.kind === "clarify") && !i.done);
  return { busy, st: busy ? "working" : waiting ? "waiting" : "" };
}

function Header(p: { c: Conv }) {
  const keys = () => (p.c.kind === "room" ? (p.c.gs.room.members || []).map((m: any) => m.profile) : [p.c.key]);
  const lk = () => look(p.c);
  const name = () => (p.c.kind === "room" ? p.c.gs.room.name : botName(p.c.bot));
  const word = () => {
    if (p.c.kind === "room") return lk().busy ? "Travaille" : "";
    if (!p.c.ui.busy) return "";
    return statusWord(p.c.ui.streaming, p.c.ui.tool);
  };
  const sub = () => (p.c.kind === "room" ? groupSub(p.c) : subLine(p.c));
  return (
    <header class="bar chat-bar">
      <button class="icon-btn" type="button" aria-label="Retour" onClick={goHome}>
        <IcBack />
      </button>
      <span class="chat-av">
        <Show when={p.c.kind === "room"} fallback={<Av k={p.c.key} s={38} ring={lk().busy} st={lk().st} />}>
          <GAv keys={keys()} s={40} st={lk().st} />
        </Show>
      </span>
      <div class="who" onClick={() => setSheet(p.c.kind === "room" ? "groupSettings" : "bot")}>
        <div class="name" data-testid="chat-name">
          {name()}
        </div>
        <div class="sub" classList={{ work: lk().busy }} data-testid="status">
          <Show when={word()} fallback={sub()}>
            <b class="word" data-testid="status-word">
              {word()}
            </b>
            <span style={{ display: "contents" }} innerHTML={DOTS} />
          </Show>
        </div>
      </div>
      <button class="icon-btn find" type="button" aria-label="Rechercher dans le fil" onClick={() => setFindOpen(!findOpen())}>
        <IcSearch />
      </button>
      <Show when={p.c.kind === "room" && tasksAvailable()}>
        <button class="icon-btn find gt" type="button" aria-label="Tâches du groupe" data-testid="tasks-btn" onClick={() => setSheet("tasks")}>
          <IcTasks />
          <Show when={(p.c as GroupConv).gs.tasks.filter((t: any) => t.status !== "done" && !t.archived).length}>
            {(n) => (
              <em class="gt-n" data-testid="tasks-count">
                {n()}
              </em>
            )}
          </Show>
        </button>
      </Show>
      <button
        class="icon-btn more"
        type="button"
        aria-label={p.c.kind === "room" ? "Réglages du groupe" : "Réglages du bot"}
        onClick={() => setSheet(p.c.kind === "room" ? "groupSettings" : "bot")}
      >
        <IcMore />
      </button>
    </header>
  );
}

// ---------- recherche dans le fil : sur les données (tout le fil chargé), le résultat est amené à l'écran ----------
function FindBar(p: { c: Conv }) {
  const [q, setQ] = createSignal("");
  const [cur, setCur] = createSignal(-1);
  let input!: HTMLInputElement;
  const hits = createMemo(() => {
    const s = q().trim().toLowerCase();
    if (!s) return [] as number[];
    return p.c.thread.items.filter((i) => i.k === "msg" && i.text.toLowerCase().includes(s)).map((i) => (i as Msg).key);
  });
  createEffect(
    on(
      hits,
      (h) => {
        setCur(h.length ? h.length - 1 : -1);
        if (h.length) go(h.length - 1);
      },
      { defer: true }
    )
  );
  function mark(key: number) {
    for (const m of document.querySelectorAll("mark.hit")) {
      const par = m.parentNode!;
      m.replaceWith(document.createTextNode(m.textContent || ""));
      par.normalize();
    }
    const b = document.querySelector(`.bubble[data-key="${key}"]`);
    const s = q().trim();
    if (!b || !s) return;
    b.classList.remove("folded");
    const re = new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    const w = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (w.nextNode()) if (re.test(w.currentNode.nodeValue || "")) nodes.push(w.currentNode as Text);
    for (const n of nodes) {
      const v = n.nodeValue || "",
        frag = document.createDocumentFragment();
      let last = 0;
      re.lastIndex = 0;
      for (let m; (m = re.exec(v));) {
        frag.append(v.slice(last, m.index));
        const k = document.createElement("mark");
        k.className = "hit cur";
        k.textContent = m[0];
        frag.append(k);
        last = m.index + m[0].length;
      }
      frag.append(v.slice(last));
      n.replaceWith(frag);
    }
  }
  function go(i: number) {
    const h = hits();
    if (!h.length) return;
    const k = (i + h.length) % h.length;
    setCur(k);
    showMsg(h[k]);
    setTimeout(() => mark(h[k]), 60);
  }
  createEffect(() => {
    if (findOpen())
      queueMicrotask(() => {
        input?.focus();
        input?.select();
      });
  });
  onCleanup(() => mark(-1));
  const close = () => {
    mark(-1);
    setQ("");
    setFindOpen(false);
  };
  return (
    <div class="find-bar">
      <button type="button" aria-label="Fermer la recherche" onClick={close}>
        <IcX />
      </button>
      <label>
        <IcSearch />
        <input
          ref={input}
          type="search"
          placeholder="Rechercher dans le fil"
          autocomplete="off"
          enterkeyhint="search"
          value={q()}
          data-testid="find"
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              go(cur() + (e.shiftKey ? -1 : 1));
            } else if (e.key === "Escape") close();
          }}
        />
        <span class="n" aria-live="polite" data-testid="find-count">
          {hits().length ? cur() + 1 + "/" + hits().length : q().trim() ? "0/0" : ""}
        </span>
      </label>
      <button type="button" aria-label="Résultat précédent" onClick={() => go(cur() - 1)}>
        <IcUp />
      </button>
      <button type="button" aria-label="Résultat suivant" onClick={() => go(cur() + 1)}>
        <IcDown />
      </button>
    </div>
  );
}

// ---------- groupe : qui travaille (avatars, fil au toucher) et Arrêter ----------
function GroupBar(p: { g: GroupConv }) {
  const w = createMemo(() => workers(p.g));
  const shown = () => p.g.gs.busy || w().out.length > 0;
  const list = () => (w().out.length ? w().out : [{ prof: p.g.gs.room.members?.[0]?.profile, id: "", nm: "Le groupe" }]);
  const waiting = () =>
    w()
      .waiting.filter((m: any) => !list().some((x) => x.prof === m.profile))
      .slice(0, Math.max(0, 4 - list().length));
  return (
    <Show when={shown()}>
      <div class="grp-bar" classList={{ par: list().length > 1 }} data-testid="group-bar">
        <span class="grp-stack">
          <For each={list().slice(0, 4)}>
            {(x) => (
              <button
                type="button"
                class="grp-av"
                data-testid="worker"
                data-worker={x.id}
                aria-label={"Voir le travail de " + x.nm}
                onClick={() => x.id && showWork(p.g, x.id)}
              >
                <Av k={x.prof} s={30} ring />
              </button>
            )}
          </For>
          <For each={waiting()}>
            {(m: any) => (
              <span class="grp-wait">
                <Av k={m.profile || m.member_id} s={30} />
              </span>
            )}
          </For>
        </span>
        <span class="grp-txt">
          <Show
            when={list().length === 1}
            fallback={
              <>
                <For each={list()}>
                  {(x, i) => (
                    <>
                      {i() ? (i() === list().length - 1 ? " et " : ", ") : ""}
                      <b style={{ color: avatarOf(x.prof).color }}>{x.nm}</b>
                    </>
                  )}
                </For>{" "}
                travaillent en parallèle
              </>
            }
          >
            <b style={{ color: avatarOf(list()[0].prof).color }}>{list()[0].nm}</b> répond
          </Show>
          <span style={{ display: "contents" }} innerHTML={DOTS} />
          <Show when={waiting().length}>
            {" · " + (waiting().length === 1 ? memberName(waiting()[0]) + " attend son tour" : waiting().map(memberName).join(", ") + " attendent leur tour")}
          </Show>
        </span>
        <Show when={(p.g.gs.busy || p.g.gs.dispatch.length) && can("groups.stop")}>
          <button class="pill g s" type="button" data-testid="group-stop" onClick={() => groupStop(p.g)}>
            Arrêter
          </button>
        </Show>
      </div>
    </Show>
  );
}

function Typing(p: { g: GroupConv }) {
  const t = () => workers(p.g).typing;
  return (
    <Show when={t().length}>
      <div class="note typing">
        {t().join(" · ")}
        <span style={{ display: "contents" }} innerHTML={DOTS} />
      </div>
    </Show>
  );
}

export function Chat(p: { c: Conv }) {
  const colors = () => (p.c.kind === "room" ? (p.c.gs.room.members || []).map((m: any) => avatarOf(m.profile).color) : [avatarOf(p.c.key).color]);
  groupUi.openSettings = () => setSheet("groupSettings");
  groupUi.openTasks = () => setSheet("tasks");
  void app;
  return (
    <section
      id="chat"
      class="view chat"
      classList={{ grp: p.c.kind === "room", busy: look(p.c).busy }}
      data-testid="chat"
      style={{ "--bc": colors()[0], "--bc2": colors()[1] || colors()[0] }}
    >
      <div class="halo" aria-hidden="true" />
      <Header c={p.c} />
      <Show when={findOpen()}>
        <FindBar c={p.c} />
      </Show>
      <ThreadView c={p.c} onChoose={(t) => submitText(p.c, t)} footer={p.c.kind === "room" ? <Typing g={p.c} /> : null} />
      <Show when={p.c.kind === "room"}>
        <GroupBar g={p.c as GroupConv} />
      </Show>
      <Composer c={p.c} />
    </section>
  );
}
