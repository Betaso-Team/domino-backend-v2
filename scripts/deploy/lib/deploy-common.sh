#!/usr/bin/env bash
#
# LO QUE COMPARTEN LOS DOS DESPLIEGUES (pm2 y Docker). No se ejecuta: lo cargan `deploy-remote.sh` y
# `deploy-docker-remote.sh`, que aportan lo que cambia de un medio a otro y dejan acá el orden.
#
# Portado de games-orchestrator (`packages/deploy`, 7528030), donde lo comparten billing-auth y el
# orquestador. Acá es SOLO del dominó: sin `deploy.config` ni carpeta de app, porque el repo es una
# sola app. Lo que se suma del dominó: la marca `FAILED` (ver `do_rollback`).
#
#   /var/www/Betaso/domino-backend-v2/
#   ├── shared/.env                el entorno REAL. Se crea UNA vez a mano y esto NUNCA lo toca: por eso
#   │                                ningún secreto pasa por GitHub ni por el artefacto
#   ├── shared/deploy.env          cómo se desplegó la última vez (lo escribe el propio despliegue)
#   ├── releases/<id>/             lo que viajó en el artefacto (`package-release.sh`), con estos scripts
#   └── current ──► releases/<id>  el symlink que decide qué corre
#
# Se conservan DOS releases: la que corre y la anterior, que es exactamente lo que hace falta para poder
# volver. Guardar más es ocupar disco por si acaso.
#
# ES ESPECÍFICO DE LINUX Y NO DISIMULA SERLO: `/proc/<pid>/cwd`, `mv -Tf` y `readlink -f` son de GNU/Linux.
#
# Un script que use esto define, ANTES de llamar a `deploy_main`:
#   DEPLOY_SCRIPT           su nombre (los atajos ./restart y ./rollback lo invocan)
#   DEPLOY_ENV_KEYS         las variables propias del medio que se anotan en deploy.env
#   mode_preflight          comprueba que el medio está disponible en esta máquina
#   mode_conflict_check     se niega si el OTRO medio está sirviendo el dominó (mismo puerto)
#   mode_prepare            deja el release listo para arrancar (dependencias, imagen)
#   mode_start              arranca o recarga lo que dice `current`, sin cortar si se puede
#   mode_recreate           lo borra y lo crea de nuevo (la versión que no recarga bien)
#   mode_running <dir>      0 si LO QUE CORRE ES ese release (no lo que el gestor dice que corre)
#   mode_persist            fija el estado para que sobreviva a un reinicio del servidor
#   mode_write_logs         escribe ./logs
#   mode_cleanup            libera lo que ya no hace falta (imágenes viejas)
set -euo pipefail

# Lo que en el monorepo dice el `deploy.config` de cada app. `APP_ID` es el nombre de la imagen;
# `COMPOSE_SERVICE`, el servicio de `compose.yaml` que la corre en un servidor (perfil `server`).
APP_ID=domino
COMPOSE_SERVICE=domino-server
DEFAULT_PORT=2567
READY_PATH=/ready
ECOSYSTEM=ecosystem.config.cjs

die() {
  echo "✗ $*" >&2
  exit 1
}

# `pwd -P` y no `pwd`: invocado a través de `current` —que es como se pide un rollback— la ruta LÓGICA
# sería `.../current/...` y `../..` se iría un nivel por encima de la raíz. Resolver el symlink acá es
# también lo que hace que RELEASE_DIR sea comparable con `/proc/<pid>/cwd`.
deploy_init() {
  local script="$1"
  # El script vive en releases/<id>/scripts/deploy/: dos niveles arriba está el release.
  RELEASE_DIR=$(cd "$(dirname "$script")/../.." && pwd -P) # releases/<id>
  RELEASE_ID=$(basename "$RELEASE_DIR")
  ROOT=$(cd "$RELEASE_DIR/../.." && pwd -P)
  SHARED_ENV="$ROOT/shared/.env"
  CURRENT="$ROOT/current"
  DEPLOY_ENV="$ROOT/shared/deploy.env"

  # CÓMO SE DESPLEGÓ LA ÚLTIMA VEZ: volver atrás es UN comando y no una lista de variables que hay que
  # acertar de memoria a las tres de la mañana. Lo que venga por el entorno gana: es un default.
  if [ -f "$DEPLOY_ENV" ]; then
    local clave valor
    while IFS='=' read -r clave valor; do
      case "$clave" in '' | '#'*) continue ;; esac
      [ -n "${!clave:-}" ] || export "$clave=$valor"
    done <"$DEPLOY_ENV"
  fi

  export APP_NAME="${APP_NAME:?falta APP_NAME}"
  # Opcional a propósito: sin declarar, `src/env.ts` resuelve al lado seguro (`prod` en producción).
  export APP_ENV="${APP_ENV:-}"
  export INSTANCES="${INSTANCES:-1}"
  case "$INSTANCES" in '' | *[!0-9]* | 0) die "INSTANCES tiene que ser un entero positivo (vale '$INSTANCES')" ;; esac

  # El puerto sale del .env, que es de donde lo lee el dominó: preguntarlo dos veces en dos lugares es
  # cómo se desincronizan. Con N instancias los puertos vivos son PORT .. PORT+N-1 (`src/env.ts`).
  PORT=""
  [ -f "$SHARED_ENV" ] && PORT=$(grep -E '^[[:space:]]*PORT=' "$SHARED_ENV" | tail -1 | cut -d= -f2- | tr -d "\"' " || true)
  PORT="${PORT:-$DEFAULT_PORT}"
  export PORT
}

