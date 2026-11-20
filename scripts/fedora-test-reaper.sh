#!/bin/sh
# Arrête, sur la Fedora, les gateways Hermes de test (~/hermes-test-runtime) lancés il y a plus de MAX_AGE_MIN minutes.
# Pourquoi (2026-11-17) : test-gateway.ts lance le gateway détaché et partagé entre sessions ; rien ne l'arrête quand une
# session finit. Trois instances (~/.hermes-test, -steer, -lead) sont restées 7 à 9 h à ~1,5 cœur chacune, la Fedora soufflait.
# Un gateway arrêté ici est relancé par le prochain `test-gateway.ts start/ensure` (pidfile mort = pas démarré).
#   sh scripts/fedora-test-reaper.sh install   # sur la Fedora : copie dans ~/bin et active la minuterie (toutes les 10 min)
#   hermes-test-reaper                         # une passe
#   hermes-test-reaper status                  # dernières actions
set -u
MAX_AGE_MIN=${MAX_AGE_MIN:-120}
LOG=$HOME/.local/state/hermes-bots-pwa/test-reaper.jsonl
mkdir -p "$(dirname "$LOG")"
log() { printf '{"ts":"%s","action":"%s","ok":%s,"detail":"%s"}\n' "$(date -Iseconds)" "$1" "$2" "$3" >>"$LOG"; }
notify() { # alerte Hub, même source que power-watch
  [ -f "$HOME/.config/power-watch.env" ] || return 0
  ( . "$HOME/.config/power-watch.env"; curl -s -m 10 -o /dev/null -H "Authorization: Bearer $HUB_TOKEN" -H "Priority: 4" -H "Title: $1" -d "$2" "$HUB_URL" )
}

case "${1:-run}" in
status)
  [ -f "$LOG" ] || { echo "aucune action journalisée ($LOG)"; exit 0; }
  tail -n 10 "$LOG"
  echo "échecs sur 7 jours : $(awk -v d="$(date -d '-7 days' -Iseconds)" -F'"' '$4 >= d && /"ok":false/' "$LOG" | wc -l)"
  echo "minuterie : $(systemctl --user is-active hermes-test-reaper.timer 2>/dev/null)"
  exit 0 ;;
install)
  install -Dm755 "$0" "$HOME/bin/hermes-test-reaper"
  d=$HOME/.config/systemd/user
  mkdir -p "$d"
  printf '[Unit]\nDescription=Arrête les gateways Hermes de test oubliés (hermes-bots-pwa)\n[Service]\nType=oneshot\nExecStart=%%h/bin/hermes-test-reaper\n' >"$d/hermes-test-reaper.service"
  printf '[Unit]\nDescription=Passe du récupérateur de gateways de test toutes les 10 min\n[Timer]\nOnBootSec=5min\nOnUnitActiveSec=10min\n[Install]\nWantedBy=timers.target\n' >"$d/hermes-test-reaper.timer"
  systemctl --user daemon-reload && systemctl --user enable --now hermes-test-reaper.timer
  log install true "~/bin/hermes-test-reaper, minuterie 10 min, seuil ${MAX_AGE_MIN} min"
  echo "installé : $(systemctl --user is-active hermes-test-reaper.timer)"
  exit 0 ;;
run) ;;
*) echo "usage : hermes-test-reaper [run|status|install]" >&2; exit 2 ;;
esac

seen=0 reaped=0 failed=0
# motif ancré sur l'exécutable : un shell dont la ligne de commande cite ce texte ne doit jamais être pris (raté du 2026-11-17)
for pid in $(pgrep -f '^[^ ]*/hermes-test-runtime/venv/bin/python .* gateway run'); do
  age=$(ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ')
  [ -n "$age" ] || continue
  seen=$((seen + 1))
  [ "$age" -ge $((MAX_AGE_MIN * 60)) ] || continue
  home=$(readlink "/proc/$pid/cwd" 2>/dev/null || echo "?")
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
  i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null; sleep 1; fi
  if kill -0 "$pid" 2>/dev/null; then
    failed=$((failed + 1)); log reap false "pid $pid ($home) survit à SIGKILL"
    notify "Fedora : gateway de test bloqué" "pid $pid ($home) ne s'arrête pas, la Fedora reste chargée"
  else
    reaped=$((reaped + 1)); rm -f "$home/test-gateway.pid"; log reap true "pid $pid ($home), lancé il y a $((age / 60)) min"
  fi
done
log run "$([ $failed -eq 0 ] && echo true || echo false)" "$seen vus, $reaped arrêtés, $failed échecs"
[ $failed -eq 0 ]
