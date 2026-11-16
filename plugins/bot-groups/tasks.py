"""Tableau du groupe : ses tâches de groupe (GLOSSARY.md « Tâche de groupe », « Tableau du groupe »).

Revu avec Yoan le 2026-11-16. Le premier tableau (2026-11-15) créait une tâche à chaque message de Yoan et ne la
fermait que si un bot pensait à appeler ``done`` : « go », « voilà j'ai bougé » restaient « en cours » des heures
(29 tâches en cours dans le groupe alpha). Désormais :

- **Création par le meneur.** Le message de Yoan part sans tâche. Le meneur en crée une, avec un titre court,
  seulement pour une demande de travail ; elle est liée à la discussion en cours (``thread``, ``messages``).
  Une réponse, une relance ou une info se rattache à la tâche existante (``action=link``).
- **Fermeture à la fin de la discussion.** Quand le moteur écrit qu'une discussion est terminée
  (``room.activity`` settled ou bounded, voir ``install``), chaque tâche liée à un fil qui n'a plus de discussion
  en cours passe « faite », avec la dernière réponse d'un bot comme preuve. Sauf : bloquée, gardée en cours par
  un bot (``hold``, posé quand un bot la passe lui-même en ``doing``), sous-tâches ouvertes, ou table ronde encore
  au travail dans le groupe (elle se ferme alors à la fin de la discussion qui suit le dernier résultat).
- **Rattrapage par Jev.** Une discussion terminée sans aucune tâche liée : Jev juge en une passe si le message de
  Yoan était une demande de travail, traitée ou pas. Traitée : tâche créée « faite » ; en suspens : « à faire ».

Stockage : ``~/.hermes/data/bot-groups/tasks/<room_id>.json``. Journal : ``actions.jsonl`` (``task_add``,
``task_update``, ``task_link``, ``task_remove``, ``task_settle``, ``task_jev``, ``task_failed``),
``python3 status.py``, alerte Hub sur chaque échec inattendu.
"""
from __future__ import annotations

import json
import re
import sqlite3
import subprocess
import sys
import threading
import time
import types
from pathlib import Path

from . import STATE, _caller, _hub, _log, _rpc

DIR = STATE / "tasks"
STATUSES = ("todo", "doing", "blocked", "done")
LABEL = {"todo": "à faire", "doing": "en cours", "blocked": "bloquée", "done": "faite"}
MAX_OPEN = 200
PROMPT_LINES = 30
JEV = Path.home() / ".local" / "bin" / "jev"
JEV_MIN_CONFIDENCE = 0.7
BOT_MSG_RE = re.compile(r"^\[[\w.:-]+\] ")          # résultat de table ronde ou group_post : pas un message de Yoan
QUOTE_RE = re.compile(r"^>\s*↩[^\n]*?»\s*", re.S)  # « > ↩ @bot : « citation » » devant un message de réponse
_ROOM_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
# Une copie du plugin par profil dans le même processus (voir dispatch.py) : le verrou du fichier est partagé.
_SHARED = sys.modules.get("_hermes_bot_groups_tasks_shared")
if _SHARED is None:
    _SHARED = types.ModuleType("_hermes_bot_groups_tasks_shared")
    _SHARED.lock, _SHARED.jev_alert = threading.Lock(), 0.0
    sys.modules["_hermes_bot_groups_tasks_shared"] = _SHARED
_lock = _SHARED.lock


def _path(room_id: str):
    if not _ROOM_RE.match(room_id or ""):
        raise ValueError("room_id invalide")
    return DIR / f"{room_id}.json"


def _load(room_id: str) -> dict:
    try:
        data = json.loads(_path(room_id).read_text())
        return data if isinstance(data, dict) and isinstance(data.get("tasks"), list) else {"seq": 0, "tasks": []}
    except FileNotFoundError:
        return {"seq": 0, "tasks": []}


def _save(room_id: str, data: dict) -> None:
    DIR.mkdir(parents=True, exist_ok=True)
    path = _path(room_id)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    tmp.replace(path)


