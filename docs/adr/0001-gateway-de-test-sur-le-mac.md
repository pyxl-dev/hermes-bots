# Un gateway de test isolé sur le Mac, pas sur Fedora

Le plugin `bot-groups` ne se recharge qu'au redémarrage du gateway, et le gateway de prod porte les bots de travail de Yoan. Les essais du plugin, de la PWA candidate et des mises à jour de Hermes se font donc sur un second gateway, sur le même Mac (`HERMES_HOME=~/.hermes-test`, 127.0.0.1 seulement, lancé et arrêté par un script de test, jamais par `hermes gateway restart`). Il a ses propres profils de test, son mot de passe de test, une seule clé de modèle bridée par model-guard, et son état est recréé à chaque série depuis un modèle versionné dans le dépôt. La prod ne redémarre plus qu'une fois par version, sur décision de Yoan, une fois les parcours passés sur le gateway de test (2026-11-16).

## Considered Options

- **Fedora** : isolation de toute la machine, mais Hermes y est cassé (interpréteur introuvable), il faudrait le garder à la même version que le Mac, et l'écart systemd/launchd et les outils macOS laisseraient passer des défauts propres à la prod. On y reviendra seulement si les tests chargent trop le Mac.

## Consequences

- `group-journey.ts`, qui redémarre le gateway pendant une tâche, ne tourne plus que sur le gateway de test.
- `bun run release` recharge le plugin à chaud sur la prod quand il a changé (depuis le 2026-11-18) ; elle s'arrête sur « redémarrage prod requis » (alerte Hub) seulement si ce rechargement échoue.
- Les mises à jour de Hermes (`hermes update`) passent d'abord par le gateway de test : redémarrage à froid de `~/.hermes-test`, puis `real-journey.ts` et `group-journey.ts`. La prod ne redémarre qu'ensuite, sur décision de Yoan.
- Le code de Hermes (`~/.hermes/hermes-agent`) est partagé entre la prod et le test ; seules les données (`HERMES_HOME`) sont séparées. Une mise à jour du code touche donc les deux au prochain redémarrage : le test se redémarre en premier.
- Réalisation (2026-11-16) : `test/test-gateway.ts` ; le processus de test reçoit un `HOME` dont `.hermes` pointe sur `~/.hermes-test`, car `model-guard` et `bot-groups` codent `Path.home()/".hermes"` en dur (sans cela, le test aurait lu et écrit la prod).

## Révision du 2026-11-17 : les tests passent sur la Fedora

La condition prévue est arrivée : le Mac saturait (charge 48, 168 Mo de RAM libre), le gateway de prod perdait ses battements et les tâches des bots tombaient en « Gateway disconnected ». Les tests se lancent désormais sur la Fedora par `sh scripts/fedora-test.sh <script> [arguments]`, qui y copie le worktree et lance `bun` avec :

- `~/hermes-test-runtime/hermes` : une copie exacte du Hermes du Mac (même commit, modifications locales comprises, paquets Python aux versions du venv du Mac), indépendante du vieux `~/.hermes` cassé de la Fedora, qui n'est pas touché ;
- `~/hermes-test-runtime/source` : la clé `OPENCODE_GO_API_KEY` (posée par Yoan) et le plugin model-guard, à la place de la prod absente ;
- `HERMES_TEST_BIN` et `HERMES_TEST_SOURCE` lus par `test/test-gateway.ts` ; sans eux, rien ne change sur le Mac.

Une mise à jour de Hermes sur le Mac impose de recopier `hermes-agent` et le venv sur la Fedora avant le test, sinon on teste une autre version que la prod.
