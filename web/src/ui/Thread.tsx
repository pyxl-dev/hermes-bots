// Fil d'une conversation : seuls les derniers éléments sont dessinés (fenêtre), le passé arrive en remontant.
// Lignes d'action repliées en une ligne cochée, cartes « Besoin de ton OK », bulles markdown en cache.
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount, untrack } from "solid-js";
import { app, botName } from "../data/app";
import { type BotConv, loadOlder } from "../data/chat";
import { type GroupConv, cancelNext, memberOf, stopBot } from "../data/groups";
import { type Card, type Item, type Msg, type Note, type Task, type Tools, actionTarget, actionVerb, answerCard } from "../data/thread";
import { avatarOf } from "../lib/avatars";
import { store } from "../lib/store";
import { REPLY_RE, replyExcerpt, toMs, vibrate } from "../lib/util";
import { hasMention, inertMd, md, mdStream } from "../lib/md";
import { Av } from "./Av";
import { IcDown, IcShield, IcUp } from "./icons";
import { focusKey, setMenu, showMsg } from "./state";

type Conv = BotConv | GroupConv;
const FOLD_CHARS = 2400;

// ---------- dates ----------
function dayLabel(d: Date) {
  const t = new Date();
  t.setHours(0, 0, 0, 0);
  const diff = Math.round((t.getTime() - new Date(d).setHours(0, 0, 0, 0)) / 864e5);
  if (diff === 0) return "Aujourd’hui";
  if (diff === 1) return "Hier";
  return d.toLocaleDateString("fr-FR", {
    weekday: diff < 7 ? "long" : undefined,
    day: "numeric",
    month: "long",
    ...(d.getFullYear() !== t.getFullYear() ? { year: "numeric" } : {}),
  });
}
function stampText(d: Date) {
  const day = d.toLocaleDateString("fr-FR", { day: "numeric", month: "short", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
  return day + " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}
const dayOf = (it: Item) => new Date(toMs(it.ts) || Date.now()).toDateString();
const Stamp = (p: { ts: number }) => {
  const d = new Date(toMs(p.ts) || Date.now());
  return (
    <time class="ts" dateTime={d.toISOString()} title={d.toLocaleString("fr-FR")}>
      {stampText(d)}
    </time>
  );
};

// ---------- bulle ----------
function soloWho(c: Conv, handle: string) {
  if (handle.toLowerCase() === "toi") return { name: "Toi", color: "#8A8A8A" };
  const bot = c.kind === "bot" ? c.bot : null;
  return { name: bot ? botName(bot) : "@" + handle, color: bot ? avatarOf(bot.name).color : "#8A8A8A" };
}
function ReplyFrame(p: { c: Conv; handle: string; excerpt: string; onGo: () => void }) {
  const who = () => {
    if (p.c.kind === "room") {
      const m = (p.c.gs.room.members || []).find((x: any) => (x.handle || "").toLowerCase() === p.handle.toLowerCase());
      if (m) return { name: m.display_name || m.handle, color: avatarOf(m.profile || m.member_id).color };
      return { name: "@" + p.handle, color: "#8A8A8A" };
    }
    return soloWho(p.c, p.handle);
  };
  return (
    <div
      class="rq in"
      style={{ "--c": who().color }}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        p.onGo();
      }}
    >
      <b>{who().name}</b>
      <span>{p.excerpt.replace(/​/g, "")}</span>
    </div>
  );
}

/** Contenu markdown d'une bulle : en cache par texte, au plus un rendu par image pendant le streaming. */
function MdBody(p: { m: Msg }) {
  let el!: HTMLDivElement;
  let raf = 0;
  createEffect(() => {
    const text = p.m.text,
      stream = p.m.stream,
      inert = p.m.inert;
    if (stream) {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          el.innerHTML = mdStream(untrack(() => p.m.text));
        });
      return;
    }
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    el.innerHTML = inert ? inertMd(text) : md(text);
  });
  onCleanup(() => raf && cancelAnimationFrame(raf));
  return <div class="md" style={{ display: "contents" }} ref={el} />;
}

