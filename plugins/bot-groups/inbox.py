"""Messages en attente d'un groupe (décidé avec Yoan le 2026-11-16, GLOSSARY.md « Message en attente »).

Le moteur ne mène qu'une discussion à la fois, dans l'ordre d'arrivée, et une discussion dure tant que les bots se
citent : un message de Yoan envoyé pendant ce temps attendait la fin de toute la chaîne, derrière les résultats de
table ronde postés avant lui (vu le 2026-11-16 : 19:03 encore pas lu à 19:12). Ici :

- tout ce qui arrive pendant une discussion (messages de Yoan via la RPC ``inbox.send``, résultats de table ronde,
  voie rapide et ``group_post`` des bots) est gardé dans ``inbox.json`` au lieu d'entrer dans le groupe ;
- entre deux tours (aucun tour du moteur vivant), juste après la publication du tour fini et AVANT que le moteur
  planifie le suivant, ``HostedRoomService._publish_terminal_tasks`` (enveloppé ici) pose dans le groupe :
  * s'il y a au moins un message de Yoan : ses messages puis les résultats gardés, tous dans le fil de la
    discussion en cours. Le moteur ne garde que le dernier message d'un fil : l'ancienne discussion s'arrête là
    (ses relances sont abandonnées), le meneur lit d'un coup tout ce qui vient d'arriver ;
  * sinon (résultats seuls) : rien tant qu'une discussion est en cours, puis tous ensemble dans un même fil.
Le tour en cours n'est jamais coupé : on n'écrit que quand aucun tour n'est vivant.

Journal : ``actions.jsonl`` (``inbox_*``), alerte Hub sur chaque échec ; ``python3 status.py`` compte les messages
gardés. Le fichier survit à un redémarrage : le premier passage du moteur après le redémarrage les pose.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import threading
import time

from . import STATE, _hub, _log

FILE = STATE / "inbox.json"
LOCK = STATE / "inbox.lock"
_tlock = threading.Lock()


@contextlib.contextmanager
def _locked():
    STATE.mkdir(parents=True, exist_ok=True)
    with _tlock, open(LOCK, "a") as fh:
        fcntl.flock(fh, fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(fh, fcntl.LOCK_UN)


def _read() -> dict:
    try:
        data = json.loads(FILE.read_text())
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write(data: dict) -> None:
    data = {k: v for k, v in data.items() if v}
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False))
    tmp.replace(FILE)


def held(room_id: str) -> list[dict]:
    return list(_read().get(room_id) or [])


def plan(items: list[dict], current_thread: str | None) -> tuple[list[dict], str | None]:
    """Ce qu'il faut poser maintenant (dans l'ordre) et dans quel fil ; ``([], None)`` = tout garder.
    Appelé seulement quand aucun tour du moteur n'est vivant. ``current_thread`` : fil de la discussion en cours."""
    users = [i for i in items if i.get("kind") == "user"]
    bots = [i for i in items if i.get("kind") != "user"]
    if users:
        return users + bots, current_thread or users[0]["payload"]["thread_id"]
    if bots and current_thread is None:
        return bots, bots[0]["payload"]["thread_id"]
    return [], None


def submit(room_id: str, event_id: str, payload: dict, kind: str) -> None:
    """Garde un message pour ce groupe ; le moteur le pose au prochain passage entre deux tours (réveillé ici)."""
    text = str((payload or {}).get("text") or "").strip()
    if not room_id or not event_id or not text:
        raise ValueError("room_id, event_id et texte requis")
    item = {"event_id": str(event_id), "kind": "user" if kind == "user" else "bot", "ts": time.time(),
            "payload": {"text": text, "thread_id": str(payload.get("thread_id") or event_id)}}
    with _locked():
        data = _read()
        rows = [r for r in data.get(room_id) or [] if r["event_id"] != item["event_id"]] + [item]
        data[room_id] = rows
        _write(data)
    _log("inbox_held", True, room_id=room_id, kind=item["kind"], chars=len(text))
    _wake()


def _wake() -> None:
    try:
        from .trace import _service
        _service().runtime.wakeup()
    except Exception:
        pass  # hors du gateway ou moteur arrêté : le passage suivant du moteur (5 s au plus) s'en charge


