# domino-backend-v2

Backend de dominó multijugador sobre Colyseus 0.18. Las salas se reparten entre los procesos
del clúster, que se ven entre sí por Redis; lo único que persiste es el historial de cada
partida, en Mongo, para la consola de soporte.

Si venís a trabajar sobre el código, lo que tenés que leer es `AGENTS.md`.

## Documentación local

La arquitectura, los flujos y las reglas se sirven como un sitio VitePress con búsqueda local y
diagramas Mermaid ampliables:

```bash
npm install
npm run docs:dev
```

Abrí la URL que imprime VitePress (normalmente `http://localhost:5173`). `npm run docs:build`
comprueba enlaces y genera el sitio estático; el CI ejecuta ese build para que la documentación no
se pudra aparte del código.

## Levantarlo con Docker

```bash
cp .env.example .env
# editá el .env: BETASO_BACKEND_JWT_SECRET y BETASO_ADMIN_PANEL_API_KEY, mínimo 16 caracteres cada una
docker compose up --build
```

`BETASO_BACKEND_JWT_SECRET` es **obligatoria**: sin ella el proceso no arranca, a propósito.
`BETASO_ADMIN_PANEL_API_KEY` no lo es, pero sin ella las rutas internas de historial y mantenimiento
**no se registran** y responden 404 — es fail closed, y es el 404 que más se investiga al pedo.

`MONGO_URI` y `REDIS_URL` **no las pongas en el `.env`**: las fija el compose apuntando a los
servicios (`mongodb://mongo:27017/domino` y `redis://redis:6379/1` — el `/1` es el índice de
base, y es el aislamiento contra otro producto en el mismo Redis; ver `src/env.ts`). Lo que sí acepta el
`.env` son tres variables que solo entiende el compose (no están en `.env.example`, que
documenta a `src/env.ts`): `DOMINO_PORT`, `MONGO_PORT` y `REDIS_PORT`, los puertos del
**host**, por si ya hay algo escuchando — pasa seguido si el mismo operador corre truco al
lado.

## Contrato para el front

La sala `lobby` exige el mismo JWT que una mesa y sincroniza el contrato histórico del dominó:
`totalPlayers`, `playersInLobby`, `gameModesCount[]`, `isUnderMaintenance` y
`maintenanceMessage`. Los jugadores se cuentan en todas las salas `domino` visibles por el driver
compartido y se agrupan por `gameModeId` en `gameModesCount[].gameModeName`.

El operador cambia mantenimiento sin desplegar con:

```bash
curl -X POST -H "x-internal-api-key: <BETASO_ADMIN_PANEL_API_KEY del .env>" -H "Content-Type: application/json" \
  -d '{"isUnderMaintenance":true,"message":"Actualizando mesas"}' \
  http://localhost:2567/internal/lobby/maintenance
```

El cambio llega a los lobbies y bloquea únicamente mesas nuevas; las partidas abiertas continúan.
Con Redis lo comparten todos los procesos y sobrevive a sus reinicios; sin Redis vive en memoria.

`GET /config/:roomId` publica los montos con los nombres usados por dominó y truco: `entryFee` y
`prize`. Ambos son UC completas, iguales a las del catálogo de v1 (`entryFee: 125` son 125 UC) y
pueden traer decimales (`1.5` es un UC y medio); convertirlos a la moneda del jugador —con el
`rateId` de la mesa— y decidir el redondeo es de quien paga, no de este servidor.

## Varias instancias

La presencia de `REDIS_URL` es lo que hace que varios procesos sean **un** servidor: comparten
el registro de salas de Colyseus, el presence y el registro de partidas vivas. Sin ella cada
proceso es un clúster de uno — correcto con una instancia, y roto en silencio con dos:
`GET /config/:roomId` devuelve 404 para cualquier sala del otro proceso y `joinById` no la
encuentra.

Con varias instancias hace falta además `SERVER_ADDRESS` (el host, **sin** puerto): cada proceso
anuncia `SERVER_ADDRESS/{su puerto}` en la reserva de asiento para que el jugador se conecte al
que hospeda **su** sala. El puerto va como path porque es el esquema que el proxy de v1 ya rutea.

