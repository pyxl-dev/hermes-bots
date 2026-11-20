// Zone de saisie : envoyer, arrêter (zone vide pendant un tour), recadrer (texte pendant un tour), /q pour après.
// Complétions @ et /, réponse citée, pièces jointes, dictée.
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { type BotConv, completePath, completeSlash, submitBot } from "../data/chat";
import { clearReply, focusReq, replyTo, stage, staged, takeText, text, typed, unstage } from "../data/composer";
import { type GroupConv, can, groupCommands, groupSubmit } from "../data/groups";
import { memberName } from "../data/app";
import { IcMic, IcPlus, IcSend } from "./icons";

type Conv = BotConv | GroupConv;
type Opt = { text: string; display?: string; meta?: string };
const SpeechRec = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
const coarse = () => matchMedia("(pointer: coarse)").matches;

/** Envoi d'un texte tapé (ou d'un bouton de choix) dans la conversation ouverte. */
export function submitText(c: Conv, raw: string) {
  if (c.kind === "room") return groupSubmit(c, raw);
  return submitBot(c, raw);
}

export function Composer(p: { c: Conv }) {
  let input!: HTMLTextAreaElement, file!: HTMLInputElement;
  const [opts, setOpts] = createSignal<Opt[]>([]);
  let tok: { start: number; end: number } | null = null,
    seq = 0,
    timer: any;
  const [dict, setDict] = createSignal<any>(null);

  const busy = () => (p.c.kind === "room" ? p.c.gs.busy : p.c.ui.busy);
  const typing = () => !!text().trim() || (p.c.kind === "bot" && staged().length > 0);
  const stop = () => !typing() && (p.c.kind === "room" ? busy() && can("groups.stop") : busy());
  const label = () => (stop() ? "Arrêter" : busy() ? "Recadrer" : "Envoyer");

  const fit = () => {
    input.style.height = "auto";
    if (input.value) input.style.height = input.scrollHeight + "px";
  };
  createEffect(
    on(text, () => {
      if (input.value !== text()) input.value = text();
      fit();
    })
  );
  createEffect(
    on(
      focusReq,
      () => {
        input.focus();
        const n = input.value.length;
        input.setSelectionRange(n, n);
      },
      { defer: true }
    )
  );

  // ---------- complétions ----------
  const hide = () => {
    setOpts([]);
    tok = null;
  };
  function show(items: Opt[], t: { start: number; end: number }) {
    if (!items.length) return hide();
    tok = t;
    setOpts(items.slice(0, 30));
  }
  function pick(i: number) {
    const it = opts()[i];
    if (!it || !tok) return;
    const ins = it.text + (/[:/]$/.test(it.text) ? "" : " "); // @file: ou un dossier : on continue
    const v = input.value.slice(0, tok.start) + ins + input.value.slice(tok.end);
    const caret = tok.start + ins.length;
    typed(v);
    input.value = v;
    input.setSelectionRange(caret, caret);
    input.focus();
    fit();
    update();
  }
  const groupMembers = (g: GroupConv) => (g.gs.room.members || []).map((m: any) => ({ text: "@" + m.handle, display: "@" + m.handle, meta: memberName(m) }));
  const filt = (rows: Opt[], q: string) => rows.filter((r) => r.text.slice(1).toLowerCase().startsWith(q) || (r.meta || "").toLowerCase().includes(q));
  function update() {
    clearTimeout(timer);
    const pos = input.selectionStart ?? input.value.length,
      head = input.value.slice(0, pos),
      c = p.c;
    if (/^\/[^\n]*$/.test(head)) {
      if (c.kind === "room") {
        const lead = /^\/meneur\s+(@?\S*)$/i.exec(head);
        if (lead) return show(filt(groupMembers(c), lead[1].replace(/^@/, "").toLowerCase()), { start: pos - lead[1].length, end: pos });
        if (/\s/.test(head)) return hide();
        const q = head.slice(1).toLowerCase();
        const items = groupCommands()
          .filter((x) => x.name.startsWith(q))
          .map((x) => ({ text: "/" + x.name, display: "/" + x.name + (x.args ? " " + x.args : ""), meta: x.meta }));
        if (items.length === 1 && items[0].text === head) return hide();
        return show(items, { start: 0, end: pos });
      }
      if (!c.gw) return hide();
      const s = ++seq;
      timer = setTimeout(async () => {
        try {
          const r = await completeSlash(c, head);
          if (s !== seq) return;
          if (r.items.length === 1 && "/" + r.items[0].text === head.trim()) return hide();
          show(r.items, { start: r.start, end: pos });
        } catch {
          if (s === seq) hide();
        }
      }, 120);
      return;
    }
    const m = /(^|\s)(@[^\s@]*)$/.exec(head);
    if (!m) return hide();
    const t = { start: pos - m[2].length, end: pos };
    if (c.kind === "room") return show(filt([...groupMembers(c), { text: "@all", display: "@all", meta: "tout le groupe" }], m[2].slice(1).toLowerCase()), t);
    if (!c.gw) return hide();
    const s = ++seq;
    timer = setTimeout(async () => {
      try {
        const items = await completePath(c, m[2]);
        if (s === seq) show(items, t);
      } catch {
        if (s === seq) hide();
      }
    }, 120);
  }

  // ---------- dictée (Web Speech ; bouton masqué si elle manque) ----------
  function toggleDictation() {
    if (dict()) {
      dict().stop();
      return;
    }
    const base = input.value,
      r = new SpeechRec();
    r.lang = "fr-FR";
    r.interimResults = true;
    r.continuous = false;
    r.onresult = (e: any) => {
      let t = "";
      for (const res of e.results) t += res[0].transcript;
      typed((base && !/\s$/.test(base) ? base + " " : base) + t);
    };
    r.onerror = (e: any) => {
      if (e.error !== "no-speech" && e.error !== "aborted") p.c.thread.addNote("Dictée impossible : " + (e.error === "not-allowed" ? "micro refusé" : e.error));
    };
    r.onend = () => setDict(null);
    try {
      r.start();
    } catch (e: any) {
      p.c.thread.addNote("Dictée impossible : " + e.message);
      return;
    }
    setDict(r);
  }
  onCleanup(() => dict()?.stop());

  function submit(e?: Event) {
    e?.preventDefault();
    hide();
    const raw = takeText().trim();
    fit();
    submitText(p.c, raw);
  }
  return (
    <>
      <Show when={p.c.kind === "bot" && busy() && typing()}>
        <div class="busy-bar">
          <span>Entrée recadre le bot tout de suite · /q met en file pour après</span>
        </div>
      </Show>
      <form class="composer" onSubmit={submit} data-testid="composer">
        <Show when={opts().length}>
          <div class="mention" role="listbox" data-testid="suggest">
            <For each={opts()}>
              {(it, i) => (
                <button type="button" role="option" onPointerDown={(e) => e.preventDefault()} onClick={() => pick(i())}>
                  <span>{it.display || it.text}</span>
                  <Show when={it.meta}>
                    <span class="m">{it.meta}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
        <Show when={replyTo()}>
          {(r) => (
            <div class="reply" style={{ "--c": r().color }} data-testid="reply">
              <div class="rq">
                <b>Réponse à {r().name}</b>
                <span>{r().excerpt.replace(/​/g, "")}</span>
              </div>
              <button
                type="button"
                class="rx"
                aria-label="Annuler la réponse"
                onClick={() => {
                  clearReply();
                  input.focus();
                }}
              >
                ×
              </button>
            </div>
          )}
        </Show>
        <Show when={staged().length}>
          <div class="tray">
            <For each={staged()}>
              {(s, i) => (
                <div class="chip">
                  {s.url ? <img src={s.url} alt={s.file.name} /> : <span class="n">{s.file.name}</span>}
                  <button type="button" class="x" aria-label="Retirer" onClick={() => unstage(i())}>
                    ×
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
        <Show when={p.c.kind === "bot"}>
          <button class="attach" type="button" aria-label="Joindre une image ou un fichier" onClick={() => file.click()}>
            <IcPlus />
          </button>
          <input
            ref={file}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.currentTarget.files?.length) stage(e.currentTarget.files);
              e.currentTarget.value = "";
            }}
          />
        </Show>
        <textarea
          ref={input}
          rows="1"
          placeholder="Message"
          enterkeyhint="send"
          aria-label="Message"
          data-testid="input"
          onInput={(e) => {
            typed(e.currentTarget.value);
            fit();
            update();
          }}
          onClick={update}
          onBlur={() => setTimeout(hide, 150)}
          onPaste={(e) => {
            const f = [...(e.clipboardData?.files || [])];
            if (f.length && p.c.kind === "bot") {
              e.preventDefault();
              stage(f);
            }
          }}
          onKeyDown={(e) => {
            if (opts().length) {
              if (e.key === "Escape") {
                hide();
                e.preventDefault();
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                pick(0);
                e.preventDefault();
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey && !coarse()) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <Show when={SpeechRec && (!typing() || dict())}>
          <button class="mic" classList={{ on: !!dict() }} type="button" aria-label={dict() ? "Arrêter la dictée" : "Dicter"} onClick={toggleDictation}>
            <IcMic />
          </button>
        </Show>
        <button class="send" classList={{ stop: stop() }} type="submit" aria-label={label()} data-testid="send">
          <IcSend />
        </button>
      </form>
    </>
  );
}
