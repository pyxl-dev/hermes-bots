# bot-groups

Outils `group_list`, `group_read`, `group_create`, `group_post` pour que les bots s'organisent en groupes eux-mêmes (demande de Yoan, 2026-11-12).

- Accès : socket de contrôle local `~/.hermes/gateway.sock`, verbe `session-ticket` (scope host, même utilisateur Mac que le desktop natif), puis `/api/ws`. Les groupes appartiennent au propriétaire : visibles dans la PWA `/bots` et le desktop.
- Garde-fous (choix « prudent ») : 3 groupes actifs créés par les bots, 2 à 4 membres créateur compris, routage `lead` avec le créateur comme meneur, 10 `group_post` par heure et par bot, lecture et post réservés aux membres. Pas de dissolution par les bots : Yoan supprime depuis la PWA.
- Suivi : journal `~/.hermes/data/bot-groups/actions.jsonl`, `python3 ~/.hermes/plugins/bot-groups/status.py`, alerte Hub (sujet `hermes-groupes`) à chaque création et chaque échec.
- Activation : `plugins.enabled` de chaque `config.yaml` (sauvegardes `*.bak-botgroups-*`), lien dans `profiles/<nom>/plugins/`, puis redémarrage du gateway (`launchctl kickstart -k gui/$UID/ai.hermes.gateway`).

## Mentions @yoan (mention.py, 2026-11-12)

- `pre_llm_call` ajoute au message du tour la consigne : écrire @yoan quand Yoan doit agir. Dans un groupe
  avec meneur, seul le meneur peut mentionner @yoan ; les autres s'adressent au meneur. Groupe sans meneur :
  tout membre peut le faire.
- `post_llm_call` : @yoan détecté hors règle (non-meneur) -> `mention_blocked` dans le journal, pas de notif.
  Sinon : mention ajoutée au ui_meta `hermes-bots-mentions` du profil (20 dernières, lues par la PWA pour
  les badges rouges) et `hub-notify -a -p 5` (topic `hermes-mentions`) avec le lien du chat ou du groupe.
- Échecs : `mention_failed` (étape ui_meta ou hub) dans `actions.jsonl`, visibles par `python3 status.py`.

## Tours de discussion (1.3.0, 2026-11-12)

Le gateway borne chaque message de Yoan à `max_rounds` tours (3) et 10 messages ; un tour de plus n'a lieu
que si un membre en cite un autre. `pre_llm_call` ajoute ces règles et le tour en cours (lu dans
`groups.state.driver_status.member_activity[].round_index`) au message de chaque membre. Avec un meneur :
les autres membres ne citent que le meneur à l'avant-dernier tour et ne citent personne au dernier ; le meneur
ne cite plus personne à partir de l'avant-dernier tour et conclut pour Yoan. Échec de lecture du tour :
action `round_lookup` dans le journal, règles données sans numéro de tour.

## Questions par clarify (1.4.0, 2026-11-13)

Hors groupe, `pre_llm_call` demande à l'agent de poser tout choix à trancher par Yoan (même oui/non) avec
l'outil clarify. La PWA affiche la question en carte à boutons (`clarify.respond`). Délai : `agent.clarify_timeout`
de chaque profil (0 = illimité).

## Messages entre bots (1.5.0)

Un tour qui répond à un `message_agent` (« Message from … (@x): ») reçoit la consigne de ne pas écrire @yoan ni utiliser clarify : la réponse repart chez l’expéditeur, qui transmet à Yoan. Un @yoan écrit quand même est rétrogradé en « Yoan » et ne notifie pas (journal `mention_blocked`).

## Messages entre bots (1.5.0)

Un tour qui répond à un `message_agent` (« Message from … (@x): ») reçoit la consigne de ne pas écrire @yoan ni utiliser clarify : la réponse repart chez l’expéditeur, qui transmet à Yoan. Un @yoan écrit quand même est rétrogradé en « Yoan » et ne notifie pas (journal `mention_blocked`).

## Réglages des équipes (1.6.0)

`plugin.bot-groups.settings.get` et `.set` (appelés par la PWA) lisent et écrivent `hosted_rooms.discussion` dans `~/.hermes/config.yaml` via `hermes config set` : `max_members` (2 à 16, lu par la PWA et `group_create`), `max_rounds` (1 à 10), `max_messages` (2 à 200). Le gateway relit tours et messages au début de chaque discussion. Journal `settings_set`, alerte Hub en cas d’échec.

