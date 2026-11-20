# Recadrer un membre de groupe par l'autorité de session de son profil

Yoan doit pouvoir recadrer un bot de groupe pendant qu'il écrit (GLOSSARY.md « Recadrage », 2026-11-17). Pour un bot seul, Hermes offre `session.redirect`. Pour un membre de groupe, aucune commande publique : son tour tourne dans une session cachée du gateway (« Group: <room_id> » pour un tour du moteur, « Groupe · <nom> » pour une tâche en coulisse lancée par `hermes chat`). `plugins/bot-groups/steer.py` retrouve donc, dans l'autorité de session de son profil (`gateway.session_authorities.all_authorities`), l'agent adopté du tour en cours (`SessionAuthority.adopted`) dont la session porte l'un de ces titres, puis refait ce que fait `correct()` de `gateway/session_busy_controls.py` : sous le verrou du flux, `check_approval_generation`, `steer_agent`, puis `agent.redirect(text)`.

## Considered Options

- **Garder le message jusqu'à la fin du tour** (ancien « Message en attente ») : Yoan perdait la main pendant tout le tour, c'est ce qu'il a refusé.
- **Arrêter puis relancer la tâche en coulisse avec la consigne** : essayé, le tour tourne dans le gateway et non dans le processus `hermes chat`, l'arrêt de ce dernier ne coupait rien et la relance restait bloquée.
- **Ajouter une commande au gateway** : il faudrait modifier Hermes lui-même, que nous ne maintenons pas.

## Consequences

- Le chemin dépend d'attributs internes de Hermes (`adopted`, `steer_agent`, `check_approval_generation`, titres de session). Après chaque mise à jour de Hermes, `group-journey.ts --part steer` sur le gateway de test le prouve avant la prod ; `steer.status()` dit si les méthodes existent, et le journal `steer_send` compte les modes.
- Si le chemin casse, rien n'est perdu : le message part en réponse immédiate ou reste gardé en tête (`inbox`, kind `user`), et une alerte Hub signale l'échec.
- Un recadrage lu est gardé (kind `steer`) et entre dans le fil du groupe entre deux tours dans son propre fil clos, pour que la discussion en cours continue.
