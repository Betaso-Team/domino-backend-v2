#!/usr/bin/env bash
#
# EL DESPLIEGUE, VISTO DESDE EL SERVIDOR. Corre por ssh y es lo único que toca la máquina.
#
# VIAJA DENTRO DEL ARTEFACTO (§`.github/workflows/ci.yml`), así que el script que se ejecuta es
# siempre el de la versión que se está desplegando: cambiar el procedimiento es un commit más, y no
# un archivo que alguien editó a mano en el servidor una tarde y que nadie más vio.
#
#   /var/www/Betaso/domino-backend-v2/
#   ├── shared/.env                  el entorno REAL. Se crea UNA vez a mano y esto NUNCA lo toca:
#   │                                  por eso ningún secreto pasa por GitHub ni por el artefacto
#   ├── releases/<id>/               dist/ + package.json + ecosystem.config.cjs + node_modules
#   └── current ──► releases/<id>    el symlink que decide qué corre
#
# Se conservan DOS releases: la que corre y la anterior, que es exactamente lo que hace falta para
# poder volver. Guardar más es ocupar disco por si acaso.
#
# TRES MODOS:
#   deploy-remote.sh              despliega el release que contiene a este script
#   deploy-remote.sh --rollback   vuelve al OTRO release que haya en disco, sin construir ni bajar
#                                 nada. Es la vuelta atrás de emergencia: tarda lo que tarda pm2 en
#                                 reiniciar, contra los minutos de rehacer el pipeline entero.
#   deploy-remote.sh --restart    recrea la app SIN cambiar de versión, para lo que un reload no
#                                 aplica (todo lo de `ecosystem.config.cjs` fuera de su `env:`).
#
# Y DEJA TRES ATAJOS en la raíz, que es lo que uno tiene a mano al entrar al servidor a las tres de
# la mañana: `./logs`, `./restart` y `./rollback`, los dos últimos sin argumentos.
#
# ES ESPECÍFICO DE LINUX Y NO DISIMULA SERLO: `/proc/<pid>/cwd` (el chequeo del medio, que es el
# corazón de este archivo), `mv -Tf` y `readlink -f` son de GNU/Linux. En un servidor BSD o macOS
# habría que reescribirlos; no hay una versión portable de `/proc` que diga lo mismo.
#
# Variables esperadas: PM2_APP_NAME (obligatoria), PM2_INSTANCES (por defecto 1), NODE_BIN
# (opcional: dónde están node y pm2, si no están en el PATH de una sesión ssh no interactiva) y
# NODE_INTERPRETER (opcional: con qué node corre la app, que no tiene por qué ser el de pm2). Las
# trae el workflow; el último despliegue las anota en `shared/deploy.env`, así que un rollback o un
# restart pedidos a mano desde el servidor no necesitan ninguna.
set -euo pipefail

# `pwd -P` Y NO `pwd`: invocado a través de `current` —que es como se pide un rollback— la ruta
# LÓGICA sería `.../current`, y entonces `../..` se iría un nivel POR ENCIMA de la raíz. Resolver el
# symlink acá es además lo que hace que `RELEASE_DIR` sea comparable con `/proc/<pid>/cwd`.
RELEASE_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
ROOT=$(cd "$RELEASE_DIR/../.." && pwd -P)
SHARED_ENV="$ROOT/shared/.env"
CURRENT="$ROOT/current"

# CÓMO SE DESPLEGÓ LA ÚLTIMA VEZ, que es lo que hace que volver atrás sea UN comando. Sólo completa lo
# que no vino: una variable explícita —la del workflow— siempre gana. Se lee línea por línea y no con
# `source`, para que un valor nunca se ejecute.
DEPLOY_ENV="$ROOT/shared/deploy.env"
if [ -f "$DEPLOY_ENV" ]; then
  while IFS='=' read -r clave valor; do
    case "$clave" in '' | '#'*) continue ;; esac
    [ -n "${!clave:-}" ] || export "$clave=$valor"
  done <"$DEPLOY_ENV"
fi

# `NODE_BIN` solo si hace falta, y vacío por defecto: el pm2 que importa es el que levantó al
# DEMONIO —invocar el de otra instalación es cómo se termina con dos demonios y una lista de
# procesos que parece vacía—, y en un servidor con nvm es fácil que ése sea el del PATH del sistema
# y no el de nvm.
export PATH="${NODE_BIN:+$NODE_BIN:}$PATH"
export PM2_APP_NAME="${PM2_APP_NAME:?falta PM2_APP_NAME}"
export PM2_INSTANCES="${PM2_INSTANCES:-1}"
# CON QUÉ NODE CORRE LA APP, que no es el de pm2: el demonio puede ser de otra versión que la que
# probó la suite. Vacío significa "el de pm2" (§`ecosystem.config.cjs`).
export NODE_INTERPRETER="${NODE_INTERPRETER:-}"

