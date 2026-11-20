"""Recadrage d'un bot de groupe pendant qu'il travaille (GLOSSARY.md « Recadrage », décidé avec Yoan le 2026-11-17).

Un message de Yoan envoyé pendant une discussion vise le bot qu'il cite, ou le meneur sans citation :

- ce bot tient un tour du moteur : sa session (cachée, dans ce processus) reçoit le message par ``agent.redirect`` ;
  la rédaction en cours est coupée, ce qui est fait reste, il repart aussitôt avec ; la discussion continue ;
- il travaille en coulisse (table ronde, réponse immédiate) : sa tâche ``hermes chat`` n'est qu'un client, le tour
  tourne dans le gateway, dans la session « Groupe · <nom du groupe> » de son profil ; elle est recadrée pareil ;
- il ne travaille pas : réponse immédiate (``dispatch.rpc_side``), comme avant ;
- le tour a fini entre-temps sans le lire : le message est gardé en tête (``inbox``, kind ``user``) et entre dans
  le groupe avant tout le reste ; le bot visé repart aussitôt avec.

Un recadrage lu est aussi gardé (kind ``steer``) pour entrer dans le fil du groupe entre deux tours, déjà traité.
Hermes n'offre pas de commande publique pour recadrer le tour d'un membre : on retrouve, dans l'autorité de session de
son profil, la session « Group: <room_id> » et l'agent adopté du tour en cours, puis on fait ce que fait
``session.redirect``, voir docs/adr/0002-recadrage-d-un-membre-de-groupe.md. Si ce chemin disparaît
après une mise à jour de Hermes, ``find_turn`` ne trouve plus rien, le journal (``steer_*``) le dit et
``status()`` le signale.

Journal : ``actions.jsonl`` (``steer_*``), alerte Hub sur chaque échec.
"""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from . import _hub, _log, _rpc, inbox, routing



def _authorities():
    from gateway.run_api import _ACTIVE_RUNNER
    from gateway.session_authorities import all_authorities
    return all_authorities(_ACTIVE_RUNNER) if _ACTIVE_RUNNER is not None else []


def find_turn(profile: str, titles: set[str]) -> tuple[Any, str, int, Any] | None:
    """Le tour que ce profil tient en ce moment dans l'une de ces sessions : ``(autorité, session_id, génération, agent)``.
    L'agent d'un tour en cours est adopté par l'autorité de session de son profil (``SessionAuthority.adopted``), là où
    ``session.redirect`` le trouve pour la conversation d'un bot seul. Sessions d'un groupe : « Group: <room_id> »
    (tours du moteur, ``gateway.session_hosted_rpc.HostedRoomAuthorityRPC``) et « Groupe · <nom> » (tâches en
    coulisse, ``dispatch._spawn``)."""
    for auth in _authorities():
        if Path(str(auth.profile_id)).name != profile:
            continue
        for sid, (gen, agent) in list(getattr(auth, "adopted", {}).items()):
            if agent is None or gen is None:
                continue
            if (auth.db.get_session(sid) or {}).get("title") in titles:
                return auth, sid, int(gen), agent
    return None


def _titles(room: dict) -> set[str]:
    rid = str(room.get("room_id") or "")
    return {f"Group: {rid}", f"Groupe · {room.get('name') or rid}"[:80]}


def redirect_turn(room: dict, profile: str, text: str) -> bool:
    """Recadre le tour en cours de ce membre dans ce groupe, comme ``session.redirect``
    (gateway/session_busy_controls.py ``correct``). Vrai si l'agent a pris le message."""
    found = find_turn(profile, _titles(room))
    if found is None:
        return False
    auth, sid, gen, _agent = found
    from gateway.session_contract import SessionRef
    from hermes_state_runtime import RuntimeStoreError
    live = auth.sessions.get(sid)
    if live is None:
        return False
    with live.event_stream.lock:
        try:
            auth.check_approval_generation(sid, gen)
        except RuntimeStoreError:
            return False  # le tour vient de finir : rien à recadrer
        agent, _ = auth.steer_agent(SessionRef(auth.profile_id, sid), gen, None)
        if agent is None or not callable(getattr(agent, "redirect", None)):
            return False
        return bool(agent.redirect(text))


def _target(members: list[dict], lead: dict, text: str) -> dict:
    hit = routing.cited(text, members)
    return hit[0] if hit else lead


def _room_busy(room_id: str) -> bool:
    (st,) = _rpc(("groups.state", {"room_id": room_id}))
    d = st.get("driver_status") or {}
    return bool(d.get("working") or d.get("member_activity")) or inbox._rounds_running(room_id)


