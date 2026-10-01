#!/usr/bin/env bash
#
# EL DESPLIEGUE CON PM2, visto desde el servidor. Corre por ssh y es lo único que toca la máquina.
#
# Viaja DENTRO del artefacto, así que el script que se ejecuta es siempre el de la versión que se está
# desplegando: cambiar el procedimiento es un commit más y no un archivo que alguien editó a mano en el
# servidor una tarde. El orden (desplegar, rollback, restart) vive en `lib/deploy-common.sh`; acá está lo
# que es de pm2. Layout del servidor y motivos: ese archivo.
#
#   deploy-remote.sh              despliega el release que contiene a este script
#   deploy-remote.sh --rollback   vuelve al OTRO release que haya en disco, sin construir ni bajar nada
#   deploy-remote.sh --restart    recrea el dominó sin cambiar de versión (ver `ecosystem.config.cjs`)
#
# Variables esperadas: APP_NAME (obligatoria), INSTANCES (por defecto 1), APP_ENV, NODE_BIN (opcional:
# dónde están node y pm2, si no están en el PATH de una sesión ssh no interactiva) y NODE_INTERPRETER
# (opcional: con qué node corre el dominó, que no tiene por qué ser el de pm2).
set -euo pipefail

DEPLOY_SCRIPT="deploy-remote.sh"
DEPLOY_ENV_KEYS="NODE_BIN NODE_INTERPRETER"

# shellcheck source=lib/deploy-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/deploy-common.sh"
deploy_init "${BASH_SOURCE[0]}"

# `NODE_BIN` solo si hace falta, y vacío por defecto: el pm2 que importa es el que levantó al DEMONIO
# —invocar el de otra instalación es cómo se termina con dos demonios y una lista de procesos que parece
# vacía—, y en un servidor con nvm es fácil que ése sea el del PATH del sistema y no el de nvm.
export PATH="${NODE_BIN:+$NODE_BIN:}$PATH"
# Con qué node CORRE el dominó, que no es el de pm2: colyseus 0.18 pide >= 22 y el demonio puede ser más
# viejo. Vacío significa "el de pm2" (§ `ecosystem.config.cjs`).
export NODE_INTERPRETER="${NODE_INTERPRETER:-}"
export NODE_BIN="${NODE_BIN:-}"
export PM2_APP_NAME="$APP_NAME"
export PM2_INSTANCES="$INSTANCES"

mode_preflight() {
  command -v pm2 >/dev/null || die "no encuentro pm2 en el PATH (NODE_BIN=${NODE_BIN:-<sin definir>})"
  echo "▸ pm2 $(pm2 --version 2>/dev/null | tail -1) · node $(node --version) · $(command -v pm2)"
  # Es un aviso y no un corte: quien decide con qué corre el dominó es NODE_INTERPRETER.
  case "$(node --version)" in
  v2[2-9].* | v[3-9][0-9].*) ;;
  *) echo "  ⚠ este node es anterior al 22 que pide colyseus; revisá NODE_BIN y NODE_INTERPRETER" >&2 ;;
  esac
}

# Los dos medios escuchan en el mismo puerto: si Docker está sirviendo el dominó, pm2 no puede. El corte
# de un medio al otro es a propósito un paso manual (docs/operacion.md, «Cambiar de medio»).
mode_conflict_check() {
  command -v docker >/dev/null 2>&1 || return 0
  if [ -n "$(docker ps -q \
    --filter "label=com.docker.compose.project=$APP_NAME" \
    --filter "label=com.docker.compose.service=$COMPOSE_SERVICE" 2>/dev/null || true)" ]; then
    die "Docker está sirviendo $APP_NAME en este servidor: bajalo antes de pasar a pm2 (docs/operacion.md, «Cambiar de medio»)"
  fi
}