def _clean(v, n: int) -> str:
    return " ".join(str(v or "").split())[:n]


def short_title(text: str, n: int = 100) -> str:
    """Titre lisible tiré d'un message : sans la citation de réponse, coupé au mot."""
    t = _clean(QUOTE_RE.sub("", str(text or "")), 400) or _clean(text, 400)
    return t if len(t) <= n else t[:n].rsplit(" ", 1)[0] + "…"


def listing(room_id: str) -> list[dict]:
    return _load(room_id)["tasks"]


def _linked(task: dict, event_id: str) -> bool:
    return event_id in (task.get("messages") or []) or task.get("source") == event_id


def add(room_id: str, title: str, by: str, parent: str | None = None, source: str | None = None,
        thread: str | None = None, status: str = "todo", proof: str | None = None) -> dict:
    title = _clean(title, 300)
    if not title:
        raise ValueError("titre de tâche vide")
    with _lock:
        data = _load(room_id)
        if source:
            hit = next((t for t in data["tasks"] if _linked(t, source)), None)
            if hit:
                return hit  # ce message a déjà sa tâche : jamais deux fois
        if parent and not any(t["id"] == parent for t in data["tasks"]):
            raise ValueError(f"tâche parente {parent} introuvable")
        if sum(t["status"] != "done" for t in data["tasks"]) >= MAX_OPEN:
            raise ValueError(f"{MAX_OPEN} tâches ouvertes au plus : termine ou regroupe d'abord")
        data["seq"] = int(data.get("seq") or 0) + 1
        now = time.time()
        task = {"id": f"t{data['seq']}", "parent": parent or None, "title": title, "status": status,
                "owner": by if status == "doing" and by != "yoan" else None, "by": by, "source": source or None,
                "thread": thread or None, "messages": [source] if source else [], "hold": False,
                "proof": _clean(proof, 500) or None, "note": None, "created": now, "updated": now}
        data["tasks"].append(task)
        _save(room_id, data)
    _log("task_add", True, room_id=room_id, id=task["id"], by=by, parent=parent, status=status, linked=bool(source))
    return task


def update(room_id: str, tid: str, by: str, *, is_user: bool, status: str | None = None, title: str | None = None,
           proof: str | None = None, note: str | None = None) -> dict:
    with _lock:
        data = _load(room_id)
        task = next((t for t in data["tasks"] if t["id"] == tid), None)
        if task is None:
            raise ValueError(f"tâche {tid} introuvable")
        if status is not None:
            if status not in STATUSES:
                raise ValueError(f"statut inconnu : {status} ({', '.join(STATUSES)})")
            if status == "done" and not is_user:
                if not _clean(proof, 10):
                    raise ValueError("une tâche faite demande une preuve (proof) : fichier, test, mesure ou message")
                left = [t["id"] for t in data["tasks"] if t.get("parent") == tid and t["status"] != "done"]
                if left:
                    raise ValueError(f"sous-tâches encore ouvertes : {', '.join(left)}")
            if status == "blocked" and not is_user and not _clean(note, 5):
                raise ValueError("une tâche bloquée demande la raison (note)")
            if status == "doing" and not is_user:
                task["owner"] = by
            # un bot qui passe lui-même sa tâche en cours la garde ouverte après la fin de la discussion
            task["hold"] = status == "doing" and not is_user
            if status != "done":
                task["proof"] = None
            task["status"] = status
        if title is not None and _clean(title, 300):
            task["title"] = _clean(title, 300)
        if proof:
            task["proof"] = _clean(proof, 500)
        if note is not None:
            task["note"] = _clean(note, 500) or None
        task["updated"], task["last_by"] = time.time(), by
        _save(room_id, data)
    _log("task_update", True, room_id=room_id, id=tid, by=by, status=task["status"])
    return task