Y `PORT` es el puerto **base**, no el puerto: `@colyseus/tools` le suma `NODE_APP_INSTANCE`
adentro de su `listen()`, así que con `PORT=2567` y dos instancias de pm2 escuchan en 2567 y 2568
—y cada una anuncia el suyo—. Con una sola instancia no hay índice y la dirección se anuncia
plana, sin puerto: un proceso solo no necesita que el proxy rutee por path.

Para mirar lo que quedó grabado:

```bash
docker compose exec mongo mongosh domino --eval 'db.match_history.find().limit(1)'
curl -H "x-internal-api-key: <BETASO_ADMIN_PANEL_API_KEY del .env>" http://localhost:2567/internal/matches/<matchId>/history
```

## Levantar N instancias con pm2

Docker es **desarrollo local**; producción y pruebas corren con pm2.

```bash
npm run build
PM2_INSTANCES=2 pm2 start ecosystem.config.cjs
```

`PM2_INSTANCES` (y `PM2_APP_NAME`, el nombre del proceso; `PM2_CWD`, desde dónde corre; y
`NODE_INTERPRETER`, con qué node) las lee **pm2**, no `src/env.ts`, así que no están en
`.env.example` — ese archivo documenta al único lector de `process.env`. Las dos últimas solo hacen
falta en el servidor, y las pone el despliegue. Todo lo demás sale del `.env` de al lado, que el
proceso carga solo.

Modo `fork` y no `cluster`: cada instancia tiene que escuchar en **su** puerto y anunciar **su**
dirección, porque el jugador se conecta al proceso que hospeda su sala. Con `PORT=2567` y dos
instancias, escuchan en 2567 y 2568.

### Lo que el proxy de adelante tiene que hacer

**Rutear por prefijo de path.** Cada instancia se anuncia como `SERVER_ADDRESS/{su puerto}`, así
que `domino.betaso.com/2568/...` tiene que llegar al proceso que escucha en 2568 — WebSocket
incluido. Es el esquema de v1: el proxy que ya rutea v1 sirve sin aprender nada.

Confirmalo **antes** de subir a dos instancias. Si el proxy no lo hace, el que no llega es el
**cliente** y el servidor no se entera: el nodo equivocado contesta con total confianza que esa
sala no es suya, y en el log no hay nada raro que mirar.

Delante de eso van las dos sondas:

| | pregunta | acción del que pregunta | consulta las bases |
|---|---|---|---|
| `GET /health` | ¿el proceso está roto sin arreglo? | reiniciarlo | **no** |
| `GET /ready` | ¿le mando jugadores nuevos? | sacarlo de rotación | sí, con plazo |

Son dos a propósito: reiniciar no arregla una base caída, y es lo único que destruye partidas en
curso. `/ready` contesta `503 {"status":"not-ready","missing":["mongo"]}` diciendo **cuál** falta,
y cada chequeo tiene 2 s — una base caída no falla, cuelga. Una dependencia que esta instancia
eligió no tener (sin `MONGO_URI`, sin `REDIS_URL`) no cuenta como faltante.

### El apagado

`pm2 reload` manda un **mensaje** `shutdown` —no una señal— y da `kill_timeout` (5 s) para drenar.
En ese rato el servidor corta el emparejamiento, cierra las salas, espera a que el historial en
vuelo termine de escribirse y recién ahí cierra Mongo. Redis lo cierra Colyseus dentro del mismo
paso.

Lo que **no** hay es migración de salas: la instancia que se apaga se lleva sus partidas, igual
que en v1. Y un `kill -9` no drena nada — las claves del registro quedan hasta que vence su TTL
de 120 s, que es para lo que el TTL existe.

## Cómo se despliega

Dos workflows en `.github/workflows/`, y **el eje es la tarea, no el entorno**.

`ci.yml` **verifica y empaqueta**: typecheck, lint, suite, build, y deja un `domino-v2.tgz` con
`dist/`, `package.json`, `package-lock.json`, `ecosystem.config.cjs` y `scripts/deploy-remote.sh`.
Construye **en el CI y no en el servidor**, que es la diferencia entre un build roto que falla en
rojo y uno que deja a medio compilar a la máquina que está sirviendo partidas. Corre en cada PR, y
en `develop`/`stage`/`main` lo llama `deploy.yml` — así cada evento produce una corrida y nada llega
a un servidor sin haber pasado por él. **No levanta Mongo ni Redis**: la suite no los usa (ver
más abajo), así que levantarlos sería un job que miente.

