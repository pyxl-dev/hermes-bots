# Réécriture du client en Solid, remplacement d'un coup

Le client en modules JS sans framework (v76) ne tient plus la fluidité voulue (Yoan, 2026-11-18) : beaucoup de bots et de groupes, des fils de 20 000 messages, du streaming, et l'ergonomie de Grok Bot (accueil épinglés puis récents, lignes d'action, statut du bot, demandes d'accord, deux volets sur grand écran). On réécrit `app/` en Solid (TypeScript, Vite) : réactivité fine sans DOM virtuel, seuls les messages visibles sont dessinés. La réécriture remplace l'app actuelle en une seule release, avec la parité complète des fonctions ; la prod ne change pas tant que le portail de release n'est pas vert. Les groupes passent à une lecture incrémentale de `groups.log` depuis le dernier `seq` connu, avec le même cache IndexedDB que les bots, sans patch de Hermes. Le smoke et les parcours pilotent l'app par l'interface (rôles, `data-testid`, valeurs à l'écran) au lieu d'importer ses modules.

Cibles : fil de 20 000 messages ouvert en moins de 1 s depuis le cache, aucune image de plus de 50 ms pendant le streaming, mêmes cibles en groupe.

## Considered Options

- **Refonte progressive des modules actuels** : moins risquée, écartée par Yoan, qui préfère la solution la plus efficace à long terme.
- **Preact + signals (build bun)** : plus léger à installer, mais la réactivité passe encore par un DOM virtuel au niveau des composants.
- **Svelte + Vite** : réactivité fine aussi ; Solid garde du JSX et TypeScript sans langage de gabarit.
- **Patcher Hermes pour pousser les événements de groupe** : temps réel vrai, mais un patch à rejouer à chaque mise à jour de Hermes.
- **App parallèle sur un autre chemin** : écartée par Yoan au profit d'un remplacement direct.

## Consequences

- Un build (Vite) entre dans la chaîne : `stage` fige la sortie du build, plus `app/` brut ; le service worker liste les fichiers produits par le build.
- Le smoke, `real-journey.ts`, `group-journey.ts` et `tasks-journey.ts` sont réécrits pour piloter l'interface par `data-testid` et rôles ; le bundle ne permet plus d'importer les modules internes depuis la page.
- Les états qu'un parcours ne peut pas provoquer (deux bots en parallèle, file du moteur, fil expiré, drain) passent par une poignée de test étroite, `window.__bots`, posée seulement si `localStorage['bots-test']` vaut `true` avant le chargement. Elle expose l'état de l'app, la conversation ouverte, le roster et les fonctions de groupe ; rien d'autre ne doit s'y ajouter sans un parcours qui en a besoin.
- Le groupe reste en scrutation (incrémentale) : son délai dépend de l'intervalle de lecture, pas d'un événement poussé.