command -v pm2 >/dev/null || {
  echo "✗ no encuentro pm2 en el PATH (NODE_BIN=${NODE_BIN:-<sin definir>})" >&2
  exit 1
}
echo "▸ pm2 $(pm2 --version 2>/dev/null | tail -1) · node $(node --version) · $(command -v pm2)"
# Colyseus 0.18 pide node >= 22 (su `engines`, que `src/entrypoint.test.ts` compara contra el
# nuestro), y en un servidor con nvm el node del PATH puede ser otro. Es un AVISO y no un corte:
# quien decide con qué corre la app es `NODE_INTERPRETER`, y este node puede ser solo el de pm2.
case "$(node --version)" in
v2[2-9].* | v[3-9][0-9].*) ;;
*) echo "  ⚠ este node es anterior al 22 que pide colyseus; revisá NODE_BIN y NODE_INTERPRETER" >&2 ;;
esac
[ -f "$SHARED_ENV" ] || {
  echo "✗ falta $SHARED_ENV — se crea UNA vez a mano, ver .env.example" >&2
  exit 1
}

# EL `.env` DEL RELEASE ES UN ENLACE AL COMPARTIDO. La app lo lee con `process.loadEnvFile()` desde
# su cwd (§`src/env.ts`: el consumidor lee el suyo), y el cwd lo fija pm2 al symlink `current`
# (§`ecosystem.config.cjs`). Un enlace por release y no una copia: copiarlo dejaría releases con
# configuraciones distintas y un rollback devolvería la de hace dos despliegues.
ln -sfn "$SHARED_ENV" "$RELEASE_DIR/.env"

# LA QUE CORRE AHORA, leída ANTES de mover nada. Para un despliegue es "la anterior" —la única a la
# que se puede volver si el nuevo sale mal—; para un rollback es de la que hay que irse.
PREVIOUS_OR_CURRENT=""
[ -L "$CURRENT" ] && PREVIOUS_OR_CURRENT=$(readlink -f "$CURRENT" || true)
PREVIOUS="$PREVIOUS_OR_CURRENT"
[ "$PREVIOUS" = "$RELEASE_DIR" ] && PREVIOUS=""

# EL PUERTO SALE DEL `.env`, que es de donde lo lee la app: preguntarlo dos veces en dos lugares es
# cómo se desincronizan. Y con N instancias los puertos vivos son PORT .. PORT+N-1, porque `PORT`
# ES LA BASE Y NO EL PUERTO: el que le suma `NODE_APP_INSTANCE` no es pm2 ni nosotros, es
# `@colyseus/tools` adentro de su `listen()` (§`src/env.ts`). El default es el mismo que el de
# `src/env.ts`, para que una instalación sin `PORT` explícito se comporte igual acá.
PORT=$(grep -E '^[[:space:]]*PORT=' "$SHARED_ENV" | tail -1 | cut -d= -f2- | tr -d "\"' ")
PORT="${PORT:-2567}"

# SIEMPRE POR EL SYMLINK, NUNCA POR LA CARPETA DEL RELEASE, y es la lección que costó cuatro
# despliegues reales en truco: pm2 guarda la ruta ABSOLUTA del script y NO la actualiza al recargar.
# Con una carpeta nueva por despliegue, `pm2 reload` seguía ejecutando el release anterior con el
# symlink ya movido —y re-aplicar el archivo de configuración, que era la mitigación planeada,
# tampoco ayuda—. Con una ruta que no cambia nunca, recargar vuelve a leerla y el symlink es lo que
# decide qué versión hay del otro lado (§`ecosystem.config.cjs`).
# QUÉ RELEASE CORRE, por nombre de carpeta: viaja al proceso como `RELEASE` (§`ecosystem.config.cjs`)
# para que cada línea de log diga de qué versión salió.
running_release() { basename "$(readlink -f "$CURRENT")"; }

start_release() {
  (cd "$CURRENT" && PM2_CWD="$CURRENT" RELEASE="$(running_release)" pm2 startOrReload ecosystem.config.cjs --update-env)
}

