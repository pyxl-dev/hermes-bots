"""Fil de travail des bots de groupe (décidé avec Yoan le 2026-11-16, besoin dans la PWA : docs/fil-de-travail.md).

Un fil = ce qu'un bot a fait pour produire un résultat : outils (nom, arguments, sortie) et textes
intermédiaires. Pas de réflexion. Deux sources :

- tours du moteur de groupe : la session cachée du bot (``Group: <room_id>``, source ``bot_room``) dans le
  ``state.db`` de son profil garde chaque appel d'outil, sa sortie et les textes intermédiaires ; les tâches et
  leurs heures viennent de ``hosted_room_driver_tasks`` (``state.db`` du gateway), en lecture seule. Le hook
  ``on_room_member_activity`` du gateway n'est PAS utilisé : vérifié en réel le 2026-11-16, il ne tire pas pour
  les membres de ces groupes (le gateway lit leur outil courant par interrogation du membre, pas par ce hook).
- table ronde (``dispatch.py``) : le flux stream-json du ``.out`` de la tâche est lu pendant qu'elle tourne,
  puis compacté dans ``traces/<room_id>/r-<jid>.jsonl`` par ``_finish`` avant que le ``.out`` soit effacé.

Après coup : un fil du moteur fini est copié en version compacte (``traces/<room_id>/<task_id>.jsonl``, balayage
toutes les 5 min et à la lecture) : les 30 jours ne dépendent pas de la durée de vie de la session Hermes.
Journal : ``actions.jsonl`` (``trace_*``), ``python3 status.py``, alerte Hub sur chaque échec (une par 10 min).
RPC : ``trace.list``, ``trace.read`` ; arrêt d'un seul bot : ``member.stop`` ; arrêt de la table ronde d'un
groupe : ``dispatch.stop`` (le bouton Arrêter du groupe ne l'arrêtait pas).
"""
from __future__ import annotations

import contextlib
import json
import os
import re
import sqlite3
import sys
import threading
import time
import types
import uuid
from pathlib import Path

from . import STATE, _hub, _log

DIR = STATE / "traces"
KEEP_S = 30 * 86400
OUT_CAP = 4000          # signes gardés de la sortie d'un outil
ARG_CAP = 1500          # signes gardés par valeur d'argument
TEXT_CAP = 6000
LIST_CAP = 400
_ID_RE = re.compile(r"[^A-Za-z0-9_.-]")

# Une copie du plugin par profil (voir dispatch.py) : l'état partagé vit dans un module du processus.
_SHARED = sys.modules.get("_hermes_bot_groups_trace")
if _SHARED is None:
    _SHARED = types.ModuleType("_hermes_bot_groups_trace")
    _SHARED.lock = threading.RLock()
    _SHARED.known = set()
    _SHARED.alert_at, _SHARED.purged_at, _SHARED.sweeper = 0.0, 0.0, False
    sys.modules["_hermes_bot_groups_trace"] = _SHARED
_lock = _SHARED.lock


def _fid(value: str) -> str:
    return _ID_RE.sub("_", str(value))[:120]


def _room_dir(room_id: str) -> Path:
    return DIR / _fid(room_id)


def _fail(where: str, exc: Exception, **extra) -> None:
    _log("trace_failed", False, where=where, cause=str(exc)[:300], **extra)
    now = time.time()
    if now - _SHARED.alert_at > 600:
        _SHARED.alert_at = now
        _hub("Fil de travail : échec", f"{where} : {str(exc)[:200]}", "4")


# ---------- écriture ----------
def _append(path: Path, op: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock, path.open("a") as f:
        f.write(json.dumps(op, ensure_ascii=False) + "\n")


def _index_op(room_id: str, op: dict) -> None:
    _append(_room_dir(room_id) / "index.jsonl", {"ts": time.time(), **op})


def _short(value, cap=ARG_CAP):
    if isinstance(value, str):
        return value if len(value) <= cap else value[:cap] + "..."
    if isinstance(value, dict):
        return {str(k): _short(v, cap) for k, v in list(value.items())[:30]}
    if isinstance(value, list):
        return [_short(v, cap) for v in value[:30]]
    return value


def _out_text(result) -> str:
    text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, default=str)
    return text if len(text) <= OUT_CAP else text[:OUT_CAP] + "..."


