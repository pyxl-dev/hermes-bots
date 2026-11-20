"""Ce qui attend d'entrer dans un groupe : résultats des bots, recadrages et demandes suivantes de Yoan.

Mis à jour le 2026-11-17 (GLOSSARY.md « Recadrage », « Demande suivante ») : un message de Yoan pendant une
discussion recadre le bot qui écrit (steer.py) au lieu d'attendre ; il n'est gardé ici que pour entrer dans le
fil du groupe (``steer`` : posé dans son propre fil, déjà traité, il n'ouvre ni n'arrête aucune discussion), ou
parce que le tour a fini sans le lire (``user`` : posé en tête, le bot repart aussitôt avec). Un message ``/q``
(``next``) attend que la discussion ET ses tables rondes soient finies (un arrêt compte), puis part seul et ouvre
sa propre discussion ; les suivants, un par un, dans l'ordre. Historique (2026-11-16, « Message en attente ») :

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


# Un résultat de bot ne reste jamais gardé plus de HOLD_MAX_S derrière une discussion qui s'éternise : il entre alors
# dans le fil en cours (le meneur le lit, la chaîne de relances s'arrête là). Vu le 2026-11-17 : 7 résultats gardés
# 6 h, la discussion en cours ne finissait jamais (groupe bloqué, moteur arrêté sur ce groupe).
HOLD_MAX_S = 600


def plan(items: list[dict], current_thread: str | None, rounds_running: bool = False,
         now: float | None = None) -> list[tuple[list[dict], str, bool]]:
    """Ce qu'il faut poser maintenant, par paquets ``(éléments, fil, clos)`` dans l'ordre ; ``[]`` = tout garder.
    Appelé seulement quand aucun tour du moteur n'est vivant. ``current_thread`` : fil de la discussion en cours ;
    ``rounds_running`` : une table ronde du groupe travaille encore. ``clos`` : le paquet est déjà traité et naît
    fermé (il n'ouvre pas de tour)."""
    now = time.time() if now is None else now
    out: list[tuple[list[dict], str, bool]] = []
    for st in (i for i in items if i.get("kind") == "steer"):
        out.append(([st], st["payload"]["thread_id"], True))
    users = [i for i in items if i.get("kind") == "user"]
    bots = [i for i in items if i.get("kind") == "bot"]
    nxt = [i for i in items if i.get("kind") == "next"]
    if users:
        todo = users + bots
        out.append((todo, current_thread or users[0]["payload"]["thread_id"], all(i.get("closes") for i in todo)))
    elif bots and current_thread is None:
        out.append((bots, bots[0]["payload"]["thread_id"], all(i.get("closes") for i in bots)))
    elif bots and now - min(i["ts"] for i in bots) > HOLD_MAX_S:
        out.append((bots, current_thread, all(i.get("closes") for i in bots)))
    elif nxt and current_thread is None and not rounds_running:
        first = min(nxt, key=lambda i: i["ts"])
        out.append(([first], first["payload"]["thread_id"], False))
    return out


def submit(room_id: str, event_id: str, payload: dict, kind: str, closes: bool = False, who: str | None = None) -> None:
    """Garde un message pour ce groupe ; le moteur le pose au prochain passage entre deux tours (réveillé ici).
    ``closes`` : message déjà traité (question et réponse immédiate du meneur lui-même) ; posé seul, il n'ouvre pas
    de tour de discussion (GLOSSARY.md « Réponse immédiate », 2026-11-17)."""
    text = str((payload or {}).get("text") or "").strip()
    if not room_id or not event_id or not text:
        raise ValueError("room_id, event_id et texte requis")
    item = {"event_id": str(event_id), "kind": kind if kind in ("user", "steer", "next") else "bot", "ts": time.time(),
            "payload": {"text": text, "thread_id": str(payload.get("thread_id") or event_id)},
            **({"closes": True} if closes else {}), **({"who": who} if who else {})}
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


def _rounds_running(room_id: str) -> bool:
    """Une table ronde (ou une réponse immédiate) de ce groupe travaille encore."""
    try:
        from .dispatch import _jobs, _jobs_lock
    except Exception:
        return False
    with _jobs_lock:
        return any(v["room_id"] == room_id and v["status"] == "running" for v in _jobs.values())


def flush(svc, room_id: str, force: bool = False) -> bool:
    """Entre deux tours : pose ce qui doit l'être. Vrai si le groupe a changé. Ne lève jamais.
    Appelé par le moteur entre deux tours, et par ``resume.sweep`` pour un groupe bloqué (le moteur ne le prépare
    plus jusqu'au prochain envoi, donc ne passe plus ici) : ``force`` pose alors les résultats sans attendre."""
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
            batches = plan(items, _current_thread(svc, room), _rounds_running(room_id),
                           now=float("inf") if force else None)
            if not batches:
                return False
            from gateway import hosted_room_discussion as discussion
            from gateway import hosted_rooms
            from gateway.session_hosted_attachments import append_user_event
            gateway_id, epoch = svc._owned_authority(room_id)
            posted, todo = [], []
            for batch, thread, closed in batches:
                for it in batch:
                    payload = discussion.validate_user_payload({**it["payload"], "thread_id": thread})
                    try:
                        append_user_event(svc, room_id=room_id, event_id=hosted_rooms.user_event_id(it["event_id"]),
                                          payload=payload, gateway_id=gateway_id, epoch=epoch)
                    except hosted_rooms.EventConflictError:
                        pass  # déjà dans le groupe (passage précédent interrompu) : rien à refaire
                    posted.append(it["event_id"])
                    todo.append(it)
                # déjà traité (recadrage lu dans le tour, ou question à laquelle le meneur a répondu lui-même) : la
                # discussion naît close, aucun bot ne reprend un tour pour y répondre une seconde fois
                if closed:
                    last = hosted_rooms.user_event_id(batch[-1]["event_id"])
                    with contextlib.suppress(hosted_rooms.EventConflictError):
                        hosted_rooms.append_event(
                            svc.db_path, room_id=room_id, event_id=f"dactivity:{last}:immediate", kind="room.activity",
                            actor={"kind": "gateway", "id": gateway_id},
                            payload={"status": "settled", "reason_code": "answered_immediately", "thread_id": thread,
                                     "discussion_event_id": last},
                            authority_gateway_id=gateway_id, authority_epoch=epoch)
            data = _read()
            data[room_id] = [r for r in data.get(room_id) or [] if r["event_id"] not in posted]
            _write(data)
            thread = batches[-1][1]
        kinds = {k: sum(1 for i in todo if i["kind"] == k) for k in ("user", "bot", "steer", "next")}
        mine = [i["ts"] for i in todo if i["kind"] in ("user", "next")]
        _log("inbox_flush", True, room_id=room_id, **kinds, thread=thread,
             waited_s=round(time.time() - min(i["ts"] for i in todo), 1),
             **({"user_waited_s": round(time.time() - min(mine), 1)} if mine else {}))
        return True
    except Exception as exc:
        _log("inbox_flush", False, room_id=room_id, cause=f"{type(exc).__name__}: {exc}"[:300])
        _hub("Groupe : messages gardés non posés", f"{room_id[:8]} : {str(exc)[:200]}", "4")
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
    """PWA : ``{room_id, event_id, payload: {text, thread_id}, kind?}``. ``kind: "next"`` : demande suivante (/q).
    ``kind: "context"`` : contexte à lire sans y répondre (résumé de reprise d'un groupe recréé) : il entre déjà clos,
    aucun bot ne prend de tour pour lui."""
    p = params or {}
    kind = p.get("kind") if p.get("kind") in ("next", "context") else "user"
    submit(str(p.get("room_id") or ""), str(p.get("event_id") or ""), p.get("payload") or {},
           "user" if kind == "context" else kind, closes=kind == "context")
    return {"ok": True, "held": True, "kind": kind, "client_event_id": p.get("event_id")}


def rpc_cancel(params: dict | None = None, **_) -> dict:
    """PWA : ``{room_id, event_id}`` retire une demande suivante pas encore partie ; renvoie son texte, ou
    ``cancelled: false`` si elle est déjà dans le groupe."""
    p = params or {}
    room_id, event_id = str(p.get("room_id") or ""), str(p.get("event_id") or "")
    with _locked():
        data = _read()
        rows = data.get(room_id) or []
        hit = next((r for r in rows if r["event_id"] == event_id and r["kind"] == "next"), None)
        if hit is not None:
            data[room_id] = [r for r in rows if r is not hit]
            _write(data)
    _log("inbox_cancel", True, room_id=room_id, found=hit is not None)
    return {"cancelled": hit is not None, "text": hit["payload"]["text"] if hit else None}


def rpc_status(params: dict | None = None, **_) -> dict:
    """PWA : messages de Yoan encore gardés pour ce groupe (bulles à remettre après un rechargement)."""
    room_id = str((params or {}).get("room_id") or "")
    return {"held": [{"event_id": i["event_id"], "text": i["payload"]["text"], "ts": i["ts"], "kind": i["kind"],
                      **({"who": i["who"]} if i.get("who") else {})}
                     for i in held(room_id) if i["kind"] in ("user", "steer", "next")]}
