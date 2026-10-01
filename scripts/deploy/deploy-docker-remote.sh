#!/usr/bin/env bash
#
# EL DESPLIEGUE CON DOCKER, visto desde el servidor: el medio ALTERNO a pm2, con el mismo layout, los
# mismos modos y las mismas garantías (`lib/deploy-common.sh`). Elegir uno u otro es una variable del
# workflow (`DEPLOY_MODE`); no corren los dos a la vez.
#
#   deploy-docker-remote.sh              despliega el release que contiene a este script
#   deploy-docker-remote.sh --rollback   vuelve al otro release: su imagen sigue cargada, no se baja nada
#   deploy-docker-remote.sh --restart    recrea el contenedor sin cambiar de versión
#
# LA IMAGEN llega de una de dos formas, y el script mira qué trae el release:
#   image.tar.gz   la construyó el CI (etapa `runtime` del Dockerfile) y viajó por scp → `docker load`
#   Dockerfile     el release trae el código y la imagen se CONSTRUYE ACÁ (`docker compose build`)
# En ambos casos queda con la etiqueta `domino:<id del release>`, que es lo que hace el rollback posible:
# volver es apuntar a la etiqueta anterior. Se conservan las de la que corre y la anterior.
#
# Mongo, Redis y RabbitMQ NO los levanta este compose en el servidor: son del VPS (`MONGO_URI`,
# `REDIS_URL` y `RABBITMQ_URL` del `shared/.env`, con `host.docker.internal` en vez de `127.0.0.1`).
#
# UNA SOLA INSTANCIA. Varias exigen que el proxy rutee cada partida a SU proceso (el prefijo de path
# del README, `SERVER_ADDRESS`), y eso solo está resuelto con pm2. Con más, este script se niega.
#
# Variables esperadas: APP_NAME (obligatoria: nombre del proyecto de compose), INSTANCES (solo 1) y APP_ENV.
set -euo pipefail

DEPLOY_SCRIPT="deploy-docker-remote.sh"
DEPLOY_ENV_KEYS=""

# shellcheck source=lib/deploy-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/deploy-common.sh"
deploy_init "${BASH_SOURCE[0]}"

[ "$INSTANCES" -eq 1 ] ||
  die "con Docker el dominó corre en UNA instancia (se pidieron $INSTANCES): varias necesitan el ruteo por path, que es de pm2"

# Siempre por el symlink `current`, como en pm2: así la definición del compose no cambia de un release a
# otro y Docker no recrea lo que no cambió.
COMPOSE_FILE="$CURRENT/compose.yaml"
export ENV_FILE="$SHARED_ENV"
# Solo el dominó del servidor (`domino-server`): el resto del compose es para desarrollo local.
export COMPOSE_PROFILES=server

compose() {
  RELEASE="$(running_release)" docker compose -p "$APP_NAME" --env-file "$SHARED_ENV" -f "$COMPOSE_FILE" "$@"
}

mode_preflight() {
  command -v docker >/dev/null || die "no encuentro docker en el PATH"
  docker compose version >/dev/null 2>&1 || die "falta el plugin de docker compose"
  echo "▸ docker $(docker --version | cut -d' ' -f3 | tr -d ,)"
}

# Los dos medios escuchan en el mismo puerto: si pm2 está sirviendo el dominó, Docker no puede.
mode_conflict_check() {
  command -v pm2 >/dev/null 2>&1 || return 0
  local pid
  for pid in $(pm2 pid "$APP_NAME" 2>/dev/null || true); do
    if [ -n "$pid" ] && [ "$pid" != "0" ]; then
      die "pm2 está sirviendo $APP_NAME en este servidor: \`pm2 delete $APP_NAME\` antes de pasar a Docker (docs/operacion.md, «Cambiar de medio»)"
    fi
  done
}