def link(room_id: str, tid: str, by: str, event_id: str, thread: str | None) -> dict:
    """Rattache un message de Yoan (réponse, relance, info) à une tâche : elle suit cette discussion. Une tâche
    faite que Yoan relance repasse « en cours »."""
    with _lock:
        data = _load(room_id)
        task = next((t for t in data["tasks"] if t["id"] == tid), None)
        if task is None:
            raise ValueError(f"tâche {tid} introuvable")
        other = next((t for t in data["tasks"] if t is not task and _linked(t, event_id)), None)
        if other:  # un message, une tâche : on le déplace
            other["messages"] = [m for m in other.get("messages") or [] if m != event_id]
        msgs = task.setdefault("messages", [])
        if event_id not in msgs:
            msgs.append(event_id)
        task["thread"] = thread or task.get("thread")
        if task["status"] == "done":
            task["status"], task["proof"], task["hold"] = "doing", None, False
        if task["status"] in ("todo", "doing") and not task.get("owner"):
            task["owner"] = by
        if task["status"] == "todo":
            task["status"] = "doing"
        task["updated"], task["last_by"] = time.time(), by
        _save(room_id, data)
    _log("task_link", True, room_id=room_id, id=tid, by=by)
    return task


def remove(room_id: str, tid: str, by: str) -> int:
    with _lock:
        data = _load(room_id)
        gone, frontier = set(), {tid}
        while frontier:  # la tâche et toutes ses sous-tâches
            gone |= frontier
            frontier = {t["id"] for t in data["tasks"] if t.get("parent") in frontier} - gone
        before = len(data["tasks"])
        data["tasks"] = [t for t in data["tasks"] if t["id"] not in gone]
        if len(data["tasks"]) == before:
            raise ValueError(f"tâche {tid} introuvable")
        _save(room_id, data)
    _log("task_remove", True, room_id=room_id, id=tid, by=by, count=before - len(data["tasks"]))
    return before - len(data["tasks"])


# ---------- fin de discussion ----------
def plan_close(tasks: list[dict], pending_thread: str | None, busy: bool) -> list[str]:
    """Ids des tâches à fermer maintenant. Règle pure (testée dans test/tasks-rules.py)."""
    if busy:
        return []
    open_children = {t.get("parent") for t in tasks if t.get("parent") and t["status"] != "done"}
    return [t["id"] for t in tasks
            if t["status"] in ("todo", "doing") and t.get("thread") and not t.get("parent")
            and t["thread"] != pending_thread and not t.get("hold") and t["id"] not in open_children]


def _text(payload: dict) -> str:
    v = (payload or {}).get("text")
    if isinstance(v, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in v)
    return v if isinstance(v, str) else ""


def _reply(db_path, room_id: str, thread: str | None) -> tuple[str, str]:
    """(bot, texte) de la dernière réponse d'un bot dans ce fil, lue en lecture seule dans le state.db du gateway."""
    if not thread or not db_path:
        return "", ""
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
    try:
        row = con.execute("SELECT payload_json, actor_json FROM hosted_room_events WHERE room_id = ? AND kind = 'message.member'"
                          " AND json_extract(payload_json, '$.thread_id') = ? ORDER BY seq DESC LIMIT 1",
                          (room_id, thread)).fetchone()
    finally:
        con.close()
    if not row:
        return "", ""
    actor = json.loads(row[1] or "{}")
    return str(actor.get("profile") or actor.get("display_name") or actor.get("id") or "bot"), _text(json.loads(row[0] or "{}"))


def _user_text(db_path, room_id: str, event_id: str | None) -> str | None:
    """Texte du message qui a ouvert la discussion (None : introuvable)."""
    if not event_id or not db_path:
        return None
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=2)
    try:
        row = con.execute("SELECT payload_json FROM hosted_room_events WHERE room_id = ? AND event_id = ?",
                          (room_id, event_id)).fetchone()
    finally:
        con.close()
    return _text(json.loads(row[0] or "{}")) if row else None


