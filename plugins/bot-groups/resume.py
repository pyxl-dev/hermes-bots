"""Relance automatique des tours de groupe bloqués (demandé le 2026-11-15).

Après un redémarrage du gateway, un tour interrompu reste en « Tour bloqué / Tour en attente » jusqu'à ce que Yoan
clique Réessayer. Ici, une boucle du gateway relit les groupes toutes les 60 s et relance seule chaque tour que le
gateway propose de réessayer (pending_actions kind « retry »). Trois essais au plus par tour ; au-delà, Hub est alerté
et la carte reste pour Yoan. Les tours « discard » (exécution inconnue) ne sont jamais abandonnés d'office.
"""
from __future__ import annotations

import fcntl
import json
import os
import sqlite3
import sys
import threading
import time

from . import ROOT, STATE, _hub, _log, _rpc

PERIOD_S = int(os.environ.get("BOT_GROUPS_SWEEP_S") or 60)  # 60 s en prod ; le gateway de test le baisse (parcours restart sous 30 s)
MAX_TRIES = 3
from . import lifecycle
_tries: dict[str, int] = lifecycle.shared("resume.tries", dict)  # gardé au rechargement à chaud


def _in_gateway() -> bool:
    argv = " ".join(sys.argv)
    return "gateway" in argv and " run" in argv


def sweep() -> int:
    """Une passe : relance les tours « retry » de tous les groupes. Renvoie le nombre de relances."""
    (listing,) = _rpc(("groups.list", {"limit": 50}))
    done = 0
    for room in listing.get("rooms") or []:
        (st,) = _rpc(("groups.state", {"room_id": room["room_id"]}))
        for a in ((st.get("driver_status") or {}).get("pending_actions") or []):
            if a.get("kind") != "retry":
                continue
            if str(a.get("task_id") or "").startswith(STALL_PREFIX):
                _flush_stalled(room["room_id"])  # à chaque passe, même après le dernier essai de relance
            key = f"{room['room_id']}|{a.get('task_id')}|{a.get('execution_generation')}"
            n = _tries.get(key, 0)
            if n >= MAX_TRIES:
                continue
            _tries[key] = n + 1
            params = {k: a.get(k) for k in ("member_id", "task_id", "execution_generation")}
            stalled = str(a.get("task_id") or "").startswith(STALL_PREFIX)
            try:
                _rpc(("groups.retry", {"room_id": room["room_id"], **params}))
                done += 1
                _log("auto_retry", True, room=room.get("name"), member=a.get("member_id"), attempt=n + 1)
            except Exception as exc:
                # groupe bloqué (« Members could not be woken ») : la vraie cause est dans le groupe, pas dans
                # l'erreur de la RPC (« invalid_params »). Alerte dès le premier échec, une fois par blocage.
                cause = (_stall_cause(room["room_id"]) if stalled else None) or str(exc)
                _log("auto_retry", False, room=room.get("name"), member=a.get("member_id"), attempt=n + 1,
                     cause=cause[:300], stalled=stalled)
                if stalled and n == 0:
                    _hub("Groupe bloqué", f"{room.get('name')} : le moteur ne réveille plus les bots ({cause[:200]})."
                         " Les résultats gardés sont posés quand même.", "4")
                elif n + 1 >= MAX_TRIES:
                    _hub("Tour de groupe non relancé", f"{room.get('name')} · {a.get('member_id')} : {cause[:200]}", "4")
    return done


# hosted_room_prepare_stall.RETRY_TASK_PREFIX : la ligne Réessayer d'un groupe dont le moteur ne prépare plus les tours
STALL_PREFIX = "prepare:"


def _stall_cause(room_id: str) -> str | None:
    """Le dernier « member.unavailable » du groupe (prepare_failed) : la cause lisible du blocage."""
    try:
        db = sqlite3.connect(f"file:{ROOT / 'state.db'}?mode=ro", uri=True, timeout=10)
        try:
            row = db.execute("select payload_json from hosted_room_events where room_id = ? and kind = "
                             "'member.unavailable' order by seq desc limit 1", (room_id,)).fetchone()
        finally:
            db.close()
        return (str(json.loads(row[0]).get("error") or "") or None) if row else None
    except Exception:
        return None


def _flush_stalled(room_id: str) -> None:
    """Groupe bloqué : le moteur ne passe plus entre deux tours, donc l'inbox ne se vide plus (7 résultats gardés
    6 h la nuit du 2026-11-17). On pose ici, tout de suite, ce qui attend, sous le verrou du moteur."""
    from . import inbox
    if not inbox.held(room_id):
        return
    try:
        from .trace import _service
        svc = _service()
    except Exception as exc:
        _log("inbox_flush", False, room_id=room_id, stalled=True, cause=str(exc)[:200])
        return
    with svc._policy_lock:
        inbox.flush(svc, room_id, force=True)


# Un tour du moteur refusé pendant un redémarrage finit « failed » (runtime_draining), état terminal sans bouton
# Réessayer : 4 tours sur 5 perdus le 2026-11-16 à 00:33. Le moteur (hermes-agent) n'est pas modifié ; le tour est
# rejoué en coulisse avec son prompt d'origine, et la réponse est postée au nom du bot (dispatch.relaunch).
RELAUNCH_FILE = STATE / "relaunched.json"
RELAUNCH_WINDOW_S = 3 * 3600


