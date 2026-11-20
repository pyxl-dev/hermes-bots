// Tour en direct : ce qu'un bot écrit et fait pendant un tour, posé dans le fil. Un seul module pour la conversation
// seule (événements poussés par la session : morceaux de texte) et pour le groupe (fils relevés par le plugin : texte
// complet à chaque relevé), pour que la parité tienne par construction (CLAUDE.md, 2026-11-18).
// Règles : le texte s'écrit dans une bulle qui défile ; un outil fige cette bulle (texte d'avant les outils) et se range
// dans le bloc de lignes d'action courant ; un texte entre deux outils ouvre un nouveau bloc ; la fin fige tout.
import type { Msg, Thread, ToolRun, Who } from "./thread";

export type TurnStatus = { streaming?: boolean; tool?: string };
export type TurnOpts = {
  /** auteur des bulles et des blocs (groupe) ; absent en conversation seule */
  who?: Who;
  /** fil du plugin auquel rattacher les blocs (groupe) */
  trace?: string;
  /** bulles sans liens actifs (groupe) */
  inert?: boolean;
  /** une fin d'outil inconnue de ce tour peut compléter une ligne déjà dans le fil (reprise de conversation seule) */
  adopt?: boolean;
  /** statut du bot : texte qui arrive, outil en cours */
  onStatus?: (s: TurnStatus) => void;
  /** cadence de l'écriture progressive d'un texte relevé (requestAnimationFrame par défaut) */
  frame?: (f: () => void) => void;
};

const same = (a?: string, b?: string) => String(a || "").trim() === String(b || "").trim();

export class LiveTurn {
  /** bulle en cours d'écriture, 0 si aucune */
  bubble = 0;
  /** dernière bulle scellée en texte intermédiaire (une réponse peut y être déjà toute entière) */
  lastSeg = 0;
  /** dernière bulle de texte de ce tour, en cours ou scellée */
  lastText = 0;
  private block = 0;
  private blocks: number[] = [];
  private tools = new Map<string, number>();
  private reply: string | null = null;
  private target = "";
  private typing = false;
  private sealed = new Set<string>();
  private ended = false;

  constructor(
    private t: Thread,
    private o: TurnOpts = {}
  ) {}

  /** Morceau de texte à ajouter (conversation seule). */
  append(chunk: string) {
    if (!chunk) return;
    const m = this.open();
    this.t.patch(m.key, { text: m.text + chunk });
  }

  /** Texte complet relevé (groupe) : une autre réponse du modèle fige la précédente ; une réponse figée ne bouge plus. */
  snapshot(text: string, reply: string) {
    if (reply !== this.reply) {
      this.seal(true);
      this.reply = reply;
    } else if (!this.bubble) return;
    this.open();
    this.target = text;
    this.pace();
  }

  /** Texte intermédiaire lu après coup dans le fil (groupe) : posé seulement s'il n'est pas déjà affiché. */
  segment(text: string) {
    const s = String(text || "").trim();
    if (!s) return;
    if (this.sealed.delete(s)) return;
    const cur = this.bubble && (this.t.get(this.bubble) as Msg | undefined);
    if (cur && (same(cur.text, s) || same(this.target, s))) return; // déjà dans la bulle en direct
    this.block = 0;
    this.lastText = this.t.addMsg("assistant", s, this.msgOpts()).key;
  }

  /** La bulle en cours est finie ; keep : elle peut contenir la réponse (fin de message), sinon c'est un texte d'avant les outils. */
  seal(keep = true): Msg | undefined {
    const m = this.bubble ? (this.t.get(this.bubble) as Msg | undefined) : undefined;
    if (m) {
      if (this.typing && this.target) this.t.patch(m.key, { text: this.target });
      this.t.patch(m.key, { stream: false });
      const s = (this.t.get(m.key) as Msg).text.trim();
      if (s) this.sealed.add(s);
    }
    if (m) this.lastSeg = keep ? m.key : 0; // sans bulle en cours, le texte scellé avant reste la dernière réponse possible
    this.bubble = 0;
    this.target = "";
    this.typing = false;
    this.o.onStatus?.({ streaming: false });
    return m;
  }

  /** Outil qui commence ou finit : rangé dans le bloc courant ; une fin ne garde que les champs qu'elle apporte. */
  tool(run: ToolRun) {
    if (run.st === "run") this.seal(false);
    const known = this.tools.get(run.id);
    const item = known && (this.t.get(known) as any);
    const old: ToolRun | undefined = item?.items?.find((x: ToolRun) => x.id === run.id);
    const next: ToolRun = old ? { ...old, ...Object.fromEntries(Object.entries(run).filter(([, v]) => v !== "" && v !== undefined)) } : run;
    if (old) this.t.putTool(known!, next);
    else if (!(this.o.adopt && run.st !== "run" && this.t.setTool(run.id, next))) {
      if (!this.block || !this.t.get(this.block)) {
        this.block = this.o.who ? this.t.addToolsBlock(this.o.who, this.o.trace).key : this.t.addTools().key;
        this.blocks.push(this.block);
      }
      this.t.putTool(this.block, next);
      this.tools.set(run.id, this.block);
    }
    this.o.onStatus?.({ tool: next.st === "run" ? next.name || "outil" : "" });
  }

  /** Identifiants des outils encore en cours (le plugin complète leur état au relevé suivant). */
  running(): string[] {
    const ids: string[] = [];
    for (const [id, key] of this.tools) {
      const r = (this.t.get(key) as any)?.items?.find((x: ToolRun) => x.id === id);
      if (r?.st === "run") ids.push(id);
    }
    return ids;
  }

  /** Fin du tour : la bulle se fige, les blocs ne sont plus en direct. Renvoie la bulle de texte en cours, s'il y en avait une. */
  end(): Msg | undefined {
    const m = this.bubble ? this.seal(true) : undefined;
    if (!this.ended) for (const k of this.blocks) this.t.patch(k, { live: false } as any);
    this.ended = true;
    this.o.onStatus?.({ streaming: false, tool: "" });
    return m;
  }

  private msgOpts(): Partial<Msg> {
    return { ...(this.o.inert ? { inert: true } : {}), ...(this.o.who ? { who: this.o.who } : {}) };
  }
  private open(): Msg {
    const cur = this.bubble && (this.t.get(this.bubble) as Msg | undefined);
    if (cur) return cur;
    this.block = 0;
    const m = this.t.addMsg("assistant", "", { stream: true, ...this.msgOpts() });
    this.bubble = this.lastText = m.key;
    this.o.onStatus?.({ streaming: true, tool: "" });
    return m;
  }
  /** Le texte relevé apparaît en continu entre deux relevés au lieu de sauter par paquets. */
  private pace() {
    if (this.typing) return;
    this.typing = true;
    const frame = this.o.frame || ((f: () => void) => requestAnimationFrame(f));
    const step = () => {
      const m = this.bubble ? (this.t.get(this.bubble) as Msg | undefined) : undefined;
      if (!this.typing || !m) return void (this.typing = false);
      const want = this.target,
        cur = m.text || "";
      if (!want.startsWith(cur)) {
        this.t.patch(m.key, { text: want });
        this.typing = false;
        return;
      } // texte corrigé : posé d'un coup
      if (cur.length >= want.length) return void (this.typing = false);
      this.t.patch(m.key, { text: want.slice(0, cur.length + Math.max(3, Math.ceil((want.length - cur.length) / 15))) });
      frame(step);
    };
    frame(step);
  }
}