def _busy(room_id: str) -> bool:
    """Table ronde au travail dans ce groupe, ou résultat gardé pas encore posé."""
    try:
        from . import dispatch, inbox
        with dispatch._jobs_lock:
            if any(v["room_id"] == room_id and v["status"] == "running" for v in dispatch._jobs.values()):
                return True
        return any(i.get("kind") != "user" for i in inbox.held(room_id))
    except Exception as exc:
        _log("task_failed", False, room_id=room_id, op="busy", cause=str(exc)[:200])
        return True  # dans le doute on ne ferme rien


def settle(room_id: str, db_path, pending_thread: str | None, ended: dict | None = None) -> list[str]:
    """Une discussion vient de se terminer : ferme ce qui doit l'être, puis le rattrapage Jev (en arrière-plan)."""
    with _lock:
        data = _load(room_id)
        ids = plan_close(data["tasks"], pending_thread, _busy(room_id))
        now = time.time()
        for t in data["tasks"]:
            if t["id"] in ids:
                bot, text = _reply(db_path, room_id, t["thread"])
                t["status"], t["hold"], t["updated"], t["last_by"] = "done", False, now, "auto"
                t["proof"] = (f"Réponse de {bot} : {_clean(text, 420)}" if text else "Discussion terminée")[:500]
                t["owner"] = t.get("owner") or (bot or None)
        if ids:
            _save(room_id, data)
        tasks = data["tasks"]
    if ids:
        _log("task_settle", True, room_id=room_id, closed=ids, pending=bool(pending_thread))
    if ended and ended.get("event_id") and not BOT_MSG_RE.match(ended.get("text") or ""):
        if not any(_linked(t, ended["event_id"]) or (t.get("thread") and t["thread"] == ended.get("thread"))
                   for t in tasks):
            bot, reply = _reply(db_path, room_id, ended.get("thread"))
            threading.Thread(target=_jev_catch, args=(room_id, ended, bot, reply), daemon=True).start()
    return ids


JEV_QUESTION = {
    "type": "choice",
    "instructions": ("Le message de Yoan a été envoyé à une équipe de bots, suivi de la dernière réponse d'un bot. "
                     "Classe le message de Yoan."),
    "criteria": {
        "pas_une_demande": ("réponse à une question, relance (« go », « continue »), information ou constat "
                            "(« c'est bon », « voilà j'ai bougé »), remerciement : rien de nouveau à faire"),
        "demande_traitee": "Yoan demande un travail, une action ou une réponse, et la réponse du bot la livre",
        "demande_en_suspens": ("Yoan demande un travail ou une action, et la réponse du bot dit que ce n'est pas "
                               "fini, attend quelque chose ou n'a pas fait la chose demandée"),
    },
}


def jev_classify(message: str, reply: str) -> tuple[str | None, float]:
    body = {"state": {"message_de_yoan": message[:1500], "derniere_reponse_du_bot": reply[:1500]},
            "questions": {"kind": JEV_QUESTION}}
    r = subprocess.run([str(JEV), "ask", "--raw"], input=json.dumps(body, ensure_ascii=False), text=True,
                       capture_output=True, timeout=30)
    if r.returncode != 0:
        raise RuntimeError(f"jev code {r.returncode} : {(r.stderr or r.stdout).strip()[-200:]}")
    out = json.loads(r.stdout)
    ans = (out.get("answers") or {}).get("kind") or {}
    return ans.get("choice"), float(ans.get("confidence") or 0)


