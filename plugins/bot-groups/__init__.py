"""bot-groups : outils de groupe pour les bots Hermes (décidé par Yoan le 2026-11-12).

Les appels passent par le socket de contrôle local du gateway (verbe ``session-ticket``, même
utilisateur Mac que le desktop natif), puis ``/api/ws`` : les groupes créés appartiennent au
propriétaire et apparaissent dans la PWA et le desktop. Journal JSONL, ``python3 status.py``,
alerte Hub sur chaque création et chaque échec.
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path

TOOLSET = "bot_groups"
MAX_ACTIVE_BOT_GROUPS = 3
MAX_MEMBERS = 10  # défaut ; la vraie limite est hosted_rooms.discussion.max_members (settings.py)
MAX_POSTS_PER_HOUR = 10
ROOT = Path.home() / ".hermes"
STATE = ROOT / "data" / "bot-groups"
LEDGER = STATE / "rooms.json"
LOG = STATE / "actions.jsonl"
HUB_NOTIFY = Path.home() / "bin" / "hub-notify"
_lock = threading.Lock()


def _max_members() -> int:
    try:
        from .settings import max_members
        return max_members()
    except Exception:
        return MAX_MEMBERS


# ---------- journal, ledger, alert ----------
def _log(action: str, ok: bool, /, **extra) -> None:
    # Positionnels seulement : un `action=` ou `ok=` passé en mot-clé ne doit ni faire planter
    # le chemin d'erreur (TypeError qui masquait la vraie cause) ni écraser les champs du journal.
    extra = {(f"extra_{k}" if k in ("ts", "action", "ok") else k): v for k, v in extra.items()}
    STATE.mkdir(parents=True, exist_ok=True)
    with LOG.open("a") as f:
        f.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "action": action, "ok": ok, **extra}, ensure_ascii=False) + "\n")


def _hub(title: str, body: str, priority: str = "3") -> None:
    if HUB_NOTIFY.exists():
        try:
            subprocess.run([str(HUB_NOTIFY), "-t", "hermes-groupes", "-T", title, "-p", priority, body[:500]],
                           timeout=15, capture_output=True, check=False)
        except Exception as exc:  # the alert must never break the tool
            _log("alert", False, cause=str(exc))


def _ledger() -> dict:
    try:
        return json.loads(LEDGER.read_text())
    except Exception:
        return {"rooms": {}, "posts": []}


def _save_ledger(data: dict) -> None:
    STATE.mkdir(parents=True, exist_ok=True)
    tmp = LEDGER.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    tmp.replace(LEDGER)


def _caller() -> str:
    """Profil du bot qui appelle : le home Hermes du contexte (profiles/<nom>, sinon default)."""
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home())
    except Exception:
        home = Path(os.environ.get("HERMES_HOME", ROOT))
    return home.name if home.parent.name == "profiles" else "default"


# ---------- gateway access (native owner path) ----------
def _ctl(verb: str, params: dict | None = None) -> dict:
    sock_path = ROOT / "gateway.sock"
    pointer = ROOT / "gateway.sock.path"
    if not sock_path.exists() and pointer.exists():
        sock_path = Path(pointer.read_text().strip())
    req = {"protocol": 1, "verb": verb, "id": 1}
    if params is not None:
        req["params"] = params
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
        s.settimeout(5)
        s.connect(str(sock_path))
        s.sendall((json.dumps(req) + "\n").encode())
        data = b""
        while not data.endswith(b"\n"):
            chunk = s.recv(65536)
            if not chunk:
                break
            data += chunk
    resp = json.loads(data or b"{}")
    if not resp.get("ok"):
        raise RuntimeError(f"gateway: {resp.get('error', 'pas de réponse')}")
    return resp["result"]


async def _rpc_many(calls: list[tuple[str, dict]], timeout: float = 45) -> list:
    from websockets.asyncio.client import connect
    ident = _ctl("identify")
    ticket = _ctl("session-ticket", {"profile_id": str(ROOT.resolve()), "instance_id": ident["instance_id"],
                                      "purpose": "interactive", "scope": "host"})["ticket"]
    url = ident["api_origin"].replace("http", "ws", 1) + "/api/ws"
    out = []
    async with connect(url, subprotocols=["hermes-gateway-v1", "hermes-gateway-ticket." + ticket],
                       max_size=8 * 1024 * 1024) as ws:
        for i, (method, params) in enumerate(calls, 1):
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": i, "method": method, "params": params}))
            while True:
                msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
                if msg.get("id") == i and ("result" in msg or "error" in msg):
                    break
            if "error" in msg:
                err = msg["error"] or {}
                raise RuntimeError(f"{method} : {err.get('message', 'erreur')} {json.dumps(err.get('data') or {}, ensure_ascii=False)}")
            out.append(msg["result"])
    return out


def _rpc(*calls: tuple[str, dict]) -> list:
    """Run in a private thread/loop: the tool may be called from inside the gateway's event loop."""
    box: dict = {}

    def run():
        try:
            box["v"] = asyncio.run(_rpc_many(list(calls)))
        except Exception as exc:
            box["e"] = exc
    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(90)
    if t.is_alive():
        raise RuntimeError("le gateway ne répond pas (délai dépassé)")
    if "e" in box:
        raise box["e"]
    return box["v"]