mode_prepare() {
  # El `domino` de desarrollo del compose exige un `.env` al lado, y compose lo valida aunque solo se
  # levante `domino-server`: sin el enlace, ningún comando de compose arranca en el servidor.
  ln -sfn "$SHARED_ENV" "$RELEASE_DIR/.env"

  if [ -f "$RELEASE_DIR/image.tar.gz" ]; then
    echo "▸ cargando la imagen del release"
    docker load -i "$RELEASE_DIR/image.tar.gz" >/dev/null
    docker tag "$APP_ID:ci" "$APP_ID:$RELEASE_ID"
    docker rmi "$APP_ID:ci" >/dev/null 2>&1 || true
    rm -f "$RELEASE_DIR/image.tar.gz"
  elif [ -f "$RELEASE_DIR/Dockerfile" ]; then
    echo "▸ construyendo la imagen en el servidor"
    RELEASE="$RELEASE_ID" docker compose -p "$APP_NAME" --env-file "$SHARED_ENV" \
      -f "$RELEASE_DIR/compose.yaml" build "$COMPOSE_SERVICE"
  else
    die "el release no trae ni image.tar.gz ni Dockerfile: no hay imagen que desplegar"
  fi
  docker image inspect "$APP_ID:$RELEASE_ID" >/dev/null 2>&1 ||
    die "no quedó la imagen $APP_ID:$RELEASE_ID"
}

# `--wait` espera al healthcheck del contenedor; lo que dictamina igual es `healthy` contra /ready.
mode_start() {
  compose up -d --no-build --no-deps --remove-orphans --wait "$COMPOSE_SERVICE"
}

mode_recreate() {
  compose up -d --no-build --no-deps --remove-orphans --force-recreate --wait "$COMPOSE_SERVICE"
}

# ¿CORRE LA IMAGEN DE ESE RELEASE? Lo que compose dice que hizo no alcanza: se mira la imagen de cada
# contenedor vivo, que es lo único que dice qué código está corriendo.
mode_running() {
  local want="$APP_ID:$(basename "$1")" id img state found=0
  for id in $(compose ps -q "$COMPOSE_SERVICE" 2>/dev/null); do
    img=$(docker inspect -f '{{.Config.Image}}' "$id" 2>/dev/null || true)
    state=$(docker inspect -f '{{.State.Running}}' "$id" 2>/dev/null || true)
    if [ "$img" != "$want" ] || [ "$state" != true ]; then
      echo "  ✗ el contenedor $id corre ${img:-<nada>} (running=$state), esperaba $want" >&2
      return 1
    fi
    found=$((found + 1))
  done
  [ "$found" -eq "$INSTANCES" ] || {
    echo "  ✗ esperaba $INSTANCES contenedores y hay $found" >&2
    return 1
  }
  echo "  ✓ $found contenedor(es) corriendo $want"
}

# `restart: unless-stopped` del compose es lo que lo trae de vuelta tras un reinicio del servidor.
mode_persist() { :; }

mode_write_logs() {
  cat >"$ROOT/logs" <<FIN
#!/usr/bin/env bash
# Los logs del dominó, una línea JSON por evento. Argumentos extra van a \`docker compose logs\`:
#   ./logs                 seguir en vivo
#   ./logs --tail 200      doscientas para atrás
release=\$(basename "\$(readlink -f "$CURRENT")")
export RELEASE="\$release" ENV_FILE="$SHARED_ENV" COMPOSE_PROFILES=server
exec docker compose -p "$APP_NAME" --env-file "$SHARED_ENV" -f "$COMPOSE_FILE" \\
  logs --no-log-prefix -f "\$@" "$COMPOSE_SERVICE"
FIN
}

# Se conservan las imágenes de la que corre y la anterior (la que hace posible el rollback).
mode_cleanup() {
  local tag
  for tag in $(docker image ls "$APP_ID" --format '{{.Tag}}' 2>/dev/null); do
    case "$tag" in
    "$RELEASE_ID" | "$(basename "${PREVIOUS:-none}")" | local | '<none>') continue ;;
    esac
    echo "  - imagen $APP_ID:$tag"
    docker rmi "$APP_ID:$tag" >/dev/null 2>&1 || true
  done
  docker image prune -f >/dev/null 2>&1 || true
}

deploy_main "$@"
