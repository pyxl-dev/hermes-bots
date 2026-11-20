"""Lecture des citations @handle d'un message de groupe (plugins/bot-groups/routing.py), sans Hermes.

Cas vécus : « @dofus. » et « @rea: » lus comme des handles inconnus, le recadrage partait au meneur (2026-11-19).
Lancé par scripts/checks.sh dès qu'un fichier Python change.
"""
import importlib.util
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "plugins" / "bot-groups" / "routing.py"
spec = importlib.util.spec_from_file_location("routing", SRC)
routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routing)

M = [{"member_id": h, "handle": h} for h in ("dofus", "rea", "fz", "fz.a", "dofus-bot")]
CITED = [
    ("@dofus. regarde ça", ["dofus"]),
    ("puis @rea: vérifie", ["rea"]),
    ("(@dofus) et @REA !", ["dofus", "rea"]),
    ("@fz.a puis @fz.", ["fz.a", "fz"]),
    ("@dofus-bot seul", ["dofus-bot"]),
    ("écris à yoan@dofus.fr", []),
    ("@@dofus", []),
    ("@dofusien n'existe pas", []),
    ("@rea @rea, encore @rea", ["rea"]),
    ("personne", []),
]
bad = []
for text, want in CITED:
    got = [m["handle"] for m in routing.cited(text, M)]
    if got != want:
        bad.append(f"cited({text!r}) = {got}, attendu {want}")
z = "​"
NEUTRAL = [
    ("fini, @dofus.", {"dofus"}, f"fini, @{z}dofus."),
    ("voir @rea: ok", {"rea"}, f"voir @{z}rea: ok"),
    ("@meneur garde", {"dofus"}, "@meneur garde"),
]
for text, hs, want in NEUTRAL:
    got = routing.neutralize(text, hs)
    if got != want:
        bad.append(f"neutralize({text!r}) = {got!r}, attendu {want!r}")
if routing.cited_handles("merci @fz.", ["fz", "fz.a"]) != {"fz"}:
    bad.append("cited_handles : « @fz. » doit donner fz")
for b in bad:
    print("  ÉCHEC  " + b)
print(f"  {'ok' if not bad else 'ÉCHEC'}  citations : {len(CITED) + len(NEUTRAL) + 1 - len(bad)}/{len(CITED) + len(NEUTRAL) + 1}")
sys.exit(1 if bad else 0)
