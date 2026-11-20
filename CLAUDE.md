# hermes-bots-pwa : règles de travail

Règles obligatoires pour toute session qui touche ce dépôt (PWA `app/`, `server.ts`, plugin `plugins/bot-groups/`). Détails : `docs/MAINTENANCE.md`, décision : `docs/adr/0001-gateway-de-test-sur-le-mac.md`.

## Tout se teste sur le gateway de test, jamais sur la prod

- Toute nouvelle fonctionnalité ou correction se développe et se prouve sur le **gateway de test** : `bun test/test-gateway.ts ensure` (ou `reset` puis `start`), puis `bun test/real-journey.ts` et `bun test/group-journey.ts`. On peut le redémarrer autant qu'on veut (`bun test/test-gateway.ts restart`).
- Le gateway de prod (`~/.hermes`, LaunchAgent `ai.hermes.gateway`) porte les vrais bots de Yoan : jamais de test dessus, jamais de redémarrage sauf demande explicite de Yoan (`hermes gateway restart --yes`, puis `bun ~/.claude/LIFEOS/TOOLS/GatewayRestartCheck.ts`). Seule exception : `real-journey.ts --target prod`, en lecture seule.
- Les mises à jour de Hermes passent d'abord par le gateway de test, comme le code.

## La copie servie ne se modifie jamais à la main

- `~/Projects/hermes-bots-pwa` (premier worktree) est la copie servie : la PWA de prod en sort et la prod charge le plugin depuis `plugins/bot-groups` (lien `~/.hermes/plugins/bot-groups`). On y fait seulement `git pull` via la release.
- On travaille dans un worktree ; le gateway de test charge le plugin de ce worktree.

## Livrer

- `bun run release` : exige les parcours sur le gateway de test avant le merge. Si le plugin a changé, la release le recharge à chaud sur la prod (`scripts/prod-plugin-reload.ts`, `plugin.bot-groups.reload`, sans redémarrage, preuve par l'empreinte du code). Seulement si ce rechargement échoue, elle s'arrête sur « redémarrage prod requis » ; après le redémarrage de la prod, `bun run release --resume`.
- Le rechargement à chaud se prouve sur le gateway de test : `group-journey.ts --part reload` (pendant une tâche en cours). Un état qui doit survivre au rechargement passe par `lifecycle.shared`, une boucle de fond par `lifecycle.wait(gen, ...)`.
- Une PR non vérifiée sur le gateway de test ne se merge pas.

## La référence : Grok Bot (Yoan, 2026-11-18)

- Chaque choix d'interface se tranche sur « comment fait Grok Bot » (https://x.ai/bot). Un écart doit avoir une raison écrite dans la PR.

## Parité conversation seule et groupe (Yoan, 2026-11-18)

- Un comportement de conversation (texte en direct, lignes d'outils au-dessus de la réponse, statut, cartes, dépliage, gestes ; aucun panneau à part pour le travail d'un bot) existe à l'identique dans une conversation seule et dans un groupe, avec le même composant. Une fonctionnalité livrée d'un seul côté n'est pas finie.
- Si une partie n'est pas faisable d'un côté (donnée absente du gateway), le dire dans la PR et au moment de l'annoncer, jamais la présenter comme livrée partout.
- Le smoke vérifie chaque comportement dans les deux parties (`bots` et `groups`).

## Garde-fous

- Hooks git versionnés dans `.githooks/` (installés par `bun install`, ou `bun run hooks:install`) : `pre-commit` (copie servie refusée, gitleaks et `.env`, types de `app/`, syntaxe TS, ruff, contrats RPC) et `pre-push` (`APP_VERSION` incrémentée si `app/` change, smoke sur le mock, versions figées). Tout passe par `scripts/checks.sh`, que la CI rejoue.
- CI GitHub (`.github/workflows/ci.yml`) sur chaque PR et chaque push vers main ; main ne se merge que CI verte.
- Jamais `--no-verify`. Un hook qui bloque à tort se corrige dans `scripts/checks.sh`, en PR.
- Règle des 60 s (Yoan, tous projets ; relevée de 30 à 60 s le 2026-11-17) : un contrôle de plus de 60 s est un mauvais contrôle ; on le découpe ou on l'accélère, on ne relève pas la limite sans décision de Yoan. `checks.sh` échoue au-delà.
- Contrats du gateway : `bun run check` lit l'instantané `test/fixtures/contracts.json` ; après une mise à jour de Hermes, `bun run check:snapshot` puis commit (`check:fresh`, dans la release, refuse un instantané périmé).

## Agent skills

### Issue tracker

Issues GitHub de pyxl-dev/hermes-bots, via `gh`. See `docs/agents/issue-tracker.md`.

### Triage labels

Les cinq labels par défaut (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), créés sur le dépôt. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context : `GLOSSARY.md` et `docs/adr/` à la racine. See `docs/agents/domain.md`.

## Dépôt public : rien de privé n'y entre

- Ce dépôt est public : chaque commit, message de commit, branche, PR et issue est lu par tout le monde, pour toujours. Aucune donnée de l'installation de Yoan (domaine, chemins, noms de services, vraies conversations, vrais groupes) n'y entre.
- Ce qui est propre à une installation vit hors du dépôt : réglages dans `~/.config/hermes-bots/config.json` (lus par `lib/local-config.ts` et `plugins/bot-groups/mention.py`), notes de suivi dans `~/.claude/projects-local/hermes-bots/`. Les données de test restent fictives.
- Garde : `scripts/public-guard.ts`, lancé par `pre-commit` (lignes ajoutées), `commit-msg` (message), `pre-push` (contenu et messages poussés, et refus de tout commit qui ne descend pas de la racine publique) et, dans Claude Code, avant chaque `gh pr|issue create|edit|comment` (`.claude/settings.json`). Motifs : génériques dans le script, perso dans `~/.config/hermes-bots/forbidden.txt` (jamais dans le dépôt). Un refus se corrige en retirant la donnée, jamais en contournant la garde.

Notes privées de Yoan (absentes chez un autre contributeur, sans effet alors) :

@~/.claude/projects-local/hermes-bots/CLAUDE.md
