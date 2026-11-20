// Zone de saisie partagée par les bots et les groupes : texte, brouillon par conversation, pièces jointes, réponse citée.
import { createSignal } from "solid-js";
import { store } from "../lib/store";
import { replyExcerpt } from "../lib/util";

export const [text, setText] = createSignal("");
export type Staged = { file: File; img: boolean; url: string | null };
export const [staged, setStaged] = createSignal<Staged[]>([]);
export type ReplyTo = { handle: string; excerpt: string; name: string; color: string };
export const [replyTo, setReplyTo] = createSignal<ReplyTo | null>(null);
/** Demande de focus sur la zone de saisie (compteur lu par la vue). */
export const [focusReq, setFocusReq] = createSignal(0);
export const focusInput = () => setFocusReq(focusReq() + 1);

let draftKey: string | null = null;
export function bindDraft(key: string | null) {
  draftKey = key;
  setText(key ? store.get("draft:" + key, "") || "" : "");
}
export function saveDraft() {
  if (!draftKey) return;
  const v = text();
  if (v.trim()) store.set("draft:" + draftKey, v);
  else store.del("draft:" + draftKey);
}
export function typed(v: string) {
  setText(v);
  saveDraft();
}
/** Vide la zone (message parti) ; le brouillon suit. */
export function takeText() {
  const v = text();
  setText("");
  saveDraft();
  return v;
}
export function insertText(v: string) {
  const cur = text();
  typed(cur ? cur.replace(/\s*$/, "\n\n") + v : v);
  focusInput();
}

export function replyPrefix() {
  const r = replyTo();
  return r ? `> ↩ @${r.handle} : « ${r.excerpt} »\n\n` : "";
}
export const clearReply = () => setReplyTo(null);
export function startReplyTo(handle: string, rawText: string, name: string, color: string) {
  setReplyTo({ handle, excerpt: replyExcerpt(rawText), name, color });
  focusInput();
}
export function stage(files: FileList | File[]) {
  const add = [...files].map((f) => {
    const img = f.type.startsWith("image/") && !/svg|icon/.test(f.type);
    return { file: f, img, url: img ? URL.createObjectURL(f) : null };
  });
  setStaged([...staged(), ...add]);
}
export function unstage(i: number) {
  const s = staged()[i];
  if (s?.url) URL.revokeObjectURL(s.url);
  setStaged(staged().filter((_, k) => k !== i));
}
export function takeStaged() {
  const s = staged();
  setStaged([]);
  return s;
}
