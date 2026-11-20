// Parité du tour en direct (web/src/data/turn.ts) : la même suite de faits, reçue en morceaux (conversation seule,
// événements de session) ou en relevés complets (groupe, trace.live + trace.read), donne le même fil.
// Garde aussi l'ordre : un texte arrivé en direct entre deux outils ouvre un nouveau bloc sous lui (défaut des groupes
// avant la v97 : l'outil suivant tombait dans l'ancien bloc, au-dessus du texte).
import { Thread } from "../web/src/data/thread";
import { LiveTurn } from "../web/src/data/turn";

const sync = (f: () => void) => f();
const shape = (t: Thread) =>
  t.items.map((i: any) =>
    i.k === "msg" ? `msg:${i.text}${i.stream ? "~" : ""}` : i.k === "tools" ? `tools:${i.items.map((r: any) => `${r.name}=${r.st}`).join(",")}` : i.k
  );

// conversation seule : morceaux de texte, outils annoncés puis finis
const bot = new Thread();
const b = new LiveTurn(bot, { frame: sync });
b.append("Je ");
b.append("regarde.");
b.tool({ id: "t1", name: "web_search", detail: "vols", st: "run" });
b.tool({ id: "t1", name: "", detail: "", st: "done" });
b.append("Puis le fichier.");
b.tool({ id: "t2", name: "read_file", detail: "a.md", st: "run" });
b.tool({ id: "t2", name: "", detail: "", st: "done" });
b.append("Voilà la réponse.");
b.end();

// groupe : texte complet à chaque relevé (une réponse du modèle = un id), outils relevés dans le fil
const grp = new Thread();
const who = { name: "Bot", color: "#000", mid: "m1", profile: "p1" };
const g = new LiveTurn(grp, { who, trace: "tr1", inert: true, frame: sync });
g.snapshot("Je", "r1");
g.snapshot("Je regarde.", "r1");
g.tool({ id: "t1", name: "web_search", detail: "vols", st: "run" });
g.segment("Je regarde."); // le fil relit le texte intermédiaire déjà affiché : pas de doublon
g.tool({ id: "t1", name: "web_search", detail: "vols", st: "done" });
g.snapshot("Puis le fichier.", "r2");
g.tool({ id: "t2", name: "read_file", detail: "a.md", st: "run" });
g.tool({ id: "t2", name: "read_file", detail: "a.md", st: "done" });
g.snapshot("Voilà la réponse.", "r3");
g.end();

const want = ["msg:Je regarde.", "tools:web_search=done", "msg:Puis le fichier.", "tools:read_file=done", "msg:Voilà la réponse."];
let fail = 0;
for (const [name, t] of [
  ["conversation seule", bot],
  ["groupe", grp],
] as const) {
  const got = shape(t);
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? "ok" : "ÉCHEC"}  tour en direct (${name}) : ${got.join(" | ")}`);
  if (!ok) fail++;
}
const detail = (bot.items[1] as any).items[0].detail;
if (detail !== "vols") (fail++, console.log(`  ÉCHEC  la fin d'un outil a effacé son argument : « ${detail} »`));
const live = grp.items.filter((i: any) => i.k === "tools" && i.live).length;
if (live) (fail++, console.log(`  ÉCHEC  ${live} bloc(s) encore en direct après la fin du tour`));
process.exit(fail ? 1 : 0);