def _current_thread(svc, room: dict) -> str | None:
    from gateway import hosted_room_discussion as discussion
    events = list(svc._policy_snapshot(room).events)
    vroom = discussion.validate_room(room, local_profiles=svc.room_profiles(room))
    pending = discussion._pending_discussion(discussion._validated_events(events, room=vroom))
    return None if pending is None else str(pending.payload["thread_id"])


def _draining() -> bool:
    """Gateway en cours d'arrêt : ``groups.send`` refuse alors tout message (``runtime_draining``) et un tour lancé
    maintenant échouerait. On garde : le fichier survit, le gateway suivant pose (vu en vrai le 2026-11-16)."""
    try:
        from gateway.run_api import _ACTIVE_RUNNER
        return bool(getattr(_ACTIVE_RUNNER, "_draining", False))
    except Exception:
        return False


def flush(svc, room_id: str) -> bool:
    """Entre deux tours : pose ce qui doit l'être. Vrai si le groupe a changé. Ne lève jamais."""
    try:
        if not FILE.exists() or not held(room_id) or _draining():
            return False
        from tui_gateway.hosted_room_service import _LIVE_STATUSES
        if next(iter(svc._list_tasks(room_id, _LIVE_STATUSES)), None) is not None:
            return False
        with _locked():
            items = list(_read().get(room_id) or [])
            if not items:
                return False
            room = svc._room(room_id)
            todo, thread = plan(items, _current_thread(svc, room))
            if not todo:
                return False
            from gateway import hosted_room_discussion as discussion
            from gateway import hosted_rooms
            from gateway.session_hosted_attachments import append_user_event
            gateway_id, epoch = svc._owned_authority(room_id)
            posted = []
            for it in todo:
                payload = discussion.validate_user_payload({**it["payload"], "thread_id": thread})
                try:
                    append_user_event(svc, room_id=room_id, event_id=hosted_rooms.user_event_id(it["event_id"]),
                                      payload=payload, gateway_id=gateway_id, epoch=epoch)
                except hosted_rooms.EventConflictError:
                    pass  # déjà dans le groupe (passage précédent interrompu) : rien à refaire
                posted.append(it["event_id"])
            data = _read()
            data[room_id] = [r for r in data.get(room_id) or [] if r["event_id"] not in posted]
            _write(data)
        n_user = sum(1 for i in todo if i["kind"] == "user")
        _log("inbox_flush", True, room_id=room_id, user=n_user, bot=len(todo) - n_user, thread=thread,
             waited_s=round(time.time() - min(i["ts"] for i in todo), 1))
        return True
    except Exception as exc:
        _log("inbox_flush", False, room_id=room_id, cause=f"{type(exc).__name__}: {exc}"[:300])
        _hub("Groupe : messages en attente non posés", f"{room_id[:8]} : {str(exc)[:200]}", "4")
        return False


def install() -> bool:
    """Enveloppe la publication des tours finis du moteur (une seule fois par processus)."""
    try:
        from tui_gateway import hosted_room_service as hrs
    except Exception:
        return False
    cls = hrs.HostedRoomService
    orig = getattr(cls, "_bot_groups_inbox_orig", None) or cls._publish_terminal_tasks

    def _publish_terminal_tasks(self, room):
        changed = orig(self, room)
        if flush(self, str(room["room_id"])):
            changed = True
        return changed

    cls._bot_groups_inbox_orig = orig
    cls._publish_terminal_tasks = _publish_terminal_tasks
    _log("inbox_install", True)
    return True


def rpc_send(params: dict | None = None, **_) -> dict:
    """PWA : ``{room_id, event_id, payload: {text, thread_id}}`` d'un message de Yoan envoyé pendant une discussion."""
    p = params or {}
    submit(str(p.get("room_id") or ""), str(p.get("event_id") or ""), p.get("payload") or {}, "user")
    return {"ok": True, "held": True, "client_event_id": p.get("event_id")}


def rpc_status(params: dict | None = None, **_) -> dict:
    """PWA : messages de Yoan encore gardés pour ce groupe (bulles à remettre après un rechargement)."""
    room_id = str((params or {}).get("room_id") or "")
    return {"held": [{"event_id": i["event_id"], "text": i["payload"]["text"], "ts": i["ts"]}
                     for i in held(room_id) if i["kind"] == "user"]}