# Y CUANDO NI ESO ALCANZA —la primera vez que se cambia el esquema, por ejemplo, porque pm2 ya tiene
# guardada una ruta vieja—, se borra y se crea de nuevo. Es determinista y cuesta un par de segundos
# de corte; el reload de arriba no corta nada, así que se intenta ése primero.
restart_release() {
  pm2 delete "$PM2_APP_NAME" >/dev/null 2>&1 || true
  (cd "$CURRENT" && PM2_CWD="$CURRENT" RELEASE="$(running_release)" pm2 start ecosystem.config.cjs --update-env)
}

# ¿ESTÁ CORRIENDO LO QUE CREEMOS? La pregunta NO ES RETÓRICA: es exactamente lo que pm2 contestó mal
# la primera vez. Y como estuvo mal una vez, ahora se CHEQUEA en vez de asumirse. El directorio real
# de cada proceso (`/proc/<pid>/cwd`, que resuelve el symlink) es lo único que dice qué código está
# vivo — `pm2 list` muestra la ruta que pm2 GUARDÓ, que es justo el dato que mintió.
running_from() {
  local expected="$1" pid cwd found=0
  for pid in $(pm2 pid "$PM2_APP_NAME" 2>/dev/null); do
    [ -n "$pid" ] && [ "$pid" != "0" ] || continue
    cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)
    if [ "$cwd" != "$expected" ]; then
      echo "  ✗ el proceso $pid corre desde ${cwd:-<no existe>}" >&2
      return 1
    fi
    found=$((found + 1))
  done
  [ "$found" -eq "$PM2_INSTANCES" ] || {
    echo "  ✗ esperaba $PM2_INSTANCES procesos y hay $found" >&2
    return 1
  }
  echo "  ✓ $found proceso(s) corriendo desde $(basename "$expected")"
}

# ¿ARRANCARON TODAS? Contra 127.0.0.1 y UNA POR UNA: por el dominio solo se ve la primera —y con el
# proxy ruteando por prefijo de path, ni siquiera eso—, y lo que hay que saber es si el clúster
# entero quedó sano.
#
# EL GATE ES `/ready` Y NO `/health`, y la diferencia es todo: `/health` no consulta nada a
# propósito (§`src/shared/http/health.ts`), así que contesta 200 en un proceso que no llega a Mongo
# ni a Redis. `/ready` es el que pregunta, con plazo por chequeo, y el que DICE CUÁL falta — o sea
# que un despliegue que se cae acá deja escrito en el log por qué.
#
# El `--retry` cubre el arranque: con `wait_ready` pm2 espera el aviso del proceso, pero entre ese
# aviso y un Redis que todavía está aceptando conexiones hay segundos.
healthy() {
  local i port
  for i in $(seq 0 $((PM2_INSTANCES - 1))); do
    port=$((PORT + i))
    if ! curl -fsS --retry 15 --retry-delay 2 --retry-all-errors -o /dev/null \
      "http://127.0.0.1:$port/ready"; then
      echo "✗ la instancia de :$port no contesta /ready" >&2
      return 1
    fi
    echo "  ✓ :$port listo"
  done
}

# RECREAR SIN CAMBIAR DE VERSIÓN. Un reload aplica las variables de entorno y nada más; el resto de
# `ecosystem.config.cjs` —instancias, intérprete, logs— queda fijado al arrancar el proceso.
if [ "${1:-}" = "--restart" ]; then
  TARGET=$(readlink -f "$CURRENT")
  echo "▸ recreando $PM2_APP_NAME desde $(basename "$TARGET")"
  restart_release || true
  if running_from "$TARGET" && healthy; then
    pm2 save >/dev/null
    echo "✓ sirviendo $(basename "$TARGET")"
    exit 0
  fi
  echo "✗ no quedó sano: hay que mirar el servidor" >&2
  exit 1
fi

