"""Cartes illisibles réparées par plugins/bot-groups/ui_guard.py : blocs réels du groupe dofus (17 et 18/11, issue 91
point 6), raccourcis. Chacun doit sortir valide, avec ses lignes de tableau en listes de la bonne largeur.
Lancé par scripts/checks.sh dès qu'un fichier Python change.
"""
import importlib.util
import sys
from pathlib import Path

SRC = Path(__file__).resolve().parent.parent / "plugins" / "bot-groups" / "ui_guard.py"
spec = importlib.util.spec_from_file_location("ui_guard", SRC)
ug = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ug)

CASES = {
    "] de fin de ligne oublié": '[{"type":"table","columns":["a","b"],"rows":[["x","1"],["y","2"]}]',
    "[ d'ouverture de ligne oublié": '[{"type":"table","columns":["a","b"],"rows":[["x","1"],"y","2"],["z","3"]]}]',
    "lignes en objets numérotés": '[{"type":"table","columns":["a","b"],"rows":[{"0":"x","1":"1"},{"0":"y","1":"2"}]}]',
    "cellule oubliée": '[{"type":"table","columns":["heure","trame","réponse"],"rows":[["1","a","b"],["2","c"]]}]',
    "coin de tableau vide": '[{"type":"table","columns":["","OnlyBot","Frigost"],"rows":[["os","win","win"]]}]',
}
bad = []
for name, raw in CASES.items():
    blocks, errs, _ = ug.check_ex(raw)
    if blocks is None or any(errs):
        bad.append(f"{name} : {errs}")
        continue
    t = blocks[0] if isinstance(blocks, list) else blocks
    if not all(isinstance(r, list) and len(r) == len(t["columns"]) for r in t["rows"]):
        bad.append(f"{name} : lignes {t['rows']}")
# un vrai bloc cassé reste refusé (pas de réparation qui invente du contenu)
if ug.check_ex('{"type":"table","columns":["a","b"],"rows":[["pas","12 ms"]] "x"}')[0] not in (None,) and \
        not any(ug.check_ex('{"type":"table","columns":["a","b"],"rows":[["pas","12 ms"]] "x"}')[1]):
    bad.append("bloc cassé accepté")
for b in bad:
    print(f"  KO  carte : {b}", file=sys.stderr)
print(f"  {'KO' if bad else 'ok'}  cartes réparées : {len(CASES) + 1 - len(bad)}/{len(CASES) + 1}")
sys.exit(1 if bad else 0)
