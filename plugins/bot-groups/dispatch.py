"""group_dispatch : le meneur fait travailler plusieurs bots en même temps (décidé par Yoan le 2026-11-14).

Le moteur de groupes de Hermes ne lance qu'un tour de bot à la fois par salle (planificateur, pilote et
reprise sont câblés ainsi). Pour une table ronde, le meneur appelle ``group_dispatch`` avec une tâche par
bot : chaque bot travaille en coulisse dans sa propre session « Groupe · <nom> » (``hermes -p <bot> chat
-Q --query-file``), tous en même temps. Quand un bot a fini, son résultat est posté dans le groupe sous
la forme ``[bot] résultat`` suivie de ``@meneur`` : la mention réveille le meneur, qui reprend la main.
La PWA affiche ces messages comme ceux du bot.

Garde-fous : seul le meneur répartit, seulement vers des membres du groupe, une tâche en cours par bot et
par groupe, 6 tâches en même temps en tout, 30 minutes au plus par tâche.
Journal : ~/.hermes/data/bot-groups/actions.jsonl (``dispatch``, ``dispatch_done``, ``dispatch_failed``),
``python3 status.py``, alerte Hub sur chaque échec. Une tâche survit à un redémarrage du gateway (processus
détaché, fiche dans data/bot-groups/jobs, reprise par ``recover_jobs``).
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import signal
import subprocess
import threading
import time
import uuid
from pathlib import Path

from . import STATE, _caller, _hub, _log, _rpc, _text, inbox

HERMES = Path.home() / ".local" / "bin" / "hermes"
MAX_RUNNING = 6
TIMEOUT_S = 30 * 60
KEEP_DONE_S = 15 * 60
CONTEXT_MESSAGES = 12

# Hermes charge une copie du plugin par profil (hermes_plugins.bot_groups__home_<digest>, plugins_loader.py) :
# un état de module serait propre à chaque copie. La copie du meneur lançait les tâches, celle qui répond à la
# PWA ne les voyait pas (barre vide, limite et « déjà occupé » contournés ; constaté le 2026-11-16). L'état des
# tâches est donc partagé dans tout le processus.
import sys as _sys
import types as _types

_SHARED = _sys.modules.get("_hermes_bot_groups_shared")
if _SHARED is None:
    _SHARED = _types.ModuleType("_hermes_bot_groups_shared")
    _SHARED.jobs, _SHARED.jobs_lock = {}, threading.Lock()
    _SHARED.side, _SHARED.side_lock = {}, threading.Lock()
    _SHARED.park_lock = threading.Lock()
    _sys.modules["_hermes_bot_groups_shared"] = _SHARED
_jobs: dict[str, dict] = _SHARED.jobs   # job_id -> {room_id, bot, task, started, status, ended?, cause?}
_jobs_lock = _SHARED.jobs_lock


def _room_and_lead(room_id: str) -> tuple[dict, dict, dict | None]:
    (st,) = _rpc(("groups.state", {"room_id": room_id}))
    room, ctx = st["room"], st.get("context") or {}
    lead = next((m for m in room.get("members", []) if ctx.get("routing") == "lead"
                 and m.get("member_id") == ctx.get("lead_member_id")), None)
    return room, ctx, lead


def _recent(room_id: str, members: list[dict]) -> str:
    events, since = [], 0
    while True:
        (page,) = _rpc(("groups.log", {"room_id": room_id, "since_seq": since, "limit": 500}))
        events += page.get("events", [])
        since = max(since, page.get("cursor") or 0)
        if not page.get("has_more") or not page.get("events"):
            break
    names = {m.get("member_id"): m.get("display_name") or m.get("handle") or m.get("member_id") for m in members}
    lines = []
    for ev in events:
        text = _text((ev.get("payload") or {}).get("text")).strip()
        if not text:
            continue
        if ev.get("kind") == "message.user":
            who = "Yoan"
            m = re.match(r"^\[([\w.-]+)\] ", text)
            if m:
                who, text = names.get(m.group(1), m.group(1)), text[m.end():]
        elif ev.get("kind") == "message.member":
            a = ev.get("actor") or {}
            who = a.get("display_name") or names.get(a.get("id")) or a.get("profile") or "?"
        else:
            continue
        lines.append(f"- {who} : {text[:800]}")
    return "\n".join(lines[-CONTEXT_MESSAGES:]) or "(aucun)"


def _neutralize(text: str, handles: set[str]) -> str:
    """Les @handle des membres dans un résultat ne doivent réveiller personne : seul le meneur est cité."""
    return re.sub(r"@([A-Za-z0-9][\w.:-]*)", lambda m: "@​" + m.group(1) if m.group(1).casefold() in handles else m.group(0), text)


def _post(room_id: str, bot: str, body: str, lead_handle: str | None, event_id: str | None = None) -> None:
    text = f"[{bot}] {body[:7500]}" + (f"\n\n@{lead_handle}" if lead_handle and lead_handle != bot else "")
    try:
        _send(room_id, text, event_id)
    except Exception as exc:
        # Toujours gardé : un refus classé « durable » à tort effaçait le résultat (alpha-session, 2026-11-16 01:59).
        # flush_unposted le reposte à la minute et alerte Hub au bout d'une heure.
        _park(room_id, bot, text, exc, event_id)
        if not _transient(exc):
            _log("dispatch_parked_unknown", False, room_id=room_id, bot=bot, cause=str(exc)[:200])


def _send(room_id: str, text: str, event_id: str | None = None) -> None:
    # gardé puis posé par le moteur entre deux tours, après les messages de Yoan (inbox.py)
    event_id = event_id or str(uuid.uuid4())
    inbox.submit(room_id, event_id, {"text": text, "thread_id": event_id}, "bot")


# Résultat refusé pendant un redémarrage du gateway (drain, port fermé) : gardé sur disque et reposté quand le
# gateway répond de nouveau, au lieu d'être perdu (4 résultats perdus le 2026-11-16 vers 00:20).
PARK_FILE = STATE / "unposted.jsonl"
_park_lock = _SHARED.park_lock


MAX_TRIES = 20          # relances d'une tâche coupée par un redémarrage (20 × 30 s : le drain dure jusqu'à 31 min)
RETRY_WAIT_S = int(os.environ.get("BOT_GROUPS_RETRY_WAIT_S") or 30)  # 30 s en prod ; le gateway de test le baisse


_INTERRUPTED = re.compile(r"Gateway restarting: this turn was interrupted|turn was interrupted and will not be run", re.I)


def _transient_cause(cause: str) -> bool:
    if _INTERRUPTED.search(cause):
        return True
    # « Gateway draining: not_ready » : un appel du tour tombé pendant le drain (GatewayUnavailableError de
    # hermes_cli/gateway_client.py) ; posé comme un échec du bot au lieu d'être relancé (group-journey, 2026-11-16)
    return bool(re.search(r"runtime_draining|Gateway (draining|starting|stopping|restarting)\b|gateway_(draining|starting)|couldn't start the model connection|Errno 61|Connection refused|"
                          r"ConnectionClosed|HTTP 50[23]|gateway.{0,40}(unavailable|unreachable|indisponible)", cause, re.I))


def _transient(exc: Exception) -> bool:
    # HTTP 403 : le gateway qui démarre refuse le websocket quelques secondes (résultat de alpha-session perdu le
    # 2026-11-16 à 01:59) ; un vrai refus durable finit en alerte Hub au bout d'une heure dans flush_unposted
    # Errno 2 : gateway.sock absent le temps du redémarrage (parcours restart, 2026-11-16)
    return bool(re.search(r"runtime_draining|Errno 61|Errno 2\]|Connect call failed|Connection refused|HTTP 50[23]|HTTP 403|"
                          r"rejected WebSocket|ConnectionClosed|timed out", str(exc), re.I))


def _park(room_id: str, bot: str, text: str, exc: Exception, event_id: str | None = None) -> None:
    rec = {"ts": time.time(), "room_id": room_id, "bot": bot, "event_id": event_id or str(uuid.uuid4()), "text": text}
    with _park_lock:
        STATE.mkdir(parents=True, exist_ok=True)
        with PARK_FILE.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    _log("dispatch_parked", True, room_id=room_id, bot=bot, cause=str(exc)[:200])


def flush_unposted() -> int:
    """Reposte les résultats gardés. Le même event_id est réutilisé : un double envoi reste un seul message.
    Ce qui échoue encore reste dans le fichier pour le prochain passage."""
    with _park_lock:
        try:
            recs = [json.loads(l) for l in PARK_FILE.read_text().splitlines() if l.strip()]
        except OSError:
            return 0
        left, n = [], 0
        for r in recs:
            try:
                _send(r["room_id"], r["text"], r["event_id"])
                n += 1
                _log("dispatch_reposted", True, room_id=r["room_id"], bot=r["bot"], waited=round(time.time() - r["ts"]))
            except Exception as exc:
                left.append(r)
                if time.time() - r["ts"] > 3600:
                    _hub("Table ronde : résultat non posté depuis 1 h", f"{r['bot']} : {str(exc)[:200]}", "4")
        PARK_FILE.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in left))
    return n


def _final_result(stdout: str) -> dict:
    """Dernier événement ``result`` du flux ``--format stream-json`` de ``hermes chat`` ({} s'il manque)."""
    last = {}
    for line in stdout.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if isinstance(ev, dict) and ev.get("type") == "result":
            last = ev
    return last


# Une tâche tourne dans un processus détaché (nouvelle session) dont la sortie va dans un fichier, avec une fiche
# sur disque : un redémarrage du gateway ne la tue plus, et la boucle de reprise poste son résultat (défaut 7 du
# 2026-11-16 : une tâche en cours mourait avec le thread du gateway).
JOBS_DIR = STATE / "jobs"


def _meta_path(jid: str) -> Path:
    return JOBS_DIR / f"{jid}.json"


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    # un enfant fini mais pas encore récolté reste « vivant » pour kill(0)
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
        return done == 0
    except ChildProcessError:
        return True


def _spawn(jid: str, prompt: str, session: str, meta: dict) -> None:
    """Lance ``hermes chat`` détaché et écrit la fiche de la tâche. Lève OSError si le lancement échoue."""
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    qfile, out, err = JOBS_DIR / f"{jid}.query", JOBS_DIR / f"{jid}.out", JOBS_DIR / f"{jid}.err"
    qfile.write_text(prompt)
    with out.open("w") as fo, err.open("w") as fe:
        p = subprocess.Popen([str(HERMES), "-p", meta["bot"], "chat", "--in", str(Path.home()), "--continue", session,
                              "--create-if-missing", "-Q", "--format", "stream-json", "--query-file", str(qfile)],
                             stdin=subprocess.DEVNULL, stdout=fo, stderr=fe, start_new_session=True)
    meta = {**meta, "jid": jid, "pid": p.pid, "session": session, "started_try": time.time()}
    from . import trace
    trace.round_start(jid, meta)
    tmp = _meta_path(jid).with_suffix(".tmp")
    tmp.write_text(json.dumps(meta, ensure_ascii=False))
    tmp.replace(_meta_path(jid))


def _poster(meta: dict):
    # L'id du message de résultat est choisi ici et noté dans le fil : la bulle du groupe retrouve ainsi son fil.
    eid = str(uuid.uuid4())
    if meta.get("jid"):
        from . import trace
        trace.round_link(meta["jid"], meta["room_id"], eid)
    if meta.get("kind") == "side":
        return lambda body: _side_post(meta["side_id"], meta["bot"], body, meta["lead_handle"], eid)
    return lambda body: _post(meta["room_id"], meta["bot"], body, meta["lead_handle"], eid)


def _watch(jid: str) -> None:
    """Attend la fin du processus de la tâche (enfant ou hérité d'un gateway précédent), puis la termine."""
    meta = json.loads(_meta_path(jid).read_text())
    pid, started = int(meta["pid"]), float(meta.get("started_try") or meta["started"])
    timed_out = False
    while _alive(pid):
        if time.time() - started > TIMEOUT_S:
            with contextlib.suppress(OSError):
                os.killpg(pid, signal.SIGTERM)
            timed_out = True
            time.sleep(5)
            with contextlib.suppress(OSError):
                os.killpg(pid, signal.SIGKILL)
            break
        time.sleep(2)
    _finish(jid, meta, timed_out)


def _stop_requested(jid: str) -> bool:
    if (_jobs.get(jid) or {}).get("stop"):
        return True
    try:
        return bool(json.loads(_meta_path(jid).read_text()).get("stop"))
    except (OSError, ValueError):
        return False


def _finish_stopped(jid: str, meta: dict, job: dict) -> None:
    """Arrêt demandé par Yoan (un bot ou tout le groupe) : pas de post d'échec, pas de relance."""
    from . import trace
    trace.round_finish(jid, meta, "stopped")
    if meta.get("kind") == "side":
        _side_abort(meta["side_id"], meta["room_id"])
    for ext in ("json", "query", "out", "err"):
        (JOBS_DIR / f"{jid}.{ext}").unlink(missing_ok=True)
    _end(jid, job, meta["room_id"], meta["bot"], "stopped", "arrêté par Yoan", "", meta)


def stop_jobs(room_id: str, member: str | None) -> int:
    """Arrête les tâches de table ronde d'un groupe (``member`` : un seul bot, profil ou member_id). Le processus
    reçoit SIGTERM sur son groupe ; ``_watch`` le voit mort et ``_finish`` ne poste rien."""
    n = 0
    with _jobs_lock:
        todo = [(jid, v) for jid, v in _jobs.items()
                if v["room_id"] == room_id and v["status"] == "running" and (member is None or v["bot"] == member)]
        for jid, v in todo:
            v["stop"] = True
    for jid, v in todo:
        try:
            meta = json.loads(_meta_path(jid).read_text())
            meta["stop"] = True
            tmp = _meta_path(jid).with_suffix(".tmp")
            tmp.write_text(json.dumps(meta, ensure_ascii=False))
            tmp.replace(_meta_path(jid))
            with contextlib.suppress(OSError):
                os.killpg(int(meta["pid"]), signal.SIGTERM)
        except (OSError, ValueError):
            pass  # fiche absente : la tâche est déjà en train de finir, le drapeau en mémoire suffit
        n += 1
    return n


def _finish(jid: str, meta: dict, timed_out: bool) -> None:
    job = _jobs.get(jid) or {}
    if _stop_requested(jid):
        return _finish_stopped(jid, meta, job)
    room_id, bot, handles = meta["room_id"], meta["bot"], set(meta.get("handles") or [])
    post = _poster(meta)
    status, cause, out, diag = "failed", "", "", ""
    try:
        diag = " ".join(((JOBS_DIR / f"{jid}.out").read_text(errors="replace")[-3000:] + " "
                         + (JOBS_DIR / f"{jid}.err").read_text(errors="replace")[-3000:]).split())
    except OSError:
        pass
    try:
        # Seule la réponse finale part dans le groupe : la sortie texte de -Q mêlait les diffs des fichiers écrits
        # par le bot (7 Ko de « │ +... » le 2026-11-15) et la coupe à 7 500 signes faisait disparaître la réponse.
        res = _final_result((JOBS_DIR / f"{jid}.out").read_text(errors="replace"))
        out = (res.get("text") or "").strip()
        if timed_out:
            cause = f"délai de {TIMEOUT_S // 60} min dépassé"
        elif _INTERRUPTED.search(out):
            # tour coupé par un redémarrage : hermes renvoie ce texte comme une réponse normale (alpha-session, 01:59)
            cause = out[:300]
        elif out and not res.get("error"):
            status = "done"
        else:
            errt = (JOBS_DIR / f"{jid}.err").read_text(errors="replace").strip()
            # message d'erreur de hermes coupé sur plusieurs lignes : on garde le texte entier, recollé
            cause = str(res.get("error") or " ".join(errt.split()[-60:]) or "réponse vide")[:300]
    except Exception as exc:
        cause = str(exc)[:300]
    # `hermes chat` passe par le gateway : pendant un drain ou une coupure il échoue (« runtime_draining »). Ce n'est
    # pas un échec du bot : la tâche est relancée dans la même session, ici ou par le gateway suivant (recover_jobs).
    tries = int(meta.get("tries") or 0)
    if status != "done" and not timed_out and _transient_cause(cause + " " + diag) and tries < MAX_TRIES:
        _log("dispatch_retry", True, room_id=room_id, bot=bot, attempt=tries + 1, cause=cause[:200])
        time.sleep(RETRY_WAIT_S)
        if _stop_requested(jid):
            return _finish_stopped(jid, meta, job)
        try:
            _spawn(jid, (JOBS_DIR / f"{jid}.query").read_text(), meta["session"], {**meta, "tries": tries + 1})
            threading.Thread(target=_watch, args=(jid,), name=f"dispatch-{bot}", daemon=True).start()
            return
        except Exception as exc:
            cause = f"relance impossible : {exc}"[:300]
    try:
        if status == "done":
            post(_neutralize(out, handles))
        else:
            post(f"Je n'ai pas pu finir la tâche confiée : {cause}.")
    except Exception as exc:
        status, cause = "failed", f"résultat non posté : {exc}"[:300]
    from . import trace
    trace.round_finish(jid, meta, status, cause)
    for ext in ("json", "query", "out", "err"):
        (JOBS_DIR / f"{jid}.{ext}").unlink(missing_ok=True)
    _end(jid, job, room_id, bot, status, cause, out, meta)


def recover_jobs() -> int:
    """Au démarrage du gateway : reprend la surveillance des tâches lancées par le processus précédent (toujours en
    cours, ou finies sans que leur résultat soit posté). Les messages en voie rapide qu'elles portent ne sont plus
    repostés par ``recover_side``."""
    try:
        metas = [json.loads(p.read_text()) for p in JOBS_DIR.glob("*.json")]
    except OSError:
        return 0
    side_left: dict[str, int] = {}
    with _jobs_lock:
        for m in metas:
            if m["jid"] in _jobs:
                continue
            _jobs[m["jid"]] = {k: m.get(k) for k in ("room_id", "room", "bot", "handle", "name", "task", "started",
                                                     "kind", "side_id", "question")} | {"status": "running"}
            if m.get("kind") == "side":
                side_left[m["side_id"]] = side_left.get(m["side_id"], 0) + 1
    if side_left:
        try:
            pending = json.loads(SIDE_FILE.read_text())
        except (OSError, ValueError):
            pending = {}
        with _side_lock:
            for sid, n in side_left.items():
                rec = pending.pop(sid, None)
                if rec:
                    _side[sid] = {**rec, "left": n, "question_posted": False}
            _side_save()
    for m in metas:
        threading.Thread(target=_watch, args=(m["jid"],), name=f"dispatch-{m['bot']}", daemon=True).start()
        _log("dispatch_recovered", True, room_id=m["room_id"], bot=m["bot"], alive=_alive(int(m["pid"])))
    return len(metas)


def _run(job_id: str, prompt: str, session: str, meta: dict) -> None:
    try:
        _spawn(job_id, prompt, session, meta)
    except Exception as exc:
        cause = f"lancement impossible : {exc}"[:300]
        try:
            _poster(meta)(f"Je n'ai pas pu finir la tâche confiée : {cause}.")
        except Exception as exc2:
            cause = f"résultat non posté : {exc2}"[:300]
        _end(job_id, _jobs[job_id], meta["room_id"], meta["bot"], "failed", cause, "", meta)
        return
    _watch(job_id)


def relaunch(room_id: str, member: dict, prompt: str, lead_handle: str | None, handles: set[str], room_name: str,
             label: str) -> str | None:
    """Rejoue en coulisse un tour du moteur perdu (resume.relaunch_drained). Renvoie l'id de tâche, ou None si le bot
    travaille déjà pour ce groupe ou si la limite est atteinte."""
    bot = member.get("profile") or member.get("member_id")
    with _jobs_lock:
        running = [v for v in _jobs.values() if v["status"] == "running"]
        if len(running) >= MAX_RUNNING or any(v["room_id"] == room_id and v["bot"] == bot for v in running):
            return None
        jid = uuid.uuid4().hex[:12]
        _jobs[jid] = {"room_id": room_id, "room": room_name, "bot": bot, "handle": member.get("handle"),
                      "name": member.get("display_name") or member.get("handle"), "task": label[:200],
                      "started": time.time(), "status": "running", "kind": "relaunch"}
        meta = {**_jobs[jid], "lead_handle": lead_handle, "handles": sorted(handles)}
    session = f"Groupe · {room_name or room_id}"[:80]
    threading.Thread(target=_run, args=(jid, prompt, session, meta), name=f"relaunch-{bot}", daemon=True).start()
    return jid


def _end(jid: str, job: dict, room_id: str, bot: str, status: str, cause: str, out: str, meta: dict) -> None:
    with _jobs_lock:
        job.update(status=status, ended=time.time(), cause=cause or None)
    dur = round(time.time() - float(job.get("started") or meta["started"]))
    if status == "done":
        _log("dispatch_done", True, room_id=room_id, bot=bot, seconds=dur, chars=len(out))
    elif status == "stopped":
        _log("dispatch_stopped", True, room_id=room_id, bot=bot, seconds=dur)
    else:
        _log("dispatch_failed", False, room_id=room_id, bot=bot, seconds=dur, cause=cause)
        _hub("Table ronde : tâche en échec", f"{bot} dans {job.get('room') or meta.get('room')} : {cause}", "4")


def group_dispatch(args: dict, _peer_ok: bool = False, **kw) -> str:
    """_peer_ok : appel interne de fanout pour un bot non meneur qui cite des coéquipiers (1.17.0)."""
    import json
    me, room_id = _caller(), str(args.get("room_id") or "")
    raw = args.get("assignments") or []

    def err(msg: str) -> str:
        _log("dispatch", False, caller=me, room_id=room_id, cause=msg)
        return json.dumps({"ok": False, "error": msg}, ensure_ascii=False)

    if not isinstance(raw, list) or not raw:
        return err("donne au moins une tâche : assignments = [{bot, task}]")
    try:
        room, ctx, lead = _room_and_lead(room_id)
    except Exception as exc:
        return err(f"groupe introuvable : {exc}")
    members = room.get("members", [])
    by_key = {}
    for m in members:
        for k in (m.get("profile"), m.get("member_id"), m.get("handle")):
            if k:
                by_key[str(k).casefold()] = m
    me_member = by_key.get(me.casefold())
    if me_member is None:
        return err("tu n'es pas membre de ce groupe")
    is_lead = lead is not None and lead.get("member_id") == me_member.get("member_id")
    if not is_lead and not _peer_ok:
        return err("seul le meneur du groupe peut répartir le travail")
    picked, seen = [], set()
    for a in raw:
        if not isinstance(a, dict):
            return err("chaque tâche est un objet {bot, task}")
        m = by_key.get(str(a.get("bot") or "").lstrip("@").casefold())
        task = str(a.get("task") or "").strip()
        if m is None:
            return err(f"« {a.get('bot')} » n'est pas membre du groupe ; membres : {', '.join(x.get('handle') or '' for x in members)}")
        if m.get("member_id") == me_member.get("member_id"):
            return err("ne te confie pas de tâche à toi-même : fais ta part directement dans ton tour")
        if not task:
            return err(f"tâche vide pour {m.get('handle')}")
        if m.get("member_id") in seen:
            return err(f"une seule tâche par bot ({m.get('handle')} apparaît deux fois)")
        seen.add(m.get("member_id"))
        picked.append((m, task[:4000]))
    now = time.time()
    with _jobs_lock:
        for jid in [j for j, v in _jobs.items() if v["status"] != "running" and now - v.get("ended", now) > KEEP_DONE_S]:
            _jobs.pop(jid, None)
        running = [v for v in _jobs.values() if v["status"] == "running"]
        busy = [m.get("handle") for m, _ in picked if any(v["room_id"] == room_id and v["bot"] == (m.get("profile") or m.get("member_id")) for v in running)]
        if busy:
            return err(f"déjà en train de travailler pour ce groupe : {', '.join(busy)} ; attends son résultat")
        if len(running) + len(picked) > MAX_RUNNING:
            return err(f"au plus {MAX_RUNNING} tâches en même temps ({len(running)} en cours)")
        try:
            history = _recent(room_id, members)
        except Exception as exc:
            return err(f"lecture du groupe impossible : {exc}")
        handles = {str(m.get("handle") or "").casefold() for m in members} - {""}
        lead_handle, lead_name = me_member.get("handle"), me_member.get("display_name") or me_member.get("handle")
        session = f"Groupe · {room.get('name', room_id)}"[:80]
        started = []
        for m, task in picked:
            bot = m.get("profile") or m.get("member_id")
            others = ", ".join((x.get("display_name") or x.get("handle")) for x, _ in picked if x is not m) or "personne"
            prompt = (
                f"[Table ronde « {room.get('name')} »] Tu es {m.get('display_name') or m.get('handle')}. "
                + (f"Le meneur, {lead_name}, te confie une tâche que tu fais en même temps que d'autres membres "
                   f"({others}). Ton résultat sera posté tel quel dans le groupe, puis le meneur reprendra la main.\n\n"
                   if is_lead else
                   f"Ton coéquipier {lead_name} s'adresse à toi ; tu lui réponds en même temps que d'autres membres "
                   f"({others}). Ton résultat sera posté tel quel dans le groupe, puis {lead_name} reprendra la main.\n\n")
                + f"But du groupe : {ctx.get('purpose') or '(non précisé)'}\n"
                f"Notes partagées : {ctx.get('notes') or '(aucune)'}\n\n"
                f"Derniers messages du groupe :\n{history}\n\n{_board(room_id)}\n\n"
                f"Ta tâche :\n{task}\n\n"
                "Fais le travail maintenant avec tes outils. Réponds uniquement par ton résultat final, clair et "
                "complet, sans formule de politesse et sans citer personne avec @.")
            jid = uuid.uuid4().hex[:12]
            _jobs[jid] = {"room_id": room_id, "room": room.get("name"), "bot": bot, "handle": m.get("handle"),
                          "name": m.get("display_name") or m.get("handle"), "task": task[:200],
                          "started": now, "status": "running"}
            meta = {**_jobs[jid], "lead_handle": lead_handle, "handles": sorted(handles), "kind": "dispatch"}
            threading.Thread(target=_run, args=(jid, prompt, session, meta),
                             name=f"dispatch-{bot}", daemon=True).start()
            started.append(m.get("handle"))
    _log("dispatch", True, caller=me, room_id=room_id, bots=started)
    return json.dumps({"ok": True, "started": started, "note": (
        "Ils travaillent en même temps. Chaque résultat sera posté dans le groupe et te citera : tu reprendras la "
        "main à ce moment-là. En attendant, fais ta propre part et dis à Yoan qui travaille sur quoi, sans citer "
        "les bots avec @ (une mention lancerait un tour de plus).")}, ensure_ascii=False)


def rpc_status(params: dict | None = None, **_) -> dict:
    """Pour la PWA : les tâches en cours (et finies depuis peu) d'un groupe."""
    room_id = str((params or {}).get("room_id") or "")
    now = time.time()
    with _jobs_lock:
        jobs = [{"bot": v["bot"], "handle": v["handle"], "name": v["name"], "task": v["task"],
                 "status": v["status"], "seconds": round((v.get("ended") or now) - v["started"]),
                 "kind": v.get("kind", "dispatch"), "side_id": v.get("side_id"), "question": v.get("question")}
                for v in _jobs.values() if v["room_id"] == room_id
                and (v["status"] == "running" or now - v.get("ended", now) < KEEP_DONE_S)]
    return {"room_id": room_id, "jobs": jobs}


SCHEMA = {
    "name": "group_dispatch",
    "description": (
        "Table ronde : si tu es le meneur d'un groupe, fais travailler plusieurs membres EN MÊME TEMPS au lieu "
        "de les citer un par un. Donne une tâche précise par bot ; chacun travaille en coulisse, puis son "
        "résultat est posté dans le groupe et te cite pour que tu reprennes la main. Ne te confie rien à "
        "toi-même : fais ta part dans ton tour. Ne cite pas avec @ les bots à qui tu viens de répartir le "
        "travail (cela lancerait en plus leur tour normal, l'un après l'autre)."),
    "parameters": {"type": "object", "properties": {
        "room_id": {"type": "string", "description": "le groupe (voir group_list)"},
        "assignments": {"type": "array", "description": "une tâche par bot", "items": {
            "type": "object", "properties": {
                "bot": {"type": "string", "description": "handle ou profil du membre"},
                "task": {"type": "string", "description": "ce qu'il doit produire, avec le contexte utile"}},
            "required": ["bot", "task"]}}},
        "required": ["room_id", "assignments"]},
}


# ---------- voie rapide : Yoan écrit à un bot libre pendant qu'une autre discussion occupe le groupe ----------
# Décidé par Yoan le 2026-11-15. Le moteur de groupes ne lance qu'un tour à la fois : un message à @bot-rh restait
# en file derrière la discussion alpha / alpha-net. Ici la PWA confie le message au plugin, le bot répond en
# coulisse tout de suite (même mécanique que la table ronde), puis la question et la réponse sont postées
# ensemble dans un même fil : la réponse étant le dernier message du fil, le moteur ne relance jamais la
# question, et la mention du meneur en fin de réponse lui rend la main. Seulement dans un groupe à meneur,
# vers des membres autres que le meneur (sinon la réponse citerait son propre auteur).
# Un message en cours survit à un redémarrage : ``recover_side`` le reposte dans la file normale.
SIDE_FILE = STATE / "side-pending.json"
_side: dict[str, dict] = _SHARED.side   # side_id -> {room_id, text, left, question_posted}
_side_lock = _SHARED.side_lock


def _board(room_id: str) -> str:
    try:
        from . import tasks
        return tasks.prompt_block(room_id)
    except Exception as exc:
        _log("task_failed", False, room_id=room_id, op="prompt_block", cause=str(exc)[:200])
        return ""


def _side_save() -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    tmp = SIDE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps({k: {"room_id": v["room_id"], "text": v["text"], "started": v["started"]}
                               for k, v in _side.items() if not v["question_posted"]}, ensure_ascii=False))
    tmp.replace(SIDE_FILE)


