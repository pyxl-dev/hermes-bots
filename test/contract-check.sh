#!/bin/sh
# Instantané des contrats du VRAI gateway Hermes (installé dans ~/.hermes), lu par `bun run check` (test/contract-check.ts, CI comprise).
#   sh test/contract-check.sh snapshot  réécrit test/fixtures/contracts.json
#   sh test/contract-check.sh fresh     échoue si l'instantané versionné ne correspond plus au gateway installé
HERE=$(cd "$(dirname "$0")" && pwd)
ENV=$(ls -d ~/.hermes/installs/*/environments/*/ | head -1)
case "$1" in
  snapshot) ARGS="" ;;
  fresh) ARGS="--check" ;;
  *) echo "usage : sh test/contract-check.sh snapshot|fresh" >&2; exit 2 ;;
esac
cd "$ENV/workspace" && PYTHONPATH="$ENV/workspace" exec "$ENV/venv/bin/python" "$HERE/contract_snapshot.py" $ARGS