def _jev_catch(room_id: str, ended: dict, bot: str, reply: str) -> None:
    try:
        kind, conf = jev_classify(ended.get("text") or "", reply)
    except Exception as exc:
        _log("task_failed", False, room_id=room_id, op="jev", cause=str(exc)[:200])
        if time.time() - _SHARED.jev_alert > 1800:  # une alerte par demi-heure si Jev reste injoignable
            _SHARED.jev_alert = time.time()
            _hub("Tâches de groupe : rattrapage Jev en échec", str(exc)[:200], "3")
        return
    created = None
    if conf >= JEV_MIN_CONFIDENCE and kind in ("demande_traitee", "demande_en_suspens"):
        done = kind == "demande_traitee"
        try:
            created = add(room_id, short_title(ended.get("text") or ""), "jev", source=ended["event_id"],
                          thread=None if done else ended.get("thread"), status="done" if done else "todo",
                          proof=(f"Réponse de {bot} : {_clean(reply, 420)}" if reply else "Discussion terminée")
                          if done else None)
        except Exception as exc:
            _log("task_failed", False, room_id=room_id, op="jev_add", cause=str(exc)[:200])
            return
    _log("task_jev", True, room_id=room_id, kind=kind, confidence=round(conf, 2),
         created=created["id"] if created else None)


def close_stale(room_id: str, older_s: float, label: str) -> list[str]:
    """Ménage décidé par Yoan : les tâches ouvertes sans activité depuis ``older_s`` passent faites (réouvrables)."""
    now = time.time()
    with _lock:
        data = _load(room_id)
        ids = [t["id"] for t in data["tasks"] if t["status"] != "done" and now - float(t.get("updated") or 0) > older_s]
        for t in data["tasks"]:
            if t["id"] in ids:
                t["status"], t["hold"], t["updated"], t["last_by"] = "done", False, now, "menage"
                t["proof"] = t["note"] = label
        if ids:
            _save(room_id, data)
    _log("task_sweep", True, room_id=room_id, closed=len(ids))
    return ids


def install() -> bool:
    """Enveloppe l'écriture « discussion terminée » du moteur (une seule fois par processus)."""
    try:
        from tui_gateway import hosted_room_service as hrs
    except Exception:
        return False
    cls = hrs.HostedRoomService
    orig = getattr(cls, "_bot_groups_tasks_orig", None) or cls._append_room_status

    def _append_room_status(self, room, decision):
        orig(self, room, decision)
        if getattr(decision, "status", None) not in ("settled", "bounded"):
            return
        room_id = str(room["room_id"])
        try:
            if not _path(room_id).exists() and not decision.discussion_event_id:
                return
            fresh = self._room(room_id)
            from .inbox import _current_thread
            said = _user_text(self.db_path, room_id, decision.discussion_event_id)
            ended = {"event_id": decision.discussion_event_id, "thread": decision.thread_id,
                     "text": said} if said is not None else None
            settle(room_id, self.db_path, _current_thread(self, fresh), ended)
        except Exception as exc:  # jamais d'exception vers le moteur
            _log("task_failed", False, room_id=room_id, op="settle", cause=f"{type(exc).__name__}: {exc}"[:300])
            _hub("Tâches de groupe : fermeture en échec", f"{room_id[:8]} : {str(exc)[:200]}", "4")

    cls._bot_groups_tasks_orig = orig
    cls._append_room_status = _append_room_status
    _log("tasks_install", True)
    return True


# ---------- discussion en cours (outil des bots) ----------
def _pending_discussion(events: list[dict]) -> dict | None:
    """Même règle que le moteur (hosted_room_discussion._pending_discussion) sur les derniers événements : le plus
    ancien message, dernier de son fil, après le dernier arrêt et pas encore terminé."""
    stop = max((ev.get("seq") or 0 for ev in events if ev.get("kind") == "room.stop_requested"), default=0)
    completed = {(ev.get("payload") or {}).get("discussion_event_id") for ev in events
                 if ev.get("kind") == "room.activity" and (ev.get("payload") or {}).get("status") in ("settled", "bounded")}
    last = {}
    for ev in events:
        if ev.get("kind") == "message.user":
            last[(ev.get("payload") or {}).get("thread_id")] = ev
    return next((ev for ev in sorted(last.values(), key=lambda e: e.get("seq") or 0)
                 if (ev.get("seq") or 0) > stop and ev["event_id"] not in completed), None)