def _side_abort(side_id: str, room_id: str) -> None:
    """Message en voie rapide dont le bot a été arrêté : la question de Yoan est quand même postée (sans réponse,
    sans mention du meneur), pour que le fil de discussion garde sa trace."""
    with _side_lock:
        rec = _side.get(side_id)
        if rec is None:
            return
        if not rec["question_posted"]:
            inbox.submit(rec["room_id"], side_id, {"text": rec["text"], "thread_id": side_id}, "bot")
            rec["question_posted"] = True
        rec["left"] -= 1
        if rec["left"] <= 0:
            _side.pop(side_id, None)
        _side_save()


def _side_post(side_id: str, bot: str, body: str, mention: str, event_id: str | None = None) -> None:
    with _side_lock:
        rec = _side[side_id]
        if not rec["question_posted"]:
            inbox.submit(rec["room_id"], side_id, {"text": rec["text"], "thread_id": side_id}, "bot")
        inbox.submit(rec["room_id"], event_id or str(uuid.uuid4()),
                     {"text": f"[{bot}] {body[:7500]}\n\n@{mention}", "thread_id": side_id}, "bot")
        rec["question_posted"] = True
        rec["left"] -= 1
        if rec["left"] <= 0:
            _side.pop(side_id, None)
        _side_save()


