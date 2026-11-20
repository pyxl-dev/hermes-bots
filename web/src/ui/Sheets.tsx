// Feuilles et pages modales : menu d'un message, partage, nouveau groupe, réglages du groupe, réglages du bot, tâches.
import { For, type JSX, Show, createEffect, createMemo, createSignal, onMount } from "solid-js";
import { app, botName, findBot, isHidden, isPinned, memberName, roster, setApp, setAvatar } from "../data/app";
import { type BotConv, current } from "../data/chat";
import { insertText, startReplyTo } from "../data/composer";
import { conv } from "../data/conv";
import { actionVerb } from "../data/thread";
import {
  type GroupConv,
  can,
  createGroup,
  currentGroup,
  disbandGroup,
  memberOf,
  nameOf,
  pollTasks,
  showWork,
  runningTraces,
  saveGroupSettings,
  seatableBots,
  settingsIds,
  taskCall,
} from "../data/groups";
import { goBot, goHome, goKey, goRoom } from "../data/nav";
import { KINDS, KIND_LABEL, SWATCH, avatarOf, mascot } from "../lib/avatars";
import { store } from "../lib/store";
import { REPLY_RE, newSubId, replyExcerpt } from "../lib/util";
import { Av, GAv } from "./Av";
import { IcBack, IcCopy, IcQuote, IcReply, IcShare, IcSpeak } from "./icons";
import { menu, setMenu, setSheet, shareText, sheet, showMsg } from "./state";

/** <dialog> ouvert en modal tant que le composant vit ; Échap ou fermeture = retour à aucune feuille. */
function Dlg(p: { class: string; children: JSX.Element; testid?: string }) {
  let d!: HTMLDialogElement;
  onMount(() => d.showModal());
  return (
    <dialog ref={d} class={p.class} data-testid={p.testid} onClose={() => setSheet(null)}>
      {p.children}
    </dialog>
  );
}
const close = () => setSheet(null);

