"""Tri des échecs de `hermes chat` : relancés (coupure du gateway) ou posés comme échec du bot.

Lit les vraies fonctions de plugins/bot-groups/dispatch.py (sans importer Hermes) et les rejoue sur des causes
relevées dans le journal de prod. Lancé par scripts/checks.sh dès qu'un fichier Python change.
"""
import ast
import re
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "plugins" / "bot-groups" / "dispatch.py"
tree = ast.parse(SRC.read_text())
keep = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in ("_transient_cause", "readable"))
        or (isinstance(n, ast.Assign) and any(getattr(t, "id", "") in ("_INTERRUPTED", "_LOST", "_READABLE")
                                               for t in n.targets))]
ns: dict = {"re": re}
exec(compile(ast.Module(body=keep, type_ignores=[]), str(SRC), "exec"), ns)
transient = ns["_transient_cause"]

RETRY = [
    # 3 bots perdus le 2026-11-17 à 00:35 : session.create a dépassé 30 s sur un gateway chargé
    "Gateway connection failed; no local fallback",
    "Gateway connection failed; no local fallback (TimeoutError)",
    "Gateway connection timed out; no local fallback",
    "résultat non posté : groups.send : runtime_draining {",
    "Gateway restarting: this turn was interrupted",
    # le tour a pu tourner : relancé dans la même session avec la consigne de reprise (_RESUME, PR 72), qui
    # redonne la réponse finale sans rejouer la tâche si elle est déjà faite ; détail dans test/dispatch-lost-turn.py
    "Gateway disconnected; turn outcome is unknown. Resume the printed session ID to check whether it finished.",
]
FAIL = [
    "délai de 30 min dépassé",
    "délai de 45 min dépassé",
    "réponse vide",
]

bad = [c for c in RETRY if not transient(c)] + [c for c in FAIL if transient(c)]
# Ce que le groupe lit d'un échec (dispatch.readable) : causes brutes relevées dans le groupe alpha, 2026-11-16 à 18.
# Jamais d'URL, d'identifiant de session ni de commande ; le refus du fournisseur dit de ne pas relancer.
said = {c: ns["readable"](c) for c in (
    "HTTP 403: Model access is disabled. Change model access at https://opencode.ai/console/wrk_X/go.",
    "Your message was not sent. To continue, run `hermes sessions discard local-0123456789abcdef0123`",
    "Session: local-0123456789abcdef0123 session_id: local-0123456789abcdef0123",
)}
bad += [f"{c} -> {r}" for c, r in said.items() if re.search(r"https?://|local-[0-9a-f]{8}|hermes sessions", r)]
bad += [] if "Ne me relance pas" in next(iter(said.values())) else ["quota : pas de consigne de ne pas relancer"]
for c in bad:
    print(f"  KO  mal classée : {c}", file=sys.stderr)
print(f"  {'KO' if bad else 'ok'}  causes transitoires : {len(RETRY) + len(FAIL) - len(bad)}/{len(RETRY) + len(FAIL)}")
sys.exit(1 if bad else 0)
