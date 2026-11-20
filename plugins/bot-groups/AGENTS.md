# bot-groups : consignes pour les agents

## Après chaque redémarrage du gateway

Un changement de ce plugin n'est chargé qu'au redémarrage du gateway (`hermes gateway restart --yes`, qui attend la fin des tours en cours). Après **chaque** redémarrage, avant de dire que c'est fait :

```bash
bun ~/.claude/LIFEOS/TOOLS/GatewayRestartCheck.ts
```

Le script attend le nouveau processus, puis vérifie l'API, les plugins (bot-groups à la version de `plugin.yaml`), les tâches de groupe en échec ou figées, les sessions coupées par le drain et les résultats de table ronde perdus ou en attente. Code de sortie 1 et alerte Hub si un point échoue. `... status` relit les derniers contrôles.

Un point en échec se traite avant de conclure : un résultat refusé pendant le drain se retrouve dans la session du bot et se reposte dans le groupe (cas du 2026-11-16, quatre résultats perdus).

Règle décidée par Yoan le 2026-11-16.
