// Personnages : le HTML vient de lib/avatars (chaînes), posé tel quel ; il ne change qu'avec la clé, la taille ou l'état.
import { avatarHtml, groupAvatarHtml } from "../lib/avatars";
import { app } from "../data/app";

export function Av(p: { k: string; s: number; st?: string; ring?: boolean; live?: boolean; class?: string }) {
  // lire app.avatars pour suivre un changement de personnage
  const html = () => {
    void app.avatars[p.k];
    return avatarHtml(p.k, p.s, { st: p.st || "", ring: p.ring, live: p.live });
  };
  return <span class={p.class} style={{ display: "contents" }} innerHTML={html()} />;
}
export function GAv(p: { keys: string[]; s: number; st?: string }) {
  const html = () => {
    for (const k of p.keys) void app.avatars[k];
    return groupAvatarHtml(p.keys, p.s, p.st || "");
  };
  return <span style={{ display: "contents" }} innerHTML={html()} />;
}