def _is_error(result) -> bool:
    if isinstance(result, dict):
        code = result.get("exit_code")
        return bool(result.get("error")) or (isinstance(code, int) and code != 0)
    return False


# ---------- tours du moteur : session Hermes du bot ----------
GATEWAY_DB = Path.home() / ".hermes" / "state.db"


def _ro(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    con.row_factory = sqlite3.Row
    return con


def _profile_db(profile: str) -> Path:
    home = Path.home() / ".hermes"
    return home / "state.db" if profile in ("", "default") else home / "profiles" / profile / "state.db"


def engine_tasks(room_id: str, since: float | None = None) -> list[dict]:
    """Tâches du moteur démarrées pour ce groupe (``hosted_room_driver_tasks``, lecture seule)."""
    since = since if since is not None else time.time() - KEEP_S
    try:
        with contextlib.closing(_ro(GATEWAY_DB)) as con:
            rows = con.execute(
                "select task_id, status, started_at, terminal_at, updated_at, execution_generation, payload_json "
                "from hosted_room_driver_tasks where room_id = ? and started_at is not null and started_at > ? "
                "order by started_at", (room_id, since)).fetchall()
    except sqlite3.Error as exc:
        _fail("engine_tasks", exc, room_id=room_id)
        return []
    out = []
    for r in rows:
        try:
            payload = json.loads(r["payload_json"])
        except ValueError:
            payload = {}
        tid = r["task_id"]
        out.append({"tid": tid, "kind": "engine", "member_id": str(payload.get("target_member_id") or payload.get("target_profile") or ""),
                    "profile": str(payload.get("target_profile") or payload.get("target_member_id") or ""),
                    "started": r["started_at"], "ended": r["terminal_at"],
                    "status": {"running": "running", "stopping": "running", "queued": "running", "settled": "done", "failed": "failed",
                               "cancelled": "stopped"}.get(r["status"], "done"),
                    "label": "", "event_id": "dmessage:" + tid.split(":", 1)[1] if tid.startswith("dtask:") else None})
    return out


def engine_ops(room_id: str, row: dict) -> list[dict]:
    """Opérations normalisées d'un tour du moteur, lues dans la session ``Group: <room_id>`` du profil du bot : de
    son message d'ouverture (rôle user, à l'heure du démarrage de la tâche) jusqu'au message user suivant."""
    try:
        with contextlib.closing(_ro(_profile_db(row["profile"]))) as con:
            msgs = con.execute(
                "select m.role, m.content, m.tool_calls, m.tool_call_id, m.timestamp from messages m join sessions s on s.id = m.session_id "
                "where s.title = ? and m.timestamp >= ? order by m.timestamp, m.id",
                (f"Group: {room_id}", float(row["started"]) - 5)).fetchall()
    except sqlite3.Error as exc:
        _fail("engine_ops", exc, room_id=room_id, member=row.get("member_id"))
        return []
    ops: list[dict] = []
    opened = False
    for m in msgs:
        if m["role"] == "user":
            if opened:
                break
            opened = True
            continue
        if not opened:
            continue
        ts = m["timestamp"]
        if m["role"] == "assistant":
            calls = []
            with contextlib.suppress(ValueError, TypeError):
                calls = json.loads(m["tool_calls"] or "[]")
            if not calls:
                continue  # sans appel d'outil : la réponse finale, déjà postée dans le groupe
            text = (m["content"] or "").strip()
            if text:
                ops.append({"o": "text", "text": text[:TEXT_CAP], "ts": ts})
            for c in calls:
                fn = c.get("function") or {}
                args = {}
                with contextlib.suppress(ValueError, TypeError):
                    args = json.loads(fn.get("arguments") or "{}")
                ops.append({"o": "tool", "id": str(c.get("id") or c.get("call_id") or ""), "name": str(fn.get("name") or "?"),
                            "args": _short(args if isinstance(args, dict) else {"value": args}), "ts": ts})
        elif m["role"] == "tool":
            out, err = m["content"] or "", False
            with contextlib.suppress(ValueError, TypeError):
                parsed = json.loads(out)
                if isinstance(parsed, dict):
                    err = _is_error(parsed)
                    if parsed.get("output") is not None and len(parsed) <= 4:
                        out = parsed["output"]
            ops.append({"o": "result", "id": str(m["tool_call_id"] or ""), "output": _out_text(out), "err": err, "ms": None, "ts": ts})
    return ops


def snapshot_engine(room_id: str, row: dict) -> bool:
    """Copie compacte d'un fil du moteur fini (survit à la session Hermes). Vrai si écrite maintenant."""
    path = _room_dir(room_id) / f"{_fid(row['tid'])}.jsonl"
    if path.exists() or row["status"] == "running":
        return False
    ops = engine_ops(room_id, row)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in ops))
    tmp.replace(path)
    return True


