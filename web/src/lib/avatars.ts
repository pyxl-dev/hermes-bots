// Personnages des bots : une couleur parmi SWATCH et une forme parmi KINDS par bot. Par défaut tirés d'un hash
// stable du nom ; les choix de Yoan (fiche du bot) viennent de app.avatars, synchronisés avec les épingles.
import { app } from "../data/app";

export const SWATCH = ["#FF8E4F", "#8B93FF", "#4FD1A5", "#FF7AB6", "#F5C84B", "#C4C4C4"];
export const KINDS = ["block", "drop", "round", "ghost"] as const;
export type Kind = (typeof KINDS)[number];
export const KIND_LABEL: Record<string, string> = { block: "Robot", drop: "Goutte", round: "Rond", ghost: "Fantôme" };
const EYE = "#0A0A0A";

// FNV-1a : stable d'un appareil à l'autre. Deux sels pour que couleur et forme ne soient pas liées.
function avHash(s: string, salt: string) {
  let h = 2166136261;
  for (const c of salt + s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}
export function avatarOf(key: string): { color: string; kind: Kind } {
  const o = app.avatars[key];
  return {
    color: SWATCH.includes(o?.color) ? o.color : SWATCH[avHash(key, "c") % SWATCH.length],
    kind: (KINDS as readonly string[]).includes(o?.kind) ? o.kind : KINDS[avHash(key, "k") % KINDS.length],
  };
}
const eyes = (inner: string) => `<g class="ey"><g class="bk">${inner}</g></g>`;
function mascotBody(kind: string, c: string) {
  switch (kind) {
    case "drop":
      return `<path d="M32 7c13 0 23 11 23 26 0 14-10 24-23 24S9 47 9 33C9 18 19 7 32 7z" fill="${c}"/>${eyes(`<rect x="23.5" y="27" width="5.5" height="12" rx="2.75" fill="${EYE}"/><rect x="35" y="27" width="5.5" height="12" rx="2.75" fill="${EYE}"/>`)}`;
    case "round":
      return `<circle cx="17" cy="16" r="7" fill="${c}"/><circle cx="47" cy="16" r="7" fill="${c}"/><circle cx="32" cy="35" r="23" fill="${c}"/>${eyes(`<circle cx="25" cy="34" r="4" fill="${EYE}"/><circle cx="39" cy="34" r="4" fill="${EYE}"/>`)}<path d="M28 43q4 3 8 0" stroke="${EYE}" stroke-width="2.6" fill="none" stroke-linecap="round"/>`;
    case "block":
      return `<g class="ant"><rect x="30.5" y="3" width="3" height="9" rx="1.5" fill="${c}"/><circle cx="32" cy="4" r="3.5" fill="${c}"/></g><rect x="9" y="12" width="46" height="45" rx="15" fill="${c}"/><rect x="16" y="26" width="32" height="11" rx="5.5" fill="${EYE}"/>${eyes(`<circle cx="25" cy="31.5" r="2.4" fill="${c}"/><circle cx="39" cy="31.5" r="2.4" fill="${c}"/>`)}`;
    default:
      return `<path d="M10 33a22 22 0 0 1 44 0v23l-7.3-5-7.3 5-7.4-5-7.3 5-7.4-5L10 56z" fill="${c}"/>${eyes(`<rect x="23" y="27" width="6" height="6" rx="3" fill="${EYE}"/><rect x="35" y="27" width="6" height="6" rx="3" fill="${EYE}"/>`)}`;
  }
}
/** État du personnage : idle (flotte, cligne), work (sautille), wait (penche la tête), still (figé). */
export type Mood = "idle" | "work" | "wait" | "still";
export const moodOf = (st?: string): Mood => (st === "working" ? "work" : st === "waiting" ? "wait" : "idle");
export function mascot(kind: string, color: string, s: number, { st = "idle", key = "" }: { st?: string; key?: string } = {}) {
  const h = avHash(key || color + kind, "a");
  return `<svg width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true" class="mascot mc ${st}" style="--d:-${((h % 500) / 100).toFixed(2)}s;--bl:${(4.6 + (h % 4) * 0.7).toFixed(1)}s"><g class="bd">${mascotBody(kind, color)}</g></svg>`;
}
export const actClass = (st?: string) => (st && st !== "idle" ? " act-" + st : "");
/** Avatar rond teinté ; ring = anneau lumineux « travaille ». */
export function avatarHtml(key: string, s: number, { ring = false, st = "", live = false }: { ring?: boolean; st?: string; live?: boolean } = {}) {
  const { color, kind } = avatarOf(key);
  return `<span class="av${ring ? " ring" : ""}${actClass(st)}" style="--c:${color};width:${s}px;height:${s}px">${mascot(kind, color, Math.round(s * 0.68), { key, st: ring ? "work" : moodOf(st) })}${live ? '<span class="live"></span>' : ""}</span>`;
}
/** Avatar de groupe : jusqu'à 2 personnages qui se chevauchent. */
export function groupAvatarHtml(keys: string[], s: number, st = "") {
  const k = Math.round(s * 0.66),
    pos = [
      [0, 0],
      [s - k, s - k],
    ],
    mood = moodOf(st);
  const cells = keys
    .slice(0, 2)
    .map((key, i) => {
      const { color, kind } = avatarOf(key);
      return `<span class="gm" style="--c:${color};left:${pos[i][0]}px;top:${pos[i][1]}px;width:${k}px;height:${k}px">${mascot(kind, color, Math.round(k * 0.74), { key, st: mood })}</span>`;
    })
    .join("");
  return `<span class="gav${actClass(st)}" style="width:${s}px;height:${s}px">${cells}</span>`;
}
export const DOTS = '<span class="tdots" aria-hidden="true"><i></i><i></i><i></i></span>';