# LAS DEPENDENCIAS, REUSADAS cuando no cambiaron —que es casi siempre—. La marca dice con qué se
# instalaron: el lockfile y el node que las compiló (un módulo nativo compilado para otro node no
# carga). Si la del release anterior coincide, su `node_modules` se copia con HARDLINKS: medio segundo
# contra los ~10 del `npm ci`, y sin ocupar disco. Es seguro porque un release no se modifica nunca
# después de desplegado; borrar el viejo solo borra sus enlaces.
mode_prepare() {
  # El .env del release es un enlace al compartido: el dominó lo lee desde su cwd, que pm2 fija a la raíz
  # del release (§ `ecosystem.config.cjs`).
  ln -sfn "$SHARED_ENV" "$RELEASE_DIR/.env"

  local stamp_file="node_modules/.deploy-stamp" stamp
  stamp="node $(node --version) · lock $(sha256sum "$RELEASE_DIR/package-lock.json" | cut -d' ' -f1)"
  if [ -n "$PREVIOUS" ] && [ -f "$PREVIOUS/$stamp_file" ] && [ "$(cat "$PREVIOUS/$stamp_file")" = "$stamp" ]; then
    echo "▸ dependencias sin cambios: se reusan las de $(basename "$PREVIOUS")"
    cp -al "$PREVIOUS/node_modules" "$RELEASE_DIR/node_modules"
  else
    echo "▸ instalando dependencias de producción"
    (cd "$RELEASE_DIR" && npm ci --omit=dev --no-audit --no-fund)
    mkdir -p "$RELEASE_DIR/node_modules"
    printf '%s\n' "$stamp" >"$RELEASE_DIR/$stamp_file"
  fi
}

# El proceso corre SIEMPRE desde el symlink, nunca desde la carpeta del release: pm2 guarda la ruta
# absoluta del script y no la cambia al recargar, así que la ruta que le damos tiene que ser la misma
# para siempre y el symlink es lo que decide qué versión hay del otro lado.
start_env() {
  PM2_CWD="$CURRENT" RELEASE="$(running_release)" "$@"
}

mode_start() {
  (cd "$CURRENT" && start_env pm2 startOrReload "$ECOSYSTEM" --update-env)
}

# Cuando ni eso alcanza —cambió algo que un reload no aplica, o pm2 tiene guardada una ruta vieja—, se
# borra y se crea de nuevo. Es determinista y cuesta un par de segundos de corte; el reload no corta
# nada, así que se intenta ése primero.
mode_recreate() {
  pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
  (cd "$CURRENT" && start_env pm2 start "$ECOSYSTEM" --update-env)
}

# ¿ESTÁ CORRIENDO LO QUE CREEMOS? La pregunta no es retórica: pm2 contestó mal la primera vez que se
# usó en truco (recargó y siguió ejecutando el release anterior). El directorio real de cada proceso
# (`/proc/<pid>/cwd`, que resuelve el symlink) es lo único que dice qué código está vivo.
mode_running() {
  local expected="$1" pid cwd found=0
  for pid in $(pm2 pid "$APP_NAME" 2>/dev/null); do
    [ -n "$pid" ] && [ "$pid" != "0" ] || continue
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
    if [ "$cwd" != "$expected" ]; then
      echo "  ✗ el proceso $pid corre desde ${cwd:-<no existe>}" >&2
      return 1
    fi
    found=$((found + 1))
  done
  [ "$found" -eq "$INSTANCES" ] || {
    echo "  ✗ esperaba $INSTANCES procesos y hay $found" >&2
    return 1
  }
  echo "  ✓ $found proceso(s) corriendo desde $(basename "$1")"
}

mode_persist() { pm2 save >/dev/null; }

# LOS LOGS, LEGIBLES DE UNA. Sin esto había que acordarse de `--raw`: sin él, el prefijo de pm2 rompe el
# JSON de pino. El dominó no trae `pino-pretty` entre sus dependencias de producción, así que se lee el
# JSON tal cual (se puede pipear a `jq`).
mode_write_logs() {
  cat >"$ROOT/logs" <<FIN
#!/usr/bin/env bash
# Los logs del dominó, una línea JSON por evento. Argumentos extra van a pm2:
#   ./logs                         seguir en vivo
#   ./logs --lines 200 --nostream  doscientas para atrás, y termina
#   ./logs --err                   solo el stream de error
# El \`sed\` le saca el timestamp que pm2 le antepone a cada línea cuando se lo dejó estampar: con él
# delante la línea deja de ser JSON. Va aunque el ecosystem diga \`time: false\`, porque los archivos ya
# escritos lo llevan. La \`-u\` no es un detalle: sin ella \`sed\` almacena y el seguimiento en vivo deja
# de ser en vivo.
pm2 logs "$APP_NAME" --raw "\$@" \\
  | sed -uE 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}: //'
FIN
}

mode_cleanup() { :; }

deploy_main "$@"
