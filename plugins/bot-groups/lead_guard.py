"""Le meneur coordonne sans agir (décidé par Yoan le 2026-11-17, docs/adr/0003-le-meneur-coordonne-sans-agir.md).

Pendant chacun de ses tours de meneur dans un groupe (tour de discussion, réponse immédiate, recadrage), le hook
``pre_tool_call`` refuse tout outil absent de la liste blanche : coordination, lecture légère, délégation hors
groupe. Le refus revient au modèle avec la marche à suivre ; Yoan n'en voit rien dans le groupe. Seul à seul avec
Yoan, le même bot garde tous ses outils : le rôle est noté par session par ``mention.pre_llm_call``.
Journal : action ``lead_tool_blocked`` dans ~/.hermes/data/bot-groups/actions.jsonl.
"""
from __future__ import annotations

from . import _log

# Repère posé dans le prompt d'une réponse immédiate du meneur (dispatch.rpc_side), lu par mention.pre_llm_call.
SIDE_MARK = "[Rôle : meneur du groupe]"

ALLOWED = frozenset({
    # coordination
    "group_dispatch", "group_steer", "group_tasks", "group_read", "group_list", "group_post", "message_agent", "clarify",
    "todo_list",
    # lecture légère
    "read_file", "search_files", "memory", "session_search", "skill_view", "skills_list",
    # délégation hors groupe (choix de Yoan)
    "delegate_task",
    # enveloppes des outils différés : chaque appel qu'elles portent repasse ici sous son propre nom
    "tool_call", "tool_search", "tool_describe",
})

BLOCK_MSG = ("Refusé : tu es le meneur de ce groupe, tu coordonnes et tu ne fais pas le travail toi-même ({tool}). "
             "Confie-le à un membre avec group_dispatch (une tâche précise par bot), ou à un sous-agent avec "
             "delegate_task. Si aucun membre ne convient, dis-le à Yoan et propose-lui d'ajouter un bot au groupe.")


def pre_tool_call(tool_name: str = "", args=None, session_id: str = "", **_) -> dict | None:
    if tool_name in ALLOWED:
        return None
    from . import mention
    role = mention.role_of(session_id)
    if not role.get("lead"):
        return None
    room = role.get("room") or {}
    _log("lead_tool_blocked", True, tool=tool_name, session_id=session_id, room_id=room.get("room_id"),
         bot=room.get("handle") or role.get("handle"))
    return {"action": "block", "message": BLOCK_MSG.format(tool=tool_name)}


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", pre_tool_call)