## 1.7.0 (2026-11-13)

Mentions @yoan : notif Web Push de la PWA Hermes Bots (`bun ~/Projects/hermes-bots-pwa/server.ts push`)
au lieu de Hub. Hub reste en secours si aucun appareil n'est abonné ou si l'envoi échoue
(journal : `mention` avec `via`, `mention_failed` avec `step=push`).

## Blocs visuels (1.9.0)

Dans la Bot Chat d'un bot et dans les groupes, `pre_llm_call` ajoute la consigne `UI` : répondre en blocs ```` ```bots-ui ```` (JSON) que la PWA Hermes Bots dessine (v59, format dans `hermes-bots-pwa/docs/bots-ui.md`). La Bot Chat est reconnue à son titre canonique « Bot Chat » (lecture seule du `state.db` du profil, en cache) ; ailleurs (Telegram, desktop) rien ne change. Dans un groupe à meneur, seul le meneur utilise `actions` et `choices`.

## Tableau de tâches et voie rapide (1.14.0, 2026-11-15)

- `tasks.py` : un tableau de tâches par groupe (`~/.hermes/data/bot-groups/tasks/<room_id>.json`). La PWA crée une tâche pour chaque message de Yoan (id du message, jamais en double) ; les bots utilisent l'outil `group_tasks` (list, add avec `parent`, update : `doing`, `blocked` avec raison, `done` avec preuve, refusé tant qu'une sous-tâche est ouverte). Les tâches ouvertes sont ajoutées à chaque tour de groupe et aux tâches en coulisse. RPC PWA : `tasks.list`, `tasks.add`, `tasks.update`, `tasks.remove` (Yoan peut tout rouvrir). Journal : `task_add`, `task_update`, `task_remove`, `task_failed`.
- `dispatch.rpc_side` (`side.send`) : le moteur ne lance qu'un tour à la fois par groupe. Quand Yoan cite un membre libre (pas le meneur) pendant qu'une discussion tourne, la PWA confie le message au plugin : le bot répond en coulisse tout de suite, puis question et réponse sont postées dans un même fil (le moteur ne relance donc pas la question) et la réponse cite le meneur. Groupes à meneur seulement. Un message coupé par un redémarrage est reposté dans la file normale (`recover_side`, journal `side_recovered`).

## Parallèle forcé (1.15.0)

Le moteur du gateway fait parler les bots cités par @mention un par un. Quand le meneur cite au moins deux coéquipiers par @handle, `fanout.py` (appelé depuis `transform_llm_output`) lance un `group_dispatch` : chaque bot reçoit le message du meneur et le paragraphe qui le cite, et tous travaillent en même temps. Dans le message posté, ces bots sont cités sans @, pour que le moteur ne relance pas leurs tours, et une ligne indique qui travaille en parallèle. Les mentions dans le code ou dans une citation ne comptent pas. Si le dispatch refuse (bot occupé, limite de tâches), le message reste tel quel et les tours se jouent un par un. Chaque conversion est journalisée sous `fanout`, en succès comme en échec.

Depuis 1.17.0, la règle vaut pour tous les bots : un bot non meneur qui cite au moins un coéquipier le lance aussi en `group_dispatch` (le meneur cité reste dans le tour du moteur, pour coordonner) ; le résultat est posté en citant ce bot, qui reprend la main. Un bot déjà occupé par une tâche parallèle du groupe garde son tour en file. Une citation à la négative (« sans passer par @x », « pas besoin de @x », « ni @x », « sauf @x ») perd son @ : le bot est nommé, pas sollicité.

## Répartition parallèle (1.16.0)

Quand le meneur répartit un message de Yoan (`{"assign": [...]}`) entre plusieurs bots, le moteur les ferait parler un par un. Désormais, un seul bot reste dans le tour du moteur : le meneur s'il s'est choisi, sinon le premier bot choisi. Les autres reçoivent aussitôt le message par `group_dispatch` et travaillent tous en même temps. Chaque conversion est journalisée sous `fanout_assign`, en succès comme en échec.

## @ oubliés (1.18.0)

Les bots adressent souvent un coéquipier par son nom sans @ (« uncensored : … », « rea, … »), et le moteur ne lui donne alors aucun tour. Avant le parallèle forcé, `fanout.add_at` remet le @ dans les positions d'adresse : nom en début de ligne (après puce, numéro ou gras) suivi de « : » ou « , », hors code et citations. Les bots en première colonne d'un tableau `bots-ui` dont l'en-tête désigne un poste (poste, bot, membre, qui, assigné, responsable, pour) sont cités en fin de message. Le handle est sensible à la casse (« dofus » le bot, pas « Dofus » le jeu). Journal : action `auto_at`.

