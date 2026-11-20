// Fil d'une conversation : une liste d'éléments (messages, lignes d'action, cartes, notes) dans un store Solid.
// La vue n'en dessine que la fin (fenêtre) ; chaque élément garde sa clé, son rendu markdown est en cache par texte.
import { batch, createSignal } from "solid-js";
import { type SetStoreFunction, createStore } from "solid-js/store";
import { toMs } from "../lib/util";

export type MsgState = "" | "queued" | "outbox" | "steering" | "steered" | "err" | "pending";
export type Who = { name: string; color: string; mid: string; profile: string; lead?: boolean };
export type Att = { url: string | null; name: string };
export type Msg = {
  k: "msg";
  key: number;
  role: "user" | "assistant";
  text: string;
  ts: number;
  stream?: boolean;
  st?: MsgState;
  sub?: string;
  files?: Att[];
  who?: Who;
  eid?: string;
  textKey?: string;
  side?: string;
  next?: string;
  held?: boolean;
  heldKind?: string;
  heldWho?: string;
  wait?: string;
  inQueue?: boolean;
  inSide?: boolean;
  trace?: "has" | "expired" | "";
  acts?: ToolRun[];
  hl?: number;
  err?: boolean;
  rid?: number;
  inert?: boolean;
  retry?: () => void;
};
export type ToolRun = { id: string; name: string; detail: string; st: "run" | "done" | "fail"; out?: string };
export type Tools = { k: "tools"; key: number; ts: number; items: ToolRun[]; who?: Who; trace?: string; live?: boolean };
export type Task = { k: "task"; key: number; name: string; body: string; ts: number };
export type Note = { k: "note"; key: number; text: string; ts: number; tag?: string; action?: { label: string; run: () => void } };
export type Btn = { c: string; label: string; cls?: string };
/** Carte à boutons : accord demandé (approval), question (clarify), confirmation d'une commande (confirm), action de groupe. */
export type Card = {
  k: "card";
  key: number;
  ts: number;
  kind: "approval" | "clarify" | "confirm" | "action";
  id?: string;
  title: string;
  sub?: string;
  body?: string;
  cmd?: string;
  question?: string;
  buttons: Btn[];
  more?: Btn[];
  choices?: string[];
  multi?: boolean;
  done?: string;
  busy?: boolean;
};
export type Item = Msg | Tools | Task | Note | Card;

let seq = 0;
const nextKey = () => ++seq;
const now = () => Date.now() / 1000;
// Fonctions des cartes (réponse aux boutons) : hors du store, par clé.
export const cardRun = new Map<number, (choice: string, extra?: any) => Promise<string | void>>();

export class Thread {
  items: Item[];
  set: SetStoreFunction<{ items: Item[] }>;
  /** nombre d'éléments dessinés depuis la fin (fenêtre) */
  win: () => number;
  setWin: (n: number) => void;
  /** passe à true quand un rendu doit défiler en bas (nouveau message à soi, ouverture) */
  stick: () => number;
  private bump: (n: number) => void;
  constructor() {
    const [s, set] = createStore<{ items: Item[] }>({ items: [] });
    this.set = set;
    Object.defineProperty(this, "items", { get: () => s.items });
    const [win, setWin] = createSignal(WINDOW);
    this.win = win;
    this.setWin = setWin;
    const [stick, bump] = createSignal(0);
    this.stick = stick;
    this.bump = bump;
  }
  scrollDown() {
    this.bump(this.stick() + 1);
  }
  clear() {
    this.set("items", []);
    this.setWin(WINDOW);
  }
  replace(items: Item[]) {
    batch(() => {
      this.set("items", items);
      this.setWin(Math.max(WINDOW, Math.min(this.win(), items.length)));
    });
  }
  private push<T extends Item>(it: T): T {
    this.set("items", this.items.length, it);
    return this.items[this.items.length - 1] as T;
  }
  index(key: number) {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i].key === key) return i;
    return -1;
  }
  get(key: number) {
    const i = this.index(key);
    return i < 0 ? undefined : this.items[i];
  }
  patch(key: number, p: Partial<Item>) {
    const i = this.index(key);
    if (i >= 0) this.set("items", i, p as any);
  }
  remove(key: number) {
    const i = this.index(key);
    if (i >= 0) this.set("items", (a) => [...a.slice(0, i), ...a.slice(i + 1)]);
    cardRun.delete(key);
  }
  last() {
    return this.items[this.items.length - 1];
  }
  findMsg(f: (m: Msg) => boolean): Msg | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.k === "msg" && f(it)) return it;
    }
    return undefined;
  }

  addMsg(role: "user" | "assistant", text: string, o: Partial<Msg> = {}) {
    return this.push<Msg>({ k: "msg", key: nextKey(), role, text: text || "", ts: toMs(o.ts) / 1000 || now(), st: "", ...o } as Msg);
  }
  addTask(name: string, body: string, ts?: number) {
    return this.push<Task>({ k: "task", key: nextKey(), name, body, ts: toMs(ts) / 1000 || now() });
  }
  addNote(text: string, o: Partial<Note> = {}) {
    const n = this.push<Note>({ k: "note", key: nextKey(), text, ts: now(), ...o });
    this.scrollDown();
    return n;
  }
  addCard(c: Omit<Card, "k" | "key" | "ts">, run?: (choice: string, extra?: any) => Promise<string | void>) {
    const it = this.push<Card>({ k: "card", key: nextKey(), ts: now(), ...c });
    if (run) cardRun.set(it.key, run);
    this.scrollDown();
    return it;
  }
  /** Les outils consécutifs se rangent dans un même groupe de lignes d'action. */
  addTool(id: string, name: string, detail: string, st: ToolRun["st"] = "run", out?: string) {
    const last = this.last();
    const run: ToolRun = { id: id || "t" + nextKey(), name: name || "outil", detail: detail || "", st, ...(out ? { out } : {}) };
    if (last?.k === "tools") {
      const i = this.items.length - 1;
      this.set("items", i, "items" as any, (l: ToolRun[]) => [...l, run]);
    } else this.push<Tools>({ k: "tools", key: nextKey(), ts: now(), items: [run] });
    return run.id;
  }
  /** Bloc de lignes d'action vide d'un tour en direct (conversation seule), rempli par clé. */
  addTools() {
    return this.push<Tools>({ k: "tools", key: nextKey(), ts: now(), items: [] });
  }
  /** Lignes d'action d'un membre de groupe (fil en direct) : un bloc à lui, rempli par clé. */
  addToolsBlock(who: Who, trace?: string) {
    return this.push<Tools>({ k: "tools", key: nextKey(), ts: now(), items: [], who, trace, live: true });
  }
  putTool(key: number, run: ToolRun) {
    const i = this.index(key);
    if (i < 0) return false;
    const it = this.items[i] as Tools,
      j = it.items.findIndex((t) => t.id === run.id);
    if (j >= 0) this.set("items", i, "items" as any, j, run as any);
    else this.set("items", i, "items" as any, (l: ToolRun[]) => [...l, run]);
    return true;
  }
  setTool(id: string, p: Partial<ToolRun>) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.k !== "tools") continue;
      const j = it.items.findIndex((t) => t.id === id);
      if (j >= 0) {
        this.set("items", i, "items" as any, j, p as any);
        return true;
      }
    }
    return false;
  }
  /** Élargit la fenêtre vers le passé ; renvoie false si tout est déjà dessiné. */
  grow(n = WINDOW / 2) {
    if (this.win() >= this.items.length) return false;
    this.setWin(Math.min(this.items.length, this.win() + n));
    return true;
  }
}
export const WINDOW = 120;

