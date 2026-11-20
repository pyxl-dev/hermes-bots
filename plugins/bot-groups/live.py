"""Texte qu'un bot de groupe est en train d'écrire (Yoan, 2026-11-18 : « fais le streaming de la réponse finale en groupe »,
comme en conversation seule).

Tours du moteur : la session cachée d'un membre (``surface`` ``bot_room``) n'a pas de client, ses ``message.delta``
ne vont nulle part et ``on_room_member_activity`` ne tire pas pour ces groupes (sonde du 2026-11-18, comme le
2026-11-16). Les hooks d'observation ``on_stream_start`` / ``on_stream_delta`` / ``on_stream_end`` tirent, eux, une
fois par morceau, dans le processus du gateway, avec l'id de la session cachée : on garde le texte de la réponse en
cours par session. ``trace.py`` relie la session au membre (titre ``Group: <room_id>`` dans le ``state.db`` du profil).

Table ronde (``dispatch.py``) : le ``.out`` stream-json reçoit chaque morceau (``type: text``) ; ``trace.stream_tail``
le lit, ce module n'y est pour rien.

Le tampon vit hors du paquet (``lifecycle.shared``) : un rechargement à chaud ne perd pas une réponse en cours.
"""
from __future__ import annotations

import threading
import time

from . import lifecycle

CAP = 20000      # signes gardés par réponse (le plugin poste au plus 7500 signes)
KEEP_S = 900     # une réponse finie reste lisible 15 min, puis s'efface
_buf: dict = lifecycle.shared("live.buf", dict)          # session_id -> {"iter", "text", "ts", "t0", "done"}
_lock = lifecycle.shared("live.lock", threading.Lock)


def _prune(now: float) -> None:
    for sid in [s for s, e in _buf.items() if now - e["ts"] > KEEP_S]:
        _buf.pop(sid, None)


def _entry(sid: str, iteration, now: float) -> dict:
    e = _buf.get(sid)
    if e is None or e["iter"] != iteration:
        e = _buf[sid] = {"iter": iteration, "text": "", "ts": now, "t0": now, "done": False}
    return e


def on_start(session_id: str = "", iteration=0, surface: str = "", **_) -> None:
    if surface != "bot_room" or not session_id:
        return
    now = time.time()
    with _lock:
        _prune(now)
        _buf[session_id] = {"iter": iteration, "text": "", "ts": now, "t0": now, "done": False}


def on_delta(session_id: str = "", delta=None, kind: str = "text", iteration=0, surface: str = "", **_) -> None:
    if surface != "bot_room" or not session_id or kind != "text" or not isinstance(delta, str) or not delta:
        return
    now = time.time()
    with _lock:
        e = _entry(session_id, iteration, now)
        if len(e["text"]) < CAP:
            e["text"] = (e["text"] + delta)[:CAP]
        e["ts"] = now


def on_end(session_id: str = "", final_text=None, iteration=0, surface: str = "", **_) -> None:
    if surface != "bot_room" or not session_id:
        return
    now = time.time()
    with _lock:
        e = _entry(session_id, iteration, now)
        if isinstance(final_text, str) and final_text.strip():
            e["text"] = final_text[:CAP]
        e["done"], e["ts"] = True, now


def latest(session_ids, since: float = 0) -> dict | None:
    """Réponse la plus récente parmi ces sessions, commencée après ``since`` : ``{"id", "text", "done"}`` ; ``id``
    change à chaque nouvelle réponse du modèle (le texte d'avant des outils devient un texte du fil)."""
    with _lock:
        found = [e for s in session_ids if (e := _buf.get(s)) is not None and e["ts"] >= since]
        if not found:
            return None
        e = max(found, key=lambda x: x["ts"])
        sid = next(s for s in session_ids if _buf.get(s) is e)
        return {"id": f"{sid[-8:]}:{e['iter']}:{round(e['t0'] * 1000)}", "text": e["text"], "done": e["done"]}


def register(ctx) -> None:
    ctx.register_hook("on_stream_start", on_start)
    ctx.register_hook("on_stream_delta", on_delta)
    ctx.register_hook("on_stream_end", on_end)
