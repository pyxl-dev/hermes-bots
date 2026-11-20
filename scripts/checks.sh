#!/bin/sh
# Contrôles partagés par les hooks git (.githooks/) et la CI (.github/workflows/ci.yml). Chacun tient sous 60 s (règle de Yoan, relevée de 30 à 60 s le 2026-11-17).
#   sh scripts/checks.sh served       refuse de travailler dans la copie servie (premier worktree, d'où la prod charge la PWA et le plugin)
#   sh scripts/checks.sh secrets      gitleaks sur l'index (pre-commit) ; « secrets all » : tout l'historique de la branche (CI)
#   sh scripts/checks.sh static FICHIERS...   types, syntaxe TS, ruff, contrats, selon les fichiers donnés
#   sh scripts/checks.sh format FICHIERS...   prettier --check sur les fichiers donnés (bun run format pour corriger)
#   sh scripts/checks.sh version BASE         APP_VERSION incrémentée si le client (web/) diffère de BASE
#   sh scripts/checks.sh smoke | releases
set -e
ROOT=$(git rev-parse --show-toplevel); cd "$ROOT"
die() { echo "REFUSÉ ($1) : $2" >&2; exit 1; }
tscheck() { bun build --no-bundle "$@" --outdir "${TMPDIR:-/tmp}/hbp-tscheck" >/dev/null; }
timed() { name=$1; shift; t=$(date +%s); "$@" || die "$name" "échec ci-dessus"; d=$(( $(date +%s) - t )); echo "  ok  $name (${d} s)"; [ "$d" -le 60 ] || die "$name" "${d} s : un contrôle de plus de 60 s est un mauvais contrôle, à découper ou accélérer"; }

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
    echo "$files" | tr ' ' '\n' | grep -qE '^web/(src/|tsconfig)' && timed "types du client (tsc)" bunx tsc -p web/tsconfig.json
    ts=$(echo "$files" | tr ' ' '\n' | grep -E '\.ts$' | grep -v '^web/src/' | while read -r f; do [ -f "$f" ] && echo "$f"; done | tr '\n' ' ')
    [ -n "$ts" ] && timed "syntaxe TypeScript" tscheck $ts
    # le client v88 n'a plus d'ids : un parcours qui vise "#input" ou "#send" attend 30 s puis échoue (PR 83, 2026-11-18)
    tj=$(echo "$ts" | tr ' ' '\n' | grep '^test/' | tr '\n' ' ')
    if [ -n "$tj" ] && grep -nE '(fill|click|locator|textContent|waitForSelector)\("#[a-z]' $tj; then die "sélecteurs" "sélecteur par id de l'ancien client dans un parcours : passer par data-testid (ADR 0004)"; fi
    echo "$files" | tr ' ' '\n' | grep -qE '^(web/src/data/(turn|thread)\.ts|test/live-turn\.ts)$' && timed "tour en direct (parité)" bun test/live-turn.ts
    echo "$files" | tr ' ' '\n' | grep -q '\.py$' && timed "ruff (plugin et tests)" ruff check plugins test
    echo "$files" | tr ' ' '\n' | grep -qE '^(plugins/bot-groups/dispatch\.py|test/dispatch-lost-turn\.py)$' && timed "relance après coupure (dispatch)" python3 test/dispatch-lost-turn.py
    echo "$files" | tr ' ' '\n' | grep -q '\.py$' && timed "causes transitoires (dispatch)" python3 test/transient_causes.py
    echo "$files" | tr ' ' '\n' | grep -q '\.py$' && timed "cartes réparées (ui_guard)" python3 test/ui_guard_repair.py
    echo "$files" | tr ' ' '\n' | grep -q '\.py$' && timed "citations (routing)" python3 test/routing_cases.py
    echo "$files" | tr ' ' '\n' | grep -qE '^(web/src/|test/contract|test/fixtures/contracts)' && timed "contrats RPC (instantané)" bun run check
    true ;;
  format)
    shift; fs=$(for f in "$@"; do [ -f "$f" ] && echo "$f"; done | tr '\n' ' ')
    [ -n "$fs" ] && timed "format (prettier)" bunx prettier --check --ignore-unknown --log-level warn $fs
    true ;;
  version)
    base=$2
    # Le client vit dans web/ (source) depuis la v88 ; avant, dans app/. On lit la version de base là où elle était.
    if git diff --quiet "$base" -- web/ ':!web/public/version.js' && git diff --quiet "$base" -- app/ ':!app/version.js'; then echo "  ok  client inchangé, APP_VERSION libre"; exit 0; fi
    q="[\"']"; old=$( (git show "$base:web/public/version.js" 2>/dev/null || git show "$base:app/version.js") | sed -n "s/.*APP_VERSION = $q\([^\"']*\)$q.*/\1/p"); new=$(sed -n "s/.*APP_VERSION = $q\([^\"']*\)$q.*/\1/p" web/public/version.js)
    [ "$old" != "$new" ] || die "APP_VERSION" "le client a changé depuis $base mais APP_VERSION reste $old : incrémente-la dans web/public/version.js"
    echo "  ok  APP_VERSION $old -> $new" ;;
  smoke) timed "build du client (vite)" bun run build; timed "smoke sur le mock" bun test/smoke.ts ;;
  releases) timed "versions figées (server.ts réel)" bun test/releases.ts ;;
  *) echo "usage : sh scripts/checks.sh served|secrets [all]|static FICHIERS|format FICHIERS|version BASE|smoke|releases" >&2; exit 2 ;;
esac
