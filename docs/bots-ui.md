# Blocs visuels des bots (`bots-ui`)

Depuis la v59, un bot peut répondre avec des cartes que la PWA dessine (maquette B choisie par Yoan le 2026-11-14).
Rendu : `app/blocks.js`, appelé par `md()` dans `app/render.js`, en conversation comme en groupe.

## Format

Un bloc clôturé `bots-ui` contenant du JSON : un objet, un tableau d'objets (12 au plus) ou `{ "blocks": [...] }`.
Le texte markdown autour reste affiché normalement. Avant l'envoi, le plugin (`plugins/bot-groups/ui_guard.py`)
répare un JSON cassé quand il peut (blocs collés sans `[...]`, guillemets non échappés, virgule finale) : la carte
s'affiche (`ui_guard_repaired` au journal). Sinon le bloc devient du texte (toutes ses chaînes, une ligne de
tableau par ligne) suivi du bloc d'origine en ```` ```bots-ui-brut ````, que l'app replie sous « Bloc illisible,
voir le brut » ; le brut est aussi au journal (`ui_guard_fixed`, champ `raw`). Un bloc invalide qui arrive malgré
tout à l'app est affiché tel quel en texte brut et remonté à `/bots/log` (`kind: bots-ui`).
Si le bot oublie l'étiquette, un bloc ``` ou ```json dont le contenu est déjà un bloc valide est rendu aussi ;
tout autre bloc de code reste du code.

| type | champs | rendu |
|---|---|---|
| `recap` | `title`, `kicker?`, `facts?` [{`value`, `label?`}] (1 à 4), `note?` | carte d'en-tête |
| `budget` | `lines` [{`label`, `min`, `max?`}], `envelope?`, `currency?` (défaut €), `title?`, `note?` | fourchettes en barres ; **le total est calculé par l'app** |
| `checklist` | `items` [texte ou {`text`, `done?`}], `tone?` `ok`/`todo`/`neutral`, `title?` | liste cochée (`ok` : tout coché par défaut) |
| `chips` | `items` [texte], `struck?`, `title?` | étiquettes (barrées si `struck`) |
| `table` | `columns` [texte], `rows` [[texte ou nombre]], `title?` | tableau |
| `steps` | `items` [{`label`, `state?` `done`/`now`/`todo`, `note?`}] (2 à 8), `title?` | étapes reliées |
| `card` | `title`, `text` | carte de texte |
| `actions` | `items?`, `options?` (1 à 4), `title?` (défaut « À toi de jouer ») | carte jaune pour Yoan |
| `choices` | `options` (1 à 6), `prompt?` | boutons |

Une option est un texte ou `{ "label": "...", "send": "..." }`. Toucher le bouton envoie `send` (sinon `label`)
comme un message normal de Yoan, puis grise les boutons du bloc.

Texte des blocs : texte brut, `**gras**` seulement, pas de lien ni d'image.

## Mise en page du markdown ordinaire

Sans bloc, l'app range aussi les réponses : au moins deux paragraphes qui commencent par `**Titre.**` deviennent
des cartes titrées, et un paragraphe qui mentionne `@yoan` dans un message de trois blocs ou plus devient la carte
jaune « À toi de jouer ». Les messages qui contiennent des cartes ne sont plus repliés.

## Exemple

````
```bots-ui
[
 {"type": "recap", "kicker": "Décidé", "title": "Lyon", "facts": [{"value": "14 au 21", "label": "avril 2027"}, {"value": "7 nuits"}]},
 {"type": "budget", "envelope": 1500, "lines": [{"label": "Logement", "min": 416, "max": 601}, {"label": "Billet chien", "min": 40}]},
 {"type": "actions", "items": ["Appeler la mairie"], "options": ["Mairie appelée", {"label": "Pas encore", "send": "Je n'ai pas encore appelé la mairie"}]}
]
```
````
