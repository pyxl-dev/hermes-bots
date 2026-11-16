"""Horloge : chaque tour d'un bot reçoit l'heure de Paris et l'écart depuis le tour précédent de la
même conversation (décidé par Yoan le 2026-11-16, « mes bots n'ont aucune notion du temps »).

Passe par le crochet ``pre_llm_call`` : il tourne dans l'agent, donc sur tous les canaux (PWA en Bot
Mode, table ronde lancée par ``hermes chat``, Telegram, tâches automatiques). Le texte accompagne le
message du tour sans entrer dans la bulle. L'option native ``gateway.message_timestamps`` ne couvre
pas le Bot Mode, d'où ce crochet.

Échecs : journal ``actions.jsonl`` (action ``clock``) et alerte Hub, au plus une par heure.
"""
from __future__ import annotations

import json
import threading
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from . import STATE, _hub, _log

TZ = ZoneInfo("Europe/Paris")
SEEN = STATE / "clock.json"
MAX_SESSIONS = 2000
JOURS = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")
MOIS = ("janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre",
        "octobre", "novembre", "décembre")
_lock = threading.Lock()
_last_alert = 0.0


def _date(dt: datetime) -> str:
    return f"{JOURS[dt.weekday()]} {dt.day} {MOIS[dt.month - 1]} {dt.year}"


def _ecart(seconds: float) -> str:
    s = max(0, int(seconds))
    if s < 60:
        return "moins d'une minute"
    if s < 3600:
        m = s // 60
        return f"{m} minute{'s' * (m > 1)}"
    if s < 86400:
        h, m = divmod(s // 60, 60)
        return f"{h} h {m:02d}" if m else f"{h} h"
    j = s // 86400
    return f"{j} jour{'s' * (j > 1)}"


def clock_line(now: float, previous: float | None) -> str:
    dt = datetime.fromtimestamp(now, TZ)
    line = f"Horloge : nous sommes le {_date(dt)}, il est {dt:%H:%M} (heure de Paris)."
    if previous is not None and previous < now:
        p = datetime.fromtimestamp(previous, TZ)
        quand = f"à {p:%H:%M}" if p.date() == dt.date() else f"le {_date(p)} à {p:%H:%M}"
        line += f" Le message précédent de cette conversation date d'il y a {_ecart(now - previous)} ({quand})."
    return line


def _swap_seen(session_id: str, now: float) -> float | None:
    """Rend l'heure du tour précédent de cette conversation et enregistre celle-ci."""
    with _lock:
        try:
            seen = json.loads(SEEN.read_text())
        except FileNotFoundError:
            seen = {}
        previous = seen.pop(session_id, None)
        seen[session_id] = now
        if len(seen) > MAX_SESSIONS:  # les plus anciennes conversations sortent en premier
            seen = dict(sorted(seen.items(), key=lambda kv: kv[1])[-MAX_SESSIONS:])
        STATE.mkdir(parents=True, exist_ok=True)
        tmp = SEEN.with_suffix(".tmp")
        tmp.write_text(json.dumps(seen))
        tmp.replace(SEEN)
    return previous


def pre_llm_call(user_message=None, session_id="", **_):
    global _last_alert
    text = user_message if isinstance(user_message, str) else ""
    if '{"assign"' in text:  # tour de répartition du meneur : il doit rendre du JSON seul
        return None
    now = time.time()
    try:
        previous = _swap_seen(session_id, now) if session_id else None
        return {"context": clock_line(now, previous)}
    except Exception as exc:  # l'horloge ne doit jamais bloquer un tour
        _log("clock", False, session=session_id, cause=str(exc)[:200])
        if now - _last_alert > 3600:
            _last_alert = now
            _hub("Horloge des bots en échec", f"{exc}"[:300])
        try:
            return {"context": clock_line(now, None)}
        except Exception:
            return None


def register(ctx) -> None:
    ctx.register_hook("pre_llm_call", pre_llm_call)
