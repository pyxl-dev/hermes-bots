// État propre à l'interface : feuilles ouvertes, menu d'un message, recherche dans le fil.
import { createSignal } from "solid-js";
import type { Msg } from "../data/thread";

export type Sheet = null | "newGroup" | "groupSettings" | "tasks" | "bot" | "share";
export const [sheet, setSheet] = createSignal<Sheet>(null);
export const [shareText, setShareText] = createSignal("");
export const [menu, setMenu] = createSignal<Msg | null>(null);
export const [findOpen, setFindOpen] = createSignal(false);
/** Clé du message à montrer (recherche, citation) : le fil élargit sa fenêtre et le centre. */
export const [focusKey, setFocusKey] = createSignal<{ key: number; n: number } | null>(null);
let n = 0;
export const showMsg = (key: number) => setFocusKey({ key, n: ++n });