def _ok(**data) -> str:
    return json.dumps({"ok": True, **data}, ensure_ascii=False)


def _err(message: str, action: str, **extra) -> str:
    _log(action, False, cause=message, caller=_caller(), **extra)
    if action in ("group_create", "group_post"):
        _hub(f"Groupes de bots : échec {action}", f"{_caller()} : {message}", "4")
    return json.dumps({"ok": False, "error": message}, ensure_ascii=False)


def _member_ids(room: dict) -> list[str]:
    return [m.get("profile") or m.get("member_id") for m in room.get("members", [])]


def _text(v) -> str:
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in v)
    return "" if v is None else str(v)


# ---------- tools ----------
def group_list(args: dict, **kw) -> str:
    me = _caller()
    try:
        caps, listing = _rpc(("groups.capabilities", {}), ("groups.list", {"limit": 50}))
    except Exception as exc:
        return _err(str(exc), "group_list")
    mine = [{"room_id": r["room_id"], "name": r["name"], "members": _member_ids(r)}
            for r in listing.get("rooms", []) if me in _member_ids(r)]
    _log("group_list", True, caller=me, count=len(mine))
    return _ok(me=me, my_groups=mine, bots_available=caps.get("seatable_profiles", []),
               limits={"max_active_bot_groups": MAX_ACTIVE_BOT_GROUPS, "max_members": _max_members()})


def group_read(args: dict, **kw) -> str:
    me, room_id = _caller(), str(args.get("room_id") or "")
    limit = max(1, min(int(args.get("limit") or 30), 100))
    try:
        (state,) = _rpc(("groups.state", {"room_id": room_id}))
        if me not in _member_ids(state["room"]):
            return _err("tu n'es pas membre de ce groupe", "group_read", room_id=room_id)
        events, since = [], 0
        while True:
            (page,) = _rpc(("groups.log", {"room_id": room_id, "since_seq": since, "limit": 500}))
            events += page.get("events", [])
            since = max(since, page.get("cursor") or 0)
            if not page.get("has_more") or not page.get("events"):
                break
    except Exception as exc:
        return _err(str(exc), "group_read", room_id=room_id)
    msgs = []
    for ev in events:
        if ev.get("kind") == "message.user":
            msgs.append({"from": "Yoan ou un bot (via group_post)", "text": _text(ev.get("payload", {}).get("text"))[:2000]})
        elif ev.get("kind") == "message.member":
            a = ev.get("actor") or {}
            msgs.append({"from": a.get("display_name") or a.get("profile") or a.get("id"), "text": _text(ev.get("payload", {}).get("text"))[:2000]})
    _log("group_read", True, caller=me, room_id=room_id)
    return _ok(room={"room_id": room_id, "name": state["room"]["name"], "members": _member_ids(state["room"])},
               context=state.get("context"), messages=msgs[-limit:])


