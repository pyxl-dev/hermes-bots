# Portée de la v88 (client Solid)

Décidé par Yoan le 2026-11-18 : la réécriture Solid aligne l'interface sur les maquettes validées (canevas « Bots PWA maquettes ») et ajoute des fonctions et de la stabilité. Il a tout coché et demande d'aller au-delà. Chaque critère porte la preuve qui le réfuterait.

## Interface (maquettes validées)

- [x] Accueil : tuiles épinglées avec état (liseré et mascotte animée qui travaille, badge @), récents mêlés bots et groupes avec l'état en couleur. Preuve : capture mobile sur le mock (`docs/redesign/captures/accueil-mobile.png`).
- [x] Fil : ligne d'action « ✓ N actions · verbes », détail au toucher ; réponse du bot en texte libre ; carte « Besoin de ton OK » à deux boutons réduite à une ligne une fois réglée. Preuve : parcours smoke.
- [x] Statut en direct : mot d'état et anneau dans l'en-tête, action en cours avec indicateur, curseur pendant le streaming, barre « travaillent en parallèle » avec Arrêter.
- [x] Deux volets à 900 px et plus. Preuve : capture 1280 px (`docs/redesign/captures/deux-volets-1280.png`, `bun test/captures.ts`).

## Stabilité (tout ce que Yoan a vu casser)

- [x] Connexion : reprise seule après redémarrage du gateway, changement de réseau, retour d'arrière-plan ; jamais figée. Preuve : smoke websocket coupé puis rouvert, gateway de test redémarré pendant un parcours.
- [x] Messages : aucun perdu ni doublé ; chaque envoi a un identifiant, une file persistante et un état visible (en attente, envoyé, échec avec Réessayer). Preuve : smoke coupure pendant l'envoi, dédoublonnage au rechargement.
- [x] État : « travaille » et l'aperçu de l'accueil se recalent sur le gateway à chaque reconnexion et toutes les 30 s ; jamais figé. Preuve : smoke tour fini pendant une coupure.
- [x] Plantage : une erreur dans une vue n'efface pas l'app (limite d'erreur par vue, rapport `report.js`, bouton Recharger) ; démarrage sûr avec un cache corrompu. Preuve : smoke cache corrompu, erreur forcée (vérifié le 2026-11-18).

## Fonctions

- [x] Accord depuis la notif (app vivante en arrière-plan) : notification avec Autoriser et Refuser, le choix est appliqué par le service worker sans ouvrir l'app. Preuve : smoke.
- [ ] Accord depuis la notif, app fermée : demande une source Web Push côté plugin (server.ts sait déjà pousser), donc un redémarrage de la prod sur accord de Yoan.
- [x] Recherche globale : un mot cherché dans tous les fils en cache (bots et groupes), résultat ouvert au bon message.
- [x] Hors ligne complet : fils lisibles sans réseau, envois en file, partis au retour du réseau.
- [x] Fichiers et profil du bot : fiche avec les fichiers touchés (tirés des actions du fil, arguments relus dans `tool_calls`), modèle, compétences actives, connecteurs et personnalité (`profiles.describe`).
- [ ] Mémoire du profil (MEMORY.md, USER.md) : le gateway n'expose aucune lecture (vérifié dans `tui_gateway`, 2026-11-18) ; il faut une méthode côté plugin ou serveur.
- [ ] Au-delà (à proposer au fil du travail, chacune notée ici avant d'être codée).

## Livraison

- [x] Typecheck, build, `scripts/checks.sh` verts, chaque contrôle sous 60 s.
- [x] Smoke, `real-journey.ts`, `group-journey.ts` sur le gateway de test, pilotés par `data-testid`.
- [x] Cibles : fil de 20 000 messages ouvert en moins de 1 s, aucune image de plus de 50 ms en streaming.
- [ ] `APP_VERSION` v88, PR, release par `bun run release`.

## Relevés (2026-11-18)

- Smoke sur le mock : 52 étapes en 21 s ; fil de 20 000 messages ouvert en 170 ms, rouvert en 34 ms ; aucune tâche de plus de 50 ms pendant un streaming (PerformanceObserver longtask, vérifié qu'il voit une tâche de 120 ms).
- Gateway de test : `real-journey.ts` 8 étapes (vraie conversation de 20 000 messages ouverte en 110 à 308 ms, vrai tour de modèle), `group-journey.ts` 36 étapes, `tasks-journey.ts` 7 étapes.
- Non vérifié : `memory-group-journey.ts`. Le labo mémoire (`~/.hermes-hindsight-lab`) attend la clé opencode-go, que seul Yoan pose (`bun test/memory-lab.ts key-help`).
- Défaut trouvé par les captures et corrigé : un message envoyé pendant la synchro d'ouverture partait avant la fin de la lecture de l'historique ; l'instantané d'attach effaçait alors la réponse en cours et l'état « travaille ». Il passe désormais par la file. Contrôle : `/api/mock/slow-history` et `/api/mock/raced` dans le smoke (échoue sans le correctif).