def rpc_side(params: dict | None = None, **_) -> dict:
    """PWA : ``{room_id, text, members: [handle], side_id}``. Lève ValueError si la voie rapide ne s'applique pas :
    la PWA envoie alors le message normalement (il attend son tour)."""
    p = params or {}
    room_id, text, side_id = str(p.get("room_id") or ""), str(p.get("text") or "").strip(), str(p.get("side_id") or "")
    if not text or not re.fullmatch(r"[0-9a-f-]{16,64}", side_id):
        raise ValueError("texte ou side_id manquant")
    room, ctx, lead = _room_and_lead(room_id)
    if lead is None:
        raise ValueError("voie rapide réservée aux groupes à meneur")
    members = room.get("members", [])
    by_handle = {str(m.get("handle") or "").casefold(): m for m in members}
    picked = []
    for h in p.get("members") or []:
        m = by_handle.get(str(h).lstrip("@").casefold())
        if m is None:
            raise ValueError(f"{h} n'est pas membre du groupe")
        if m.get("member_id") == lead.get("member_id"):
            raise ValueError("le meneur répond dans la file normale")
        if m not in picked:
            picked.append(m)
    if not picked:
        raise ValueError("aucun membre cité")
    (st,) = _rpc(("groups.state", {"room_id": room_id}))
    acts = (st.get("driver_status") or {}).get("member_activity") or []
    busy = [m.get("handle") for m in picked if any(a.get("member_id") == m.get("member_id") for a in acts)]
    now = time.time()
    with _jobs_lock:
        running = [v for v in _jobs.values() if v["status"] == "running"]
        busy += [m.get("handle") for m in picked if any(
            v["room_id"] == room_id and v["bot"] == (m.get("profile") or m.get("member_id")) for v in running)]
        if busy:
            raise ValueError(f"déjà au travail dans ce groupe : {', '.join(busy)}")
        if len(running) + len(picked) > MAX_RUNNING:
            raise ValueError(f"au plus {MAX_RUNNING} tâches en coulisse en même temps")
        history = _recent(room_id, members)
        handles = {str(m.get("handle") or "").casefold() for m in members} - {""}
        session = f"Groupe · {room.get('name', room_id)}"[:80]
        with _side_lock:
            _side[side_id] = {"room_id": room_id, "text": text, "left": len(picked), "question_posted": False,
                              "started": now}
            _side_save()
        for m in picked:
            bot = m.get("profile") or m.get("member_id")
            name = m.get("display_name") or m.get("handle")
            prompt = (
                f"[Groupe « {room.get('name')} »] Tu es {name}. Yoan t'écrit directement pendant qu'une autre "
                "discussion occupe le groupe : tu lui réponds en parallèle, en coulisse. Ta réponse sera postée "
                f"telle quelle dans le groupe sous ton nom, juste après son message, puis le meneur "
                f"{lead.get('display_name') or lead.get('handle')} reprendra la main.\n\n"
                f"But du groupe : {ctx.get('purpose') or '(non précisé)'}\n"
                f"Notes partagées : {ctx.get('notes') or '(aucune)'}\n\n"
                f"Derniers messages du groupe :\n{history}\n\n{_board(room_id)}\n\n"
                f"Message de Yoan :\n{text}\n\n"
                "Fais le travail maintenant avec tes outils. Réponds uniquement par ton résultat, clair et complet, "
                "sans formule de politesse et sans citer personne avec @ (une mention lancerait un tour du groupe).")
            jid = uuid.uuid4().hex[:12]
            _jobs[jid] = {"room_id": room_id, "room": room.get("name"), "bot": bot, "handle": m.get("handle"),
                          "name": name, "task": text[:200], "started": now, "status": "running",
                          "kind": "side", "side_id": side_id, "question": text[:2000]}
            meta = {**_jobs[jid], "lead_handle": lead.get("handle"), "handles": sorted(handles)}
            threading.Thread(target=_run, args=(jid, prompt, session, meta),
                             name=f"side-{bot}", daemon=True).start()
    _log("side", True, room_id=room_id, bots=[m.get("handle") for m in picked])
    return {"ok": True, "side_id": side_id, "started": [m.get("handle") for m in picked]}


def recover_side() -> int:
    """Au démarrage du gateway : un message en voie rapide dont la question n'a jamais été postée (gateway
    redémarré pendant le travail) est reposté tel quel, il prend sa place dans la file normale."""
    try:
        left = json.loads(SIDE_FILE.read_text())
    except (OSError, ValueError):
        return 0
    n = 0
    for side_id, rec in (left or {}).items():
        try:
            inbox.submit(rec["room_id"], side_id, {"text": rec["text"], "thread_id": side_id}, "bot")
            n += 1
            _log("side_recovered", True, room_id=rec["room_id"])
        except Exception as exc:
            _log("side_recovered", False, room_id=rec.get("room_id"), cause=str(exc)[:300])
            _hub("Voie rapide : message non reposté", f"{rec.get('room_id')} : {str(exc)[:200]}", "4")
    SIDE_FILE.unlink(missing_ok=True)
    return n