`deploy.yml` **despliega**, con el entorno como dato: `develop → dev`, `stage → stage`,
`main → prod`, más un `workflow_dispatch` desde cualquier rama para probar una feature en el VPS de
dev sin mergearla. Los tres Environments guardan los secretos con el **mismo nombre**, así que no
hay sufijos por entorno y `prod` puede exigir la aprobación de una persona.

| Environment | secretos | variables |
|---|---|---|
| dev / stage / prod | `SSH_HOST`, `SSH_USER`, `SSH_KEY` | `DEPLOY_PATH`, `PM2_APP_NAME`, `PM2_INSTANCES`, `NODE_BIN`, `NODE_INTERPRETER`, `SSH_KNOWN_HOSTS`, `PUBLIC_URL` |
| repositorio | — | `DEPLOY_ENVIRONMENTS` (los entornos que ya tienen servidor) |

En el servidor queda así, y el **`.env` real se crea UNA vez a mano** en `shared/` — el despliegue
solo lo enlaza, y por eso ningún secreto de la aplicación pasa por GitHub:

```
/var/www/Betaso/domino-backend-v2/
├── shared/.env                  se crea a mano; el deploy NUNCA lo toca
├── releases/<fecha>-<commit>/   dist/ + package.json + ecosystem.config.cjs + node_modules
└── current ──► releases/<id>    el symlink que decide qué corre
```

El despliegue instala las dependencias de producción, voltea el symlink y **gatea contra `/ready`
instancia por instancia, contra 127.0.0.1**. Si la release nueva no queda sana **repone la anterior
y falla en rojo igual**: que la vieja haya vuelto no significa que se haya desplegado lo que se
pidió. Se conservan dos releases, que es lo que hace falta para poder volver.

**pm2 apunta al symlink y no a la carpeta del release**, y no es un detalle: pm2 guarda la ruta
absoluta del script y **no la actualiza al recargar**, así que con una carpeta nueva por despliegue
un `pm2 reload` sigue corriendo la versión anterior. Por eso `ecosystem.config.cjs` lee
`PM2_CWD`, y por eso el deploy **comprueba** con `/proc/<pid>/cwd` desde dónde corre cada proceso
en vez de asumirlo.

Para volver atrás sin rehacer el pipeline, desde el servidor:

```bash
bash /var/www/Betaso/domino-backend-v2/current/scripts/deploy-remote.sh --rollback
```

Salta los releases marcados `FAILED` — si no, el rollback de emergencia iría a parar justo al que
acaba de fallar, que es el más nuevo que hay en disco.

`scripts/deploy-remote.sh` **es de Linux** (`/proc`, `mv -Tf`, `readlink -f`) y viaja **dentro del
artefacto**: el que corre es siempre el de la versión que se está desplegando.

## Smoke del deploy

El gate completo compila `dist/main.js` y juega una partida 2P contra dos procesos PM2 detrás de
Nginx, con Redis y Mongo efímeros:

```powershell
$env:RUN_ENGINE_SMOKE='1'; npm run test:deploy; Remove-Item Env:RUN_ENGINE_SMOKE
```

Sin la flag el comando se niega a correr. Esta prueba no llama wallets ni valida el Nginx de
producción; valida el contrato `/2567` y `/2568` que ese proxy debe implementar.

## Los tests

**No necesitan Docker, ni Mongo, ni Redis.** `vitest.setup.ts` **borra** `MONGO_URI` y
`REDIS_URL` del entorno antes de que corra nada: sin ellas el historial es el de memoria y
Colyseus usa su driver y su presence locales, así que la suite no depende de ningún servicio
externo. Que eso sea una propiedad del repo y no del shell de quien lo corre es la razón de
esas dos líneas — si las tenés exportadas porque corrés otro proyecto al lado, la suite igual
no las mira.

```bash
npm ci
npm test
```

## El gate

```bash
npm run typecheck   # tsc --noEmit  <- ESTE es el gate, no el verde de vitest
npm test            # vitest run
npm run lint        # biome check src
npm run format      # biome format --write src, antes de commitear
```

Vitest transpila con esbuild, que borra los tipos sin chequearlos: una suite verde no dice
nada sobre si compila. El porqué largo está en `AGENTS.md`.
