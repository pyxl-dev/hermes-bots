# Hermes Bots (PWA)

Client téléphone pour le Bot Mode de Hermes : la liste des bots (profils) et le chat permanent de chacun (session « Bot Chat »), avec streaming, outils, validations de commandes et notifications.

- Servi sur le tailnet, même origine que la webapp Hermes : `https://ton-hote/bots/` (origine posée dans `~/.config/hermes-bots/config.json`, voir `lib/local-config.ts`)
- Auth : le login de la webapp Hermes (cookie). Chaque socket prend un ticket `POST /api/webapp/socket-ticket?socket=gateway[&profile=]` puis parle le JSON-RPC du gateway sur `/api/ws`.
- `bun server.ts` sert `app/` sur 127.0.0.1:9131 ; `tailscale serve --bg --set-path /bots http://127.0.0.1:9131` le publie.
- `bun server.ts status` : actions, échecs (journal `~/.local/state/hermes-bots-pwa/actions.jsonl`) et santé.
- Test local : `bun test/mock-gateway.ts` (faux gateway, ouvrir `/bots/`). Le mock sert aussi un bot « Archive » de 20 000 messages (outils, images), la taille réelle de la Bot Chat de Hermes.

## Livraison : `bun run release`

**Unique chemin vers la prod.** Le serveur ne sert plus la copie de travail mais une version figée.

- `releases/<version>/` : copie figée de `app/` (la version vient de `app/version.js`, `APP_VERSION`).
- `current` : lien vers la version servie sur `/bots/` (la prod). `next` : la candidate, servie sur `/bots-next/` (port 9132, `tailscale serve --bg --set-path /bots-next http://127.0.0.1:9132`). `previous` : l'ancienne prod.
- Chaque version figée a son tag git `release/<version>`.
- `bun server.ts stage` fige `app/` et désigne la candidate ; `bun server.ts promote` la met en prod ; `bun server.ts rollback` remet la précédente (un second rollback revient en avant). Prise d'effet immédiate, sans redémarrage ; chaque commande écrit dans `actions.jsonl` et alerte Hub en cas d'échec.
- `/bots-next/` partage l'origine, le cookie de session et le stockage local de `/bots/` : on peut y vérifier la candidate contre le vrai gateway avant la bascule.

Procédure :