def current(room_id: str) -> dict | None:
    """La discussion que le moteur mène en ce moment : {event_id, thread, text} du message qui l'a ouverte."""
    (st,) = _rpc(("groups.state", {"room_id": room_id}))
    latest = int((st.get("room") or {}).get("latest_seq") or 0)
    (page,) = _rpc(("groups.log", {"room_id": room_id, "since_seq": max(0, latest - 100), "limit": 100}))
    ev = _pending_discussion(page.get("events") or [])
    if ev is None:
        return None
    p = ev.get("payload") or {}
    return {"event_id": ev["event_id"], "thread": str(p.get("thread_id") or ev["event_id"]), "text": _text(p)}


def prompt_block(room_id: str, is_lead: bool = False, cur: dict | None = None) -> str:
    """Le tableau du groupe (tâches ouvertes, en arbre) pour le message d'un tour de bot."""
    tasks = listing(room_id)
    done = sum(t["status"] == "done" for t in tasks)
    open_ = [t for t in tasks if t["status"] != "done"]
    ids = {t["id"] for t in open_}
    lines: list[str] = []

    def walk(parent, depth):
        for t in open_:
            if (t.get("parent") if t.get("parent") in ids else None) == parent:
                who = f", {t['owner']}" if t.get("owner") else ""
                why = f" : {t['note']}" if t["status"] == "blocked" and t.get("note") else ""
                lines.append(f"{'  ' * depth}- {t['id']} [{LABEL[t['status']]}{who}] {t['title'][:160]}{why}")
                walk(t["id"], depth + 1)

    walk(None, 0)
    if len(lines) > PROMPT_LINES:
        lines = lines[:PROMPT_LINES] + [f"- … {len(lines) - PROMPT_LINES} autres (group_tasks action=list)"]
    head = f"[Tableau du groupe] outil group_tasks, room_id {room_id}. "
    if is_lead:
        rules = ("Tu es le meneur : c'est toi qui inscris les demandes de Yoan. Si son message demande un travail, "
                 "une action ou une réponse qui demande du travail, crée une tâche (action=add) avec un titre court "
                 "à toi (une phrase, pas son message recopié) ; découpe-la en sous-tâches (parent) si plusieurs "
                 "bots ou plusieurs étapes. Si son message répond, relance (« go », « continue »), informe ou "
                 "confirme, ne crée rien : rattache-le à la tâche concernée (action=link, id). Rien à rattacher "
                 "(salut, merci) : ne fais rien. ")
        if cur:
            hit = next((t for t in tasks if _linked(t, cur["event_id"])), None)
            rules += (f"Le message de Yoan de cette discussion est déjà rattaché à {hit['id']}. " if hit
                      else "Le message de Yoan de cette discussion n'a pas encore de tâche. ")
    else:
        rules = ""
    rules += ("Une tâche liée à la discussion se ferme seule quand la discussion se termine, avec la dernière "
              "réponse comme preuve. Si le travail continue après ton tour (tu attends quelque chose, il reste à "
              "faire), passe-la toi-même en doing : elle restera ouverte. Bloqué : blocked avec la raison. Fini "
              "hors discussion : done avec une preuve (fichier, test, mesure). Pas de doublon.")
    if not lines:
        return head + (f"Aucune tâche ouverte ({done} faites). " if done else "Aucune tâche pour l'instant. ") + rules
    return head + rules + f"\nOuvertes ({len(open_)}, {done} faites) :\n" + "\n".join(lines)


