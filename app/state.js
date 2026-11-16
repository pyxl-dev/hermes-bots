// @ts-check
import { store } from './store.js';

// État partagé : un seul objet par sujet, jamais de variable réassignée entre modules.

/** Roster, conversation ouverte, groupes. @type {any} */
export const state = { roster: null, bots: [], chat: null, groups: [], group: null };
/** Dernier last_active vu par profil (clé : nom du bot, ou room:<id>). @type {Record<string, any>} */
export const seen = store.get('seen', {});
/** Activité en direct (session.active_list). @type {any} */
export const activity = { bots: {}, rooms: {}, socks: {}, direct: null, busy: false };
/** Réglages synchronisés : épingles, couleur de mes bulles, personnages. @type {any} */
export const prefs = { pinned: [], bubble: null, avatars: {} };
/** Verrou de position de lecture (posé pendant un rendu pour ne pas enregistrer un défilement provoqué). */
export const ui = { posLock: false };
