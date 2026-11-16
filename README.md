# Hermes Bots

Une interface mobile, open source, pour piloter tes agents IA : la liste de tes bots et le chat permanent de chacun, avec streaming, outils, validations de commandes et notifications.

C'est l'alternative ouverte aux interfaces de bots fermées : le socle d'exécution est [Hermes Agent](https://github.com/NousResearch/hermes-agent), cette app est la couche qui rend l'ensemble utilisable depuis un téléphone.

MIT. Le code est à toi, tu peux l'héberger chez toi.

> **Bêta.** Aucun support promis. Les issues sont lues, les demandes de fonctionnalité ne sont pas des engagements. Le cœur est sous licence MIT ; l'hébergement pour d'autres est un travail séparé, pas une promesse de ce dépôt.

Chaîne : <!-- URL de la chaîne à poser ici avant la publication -->


## Essayer en deux minutes, sans rien installer d'autre

L'app embarque une passerelle factice qui sert l'interface et simule des bots. Aucun compte, aucune configuration.

```bash
bun install
bun test/mock-gateway.ts      # http://127.0.0.1:8790/bots/
```

Ouvre cette adresse dans un navigateur, ou depuis un téléphone sur le même réseau : chat, groupes, tâches planifiées, notifications.

## L'utiliser pour de vrai

L'app n'est qu'une interface : il lui faut un gateway Hermes derrière et la session de la webapp Hermes pour l'authentification.

- Le serveur sert `app/` sur `127.0.0.1:9131` : `bun server.ts`.
- Chaque socket prend un ticket via `POST /api/webapp/socket-ticket?socket=gateway[&profile=]`, puis parle le JSON-RPC du gateway sur `/api/ws`.
- Pour l'exposer à ton téléphone, mets-la derrière le même nom d'hôte que ta webapp Hermes (reverse proxy ou tailnet), puis déclare l'origine publique dans `PWA_URL`.

## Ce que fait l'interface

- Un chat permanent par bot, streaming et cartes d'outils repliables.
- Validation d'une commande depuis le téléphone, sans revenir sur l'ordinateur.
- Groupes de bots multi-auteurs, avec un meneur obligatoire qui arbitre.
- Tâches planifiées par bot : prochaine exécution, état, mise en pause depuis le téléphone.
- La sortie d'une tâche planifiée arrive en carte dans la conversation, avec la réponse du bot en dessous.
- Notifications Web Push par appareil.
- Mention prioritaire d'une personne : un bot qui a besoin de toi le signale.
- Cache hors-ligne : une conversation déjà ouverte se relit sans réseau.
- Réglages : avatars, markdown, brouillons, couleur des messages, thèmes.

## Configuration

Toutes les valeurs ont un défaut local, rien n'est obligatoire pour essayer.

| Variable | Rôle | Défaut |
|---|---|---|
| `HERMES_GATEWAY` | origine du gateway Hermes | `http://127.0.0.1:9120` |
| `PWA_URL` | origine publique de l'app, utilisée dans les notifications | `http://127.0.0.1:9131/bots/` |
| `PWA_SERVICE` | service système à relancer après une mise à jour du serveur | aucun |
| `PROD_ORIGIN` | origine testée par `test/real-journey.ts` | `http://127.0.0.1:9131` |

## Développement

```bash
bun test/smoke.ts        # parcours de base sur la passerelle factice
bun run typecheck        # types de app/
bun run check            # contrats du gateway
```

La documentation interne (livraison, gateway de test, parcours réels, module par module) est dans [docs/MAINTENANCE.md](docs/MAINTENANCE.md).

## Licence

MIT, voir [LICENSE](LICENSE).