# LA QUE CORRE AHORA, leída ANTES de mover nada. Para un despliegue es "la anterior" —la única a la que
# se puede volver si la nueva sale mal—; para un rollback es de la que hay que irse.
read_previous() {
  PREVIOUS_OR_CURRENT=""
  if [ -L "$CURRENT" ]; then PREVIOUS_OR_CURRENT=$(readlink -f "$CURRENT" || true); fi
  PREVIOUS="$PREVIOUS_OR_CURRENT"
  if [ "$PREVIOUS" = "$RELEASE_DIR" ]; then PREVIOUS=""; fi
}

# El symlink cambia de un golpe: nunca hay un instante sin `current`.
swap_current() {
  ln -sfn "$1" "$CURRENT.tmp"
  mv -Tf "$CURRENT.tmp" "$CURRENT"
}

# La release que se estampa es la que el symlink APUNTA AHORA y no la carpeta desde la que se invocó el
# script: en un rollback son distintas —se pide por `current`, o sea desde la que se abandona—.
running_release() { basename "$(readlink -f "$CURRENT")"; }

# ¿ARRANCARON TODAS? Contra 127.0.0.1 y una por una: por el dominio solo se ve la primera, y lo que hay
# que saber es si el conjunto entero quedó sano. `/ready` es el que mira las dependencias.
healthy() {
  local i port
  for i in $(seq 0 $((INSTANCES - 1))); do
    port=$((PORT + i))
    if ! curl -fsS --retry 15 --retry-delay 2 --retry-all-errors -o /dev/null \
      "http://127.0.0.1:$port$READY_PATH"; then
      echo "✗ la instancia de :$port no contesta $READY_PATH" >&2
      return 1
    fi
    echo "  ✓ :$port listo"
  done
}

# Sano de verdad = corre LO QUE CREEMOS y contesta.
serving() { mode_running "$1" && healthy; }

# Queda anotado cómo se desplegó. Los comentarios van en un heredoc CON comillas: sin ellas, un
# acento grave en el texto se ejecutaría.
write_deploy_env() {
  local k
  {
    cat <<'FIN'
# Lo escribe el despliegue al terminar bien; lo lee el rollback para no necesitar argumentos.
# El ENTORNO va acá por lo mismo: un rollback se pide DESDE el servidor, sin el workflow que lo
# calculó, y sin anotarlo el proceso volvía a resolver `APP_ENV` por su cuenta.
FIN
    for k in APP_NAME INSTANCES APP_ENV $DEPLOY_ENV_KEYS; do
      printf '%s=%s\n' "$k" "${!k:-}"
    done
  } >"$DEPLOY_ENV"
}

# LOS ATAJOS: lo que uno hace al entrar al servidor tiene que estar a mano y no en la cabeza de alguien.
write_shortcuts() {
  mode_write_logs
  cat >"$ROOT/restart" <<FIN
#!/usr/bin/env bash
# Recrea el dominó SIN cambiar de versión. Corta las partidas en vuelo.
#
# CUÁNDO: cambiaste la definición del proceso ($ECOSYSTEM o compose.yaml) o el shared/.env y ya se
# desplegó, pero eso no se aplicó con un reload. CUÁNDO NO: cambios de código.
exec bash "$CURRENT/scripts/deploy/$DEPLOY_SCRIPT" --restart
FIN
  cat >"$ROOT/rollback" <<FIN
#!/usr/bin/env bash
# Vuelve a la versión anterior. Sin argumentos: lo que hace falta está en shared/deploy.env.
# Ojo: vuelve el CÓDIGO; lo que ya se escribió en Mongo, Redis o RabbitMQ se queda.
exec bash "$CURRENT/scripts/deploy/$DEPLOY_SCRIPT" --rollback
FIN
  chmod +x "$ROOT/logs" "$ROOT/restart" "$ROOT/rollback"
}

