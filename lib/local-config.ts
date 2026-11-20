// Réglages propres à une installation, hors du dépôt (public) : ~/.config/hermes-bots/config.json, ou les variables
// d'environnement, qui priment. Sans fichier ni variable, chaque valeur a un défaut local qui marche pour un essai.
//   { "pwaUrl": "https://ton-hote/bots/", "prodOrigin": "https://ton-hote", "pwaService": "label.du.launchagent" }
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LOCAL_DIR = join(homedir(), ".config", "hermes-bots");
const file: Record<string, string> = (() => {
  try {
    return JSON.parse(readFileSync(join(LOCAL_DIR, "config.json"), "utf8"));
  } catch {
    return {};
  }
})();

/** Origine publique de la PWA (notifications Web Push, liens des mentions). */
export const PWA_URL = process.env.PWA_URL || file.pwaUrl || "http://127.0.0.1:9131/bots/";
/** Origine visée par `test/real-journey.ts --target prod`. */
export const PROD_ORIGIN = process.env.PROD_ORIGIN || file.prodOrigin || "http://127.0.0.1:9131";
/** Service launchd à relancer quand `server.ts` change à la livraison ; vide : relance à la main. */
export const PWA_SERVICE = process.env.PWA_SERVICE || file.pwaService || "";
