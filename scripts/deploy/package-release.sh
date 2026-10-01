#!/usr/bin/env bash
#
# EMPAQUETA EL RELEASE que viaja al servidor. Lo usa el CI y se puede correr en local para probar el
# despliegue igual que en dev. Construir ACÁ y no en el servidor es la diferencia entre un build roto que
# falla en rojo y uno que deja a medias la máquina que está sirviendo partidas.
#
#   package-release.sh pm2 <salida.tgz>            dist/ + lo necesario para `npm ci --omit=dev` y pm2
#   package-release.sh docker <salida.tgz>         compose + scripts: la imagen viaja APARTE (image.tar.gz)
#   package-release.sh docker-build <salida.tgz>   el código fuente: el servidor construye la imagen
#
# Todos llevan los scripts de despliegue (`scripts/deploy`): así el procedimiento es siempre el de la
# versión que se está desplegando y no el que alguien dejó escrito en el servidor.
#
# Portado de games-orchestrator (`packages/deploy`, 7528030), sin la carpeta de app: el repo es el dominó.
set -euo pipefail

mode="${1:?uso: package-release.sh pm2|docker|docker-build <salida.tgz>}"
out="$(realpath -m "${2:?falta el archivo de salida}")"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo"

common=(package.json package-lock.json scripts/deploy)

case "$mode" in
pm2)
  [ -f dist/main.js ] || {
    echo "✗ falta dist/: corré \`npm run build\` primero" >&2
    exit 1
  }
  files=("${common[@]}" dist ecosystem.config.cjs)
  ;;
docker)
  files=("${common[@]}" compose.yaml)
  ;;
docker-build)
  # Todo lo versionado y lo nuevo sin versionar, pero nunca lo ignorado (`.env`, `node_modules`, `dist`):
  # `tar .` empaquetaría los secretos de quien lo corra. El Dockerfile y su .dockerignore filtran después.
  mapfile -t files < <(git ls-files --cached --others --exclude-standard)
  ;;
*)
  echo "✗ modo desconocido: $mode" >&2
  exit 1
  ;;
esac

# Los tests de los scripts no viajan: son del repo, no del servidor.
tar -czf "$out" --exclude='scripts/deploy/tests' "${files[@]}"
echo "✓ dominó $mode → $out ($(du -h "$out" | cut -f1))"