def sweep(window_s: float = 2 * 86400) -> int:
    """Copie les fils du moteur finis récemment, pour tous les groupes (appelé toutes les 5 min)."""
    n = 0
    try:
        with contextlib.closing(_ro(GATEWAY_DB)) as con:
            rooms = [r[0] for r in con.execute("select distinct room_id from hosted_room_driver_tasks where started_at > ?", (time.time() - window_s,))]
    except sqlite3.Error as exc:
        _fail("sweep", exc)
        return 0
    for room_id in rooms:
        for row in engine_tasks(room_id, time.time() - window_s):
            try:
                n += snapshot_engine(room_id, row)
            except Exception as exc:
                _fail("snapshot", exc, room_id=room_id, task=row["tid"])
    return n


def _sweeper() -> None:
    while True:
        time.sleep(300)
        with contextlib.suppress(Exception):
            sweep()
            purge()


# ---------- table ronde : flux stream-json du .out ----------
def ops_from_stream(text: str) -> list[dict]:
    """Opérations normalisées d'un flux ``hermes chat --format stream-json``. Le texte qui suit le dernier outil
    est la réponse finale (déjà postée dans le groupe) : il n'est pas gardé."""
    ops, buf, n = [], "", 0
    for line in text.splitlines():
        try:
            ev = json.loads(line)
        except ValueError:
            continue
        if not isinstance(ev, dict):
            continue
        kind, ts = ev.get("type"), (ev.get("timestamp") or 0) / 1000 or None
        if kind == "text":
            buf += str(ev.get("text") or "")
        elif kind == "tool_use":
            if buf.strip():
                ops.append({"o": "text", "text": buf.strip()[:TEXT_CAP], "ts": ts})
            buf, n = "", n + 1
            ops.append({"o": "tool", "id": str(ev.get("tool_call_id") or f"t{n}"), "name": str(ev.get("name") or "?"),
                        "args": _short(ev.get("input") or {}), "ts": ts})
        elif kind == "tool_result":
            out = ev.get("output")
            with contextlib.suppress(ValueError, TypeError):
                parsed = json.loads(out) if isinstance(out, str) else None
                if isinstance(parsed, dict) and parsed.get("output") is not None and len(parsed) <= 4:
                    out = parsed["output"]
            ops.append({"o": "result", "id": str(ev.get("tool_call_id") or f"t{n}"), "output": _out_text(out if out is not None else ""),
                        "err": bool(ev.get("is_error")), "ms": ev.get("duration_ms"), "ts": ts})
        elif kind == "result":
            buf = ""
    return ops


def round_start(jid: str, meta: dict) -> None:
    """Fiche de début d'une tâche de table ronde (une seule par ``jid``, même relancée)."""
    tid = f"r-{jid}"
    try:
        with _lock:
            if tid in _SHARED.known:
                return
            _SHARED.known.add(tid)
            _index_op(meta["room_id"], {"o": "start", "tid": tid, "member_id": meta.get("bot"), "kind": "round",
                                        "started": float(meta.get("started") or time.time()), "jid": jid,
                                        "label": str(meta.get("task") or "")[:160]})
    except Exception as exc:
        _fail("round_start", exc, jid=jid)


