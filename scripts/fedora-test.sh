#!/bin/sh
# Lance un script de test du dépôt sur la Fedora au lieu du Mac (ADR 0001 : on y revient quand les tests chargent trop
# le Mac, constaté le 2026-11-17 : charge 48, gateway de prod en perte de battement).
#   sh scripts/fedora-test.sh test/test-gateway.ts ensure
#   sh scripts/fedora-test.sh test/real-journey.ts
#   sh scripts/fedora-test.sh test/group-journey.ts
# Copie ce worktree (sans .git ni node_modules) dans ~/hermes-bots-pwa-test/<worktree> sur la Fedora, puis y lance
# `bun <arguments>` avec le Hermes de test de la Fedora (~/hermes-test-runtime/hermes, copie du Hermes du Mac) et sa
# source de clé et de model-guard (~/hermes-test-runtime/source). La prod du Mac n'est jamais touchée.
# FEDORA_HOST change l'hôte ssh (défaut : fedora). HERMES_TEST_HOME (seul son nom compte : ~/<nom> sur la Fedora) et
# HERMES_TEST_PORT passent tels quels : seconde instance quand une autre session occupe ~/.hermes-test (2026-11-17).
# Les gateways de test lancés ici restent vivants après la session : la minuterie hermes-test-reaper de la Fedora
# (scripts/fedora-test-reaper.sh) arrête ceux de plus de 2 h. Arrêt immédiat : sh scripts/fedora-test.sh test/test-gateway.ts stop
set -eu
[ $# -ge 1 ] || { echo "usage : sh scripts/fedora-test.sh <script bun> [arguments]" >&2; exit 2; }
HOST=${FEDORA_HOST:-fedora}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME=$(basename "$ROOT")
DEST="hermes-bots-pwa-test/$NAME"
ssh -o BatchMode=yes "$HOST" "mkdir -p ~/$DEST"
rsync -a --delete --exclude .git --exclude node_modules --exclude .claude "$ROOT/" "$HOST:$DEST/"
# arguments recollés un par un entre apostrophes : aucun n'est réinterprété par le shell distant
args=""
for a in "$@"; do args="$args '$(printf %s "$a" | sed "s/'/'\\\\''/g")'"; done
inst=""
if [ -n "${HERMES_TEST_HOME:-}" ]; then
  n=$(basename "$HERMES_TEST_HOME"); case "$n" in .hermes-test*) ;; *) echo "HERMES_TEST_HOME doit commencer par .hermes-test" >&2; exit 2 ;; esac
  inst="export HERMES_TEST_HOME=\$HOME/$n;"
fi
if [ -n "${HERMES_TEST_PORT:-}" ]; then inst="$inst export HERMES_TEST_PORT=$(printf %d "$HERMES_TEST_PORT");"; fi

exec ssh -o BatchMode=yes "$HOST" "set -e; export PATH=/home/linuxbrew/.linuxbrew/bin:\$PATH; cd ~/$DEST
bun install --frozen-lockfile --ignore-scripts >/dev/null
ls ~/.cache/ms-playwright 2>/dev/null | grep -q chromium_headless_shell || bunx playwright-core install chromium-headless-shell >/dev/null
export HERMES_TEST_BIN=\$HOME/hermes-test-runtime/hermes HERMES_TEST_SOURCE=\$HOME/hermes-test-runtime/source
$inst
exec bun$args"
