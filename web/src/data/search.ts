// Recherche globale : un mot cherché dans tous les fils gardés sur le téléphone (bots et groupes), sans réseau.
// Un résultat ouvre la conversation et amène le message à l'écran.
import { createSignal } from "solid-js";
import { idb, rowKey } from "../lib/store";
import { asText, toMs } from "../lib/util";
import { app, botName, memberName } from "./app";
import { conv } from "./conv";
import { goKey } from "./nav";
import { showMsg } from "../ui/state";

export type Hit = { key: string; name: string; who: string; text: string; raw: string; at: number };
const MAX_HITS = 40;
const [hits, setHits] = createSignal<Hit[]>([]);
const [searching, setSearching] = createSignal(false);
export { hits, searching };

/** Extrait autour du mot trouvé (le mot reste lisible même dans un long message). */
function excerpt(text: string, i: number, n: number) {
  const a = Math.max(0, i - 40),
    b = Math.min(text.length, i + n + 80);
  return (a ? "…" : "") + text.slice(a, b).replace(/\s+/g, " ") + (b < text.length ? "…" : "");
}

let seq = 0;
export async function searchAll(raw: string) {
  const q = raw.trim().toLowerCase(),
    s = ++seq;
  if (q.length < 3) {
    setHits([]);
    setSearching(false);
    return;
  }
  setSearching(true);
  const out: Hit[] = [];
  const add = (key: string, name: string, who: string, text: string, ts: any) => {
    const i = text.toLowerCase().indexOf(q);
    if (i < 0) return;
    out.push({ key, name, who, text: excerpt(text, i, q.length), raw: text.slice(0, 120), at: typeof ts === "string" ? Date.parse(ts) || 0 : toMs(ts) });
  };
  const bots = app.bots.map((b) =>
    idb.get(rowKey(b.name)).then((saved) => {
      for (const m of saved?.rows || [])
        if (m.role === "user" || m.role === "assistant")
          add(b.name, botName(b), m.role === "user" ? "Toi" : botName(b), asText(m.text ?? m.content), m.timestamp);
    })
  );
  const rooms = app.groups.map((r) =>
    idb.get("room:" + r.room_id).then((saved) => {
      for (const ev of saved?.events || []) {
        if (ev.kind !== "message.user" && ev.kind !== "message.member") continue;
        const m = ev.kind === "message.member" ? (r.members || []).find((x: any) => x.member_id === ev.actor?.id) : null;
        add("room:" + r.room_id, r.name, ev.kind === "message.user" ? "Toi" : m ? memberName(m) : "Un bot", asText(ev.payload?.text), ev.created_at ?? ev.ts);
      }
    })
  );
  await Promise.all([...bots, ...rooms]);
  if (s !== seq) return;
  setHits(out.sort((a, b) => b.at - a.at).slice(0, MAX_HITS));
  setSearching(false);
}

/** Ouvre la conversation du résultat puis amène ce message à l'écran (attend que le fil soit chargé). */
export async function openHit(h: Hit) {
  await goKey(h.key);
  const head = h.raw.slice(0, 60);
  for (let n = 0; n < 40; n++) {
    const c = conv();
    if (c?.key === h.key) {
      const items = c.thread.items as any[];
      for (let i = items.length - 1; i >= 0; i--)
        if (items[i].k === "msg" && items[i].text.includes(head)) {
          showMsg(items[i].key);
          return true;
        }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}