def group_create(args: dict, **kw) -> str:
    me = _caller()
    name = str(args.get("name") or "").strip()[:80]
    purpose = str(args.get("purpose") or "").strip()[:500]
    others = [str(m).strip() for m in (args.get("members") or []) if str(m).strip() and str(m).strip() != me]
    profiles = [me] + list(dict.fromkeys(others))
    if not name or not purpose:
        return _err("donne un nom et un but au groupe", "group_create")
    limit = _max_members()
    if not 2 <= len(profiles) <= limit:
        return _err(f"un groupe compte de 2 à {limit} bots, toi compris", "group_create")
    with _lock:
        try:
            caps, listing = _rpc(("groups.capabilities", {}), ("groups.list", {"limit": 200}))
            alive = {r["room_id"] for r in listing.get("rooms", [])}
            led = _ledger()
            led["rooms"] = {rid: v for rid, v in led["rooms"].items() if rid in alive}  # dissous = libérés
            if len(led["rooms"]) >= MAX_ACTIVE_BOT_GROUPS:
                _save_ledger(led)
                names = ", ".join(v["name"] for v in led["rooms"].values())
                return _err(f"limite atteinte : {MAX_ACTIVE_BOT_GROUPS} groupes créés par les bots sont actifs ({names}). Réutilise-en un avec group_post, ou demande à Yoan d'en supprimer.", "group_create")
            seatable = set(caps.get("seatable_profiles") or [])
            unknown = [p for p in profiles if p not in seatable]
            if unknown:
                return _err(f"bots inconnus ou indisponibles : {', '.join(unknown)}. Disponibles : {', '.join(sorted(seatable))}", "group_create")
            members = [{"member_id": p, "profile": p, "handle": "hermes" if p == "default" else p,
                        "target": {"kind": "local", "profile": p}} for p in profiles]
            room_id = str(uuid.uuid4())
            created, ctx = _rpc(
                ("groups.create", {"room_id": room_id, "name": name, "members": members}),
                ("groups.context", {"room_id": room_id, "event_id": str(uuid.uuid4()), "purpose": purpose,
                                    "notes": f"Groupe créé par le bot {me}. Meneur : {me}.",
                                    "routing": "lead", "lead_member_id": me}),
            )
            led["rooms"][room_id] = {"name": name, "creator": me, "members": profiles, "created": time.time()}
            _save_ledger(led)
        except Exception as exc:
            return _err(str(exc), "group_create")
    _log("group_create", True, caller=me, room_id=room_id, name=name, members=profiles)
    _hub(f"Nouveau groupe : {name}", f"Créé par {me} avec {', '.join(profiles[1:])}. But : {purpose}")
    return _ok(room_id=room_id, name=name, members=profiles, routing="lead", lead=me,
               note="Groupe créé. Lance le travail avec group_post. Seul le meneur (toi) répond par défaut ; mentionne un bot par son nom pour qu'il prenne la parole.")


def group_post(args: dict, **kw) -> str:
    me, room_id = _caller(), str(args.get("room_id") or "")
    text = str(args.get("text") or "").strip()
    if not text:
        return _err("message vide", "group_post", room_id=room_id)
    with _lock:
        led = _ledger()
        now = time.time()
        led["posts"] = [p for p in led.get("posts", []) if now - p["t"] < 3600]
        if sum(1 for p in led["posts"] if p["by"] == me) >= MAX_POSTS_PER_HOUR:
            return _err(f"limite de {MAX_POSTS_PER_HOUR} messages de groupe par heure atteinte pour {me}", "group_post", room_id=room_id)
        try:
            (state,) = _rpc(("groups.state", {"room_id": room_id}))
            if me not in _member_ids(state["room"]):
                return _err("tu n'es pas membre de ce groupe", "group_post", room_id=room_id)
            event_id = str(uuid.uuid4())
            from . import inbox  # gardé puis posé entre deux tours, après les messages de Yoan
            inbox.submit(room_id, event_id, {"text": f"[{me}] {text[:8000]}", "thread_id": event_id}, "bot")
        except Exception as exc:
            return _err(str(exc), "group_post", room_id=room_id)
        led["posts"].append({"t": now, "by": me, "room": room_id})
        _save_ledger(led)
    _log("group_post", True, caller=me, room_id=room_id, chars=len(text))
    return _ok(room_id=room_id, posted=True, note="Les réponses arrivent dans le groupe ; relis-les avec group_read.")