def rpc_send(params: dict | None = None, **_) -> dict:
    """PWA : ``{room_id, event_id, text}`` d'un message de Yoan pendant que le groupe travaille.
    Réponse ``{mode}`` : ``steered`` (le bot l'a dans son tour), ``side`` (réponse immédiate), ``held`` (gardé en tête,
    il repart aussitôt avec), ``fallback`` (rien en cours : la PWA l'envoie normalement)."""
    from . import dispatch
    p = params or {}
    room_id, event_id, text = str(p.get("room_id") or ""), str(p.get("event_id") or ""), str(p.get("text") or "").strip()
    if not room_id or not text or not re.fullmatch(r"[0-9a-f-]{16,64}", event_id):
        raise ValueError("room_id, event_id et texte requis")
    room, _ctx, lead = dispatch._room_and_lead(room_id)
    if lead is None:
        return {"mode": "fallback", "reason": "groupe sans meneur"}
    members = room.get("members", [])
    m = _target(members, lead, text)
    bot = m.get("profile") or m.get("member_id")
    who = m.get("display_name") or m.get("handle")
    keep = {"text": text, "thread_id": event_id}
    note = f"Yoan, pendant ton tour : {text}"
    try:
        if redirect_turn(room, bot, note):
            inbox.submit(room_id, event_id, keep, "steer", who=who)
            _log("steer_send", True, room_id=room_id, bot=bot, mode="steered")
            return {"mode": "steered", "who": who}
        if not _room_busy(room_id):
            _log("steer_send", True, room_id=room_id, bot=bot, mode="fallback")
            return {"mode": "fallback"}
        try:
            dispatch.rpc_side({"room_id": room_id, "text": text, "members": [m.get("handle")], "side_id": event_id})
            _log("steer_send", True, room_id=room_id, bot=bot, mode="side")
            return {"mode": "side", "who": who}
        except ValueError as exc:
            # occupé entre-temps (son tour vient de commencer ou de finir), limite de tâches : il repart avec, en tête
            if redirect_turn(room, bot, note):
                inbox.submit(room_id, event_id, keep, "steer", who=who)
                _log("steer_send", True, room_id=room_id, bot=bot, mode="steered", retry=True)
                return {"mode": "steered", "who": who}
            inbox.submit(room_id, event_id, keep, "user")
            _log("steer_send", True, room_id=room_id, bot=bot, mode="held", cause=str(exc)[:200])
            return {"mode": "held", "who": who}
    except Exception as exc:
        _log("steer_send", False, room_id=room_id, bot=bot, cause=f"{type(exc).__name__}: {exc}"[:300])
        _hub("Groupe : recadrage échoué", f"{who} : {str(exc)[:200]}", "4")
        raise


def status() -> dict:
    """Le chemin de recadrage du moteur existe-t-il dans ce Hermes ?"""
    try:
        from gateway.session_authority import SessionAuthority
        from gateway.session_contract import SessionRef  # noqa: F401
        ok = all(hasattr(SessionAuthority, a) for a in ("steer_agent", "check_approval_generation"))
        return {"ok": ok, "authorities": len(_authorities())}
    except Exception as exc:
        return {"ok": False, "cause": f"{type(exc).__name__}: {exc}"[:200]}


# ---------- recadrage par le meneur (décidé avec Yoan le 2026-11-17, GLOSSARY.md « Recadrage ») ----------
# Le meneur, et lui seul, recadre un membre de son groupe qui travaille : même chemin que pour Yoan (redirect_turn),
# au plus une fois par tour du membre visé (le tour du meneur n'a pas d'identifiant fiable : en réponse immédiate,
# user_task est vide et sa session de coulisse est réutilisée). Un membre sans tour en cours : refus, avec la liste de ceux
# qui travaillent. Le recadrage entre dans le fil du groupe, déjà traité (kind ``steer``), signé du meneur.
from . import lifecycle  # gardé au rechargement à chaud
_lead_steers: set[tuple[str, int]] = lifecycle.shared("steer.lead_steers", set)   # tours de membre (session, génération) déjà recadrés par le meneur
_LEAD_TURN_MAX = 2000


def _working(room: dict, members: list[dict], skip: str) -> list[str]:
    """Handles des membres (hors ``skip``) qui tiennent un tour dans ce groupe, moteur ou coulisse."""
    from .dispatch import _jobs, _jobs_lock
    rid = room.get("room_id")
    with _jobs_lock:
        busy = {v["bot"] for v in _jobs.values() if v["room_id"] == rid and v["status"] == "running"}
    out = []
    for m in members:
        bot = m.get("profile") or m.get("member_id")
        if m.get("member_id") == skip:
            continue
        if bot in busy or find_turn(str(bot), _titles(room)) is not None:
            out.append(str(m.get("handle")))
    return out


