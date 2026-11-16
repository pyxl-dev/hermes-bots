// Faux modèle déterministe (API chat completions, compatible OpenAI) pour les parcours SANS MODÈLE du gateway de test.
// Les profils fx-* (test/fixtures/hermes-test/profiles/fx-*) l'appellent sur 127.0.0.1:9329 ; chaque profil porte « FAUX-ID: <id> »
// dans son SOUL.md, et le script de cet id dit quoi répondre. Aucun appel réseau, aucun quota, même réponse à chaque passage.
//   - réponse texte :        { text: "..." }
//   - outil puis réponse :   { tool: { name: "terminal", args: { command: "sleep 3" } }, text: "Madrid" }
//     (premier appel du tour : l'outil ; dès que son résultat suit le dernier message utilisateur : le texte)
//   - fonction :             (msgs) => Reply   (ex. le meneur ne répartit qu'au message de test, pas quand un membre le cite)
// Tout appel sans FAUX-ID connu (titre de session, résumé...) reçoit « ok ».
export type Msg = { role: string; content?: unknown; tool_calls?: unknown };
export type Reply = { text: string; tool?: { name: string; args: Record<string, unknown> } };
export type Script = Reply | ((msgs: Msg[]) => Reply);

export const FAKE_PORT = 9329;
const text = (c: unknown): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p?.text ?? "").join("") : "";

export function startFakeModel(scripts: Record<string, Script>, port = FAKE_PORT) {
  const calls: { id: string; kind: "tool" | "text"; said: string }[] = [];
  const server = Bun.serve({
    port, hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "faux-modele", object: "model", owned_by: "test" }] });
      if (!url.pathname.endsWith("/chat/completions")) return new Response("introuvable", { status: 404 });
      const body: any = await req.json();
      const msgs: Msg[] = body.messages || [];
      const id = /FAUX-ID: ([\w-]+)/.exec(msgs.filter((m) => m.role === "system").map((m) => text(m.content)).join("\n"))?.[1] || "";
      const s = scripts[id];
      const r: Reply = !s ? { text: "ok" } : typeof s === "function" ? s(msgs) : s;
      // un résultat d'outil ne compte que s'il suit le dernier message utilisateur : la session d'un bot garde ceux des tours passés
      const lastU = msgs.map((m) => m.role).lastIndexOf("user");
      const useTool = !!r.tool && !msgs.slice(lastU + 1).some((m) => m.role === "tool");
      calls.push({ id: id || "?", kind: useTool ? "tool" : "text", said: useTool ? r.tool!.name : r.text.slice(0, 40) });
      const tc = useTool ? [{ index: 0, id: "call_" + crypto.randomUUID().slice(0, 8), type: "function", function: { name: r.tool!.name, arguments: JSON.stringify(r.tool!.args) } }] : undefined;
      const finish = useTool ? "tool_calls" : "stop";
      const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
      const base = { id: "faux-" + crypto.randomUUID().slice(0, 8), model: body.model || "faux-modele", created: Math.floor(Date.now() / 1000) };
      if (!body.stream) {
        return Response.json({ ...base, object: "chat.completion", usage,
          choices: [{ index: 0, finish_reason: finish, message: { role: "assistant", content: useTool ? null : r.text, ...(tc ? { tool_calls: tc.map(({ index, ...t }) => t) } : {}) } }] });
      }
      const chunk = (delta: object, fr: string | null, extra: object = {}) => `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: fr }], ...extra })}\n\n`;
      const out = chunk({ role: "assistant", ...(tc ? { tool_calls: tc } : { content: r.text }) }, null) + chunk({}, finish)
        + `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [], usage })}\n\ndata: [DONE]\n\n`;
      return new Response(out, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { calls, stop: () => server.stop(true) };
}

if (import.meta.main) { // essai à la main : bun test/fake-model.ts, puis un curl sur 127.0.0.1:9329/v1/chat/completions
  startFakeModel({ "fx-b": { tool: { name: "terminal", args: { command: "sleep 1" } }, text: "Madrid" } });
  console.log(`faux modèle sur http://127.0.0.1:${FAKE_PORT}/v1 (Ctrl-C pour arrêter)`);
}
