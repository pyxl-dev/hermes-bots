"""Lecture des citations @handle d'un message de groupe (plugins/bot-groups/routing.py), sans Hermes.

Cas vécus : « @alpha. » et « @rea: » lus comme des handles inconnus, le recadrage partait au meneur (2026-11-19).
Lancé par scripts/checks.sh dès qu'un fichier Python change.
"""
import importlib.util
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "plugins" / "bot-groups" / "routing.py"
spec = importlib.util.spec_from_file_location("routing", SRC)
routing = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routing)

M = [{"member_id": h, "handle": h} for h in ("alpha", "rea", "fz", "fz.a", "alpha-bot")]
CITED = [
    ("@alpha. regarde ça", ["alpha"]),
    ("puis @rea: vérifie", ["rea"]),
    ("(@alpha) et @REA !", ["alpha", "rea"]),
    ("@fz.a puis @fz.", ["fz.a", "fz"]),
    ("@alpha-bot seul", ["alpha-bot"]),
    ("écris à yoan@example.com", []),
    ("@@alpha", []),
    ("@alphaien n'existe pas", []),
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
    ("fini, @alpha.", {"alpha"}, f"fini, @{z}alpha."),
    ("voir @rea: ok", {"rea"}, f"voir @{z}rea: ok"),
    ("@meneur garde", {"alpha"}, "@meneur garde"),
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
