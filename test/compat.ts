// Parcours réels écrits pour l'ancien client : leurs lectures d'état (state.js, groups.js, chat.js, tasks.js) passent par
// la poignée de test du client Solid (window.__bots, ADR 0004). Script posé avant le chargement de la page.
export const COMPAT_INIT = `
localStorage.setItem('bots-test', 'true');
window.__compat = async (name) => {
  for (let i = 0; i < 100 && !window.__bots; i++) await new Promise((r) => setTimeout(r, 50));
  const B = window.__bots;
  const group = () => { const c = B.conv(); if (!c || c.kind !== 'room') return null;
    return { room: c.gs.room, context: c.gs.context, driver: c.gs.driver, busy: c.gs.busy, dispatch: c.gs.dispatch, tasks: c.gs.tasks, events: c.events, conv: c }; };
  const roster = () => ({ call: (m, p, t) => B.roster.gw.call(m, p, t), ws: B.roster.gw && B.roster.gw.ws });
  if (name === 'state') return { state: { get roster() { return roster(); }, get group() { return group(); }, get groups() { return B.app.groups; } } };
  if (name === 'groups' || name === 'tasks') return { ...B.groups, openGroup: (id) => B.goKey('room:' + id), loadGroups: B.groups.loadGroups,
    fastLaneMembers: (g, t) => B.groups.fastLaneMembers(g.conv || { gs: g }, t) };
  if (name === 'chat') return { openBot: (n) => B.goKey(n) };
  throw new Error('module inconnu : ' + name);
};`;
/** Remplace import(new URL('x.js', document.baseURI).href) par la couche de compatibilité. */
export const compat = (src: string) => src.replace(/import\(new URL\('(\w+)\.js', document\.baseURI\)\.href\)/g, "window.__compat('$1')");