function Bubble(p: { c: Conv; m: Msg; answered: () => string | null; goQuote: (from: Msg, excerpt: string) => void }) {
  const [open, setOpen] = createSignal(false);
  const m = () => p.m;
  const rp = createMemo(() => (m().role === "user" ? REPLY_RE.exec(m().text) : null));
  const long = () => m().role === "assistant" && !m().stream && m().text.length > FOLD_CHARS && !/```bots-ui/.test(m().text);
  const folded = () => long() && !open();
  // Déplier ne doit jamais suivre le bas du fil : on décroche (évènement « unstick » lu par le fil), puis on garde le haut du message visible.
  const toggle = () => {
    const was = open();
    el.dispatchEvent(new CustomEvent("unstick", { bubbles: true }));
    setOpen(!was);
    if (was) {
      el.scrollIntoView({ block: "nearest" });
      return;
    }
    requestAnimationFrame(() => {
      const log = el.closest(".log");
      if (log && el.getBoundingClientRect().top < log.getBoundingClientRect().top) el.scrollIntoView({ block: "start" });
    });
  };
  let el!: HTMLDivElement;
  // boutons de choix : figés dès qu'un message de Yoan suit ; celui dont le texte est ce message est marqué
  createEffect(() => {
    if (m().role !== "assistant" || !/ui-choice|bots-ui/.test(m().text)) return;
    void m().text;
    const said = p.answered();
    queueMicrotask(() => {
      for (const x of el.querySelectorAll<HTMLButtonElement>(".ui-choice")) {
        x.disabled = said !== null;
        x.classList.toggle("chosen", said !== null && x.dataset.say?.trim() === said);
      }
    });
  });
  const [hl, setHl] = createSignal(false);
  createEffect(
    on(
      () => m().hl,
      (v) => {
        if (!v) return;
        setHl(false);
        requestAnimationFrame(() => setHl(true));
        setTimeout(() => setHl(false), 1600);
      }
    )
  );
  return (
    <>
      <div
        ref={el}
        class={"bubble" + (m().st ? " " + m().st : "")}
        data-testid="bubble"
        data-role={m().role}
        data-key={m().key}
        data-wait={m().wait}
        data-who={m().heldWho}
        data-mid={m().who?.mid}
        classList={{
          cursor: !!m().stream,
          folded: folded(),
          "mentions-me": m().role === "assistant" && hasMention(m().text),
          err: !!m().err,
          "has-trace": m().trace === "has",
          "trace-expired": m().trace === "expired",
          hl: hl(),
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          vibrate();
          setMenu(m());
        }}
        onClick={(e) => {
          // toucher un long message l'agrandit (ou le réduit) ; le fil s'ouvre par son bouton (Yoan, 2026-11-18)
          if (!long() || (e.target as HTMLElement).closest("a, button, summary, .rq, .ui-choice") || getSelection()?.toString()) return;
          toggle();
        }}
      >
        <Show when={m().who}>
          <div class="author" style={{ color: m().who!.color }}>
            {m().who!.name}
            <Show when={m().who!.lead}>
              <span class="lead-tag" style={{ "--c": m().who!.color }}>
                meneur
              </span>
            </Show>
          </div>
        </Show>
        <Show when={m().files?.length}>
          <div class="att">
            <For each={m().files}>{(f) => (f.url ? <img src={f.url} alt={f.name} loading="lazy" /> : <span class="f">{f.name}</span>)}</For>
          </div>
        </Show>
        <Switch>
          <Match when={rp()}>
            <ReplyFrame c={p.c} handle={rp()![1]} excerpt={rp()![2]} onGo={() => p.goQuote(m(), rp()![2])} />
            {rp()![3]}
          </Match>
          <Match when={m().role === "user"}>{m().text}</Match>
          <Match when={true}>
            <MdBody m={m()} />
          </Match>
        </Switch>
      </div>
      <Show when={m().st === "err" && m().retry}>
        <button type="button" class="retry" data-testid="retry" onClick={() => m().retry!()}>
          Pas envoyé · Réessayer
        </button>
      </Show>
      <Show when={long()}>
        <div class="bub-acts">
          <button type="button" class="fold-btn" data-testid="fold" onClick={toggle}>
            {open() ? "Réduire" : "Afficher tout"}
          </button>
        </div>
      </Show>
    </>
  );
}

// ---------- lignes d'action : une ligne cochée « ✓ Lu → fichier », le détail au toucher ----------
function ToolsLine(p: { t: Tools }) {
  const running = () => p.t.items.filter((x) => x.st === "run");
  const failed = () => p.t.items.filter((x) => x.st === "fail").length;
  const line = (x: { name: string; detail: string }) => actionVerb(x.name) + (x.detail ? " → " + actionTarget(x.detail) : "");
  // Une action : « Verbe → cible ». Plusieurs : « N actions · verbes distincts ». En cours : la dernière, suivie de « … ».
  const head = () => {
    const r = running(),
      n = p.t.items.length,
      last = p.t.items[n - 1];
    const one = r.length ? r[r.length - 1] : last;
    if (r.length || n === 1)
      return {
        verb: actionVerb(one.name),
        target: one.detail ? actionTarget(one.detail) : "",
        tail: (r.length ? "…" : "") + (r.length && n > 1 ? " · " + n : ""),
      };
    const verbs = [...new Set(p.t.items.map((x) => actionVerb(x.name)))].slice(0, 4).join(", ");
    return { verb: n + " actions · " + verbs, target: "", tail: failed() ? " · " + failed() + " en échec" : "" };
  };
  return (
    <details class="tools act-line" classList={{ run: running().length > 0, fail: !running().length && failed() > 0 }} data-testid="actions">
      <summary>
        <Show when={!running().length} fallback={<i class="spin" aria-hidden="true" />}>
          <span class="ck" aria-hidden="true">
            {failed() ? "✕" : "✓"}
          </span>
        </Show>
        <span class="v">{head().verb}</span>
        <Show when={head().target}>
          <span class="ar">→</span>
          <code class="tg">{head().target}</code>
        </Show>
        <span>{head().tail}</span>
      </summary>
      <div class="items">
        <For each={p.t.items}>
          {(x) => (
            <details class={"tool " + x.st}>
              <summary>{line(x)}</summary>
              <Show when={x.out}>
                <pre>{x.out}</pre>
              </Show>
            </details>
          )}
        </For>
      </div>
    </details>
  );
}

// ---------- cartes à boutons ----------
function CardView(p: { c: Conv; card: Card }) {
  const k = () => p.card;
  const [more, setMore] = createSignal(false);
  const [picked, setPicked] = createSignal<number[]>([]);
  let other!: HTMLInputElement;
  const run = (choice: string, label?: string) => answerCard(p.c.thread, k().key, choice, label);
  const btn = (b: { c: string; label: string; cls?: string }) => (
    <button type="button" class={b.cls || ""} disabled={k().busy} onClick={() => run(b.c, b.label)}>
      {b.label}
    </button>
  );
  return (
    <div
      class={"approval" + (k().kind === "clarify" ? " clarify" : "") + " card-" + k().kind}
      classList={{ done: !!k().done }}
      data-testid="card"
      data-kind={k().kind}
    >
      <div class="t">
        <Show when={k().kind === "approval"}>
          <IcShield />
        </Show>
        {k().title}
      </div>
      <Show when={k().body}>
        <div class="body">{k().body}</div>
      </Show>
      <Show when={k().sub}>
        <div class="sub">{k().sub}</div>
      </Show>
      <Show when={k().cmd}>
        <pre>{k().cmd}</pre>
      </Show>
      <Show when={k().question}>
        <div class="q" innerHTML={md(k().question!)} />
      </Show>
      <Show
        when={!k().done}
        fallback={
          <div class="a" classList={{ no: /^Refus/.test(k().done || "") }} data-testid="card-done">
            <span class="ck" aria-hidden="true">
              {/^Refus/.test(k().done || "") ? "✕" : "✓"}
            </span>
            {k().done}
          </div>
        }
      >
        <Show
          when={k().kind === "clarify"}
          fallback={
            <div class="btns">
              <For each={k().buttons}>{btn}</For>
              <Show when={k().more?.length}>
                <Show
                  when={more()}
                  fallback={
                    <button type="button" class="more" onClick={() => setMore(true)}>
                      Plus de choix
                    </button>
                  }
                >
                  <For each={k().more}>{btn}</For>
                </Show>
              </Show>
            </div>
          }
        >
          <div class={"btns" + (k().multi ? " multi" : "")}>
            <For each={k().choices}>
              {(ch, i) => (
                <button
                  type="button"
                  disabled={k().busy}
                  class={k().multi ? "opt" : i() === 0 ? "yes" : ""}
                  classList={{ on: picked().includes(i()) }}
                  onClick={() => {
                    if (!k().multi) return run(ch, ch);
                    setPicked(picked().includes(i()) ? picked().filter((x) => x !== i()) : [...picked(), i()]);
                  }}
                >
                  {ch}
                </button>
              )}
            </For>
          </div>
          <form
            class="other"
            onSubmit={(e) => {
              e.preventDefault();
              const t = other.value.trim();
              if (k().multi) {
                const list = [...picked()]
                  .sort()
                  .map((i) => k().choices![i])
                  .concat(t ? [t] : []);
                if (list.length) run(JSON.stringify(list), list.join(", "));
              } else if (t) run(t, t);
            }}
          >
            <input ref={other} type="text" placeholder={k().choices?.length ? "Autre réponse…" : "Ta réponse…"} enterkeyhint="send" disabled={k().busy} />
            <button type="submit" class="yes" disabled={k().busy}>
              {k().multi ? "Valider" : "Envoyer"}
            </button>
          </form>
          <button type="button" class="skip" disabled={k().busy} onClick={() => run("", "passée")}>
            Passer
          </button>
        </Show>
      </Show>
    </div>
  );
}

function TaskView(p: { t: Task }) {
  const failed = () => /^\s*(⚠|\[CRON_FAILURE\])/.test(p.t.body);
  return (
    <details class={"task-card" + (failed() ? " fail" : "")}>
      <summary>
        <span class="tk">{failed() ? "Tâche automatique en échec" : "Tâche automatique"}</span>
        <b>{p.t.name}</b>
      </summary>
      <div class="tb" innerHTML={md(p.t.body.replace(/^\s*\[CRON_FAILURE\]\s*/, ""))} />
    </details>
  );
}
const NoteView = (p: { n: Note }) => (
  <div class={"note" + (p.n.tag ? " " + p.n.tag : "")} data-testid="note">
    {p.n.text}
    <Show when={p.n.action}>
      <button type="button" class="link" onClick={() => p.n.action!.run()}>
        {p.n.action!.label}
      </button>
    </Show>
  </div>
);

// ---------- le fil ----------
export function ThreadView(p: { c: Conv; onChoose: (text: string) => void; footer?: any }) {
  const t = p.c.thread;
  let log!: HTMLElement;
  const [atBottom, setAtBottom] = createSignal(true);
  const [far, setFar] = createSignal(false);
  const [top, setTop] = createSignal(true);
  const start = createMemo(() => Math.max(0, t.items.length - t.win()));
  const visible = createMemo(() => t.items.slice(start()));

  const toBottom = (smooth = false) => requestAnimationFrame(() => log && log.scrollTo({ top: log.scrollHeight, behavior: smooth ? "smooth" : "auto" }));
  // nouveau contenu : on suit le bas si on y était
  createEffect(
    on(
      () => {
        const l = t.items[t.items.length - 1] as any;
        return [t.items.length, l?.text, l?.items?.length, l?.done];
      },
      () => {
        if (untrack(atBottom)) toBottom();
      }
    )
  );
  createEffect(
    on(
      t.stick,
      () => {
        setAtBottom(true);
        toBottom();
      },
      { defer: true }
    )
  );
  // La hauteur change sans défilement (barre du groupe qui apparaît, clavier, dernier élément qui grandit après rendu) :
  // si on était en bas, on y reste.
  const ro = new ResizeObserver(() => {
    if (untrack(atBottom) && log) log.scrollTop = log.scrollHeight;
  });
  let watched: Element | null = null;
  createEffect(
    on(
      () => t.items.length,
      () =>
        queueMicrotask(() => {
          const last = log?.lastElementChild;
          if (last && last !== watched) {
            if (watched) ro.unobserve(watched);
            ro.observe(last);
            watched = last;
          }
        })
    )
  );
  onMount(() => {
    ro.observe(log);
    log.addEventListener("unstick", () => setAtBottom(false));
  });
  onCleanup(() => ro.disconnect());

  // position de lecture par conversation : on rouvre en bas, sauf si on lisait plus haut (clé du premier élément vu)
  const POS = "scroll-pos";
  onMount(() => {
    const pos = store.get<Record<string, any>>(POS, {})[p.c.key];
    requestAnimationFrame(() => {
      if (pos && !pos.bottom && pos.top) log.scrollTop = pos.top;
      else log.scrollTop = log.scrollHeight;
      onScroll();
    });
  });
  let posTimer: any;
  function savePos() {
    clearTimeout(posTimer);
    posTimer = setTimeout(() => {
      const all = store.get<Record<string, any>>(POS, {});
      all[p.c.key] = { top: Math.round(log.scrollTop), bottom: atBottom() };
      store.set(POS, all);
    }, 400);
  }

  // passé : on élargit la fenêtre, puis on demande la page précédente ; la position à l'écran ne bouge pas
  // Les lignes ajoutées au-dessus ont d'abord une taille estimée (content-visibility) qui se corrige sur plusieurs images :
  // la hauteur totale peut s'effondrer (16 786 -> 4 262 px vu sous charge), le navigateur rabat alors scrollTop au bas du fil.
  // On suit donc l'ancre (première ligne visible) image par image tant que la mise en page bouge : seul le déplacement de
  // l'ancre dans le contenu (dc) qui n'a pas déjà été compensé par scrollTop (ds, ancrage natif ou rabat) est corrigé ;
  // un défilement de Yoan change ds sans changer dc, il n'est jamais annulé. Pendant ce temps, « en bas » ne s'allume pas.
  let loading = false,
    gen = 0,
    holding = false;
  async function older() {
    if (loading) return;
    loading = true;
    try {
      const lt = log.getBoundingClientRect().top;
      // ancre = première ligne de message visible (data-key) : le séparateur de jour au-dessus disparaît quand la page précédente
      // arrive le même jour, et « … » reste collé en haut ; ni l'un ni l'autre ne peut servir d'ancre
      const anchor = [...log.querySelectorAll<HTMLElement>(":scope > [data-key]")].find((c) => c.getBoundingClientRect().bottom > lt);
      const off = () => anchor!.getBoundingClientRect().top - log.getBoundingClientRect().top + log.scrollTop;
      const h0 = log.scrollHeight,
        s0 = log.scrollTop;
      let lastOff = anchor ? off() : 0,
        lastTop = s0;
      let grew = t.grow();
      if (!grew && p.c.kind === "bot" && p.c.moreOlder) grew = await loadOlder(p.c);
      if (!grew) return;
      if (!anchor?.isConnected) {
        log.scrollTop = s0 + (log.scrollHeight - h0);
        return;
      }
      const run = ++gen;
      holding = true;
      let quiet = 0,
        frames = 0;
      const keep = () => {
        if (run !== gen) return;
        if (!anchor.isConnected) {
          holding = false;
          return;
        }
        const o = off(),
          dc = o - lastOff,
          ds = log.scrollTop - lastTop;
        if (Math.abs(dc - ds) >= 1 && dc !== 0) log.scrollTop += dc - ds;
        quiet = dc === 0 ? quiet + 1 : 0;
        lastOff = off();
        lastTop = log.scrollTop;
        // la mise en page est stable depuis 10 images (ou 3 s d'images) : on rend la main
        if (quiet >= 10 || ++frames > 180) {
          holding = false;
          onScroll();
          return;
        }
        requestAnimationFrame(keep);
      };
      keep();
    } finally {
      loading = false;
    }
  }
  function onScroll() {
    if (!log) return;
    const gap = log.scrollHeight - log.scrollTop - log.clientHeight;
    if (!holding) setAtBottom(gap < 80);
    setFar(gap > 300);
    setTop(log.scrollTop < 40);
    if (log.scrollTop < 600) older();
    setMenu(null);
    savePos();
  }

  // dernier message de Yoan après chaque bulle à choix (pour figer ses boutons)
  const answerAfter = (key: number) => {
    const items = t.items;
    let i = t.index(key);
    for (i++; i < items.length; i++) {
      const it = items[i];
      if (it.k === "msg" && it.role === "user") return it.text.trim();
    }
    return null;
  };

  // aller à un message (citation, recherche) : élargir la fenêtre jusqu'à lui puis le centrer
  async function reveal(key: number) {
    let i = t.index(key);
    if (i < 0) return false;
    if (i < start()) t.setWin(t.items.length - i + 10);
    await new Promise(requestAnimationFrame);
    const el = log.querySelector(`[data-key="${key}"]`) as HTMLElement | null;
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    t.patch(key, { hl: Date.now() } as any);
    return true;
  }
  createEffect(
    on(
      focusKey,
      (f) => {
        if (f) reveal(f.key);
      },
      { defer: true }
    )
  );
  async function goQuote(from: Msg, excerpt: string) {
    const want = excerpt.replace(/…$/, "");
    const find = () => {
      for (let i = t.index(from.key) - 1; i >= 0; i--) {
        const it = t.items[i];
        if (it.k !== "msg") continue;
        const body = it.role === "user" ? (REPLY_RE.exec(it.text)?.[3] ?? it.text) : it.text;
        const e = replyExcerpt(body).replace(/…$/, "");
        if (e && (e.startsWith(want) || want.startsWith(e))) return it.key;
      }
      return 0;
    };
    let hit = find();
    for (let n = 0; !hit && n < 10 && p.c.kind === "bot" && p.c.moreOlder; n++) {
      await loadOlder(p.c);
      hit = find();
    }
    if (!hit) {
      t.addNote("Message cité introuvable dans l’historique chargé.");
      return;
    }
    showMsg(hit);
  }

  function prevPrompt() {
    const top = log.getBoundingClientRect().top;
    const users = [...log.querySelectorAll(".row.user")].reverse();
    const target = users.find((r) => r.getBoundingClientRect().top < top - 8);
    if (target) target.scrollIntoView({ block: "start", behavior: "smooth" });
    else {
      log.scrollTo({ top: 0, behavior: "smooth" });
      older();
    }
  }

  const memberAv = (m: Msg) => m.who?.profile || m.who?.mid || "";
  const groupHandle = (m: Msg) => (p.c.kind === "room" && m.who ? memberOf(p.c, m.who.mid)?.handle : null);
  void groupHandle;

  return (
    <>
      <main
        class="log"
        ref={log}
        onScroll={onScroll}
        data-testid="thread"
        onClick={(e) => {
          const b = (e.target as HTMLElement).closest(".ui-choice") as HTMLButtonElement | null;
          if (b && !b.disabled && b.dataset.say) {
            for (const x of b.closest(".ui-btns, .ui")?.querySelectorAll<HTMLButtonElement>(".ui-choice") || []) x.disabled = true;
            b.classList.add("chosen");
            p.onChoose(b.dataset.say);
          }
        }}
      >
        <Show when={start() > 0 || (p.c.kind === "bot" && p.c.moreOlder)}>
          <div class="note older">…</div>
        </Show>
        <For each={visible()}>
          {(it, i) => {
            const newDay = () => {
              const j = i();
              const prev = j > 0 ? visible()[j - 1] : t.items[start() - 1];
              return !prev || dayOf(prev) !== dayOf(it);
            };
            return (
              <>
                <Show when={newDay()}>
                  <div class="day">{dayLabel(new Date(toMs(it.ts) || Date.now()))}</div>
                </Show>
                <Switch>
                  <Match when={it.k === "msg" && (it as Msg)}>
                    {(m) => (
                      <div
                        class={"row " + (m().who && m().role === "assistant" ? "member assistant" : m().role)}
                        classList={{ "in-queue": !!m().inQueue, "in-side": !!m().inSide }}
                        data-key={m().key}
                      >
                        <Show when={m().who && m().role === "assistant"}>
                          <Av k={memberAv(m())} s={30} />
                        </Show>
                        <Show when={m().acts?.length}>
                          <ToolsLine t={{ k: "tools", key: m().key, ts: m().ts, items: m().acts! }} />
                        </Show>
                        <Bubble c={p.c} m={m()} answered={() => answerAfter(m().key)} goQuote={goQuote} />
                        <Show when={m().next && p.c.kind === "room"}>
                          <button
                            type="button"
                            class="next-cancel"
                            onClick={() => cancelNext(p.c as GroupConv, m()).catch((e) => t.addNote("Annulation impossible : " + e.message))}
                          >
                            Annuler
                          </button>
                        </Show>
                        <Stamp ts={m().ts} />
                      </div>
                    )}
                  </Match>
                  <Match when={it.k === "tools" && (it as Tools)}>
                    {(x) => (
                      <Show when={x().who} fallback={<ToolsLine t={x()} />}>
                        <div class="row member tools-row" data-key={x().key} data-testid="member-actions">
                          <Av k={x().who!.profile || x().who!.mid} s={30} />
                          <ToolsLine t={x()} />
                          <Show when={x().live && p.c.kind === "room"}>
                            <button
                              type="button"
                              class="stop-bot"
                              data-testid="stop-bot"
                              data-member={x().who!.mid}
                              onClick={(e) => {
                                (e.currentTarget as HTMLButtonElement).disabled = true;
                                stopBot(p.c as GroupConv, x().who!.mid);
                              }}
                            >
                              Arrêter {x().who!.name}
                            </button>
                          </Show>
                        </div>
                      </Show>
                    )}
                  </Match>
                  <Match when={it.k === "card" && (it as Card)}>{(x) => <CardView c={p.c} card={x()} />}</Match>
                  <Match when={it.k === "task" && (it as Task)}>
                    {(x) => (
                      <div class="row task" data-key={x().key}>
                        <TaskView t={x()} />
                        <Stamp ts={x().ts} />
                      </div>
                    )}
                  </Match>
                  <Match when={it.k === "note" && (it as Note)}>{(x) => <NoteView n={x()} />}</Match>
                </Switch>
              </>
            );
          }}
        </For>
        {p.footer}
      </main>
      <div class="jump-anchor">
        <div class="jump">
          <Show when={!top() && t.items.some((x) => x.k === "msg" && x.role === "user")}>
            <button type="button" aria-label="Mon message précédent" onClick={prevPrompt}>
              <IcUp />
            </button>
          </Show>
          <Show when={far()}>
            <button
              type="button"
              aria-label="Aller en bas"
              data-testid="to-bottom"
              onClick={() => {
                setAtBottom(true);
                log.scrollTo({ top: log.scrollHeight, behavior: "smooth" });
              }}
            >
              <IcDown />
            </button>
          </Show>
        </div>
      </div>
    </>
  );
}
export { app };
