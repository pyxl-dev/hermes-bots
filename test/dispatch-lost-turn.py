"""Une tâche de dispatch coupée par une perte de transport Hermes (gateway vivant, Mac saturé le 2026-11-17) est
relancée, avec une consigne de reprise après « Gateway disconnected », au lieu de poster « Je n'ai pas pu finir ».
Usage : python3 test/dispatch-lost-turn.py (sort 1 si un cas poste l'échec)."""
import importlib.util, json, os, sys, tempfile, time
from pathlib import Path

home = tempfile.mkdtemp()
os.environ["HOME"] = home
os.environ["BOT_GROUPS_RETRY_WAIT_S"] = "0"
plug = Path(__file__).resolve().parent.parent / "plugins" / "bot-groups"
spec = importlib.util.spec_from_file_location("bg", plug / "__init__.py", submodule_search_locations=[str(plug)])
bg = importlib.util.module_from_spec(spec); sys.modules["bg"] = bg; spec.loader.exec_module(bg)
d = importlib.import_module("bg.dispatch"); tr = importlib.import_module("bg.trace")
for f in ("round_start", "round_finish", "round_link"):
    setattr(tr, f, lambda *a, **k: None)
d._hub = lambda *a, **k: None
posts, spawns = [], []
d._post = lambda room, bot, body, lead, eid=None: posts.append(body)
d._spawn = lambda jid, q, s, meta: spawns.append((meta.get("tries"), q.startswith("[reprise")))
d.threading.Thread = lambda *a, **k: type("T", (), {"start": lambda self: None})()

CASES = {
    "disconnected": "Gateway disconnected; turn outcome is unknown. Resume the printed session ID to check whether it completed or was interrupted; do not resend the work.",
    "connection_failed": "Gateway connection failed; no local fallback",
    "session_busy": "session_busy",
}
fails = 0
for name, err in CASES.items():
    posts.clear(); spawns.clear()
    jid = "j" + name[:8]
    d.JOBS_DIR.mkdir(parents=True, exist_ok=True)
    meta = {"room_id": "r", "room": "R", "bot": "alpha-inject", "lead_handle": "alpha", "handles": [], "jid": jid,
            "session": "Groupe · R", "started": time.time(), "kind": "dispatch"}
    d._jobs[jid] = {**meta, "status": "running"}
    (d.JOBS_DIR / f"{jid}.out").write_text(json.dumps({"type": "result", "text": "", "error": err}) + "\n")
    (d.JOBS_DIR / f"{jid}.err").write_text("\nSession: local-abc\n")
    (d.JOBS_DIR / f"{jid}.query").write_text("fais X")
    (d.JOBS_DIR / f"{jid}.json").write_text(json.dumps(meta))
    d._finish(jid, meta, False)
    ok = bool(spawns) and spawns[0][1] == (name == "disconnected") and not any("pas pu finir" in p for p in posts)
    fails += not ok
    print(("GREEN " if ok else "RED   ") + name, "spawns=", spawns, "posts=", [p[:70] for p in posts])
sys.exit(1 if fails else 0)