1. Travailler sur une branche, dans un worktree (`git worktree add ../hermes-bots-pwa-work -b ma-branche`), jamais dans la copie servie ; ouvrir une PR brouillon.
2. Incrémenter `APP_VERSION` dans `app/version.js` à chaque changement du client (`sw.js` en tire le nom du cache, `report.js` l'envoie avec chaque erreur). Le script refuse si `app/` change sans nouvelle version.
3. `bun run release` (ou `bun run release N`) enchaîne, et s'arrête au premier échec :
   - `bun run check:fresh` puis `bun run check` : l'instantané des contrats du vrai gateway (`test/fixtures/contracts.json`) est à jour, et chaque appel RPC de `app/` le respecte ;
   - `test/releases.ts` : le vrai `server.ts` dans une copie jetable : stage, `/bots-next/`, promote, rollback sans redémarrage ;
   - `test/client-log.ts` : `POST /bots/log` journalisé, alerte une seule fois par version ;
   - `test/smoke.ts` : deux parties en parallèle (`--part bots|groups`, environ 17 s), Chromium headless sur le mock, parcours de Yoan : ouvrir la conversation de 20 000 messages (limites : 4 s, 3 Mo), ouvrir un bot, envoyer, recevoir, rouvrir, ouvrir un groupe, aucune erreur JavaScript ;
   - puis `gh pr ready`, `gh pr merge --merge`, `git pull --ff-only` dans la copie servie (et `launchctl kickstart` si `server.ts` ou `lib/` a changé) ;
   - `stage` (tag git), contrôle de `/bots-next/`, smoke rejoué sur la version figée, `promote`, contrôle de `/bots/version.js`. Si ce dernier échoue, `rollback` automatique.
4. `bun run release --dry-run` : les contrôles seuls (parcours sur le gateway de test compris), sans merge. `bun run release --stage-only` : merge et version figée, la candidate attend sur `/bots-next/` ; ensuite `bun server.ts promote`.

**Gateway de test** (`bun test/test-gateway.ts start | stop | restart [--hard] | status | reset | ensure`, ADR `docs/adr/0001-gateway-de-test-sur-le-mac.md`) : un second gateway Hermes sur le même Mac, isolé de la prod. `HERMES_HOME=~/.hermes-test`, webapp lié à 127.0.0.1:9320 (prod : 9120, jamais touchée), lancé directement par `hermes gateway run` : jamais `hermes gateway restart/stop`, `launchctl` ni LaunchAgent. Le processus a un `HOME` dont `.hermes` pointe sur `~/.hermes-test`, sans quoi `model-guard` et `bot-groups` (qui codent `~/.hermes` en dur) liraient et écriraient la prod. `reset` recrée `~/.hermes-test` depuis `test/fixtures/hermes-test/` : profils `bots-test`, `chiffres`, `travel-prep`, `visuels` (modèle `deepseek-v4.1-flash`, `model-guard` limité à ce modèle), plugin `bot-groups` lié au dossier `plugins/bot-groups` de ce dépôt, mot de passe du webapp généré dans `~/.hermes-test/webapp-password` (hors dépôt), et la seule clé `OPENCODE_GO_API_KEY` copiée du `.env` de la prod vers les `.env` de test par script, sans jamais l'afficher. Aucun vrai profil, aucune vraie conversation ni mémoire n'est copié. `start` génère au besoin la « Bot Chat » de 20 000 messages (outils, images) du profil par défaut ; `restart` fait un vrai drain (SIGUSR1, comme `hermes gateway restart --yes`), `restart --hard` coupe les tours ; `ensure` (utilisé par `release`) recrée, relie le plugin à ce dépôt et démarre au besoin. Journal : lignes `test_gateway_*` dans `actions.jsonl`, alerte Hub sur chaque échec, `status` les résume. **Les mises à jour de Hermes passent d'abord par ce gateway** : `hermes update`, puis `restart` du gateway de test et les deux parcours ; la prod ne redémarre qu'ensuite, par Yoan.

**Parcours réel** (`bun test/real-journey.ts [--target test|prod] [--path /bots-next/] [--app dossier]`) : par défaut sur le gateway de test, dans un Chromium headless isolé qui se connecte lui-même (mot de passe de `~/.hermes-test`) ; la PWA vient de `app/` de ce dépôt (interception des requêtes `/bots/` et `/bots-next/`), tout le reste va au vrai gateway de test. Ouvre la conversation de 20 000 messages (limites 8 s, 5 Mo ; réouverture sous 400 Ko), puis écrit au seul bot `bots-test` : le modèle doit répondre pour de vrai (une réponse vide ou « No usable credentials » est un échec) et l'échange doit être conservé. `--target prod` : lecture seule sur la prod, dans le navigateur déjà connecté par Yoan (`remote-login serve --target headless`, CDP 127.0.0.1:9334) : liste des bots, ouverture et réouverture de la plus grosse vraie conversation, aucun message envoyé.

**Parcours réel d'un groupe** (`bun test/group-journey.ts [--path /bots-next/] [--app dossier] [--no-restart]`) : uniquement sur le gateway de test (il le redémarre, ce qu'on ne fait jamais à la prod ; il refuse `--cdp` et `--target`). Groupe « Test enchaînement » (meneur `chiffres`, membres `travel-prep` et `visuels`, créé s'il manque), jamais les salons de travail. Le meneur nomme deux bots sans @ : les deux doivent tourner en même temps (`plugin.bot-groups.dispatch.status`) et la barre les afficher ; tout « attend son tour » affiché doit correspondre à une tâche `queued` du moteur ; le gateway de test est redémarré avec drain pendant une tâche parallèle (`test-gateway.ts restart`) et les deux résultats doivent arriver ; aucun tour `failed` sans relance. Parties indépendantes (`--part parallel|fil|immediate|steer|restart`) : `parallel`, `fil` et `immediate` tournent en même temps (chacune son groupe, sous 30 s), puis `restart` seule (elle redémarre le gateway de test). `steer` (profils `fv-*`, faux modèle sur 9333) tourne dans sa propre étape de release, pour que chaque contrôle reste sous 60 s : recadrage du meneur sans @ et d'un bot en coulisse dans leur tour, deux `/q` dont un annulé, la demande suivante part seule après la discussion et la table ronde. Toutes les parties jouent **sans modèle** : chacune a son groupe de profils (`fx-*` pour `parallel`, `fy-*` pour `fil`, `fz-*` pour `restart`) qui appellent le faux modèle déterministe de `test/fake-model.ts`, lancé par le parcours (127.0.0.1:9329, 9330, 9331). Elles prouvent la répartition parallèle, le fil et la survie au redémarrage (reprise, relance, repost) en 15 à 30 s chacune, sans quota. **Verrou** : le gateway de test est partagé par toutes les sessions ; `test/gateway-lock.ts` le réserve à une seule à la fois (`test-gateway.ts` sauf `status`, `real-journey`, `group-journey`, et le portail de `bun run release` jusqu'à sa fin). Une autre session attend son tour, jusqu'à 10 min. Sur le seul gateway de test, des variables d environnement ramènent les relances du plugin à 2 s, sa boucle de reprise à 3 s (`BOT_GROUPS_SWEEP_S`), et coupent le frein anti-boucle de Hermes (`HERMES_GATEWAY_MAX_STARTS=0`, sinon 20 s d attente après 7 démarrages en 120 s).

**Parcours du tableau du groupe** (`bun test/tasks-journey.ts`) : gateway de test, **sans modèle** (`fx-meneur`, faux modèle de `test/fake-model.ts`), moins de 15 s. Une demande : le meneur crée une seule tâche, fermée seule à la fin de la discussion avec sa réponse en preuve ; « go » : aucune nouvelle tâche, message rattaché, tâche rouverte puis refermée ; tâche gardée en cours par le meneur : ouverte après la discussion ; kanban à 4 colonnes, carte dans « En cours », « Voir le message » ramène à la bulle ; le meneur appelle le terminal : refusé par le garde (ADR 0003), le refus lui revient. Règles : `plugins/bot-groups/tasks.py`, termes : `GLOSSARY.md`.

**Portail de `bun run release`** : après le smoke, `test-gateway.ts ensure`, `real-journey.ts`, `group-journey.ts` et `tasks-journey.ts` sur le gateway de test sont exigés avant tout merge (`--dry-run` les joue aussi). Si `plugins/bot-groups` est arrivé sur main après le démarrage du gateway de prod, la prod doit recharger le plugin : après le merge, la release le recharge à chaud (`scripts/prod-plugin-reload.ts` : `plugin.bot-groups.reload` par le navigateur connecté à la prod, puis `plugin.bot-groups.health` doit montrer l'empreinte du dossier servi et une seule boucle de fond de chaque sorte), sans redémarrage. Si ce rechargement échoue, la release s'arrête sur « redémarrage prod requis » (code 3, alerte Hub, état dans `~/.local/state/hermes-bots-pwa/release-pending.json`). Yoan redémarre alors le gateway de prod, puis `bun run release --resume` rejoue `GatewayRestartCheck.ts`, fige la version, ouvre en lecture seule la plus grosse conversation de la prod sur `/bots-next/` (`real-journey.ts --target prod`) et bascule. Plugin inchangé : pas d'arrêt, pas de `GatewayRestartCheck`, mais l'ouverture en lecture seule sur la prod reste exigée.

`bun server.ts status` donne les versions (prod, candidate, précédente), le dernier `smoke` et le dernier `release`.

## Client robuste (v55)

- **Cache IndexedDB** (`hermes-bots`, un enregistrement par bot, jusqu'à 2 000 lignes du serveur avec leur `id`) : la conversation s'affiche depuis le téléphone, puis `loadHistory` ne demande que les 40 derniers messages et les recolle au cache par `id` (200 si le fil a trop avancé ou a été réécrit).
- **`after_id` n'est pas utilisable** : `db.get_messages` le connaît, mais la route REST `/api/sessions/{id}/messages` ne l'expose pas (elle lit `limit`, `offset`, `order`, `include_compacted`, `inline_images`) et il est incompatible avec `include_ancestors`, que la route impose. D'où la petite page des derniers messages au lieu d'un `after_id`.
- **Remonter le fil** : près du haut, `loadOlder` lit la page plus ancienne (`offset` = lignes déjà connues) et garde la position de lecture.
- **Reconnexion** : recul 1, 2, 5, 10, 30 s, état dans l'en-tête (« hors ligne », « reconnexion dans N s (essai k) », « à jour »).
- **Repli `invalid_params`** : sur `session.resume`, `session.history` et `profiles.list`, un refus est réessayé une fois sans les champs refusés (ou avec les seuls paramètres de base) ; l'échec d'origine est remonté à `/bots/log`.
- Limite connue : les groupes gardent leur propre scrutation, sans cache IndexedDB.

## Client en modules (v76)

`app/index.html` charge `report.js`, `version.js` et les bibliothèques (`vendor/`) en scripts classiques, puis `main.js` en `<script type="module">`. Plus aucune globale partagée : chaque module importe ce qu'il utilise, et `// @ts-check` en tête de chacun.

| Module | Rôle |
|---|---|
| `main.js` | point d'entrée : réveil, reconnexion, service worker, démarrage |
| `state.js` | état partagé : `state` (roster, conversation, groupes), `seen`, `activity`, `prefs` (épingles, couleur, personnages), `ui` |
| `gateway.js` | classe `Gateway` (JSON-RPC sur `/api/ws`), `AuthError` |
| `store.js` | `localStorage` (`store`, petit cache de messages) et IndexedDB (`idb`) |
| `history.js` | `fetchPage`, `loadHistory`, `loadOlder`, `renderHistory` |
| `chat.js` | ouverture d'un bot, `attach`, événements, état occupé |
| `approvals.js` | validations de commandes et questions du bot |
| `composer.js`, `send.js`, `outbox.js`, `attachments.js`, `commands.js`, `mentions.js` | saisie, envoi, file hors ligne, pièces jointes, commandes slash, complétions `@` et `/` |
| `render.js` | markdown, bulles, cartes de tâche, outils, pli des longs messages |
| `blocks.js`, `avatars.js` | blocs `bots-ui`, personnages |
| `roster.js`, `prefs.js`, `nav.js` | liste des bots et connexion, épingles et couleur de bulle, navigation |
| `groups.js`, `tasks.js` | groupes et tableau de tâches |
| `scroll.js`, `find.js`, `reply.js`, `msgmenu.js`, `botedit.js`, `settings.js`, `share.js` | position de lecture et brouillons, recherche, réponse à un message, menu d'un message, fiche d'un bot, réglages et push, partage Android |

Des imports circulaires existent (`chat` et `groups`, `roster` et `groups`) : ils ne servent que dans des fonctions appelées après le chargement, jamais au chargement même.

Contrôle de types : `bun run typecheck` (`tsc -p jsconfig.json`, équivalent de `tsc --noEmit --allowJs --checkJs`), rejoué par `bun run release` avant les tests. `sw.js` liste chaque module dans `SHELL` : en ajouter un, c'est l'ajouter là aussi. Les tests qui entrent dans la page (`test/smoke.ts`, les parcours réels) importent les modules (`import(new URL('state.js', document.baseURI).href)`), les globales n'existent plus.

## Erreurs du client

`app/report.js` envoie `window.onerror`, `unhandledrejection` et chaque échec RPC (sauf états normaux : file d'attente, génération périmée, réseau coupé) à `POST /bots/log` avec la version. Le serveur les écrit dans `actions.jsonl` (`client_error`) et envoie une alerte Hub au premier échec de chaque version. `bun server.ts status` les compte par version.

Chaque contrôle écrit dans `actions.jsonl` (`smoke`, `release_gate`, `release`) ; un échec envoie une alerte Hub. `bun server.ts status` donne le dernier `smoke` et le dernier `release`.

## Style voulu (Yoan, 2026-11-12)

- Style des apps de chat grand public : bulles sobres, rien de technique en vue par défaut.
- Les messages automatiques (fin de process, délégation, auto-continue) ne s'affichent jamais comme des messages de Yoan.
- Les outils tiennent sur une seule ligne repliable avec un compteur, jamais un mur de puces.

## Blocs visuels des bots (v59)

Un bloc clôturé ```` ```bots-ui ```` en JSON devient des cartes (récap, budget calculé, listes, étapes, boutons qui envoient la réponse). Bloc invalide : texte brut. Format et types : `docs/bots-ui.md`. Le markdown ordinaire est aussi rangé en cartes (`**Titre.**` en tête de paragraphe, mention @yoan).

## Notifications push (2026-11-13)

Les mentions @yoan arrivent en notification de Hermes Bots, plus de Hub. Activer : la cloche de la
liste des bots, sur chaque appareil (Android : Chrome > « Installer l'application » ; PWA, donc
aucun store). Vérifié le 14 novembre 2026 : l'abonnement push enregistré est `Android (app)`,
endpoint FCM. **Le téléphone de Yoan est un Xiaomi, pas un iPhone.**

- Abonnement : `POST /bots/push/subscribe`, exige la session de la webapp Hermes (cookie vérifié par `/api/auth/me`).
- Envoi, en local seulement : `bun server.ts push --title T --body B --url /bots/#profil`.
- Crons (2026-11-14) : plus de notif. Les crons Hermes livrent en `deliver: bot-chat` : le résultat
  arrive dans la conversation de son bot, affiché en carte « Tâche automatique », et le bot le résume.
- Clé VAPID et abonnements : `~/.local/state/hermes-bots-pwa/` (0600). `bun server.ts status` donne le dernier envoi.
- Le plugin bot-groups (mention.py) appelle cette commande ; Hub ne sert qu'en secours.

## Yaia dans un groupe (2026-11-18)

Yaia (la session Claude de Yoan) parle à un groupe de bots dans le groupe lui-même, à la vue de Yoan, et plus par `hermes -z` dans une autre session :

- `bun run yaia -- say <groupe> <texte>` : RPC `plugin.bot-groups.yaia.send`, le message entre dans la file du groupe comme un message de Yoan, préfixé `[yaia]` ; la PWA l'affiche au nom de Yaia et les bots reçoivent la règle `mention.YAIA_RULE` (le traiter comme un message de Yoan, répondre dans le groupe).
- `bun run yaia -- read <groupe> [--since N] [--wait S]` : lit les messages du groupe ; `status` : journal `data/bot-groups/yaia.jsonl`, alerte Hub sur chaque échec.
- Le gateway visé suit `HOME` (prod par défaut) ; `--test` vise le gateway de test. Groupes seulement : une conversation seule n'a pas de file où poster. Parcours : `group-journey.ts --part yaia`.

## Monorepo : PWA + plugin

Ce dépôt contient tout le pack Bots :

- `app/`, `server.ts`, `test/`, `scripts/` : la PWA (servie par le service déclaré dans `pwaService` de `~/.config/hermes-bots/config.json`).
- `plugins/bot-groups/` : le plugin Hermes des groupes de bots (historique de l'ancien dépôt `pyxl-dev/hermes-bot-groups` conservé). Hermes le charge depuis `~/.hermes/plugins/bot-groups`, qui est un lien vers ce dossier ; code rechargé par redémarrage du gateway (puis `bun LIFEOS/TOOLS/GatewayRestartCheck.ts`).