# Se conservan la que corre y la anterior. El resto se borra acá y no antes: hasta este punto la
# anterior seguía siendo necesaria. Se lleva también los releases marcados `FAILED`.
prune_releases() {
  local dir
  echo "▸ limpiando releases viejas"
  for dir in "$ROOT"/releases/*; do
    [ -d "$dir" ] || continue
    case "$dir" in
    "$RELEASE_DIR" | "$PREVIOUS") continue ;;
    esac
    echo "  - $(basename "$dir")"
    rm -rf "$dir"
  done
}

do_rollback() {
  local target="" dir
  # El más nuevo que no sea el que corre ni uno que FALLÓ (el glob ordena alfabéticamente y los nombres
  # empiezan por fecha). Va con `if` y no con `&&`: bajo `set -e`, una lista que falla en el último paso
  # del bucle puede cortar el script.
  #
  # LO DE `FAILED` NO ES DEFENSIVO, ES EL CASO QUE SE MIDIÓ. Un despliegue que no queda sano devuelve el
  # symlink a la anterior y sale en rojo ANTES de la limpieza, así que el release roto SIGUE EN DISCO —y
  # es el más nuevo, o sea justo el que este bucle elegía—. El rollback de emergencia se iba de cabeza a
  # la versión que acababa de fallar, con el servicio ya cortado.
  for dir in "$ROOT"/releases/*; do
    if [ -d "$dir" ] && [ ! -e "$dir/FAILED" ] && [ "$dir" != "$PREVIOUS_OR_CURRENT" ]; then
      target="$dir"
    fi
  done
  [ -n "$target" ] || die "no hay otro release en disco al que volver"
  echo "▸ volviendo de $(basename "$PREVIOUS_OR_CURRENT") a $(basename "$target")"
  swap_current "$target"
  mode_recreate || true
  if serving "$target"; then
    mode_persist
    echo "✓ sirviendo $(basename "$target")"
    exit 0
  fi
  die "el release al que se volvió tampoco está sano: hay que mirar el servidor"
}

do_restart() {
  local target
  target=$(readlink -f "$CURRENT")
  echo "▸ recreando $APP_NAME desde $(basename "$target")"
  mode_recreate || true
  if serving "$target"; then
    mode_persist
    echo "✓ sirviendo $(basename "$target")"
    exit 0
  fi
  die "no quedó sano: hay que mirar el servidor"
}

do_deploy() {
  echo "▸ release   $RELEASE_DIR"
  echo "▸ anterior  ${PREVIOUS:-<ninguna: es el primer despliegue>}"
  echo "▸ app       $APP_NAME · $INSTANCES instancia(s) · puertos $PORT..$((PORT + INSTANCES - 1))"

  mode_prepare

  echo "▸ apuntando current al release nuevo"
  swap_current "$RELEASE_DIR"

  echo "▸ arrancando"
  mode_start || true # lo que dictamina es la comprobación de abajo, no el código de salida

  local ok=true
  mode_running "$RELEASE_DIR" || {
    echo "▸ el reload no tomó la versión nueva: se recrea" >&2
    mode_recreate || true
    mode_running "$RELEASE_DIR" || ok=false
  }
  healthy || ok=false

  if [ "$ok" = false ]; then
    echo "✗ el release nuevo no quedó sano" >&2
    # SE MARCA Y NO SE BORRA. Marcarlo es lo que impide que el `--rollback` de emergencia lo elija por
    # ser el más nuevo; no borrarlo deja el árbol entero para mirar por qué falló. El próximo despliegue
    # que sí quede sano se lo lleva.
    touch "$RELEASE_DIR/FAILED"
    if [ -z "$PREVIOUS" ] || [ ! -d "$PREVIOUS" ]; then
      die "no hay release anterior: no hay a dónde volver. La app queda como esté."
    fi
    echo "▸ VOLVIENDO a $PREVIOUS" >&2
    swap_current "$PREVIOUS"
    mode_recreate || true
    if serving "$PREVIOUS"; then
      echo "✓ la versión anterior quedó sirviendo" >&2
    else
      echo "✗ la versión anterior TAMPOCO está sana: hay que mirar el servidor" >&2
    fi
    exit 1
  fi

  mode_persist
  write_deploy_env
  write_shortcuts
  prune_releases
  mode_cleanup
  echo "✓ desplegado: $RELEASE_ID"
}

deploy_main() {
  mode_preflight
  [ -f "$SHARED_ENV" ] || die "falta $SHARED_ENV — se crea UNA vez a mano, ver .env.example"
  mode_conflict_check
  read_previous
  case "${1:-}" in
  --rollback) do_rollback ;;
  --restart) do_restart ;;
  "") do_deploy ;;
  *) die "modo desconocido: $1 (usá --rollback, --restart o nada)" ;;
  esac
}
