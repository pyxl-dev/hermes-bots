// Faux modèle déterministe (API chat completions, compatible OpenAI) pour les parcours SANS MODÈLE du gateway de test.
// Les profils fx-* (test/fixtures/hermes-test/profiles/fx-*) l'appellent sur 127.0.0.1:9329 ; chaque profil porte « FAUX-ID: <id> »
// dans son SOUL.md, et le script de cet id dit quoi répondre. Aucun appel réseau, aucun quota, même réponse à chaque passage.
//   - réponse texte :        { text: "..." }
//   - outil puis réponse :   { tool: { name: "terminal", args: { command: "sleep 3" } }, text: "Madrid" }
//     (premier appel du tour : l'outil ; dès que son résultat suit le dernier message utilisateur : le texte)
//   - réponse retenue :      { hold: "/chemin/porte", ... } : la réponse (l'appel d'outil s'il y en a un, sinon le texte) ne part
//     qu'une fois le fichier créé, 30 s au plus ; garde un bot occupé sans outil (le meneur n'a pas le terminal, ADR 0003)
//   - réponse écrite en direct : { text: "...", streamMs: 150 } : le texte part mot par mot, un morceau toutes les 150 ms
//   - fonction :             (msgs) => Reply   (ex. le meneur ne répartit qu'au message de test, pas quand un membre le cite)
// Tout appel sans FAUX-ID connu (titre de session, résumé...) reçoit « ok ».
import { existsSync } from "node:fs";

export type Msg = { role: string; content?: unknown; tool_calls?: unknown };
export type Reply = { text: string; tool?: { name: string; args: Record<string, unknown> }; hold?: string; streamMs?: number };
export type Script = Reply | ((msgs: Msg[]) => Reply);

export const FAKE_PORT = 9329;
const text = (c: unknown): string => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p?.text ?? "").join("") : "");

export function startFakeModel(scripts: Record<string, Script>, port = FAKE_PORT) {
  const calls: { id: string; kind: "tool" | "text"; said: string }[] = [];
  let closing = false,
    lastCall = Date.now();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "faux-modele", object: "model", owned_by: "test" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("introuvable", { status: 404 });
      const body: any = await req.json();
      const msgs: Msg[] = body.messages || [];
      const id =
        /FAUX-ID: ([\w-]+)/.exec(
          msgs
            .filter((m) => m.role === "system")
            .map((m) => text(m.content))
            .join("\n")
        )?.[1] || "";
      const s = scripts[id];
      lastCall = Date.now();
      const r: Reply = closing ? { text: "fin" } : !s ? { text: "ok" } : typeof s === "function" ? s(msgs) : s;
      // un résultat d'outil ne compte que s'il suit le dernier message utilisateur : la session d'un bot garde ceux des tours passés
      const lastU = msgs.map((m) => m.role).lastIndexOf("user");
      const useTool = !!r.tool && !msgs.slice(lastU + 1).some((m) => m.role === "tool");
      calls.push({ id: id || "?", kind: useTool ? "tool" : "text", said: useTool ? r.tool!.name : r.text.slice(0, 40) });
      if (r.hold && (useTool || !r.tool)) for (let i = 0; i < 300 && !closing && !existsSync(r.hold); i++) await Bun.sleep(100);
      const tc = useTool
        ? [
            {
              index: 0,
              id: "call_" + crypto.randomUUID().slice(0, 8),
              type: "function",
              function: { name: r.tool!.name, arguments: JSON.stringify(r.tool!.args) },
            },
          ]
        : undefined;
      const finish = useTool ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const base = { id: "faux-" + crypto.randomUUID().slice(0, 8), model: body.model || "faux-modele", created: Math.floor(Date.now() / 1000) };
      if (!body.stream) {
        return Response.json({
          ...base,
          object: "chat.completion",
          usage,
          choices: [
            {
              index: 0,
              finish_reason: finish,
              message: { role: "assistant", content: useTool ? null : r.text, ...(tc ? { tool_calls: tc.map(({ index, ...t }) => t) } : {}) },
            },
          ],
        });
      }
      const chunk = (delta: object, fr: string | null, extra: object = {}) =>
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: fr }], ...extra })}\n\n`;
      const tail = chunk({}, finish) + `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage })}\n\ndata: [DONE]\n\n`;
      if (!tc && r.streamMs) {
        // texte mot par mot : ce que le PWA doit montrer en train de s'écrire
        // un morceau ne doit pas commencer par « : » : Hermes le prend pour un commentaire SSE en écho et garde la suite jusqu'au
        // prochain saut de ligne (_provider_stream_text_may_be_sse, sonde du 2026-11-18)
        const words = r.text.split(/(?<= )/),
          enc = new TextEncoder(),
          ms = r.streamMs;
        const stream = new ReadableStream({
          async start(ctl) {
            for (const [i, w] of words.entries()) {
              ctl.enqueue(enc.encode(chunk(i ? { content: w } : { role: "assistant", content: w }, null)));
              if (!closing) await Bun.sleep(ms);
            }
            ctl.enqueue(enc.encode(tail));
            ctl.close();
          },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      const out = chunk({ role: "assistant", ...(tc ? { tool_calls: tc } : { content: r.text }) }, null) + tail;
      return new Response(out, { headers: { "content-type": "text/event-stream" } });
    },
  });
  // settle : fin de parcours. Arrêter net laissait les tours en cours appeler un serveur mort et réessayer longtemps ; le drain du
  // gateway de test suivant les attendait et dépassait 25 s (2026-11-18). Ici, tout appel restant reçoit « fin » sans outil, et le
  // serveur ne s'arrête qu'après `quietMs` sans appel ET sans travail signalé par `busy` (tours du groupe en file ou en cours : la boîte
  // d'envoi du plugin poste encore après le parcours et relance un tour), 25 s au plus.
  const settle = async (busy: () => boolean = () => false, quietMs = 3000, maxMs = 25000) => {
    closing = true;
    const t0 = Date.now();
    let free = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (busy()) free = Date.now();
      if (Date.now() - Math.max(lastCall, free) >= quietMs) break;
      await Bun.sleep(250);
    }
    server.stop(true);
    return Date.now() - t0;
  };
  return { calls, stop: () => server.stop(true), settle };
}

if (import.meta.main) {
  // essai à la main : bun test/fake-model.ts, puis un curl sur 127.0.0.1:9329/v1/chat/completions
  startFakeModel({ "fx-b": { tool: { name: "terminal", args: { command: "sleep 1" } }, text: "Madrid" } });
  console.log(`faux modèle sur http://127.0.0.1:${FAKE_PORT}/v1 (Ctrl-C pour arrêter)`);
}