## Résultats gardés pendant un redémarrage (1.18.1)

Un résultat de table ronde refusé parce que le gateway redémarre (drain, port fermé) est écrit dans `~/.hermes/data/bot-groups/unposted.jsonl` au lieu d'être perdu, puis reposté chaque minute par la boucle de `resume.py` dès que le gateway répond, avec le même `event_id`. Journal : `dispatch_parked`, `dispatch_reposted` ; alerte Hub si un résultat attend plus d'une heure.

## Un seul état des tâches par processus (1.18.2)

Hermes charge une copie du plugin par profil (`hermes_plugins.bot_groups__home_<digest>`). La liste des tâches parallèles, celle des messages en voie rapide et le verrou des résultats parqués vivent dans un module partagé, `_hermes_bot_groups_shared` : toutes les copies voient les mêmes tâches, et la PWA affiche les bots au travail.

## Enchaînement sans perte (1.19.0, 2026-11-16)

- Tâches parallèles détachées : `hermes chat` passe par le gateway (refusé pendant un drain), donc une tâche coupée par une erreur transitoire est relancée dans la même session (20 essais, 30 s ; journal `dispatch_retry`). Le processus tourne dans sa propre session de processus, sortie dans `data/bot-groups/jobs/<id>.out`, fiche `<id>.json`. Un redémarrage du gateway ne la tue plus ; `recover_jobs` (au démarrage, avant la boucle) la remet dans la barre et poste son résultat. Journal `dispatch_recovered`.
- Tours du moteur coupés par le drain (`failed`, `runtime_draining`, sans bouton Réessayer) : rejoués en coulisse avec leur prompt d'origine, résultat posté au nom du bot (`resume.relaunch_drained`, journal `relaunch_drained`, déjà traités dans `relaunched.json`). Ignoré si le bot a parlé depuis.
- `add_at` : un nom de bot suivi de « : » ou « , » en début de phrase (après « . ; ! ? ») reçoit aussi son @.
- Voie parallèle : la mention reste visible (`@` + espace sans chasse) au lieu d'être retirée ; le moteur ne la compte pas.

## Fil de travail (1.20.0)

Ce qu'un bot fait pour produire un résultat de groupe : outils (nom, arguments, sortie) et textes intermédiaires,
sans réflexion. Gardé 30 jours dans `data/bot-groups/traces/<room_id>/`.