// ---------- lignes d'action : écrites par l'app depuis le nom de l'outil et son argument (aucun jeton) ----------
const VERB: [RegExp, string][] = [
  [/^(terminal|shell|bash|run_command|exec|process)/, "Commande"],
  [/^(read_file|file_read|view|cat)/, "Lu"],
  [/^(write_file|file_write|create_file)/, "Écrit"],
  [/^(patch|edit|apply_patch|str_replace|file_edit)/, "Modifié"],
  [/^(search_files|grep|glob|find|list_dir|ls)/, "Cherché"],
  [/^(web_search|search)/, "Recherche web"],
  [/^(web_extract|web_fetch|fetch|browser_|browse)/, "Page lue"],
  [/^(delegate|subagent|task$)/, "Délégué"],
  [/^memory/, "Mémoire"],
  [/^(todo|plan)/, "Liste mise à jour"],
  [/^(cron|schedule)/, "Tâche planifiée"],
  [/^(send_message|message|notify)/, "Message envoyé"],
  [/^skill/, "Compétence"],
  [/^(image_generate|image_gen|generate_image)/, "Image créée"],
  [/^(vision|image_analy)/, "Image regardée"],
  [/^(execute_code|python|code_exec)/, "Code exécuté"],
  [/^clarify/, "Question"],
  [/^(mcp_|mcp\.)/, "Outil"],
];
const SEARCHY = /^(search_files|grep|glob|find|list_dir|ls|web_search|search|web_extract|web_fetch|fetch|browser_|browse|read_file|file_read|view)/;
export function actionVerb(name: string) {
  const n = String(name || "").toLowerCase();
  for (const [re, v] of VERB) if (re.test(n)) return v;
  return (name || "outil").replace(/[_.]+/g, " ");
}
export function actionTarget(detail: string) {
  const s = String(detail || "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}
/** Mot du statut en direct : Écrit (texte qui arrive), Cherche (lecture, recherche), Agit (autre outil), Réfléchit. */
export function statusWord(streaming: boolean, runningTool?: string) {
  if (runningTool) return SEARCHY.test(runningTool.toLowerCase()) ? "Cherche" : "Agit";
  return streaming ? "Écrit" : "Réfléchit";
}

/** Répondre à une carte (bouton de la carte, ou action d'une notification) : occupée pendant l'appel, puis réduite à une ligne. */
export async function answerCard(t: Thread, key: number, choice: string, label?: string) {
  const f = cardRun.get(key),
    card = t.items.find((i) => i.key === key) as Card | undefined;
  if (!f || !card || card.busy || card.done) return false;
  t.patch(key, { busy: true } as any);
  try {
    const done = await f(choice, label ?? choice);
    t.patch(key, { busy: false, done: done || "Réponse envoyée" } as any);
    return true;
  } catch (e: any) {
    t.patch(key, { busy: false } as any);
    if (!e?.silent) t.addNote("Échec : " + (e?.message || e));
    return false;
  }
}
