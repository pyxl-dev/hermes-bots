# Le meneur coordonne sans agir : outils bloqués par liste blanche

Un meneur qui fait le travail lui-même est un mauvais meneur (Yoan, 2026-11-17) : les membres restent inactifs, et le groupe ne sert plus à rien. Une consigne dans le prompt ne suffit pas, car le meneur passe outre dès qu'une tâche lui paraît rapide. Le plugin `bot-groups` bloque donc les outils du meneur avec le hook `pre_tool_call` de Hermes, pendant chacun de ses tours dans un groupe : tour normal, réponse immédiate et recadrage compris. Seuls passent les outils d'une liste blanche : coordination (`group_dispatch`, tableau du groupe, cartes et boutons), lecture légère (lire un fichier, consulter la mémoire) et délégation hors groupe. Le meneur peut toujours répondre en texte, résumer et trancher. Un outil refusé renvoie au modèle un message qui l'invite à confier le travail à un membre. Le refus est journalisé et Yoan n'en voit rien dans le groupe. Quand aucun membre ne convient, le meneur le dit à Yoan et propose d'ajouter un bot. Seul à seul avec Yoan, le même bot garde tous ses outils.

## Considered Options

- **Consigne dans le prompt** : c'est l'état d'avant, qui n'a pas empêché le meneur d'agir.
- **Liste noire d'outils interdits** : un outil ajouté plus tard à Hermes ou à un profil passerait sans bruit. La liste blanche le bloque tant qu'on ne l'a pas autorisé.
- **Retirer les outils du profil du meneur** : le même bot perdrait aussi ses outils seul à seul avec Yoan, alors que « meneur » est un rôle dans un groupe, pas une propriété du bot.

## Consequences

- Un nouvel outil de coordination doit être ajouté à la liste blanche, sinon le meneur ne peut pas s'en servir.
- La délégation hors groupe reste ouverte (choix de Yoan) : le meneur peut encore faire faire un travail hors de ses membres.