# VOLVER ATRÁS A MANO. El release anterior sigue entero en disco —con sus `node_modules`—, así que
# es mover el symlink y reiniciar. No se rehace nada: es justamente para cuando no hay tiempo.
if [ "${1:-}" = "--rollback" ]; then
  TARGET=""
  # El más nuevo que no sea el que corre Y QUE NO HAYA FALLADO (el glob ordena alfabéticamente y los
  # nombres empiezan por fecha, §`deploy.yml`). Va con `if` y no con `&&`: bajo `set -e`, una lista
  # que falla en el último paso del bucle puede cortar el script.
  #
  # LO DE `FAILED` NO ES DEFENSIVO, ES EL CASO QUE SE MIDIÓ. Un despliegue que no queda sano
  # devuelve el symlink a la anterior y sale en rojo ANTES de la limpieza, así que el release roto
  # SIGUE EN DISCO — y es el más nuevo, o sea justo el que este bucle elegía. El rollback de
  # emergencia se iba de cabeza a la versión que acababa de fallar, arrancaba dos procesos que
  # contestan 503 y recién ahí se daba cuenta, con el servicio ya cortado. Reproducido en seco con
  # tres releases (una rota) y un pm2 de mentira.
  for dir in "$ROOT"/releases/*; do
    if [ -d "$dir" ] && [ ! -e "$dir/FAILED" ] && [ "$dir" != "$PREVIOUS_OR_CURRENT" ]; then
      TARGET="$dir"
    fi
  done
  [ -n "$TARGET" ] || {
    echo "✗ no hay otro release en disco al que volver" >&2
    exit 1
  }
  echo "▸ volviendo de $(basename "$PREVIOUS_OR_CURRENT") a $(basename "$TARGET")"
  ln -sfn "$TARGET" "$CURRENT.tmp"
  mv -Tf "$CURRENT.tmp" "$CURRENT"
  restart_release || true
  if running_from "$TARGET" && healthy; then
    pm2 save >/dev/null
    echo "✓ sirviendo $(basename "$TARGET")"
    exit 0
  fi
  echo "✗ el release al que se volvió tampoco está sano: hay que mirar el servidor" >&2
  exit 1
fi

echo "▸ release   $RELEASE_DIR"
echo "▸ anterior  ${PREVIOUS:-<ninguna: es el primer despliegue>}"
echo "▸ app       $PM2_APP_NAME · $PM2_INSTANCES instancia(s) · puertos $PORT..$((PORT + PM2_INSTANCES - 1))"

# LAS DEPENDENCIAS, REUSADAS cuando no cambiaron —que es casi siempre— (portado de truco `32d83de`).
# La marca dice con qué se instalaron: el lockfile y el node que las compiló (un módulo nativo
# compilado para otro node no carga). Si la del release anterior coincide, sus `node_modules` se
# copian con HARDLINKS: medio segundo contra los ~10 del `npm ci`, y sin ocupar disco. Es seguro
# porque un release no se modifica nunca después de desplegado; borrar el viejo sólo borra sus
# enlaces. Sin marca —el primer despliegue con este script— se instala como siempre.
STAMP_FILE="node_modules/.deploy-stamp"
stamp="node $(node --version) · lock $(sha256sum "$RELEASE_DIR/package-lock.json" | cut -d' ' -f1)"
if [ -n "$PREVIOUS" ] && [ -f "$PREVIOUS/$STAMP_FILE" ] && [ "$(cat "$PREVIOUS/$STAMP_FILE")" = "$stamp" ]; then
  echo "▸ dependencias sin cambios: se reusan las de $(basename "$PREVIOUS")"
  cp -al "$PREVIOUS/node_modules" "$RELEASE_DIR/node_modules"
else
  echo "▸ instalando dependencias de producción"
  (cd "$RELEASE_DIR" && npm ci --omit=dev --no-audit --no-fund)
  mkdir -p "$RELEASE_DIR/node_modules"
  printf '%s\n' "$stamp" >"$RELEASE_DIR/$STAMP_FILE"
fi

# EL SYMLINK SE MUEVE ATÓMICAMENTE: `ln -sfn` sobre un enlace que ya existe borra y crea, y entre
# esas dos operaciones `current` NO EXISTE. Se crea al lado y se renombra con `mv -Tf`, que es un
# `rename(2)`: o está el viejo o está el nuevo, nunca ninguno.
echo "▸ apuntando current al release nuevo"
ln -sfn "$RELEASE_DIR" "$CURRENT.tmp"
mv -Tf "$CURRENT.tmp" "$CURRENT"

echo "▸ arrancando"
start_release || true # lo que dictamina es la comprobación de abajo, no el código de salida

ok=true
running_from "$RELEASE_DIR" || {
  echo "▸ el reload no tomó la versión nueva: se recrea la app" >&2
  restart_release || true
  running_from "$RELEASE_DIR" || ok=false
}
healthy || ok=false

if [ "$ok" = false ]; then
  echo "✗ el release nuevo no quedó sano" >&2
  # SE MARCA Y NO SE BORRA. Marcarlo es lo que impide que el `--rollback` de emergencia lo elija
  # por ser el más nuevo (§arriba); no borrarlo es lo que deja el árbol entero para mirar por qué
  # falló. Se limpia solo: el próximo despliegue que sí quede sano se lo lleva puesto.
  touch "$RELEASE_DIR/FAILED"
  if [ -z "$PREVIOUS" ] || [ ! -d "$PREVIOUS" ]; then
    echo "✗ no hay release anterior: no hay a dónde volver. La app queda como esté." >&2
    exit 1
  fi
  echo "▸ VOLVIENDO a $PREVIOUS" >&2
  ln -sfn "$PREVIOUS" "$CURRENT.tmp"
  mv -Tf "$CURRENT.tmp" "$CURRENT"
  restart_release || true
  if running_from "$PREVIOUS" && healthy; then
    echo "✓ la versión anterior quedó sirviendo" >&2
  else
    echo "✗ la versión anterior TAMPOCO está sana: hay que mirar el servidor" >&2
  fi
  # SE SALE EN ROJO IGUAL. Que la anterior haya vuelto a quedar sirviendo no convierte esto en un
  # éxito: lo que se pidió desplegar no está desplegado, y un verde acá es cómo nadie se entera.
  exit 1
fi

pm2 save >/dev/null

# Se conservan la que corre y la anterior. El resto se borra ACÁ y no antes: hasta este punto la
# anterior seguía siendo el único lugar a donde volver.
echo "▸ limpiando releases viejas"
for dir in "$ROOT"/releases/*; do
  [ -d "$dir" ] || continue
  case "$dir" in
  "$RELEASE_DIR" | "$PREVIOUS") continue ;;
  esac
  echo "  - $(basename "$dir")"
  rm -rf "$dir"
done

# QUEDA ANOTADO CÓMO SE DESPLEGÓ, que es lo que hace que el rollback no necesite argumentos. `APP_ENV`
# no va: vive en el `.env` de cada servidor, que es lo único que un rollback relee. Sólo variables:
# estos heredocs expanden, así que nada de comillas invertidas adentro — ejecutarían lo que citan.
cat >"$DEPLOY_ENV" <<FIN
PM2_APP_NAME=$PM2_APP_NAME
PM2_INSTANCES=$PM2_INSTANCES
NODE_BIN=${NODE_BIN:-}
NODE_INTERPRETER=${NODE_INTERPRETER:-}
FIN

# LOS LOGS, LEGIBLES DE UNA. Sin esto había que acordarse de `--raw` —sin él, el prefijo de pm2 rompe
# el JSON y pino-pretty no parsea nada— y de pipear a mano, y una molestia chica repetida termina en
# que nadie mira los logs. Corre desde `current` porque pino-pretty busca su configuración desde el
# directorio actual hacia arriba, y la del release es la que viaja con esta versión.
cat >"$ROOT/logs" <<FIN
#!/usr/bin/env bash
# Los logs de esta app, con color. Argumentos extra van a pm2:
#   ./logs                 seguir en vivo
#   ./logs --lines 200     doscientas para atrás
#   ./logs --err           solo el stream de error
cd "$CURRENT" || exit 1
# El sed le saca el timestamp que pm2 antepone cuando se lo deja estampar: con él la línea deja de
# ser JSON. La -u no es un detalle: sin ella sed almacena y el seguimiento en vivo deja de serlo.
pm2 logs "$PM2_APP_NAME" --raw "\$@" \\
  | sed -uE 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}: //' \\
  | ./node_modules/.bin/pino-pretty
FIN
chmod +x "$ROOT/logs"

# Los otros dos, por lo mismo: tres comandos tecleados de memoria a las tres de la mañana es
# exactamente lo que este archivo viene a evitar. Siempre el script del release QUE CORRE.
cat >"$ROOT/restart" <<FIN
#!/usr/bin/env bash
# Recrea la app SIN cambiar de versión: para lo que un reload no aplica.
exec bash "$CURRENT/scripts/deploy-remote.sh" --restart
FIN
chmod +x "$ROOT/restart"

cat >"$ROOT/rollback" <<FIN
#!/usr/bin/env bash
# Vuelve al otro release en disco. Sin argumentos: lo que necesita lo anotó el último despliegue.
exec bash "$CURRENT/scripts/deploy-remote.sh" --rollback
FIN
chmod +x "$ROOT/rollback"

echo "✓ desplegado: $(basename "$RELEASE_DIR")"