def relaunch_drained() -> int:
    try:
        done = set(json.loads(RELAUNCH_FILE.read_text()))
    except (OSError, ValueError):
        done = set()
    db = sqlite3.connect(f"file:{ROOT / 'state.db'}?mode=ro", uri=True, timeout=10)
    try:
        rows = db.execute(
            "select room_id, task_id, payload_json from hosted_room_driver_tasks where status = 'failed' "
            "and result_json like '%runtime_draining%' and updated_at > ?", (time.time() - RELAUNCH_WINDOW_S,)).fetchall()
        todo = []
        for room_id, task_id, payload in rows:
            if task_id in done:
                continue
            p = json.loads(payload)
            member, seq = p.get("target_member_id") or p.get("target_profile"), int(p.get("source_event_seq") or 0)
            # le bot a parlé depuis : son tour a été rejoué autrement, rien à faire
            spoke = db.execute(
                "select 1 from hosted_room_events where room_id = ? and seq > ? and kind = 'message.member' "
                "and json_extract(actor_json, '$.id') = ? limit 1", (room_id, seq, member)).fetchone()
            todo.append((room_id, task_id, member, p.get("prompt") or "", bool(spoke)))
    finally:
        db.close()
    from . import dispatch
    n = 0
    for room_id, task_id, member_id, prompt, spoke in todo:
        if spoke or not prompt:
            done.add(task_id)
            continue
        try:
            room, _ctx, lead = dispatch._room_and_lead(room_id)
        except Exception as exc:
            _log("relaunch_drained", False, room_id=room_id, task_id=task_id, cause=str(exc)[:200])
            continue
        members = room.get("members", [])
        m = next((x for x in members if x.get("member_id") == member_id), None)
        if m is None or room.get("disbanded_at"):
            done.add(task_id)
            continue
        handles = {str(x.get("handle") or "").casefold() for x in members} - {""}
        jid = dispatch.relaunch(room_id, m, prompt, (lead or {}).get("handle"), handles, room.get("name") or "",
                                "Tour coupé par le redémarrage du gateway, rejoué")
        if jid:
            done.add(task_id)
            n += 1
            _log("relaunch_drained", True, room_id=room_id, task_id=task_id, bot=m.get("handle"), job=jid)
    STATE.mkdir(parents=True, exist_ok=True)
    RELAUNCH_FILE.write_text(json.dumps(sorted(done)))
    return n


def _loop(gen: int) -> None:
    """Boucle de fond du chargement ``gen`` : s'arrête dès qu'un chargement plus récent existe (rechargement à chaud)."""
    pend = lifecycle.shared("resume.boot_pending", lambda: [False])  # reprise des voies rapides encore à faire
    ready = lifecycle.shared("resume.ready_at", lambda: [0.0])
    if lifecycle.once("resume.boot"):  # une fois par processus : au démarrage du gateway, pas à chaque rechargement
        pend[0] = True
        try:
            from . import dispatch
            dispatch.recover_jobs()  # tâches parallèles lancées avant le redémarrage : la barre les montre tout de suite
        except Exception as exc:
            _log("dispatch_recovered", False, cause=str(exc)[:300])
        ready[0] = time.time() + int(os.environ.get("BOT_GROUPS_RESUME_DELAY_S") or 45)  # laisser le gateway finir de démarrer
    # chargements en rafale (une copie par profil) : seul le dernier tourne ; jamais avant la fin du démarrage
    if not lifecycle.wait(gen, max(2.0, ready[0] - time.time())):
        return  # un chargement plus récent prend la suite, reprise comprise (pend reste vrai)
    if pend[0]:
        _recover_side()
    while True:
        try:
            from . import dispatch
            dispatch.flush_unposted()  # résultats de table ronde refusés pendant un redémarrage
        except Exception as exc:
            _log("dispatch_reposted", False, cause=str(exc)[:300])
        try:
            sweep()
        except Exception as exc:
            _log("auto_retry_sweep", False, cause=str(exc)[:300])
        try:
            relaunch_drained()
        except Exception as exc:
            _log("relaunch_drained", False, cause=str(exc)[:300])
        if not lifecycle.wait(gen, PERIOD_S):
            _log("resume_loop_handover", True, gen=gen, next=lifecycle.current())
            return


def _recover_side() -> None:
    lifecycle.shared("resume.boot_pending", lambda: [False])[0] = False
    try:
        from . import dispatch
        dispatch.recover_side()  # messages en voie rapide coupés par le redémarrage
    except Exception as exc:
        _log("side_recovered", False, cause=str(exc)[:300])


def start(gen: int) -> None:
    if not _in_gateway():
        return
    STATE.mkdir(parents=True, exist_ok=True)
    held = lifecycle.shared("resume.lock", lambda: [None])
    if held[0] is None:  # un seul gateway par dossier d'état : verrou pris une fois par processus, gardé au rechargement
        lock = open(STATE / "resume.lock", "w")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            lock.close()
            return  # un autre processus tient la boucle
        held[0] = lock
    threading.Thread(target=_loop, name="bot-groups-resume", daemon=True, args=(gen,)).start()
