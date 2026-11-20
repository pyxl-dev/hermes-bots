"""Appel RPC au gateway de PROD par son socket local, sans navigateur (issue 91 : prod-plugin-reload annonçait à tort
« redémarrage requis » quand le navigateur CDP :9334 ne se connectait pas).
  <python du venv hermes-agent> scripts/prod-rpc.py <dossier du plugin> <méthode> [timeout_s]
Importe le plugin servi pour réutiliser son client (_rpc_many : identify, ticket, websocket). Sortie : le résultat en JSON
sur stdout, code 0 ; une erreur RPC en JSON {"error": ...}, code 2 ; tout autre échec, code 1.
"""
import asyncio
import importlib.util
import json
import os
import sys

d, method = sys.argv[1], sys.argv[2]
timeout = float(sys.argv[3]) if len(sys.argv) > 3 else 20
if os.environ.get("HOME", "").rstrip("/").endswith("_home"):
    sys.exit("HOME du gateway de test : ce script ne vise que la prod")
spec = importlib.util.spec_from_file_location("bg_prod_rpc", os.path.join(d, "__init__.py"), submodule_search_locations=[d])
bg = importlib.util.module_from_spec(spec)
sys.modules["bg_prod_rpc"] = bg
spec.loader.exec_module(bg)
try:
    res = asyncio.run(bg._rpc_many([(method, {})], timeout))[0]
except RuntimeError as e:
    print(json.dumps({"error": str(e)}, ensure_ascii=False))
    sys.exit(2)
print(json.dumps(res, ensure_ascii=False))
