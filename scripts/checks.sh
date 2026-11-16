#!/bin/sh
# Contrôles partagés par les hooks git (.githooks/) et la CI (.github/workflows/ci.yml). Chacun tient sous 30 s (règle de Yoan).
#   sh scripts/checks.sh served       refuse de travailler dans la copie servie (premier worktree, d'où la prod charge la PWA et le plugin)
#   sh scripts/checks.sh secrets      gitleaks sur l'index (pre-commit) ; « secrets all » : tout l'historique de la branche (CI)
#   sh scripts/checks.sh static FICHIERS...   types, syntaxe TS, ruff, contrats, selon les fichiers donnés
#   sh scripts/checks.sh version BASE         APP_VERSION incrémentée si app/ diffère de BASE
#   sh scripts/checks.sh smoke | releases
set -e
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
die() { echo "REFUSÉ ($1) : $2" >&2; exit 1; }
tscheck() { bun build --no-bundle "$@" --outdir "${TMPDIR:-/tmp}/hbp-tscheck" >/dev/null; }
timed() { name=$1; shift; t=$(date +%s); "$@" || die "$name" "échec ci-dessus"; d=$(( $(date +%s) - t )); echo "  ok  $name (${d} s)"; [ "$d" -le 30 ] || die "$name" "${d} s : un contrôle de plus de 30 s est un mauvais contrôle, à découper ou accélérer"; }

case "$1" in
  served)
    served=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
    [ -z "$CI" ] && [ "$ROOT" = "$served" ] && die "copie servie" "$ROOT est la copie servie (prod). Travaille dans un worktree ; ici on fait seulement git pull via la release."
    echo "  ok  hors de la copie servie" ;;
  secrets)
    command -v gitleaks >/dev/null || die "secrets" "gitleaks absent : brew install gitleaks"
    if git diff --cached --name-only | grep -E '(^|/)\.env(\.|$)' | grep -v '\.example$' >/dev/null; then die "secrets" "un fichier .env est indexé"; fi
    if [ "$2" = all ]; then timed "gitleaks (historique)" gitleaks git --no-banner --log-level warn --redact .
    else timed "gitleaks (index)" gitleaks git --no-banner --log-level warn --redact --staged --pre-commit .; fi ;;
  static)
    shift; files="$*"
    echo "$files" | tr ' ' '\n' | grep -q '^app/.*\.js$' && timed "types de app/ (tsc)" bunx tsc -p jsconfig.json
    ts=$(echo "$files" | tr ' ' '\n' | grep -E '\.ts$' | while read -r f; do [ -f "$f" ] && echo "$f"; done | tr '\n' ' ')
    [ -n "$ts" ] && timed "syntaxe TypeScript" tscheck $ts
    echo "$files" | tr ' ' '\n' | grep -q '\.py$' && timed "ruff (plugin et tests)" ruff check plugins test
    echo "$files" | tr ' ' '\n' | grep -qE '^(app/|test/contract|test/fixtures/contracts)' && timed "contrats RPC (instantané)" bun run check
    true ;;
  version)
    base=$2
    if git diff --quiet "$base" -- app/ ':!app/version.js'; then echo "  ok  app/ inchangé, APP_VERSION libre"; exit 0; fi
    old=$(git show "$base:app/version.js" | sed -n "s/.*APP_VERSION = '\([^']*\)'.*/\1/p"); new=$(sed -n "s/.*APP_VERSION = '\([^']*\)'.*/\1/p" app/version.js)
    [ "$old" != "$new" ] || die "APP_VERSION" "app/ a changé depuis $base mais APP_VERSION reste $old : incrémente-la dans app/version.js"
    echo "  ok  APP_VERSION $old -> $new" ;;
  smoke) timed "smoke sur le mock" bun test/smoke.ts ;;
  releases) timed "versions figées (server.ts réel)" bun test/releases.ts ;;
  *) echo "usage : sh scripts/checks.sh served|secrets [all]|static FICHIERS|version BASE|smoke|releases" >&2; exit 2 ;;
esac