def round_link(jid: str, room_id: str, event_id: str) -> None:
    """Le message de résultat posté dans le groupe : la bulle retrouve ainsi son fil."""
    try:
        # le groupe range un message posté sous « user:<sha256 de l'id envoyé> » (gateway/hosted_rooms.user_event_id)
        import hashlib
        served = "user:" + hashlib.sha256(str(event_id).encode("utf-8")).hexdigest()
        _index_op(room_id, {"o": "link", "tid": f"r-{jid}", "event_id": served})
    except Exception as exc:
        _fail("round_link", exc, jid=jid)


def round_finish(jid: str, meta: dict, status: str, cause: str = "") -> None:
    """Appelé par ``_finish`` avant d'effacer le ``.out`` : le fil compact reste 30 jours."""
    from .dispatch import JOBS_DIR
    tid, room_id = f"r-{jid}", meta["room_id"]
    try:
        out = JOBS_DIR / f"{jid}.out"
        ops = ops_from_stream(out.read_text(errors="replace")) if out.exists() else []
        path = _room_dir(room_id) / f"{_fid(tid)}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("".join(json.dumps(o, ensure_ascii=False) + "\n" for o in ops))
        _index_op(room_id, {"o": "end", "tid": tid, "status": status, "cause": cause[:300]})
    except Exception as exc:
        _fail("round_finish", exc, jid=jid)


# ---------- lecture ----------
def _fold_index(room_id: str) -> dict[str, dict]:
    rows: dict[str, dict] = {}
    try:
        lines = (_room_dir(room_id) / "index.jsonl").read_text().splitlines()
    except OSError:
        return rows
    for line in lines:
        try:
            op = json.loads(line)
        except ValueError:
            continue
        tid, kind = op.get("tid"), op.get("o")
        if kind == "start":
            rows[tid] = {k: op.get(k) for k in ("tid", "member_id", "kind", "started", "label", "jid", "event_id")}
        elif tid in rows and kind == "link":
            rows[tid]["event_id"] = op.get("event_id")
        elif tid in rows and kind == "end":
            rows[tid].update(status=op.get("status"), ended=op.get("ts"), cause=op.get("cause"))
    return rows


def _round_running(row: dict) -> bool:
    from .dispatch import _meta_path
    return bool(row.get("jid")) and _meta_path(row["jid"]).exists()


def _status(row: dict) -> str:
    if row["kind"] == "engine":
        return row["status"]
    if row.get("status"):
        return row["status"]
    return "running" if _round_running(row) else "done"


def _rows(room_id: str) -> dict[str, dict]:
    """Tous les fils connus d'un groupe : table ronde (index) et moteur (tâches du gateway)."""
    rows = _fold_index(room_id)
    for r in engine_tasks(room_id):
        rows[r["tid"]] = r
    return rows


def purge() -> int:
    """Efface les fils de plus de 30 jours (appelé au plus une fois par heure)."""
    now = time.time()
    if now - _SHARED.purged_at < 3600 or not DIR.exists():
        return 0
    _SHARED.purged_at, gone = now, 0
    with _lock:
        for rdir in DIR.iterdir():
            if not rdir.is_dir():
                continue
            for f in rdir.glob("*.jsonl"):
                if f.name != "index.jsonl" and now - f.stat().st_mtime > KEEP_S:
                    f.unlink(missing_ok=True)
                    gone += 1
            idx = rdir / "index.jsonl"
            if idx.exists():
                keep = []
                for line in idx.read_text().splitlines():
                    try:
                        if now - float(json.loads(line).get("ts") or now) <= KEEP_S:
                            keep.append(line)
                    except ValueError:
                        pass
                if len(keep) != len(idx.read_text().splitlines()):
                    idx.write_text("".join(l + "\n" for l in keep))
    if gone:
        _log("trace_purged", True, files=gone)
    return gone