# ---------- outil des bots ----------
def group_tasks(args: dict, **kw) -> str:
    me, room_id = _caller(), str(args.get("room_id") or "")
    action = str(args.get("action") or "list")

    def out(**data) -> str:
        return json.dumps({"ok": True, **data}, ensure_ascii=False)

    try:
        (st,) = _rpc(("groups.state", {"room_id": room_id}))
        members = st["room"].get("members") or []
        if not any(me in (m.get("profile"), m.get("member_id")) for m in members):
            raise ValueError("tu n'es pas membre de ce groupe")
        if action == "list":
            return out(tasks=listing(room_id))
        if action == "add":
            parent = args.get("parent") or None
            cur = None if parent else current(room_id)
            if cur and BOT_MSG_RE.match(cur["text"]):
                cur = None  # discussion ouverte par un résultat de bot : pas une demande de Yoan
            return out(task=add(room_id, args.get("title"), me, parent=parent,
                                source=cur["event_id"] if cur else None, thread=cur["thread"] if cur else None,
                                status="doing" if cur else "todo"))
        if action == "link":
            cur = current(room_id)
            if cur is None:
                raise ValueError("aucune discussion en cours : rien à rattacher")
            return out(task=link(room_id, str(args.get("id") or ""), me, cur["event_id"], cur["thread"]))
        if action == "update":
            return out(task=update(room_id, str(args.get("id") or ""), me, is_user=False, status=args.get("status"),
                                   title=args.get("title"), proof=args.get("proof"), note=args.get("note")))
        raise ValueError("action inconnue : list, add, link ou update")
    except ValueError as exc:
        _log("task_failed", False, room_id=room_id, caller=me, op=action, cause=str(exc)[:200])
        return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)
    except Exception as exc:
        _log("task_failed", False, room_id=room_id, caller=me, op=action, cause=str(exc)[:200])
        _hub("Tâches de groupe : échec", f"{me} ({action}) : {str(exc)[:200]}", "4")
        return json.dumps({"ok": False, "error": f"erreur interne : {exc}"}, ensure_ascii=False)


SCHEMA = {
    "name": "group_tasks",
    "description": (
        "Tableau du groupe dont tu es membre. list : toutes les tâches. add : nouvelle tâche, liée au message de "
        "Yoan de la discussion en cours (parent pour une sous-tâche). link : rattache le message de Yoan en cours "
        "à une tâche existante (id) au lieu d'en créer une. update : status doing (tu la gardes ouverte après la "
        "discussion), blocked (note = raison obligatoire), done (proof = preuve obligatoire), todo ; ou corrige "
        "title / note."),
    "parameters": {"type": "object", "properties": {
        "room_id": {"type": "string", "description": "le groupe"},
        "action": {"type": "string", "enum": ["list", "add", "link", "update"]},
        "id": {"type": "string", "description": "update, link : la tâche (ex. t12)"},
        "title": {"type": "string", "description": "add : ce qu'il faut faire, titre court (une phrase)"},
        "parent": {"type": "string", "description": "add : tâche dont celle-ci est une sous-tâche"},
        "status": {"type": "string", "enum": list(STATUSES)},
        "proof": {"type": "string", "description": "done : ce qui prouve que c'est fait"},
        "note": {"type": "string", "description": "blocked : la raison ; sinon une précision courte"}},
        "required": ["room_id", "action"]},
}


# ---------- RPC de la PWA (Yoan) ----------
def _rpc_guard(name: str, fn):
    def run(params: dict | None = None, **_):
        try:
            return fn(params or {})
        except ValueError:
            raise
        except Exception as exc:
            _log("task_failed", False, via="pwa", op=name, cause=str(exc)[:200])
            _hub("Tâches de groupe : échec", f"PWA {name} : {str(exc)[:200]}", "4")
            raise
    return run


def _room(params: dict) -> str:
    return str(params.get("room_id") or "")


rpc_list = _rpc_guard("list", lambda p: {"room_id": _room(p), "tasks": listing(_room(p))})
rpc_add = _rpc_guard("add", lambda p: {"task": add(_room(p), p.get("title"), "yoan", parent=p.get("parent") or None)})
rpc_update = _rpc_guard("update", lambda p: {"task": update(
    _room(p), str(p.get("id") or ""), "yoan", is_user=True, status=p.get("status"), title=p.get("title"),
    note=p.get("note"))})
rpc_remove = _rpc_guard("remove", lambda p: {"removed": remove(_room(p), str(p.get("id") or ""), "yoan")})