SCHEMAS = [
    ({"name": "group_list", "description": "Liste les groupes dont tu es membre et les bots que tu peux inviter.",
      "parameters": {"type": "object", "properties": {}}}, group_list, "👥"),
    ({"name": "group_read", "description": "Lit le but et les derniers messages d'un groupe dont tu es membre.",
      "parameters": {"type": "object", "properties": {
          "room_id": {"type": "string"}, "limit": {"type": "integer", "description": "messages récents, 30 par défaut"}},
          "required": ["room_id"]}}, group_read, "📖"),
    ({"name": "group_create", "description": (
        "Crée un groupe de travail avec d'autres bots quand une tâche demande plusieurs compétences. "
        f"Tu en es membre et meneur. 2 bots au moins toi compris (la limite haute, fixée par Yoan, est dans group_list), {MAX_ACTIVE_BOT_GROUPS} groupes créés par les bots au plus : "
        "vérifie d'abord group_list et réutilise un groupe existant si possible. Yoan voit et peut supprimer ces groupes."),
      "parameters": {"type": "object", "properties": {
          "name": {"type": "string", "description": "nom court"},
          "purpose": {"type": "string", "description": "ce que le groupe doit produire (500 caractères max)"},
          "members": {"type": "array", "items": {"type": "string"}, "description": "profils des autres bots (voir group_list)"}},
          "required": ["name", "purpose", "members"]}}, group_create, "🧩"),
    ({"name": "group_post", "description": f"Poste un message dans un groupe dont tu es membre ({MAX_POSTS_PER_HOUR} par heure au plus). Ton nom est ajouté devant.",
      "parameters": {"type": "object", "properties": {
          "room_id": {"type": "string"}, "text": {"type": "string"}}, "required": ["room_id", "text"]}}, group_post, "💬"),
]


def register(ctx) -> None:
    for schema, handler, emoji in SCHEMAS:
        ctx.register_tool(name=schema["name"], toolset=TOOLSET, schema=schema, handler=handler,
                          description=schema["description"], emoji=emoji)
    from . import mention  # @yoan : consigne + notif prioritaire
    mention.register(ctx)
    from . import dispatch  # table ronde : le meneur fait travailler plusieurs bots en même temps
    ctx.register_tool(name=dispatch.SCHEMA["name"], toolset=TOOLSET, schema=dispatch.SCHEMA,
                      handler=dispatch.group_dispatch, description=dispatch.SCHEMA["description"], emoji="🪑")
    ctx.register_rpc("dispatch.status", dispatch.rpc_status)
    ctx.register_rpc("side.send", dispatch.rpc_side)
    from . import tasks  # tableau de tâches du groupe : outil des bots + RPC de la PWA
    ctx.register_tool(name=tasks.SCHEMA["name"], toolset=TOOLSET, schema=tasks.SCHEMA,
                      handler=tasks.group_tasks, description=tasks.SCHEMA["description"], emoji="📋")
    for verb in ("list", "add", "update", "remove"):
        ctx.register_rpc(f"tasks.{verb}", getattr(tasks, f"rpc_{verb}"))
    tasks.install()  # fin de discussion : les tâches liées se ferment, rattrapage Jev
    from . import settings  # réglages des équipes pour la PWA : plugin.bot-groups.settings.get / .set
    ctx.register_rpc("settings.get", settings.rpc_get)
    ctx.register_rpc("settings.set", settings.rpc_set)
    from . import trace  # fil de travail : hook du moteur, RPC trace.* / member.stop / dispatch.stop
    trace.register(ctx)
    from . import clock  # horloge : heure de Paris et écart depuis le tour précédent, à chaque tour
    clock.register(ctx)
    from . import inbox  # messages en attente : posés entre deux tours, ceux de Yoan d'abord
    inbox.install()
    ctx.register_rpc("inbox.send", inbox.rpc_send)
    ctx.register_rpc("inbox.status", inbox.rpc_status)
    from . import resume  # tours bloqués après un redémarrage : relancés seuls
    resume.start()