def rpc_list(params: dict | None = None, **_) -> dict:
    """PWA : fils d'un groupe des 30 derniers jours (les plus récents d'abord), pour poser la réaction sur les
    bulles qui ont un fil et ouvrir les onglets des fils en cours. ``member_id`` filtre sur un bot."""
    p = params or {}
    room_id = str(p.get("room_id") or "")
    if not room_id:
        raise ValueError("room_id manquant")
    purge()
    rows = list(_rows(room_id).values())
    member = str(p.get("member_id") or "")
    if member:
        rows = [r for r in rows if r.get("member_id") == member]
    rows = [r for r in rows if time.time() - float(r.get("started") or 0) <= KEEP_S]
    out = [{"trace_id": r["tid"], "member_id": r.get("member_id"), "kind": r["kind"], "started": r.get("started"),
            "ended": r.get("ended"), "status": _status(r), "label": r.get("label") or "",
            "event_id": r.get("event_id")} for r in rows]
    out.sort(key=lambda r: r["started"] or 0, reverse=True)
    if p.get("running"):
        out = [r for r in out if r["status"] == "running"]
    return {"room_id": room_id, "traces": out[:LIST_CAP], "keep_days": KEEP_S // 86400}


def _entries(row: dict, room_id: str) -> list[dict]:
    if row["kind"] == "round" and _round_running(row):
        from .dispatch import JOBS_DIR
        try:
            ops = ops_from_stream((JOBS_DIR / f"{row['jid']}.out").read_text(errors="replace"))
        except OSError:
            ops = []
    elif row["kind"] == "engine" and not (_room_dir(room_id) / f"{_fid(row['tid'])}.jsonl").exists():
        ops = engine_ops(room_id, row)
        if row["status"] != "running":
            with contextlib.suppress(Exception):
                snapshot_engine(room_id, row)
    else:
        try:
            lines = (_room_dir(room_id) / f"{_fid(row['tid'])}.jsonl").read_text().splitlines()
        except OSError:
            return []
        ops = []
        for line in lines:
            with contextlib.suppress(ValueError):
                ops.append(json.loads(line))
    entries, by_id = [], {}
    finished = _status(row) != "running"
    for op in ops:
        kind = op.get("o")
        if kind == "tool":
            e = {"n": len(entries), "k": "tool", "id": op["id"], "name": op["name"], "args": op.get("args") or {},
                 "state": "running", "ts": op.get("ts")}
            entries.append(e)
            by_id[op["id"]] = e
        elif kind == "result":
            e = by_id.get(op["id"])
            if e is not None:
                e.update(state="error" if op.get("err") else "done", output=op.get("output") or "", ms=op.get("ms"))
        elif kind == "text":
            entries.append({"n": len(entries), "k": "text", "text": op.get("text") or "", "ts": op.get("ts")})
        elif kind == "retry":
            entries.append({"n": len(entries), "k": "retry", "ts": op.get("ts")})
    if finished:
        for e in entries:
            if e["k"] == "tool" and e["state"] == "running":
                e.update(state="error", output="(interrompu)")
    return entries


def rpc_read(params: dict | None = None, **_) -> dict:
    """PWA : un fil. ``after`` = dernier ``n`` déjà reçu ; ``open`` = ids d'outils encore affichés « en cours »
    (renvoyés même s'ils sont plus anciens que ``after``, pour passer à « fini »)."""
    p = params or {}
    room_id, tid = str(p.get("room_id") or ""), str(p.get("trace_id") or "")
    row = _rows(room_id).get(tid)
    if row is None:
        raise ValueError("fil introuvable ou expiré")
    after = int(p.get("after") if p.get("after") is not None else -1)
    opened = set(p.get("open") or [])
    entries = _entries(row, room_id)
    status = _status(row)
    return {"trace_id": tid, "member_id": row.get("member_id"), "kind": row["kind"], "status": status,
            "label": row.get("label") or "", "started": row.get("started"), "ended": row.get("ended"),
            "total": len(entries),
            "entries": [e for e in entries if e["n"] > after or e.get("id") in opened]}


# ---------- arrêt d'un seul bot ----------
def _service():
    """Le service des groupes du moteur : il vit sur l'autorité de session du gateway (``authority.hosted_room_service``),
    pas dans ``tui_gateway.methods_groups`` (vérifié en réel le 2026-11-16 : ``get_hosted_room_service()`` y répond None)."""
    from gateway.run_api import _ACTIVE_RUNNER
    from gateway.session_authorities import active_authority
    authority = active_authority(_ACTIVE_RUNNER) if _ACTIVE_RUNNER is not None else None
    svc = getattr(authority, "hosted_room_service", None)
    status = svc.runtime.status() if svc is not None else {}
    if svc is None or not status.get("running") or status.get("stopping"):
        raise RuntimeError("le moteur de groupes n'est pas démarré")
    return svc


def _stop_engine(room_id: str, member_id: str) -> int:
    from tui_gateway.hosted_room_service import _STOPPABLE_STATUSES, task_member_id
    svc = _service()
    cancel_id = f"member-stop:{uuid.uuid4().hex[:12]}"
    stopped = 0
    with svc._room_approval_stop_lock(room_id):
        tasks = [t for t in svc._list_tasks(room_id, _STOPPABLE_STATUSES) if task_member_id(t) == member_id]
        ids = {(t["identity"].task_id, t.get("execution_generation")) for t in tasks}
        with svc._policy_lock, svc._state_lock:
            for key in [k for k, a in svc._pending_actions.items() if k[0] == room_id
                        and (a.get("task_id"), a.get("execution_generation")) in ids]:
                svc._pending_actions.pop(key, None)
        for t in tasks:
            own = t.get("status") == "stopping" and str(t.get("cancel_id") or "")
            svc.runtime.cancel(t["identity"], cancel_id=own or cancel_id)
            stopped += 1
        svc.runtime.wakeup()
    return stopped


def _stop_round(room_id: str, member_id: str | None) -> int:
    from . import dispatch
    return dispatch.stop_jobs(room_id, member_id)


def rpc_member_stop(params: dict | None = None, **_) -> dict:
    """PWA : arrête ce seul bot (ses tours du moteur et ses tâches de table ronde), le reste du groupe continue."""
    p = params or {}
    room_id, member_id = str(p.get("room_id") or ""), str(p.get("member_id") or "")
    if not room_id or not member_id:
        raise ValueError("room_id et member_id requis")
    errors, engine, rnd = [], 0, 0
    try:
        engine = _stop_engine(room_id, member_id)
    except Exception as exc:
        errors.append(f"moteur : {exc}")
    try:
        rnd = _stop_round(room_id, member_id)
    except Exception as exc:
        errors.append(f"table ronde : {exc}")
    ok = not errors
    _log("member_stop", ok, room_id=room_id, member_id=member_id, engine=engine, round=rnd, cause="; ".join(errors)[:300] or None)
    if not ok:
        _hub("Arrêt d'un bot : échec", f"{member_id} : {'; '.join(errors)[:300]}", "4")
        raise RuntimeError("; ".join(errors))
    return {"ok": True, "member_id": member_id, "engine": engine, "round": rnd}


def rpc_dispatch_stop(params: dict | None = None, **_) -> dict:
    """PWA : le bouton Arrêter du groupe arrête aussi la table ronde (``groups.stop`` ne la connaît pas)."""
    room_id = str((params or {}).get("room_id") or "")
    if not room_id:
        raise ValueError("room_id manquant")
    try:
        n = _stop_round(room_id, None)
    except Exception as exc:
        _log("dispatch_stop", False, room_id=room_id, cause=str(exc)[:300])
        _hub("Arrêt de la table ronde : échec", f"{room_id} : {str(exc)[:200]}", "4")
        raise
    _log("dispatch_stop", True, room_id=room_id, stopped=n)
    return {"ok": True, "stopped": n}


def register(ctx) -> None:
    ctx.register_rpc("trace.list", rpc_list)
    ctx.register_rpc("trace.read", rpc_read)
    ctx.register_rpc("member.stop", rpc_member_stop)
    ctx.register_rpc("dispatch.stop", rpc_dispatch_stop)
    if not _SHARED.sweeper:
        _SHARED.sweeper = True
        threading.Thread(target=_sweeper, name="bot-groups-trace-sweeper", daemon=True).start()
    _log("trace_register", True, pid=os.getpid(), home=os.environ.get("HERMES_HOME", ""))
    purge()