def group_steer(args: dict, **_) -> str:
    import json
    import uuid
    from . import _caller, dispatch
    me, room_id = _caller(), str(args.get("room_id") or "")
    text = str(args.get("text") or "").strip()
    target = str(args.get("bot") or "").lstrip("@")

    def err(msg: str, failed: bool = False, **extra) -> str:
        # refus (membre libre, pas le meneur...) : la règle a joué, ce n'est pas un échec
        _log("lead_steer", not failed, caller=me, room_id=room_id, bot=target, **({"cause": msg} if failed else {"refused": msg}))
        return json.dumps({"ok": False, "error": msg, **extra}, ensure_ascii=False)

    if not text or not target:
        return err("donne le membre (bot) et le message (text)")
    try:
        room, _ctx, lead = dispatch._room_and_lead(room_id)
    except Exception as exc:
        return err(f"groupe introuvable : {exc}")
    members = room.get("members", [])
    by_key = {str(k).casefold(): m for m in members
              for k in (m.get("profile"), m.get("member_id"), m.get("handle")) if k}
    me_member = by_key.get(me.casefold())
    if lead is None or me_member is None or me_member.get("member_id") != lead.get("member_id"):
        return err("seul le meneur du groupe peut recadrer un membre")
    m = by_key.get(target.casefold())
    if m is None:
        return err(f"« {target} » n'est pas membre du groupe")
    if m.get("member_id") == lead.get("member_id"):
        return err("tu ne te recadres pas toi-même")
    bot = str(m.get("profile") or m.get("member_id"))
    found = find_turn(bot, _titles(room))
    key = (found[1], found[2]) if found else None
    if key in _lead_steers:
        return err(f"tu as déjà recadré {m.get('handle')} pendant ce tour : attends son résultat")
    who = m.get("display_name") or m.get("handle")
    lead_name = lead.get("display_name") or lead.get("handle")
    try:
        ok = key is not None and redirect_turn(room, bot, f"{lead_name} (meneur), pendant ton tour : {text}")
    except Exception as exc:
        _hub("Groupe : recadrage du meneur échoué", f"{who} : {str(exc)[:200]}", "4")
        return err(f"recadrage impossible : {type(exc).__name__}: {exc}"[:300], failed=True)
    if not ok:
        working = _working(room, members, str(lead.get("member_id")))
        hint = ("Cite-le avec @ ou confie-lui une tâche avec group_dispatch."
                + (f" Travaillent en ce moment : {', '.join(working)}." if working else " Aucun membre ne travaille."))
        return err(f"{m.get('handle')} ne travaille pas en ce moment. {hint}", working=working)
    if len(_lead_steers) > _LEAD_TURN_MAX:
        _lead_steers.clear()
    _lead_steers.add(key)
    eid = str(uuid.uuid4())
    try:
        inbox.submit(room_id, eid, {"text": f"[{me}] Recadrage pour {who} : {text}", "thread_id": eid}, "steer",
                     who=who)
    except Exception as exc:  # le membre l'a déjà dans son tour : seule la trace dans le fil manque
        _log("lead_steer", False, caller=me, room_id=room_id, bot=bot, step="fil", cause=str(exc)[:200])
        _hub("Groupe : recadrage absent du fil", f"{who} : {str(exc)[:200]}", "4")
    _log("lead_steer", True, caller=me, room_id=room_id, bot=bot)
    return json.dumps({"ok": True, "steered": m.get("handle"), "note": (
        "Il l'a dans son tour en cours et continue avec. Son résultat te reviendra comme d'habitude.")},
        ensure_ascii=False)


SCHEMA = {
    "name": "group_steer",
    "description": (
        "Recadrage : si tu es le meneur d'un groupe, envoie une consigne à un membre PENDANT qu'il travaille "
        "(tour de discussion ou tâche de table ronde). Il la prend tout de suite dans son tour, garde ce qu'il a "
        "fait et continue avec. Une fois par membre et par tour. Refusé si le membre ne travaille pas : cite-le "
        "ou utilise group_dispatch."),
    "parameters": {"type": "object", "properties": {
        "room_id": {"type": "string", "description": "le groupe"},
        "bot": {"type": "string", "description": "handle ou profil du membre qui travaille"},
        "text": {"type": "string", "description": "la consigne, complète"}},
        "required": ["room_id", "bot", "text"]},
}
