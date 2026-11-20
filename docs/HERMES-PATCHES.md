# Patchs locaux de Hermes

`~/.hermes/hermes-agent` porte des modifications non publiées en amont. Une mise à jour de Hermes (`hermes update`) peut les effacer : les vérifier après chaque mise à jour (`git -C ~/.hermes/hermes-agent diff --stat`), puis rejouer les parcours sur le gateway de test.

## Groupes jusqu'à 16 bots (`gateway/hosted_room_discussion.py`)

- `MAX_DISCUSSION_MEMBERS = 16` (amont : 6). La limite choisie vit dans `hosted_rooms.discussion.max_members` (`plugins/bot-groups/settings.py`).
- `_TURN_ID_RE` : position `p([0-9]|1[0-5])` (amont : `p[0-5]`). À garder en phase avec `MAX_DISCUSSION_MEMBERS`.
  Panne du 2026-11-17 : le motif était resté à `[0-5]`. Dans un groupe de 8 bots, le tour du 7e bot (`p6`) devenait illisible à la préparation suivante (`turn_id is not a Discussion coordinate`) : groupe gelé, « Réessayer » refusé en `groups.retry : invalid_params`.
- Test : `tests/tui_gateway/test_hosted_room_discussion_limits.py::test_every_member_position_a_room_can_seat_is_a_readable_turn_id`.
