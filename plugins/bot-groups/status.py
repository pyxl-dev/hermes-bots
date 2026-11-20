#!/usr/bin/env python3
"""python3 ~/.hermes/plugins/bot-groups/status.py : groupes créés par les bots, derniers échecs."""
import json
from pathlib import Path
d = Path.home() / ".hermes" / "data" / "bot-groups"
rows = [json.loads(l) for l in (d / "actions.jsonl").read_text().splitlines() if l.strip()] if (d / "actions.jsonl").exists() else []
fails = [r for r in rows if not r["ok"]]
print(f"actions: {len(rows)}, échecs: {len(fails)}")
for r in fails[-5:]:
    print(f"  ÉCHEC {r['ts']} {r['action']} {r.get('caller') or r.get('profile', '')} : {r.get('cause') or r.get('error', '')}")
led = json.loads((d / "rooms.json").read_text()) if (d / "rooms.json").exists() else {"rooms": {}}
print(f"groupes actifs créés par les bots (vus à la dernière création) : {len(led['rooms'])}")
for rid, v in led["rooms"].items():
    print(f"  {v['name']} ({rid[:8]}) par {v['creator']} : {', '.join(v['members'])}")

# fil de travail : fils gardés (30 jours), derniers échecs de collecte, arrêts demandés
tdir = d / "traces"
n_eng = n_round = 0
if tdir.exists():
    for idx in tdir.glob("*/index.jsonl"):
        for l in idx.read_text().splitlines():
            try:
                op = json.loads(l)
            except ValueError:
                continue
            if op.get("o") == "start":
                n_eng += op.get("kind") == "engine"
                n_round += op.get("kind") == "round"
tf = [r for r in rows if r["action"].startswith("trace_") and not r["ok"]]
stops = [r for r in rows if r["action"] in ("member_stop", "dispatch_stop", "dispatch_stopped")]
print(f"fils de travail : {n_eng} du moteur, {n_round} de table ronde ; arrêts : {len(stops)} ; échecs de collecte : {len(tf)}")
for r in tf[-3:]:
    print(f"  ÉCHEC {r['ts']} {r['action']} {r.get('where', '')} : {r.get('cause', '')}")


# horloge : échecs du crochet pre_llm_call (clock.py), conversations suivies
ck = [r for r in rows if r["action"] == "clock"]
seen = d / "clock.json"
n_seen = len(json.loads(seen.read_text())) if seen.exists() else 0
print(f"horloge : {n_seen} conversations suivies ; échecs : {len(ck)}")
for r in ck[-3:]:
    print(f"  ÉCHEC {r['ts']} clock {r.get('session', '')} : {r.get('cause', '')}")

# inbox.py : messages gardés pendant une discussion (demandes suivantes, recadrages lus, résultats), posés entre deux tours
inbox = json.loads((d / "inbox.json").read_text()) if (d / "inbox.json").exists() else {}
ib = [r for r in rows if r["action"] == "inbox_flush"]
ibf = [r for r in ib if not r["ok"]]
print(f"inbox : {sum(len(v) for v in inbox.values())} gardés ; posés : {len(ib) - len(ibf)} fois ; échecs : {len(ibf)}")
for r in ibf[-3:]:
    print(f"  ÉCHEC {r['ts']} inbox_flush {r.get('room_id', '')[:8]} : {r.get('cause', '')}")
# recadrages (steer.py) : par issue (steered, side, held, fallback), et échecs
st = [r for r in rows if r["action"] == "steer_send"]
stf = [r for r in st if not r["ok"]]
modes = {}
for r in st:
    if r not in stf:
        modes[r.get("mode")] = modes.get(r.get("mode"), 0) + 1
print(f"recadrages : {modes or 'aucun'} ; échecs : {len(stf)}")
for r in stf[-5:]:
    print(f"  ÉCHEC {r['ts']} {r['action']} {r.get('bot', '')} : {r.get('cause', '')}")
ls = [r for r in rows if r["action"] == "lead_steer"]
lsf = [r for r in ls if not r["ok"]]
lsr = [r for r in ls if r["ok"] and r.get("refused")]
print(f"recadrages du meneur : {len(ls) - len(lsf) - len(lsr)} pris ; refusés : {len(lsr)} ; échecs : {len(lsf)}")
for r in lsf[-3:]:
    print(f"  ÉCHEC {r['ts']} lead_steer {r.get('bot', '')} : {r.get('cause', '')}")

# tableau du groupe (tasks.py) : fermetures en fin de discussion, rattrapage Jev, échecs
st = [r for r in rows if r["action"] == "task_settle"]
jv = [r for r in rows if r["action"] == "task_jev"]
tkf = [r for r in rows if r["action"] == "task_failed"]
print(f"tableau : {sum(len(r.get('closed') or []) for r in st)} tâches fermées en fin de discussion ; "
      f"Jev : {len(jv)} passes, {sum(1 for r in jv if r.get('created'))} tâches créées ; échecs : {len(tkf)}")
for r in tkf[-3:]:
    print(f"  ÉCHEC {r['ts']} task {r.get('op', '')} {str(r.get('room_id', ''))[:8]} : {r.get('cause', '')}")
