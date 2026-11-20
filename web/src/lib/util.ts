// Petits outils sans état partagés par tous les modules.

// Réponse « rien à dire » de Hermes ([SILENT], SILENT, NO_REPLY) : cachée, comme sur le desktop.
const SILENT_RE = /^\s*\[?\s*(silent|no[_ ]reply)\s*\]?\s*$/i;
export const isSilent = (t: unknown) => SILENT_RE.test(String(t || ""));
export const toMs = (t: any): number => (!t ? 0 : t > 1e12 ? +t : t * 1000);
export function when(t: any) {
  const ms = toMs(t);
  if (!ms) return "";
  const d = new Date(ms),
    now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  if (+now - +d < 6 * 864e5) return d.toLocaleDateString("fr-FR", { weekday: "short" });
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}
export const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function asText(v: any): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  if (typeof v === "object") return v.text ?? JSON.stringify(v);
  return String(v);
}

// Tours utilisateur synthétiques (processus terminé, délégation, relance auto...) : le gateway les marque display_kind.
export const SYNTHETIC_KINDS = new Set([
  "hidden",
  "process_complete",
  "async_delegation_complete",
  "auto_continue",
  "model_switch",
  "personality_switch",
  "failed_turn",
]);
export const looksSynthetic = (t: string) => /^\s*\[(IMPORTANT|SYSTEM|Background process|Async)[^\]]{0,40}:/i.test(t);

export const newSubId = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

export async function apiErr(r: Response) {
  let d = "";
  try {
    d = (await r.json()).detail;
  } catch {}
  return new Error(`${r.status}${d ? " " + d : ""}`);
}

/** Remontée d'erreur vers /bots/log (public/report.js, chargé en script classique avant le module). */
export const report = (...a: any[]) => (window as any).reportError?.(...a);

export const vibrate = (ms = 15) => {
  try {
    navigator.vibrate?.(ms);
  } catch {}
};

// Tâche automatique : tour entrant « [Cronjob "nom" output — …] ».
export const TASK_RE = /^\[Cronjob "([^"]*)" output[^\]]*\]\s*([\s\S]*)$/;
// Réponse à un message : « > ↩ @handle : « extrait » » puis une ligne vide.
export const REPLY_RE = /^> ↩ @([A-Za-z0-9][A-Za-z0-9._:-]*) : « (.*) »\n\n([\s\S]*)$/;
export function replyExcerpt(t: string) {
  const s = String(t || "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>|\[\]]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (s.length > 140 ? s.slice(0, 140).replace(/\s\S*$/, "") + "…" : s).replace(/@/g, "@​").replace(/»/g, '"');
}