- Tours du moteur : session cachée du bot (`Group: <room_id>`) dans le `state.db` de son profil, tâches lues dans `hosted_room_driver_tasks` (lecture seule) ; copie compacte des fils finis toutes les 5 min. Le hook `on_room_member_activity` n'est pas utilisé : il ne tire pas pour ces membres (vérifié en réel).
- Table ronde : flux stream-json du `.out` lu pendant le travail ; `_finish` le compacte avant de l'effacer.
- RPC : `trace.list {room_id}`, `trace.read {room_id, trace_id, after?, open?}`, `member.stop {room_id, member_id}`
  (ce seul bot : `runtime.cancel` pour ses tâches du moteur, SIGTERM pour ses tâches de table ronde, sans post
  d'échec ni relance), `dispatch.stop {room_id}` (toute la table ronde du groupe).
- Journal : `trace_failed`, `member_stop`, `dispatch_stop`, `dispatch_stopped` ; `python3 status.py` ; alerte Hub sur échec.

## Horloge (1.21.0, 2026-11-16)

`clock.py`, crochet `pre_llm_call` : à chaque tour, le bot reçoit « Horloge : nous sommes le lundi 16 novembre 2026, il est 17:05 (heure de Paris). Le message précédent de cette conversation date d'il y a 3 jours (le vendredi 13 novembre à 09:12). » Le crochet tourne dans l'agent, donc sur tous les canaux : PWA (Bot Mode), table ronde, Telegram, tâches automatiques. L'option native `gateway.message_timestamps` ne couvre pas le Bot Mode. L'heure du dernier tour de chaque conversation est gardée dans `data/bot-groups/clock.json` (2 000 conversations au plus). Le tour de répartition du meneur (`{"assign"`) n'est pas touché. Échecs : action `clock` du journal, alerte Hub au plus une par heure, ligne « horloge » de `status.py`.

## Messages en attente (1.22.0, 2026-11-16, inbox.py)

Le moteur ne mène qu'une discussion à la fois et la prolonge tant que les bots se citent : un message de Yoan attendait toute la chaîne, derrière les résultats de table ronde (19:03 encore pas lu à 19:12). Désormais tout ce qui arrive pendant une discussion (RPC `inbox.send` de la PWA, résultats de table ronde, voie rapide, `group_post`) est gardé dans `data/bot-groups/inbox.json`. Entre deux tours, juste après la publication du tour fini et avant que le moteur planifie la relance (enveloppe de `HostedRoomService._publish_terminal_tasks`) : les messages de Yoan puis les résultats gardés entrent dans le fil de la discussion en cours, ce qui la clôt (relances abandonnées) ; le meneur lit tout d'un coup. Résultats seuls : posés quand plus aucune discussion n'est en cours. Rien n'est posé pendant l'arrêt du gateway. RPC `inbox.status` : messages encore gardés (bulles après rechargement). Journal `inbox_held`, `inbox_flush` ; `status.py`.

## Recadrage et demandes suivantes (1.24.0, 2026-11-17, steer.py, inbox.py)

Termes : `GLOSSARY.md` « Recadrage », « Demande suivante » ; décision : `docs/adr/0002-recadrage-d-un-membre-de-groupe.md`.

- **Recadrage** : RPC `steer.send {room_id, event_id, text}`. Bot visé : le premier @ cité membre du groupe, sinon le meneur. S'il tient un tour (moteur ou coulisse), `agent.redirect` le lui donne tout de suite (mode `steered`) ; s'il ne travaille pas, réponse immédiate (`side`) ; si le tour vient de finir, le message est gardé en tête (`held`, kind `user`) et le bot repart aussitôt avec ; rien en cours : `fallback`, la PWA l'envoie normalement. Journal `steer_send` ; `steer.status` vérifie que le chemin existe dans ce Hermes.
- **Demande suivante** : `/q texte` ou `/queue texte` dans la PWA, RPC `inbox.send` avec `kind:"next"`. Elle part seule, la plus ancienne d'abord, quand la discussion est finie et qu'aucune table ronde du groupe ne tourne (un arrêt compte), et ouvre sa propre discussion. `inbox.cancel {room_id, event_id}` l'annule tant qu'elle n'est pas partie (le texte revient dans la zone de saisie).
- La fin d'une tâche en coulisse (`dispatch._end`) réveille l'inbox : une demande suivante attendait peut-être cette table ronde.

## Le meneur coordonne sans agir (1.25.0, 2026-11-17, lead_guard.py)

Pendant ses tours de meneur dans un groupe (discussion, réponse immédiate, recadrage), le hook `pre_tool_call` refuse tout outil hors de la liste blanche `lead_guard.ALLOWED` : coordination (`group_dispatch`, `group_steer`, `group_tasks`, `group_read`, `group_list`, `group_post`, `message_agent`, `clarify`, `todo_list`), lecture légère (`read_file`, `search_files`, `memory`, `session_search`, `skill_view`, `skills_list`) et délégation hors groupe (`delegate_task`). Le refus revient au modèle avec la marche à suivre et se journalise (`lead_tool_blocked`). Le rôle est noté par session dans `mention.pre_llm_call` ; une réponse immédiate du meneur porte le repère `lead_guard.SIDE_MARK`. Seul à seul avec Yoan, le bot garde tous ses outils. Un nouvel outil de coordination s'ajoute à la liste blanche. Décision : `docs/adr/0003-le-meneur-coordonne-sans-agir.md`. Preuve : `test/tasks-journey.ts`, étape 5.

## Recadrage par le meneur (1.26.0)

L'outil `group_steer` (réservé au meneur) envoie une consigne à un membre pendant son tour, de discussion ou de table ronde : même chemin que le recadrage de Yoan (`steer.redirect_turn`). Le membre la prend dans son tour en cours et continue avec. Une seule fois par tour du membre. Si le membre ne travaille pas, l'outil refuse et liste ceux qui travaillent. Le recadrage entre dans le fil, signé du meneur (`[meneur] Recadrage pour X : ...`), déjà traité. Journal : `lead_steer` (refus notés `refused`, échecs en alerte Hub), compté dans `status.py`. Preuve : `test/group-journey.ts --part steer`, dernière étape.
