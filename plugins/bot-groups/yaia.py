"""Yaia (l'assistante Claude de Yoan) parle dans un groupe, à la vue de Yoan.

Écrit le 2026-11-18 à la demande de Yoan : Yaia passait par ``hermes -z`` dans une autre session, hors du groupe ;
Yoan ne voyait pas ses échanges avec l'équipe. Ici, un message de Yaia entre dans le groupe comme un message de Yoan
(même file : ``inbox.submit``, même réveil du meneur), préfixé ``[yaia]`` : la PWA l'affiche au nom de Yaia
(``botPost`` dans web/src/data/groups.ts) et les bots savent qui parle (``mention.YAIA_RULE``).

RPC ``plugin.bot-groups.yaia.send {room_id, text, event_id?}`` -> ``{ok, event_id}`` ; CLI : ``scripts/yaia.py``.
Journal : ``actions.jsonl`` (``yaia_send``), alerte Hub sur chaque échec.
"""
from __future__ import annotations

import uuid

from . import _hub, _log, _rpc

PREFIX = "[yaia] "
MAX = 8000


def rpc_send(params: dict | None = None, **_) -> dict:
    p = params or {}
    room_id = str(p.get("room_id") or "")
    text = str(p.get("text") or "").strip()
    event_id = str(p.get("event_id") or f"yaia-{uuid.uuid4().hex[:16]}")
    try:
        if not room_id or not text:
            raise ValueError("room_id et texte requis")
        if text.startswith(PREFIX):
            text = text[len(PREFIX):]
        (state,) = _rpc(("groups.state", {"room_id": room_id}))  # groupe inconnu : erreur nommée par le gateway
        if not (state.get("room") or {}).get("room_id"):
            raise ValueError(f"groupe introuvable : {room_id}")
        from . import inbox
        inbox.submit(room_id, event_id, {"text": PREFIX + text[:MAX], "thread_id": event_id}, "user")
    except Exception as exc:
        _log("yaia_send", False, room_id=room_id, event_id=event_id, cause=str(exc)[:300])
        _hub("Yaia : message non posé", f"{room_id} : {exc}")
        raise
    _log("yaia_send", True, room_id=room_id, event_id=event_id, chars=len(text))
    return {"ok": True, "event_id": event_id, "room_id": room_id}
