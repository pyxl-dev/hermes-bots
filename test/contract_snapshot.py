"""Instantané des contrats du VRAI gateway Hermes : méthodes RPC et champs de paramètres acceptés.

Écrit test/fixtures/contracts.json, que `bun run check` lit (CI comprise : pas besoin de ~/.hermes).
Lance avec le Python de l'install Hermes : `bun run check:snapshot` (voir test/contract-check.sh).
Sans argument, écrit le fichier ; avec `--check`, sort 1 si le fichier versionné diffère du gateway installé.
"""
import json, pathlib, sys

OUT = pathlib.Path(__file__).resolve().parent / "fixtures" / "contracts.json"
from tui_gateway.contracts import registry  # noqa: E402  (importé via le workspace Hermes)
import tui_gateway.server  # noqa: F401  remplit les tables de contrats

def fields(c):
    return sorted(getattr(c.params, "model_fields", {}).keys())

snap = {
    "methods": {n: fields(c) for n, c in sorted(registry.METHODS.items())},
    "canonical": {n: fields(c) for n, c in sorted(registry.CANONICAL_METHODS.items())},
}
text = json.dumps(snap, indent=1, ensure_ascii=False, sort_keys=True) + "\n"
if "--check" in sys.argv:
    same = OUT.exists() and OUT.read_text() == text
    print("instantané des contrats " + ("à jour" if same else "PÉRIMÉ : bun run check:snapshot, puis commiter test/fixtures/contracts.json"))
    sys.exit(0 if same else 1)
OUT.parent.mkdir(exist_ok=True)
OUT.write_text(text)
print(f"{len(snap['methods'])} méthodes, {len(snap['canonical'])} canoniques -> {OUT}")