// ---------- menu d'un message (appui long) ----------
let speaking: number | null = null;
function speak(key: number, text: string) {
  if (!("speechSynthesis" in window)) return;
  if (speechSynthesis.speaking && speaking === key) {
    speechSynthesis.cancel();
    speaking = null;
    return;
  }
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/[`*_#>|]/g, ""));
  u.lang = "fr-FR";
  const v = speechSynthesis.getVoices().find((x) => /^fr[-_]FR/i.test(x.lang));
  if (v) u.voice = v;
  u.onend = u.onerror = () => {
    if (speaking === key) speaking = null;
  };
  speaking = key;
  speechSynthesis.speak(u);
}
export function MsgMenu() {
  const m = menu;
  const body = () => {
    const t = m()!.text;
    return m()!.role === "user" ? (REPLY_RE.exec(t)?.[3] ?? t) : t;
  };
  const c = () => conv();
  const canReply = () => (c()?.kind === "room" ? !!m()?.who?.mid : !!c());
  const who = () => m()!.who?.name || (m()!.role === "user" ? "Toi" : c()?.kind === "bot" ? botName((c() as BotConv).bot) : "");
  const note = (t: string) => c()?.thread.addNote(t);
  async function act(a: string) {
    const msg = m();
    if (!msg) return;
    const text = body().trim();
    setMenu(null);
    if (a === "copy") {
      try {
        await navigator.clipboard.writeText(text);
        note("Message copié.");
      } catch (e: any) {
        note("Copie impossible : " + e.message);
      }
    } else if (a === "share") {
      try {
        await navigator.share({ text });
      } catch (e: any) {
        if (e.name !== "AbortError") note("Partage impossible : " + e.message);
      }
    } else if (a === "speak") speak(msg.key, text);
    else if (a === "reply") {
      const cv = c();
      if (cv?.kind === "room") {
        const mm = memberOf(cv, msg.who!.mid);
        if (mm?.handle) startReplyTo(mm.handle, text, msg.who!.name, avatarOf(mm.profile || mm.member_id).color);
      } else if (cv) {
        const mine = msg.role === "user";
        startReplyTo(mine ? "toi" : cv.bot.name, text, mine ? "Toi" : botName(cv.bot), mine ? "#8A8A8A" : avatarOf(cv.bot.name).color);
      }
    } else if (a === "quote")
      insertText(
        text
          .split("\n")
          .map((l) => "> " + l)
          .join("\n") + "\n\n"
      );
  }
  const Btn = (p: { a: string; ic: JSX.Element; l: string }) => (
    <button type="button" role="menuitem" data-a={p.a} onClick={() => act(p.a)}>
      <span class="ic">{p.ic}</span>
      <span class="l">{p.l}</span>
    </button>
  );
  return (
    <Show when={m()}>
      <div
        class="msg-menu"
        data-testid="msg-menu"
        onPointerDown={(e) => {
          if (!(e.target as HTMLElement).closest(".mm-sheet")) setMenu(null);
        }}
      >
        <div class="mm-back" />
        <div class="mm-sheet" role="menu">
          <div class="grab" />
          <div class="mm-who">{who()}</div>
          <p class="mm-prev">{body().length > 500 ? body().slice(0, 500) + "…" : body()}</p>
          <div class="mm-grid">
            <Btn a="copy" ic={<IcCopy />} l="Copier" />
            <Show when={"share" in navigator}>
              <Btn a="share" ic={<IcShare />} l="Partager" />
            </Show>
            <Show when={"speechSynthesis" in window}>
              <Btn a="speak" ic={<IcSpeak />} l={"speechSynthesis" in window && speechSynthesis.speaking && speaking === m()!.key ? "Arrêter" : "Lire"} />
            </Show>
            <Show when={canReply()} fallback={<Btn a="quote" ic={<IcQuote />} l="Citer" />}>
              <Btn a="reply" ic={<IcReply />} l="Répondre" />
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
export { replyExcerpt };

// ---------- partage reçu (share_target) : le texte part dans le brouillon de la conversation choisie ----------
export function ShareSheet() {
  const text = shareText;
  const rows = createMemo(() => [
    ...app.groups
      .filter((r) => !r.disbanded_at)
      .map((r) => ({ key: "room:" + r.room_id, label: r.name, kind: "groupe", keys: (r.members || []).map((m: any) => m.profile) })),
    ...app.bots.filter((b) => !isHidden(b)).map((b) => ({ key: b.name, label: botName(b), kind: "", keys: [b.name] })),
  ]);
  const pins = () => app.pinned.map((k) => rows().find((r) => r.key === k)).filter(Boolean) as ReturnType<typeof rows>;
  const rest = () => rows().filter((r) => !isPinned(r.key));
  const dest = (key: string) => {
    const old = store.get<string>("draft:" + key, "") || "";
    store.set("draft:" + key, old.trim() ? old.replace(/\s*$/, "\n\n") + text() : text());
    close();
    goKey(key);
  };
  const av = (r: { kind: string; keys: string[] }, s: number) => (r.kind ? <GAv keys={r.keys} s={s} /> : <Av k={r.keys[0]} s={s} />);
  return (
    <Dlg class="sheet" testid="share">
      <div class="grab" />
      <h3>Partager vers…</h3>
      <pre class="share-text">{text().length > 600 ? text().slice(0, 600) + "…" : text()}</pre>
      <div class="share-list">
        <Show when={pins().length}>
          <h4>Épinglés</h4>
          <div class="shp">
            <For each={pins()}>
              {(r) => (
                <button type="button" onClick={() => dest(r.key)}>
                  {av(r, 62)}
                  <span class="tn">{r.label}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={rest().length}>
          <h4>Tous</h4>
          <For each={rest()}>
            {(r) => (
              <button type="button" class="shr" onClick={() => dest(r.key)}>
                {av(r, 42)}
                <span class="tn">{r.label}</span>
                <span class="k">{r.kind}</span>
              </button>
            )}
          </For>
        </Show>
        <Show when={!rows().length}>
          <p class="msg small">Aucun bot disponible : ouvre l’app, puis repartage.</p>
        </Show>
      </div>
      <p class="hint">Le texte arrive dans le composeur, tu relis avant d’envoyer</p>
      <div class="btns">
        <button type="button" class="pill g" onClick={close}>
          Annuler
        </button>
      </div>
    </Dlg>
  );
}

// ---------- nouveau groupe ----------
export function NewGroupSheet() {
  const creation = newSubId(); // un id par ouverture : une création incertaine se renvoie sans doublon
  const [name, setName] = createSignal("");
  const [picked, setPicked] = createSignal<string[]>([]);
  const [lead, setLead] = createSignal("");
  const [msg, setMsg] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const bots = createMemo(() => seatableBots());
  const leadNow = () => (picked().includes(lead()) ? lead() : picked()[0]);
  async function create() {
    setBusy(true);
    try {
      const r = await createGroup(creation, name().trim(), picked(), leadNow(), setMsg);
      close();
      await goRoom(r.id);
      if (r.warn) currentGroup()?.thread.addNote(r.warn);
    } catch (e: any) {
      setMsg(e.message.startsWith("Donne") || e.message.startsWith("Choisis") ? e.message : "Échec : " + e.message + " (réessayer ne crée pas de doublon)");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dlg class="sheet tall" testid="new-group">
      <div class="grab" />
      <div class="sh-head">
        <h3>Nouveau groupe</h3>
        <button type="button" class="txt-btn" onClick={close}>
          Annuler
        </button>
      </div>
      <input
        class="pillfield"
        type="text"
        placeholder="Nom du groupe"
        aria-label="Nom du groupe"
        autocomplete="off"
        maxlength="80"
        value={name()}
        onInput={(e) => setName(e.currentTarget.value)}
      />
      <div class="cap row-cap">
        <span>Membres</span>
        <span>
          {picked().length} sur {app.team.max_members} au plus
        </span>
      </div>
      <div class="tiles">
        <For each={bots()}>
          {(b) => {
            const a = () => avatarOf(b.name);
            return (
              <label class="tile" style={{ "--c": a().color }}>
                <span style={{ display: "contents" }} innerHTML={mascot(a().kind, a().color, 58)} />
                <span class="tn">{botName(b)}</span>
                <span class="tick" />
                <input
                  type="checkbox"
                  value={b.name}
                  aria-label={botName(b)}
                  checked={picked().includes(b.name)}
                  onChange={(e) => setPicked(e.currentTarget.checked ? [...picked(), b.name] : picked().filter((x) => x !== b.name))}
                />
              </label>
            );
          }}
        </For>
      </div>
      <Show when={picked().length}>
        <div class="cap row-cap">
          <span>Meneur</span>
          <span>distribue la parole</span>
        </div>
        <div class="lchips" role="radiogroup" aria-label="Meneur">
          <For each={picked()}>
            {(p) => (
              <label class="lchip" style={{ "--c": avatarOf(p).color }}>
                <input type="radio" name="ng-lead" value={p} checked={p === leadNow()} onChange={() => setLead(p)} />
                <span>{findBot(p) ? botName(findBot(p)) : p}</span>
              </label>
            )}
          </For>
        </div>
      </Show>
      <p class="msg small">{msg()}</p>
      <button type="button" class="pill wide" disabled={busy()} onClick={create}>
        Créer le groupe
      </button>
    </Dlg>
  );
}

// ---------- réglages du groupe ----------
export function GroupSettingsSheet() {
  const g = currentGroup()!;
  settingsIds(g); // un id par ouverture : un enregistrement renvoyé ne s'applique pas deux fois
  const ctx = g.gs.context || { purpose: "", notes: "", routing: "everyone", lead_member_id: "" };
  const members = g.gs.room.members || [];
  const [name, setName] = createSignal(g.gs.room.name);
  const [purpose, setPurpose] = createSignal(ctx.purpose || "");
  const [notes, setNotes] = createSignal(ctx.notes || "");
  const [lead, setLead] = createSignal(members.some((m: any) => m.member_id === ctx.lead_member_id) ? ctx.lead_member_id : members[0]?.member_id);
  const canRecreate = can("groups.create") && can("groups.disband") && can("groups.log");
  const current = new Set<string>(members.map((m: any) => m.profile));
  const [picked, setPicked] = createSignal<string[]>([...current]);
  const [msg, setMsg] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  async function save() {
    setBusy(true);
    setMsg("");
    try {
      const r = await saveGroupSettings(
        g,
        name().trim(),
        { purpose: purpose().trim(), notes: notes().trim(), lead_member_id: lead() },
        canRecreate ? picked() : null,
        setMsg
      );
      if (r === "cancel") {
        setMsg("");
        return;
      }
      close();
      if (typeof r === "object" && r.reopen) goRoom(r.reopen);
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function disband() {
    setBusy(true);
    try {
      if (await disbandGroup(g)) {
        close();
        goHome();
      }
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dlg class="page" testid="group-settings">
      <header class="bar">
        <button class="icon-btn" type="button" aria-label="Retour" onClick={close}>
          <IcBack />
        </button>
        <h1>Réglages du groupe</h1>
      </header>
      <div class="page-body">
        <label class="fld">
          Nom
          <input
            type="text"
            maxlength="80"
            autocomplete="off"
            value={name()}
            disabled={!can("groups.rename")}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>
        <label class="fld">
          But du groupe
          <textarea
            rows="2"
            maxlength="500"
            placeholder="Ce que ce groupe doit faire"
            value={purpose()}
            disabled={!can("groups.context")}
            onInput={(e) => setPurpose(e.currentTarget.value)}
          />
        </label>
        <label class="fld">
          Notes partagées
          <textarea
            rows="3"
            placeholder="Ce que chaque bot doit savoir"
            value={notes()}
            disabled={!can("groups.context")}
            onInput={(e) => setNotes(e.currentTarget.value)}
          />
        </label>
        <label class="fld">
          Meneur (distribue la parole)
          <select value={lead()} disabled={!can("groups.context")} onChange={(e) => setLead(e.currentTarget.value)} aria-label="Meneur">
            <For each={members}>{(m: any) => <option value={m.member_id}>{memberName(m)}</option>}</For>
          </select>
        </label>
        <Show when={canRecreate}>
          <div class="fld">
            Membres
            <div class="picks">
              <For each={seatableBots([...current])}>
                {(b) => (
                  <label class="pick">
                    <Av k={b.name} s={36} />
                    <span class="nm">{botName(b)}</span>
                    <input
                      type="checkbox"
                      value={b.name}
                      checked={picked().includes(b.name)}
                      onChange={(e) => setPicked(e.currentTarget.checked ? [...picked(), b.name] : picked().filter((x) => x !== b.name))}
                    />
                  </label>
                )}
              </For>
            </div>
            <span class="small">Changer les membres recrée le groupe : but, notes et routage sont recopiés, avec un résumé des derniers échanges.</span>
          </div>
        </Show>
        <p class="msg small left">{msg()}</p>
      </div>
      <div class="page-foot">
        <button type="button" class="pill wide" disabled={busy()} onClick={save}>
          Enregistrer
        </button>
        <Show when={can("groups.disband")}>
          <button type="button" class="danger-link" disabled={busy()} onClick={disband}>
            Supprimer le groupe
          </button>
        </Show>
      </div>
    </Dlg>
  );
}

// ---------- réglages du bot : nom affiché, personnage, tâches planifiées ----------
function inWords(iso: string) {
  const t = Date.parse(iso || "");
  if (!t) return "";
  const d = t - Date.now(),
    a = Math.abs(d),
    m = 60000,
    h = 60 * m,
    j = 24 * h;
  const n = a < h ? `${Math.max(1, Math.round(a / m))} min` : a < j ? `${Math.round(a / h)} h` : `${Math.round(a / j)} j`;
  return d >= 0 ? `dans ${n}` : `il y a ${n}`;
}
function CronRow(p: { bot: any; job: any; onErr: (t: string) => void }) {
  const [job, setJob] = createSignal(p.job);
  const [busy, setBusy] = createSignal(false);
  const on = () => job().enabled !== false && job().state !== "paused";
  const err = () =>
    job().last_status === "error" || job().last_status === "failed" ? job().last_error || job().last_fire_error || "dernier passage en échec" : "";
  async function toggle() {
    setBusy(true);
    try {
      const r = await roster.gw!.call("cron.manage", { action: on() ? "pause" : "resume", name: job().job_id, profile: p.bot.name }, 30000);
      if (r?.error || r?.success === false) throw new Error(r.error || "refusé");
      setJob({ ...job(), ...(r?.job || {}), enabled: !on(), state: on() ? "paused" : "scheduled" });
    } catch (e: any) {
      p.onErr("Échec : " + e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="cron" classList={{ off: !on(), err: !!err() }}>
      <div class="nm">
        <span class="dot" />
        <span>{job().name || job().job_id}</span>
      </div>
      <button class="sw" role="switch" aria-checked={on()} aria-label="Activer" disabled={busy()} onClick={toggle} />
      <span class="sched">{job().schedule}</span>
      <span class="next">
        {on() ? (job().next_run_at ? "Prochaine : " + inWords(job().next_run_at) : "") : job().state === "completed" ? "terminée" : "en pause"}
      </span>
      <Show when={err()}>
        <span class="lasterr">{String(err()).slice(0, 200)}</span>
      </Show>
    </div>
  );
}
export function BotSheet() {
  const c = current()!;
  const bot = c.bot;
  const [draft, setDraft] = createSignal({ ...avatarOf(bot.name) });
  const [title, setTitle] = createSignal(botName(bot));
  const [msg, setMsg] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [jobs, setJobs] = createSignal<any[] | null>(null);
  const [cronErr, setCronErr] = createSignal("");
  const [prof, setProf] = createSignal<any>(null);
  onMount(() => roster.gw!.call("profiles.describe", { name: bot.name }, 15000).then(setProf, (e) => setProf({ error: e.message })));
  // fichiers touchés : tirés des actions du fil (lu, écrit, modifié), le plus récent d'abord
  const files = createMemo(() => {
    const seen = new Map<string, { path: string; verb: string }>();
    for (const it of c.thread.items)
      if (it.k === "tools")
        for (const r of it.items) {
          const verb = actionVerb(r.name);
          if (!/^(Lu|Écrit|Modifié)$/.test(verb)) continue;
          const path = (r.detail || "").trim().split(/\s/)[0];
          if (!path || !/[./]/.test(path)) continue;
          seen.delete(path);
          seen.set(path, { path, verb });
        }
    return [...seen.values()].reverse().slice(0, 30);
  });
  onMount(async () => {
    try {
      const r = await roster.gw!.call("cron.manage", { action: "list", include_disabled: true, profile: bot.name }, 30000);
      if (r?.error) throw new Error(r.error);
      let list = r?.jobs || [];
      if (r?.scoped !== bot.name) list = list.filter((j: any) => (j.name || "").startsWith(`[bot:${bot.name}]`)); // ancien gateway : magasin commun
      setJobs(list.sort((a: any, b: any) => (Date.parse(a.next_run_at) || 9e15) - (Date.parse(b.next_run_at) || 9e15)));
    } catch (e: any) {
      setCronErr("Impossible de lire les tâches : " + e.message);
      setJobs([]);
    }
  });
  async function saveName(t: string) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = (await roster.gw!.call("profiles.list", { include_sessions: false })).profiles?.find((x: any) => x.name === bot.name) || bot;
      const meta = { ...(fresh.ui_meta?.["hermes-bots"] || {}), title: t };
      const params: any = { name: bot.name, ui_meta: { "hermes-bots": meta } };
      const rev = fresh.ui_meta_revisions?.["hermes-bots"];
      if (Number.isInteger(rev)) params.ui_meta_expected_revisions = { "hermes-bots": rev };
      const r = await roster.gw!.call("profiles.configure", params, 30000);
      if (r?.applied?.ui_meta_conflicts) continue; // modifié ailleurs entre-temps : on relit et on réessaie une fois
      if (r?.applied && r.applied.ui_meta === false) throw new Error("le gateway n’a pas enregistré le nom");
      const ui_meta = { ...(bot.ui_meta || {}), "hermes-bots": meta };
      const i = app.bots.findIndex((b) => b.name === bot.name);
      if (i >= 0) setApp("bots", i, "ui_meta", ui_meta);
      c.bot = app.bots[i] || { ...bot, ui_meta };
      store.set("roster-cache", app.bots);
      return;
    }
    throw new Error("modifié ailleurs en même temps, réessaie");
  }
  async function save() {
    const cur = avatarOf(bot.name),
      d = draft();
    if (d.color !== cur.color || d.kind !== cur.kind) setAvatar(bot.name, { ...d });
    const t = title().trim();
    if (!t) return setMsg("Le nom ne peut pas être vide.");
    if (t !== botName(bot)) {
      setBusy(true);
      setMsg("Enregistrement…");
      try {
        await saveName(t);
      } catch (e: any) {
        setMsg("Échec : " + e.message);
        return;
      } finally {
        setBusy(false);
      }
    }
    close();
  }
  return (
    <Dlg class="page" testid="bot-sheet">
      <div class="page-body">
        <div class="hero" style={{ "--c": draft().color }}>
          <button class="icon-btn" type="button" aria-label="Retour" onClick={close}>
            <IcBack />
          </button>
          <span class="hero-av" innerHTML={mascot(draft().kind, draft().color, 92, { key: bot.name })} />
        </div>
        <div class="hero-t">
          <h1>{title() || botName(bot)}</h1>
          <div class="sub">
            profil technique <span>{bot.name}</span>
          </div>
          <div class="pills">
            <Show when={bot.model}>
              <span>{bot.model}</span>
            </Show>
          </div>
        </div>
        <label class="fld">
          Nom affiché
          <input type="text" maxlength="60" autocomplete="off" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} />
        </label>
        <h2 class="sect">Personnaliser</h2>
        <div class="card pad">
          <div class="colors" role="radiogroup" aria-label="Couleur">
            <For each={SWATCH}>
              {(x) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={x === draft().color}
                  aria-label={"Couleur " + x}
                  style={{ background: x }}
                  onClick={() => setDraft({ ...draft(), color: x })}
                />
              )}
            </For>
          </div>
          <div class="kinds" role="radiogroup" aria-label="Personnage">
            <For each={[...KINDS]}>
              {(k) => (
                <button
                  type="button"
                  role="radio"
                  aria-checked={k === draft().kind}
                  aria-label={KIND_LABEL[k]}
                  onClick={() => setDraft({ ...draft(), kind: k })}
                  innerHTML={mascot(k, draft().color, 40, { st: "still" })}
                />
              )}
            </For>
          </div>
        </div>
        <h2 class="sect">Fichiers touchés</h2>
        <div class="card pad files" data-testid="bot-files">
          <For each={files()} fallback={<p class="msg small">Aucun fichier lu ou écrit dans ce fil.</p>}>
            {(f) => (
              <div class="file-row">
                <span class="v">{f.verb}</span>
                <code>{f.path}</code>
              </div>
            )}
          </For>
        </div>
        <h2 class="sect">Profil</h2>
        <div class="card pad prof" data-testid="bot-profile">
          <Show when={prof()} fallback={<p class="msg small">Chargement…</p>}>
            <Show when={!prof().error} fallback={<p class="msg small">Profil illisible : {prof().error}</p>}>
              <Show when={prof().description}>
                <p>{prof().description}</p>
              </Show>
              <div class="kv">
                <span>Modèle</span>
                <b>{prof().model?.default || "?"}</b>
              </div>
              <div class="kv">
                <span>Compétences</span>
                <b>
                  {(prof().skills || [])
                    .filter((s: any) => s.enabled)
                    .map((s: any) => s.name)
                    .join(", ") || "aucune"}
                </b>
              </div>
              <div class="kv">
                <span>Connecteurs</span>
                <b>
                  {(prof().mcp_servers || [])
                    .filter((s: any) => s.enabled)
                    .map((s: any) => s.name)
                    .join(", ") || "aucun"}
                </b>
              </div>
              <Show when={prof().soul}>
                <details class="soul">
                  <summary>Personnalité (SOUL.md)</summary>
                  <pre>{prof().soul}</pre>
                </details>
              </Show>
            </Show>
          </Show>
        </div>
        <h2 class="sect">Tâches planifiées</h2>
        <div class="cron-list">
          <Show when={jobs()} fallback={<p class="msg small">Chargement…</p>}>
            <Show when={cronErr()}>
              <p class="msg small">{cronErr()}</p>
            </Show>
            <Show when={!cronErr() && !jobs()!.length}>
              <p class="msg small">Aucune tâche planifiée.</p>
            </Show>
            <For each={jobs()!}>{(j) => <CronRow bot={bot} job={j} onErr={setMsg} />}</For>
          </Show>
        </div>
        <p class="msg small left">{msg()}</p>
      </div>
      <div class="page-foot">
        <button type="button" class="pill wide" disabled={busy()} onClick={save}>
          Enregistrer
        </button>
      </div>
    </Dlg>
  );
}

// ---------- tableau des tâches du groupe ----------
const COLS = ["todo", "doing", "blocked", "done"] as const;
const TASK_LABEL: Record<string, string> = { todo: "À faire", doing: "En cours", blocked: "Bloquée", done: "Faite" };
const ARCHIVE_S = 7 * 86400;
function ago(sec: number) {
  const s = Math.max(0, Date.now() / 1000 - (sec || 0));
  if (s < 60) return "à l’instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return "hier";
  return new Date(sec * 1000).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}
export function TasksSheet() {
  const g = currentGroup()!;
  const [filter, setFilter] = createSignal("");
  const [archive, setArchive] = createSignal(false);
  const [openCard, setOpenCard] = createSignal("");
  const [msg, setMsg] = createSignal("");
  const [tab, setTab] = createSignal(0);
  let kb!: HTMLDivElement,
    input!: HTMLInputElement,
    dragId = "";
  onMount(() => {
    pollTasks(g);
    if (g.gs.tasks.some((t: any) => t.status === "doing"))
      requestAnimationFrame(() => {
        const d = kb.querySelector<HTMLElement>(".kb-col.doing");
        if (d && kb.scrollWidth > kb.clientWidth) kb.scrollLeft = d.offsetLeft - kb.offsetLeft;
      });
  });
  const tasks = () => g.gs.tasks || [];
  const byId = createMemo(() => new Map(tasks().map((t: any) => [t.id, t])));
  const owners = createMemo(
    () =>
      [
        ...new Set(
          tasks()
            .map((t: any) => t.owner)
            .filter((o: string) => o && o !== "yoan" && o !== "auto")
        ),
      ] as string[]
  );
  createEffect(() => {
    if (filter() && !owners().includes(filter())) setFilter("");
  });
  const shown = () => tasks().filter((t: any) => !filter() || t.owner === filter());
  const now = () => Date.now() / 1000;
  const colItems = (c: string) => {
    let items = shown().filter((t: any) => t.status === c);
    if (c === "done" && !archive()) items = items.filter((t: any) => now() - t.updated <= ARCHIVE_S);
    return items.sort((a: any, b: any) => (c === "done" ? b.updated - a.updated : a.created - b.created));
  };
  const oldDone = () => shown().filter((t: any) => t.status === "done" && now() - t.updated > ARCHIVE_S).length;
  const working = (t: any) => {
    const m = memberOf(g, t.owner);
    if (!m || t.status === "done") return false;
    const ids = [m.member_id, m.profile];
    return (
      (g.gs.driver?.member_activity || []).some((a: any) => ids.includes(a.member_id) && ["running", "stopping"].includes(a.status)) ||
      (g.gs.dispatch || []).some((j: any) => ids.includes(j.bot)) ||
      runningTraces(g, m.member_id).length > 0
    );
  };
  const task = (verb: "update" | "remove" | "add", params: any) => taskCall(g, verb, params).catch((e: any) => setMsg("Échec : " + (e.message || e)));
  const set = (t: any, p: any) => {
    if (p.status) setOpenCard("");
    return task("update", { id: t.id, ...p });
  };
  const remove = (t: any) => {
    const kids = tasks().some((x: any) => x.parent === t.id);
    if (confirm(`Supprimer « ${t.title.slice(0, 60)} »${kids ? " et ses sous-tâches" : ""} ?`)) {
      setOpenCard("");
      task("remove", { id: t.id });
    }
  };
  const add = () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = "";
    setMsg("");
    task("add", { title: v });
  };
  const gotoMessage = (ids: string[]) => {
    const hit = ids
      .map((id) => g.thread.findMsg((m) => m.eid === id))
      .filter(Boolean)
      .pop();
    if (!hit) {
      setMsg("Ce message n’est plus dans l’historique chargé du groupe.");
      return;
    }
    close();
    showMsg(hit.key);
  };
  const open = () => tasks().filter((t: any) => t.status !== "done").length;
  function KCard(p: { t: any }) {
    const t = () => p.t;
    const kids = () => tasks().filter((x: any) => x.parent === t().id);
    const parent = () => t().parent && byId().get(t().parent);
    const msgs = () => [...(t().messages || []), ...(t().source && !(t().messages || []).includes(t().source) ? [t().source] : [])];
    const live = () => working(t());
    return (
      <div
        data-testid="task"
        class={"kb-card " + t().status}
        classList={{ open: openCard() === t().id }}
        draggable={true}
        onDragStart={(e) => {
          dragId = t().id;
          e.dataTransfer?.setData("text/plain", t().id);
          e.currentTarget.classList.add("drag");
        }}
        onDragEnd={(e) => {
          dragId = "";
          e.currentTarget.classList.remove("drag");
        }}
        onClick={(e) => {
          if (!(e.target as HTMLElement).closest("button")) setOpenCard(openCard() === t().id ? "" : t().id);
        }}
      >
        <Show when={parent()}>
          <div class="kb-parent">↳ {parent().title}</div>
        </Show>
        <div class="kb-t">{t().title}</div>
        <div class="kb-m">
          <Show when={t().owner && t().owner !== "yoan" && t().owner !== "auto"}>
            <span class="kb-who">
              <Av k={t().owner} s={18} />
              <span>{nameOf(g, t().owner)}</span>
            </span>
          </Show>
          <Show when={live()}>
            <span class="kb-live">travaille</span>
          </Show>
          <Show when={kids().length}>
            <span>
              {kids().filter((x: any) => x.status === "done").length}/{kids().length} sous-tâches
            </span>
          </Show>
          <span title={"créée " + ago(t().created)}>
            {t().status === "done" ? "faite " : ""}
            {ago(t().status === "done" ? t().updated : t().created)}
          </span>
        </div>
        <Show
          when={t().status === "done" && t().proof}
          fallback={
            <Show when={t().note}>
              <div class="kb-x" classList={{ warn: t().status === "blocked" }}>
                {t().note}
              </div>
            </Show>
          }
        >
          <div class="kb-x">{t().proof}</div>
        </Show>
        <div class="kb-acts">
          <div class="kb-move">
            <For each={COLS.filter((c) => c !== t().status)}>
              {(c) => (
                <button type="button" class="pill s g" data-to={c} onClick={() => set(t(), { status: c })}>
                  {TASK_LABEL[c]}
                </button>
              )}
            </For>
          </div>
          <div class="kb-links">
            <Show when={msgs().length}>
              <button type="button" class="kb-link" data-act="msg" onClick={() => gotoMessage(msgs())}>
                Voir le message{msgs().length > 1 ? `s (${msgs().length})` : ""}
              </button>
            </Show>
            <Show when={memberOf(g, t().owner)}>
              <button
                type="button"
                class="kb-link"
                onClick={() => {
                  const m = memberOf(g, t().owner);
                  close();
                  showWork(g, m.member_id);
                }}
              >
                {live() ? "Suivre son travail" : "Voir son travail"}
              </button>
            </Show>
            <button type="button" class="kb-link danger" onClick={() => remove(t())}>
              Supprimer
            </button>
          </div>
        </div>
      </div>
    );
  }
  return (
    <Dlg class="page" testid="tasks">
      <header class="bar">
        <button class="icon-btn" type="button" aria-label="Retour" data-testid="tasks-close" onClick={close}>
          <IcBack />
        </button>
        <div class="who">
          <div class="name">Tâches du groupe</div>
          <div class="sub">
            {open()} ouverte{open() > 1 ? "s" : ""} · {tasks().length - open()} faite{tasks().length - open() > 1 ? "s" : ""}
          </div>
        </div>
      </header>
      <div class="page-body">
        <Show when={owners().length >= 2}>
          <div class="kb-filter">
            <For each={[["", "Tous"], ...owners().map((o) => [o, nameOf(g, o)])]}>
              {([v, l]) => (
                <button type="button" class="kb-chip" classList={{ on: filter() === v }} onClick={() => setFilter(v)}>
                  {l}
                </button>
              )}
            </For>
          </div>
        </Show>
        <div class="tk-list">
          <div class="kb-tabs">
            <For each={[...COLS]}>
              {(c, i) => (
                <button
                  type="button"
                  classList={{ on: tab() === i() }}
                  onClick={() => {
                    const col = kb.querySelector<HTMLElement>(".kb-col." + c);
                    if (col) kb.scrollTo({ left: col.offsetLeft - kb.offsetLeft, behavior: "smooth" });
                  }}
                >
                  {TASK_LABEL[c]} <span>{colItems(c).length}</span>
                </button>
              )}
            </For>
          </div>
          <div
            class="kb"
            ref={kb}
            onScroll={() => setTab(Math.min(COLS.length - 1, Math.round(kb.scrollLeft / Math.max(1, (kb.firstElementChild as HTMLElement).offsetWidth + 12))))}
          >
            <For each={[...COLS]}>
              {(c) => (
                <section
                  class={"kb-col " + c}
                  data-col={c}
                  onDragOver={(e) => {
                    if (dragId) {
                      e.preventDefault();
                      e.currentTarget.classList.add("over");
                    }
                  }}
                  onDragLeave={(e) => e.currentTarget.classList.remove("over")}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.currentTarget.classList.remove("over");
                    const t = byId().get(dragId);
                    if (t && t.status !== c) set(t, { status: c });
                  }}
                >
                  <h3 class="kb-h">
                    <span>{TASK_LABEL[c]}</span>
                    <span class="kb-n">{colItems(c).length}</span>
                  </h3>
                  <div class="kb-items">
                    <For
                      each={colItems(c)}
                      fallback={<p class="kb-empty">{c === "todo" && !tasks().length ? "Le meneur inscrit ici tes demandes de travail." : "Rien ici."}</p>}
                    >
                      {(t) => <KCard t={t} />}
                    </For>
                  </div>
                  <Show when={c === "done" && oldDone()}>
                    <button type="button" class="kb-link kb-arch" onClick={() => setArchive(!archive())}>
                      {archive() ? "Masquer les archives" : `Archives (${oldDone()})`}
                    </button>
                  </Show>
                </section>
              )}
            </For>
          </div>
        </div>
        <p class="msg small left">{msg()}</p>
      </div>
      <div class="page-foot tk-foot">
        <div class="tk-addrow">
          <input
            ref={input}
            data-testid="task-new"
            type="text"
            maxlength="300"
            placeholder="Ajouter une tâche"
            autocomplete="off"
            enterkeyhint="done"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
          />
          <button class="pill s" type="button" data-testid="task-add" onClick={add}>
            Ajouter
          </button>
        </div>
      </div>
    </Dlg>
  );
}

export function Sheets() {
  return (
    <>
      <MsgMenu />
      <Show when={sheet() === "share"}>
        <ShareSheet />
      </Show>
      <Show when={sheet() === "newGroup"}>
        <NewGroupSheet />
      </Show>
      <Show when={sheet() === "groupSettings" && currentGroup()}>
        <GroupSettingsSheet />
      </Show>
      <Show when={sheet() === "bot" && current()}>
        <BotSheet />
      </Show>
      <Show when={sheet() === "tasks" && currentGroup()}>
        <TasksSheet />
      </Show>
    </>
  );
}
export { goBot };
