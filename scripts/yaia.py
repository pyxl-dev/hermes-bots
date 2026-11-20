"""Yaia (session Claude de Yoan) parle et lit dans un groupe de bots, à la vue de Yoan dans la PWA.

Remplace ``hermes -z`` lancé dans une autre session : rien de ce qui s'y disait n'apparaissait dans le groupe.

  <python du venv hermes-agent> scripts/yaia.py say  <groupe> <texte>      poste « [yaia] texte » (RPC yaia.send)
  <python du venv hermes-agent> scripts/yaia.py read <groupe> [--since N] [--wait S]
        affiche les messages du groupe après la séquence N (défaut : les 15 derniers) ; --wait attend jusqu'à S s
        (60 au plus) qu'un bot réponde après N
  <python du venv hermes-agent> scripts/yaia.py status                      ce qui a marché et échoué (journal)

<groupe> : nom exact du groupe ou room_id. Le gateway visé suit HOME (~/.hermes = prod) ; --test vise le gateway de test
(HOME=~/.hermes-test/_home). Raccourci : ``bun run yaia -- say ...``. Journal : ~/.hermes/data/bot-groups/yaia.jsonl (horodatage, action,
succès, cause) ; chaque échec part aussi en alerte Hub.
"""
import asyncio
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

if "--test" in sys.argv:  # avant le chargement du plugin : il lit Path.home()/.hermes
    sys.argv.remove("--test")
    os.environ["HOME"] = str(Path.home() / ".hermes-test" / "_home")
PLUGIN = Path(__file__).resolve().parent.parent / "plugins" / "bot-groups"
spec = importlib.util.spec_from_file_location("bg_yaia_cli", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
bg = importlib.util.module_from_spec(spec)
sys.modules["bg_yaia_cli"] = bg
spec.loader.exec_module(bg)
LOG = bg.STATE / "yaia.jsonl"


def journal(action: str, ok: bool, **extra) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with open(LOG, "a") as fh:
        fh.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "action": action, "ok": ok, **extra},
                            ensure_ascii=False) + "\n")
    if not ok:
        bg._hub("Yaia : échec " + action, str(extra.get("cause", ""))[:400])


def rpc(method: str, params: dict, timeout: float = 30):
    return asyncio.run(bg._rpc_many([(method, params)], timeout))[0]


def room_of(name: str) -> dict:
    rooms = rpc("groups.list", {"limit": 200}).get("rooms", [])
    hit = [r for r in rooms if name in (r["room_id"], r.get("name"))]
    if len(hit) != 1:
        raise SystemExit(f"groupe « {name} » : {len(hit)} correspondance(s) ; groupes : "
                         + ", ".join(r.get("name", r["room_id"]) for r in rooms))
    return hit[0]


def author(ev: dict) -> tuple[str, str]:
    text = bg._text((ev.get("payload") or {}).get("text"))
    if ev.get("kind") == "message.member":
        a = ev.get("actor") or {}
        return a.get("display_name") or a.get("profile") or a.get("id") or "?", text
    if text.startswith("[") and "] " in text[:40]:
        who, body = text[1:].split("] ", 1)
        return ("Yaia" if who == "yaia" else who), body
    return "Yoan", text


def events(room_id: str, since: int) -> list:
    out, cur = [], since
    while True:
        page = rpc("groups.log", {"room_id": room_id, "since_seq": cur, "limit": 500})
        out += page.get("events", [])
        cur = max(cur, page.get("cursor") or 0)
        if not page.get("has_more") or not page.get("events"):
            return out


def show(evs: list) -> None:
    for ev in evs:
        if ev.get("kind") in ("message.user", "message.member"):
            who, text = author(ev)
            print(f"#{ev.get('seq')} {who} : {text}")


def main(argv: list) -> int:
    if not argv or argv[0] not in ("say", "read", "status"):
        print(__doc__)
        return 2
    cmd = argv[0]
    if cmd == "status":
        rows = [json.loads(line) for line in LOG.read_text().splitlines()] if LOG.exists() else []
        bad = [r for r in rows if not r["ok"]]
        print(f"{len(rows)} action(s), {len(bad)} échec(s) ; journal {LOG}")
        for r in rows[-10:]:
            print(f"  {r['ts']} {r['action']} {'ok' if r['ok'] else 'ÉCHEC ' + str(r.get('cause'))} {r.get('groupe', '')}")
        return 1 if bad and not rows[-1]["ok"] else 0
    if len(argv) < 2 or (cmd == "say" and len(argv) < 3):
        print(__doc__)
        return 2
    name = argv[1]
    try:
        room = room_of(name)
        if cmd == "say":
            res = rpc("plugin.bot-groups.yaia.send", {"room_id": room["room_id"], "text": " ".join(argv[2:])})
            journal("say", True, groupe=room.get("name"), event_id=res.get("event_id"))
            print(f"posté dans « {room.get('name')} » : {res.get('event_id')} (le meneur le lit au prochain passage)")
            return 0
        since = int(argv[argv.index("--since") + 1]) if "--since" in argv else None
        wait = min(float(argv[argv.index("--wait") + 1]), 60) if "--wait" in argv else 0
        evs = events(room["room_id"], since or 0)
        if since is None:
            msgs = [e for e in evs if e.get("kind") in ("message.user", "message.member")]
            show(msgs[-15:])
        else:
            deadline = time.time() + wait
            while wait and not any(author(e)[0] not in ("Yoan", "Yaia") for e in evs) and time.time() < deadline:
                time.sleep(3)
                evs = events(room["room_id"], since)
            show(evs)
        last = max([e.get("seq") or 0 for e in evs] or [since or 0])
        print(f"(dernière séquence : {last} ; suite : read {name!r} --since {last})")
        journal("read", True, groupe=room.get("name"), last=last)
        return 0
    except SystemExit:
        raise
    except Exception as exc:
        journal(cmd, False, groupe=name, cause=str(exc)[:300])
        print(f"échec {cmd} : {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
