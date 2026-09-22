# AGENTS.md — domino-backend-v2

Backend de dominó multijugador sobre Colyseus 0.18. Es un **port de la arquitectura de
truco** (`truco-backend-v2`), no un rediseño: cuando algo no cierra, la respuesta suele
estar en cómo lo resolvió truco.

## El plan es la autoridad

`docs/superpowers/plans/2026-09-09-domino-v2-esqueleto-y-juego-2p.md` — 24 tareas (la 0 a la
23), cada
una con sus Steps, su código y sus tests escritos. **No improvises el diseño**: el plan ya
decidió, y las decisiones están argumentadas en los comentarios del propio código.

Los otros dos documentos:

- `docs/superpowers/specs/2026-09-09-domino-v2-port-arquitectura-truco-design.md` — el
  porqué de cada decisión. Lo que el plan ejecuta, esto lo justifica.
- `docs/reglas-de-juego-v1.md` — las reglas del dominó **y** la anatomía del v1, con
  referencias a archivo:línea del backend viejo. Es la fuente cuando hay que saber qué
  hacía el sistema anterior.

**Estado: plan completo, Tareas 0–23 hechas.** La Tarea 22 cerró sus correcciones de calidad en
`f6fdb3d`; la Tarea 23 cerró implementación, E2E y golden en `11d20f5` con **253 tests verdes**.

Después del plan entró una tanda de correcciones portadas de truco (`078a2af` y anteriores):
la Regla 3 no veía los imports locales del container, el transporte HTTP resolvía del root en
vez de recibir, faltaba el manejador de errores de Express y `.env.example` estaba ocho
variables atrás de `src/env.ts`. Después vino la validación de la entrada HTTP con zod
(`validated`, gemelo del decoder del wire; nació en `features/match/transports/http/` y la Tarea 2
del incremento del catálogo lo promovió a `shared/http/` al aparecer el segundo consumidor).

Y después la **persistencia del historial**, portada de truco (`124ed68`/`a483fe8`): la
única dependencia de infraestructura del repo (`mongodb`). `HistoryReader.of` pasó a
prometer y `HistoryPort.record` NO —la asimetría es la decisión: `record` lo llaman el
camino de un comando y el de un timer, `of` lo llama el operador de soporte—.
`MemoryHistory` **se queda** y no es un doble: es la implementación de una instancia que
elige no persistir, y la que usa la suite. **La presencia de `MONGO_URI` elige**, sin
`HISTORY_DRIVER` ni nada que lo parezca (`src/di-container.test.ts` se pone rojo si
aparece). `vitest.setup.ts` **borra** `MONGO_URI`: la suite no depende de ningún servicio
externo, y eso tiene que ser una propiedad del repo y no del shell de quien lo corre.

Y después el **escalamiento horizontal**, portado de truco (`874a778`/`909217a`/`a3bb6dd`) —
primero de dos incrementos. El
registro de partidas vivas dejó de ser un `Map` del proceso y pasó al almacén compartido
(`src/shared/kv.ts`, un puerto con la forma de la `Presence` de Colyseus, así que **el
adaptador de Redis son cero líneas propias**); Colyseus recibe el driver y el presence
compartidos, anuncia `publicAddress` y reparte las salas con el balanceador de
`transports/colyseus/load-balancer.ts`. **`matchOf` se volvió un índice invertido** que la sala
escribe, y toda clave tiene plazo (120 s) con un latido de la sala que lo renueva (30 s).
**La presencia de `REDIS_URL` elige**, igual que `MONGO_URI`: sin ella Colyseus usa su driver y
su presence locales —que es lo que él mismo hace por default— y el registro usa el almacén de
memoria. `vitest.setup.ts` **también borra `REDIS_URL`**, así que la suite sigue sin depender de
ningún servicio externo. Verificado con dos instancias reales sobre el compose: `/config`
contesta desde las dos por una sala de cualquiera, `joinById` cruza de proceso, las salas se
reparten y el latido renueva el plazo.

Y después el **segundo incremento, la capa de deploy** (`89fa497`/`26e1bd4`/`290017c`/`57194e5`/
`ebb5082`): el entrypoint se partió en `src/main.ts` —el que CORRE— y `src/app.config.ts` —el que
se IMPORTA—, porque el apagado ordenado necesita un lugar donde registrar manejadores de señal
que ningún test arrastre. Cuatro archivos que no se importan entre sí nombran ese bundle (tsup,
los dos scripts de npm, el `CMD` de la imagen y el `script` de pm2) y ninguno rompe el gate al
desincronizarse: lo pinea `src/entrypoint.test.ts`.

**`PORT` ES LA BASE Y NO EL PUERTO**, y es el hallazgo que cuesta una tarde: el que le suma
`NODE_APP_INSTANCE` no es pm2 ni nosotros, es `@colyseus/tools` ADENTRO de su `listen()`
(`node_modules/@colyseus/tools/build/index.mjs:45-46`, `port += processNumber`, medido sobre la
0.18.3 instalada). Sumárselo antes lo contaría dos veces. `env.listeningPort` es el efectivo, y es
el que va en el `publicAddress` — anunciar la base manda al jugador al proceso equivocado, y es la
única falla de esta capa que aparece en el CLIENTE y no en el servidor. Sin pm2 la dirección se
anuncia PLANA, sin puerto en el path: un proceso solo no necesita un proxy que rutee por prefijo.

**El apagado es nuestro** (`gracefullyShutdown: false` en `app.config.ts`, el orden en
`src/main.ts`): salas y emparejamiento primero (`server.gracefullyShutdown(false)`), después
`shutdown()` del container, que drena el historial y RECIÉN AHÍ cierra Mongo —`record` es `void` y
no reintenta, así que al revés se pierde el último lote, o sea el desenlace—. Redis NO se cierra
ahí: lo cierra Colyseus adentro del paso 1, y hacerlo dos veces deja una promesa rechazada en cada
apagado. Y se escucha el **mensaje** `shutdown` de pm2 además de las señales: con
`shutdown_with_message`, pm2 manda un MENSAJE y no una señal, así que sin esa rama el drenado no
correría en ningún `pm2 reload` —o sea en ningún deploy— sin un solo error en el log.

**Las sondas son dos a propósito** (`src/shared/http/health.ts`): `/health` NO consulta nada,
porque una dependencia caída nunca puede contestarse con "reiniciame" —reiniciar es lo único que
destruye partidas en curso, y el dominó sigue jugando sin sus bases—; `/ready` sí consulta y dice
CUÁL falta, con un plazo **por chequeo** de 2 s, porque una base caída no falla: CUELGA. Una
dependencia que la instancia eligió no tener no entra al mapa.

Verificado con dos instancias reales sobre el compose (**pm2 no está instalado en esta máquina**;
se reprodujo con `fork` + IPC + `NODE_APP_INSTANCE` + el mensaje `shutdown`): cada una ata
`PORT + índice` y anuncia el efectivo, dos jugadores que entran por procesos distintos caen en una
sala, `/config` contesta desde las dos, el que se cae vuelve por el OTRO nodo y recupera su
partida, el apagado por mensaje sale con 0 y no deja claves atrás, y `kill -9` sí las deja —con
TTL de 119 s, que es lo que las limpia—. Medido: el drenado tarda **9 ms** con el servidor vacío;
`/ready` contra un Mongo inalcanzable contesta **503 `{"missing":["mongo"]}` en 2014 ms** mientras
`/health` sigue contestando 200 en 43 ms.

Y después la **primera tanda de correcciones de la capa de deploy**, portadas de truco
(`5210cd6`/`48ac4bc`/`3d3eb0f`) — la segunda (CI/CD y el script de deploy) es la de más abajo:

- **La app carga su propio `.env`** con `process.loadEnvFile()` en `src/env.ts`, en vez de
  heredarlo de rebote de quien la arrancó. El archivo es opcional y **el entorno le gana al
  archivo** (medido sobre la node 22.17.1). No es redundante con `@colyseus/tools` —que también
  carga uno al importarse—, porque `src/replay.ts` no lo importa: medido, `npm run replay` con la
  configuración sólo en el `.env` moría con «Entorno inválido — JWT_SECRET». **Y ahí apareció un
  agujero que ya estaba vivo**: `vitest.setup.ts` borra `MONGO_URI`/`REDIS_URL` y
  `@colyseus/tools` las REPONE después (un `setupFile` corre antes de los imports del archivo de
  test, así que contra ése no hay orden que salve). Medido: 18 tests rojos en 6 archivos. Se
  desactiva `dotenv.config` en `vitest.setup.ts` — la FUNCIÓN, no las dos variables, porque un
  `.env` también puede traer `WRITE_GOLDEN=1`, que es `npm test` reescribiendo los golden.
- **El aislamiento de Redis por índice de base SE SOSTIENE, y ahora está medido** en vez de
  argumentado: dos instancias contra el mismo Redis, una en `/0` y otra en `/1`, cada una con su
  juego completo de claves y con los mismos NOMBRES (`roomcaches`, `roomcount`, `ch:domino`,
  `match_config:*`, `player_match:*`), ciegas entre sí (`/config` 404, `joinById` 522) mientras
  una tercera en `/0` las ve. **Lo que el índice no cubre es el pub/sub —que no tiene base— y un
  prefijo de claves tampoco lo cubriría** (medido: con `keyPrefix` la clave sale prefijada y el
  canal no). **El default pasó de `/0` a `/1`**: el `0` es donde cae todo el que no eligió, y
  truco no elige.
- **No llegar a escuchar se dice y se sale.** Medido: `listen()` no rechaza con el puerto
  ocupado, se CUELGA —`@colyseus/ws-transport` se come el `'error'` del servidor HTTP en su
  constructor y sólo lo imprime; el `reject` de `@colyseus/core` se registra dentro del callback
  de `'listening'`, que nunca corre—, así que el `.catch()` de truco no alcanza. Va un plazo de
  arranque de 20 s en `src/main.ts`, que cubre también el Redis caído al arrancar.

Y después la **segunda tanda: el CI/CD**, portado de truco (`bd591f3`/`3d3eb0f`). El repo no
tenía `.github/` ni `scripts/`:

- **`ci.yml` verifica antes de que algo toque un servidor** —typecheck, lint, suite, build— y deja
  empaquetado el artefacto (`dist` + `package.json` + `package-lock.json` +
  `ecosystem.config.cjs` + `scripts/deploy-remote.sh`). Construir en el CI y no en el servidor es
  la diferencia entre un build roto que falla en rojo y uno que deja a medio compilar a la máquina
  que está sirviendo partidas. **SIN `services:`, y es lo que el dominó decide distinto que
  truco**: allá la suite necesita Redis y Mongo de verdad, acá `vitest.setup.ts` los borra del
  entorno a propósito, así que levantarlos no agregaría una sola aserción y agregaría un job que
  **miente**. Ejercitarlos de verdad pide una suite de integración que no pase por
  `vitest.setup.ts`, no un bloque de `services:`.
- **`deploy.yml` con el entorno como DATO.** Un solo workflow para dev/stage/prod: los
  Environments de GitHub guardan los secretos con el mismo nombre, así que no hay sufijos
  `_DEV`/`_STAGE`/`_PROD`, y prod puede exigir un humano. `DEPLOY_ENVIRONMENTS` lista los que
  existen; el que no esté se saltea en vez de fallar.
- **El deploy gatea contra `/ready`, instancia por instancia**, y si la release nueva no queda
  sana **repone la anterior y sale en rojo igual**. `/health` no serviría de gate: no consulta
  nada a propósito. **El procedimiento viaja DENTRO del artefacto**
  (`scripts/deploy-remote.sh`), así que el que corre es siempre el de la versión que se despliega.
- **pm2 guarda la ruta absoluta del script y NO la actualiza al recargar.** `cwd: __dirname` no
  alcanza —node resuelve los symlinks, así que eso da la carpeta FÍSICA del release, distinta en
  cada despliegue—: va `process.env.PM2_CWD || __dirname`, con pm2 apuntando al symlink `current`.
  Y como eso estuvo mal una vez, el deploy lo **chequea** con `/proc/<pid>/cwd` en vez de asumirlo.
- **El piso de node es la cuarta puerta de `src/entrypoint.test.ts`**: el test lee el
  `node-version` del workflow y lo compara contra `engines`, que se compara contra colyseus.

**No hay servidor ni Actions donde correr esto acá.** Lo que se verificó: `actionlint` y
`shellcheck` en Docker (limpios salvo dos `SC2029` informativos, que son la expansión del lado del
cliente que se quiere), el `tar` del artefacto a mano, y **el `deploy-remote.sh` entero en seco
sobre un Linux con `/proc` y un pm2 de mentira** —siete escenarios: primer despliegue, segundo,
uno que contesta 503 (vuelve atrás y sale 1), rollback a mano por el symlink, la limpieza dejando
dos, y el defecto de pm2 con y sin la mitigación—. **Es un script de Linux y no lo disimula**:
`/proc/<pid>/cwd`, `mv -Tf` y `readlink -f` no existen fuera de GNU/Linux, y no se pueden probar
en Windows. Lo que queda sin verificar es todo lo que pide un servidor o Actions de verdad: que
pm2 el de verdad se comporte como el de mentira, el `ssh`/`scp`, y los Environments.

**Un defecto del script de truco, encontrado al ensayarlo**: el `--rollback` elegía «el más nuevo
que no sea el que corre», y un despliegue fallido sale en rojo ANTES de la limpieza — o sea que el
release roto sigue en disco y **es el más nuevo**. El rollback de emergencia se iba de cabeza a la
versión que acababa de fallar. Ahora el fallido se marca con un `FAILED` y el bucle lo saltea.

**Baseline antes del incremento siguiente: 320 tests / 48 archivos.**

## Incremento completo — identidad multiplataforma y smoke real

Autoridad operativa:
`docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md`.
Diseño aprobado:
`docs/superpowers/specs/2026-09-14-identidad-multiplataforma-y-smoke-pm2-design.md`.

Estado: **incremento completo; Tareas 0–5 cerradas** (`8a88229` la 0; `b930b75`…`ce8a895` la 1;
`d3617cb`…`922d85d` la 2; `60d7c19`, `dc151be` la 3; `6a10918`…`7e5d286` la 4; `f66ab13`
la 5). Baseline **366 tests / 52 archivos**. Verificados con código 0:
`typecheck`, suite, lint, build y depcruise (**163 módulos / 617 dependencias**). El smoke real
quedó verde con Docker Desktop 4.35.1 / Engine 27.3.1 / Compose 2.29.7, PM2 7.0.4 y Nginx
1.30.4: ambas instancias escucharon en 2567/2568, la partida terminó por `SCORE` con 119 entradas
de historial y `down -v --remove-orphans` dejó el compose vacío. Deuda deliberada: la entrega
remota/outbox pertenece al futuro orquestador —el juego sólo exporta `settlementOf`— y el Nginx
entregado es de certificación, no infraestructura productiva. **El 4P tampoco liquida todavía**:
falta definir cómo se divide el premio entre compañeros antes de eliminar esa guarda.
La identidad externa pasa a ser `{ platformId, userUuid }`; `currency` es la moneda ya cobrada y
queda congelada, y toda recompensa/reembolso usa el `rateId` único de la mesa. ⚠ Los montos
`*UcMinor` que este bloque describe **ya no existen**: la Tarea 1 del incremento del catálogo
(`ca9e68a`) los renombró a `entryFee`/`prize`/`amount` y los pasó a UC completas — ver el bloque de
más abajo.

⚠⚠ **Y LA PAREJA `{ platformId, userUuid }` TAMPOCO EXISTE YA.** El incremento de integración con
el front (`18c99b0`) la aplanó a un solo `userId`, que es el `sub` del token. **Todo lo que este
bloque y los siguientes dicen sobre "la pareja" hay que leerlo como "el `userId`"**: la clave del
registro (`player_match:<userId>`, ya sin `JSON.stringify`), la `idempotencyKey` de
`settlementOf` (`["matchId","KIND",userId]`), la comparación de `assertSameTable`, el
`noSync()` de `PlayerState` y el cruce de `onJoin`. El motivo está en el bloque del final; en una
línea: ni truco ni el v1 del dominó tienen `platformId` en una sola línea de su código, así que la
multiplataforma no la alimentaba ningún sistema. **`golden-2p.json` ya no contiene `betaso`**, y
`shared/player-ref.ts` no existe.

Lo que dejó la Tarea 1, y que conviene saber antes de tocar nada de acá:

- **`configOf` es la ÚNICA frontera**, y ahora valida con zod: `onCreate(options: unknown)`, así
  que una mesa con el dinero mal formado no llega a existir. Rechaza UC fraccionaria, insegura o
  negativa, `rateId` que no sea UUID, campos en blanco y la pareja duplicada.
- **`playerId` es OPACO y posicional** (`seat-1`, `seat-2`, …). Adentro de la partida —motor,
  historial, wire, registro público— no hay plataformas ni UUIDs. El cruce entre la pareja
  autenticada y el asiento pasa en UN solo lugar: `onJoin`.
- **`PlayerState` sincroniza presentación y NO identidad.** `platformId`/`userUuid`/`currency` son
  `noSync()`: no entran a la metadata del Schema, así que ni se codifican ni aparecen en
  `toJSON()`. `displayName`/`username`/`profilePicture` sí viajan.
  **OJO con el golden**: `golden-2p.json` **sí** contiene `betaso` y `VES`, y no es una filtración
  —están en `meta`, que es el `DominoMatchConfig` de ENTRADA que el replay necesita para rebobinar;
  `finalState`, que es el árbol serializado, no los tiene—. Es el primer archivo donde se va a
  buscar una fuga: la diferencia es `meta` (entrada) contra `finalState` (estado).
- **La identidad se NORMALIZA con `trim()` en las dos fronteras** (`configOf` y `JwtVerifier`) y la
  moneda NO. `platformId`/`userUuid` son una llave que se compara y se concatena, así que un
  espacio de un lado y no del otro es `SeatNotReservedError` con la inscripción ya cobrada;
  `currency` es un valor contable que se conserva exactamente como se cobró. Si tocás una frontera,
  tocá la otra.
- **El índice del registro es la pareja entera**, serializada con `JSON.stringify` y no
  concatenada: `["a","b:c"]` y `["a:b","c"]` no pueden colisionar. El `MatchRegistry` guarda las
  parejas en un `Map` aparte del DTO público, que sigue llevando solo ids opacos.
- **Los tests del motor usan `core/engine/tests/match-config-fixture.ts`**; el arnés E2E resuelve
  `userUuid`→`seat-N` con `playerIdOf`/`clientOf`, así que ningún test escribe `seat-N` a mano.

Lo que dejó la Tarea 2:

- **`settlementOf` PROYECTA, no mueve** (`network/settlement.ts`, exportada por
  `features/match/index.ts`). Es una función pura: `MATCH_ABORTED` → `REFUND` de
  `entryFee` a todos los asientos, `MATCH_RESOLVED` → `REWARD` de `prize` al
  ganador, cualquier otro evento → `undefined`. **No hay puerto de wallet, ni adaptador, ni
  outbox**: todavía no existe un orquestador a quien entregarle el trabajo, y un puerto sin
  quien lo llame es una interfaz que se diseña dos veces.
- **Devuelve la pareja y la moneda congeladas, y el `rateId` de la mesa. No convierte.** La
  identidad sale de `config.seats` —donde quedó congelada— y el equipo ganador del estado; el
  cruce es por el id opaco, así que el motor sigue sin saber de plataformas.
- **La `idempotencyKey` se serializa con `JSON.stringify(["matchId","KIND",platformId,userUuid])`**,
  igual que el índice del registro y por lo mismo: concatenada, dos parejas distintas pueden dar
  la misma clave, y una colisión acá es un pago que no se hace porque otro ya usó la clave.
- **Cero ganadores o más de uno lanza `InvariantViolationError`**, que cierra la partida. Es
  "plata de por medio" aplicada: el 4P todavía no tiene regla escrita de cómo se parte el premio,
  y sin esa regla repartirlo es inventarla al liquidar. **Si alguna vez se liquida una mesa de
  cuatro, esta guarda es el primer lugar que hay que tocar** —y hay que traer la regla, no
  borrarla—.
- **`assertSameTable` corre ANTES de cualquier instrucción, y es la guarda menos obvia del
  archivo.** Como los `playerId` son posicionales, `seat-1` existe en todas las mesas: cruzar el
  estado de una con el snapshot de otra **no** da cero ganadores ni dos —que harían ruido—, da
  exactamente UNO, y emite una instrucción impecable que le paga a alguien que no jugó esa
  partida. **Compara la PAREJA asiento por asiento y no la forma**, y ahí está el hallazgo: dos
  mesas 2P tienen los mismos `seat-N`, así que largo y pertenencia coinciden y una guarda de forma
  las deja pasar. Lo que las distingue es la identidad congelada que `PlayerState` ya lleva desde
  la Tarea 1 —escrita una sola vez en `genesis.ts`, `noSync()`, sin costo de wire—, así que la
  guarda es **exacta hoy y no necesita que el estado lleve `matchId`**. El error **nombra el
  desajuste, no el conteo de ganadores**: «recibió 0 ganadores» manda a soporte a auditar un
  veredicto sano.
- **El `switch` es exhaustivo con `never` en el default, y eso es el gate.** Un evento de
  plataforma nuevo que también devuelva plata —una cancelación, una expulsión por fraude—
  compilaría contra un `if`, devolvería `undefined`, y nadie cobraría sin una línea roja.
- **La superficie exporta los tipos de los tres parámetros** (`NetworkMatchEvent`,
  `DominoMatchConfig`, `MatchState`, los tres como tipo): una firma cuyos parámetros no se pueden
  nombrar obliga a importar hondo, que es lo que la Regla 4 evita. **El smoke de la Task 3 tiene
  que importar de `@/features/match`**, no de `@/features/match/network/settlement`.
- **Las claves de idempotencia se assertan como literal** (`'["money-1","REWARD","betaso","same"]'`)
  y no recalculadas con el mismo `JSON.stringify` del código: recalcularlas mide que dos
  expresiones idénticas dan lo mismo, y acompaña cualquier cambio de formato sin ponerse roja.
- **Las guardas están medidas por mutación, no por argumento.** Se verificó a mano que sacar
  `assertSameTable`, cambiar el `kind` del `REFUND` a `"REWARD"` y suprimir el reembolso de
  `NEVER_STARTED` rompen cada uno su test y ningún otro. Es el método que conviene repetir acá: en
  este archivo, un test que no se pone rojo al mutar la línea que dice medir es plata sin custodia.

⚠ **Compatibilidad de schema — ruptura de wire, y no hay negociación de versión en el repo.** Los
tres campos sincronizados nuevos (`displayName`, `username`, `profilePicture`) se insertaron
**entre `playerId` y `teamId`**, así que TODOS los índices posteriores de `PlayerState` se
corrieron. `@colyseus/schema` codifica por índice: un cliente con el schema pre-generado de antes
de esta tarea decodifica `displayName` donde espera `teamId`. No es un defecto —agregar campos es
el punto de la tarea— pero **cliente y servidor tienen que desplegarse juntos**, y el día que eso
no se pueda, los campos nuevos van al FINAL en vez de al medio.

Al terminar cada tarea, actualizar esta línea con tarea, commit, baseline y primer paso pendiente.
No cambiar `maxClients`: sigue abierta la deuda del `unlock()` descrita más abajo.

**Si retomás por la Task 3**, leé antes el bloque «Lo que la revisión agregó» al final de la Task 2
del plan: los snippets de esa tarea NO son el código que quedó, y el smoke se escribe contra lo que
quedó.

**Deudas abiertas — NO CUMPLIDAS:**

1. El `unlock()` de `onDrop` no tiene test y es inalcanzable bajo el
   `maxClients = seats.length * 2` actual. La condición exacta que lo reactiva está en el recuadro
   ⛔ de la Tarea 22 y junto al propio `unlock()`: **si tocás `maxClients`, leelo y agregá el test
   antes de cambiarlo.**
2. ~~**El 4P no tiene regla de reparto del premio.**~~ **CERRADO, y la deuda era FALSA**: la regla
   estaba escrita en v1 (`domino-room-state.ts:672-678`) y `settlementOf` ya la implementaba por
   construcción. Ver el bloque «la mesa de cuatro y la máquina que la sostiene» al final.
3. **No existe el orquestador que cobre.** `settlementOf` es una proyección pura y exportada, y
   nadie la llama todavía fuera de su test: no hay puerto de wallet, ni adaptador remoto, ni
   outbox, **y es deliberado** (el plan lo dice en su Mapa de archivos). Diseñar el puerto sin un
   consumidor es diseñarlo dos veces. Lo que falta para que el dinero se mueva de verdad —entrega
   al menos una vez, reintentos, quién persiste la instrucción— **no está resuelto en ningún
   lado**: es el incremento siguiente, no una omisión de éste.

## Incremento completo — lobby operativo y montos públicos

Autoridad operativa:
`docs/superpowers/plans/2026-09-14-lobby-y-montos-publicos.md`.

Estado: **Tareas 0–4 completas** (`ba84fa1`, `df3cdb2`, `be443ee`, `2198f07`, `e781896`).
Baseline **373 tests / 54 archivos**. Verificados con código 0:
`typecheck`, suite, lint, build y depcruise (**173 módulos / 654 dependencias**). El grafo fue
reindexado y el smoke Docker/PM2/Nginx terminó una partida 2P con 119 entradas de historial; el
compose quedó vacío.

Corrección posterior (`3074e2c`): el HTTP interno ordena una copia del historial por `seq`. Mongo
puede aplicar fuera de orden los lotes que `record()` envía concurrentemente; el replay ya ordenaba,
pero el endpoint devolvía el orden físico (`1,3,2,…`). El test cubre además que no se mute al lector.

Se portó el contrato de lobby del dominó v1 y se recuperaron los nombres públicos
`entryFee`/`prize`; no se añadió matchmaking ni catálogo. El lobby es una `Room` normal: consulta
el driver compartido y evita el canal global `$lobby`, que Redis no aísla por índice de base. El
mantenimiento vive en Redis cuando está configurado —en memoria con una sola instancia—, se cambia
por `POST /internal/lobby/maintenance`, bloquea únicamente mesas nuevas y falla cerrado ante un valor
corrupto. ⚠ El `entryFee`/`prize` de UC minor que este bloque describía lo corrigió la Tarea 1 del
incremento siguiente: son UC completas.

## Incremento completo — router de mensajes y aumento de apuesta

Sin plan escrito: salió de revisar el changelog de truco (negocio v28 / app-infra v20 /
estructura v22) contra lo que este repo tenía. Baseline **710 tests / 69 archivos**, con
`typecheck`, lint y suite en verde.

**El router de mensajes** (portado de truco `51a23d5`). El `type` del mensaje del socket ERA un
`CommandName`, así que "lo que el cliente puede mandar" y "los verbos del dominó" eran el mismo
conjunto POR CONSTRUCCIÓN. Ahora son tres actores en `transports/colyseus/messages.ts`:
`MessageDecoder<P>` valida y tipa, `MessageHandler<P>` hace el trabajo, `MessageRouter` los
empareja. `router.on(type, decoder, handler)` los registra JUNTOS y eso es todo el punto: no
existe un camino de un `raw` a un handler que no pase por su decoder. `CommandCatalog` perdió
`accepts()` —se fue al router, y con él el `Object.hasOwn` que esquivaba el prototipo, que un
`Map` no necesita— y conservó los dos tipos mapeados sobre `CommandName`, que son los que hacen
imposible sumar un verbo y olvidarse de rutearlo. `CommandHandler` compone los tres pasos del
verbo (ejecutar, grabar, notificar) y deja dicho que **el historial es del VERBO, no del
mensaje**. La sala se quedó con rutear y con `rejectMessage`, que es método aparte porque un
handler asíncrono falla por otro camino y su rechazo tiene que caer en la misma política.

**El reloj del servidor** (`shared/http/server-time.ts`): `Access-Control-Expose-Headers: Date`.
No reemplaza al `serverNow` de `/config/:roomId` —ése sigue siendo la fuente del offset
inicial—; agrega que el desfase se pueda remedir contra cualquier respuesta ya pedida.

**El aumento de apuesta**, y acá **NO se portó truco**: se portó el v1 del DOMINÓ, que lo
resuelve distinto. Truco tiene `OFFER_MULTIPLIER` + QUIERO/NO_QUIERO compartidos, valor libre,
multiplicativo y leído al cerrar. El dominó v1 tiene `PROPOSE_BET_MULTIPLIER` /
`RESPOND_BET_MULTIPLIER {accept}`, nivel de un catálogo remoto, **aditivo**
(`multiplier + acceptedBetExtra`), cobrado al aceptar y con timeout de 10 s que auto-rechaza.
Copiar la forma de truco habría cambiado lo que se paga.

Piezas: `RoundPhase` gana `NEGOTIATING_BET` (fase propia porque hay UN SOLO `activeDeadline`);
`RoundState.betOffer` es rama nula y muere con su ronda; `MatchState.acceptedBetExtra` /
`acceptedBetLevel` son el escalar de la partida con neutro 0. El módulo `core/engine/bet/` es un
dúo pelado —`BetReferee` juzga, `BetNegotiation` posee el dato— y las transiciones son del
conductor de RONDA (`freezeForBet` / `resumeFromBet`), **no** de `advance`: congelar no
reconcilia nada.

Dos cosas que aparecieron implementando y conviene no volver a descubrir:

- **El reloj del turno se congela y se devuelve** (`BetOffer.turnRemainingMs`). Re-estampar el
  turno entero al descongelar es un turno gratis para el que propone: proponés, te rechazan y
  volvés con el reloj a cero.
- **`settle` borra la oferta**, así que el remanente y el que calló se preguntan ANTES. El
  primer diseño los leía después y devolvía siempre cero.

~~⚠ **No cobra.**~~ **YA COBRA** — ver el bloque del final. Este párrafo decía que `configOf`
deja `betLevels: []` y que `network/bet-charge.ts` era sólo el contrato; las dos cosas dejaron de
ser ciertas. La decisión de producto que este bloque dejaba abierta —compensar o reservar— se
resolvió por COMPENSAR, que es lo que hace truco.

⚠⚠ **Y EL MODELO DEL NIVEL ERA INCORRECTO.** `BetLevel` guardaba `additionalEntryFee` y
`additionalPrize`, y el catálogo de v1 NO los tiene: devuelve `{ level, extra, additionalPoints }`.
El `level` es el MULTIPLICADOR de la mesa (2, 3, 5), no un índice. Todo lo que este bloque dice
sobre los niveles hay que leerlo con eso.

Los dos campos nuevos del snapshot (`betLevels`, `isFreeRoom`) llevan **default en el schema del
replay**: sin eso, toda la historia grabada antes de la feature dejaba de rebobinarse. El golden
2P se regrabó solo para sumar los dos campos neutros del árbol.

## Incremento completo — las reglas dictaminan, y las dos tablas del cierre

Sin plan escrito: salió de barrer el changelog de truco contra este repo y quedarse SOLO con lo
que el dominó necesita. Baseline **761 → 779 tests / 74 archivos**, con `typecheck`, lint,
`depcruise` y suite en verde.

### `core/rules/`: las reglas dictaminan, no lanzan

Portado de la serie de truco (`e6766c1` … `20583cd`). Todo lo de esa carpeta es CONSULTA: dado el
estado, qué ficha engancha, qué verbo es legal, cuánto vale una mano. Nada muta y nada conoce
Colyseus — es la condición para que algún día viva en un paquete que el cliente también consuma, y
con eso se acabe la única forma real de que las reglas se desincronicen: tenerlas escritas dos
veces.

Dos cosas cambian de forma y el resto se sigue de ahí:

- **El veredicto es DATO** (`Ruling`). Una excepción solo le sirve a un servidor: "lanza" no se
  puede pintar, y el cliente necesita preguntar ANTES y saber POR QUÉ el botón está apagado. Los
  jueces conservan sus `assertX`, que ahora leen el veredicto y lanzan por **un solo puente**,
  `assertLegal` — que vive en `engine/errors.ts` a propósito: el día que las reglas viajen, ese
  archivo NO viaja.
- **`MatchView` es la frontera anti-trampa vuelta TIPO.** No declara los dos campos `.view()` del
  schema, así que una regla que estire la mano hacia la mano de otro **no compila**. La única
  puerta es `privateOf(playerId)`, y `SchemaMatchView` (`core/state/view.ts`) es la mitad servidor:
  getters sobre el árbol VIVO, sin copia y sin adaptador.

Tres cosas que aparecieron implementando y conviene no volver a descubrir:

- **La vista pide `string` donde el dominio tiene una unión**, y acá el repo se aparta de truco.
  Allá el schema declara el campo con el tipo TS de la unión sobre un wire `string`, así que la
  vista puede pedir `RoundPhase` y el árbol la satisface. La API builder de schema 5 infiere
  `string` a secas, así que pedir la unión dejaba al `MatchState` SIN satisfacer la vista y
  obligaba a COPIAR el árbol para angostarlo. Se pide `string` —que el nodo del servidor y el
  literal del cliente satisfacen los dos— y el angostamiento vive en `rules/projections.ts`.
- **Las proyecciones son DOS juegos y los dos están bien.** Las del motor revientan la invariante
  (`currentRoundOf` lanza); las de las reglas son TOTALES y devuelven `undefined`. El motor
  pregunta desde un comando, o sea con la partida en juego, y ahí "no hay ronda" es un bug; una
  regla que el cliente corre se lo pregunta con la mesa recién abierta, y ahí es la respuesta
  correcta. De eso salió el código nuevo `NO_ROUND_IN_PROGRESS`.
- **No hay `firstIllegal(...rulings)`.** Evaluaría TODOS sus argumentos antes de elegir el primero,
  y las guardas están ordenadas justamente porque las de atrás asumen lo que las de adelante ya
  comprobó. La composición es un `if` con `return` temprano, que es perezosa por construcción.

⚠ **NO HAY `stakes.ts`, y la ausencia es la diferencia con truco.** Allá el tarifado es una TABLA
—cada escalón vale N piedras— y tenerla dos veces es cómo los dos lados se desincronizan. En el
dominó los puntos de una ronda son los pips del que perdió: no hay tabla que compartir, hay una
suma, y ya vive en `rules/tiles.ts`.

De paso se hizo **`528ff7a`** (el vocabulario sale del schema): `MatchPhase`, `RoundPhase`,
`RoundEndReason`, `BoardSide`, `TileLike` y `BetLevel` se declaran en `rules/` y el schema los
**re-exporta**, así que la mudanza no le cambió el import a nadie. `RuleViolationCode` hizo lo
mismo hacia `rules/codes.ts`, y sigue siendo una unión CERRADA —truco la abrió a `string` porque
el front lo pidió; acá la mitad de los motivos existen para que el jugador sepa si le conviene
reintentar, y con `string` un motivo mal escrito compilaría—.

El fixture de los tests de reglas arma la mesa como **objeto PLANO**. Es la mitad de la afirmación
del módulo que ningún `expect` podría hacer: estas reglas corren sin un solo nodo de Colyseus.

### Las dos tablas del cierre

Portado de truco `9b3fd36`, pero **leído de v1**, que lo resuelve distinto en los dos puntos que
importan. El ranking del dominó y la liga eran lo único de v1 que al cerrar una partida no tenía
equivalente acá.

Son **dos puertos y no uno** porque no comparten ni destino ni condición, y la asimetría es de v1:

| | destino | condición |
|---|---|---|
| ranking | cola `rankings_queue`, envoltorio NestJS | **solo mesas pagas** (adentro del `if (!isFreeRoom)`) |
| liga | `POST leagues/save`, sin credencial | **también las gratis** (afuera de ese `if`) |

Juntarlos escondería la segunda diferencia adentro de un `if`. Y los dos defectos que leer v1
corrigió:

- **El aumento de apuesta SÍ pesa en el ranking.** Truco manda el peso de la mesa y nada del
  aumento, con el argumento de que hacerlo pesar sería una decisión de producto. En el dominó ya
  está decidida: v1 calcula `multiplier + acceptedBetExtra` y manda además la traza
  `betIncrease {level, extra, baseMultiplier}`. Copiar la forma de truco cambiaba los puntos que
  el jugador recibe.
- **Lo que viaja como `userId` es el `userUuid`, NUNCA el `playerId`.** En truco el `playerId` ES
  la identidad de plataforma y el transporte lo manda tal cual. Acá es opaco y POSICIONAL
  (`seat-1`), idéntico en todas las mesas: portar la línea le sumaba los puntos de todos los
  ganadores del sistema a una cuenta que no existe.

`DominoMatchConfig` gana `multiplier` —el peso del modo en el ranking, congelado como el resto,
porque el panel puede repesar un modo mientras la mesa se juega—. Es el **tercer** campo con
default en el schema del replay, y el único cuyo default no es del todo inocuo: rebobinar una
partida vieja da peso 1. Hoy no importa —el replay no reporta nada afuera— y queda escrito ahí
para el día que alguien quiera re-liquidar desde el historial.

`publishPattern` **existe ahora que tiene llamador**: el camino de COLA con el envoltorio
`{pattern, data, id}` que el `@EventPattern` del otro lado espera, y que el incremento del catálogo
había dejado afuera justamente por no tenerlo. Mezclarlo con `publishTopic` produce un mensaje que
nadie consume, en silencio; los dos contratos están fijados campo por campo en la suite, porque un
nombre que no coincide no falla de este lado.

La liga usa el **`fetch` de la plataforma** y no un cliente HTTP propio (truco tiene
`shared/http`): un solo consumidor saliente, sin credencial y sin reintentos. `BACKEND_URL` se suma
a las obligatorias de producción, y con eso son **cuatro**.

⚠ **EL SMOKE DEL DEPLOY NO CERTIFICA NINGUNO DE LOS DOS.** Lo que sí hace desde este incremento
es **arrancar**: `BACKEND_URL` pasó a ser obligatoria en producción y el servicio `domino` de
`compose.smoke.yaml` no la tenía, así que el servidor moría ANTES de escuchar y el smoke entero
se caía con un 502 de nginx —un rojo que apunta a la fase y no a la variable que falta—. Lo pinea
`src/compose-env.test.ts`, que le pasa el `environment:` del compose al `parseEnv` de verdad en
vez de comparar contra una lista escrita a mano: así la quinta variable obligatoria se detecta
sola.

La URL apunta al **nginx del stack**, y eso no es comodidad: el smoke TERMINA una partida, así que
el `POST leagues/save` sale de verdad. Con la URL productiva ahí, cada corrida le mete un
resultado inventado a la liga real — y esa ruta no pide credencial, así que nada del otro lado lo
pararía. `smoke/nginx.conf` la atiende con un 204.

Ese 204 **no registra nada**, y ahí está el límite: el smoke pasa igual si el reporte no sale.
Certificarlos de verdad pide un stub que GUARDE lo recibido y un cliente que lo lea —para el
ranking, además, un consumidor bindeado a `rankings_queue`, que hoy nadie declara y cuyos mensajes
el broker descarta sin error—. Es un incremento propio.

⚠ **Falta el tercer flujo de v1**: `lastWinners.saveWin`, el carrusel de últimos ganadores. Su
payload es `Math.round(entryFee * rate * 100)`, o sea que exige CONVERTIR la moneda, y este repo no
convierte nada por decisión escrita (`network/settlement.ts`). Portarlo es traer el servicio de
tasas de v1: es un incremento propio, no una línea.

### Lo que se decidió NO portar

- **Las reacciones** (truco `f8713f3`). Allá el argumento era que existen en v1 y el día del corte
  dejarían de funcionar. **El dominó v1 no las tiene** —verificado: no hay una sola mención en
  `Betaso-Domino-Backend/src`—, así que acá no sería una regresión que se tapa sino una feature
  nueva que nadie pidió.
- **El catálogo fuera de matchmaking** (`a1605d2`), **el registrar y su API administrativa**
  (`c51b4cd`), **la llave interna** (`3308781`) y **el `PUT` como parche** (`d1f23fc`): ya estaban
  hechos, y el último **mejor que en truco**. Allá el `PUT` exigía los seis campos y lo destapó
  probando contra dev; acá `UPDATE_BODY` se escribió a mano todo-opcional en vez de con
  `.partial()`, justamente porque `.partial()` deja los defaults vivos y un `PUT` de un solo campo
  le habría reescrito los otros con el default. El `$set` de Mongo ya llevaba solo lo que vino.

## Incremento planificado — catálogo v1 y entrega RabbitMQ durable

Diseño aprobado:
`docs/superpowers/specs/2026-09-15-catalogo-modos-v1-y-outbox-rabbitmq-design.md`.
Autoridad operativa:
`docs/superpowers/plans/2026-09-15-catalogo-modos-v1-y-outbox-rabbitmq.md`.

Estado: **incremento COMPLETO, Tareas 1–13 cerradas** (`ca9e68a`, `5771b1e`, `ec63d71`, `ce54f9e`,
`348f527`+`93809c1`, `3be878f`+`edf2e14`, `1f03cd7`+`cf8fe11`, `bed7e88`+`c269959`+los de la
revisión, `dd16258`+`075900c`, `3c9930c`, `b9c35b2`, `782ed54`, `d684fd4`).
Baseline **691 tests / 66 archivos**, con `typecheck`, suite, lint, `format`, `build` y `depcruise`
(**205 módulos / 800 dependencias**) en verde.

**La certificación real quedó verde con código 0 de punta a punta** (Docker Engine 27.3.1, Compose
2.29.7, RabbitMQ 4, Mongo 7, Nginx 1.30.4, PM2 con dos instancias): la colección con sus cuatro
índices y su `__v`, el payload del exchange `betaso` comparado campo por campo contra un consumidor
real, el ciclo **Rabbit apagado → encolado PENDING → Rabbit arriba → entregado SENT**, el
reconciliador cerrando una ventana modo→outbox rota a mano, las dos instancias PM2 contestando la
misma revisión, y la partida 2P terminada por `SCORE` con 119 entradas de historial.
`docker compose ps -a` quedó vacío.

⚠ **Lo que la primera corrida real encontró, y no lo veía ninguna suite:**

- **`up --build` sólo construye los servicios QUE SE NOMBRAN.** El cliente del smoke lo invoca
  `compose run`, que NO reconstruye, así que corría una imagen con un `engine-smoke.ts` anterior a
  la Tarea 1 y mandaba `entryFeeUcMinor`. El modo de falla es cruel: el error apunta al CONTRATO y
  no a la imagen, así que se investiga el código que ya está bien. Ahora el cliente se construye
  explícito y primero.
- **El smoke del engine terminaba su trabajo y no salía NUNCA.** El SDK de Colyseus deja handles
  vivos después del `leave()`, así que el event loop no se vacía solo — estuvo colgado 56 minutos,
  en verde, sin decir nada. El runner viejo lo tapaba con `--abort-on-container-exit`; el nuevo
  espera a cada fase, así que quedó a la vista. Los dos smokes salen ahora explícitamente.
- **La cola durable se declara ANTES de la primera mutación.** Un topic exchange DESCARTA lo que no
  matchea ninguna binding, y el publicador recibe su confirm igual —el broker confirma que lo
  ACEPTÓ, no que alguien lo guardó—, así que al revés la fase `recover` esperaría para siempre un
  mensaje que nunca existió.
- **`--no-deps` en todas las fases de cliente.** Sin eso `compose run` vuelve a PRENDER RabbitMQ al
  intentar certificar que está caído, y `enqueue` mediría en verde lo contrario de lo que dice.

### El incremento en diez líneas, para el que llega sin contexto

- **La colección es la de v1 y no se migró nada**: `game_modes_domino`, los mismos campos y defaults,
  los mismos cuatro índices (`uuid_1` único, `isActive_1`, `isActive_1_name_1`, `isActive_1_uuid_1`),
  `_id`, `__v` y los timestamps de Mongoose. Sin mongoose y sin el paquete `uuid`: el documento vive
  sólo dentro del transporte. ⚠ **En v1 el `__v` nunca se movía** —el `versionKey` de Mongoose sólo
  avanza con modificaciones de arreglos y este documento no tiene ninguno—, así que todo lo
  productivo está en `0`; que v2 lo use como revisión es un uso NUEVO de un campo existente, sin
  lector v1 que lo consuma.
- **`entryFee: 10` son 10 UC.** No hay escala, no hay `*UcMinor`, y los montos aceptan decimales
  finitos no negativos con techo `Number.MAX_SAFE_INTEGER`. La spec del 2026-09-14 quedó supersedida
  en ese punto y lleva la nota.
- **El dominó NO autentica administradores.** Los GET del catálogo son públicos; las cinco
  mutaciones viven detrás de `X-Internal-Key` y **no se registran** sin llave (fail closed, 404 y no
  401). Quien valida al admin es el futuro orquestador.
- **La entrega es AL MENOS UNA VEZ y el consumidor debe deduplicar.** La mutación escribe Mongo y un
  outbox durable; el despachador publica después con confirmación del broker, una entrada por lease,
  backoff hasta 300 s y **sin límite de intentos** —una caída larga no puede convertir un pendiente
  en pérdida silenciosa—. Una caída posterior al confirm reentrega, pero **nunca adelanta** la
  siguiente entrada: reordenar el historial del catálogo deja al consumidor con un modo viejo.
- **No hay replica set, así que no hay transacción** entre `game_modes_domino` y `game_mode_outbox`.
  Lo que cubre esa ventana es el reconciliador, y su regla más delicada está abajo en la tabla de
  defectos: el `created` sólo cuenta en la revisión cero.

**Deudas abiertas de ESTE incremento — NO CUMPLIDAS:**

1. ~~**4P y bots siguen sin implementarse.**~~ **CERRADO**: la mesa de cuatro nace, paga y los
   bots la sostienen — ver el bloque del final. Lo que sigue sin efecto es **`multiplier`**, que
   viaja a Mongo y a HTTP y sólo pesa en el ranking.
2. **El hueco heredado del `PUT` que cambia sólo `playersQuantity`.** v1 no consulta duplicados
   cuando el nombre no cambia, así que una edición puede fabricar el par `name + playersQuantity`
   que `create` rechaza una línea antes. Está **pineado por un test** que lo afirma como hueco, no
   como virtud: el que toque la regla de unicidad empieza ahí, y ponerlo rojo es el resultado
   correcto. Cerrarlo exige decidir cuál de las dos reglas asimétricas de v1 gana.
3. **El lease excluye PROCESOS, no llamadas.** El `owner` es por proceso, así que dos mutaciones
   concurrentes de la MISMA instancia entran las dos. Lo cubre una cola en memoria dentro de
   `GameModeService`; si aparece un segundo escritor del catálogo que no pase por ese servicio, esa
   cola no lo protege.
4. **`src/architecture.test.ts` es flaky bajo carga.** Corre `depcruise` como subproceso: aislado
   tarda ~2,4 s, dentro de `npm test` llegó a 5,6 s y falló una vez, verde al repetir. `npm run
   depcruise` da limpio. No se tocó —está fuera del alcance de este incremento— pero si lo ves rojo,
   repetilo antes de investigar.

**El incremento siguiente, y por dónde empieza.** Nadie llama a `settlementOf` todavía: el juego
proyecta la instrucción de pago y no hay quien la cobre. El catálogo ya demostró la forma que le
falta a esa pieza —outbox durable, lease, confirmación del broker, entrega al menos una vez— así
que el primer paso es **portar esa misma forma a la liquidación**: un outbox de instrucciones de
pago con su dispatcher, consumido por el orquestador. Lo que NO está resuelto en ningún lado y hay
que decidir antes de escribir código es **el 4P**: sin regla de reparto del premio, abrir la
liquidación de cuatro deja plata trabada (ver la deuda 1). La decisión va primero, el código después.

Lo que dejó la Tarea 11:

- **LA PRESENCIA DEL DATO ELIGE, y ahora son TRES variables con el mismo criterio.** `RABBITMQ_URL`
  se suma a `MONGO_URI` y `REDIS_URL`: ausente no es una falla, es "esta instancia no publica" — no
  se construye publicador, el despachador no arranca y **el outbox sigue acumulando**, que es el
  punto entero de que la entrega esté desacoplada del request administrativo. No hay
  `GAME_MODE_DRIVER` ni `OUTBOX_DRIVER` ni `AMQP_DRIVER`, y `src/di-container.test.ts` se pone rojo
  si aparecen.
- **LAS TRES PIEZAS DEL CATÁLOGO ELIGEN JUNTAS Y POR `mongo`**, nunca una por una: son la MISMA
  base. Un catálogo en Mongo con un outbox en memoria pierde en cada reinicio justamente los eventos
  que el outbox existe para no perder, y un lease de memoria no excluye a la otra instancia, que es
  lo único que ese lease hace.
- ⚠ **EN PRODUCCIÓN LAS TRES SON OBLIGATORIAS**, y la asimetría con el schema de zod es deliberada:
  fuera de producción "ausente" es la elección legítima de una instancia que corre sola. Adentro,
  las tres ausencias fallan **en silencio** —sin Mongo el catálogo muere con el proceso, sin Rabbit
  el consumidor se queda con un catálogo viejo sin que falle nada de los dos lados, sin llave el
  panel recibe 404 donde espera administrar—. Se emite **UN error que las enumera a las tres**:
  corregir de a una es un despliegue productivo por variable.
- **`vitest.setup.ts` BORRA `RABBITMQ_URL`** como ya borraba las otras dos, y acá el daño del olvido
  SALE DEL REPO: los otros dos ensucian una base nuestra, éste le manda eventos a los CONSUMIDORES
  de otro sistema desde cuarenta archivos en paralelo. Y el modo de falla no sería un rojo sino un
  cuelgue.
- **EL ORDEN DEL APAGADO ES EL CONTRATO**: despachador → drenado del historial → broker → Mongo, y
  cada paso escribe en el siguiente. Cerrar el broker antes que el despachador tira la publicación
  en vuelo sobre un canal cerrado; cerrar Mongo antes de drenar pierde el desenlace de cada partida.
  El test lo mide como **secuencia** (`indexOf` creciente) y no con cuatro `toContain`, que darían
  verde con el orden invertido. Redis sigue afuera: lo cierra Colyseus.
- **`src/main.ts` NO se tocó**, contra lo que el plan listaba: ya delega en el `shutdown()` del
  container, así que la extensión entera vive donde se abrieron las conexiones.
- ⚠ **`ping()` NO RECHAZA SOLO CON EL BROKER CAÍDO: CUELGA** (`amqplib` con `recovery: true` usa
  `maxRetries: Infinity`). Lo único que lo convierte en un 503 es el plazo POR CHEQUEO de
  `registerHealth`. Por eso su test usa una promesa que **cuelga** y no una que rechaza: con
  `Promise.reject` daría verde aunque ese plazo no existiera, y el síntoma en producción sería un
  `/ready` que no contesta nada.

Lo que dejó la Tarea 10:

- **EL CATÁLOGO ES LA AUTORIDAD SOBRE LA ECONOMÍA DE UNA MESA.** El request nombra un
  `gameModeId`, la sala lo resuelve con `activeByUuid` y `pointsToWin`/`entryFee`/`prize` salen del
  modo. El request **ya no puede nombrarlos**: el `strictObject` los RECHAZA en vez de ignorarlos,
  porque ignorarlos dejaría a un llamador creyendo que fijó el premio mientras el modo lo pisa.
- **LA FRONTERA SON DOS FUNCIONES PORQUE LAS ENTRADAS SON DOS COSAS.** `requestOf` +
  `configOf(request, mode)` es el camino de una mesa que NACE; `replayConfigOf` valida un snapshot
  YA GRABADO y **no consulta nada**. Con una sola función que resolviera el modo, el CLI de soporte
  tendría que ir a Mongo para rebobinar —y encontraría el modo YA EDITADO—, así que una partida
  vieja se reconstruiría con los puntos y el premio de hoy.
- **EL MODO SE COPIA AL SNAPSHOT EN `onCreate` Y NO SE VUELVE A CONSULTAR.** Editar un modo con
  partidas en curso no puede reescribirle la economía a una mesa cuya inscripción ya se cobró. Lo
  mide un test que crea la sala, edita el modo y **además** crea una mesa nueva que sí ve los
  valores nuevos: sin esa segunda mitad, un `update` que no escribiera nada dejaba el test verde.
- ⚠ **EL 4P SE RECHAZA EN `configOf`, NO EN LA SALA** — ⚠ y **ya no se rechaza**: el incremento
  del final abre la mesa de cuatro. Lo que sigue valiendo es la UBICACIÓN, que es la decisión:
  `configOf` es
  lo único que ve el request Y el modo, y es por donde pasa toda mesa que nace —la sala es UN
  llamador, y una segunda puerta de creación quedaría sin guarda—. «Antes de génesis» queda
  garantizado por construcción: el árbol nace de un `DominoMatchConfig` y no hay otro modo de
  obtener uno. **La guarda de `settlementOf` NO se tocó**; sigue siendo la última red.
- **Y `replayConfigOf` SÍ acepta cuatro asientos.** Se prohíbe que una mesa de cuatro NAZCA, no que
  una ya grabada se rebobine y se audite — que es justo lo que hace falta el día que una quede con
  la plata trabada. Los tests de mesa de cuatro de `settlement.test.ts` se arman ahora con ella.
- **«El replay nunca consulta el catálogo» se mide SOBRE LA LISTA EXACTA DE IMPORTS de
  `src/replay.ts`**, con el idioma de la Tarea 8. Un reader envenenado sólo diría que hoy no se
  llama con esta entrada; que el archivo no importe nada de `features/game-mode` es estructural. Lo
  que la guarda no cubre: un `await import()` o un `resolve()` del container, que ya está importado.
- **`src/di-container.ts` registra SOLO `GameModeReader`** aunque el adaptador sepa escribir: quien
  crea y edita es la API administrativa, y un token de escritura ahí sería una puerta que la sala
  podría abrir sin querer. Hoy es siempre el de memoria — la rama de Mongo es de la Tarea 11.
- **`src/tests/game-mode-catalog.ts` siembra el modo de la suite UNA vez**, y vive fuera de
  `src/features/` porque `feature-boundary` prohíbe que `features/lobby/tests/lobby.e2e.test.ts`
  —que también crea mesas de dominó— importe el arnés de `features/match/tests/`.
- **El golden se regeneró y lo único que cambió además de los instantes es `meta.gameModeId`**, que
  ahora es el uuid del modo resuelto. Las 167 entradas y el `finalState` salieron idénticos. ⚠ Ese
  uuid lo genera `MemoryGameModeRepository` en cada corrida, así que **cambia en cada regeneración
  como los timestamps**; el motor no lo lee.
- **Seis mutaciones verificadas a mano**, cada una roja en el test que dice medirla y en ningún
  otro: `byUuid` en vez de `activeByUuid`, `pointsToWin` fijo en vez del modo, sin la guarda de
  cantidad, sin la guarda del 4P, un import del catálogo en `replay.ts`, y una sala que relee el
  catálogo después de `onCreate`.
- ⚠ **EL SMOKE TIENE EL LLAMADOR PERO TODAVÍA NO PUEDE CORRER.** `src/smoke/engine-smoke.ts` crea
  el modo con `POST /game-modes` + `X-Internal-Key` antes de crear la sala, pero esa ruta no está
  registrada hasta que la **Tarea 11** llame a `registerGameModeHttp` desde `src/app.config.ts`, y
  las fases del compose son de la **Tarea 12**. Está escrito y anotado, no verificado.

Lo que dejó la Tarea 9:

- **LAS SIETE RUTAS DE v1, Y LO QUE CAMBIA ES QUIÉN AUTORIZA.** Allá cada mutación llevaba
  `isAuthenticated()` + `isAuthorized('admin')`; acá el panel no autentica administradores contra
  domino, así que el orquestador valida al admin y llama con `X-Internal-Key`
  (`shared/http/internal-key.ts`, la comparación constante que ya existía). **Sin llave configurada
  las cinco mutaciones NO SE REGISTRAN** —`reactive/:uuid` cuenta como mutación aunque conserve el
  verbo GET—, y el `warn` de arranque nombra los cinco paths apagados: el que llega a ese log llega
  desde un 404 inexplicable y busca por path.
- ⚠ **EL ORDEN DE LAS RUTAS NO ES LOAD-BEARING CON ESTOS PATHS, y el plan decía que sí.** Medido
  contra la express 5.2 instalada: `/game-modes/:uuid` matchea UN segmento, así que no puede tapar a
  `/game-modes/reactive/x`, y no existe ningún `POST /game-modes/:uuid` que pueda tapar a
  `POST /game-modes/sync`. Invertirlos deja verde cualquier test de comportamiento. El orden se
  conserva igual —es el de v1 y es lo único que protege a `reactive` el día que aparezca un
  `GET /game-modes/:a/:b`— pero **lo pinea una aserción sobre la lista de registros en orden**, con
  un doble de `Application` que sólo anota método y path.
- ⚠ **EL CUERPO DE EDICIÓN NO PUEDE SER `CREATE_BODY.partial()`, y es el defecto más caro de la
  tarea.** Medido sobre la zod 4 instalada: `.partial()` deja los defaults VIVOS, así que un `PUT`
  que sólo cambia el premio le reescribe al modo el multiplicador, los puntos y la sala gratis con
  los valores de fábrica. Edición destructiva silenciosa sobre un catálogo con dinero configurado.
  Los campos se declaran una vez sin envolver y cada cuerpo los envuelve.
- **EL TECHO DE MAGNITUD DE LOS MONTOS SE REPITE ACÁ** (`.max(Number.MAX_SAFE_INTEGER)`), porque
  `configOf` no es la única frontera por la que entra plata: el catálogo la CONFIGURA. Sin el techo,
  `2 ** 53` es una inscripción válida y dos precios distintos son el mismo número. Sigue sin
  escribirse `.safe()`, que implica entero y rechazaría el `1.5`.
- **`enableBots` VIAJA, Y `enableBots` NO LLEVA DEFAULT EN LA FRONTERA.** Lo primero es el bug de v1
  que no se porta —se perdía en la desestructuración de las rutas (`routes.ts:92-93`), así que el
  panel no podía encenderlo en una mesa de dos ni apagarlo en una de cuatro—; lo segundo es que su
  default depende de `playersQuantity` y lo completa el repositorio, así que uno fijo acá dejaría
  toda mesa de cuatro con los bots apagados sin que nadie escribiera ese valor.
- **DOS RESPUESTAS MEJORAN A PROPÓSITO, y no se declara compatibilidad que no hay.** Un cuerpo
  inválido es **400** y no el 500 de v1 —sus rutas nunca llaman al `.parse()` de su propio DTO, así
  que lo único que validaba era Mongoose, después de la consulta de duplicados—; repetir una baja es
  **409** y no 500, que es para lo que la Tarea 8 agregó el cuarto error. **El 400 sale con
  `{code:"MALFORMED",detail}`** y no con el envelope histórico, porque lo emite `shared/http/
  validated.ts` y ése es el mismo vocabulario que el del socket; copiar el validador para cambiarle
  el cuerpo es justo la divergencia que su promoción vino a evitar, y v1 no contesta 400 en ninguna
  ruta. Los otros tres códigos sí llevan `{status:"error",message}`.
- **LO DESCONOCIDO SE RELANZA** al manejador compartido en vez de traducirse: convertirlo en 404 le
  diría al panel que el modo no existe cuando lo que pasa es que la base no contesta, y manda al
  operador a auditar el modo equivocado.
- **EL `batchId` DEL `/sync` LO GENERA LA RUTA, uno por request.** Con uno fijo, el segundo apretón
  del botón de recuperación no encola nada y contesta éxito igual — y el número de la respuesta no
  lo delata, porque `sync` devuelve los modos recorridos y no los insertados. El test lo mide
  drenando el outbox por `next()`/`sent()`, que es la única ventana que el puerto tiene.
- **Trece mutaciones verificadas a mano**, cada una roja en el test que dice medirla. Las dos que
  corrigieron un test decorativo: el `batchId` fijo pasaba verde contra una aserción sobre `synced`
  (ver arriba), y el orden de rutas no lo puede medir ningún request.
- **El defecto que encontró la autorrevisión y no la suite** (`075900c`): el `/sync` era la única de
  las cinco mutaciones sin traducción de errores, así que el catálogo ocupado salía 500. El test del
  503 sólo ejercitaba dos rutas; ahora ejercita las cinco.

Lo que dejó la Tarea 8:

- **EL SERVICIO NO NOMBRA A RABBIT, Y ESO ESTÁ MEDIDO CON LA LISTA EXACTA DE IMPORTS de
  `service.ts`.** Los tipos NO impiden un quinto parámetro que publique "sólo para el create", y esa
  es la tentación que el outbox existe para prohibir. ⚠ **Pero hay que saber hasta dónde llega la
  guarda, porque el comentario original prometía de más**: la lista cerrada atrapa toda dependencia
  **importada** —el puerto AMQP, el despachador, el container— y **no** un quinto parámetro tipado
  con un tipo ESTRUCTURAL escrito en la línea (`publish: (key, body) => Promise<void>`), que no
  importa nada y pasa verde. Está medido. No se intenta cerrar ese caso: el guardarraíl que lo
  atrapara tendría que entender la firma del constructor. Es el piso, no el techo.
- **LA REGLA DE UNICIDAD ES ASIMÉTRICA Y SE REPRODUJO ASÍ, porque es la de v1**: `create` compara el
  par `name + playersQuantity` (`game-mode.service.ts:58`), `update` compara **sólo el nombre**,
  cruzando mesas de dos y de cuatro (`:100-103`), y sólo cuando el nombre CAMBIA (`:99`). Unificar
  cambia lo que el panel puede hacer hoy en alguna de las dos puntas: hacia el par, un renombre puede
  dejar el duplicado que v1 rechaza; hacia el nombre solo, deja de poder crearse la pareja homónima
  2P/4P que el catálogo productivo ya tiene. ⚠ **El hueco heredado**: un `PUT` que cambia sólo
  `playersQuantity` no dispara ninguna consulta, así que puede fabricar el par que `create` prohíbe.
  Cerrarlo pide decidir primero cuál de las dos reglas vale — no es una decisión de esta tarea.
- **LA COLA EN MEMORIA NO ES REDUNDANTE CON EL LEASE, y sin ella la unicidad es decorativa.**
  `MongoLease` excluye PROCESOS y no llamadas del mismo proceso, y la consulta de duplicados es un
  `await`: dos `POST /game-modes` contra la misma instancia la pasan los dos antes de que ninguno
  haya insertado. Es la cola ENCIMA del lease que el comentario del `owner` ya proponía. **El test
  que lo mide lanza las dos creaciones EN EL MISMO TURNO** — esperar a que la primera termine deja
  pasar verde a un servicio sin cola.
- **NO HAY DIFF DE "CAMBIO EFECTIVO", y la ausencia es la decisión.** El repositorio hace `$inc` del
  `__v` en toda llamada que encuentre el documento, así que dos `PUT` idénticos dan las revisiones 1
  y 2 y salen dos `game_mode.updated` con el mismo cuerpo — que es lo que hacía v1 (`:110-123`). El
  consumidor ya deduplica por `id`. Cualquier otra regla tendría que coincidir EXACTAMENTE con el
  criterio del `$inc`, y el día que no coincida hay un cambio real cuya revisión ya se publicó: un
  evento descartado en silencio por la clave de deduplicación.
- **`GameModeStateConflictError` ES EL CUARTO ERROR**, y es el «ya está inactivo»/«ya está activo» de
  v1 (`:148-150`, `:203-205`). 409 y no 404: el modo existe y el panel lo está listando. Comparte el
  código con `DuplicateGameModeError` y no el nombre, que es lo que se lee en el log.
- **SE DESPIERTA AL DESPACHADOR SÓLO TRAS EL ÉXITO** —incluyendo que el outbox haya aceptado—: si el
  lease no se consiguió no hay nada escrito, y si falló el outbox lo que corresponde es la
  reconciliación, que el tick de un segundo ya hace. `wakeDispatcher` es un callback y no el
  `OutboxDispatcher` para no cerrar el ciclo servicio → despachador → outbox → servicio.
- **LAS LECTURAS NO TOMAN EL LEASE**: un GET público que compitiera por el lease del escritor daría
  503 cada vez que el panel edita.
- **`syncAll` DIVERGE DE v1 EN DOS COSAS, NO EN UNA** (el cuerpo del `feat:` dice "una sola
  diferencia de fondo" y se queda corto). La primera es la del incremento entero: no publica, encola.
  La segunda es el número que devuelve — v1 cuenta los modos **efectivamente publicados** (`synced++`
  adentro del `try`, `game-mode.service.ts:181-189`, así que un fallo del broker baja el número) y v2
  devuelve los **encolados**. Es lo correcto acá y está argumentado en `memory-outbox.ts:50-53`: con
  outbox, "publicado" todavía no pasó cuando el HTTP contesta, y repetir el mismo lote no duplica —
  devolver menos haría creer al operador que se perdieron modos.
- ⚠ **EL HUECO HEREDADO ESTÁ PINEADO CON UN TEST** (`⚠ HUECO HEREDADO DE v1: un PUT que cambia sólo
  la cantidad…`): un `PUT` que cambia SÓLO `playersQuantity` no dispara la consulta de duplicados —la
  de `update` corre sólo cuando el nombre cambia—, así que fabrica el par que `create` rechaza. El
  test **no celebra el hueco, lo fija**: el que venga a cambiar la regla de unicidad empieza por ahí,
  y ponerlo rojo es lo correcto. Un hueco documentado sin test se ensancha en silencio.
- **Dieciséis mutaciones verificadas a mano**, cada una roja en el test que dice medirla y en ningún
  otro. La que decidió el diseño del test: sin la cola, la carrera en proceso sólo se ve lanzando las
  dos creaciones en el mismo turno. Las tres que agregó la revisión, y las tres pasaban verdes contra
  los 21 tests originales: `this.tail = result` sin neutralizar —el envenenamiento de la cola, que
  deja el catálogo de sólo lectura hasta reiniciar—, un `batchId` fijo en `syncAll` —el segundo
  apretón del botón de recuperación no encola NADA y contesta éxito igual— y cerrar el hueco de
  arriba.

Lo que dejó la Tarea 7:

- ⚠ **EL `created` SÓLO CUENTA EN LA REVISIÓN CERO** (`cf8fe11`, y la primera corrección del defecto
  estuvo mal). `createdKeyOf` no lleva revisión —hay una sola creación por modo— y los registros del
  outbox **no tienen TTL**, así que esa clave existe para siempre desde que el modo pasó por
  `enqueueCreated`. `revisionKeysOf` la aceptaba sin condición, con lo cual el modo daba "cubierto" en
  la v1, en la v5 y en la v50: **el reconciliador apagado exactamente para los modos que crea el
  panel**, que son todos. Y es la única pieza que cubre la falta de transacción entre
  `game_modes_domino` y `game_mode_outbox` —no hay replica set—, así que una edición cuyo insert de
  outbox se pierda no se recupera nunca más sola. Las tres decisiones se sostienen entre sí y no se
  pueden tocar de a una: **clave de creación sin revisión + sin TTL ⇒ el `created` sólo cuenta en la
  revisión cero**. El hueco del contrato tenía la forma exacta del bug —ningún test combinaba un
  `created` con una revisión posterior—, que es el motivo por el que la suite entera daba verde.

- **EL REQUEST ADMINISTRATIVO NO ESPERA A RABBIT, y ése es el archivo entero.** La mutación escribe
  Mongo y escribe el outbox; el dispatcher publica después con confirmación del broker. La entrega es
  **al menos una vez** y está aceptado: un proceso que muere DESPUÉS del confirm y ANTES de marcar
  `SENT` republica, y el consumidor upsertea por `id`.
- **LO QUE NO SE ACEPTA ES ADELANTARSE.** `next()` mira el PENDIENTE MÁS VIEJO y devuelve vacío si
  todavía no venció su reintento, en vez de ofrecer el siguiente. La consulta NO filtra por
  `nextAttemptAt` (`{status:"PENDING"}` ordenado por `_id`, y el plazo se compara después): con el
  filtro adentro, el segundo `updated` sale antes que el primero y el consumidor se queda con el modo
  viejo **sin que nada falle**.
- **LAS TRES CLAVES DE DEDUPLICACIÓN VIVEN EN `outbox.ts`, no en cada adaptador**, porque el formato
  ES el contrato: `["game_mode.created", uuid]`, `["game_mode.updated", uuid, version]` y
  `["game_mode.sync", batchId, uuid]`. `sync` lleva `batchId` y un discriminador propio porque es el
  botón de "republicar todo" del operador y **debe forzar el evento aunque esa revisión ya se haya
  publicado** — justo el caso en que se aprieta.
- **`reconcile` NO es un `ensureUpdated` a secas**, y ése fue el hueco del plan. Da por cubierto al
  modo cuyo `created` existe (`revisionKeysOf` devuelve las DOS claves): sin eso, cada alta del panel
  recibe además un `updated` espurio en el primer tick, para siempre. Un `created` PERDIDO sí vuelve
  como `updated`, que es la estrategia de recuperación del `/sync` de v1.
- **NO HAY LÍMITE DE INTENTOS, y la ausencia es la decisión.** Descartar al intento N es una pérdida
  silenciosa; una caída larga del broker cuesta retraso, no datos. El backoff sí tiene techo:
  `min(300_000, 1_000 * 2 ** attempts)`.
- ⚠ **EL PLAZO DE 5 s NO ES DECORACIÓN.** `publishTopic` no rechaza solo con el broker caído: SE
  CUELGA (ver el bloque de la Tarea 6). Sin el plazo, el primer tick contra un Rabbit apagado espera
  para siempre con el lease tomado y el outbox deja de drenar sin un solo error en el log.
- **EL DISPATCHER TIENE SU PROPIA GUARDA `inFlight`, y no alcanza con el lease**: `MongoLease` excluye
  PROCESOS y no llamadas del mismo proceso, así que un `wake()` encima del tick programado publicaría
  la misma entrada dos veces.
- **NO HAY TTL NI BORRADO.** Los `SENT` son lo que impide que la reconciliación vuelva a emitir toda
  revisión ya publicada en cada tick.
- **`MemoryGameModeOutbox` no es un doble** y comparte `transports/tests/outbox-contract.ts` con el
  adaptador Mongo. El contrato mide SÓLO por el puerto —no hay inspector de "todas las entradas",
  porque la única ventana que la producción usa es `next()`—; lo que sólo Mongo puede tener (documento,
  índices, colección, hex del `ObjectId`) se mide en su propio archivo.
- **`reconcile` consulta por claves candidatas, no lee la colección.** El techo está escrito como
  comentario `ponytail:` en `mongo-outbox.ts`: un `$in` de `2 × modos` por segundo deja de ser adecuado
  del orden del millar de modos, y ahí lo que cambia es la cadencia o una marca de agua, no la consulta.
- **Quince mutaciones verificadas a mano**, cada una roja en el test que dice medirla. La que corrigió
  un test decorativo: `close()` sin esperar `inFlight` pasaba VERDE contra un `Promise.race` con una
  promesa ya resuelta —el race de microtareas lo gana igual—. Se espera un turno completo del event
  loop.

Lo que dejó la Tarea 6:

- **`publishTopic` RESUELVE SÓLO DESPUÉS DEL CONFIRM del broker, y es la razón entera de usar un
  confirm channel.** El dispatcher de la Tarea 7 marca `SENT` cuando esa promesa resuelve, y
  `channel.publish()` sólo dice "lo puse en el buffer de salida": resolver ahí marcaría como
  entregado un mensaje que el broker nunca tomó, y el evento se pierde **sin rastro y sin reintento**.
  v1 abre un confirm channel y **nunca espera los confirms**.
- **`publish() === false` se RECHAZA aunque sea contrapresión** (buffer de salida lleno) y no un
  fallo. El mensaje puede terminar saliendo, pero quien espera no tiene cómo enterarse: darlo por
  bueno es el mismo evento perdido. El outbox reintenta y la entrega es al menos una vez por diseño,
  así que un duplicado es el costo correcto.
- **La conexión se REUSA al soltar el canal, y es lo que este archivo decide distinto que truco.**
  `connect(url, {recovery:true})` devuelve un `RecoveringChannelModel` que se reconecta solo y sin
  plazo de renuncia (`maxRetries: Infinity`, `node_modules/amqplib/lib/recovery.js:8`), y sus canales
  se piden sobre el MODELO. Truco vuelve a llamar `connect()` al soltar el canal: eso abandona un
  modelo que igual sigue reintentando para siempre, **un zombi por cada caída del broker**. Acá se
  memoizan por separado conexión y canal.
- ⚠ **CON EL BROKER CAÍDO, `connect()` NO RECHAZA: CUELGA, y eso lo heredan las Tareas 7 y 11.** Ese
  mismo `maxRetries: Infinity` deja muerta la única rama que rechaza la conexión inicial
  (`_scheduleReconnect` sólo llama `_rejectInitialConnection` con los reintentos agotados,
  `lib/recovery.js:290-294`). **`AmqpPublisher` no lo acota a propósito**: el plazo es del que llama,
  que es quien sabe cuánto puede esperar — 2 s POR CHEQUEO en la sonda de LISTO
  (`shared/http/health.ts`, la misma propiedad que ya está escrita para Mongo: «una base caída no
  falla: CUELGA») y 5 s en el dispatcher del outbox. O sea: **`ping()` no se rechaza solo**, y sin el
  plazo del endpoint un Rabbit caído deja `/ready` sin contestar en vez de contestar 503.
- **SE ESCUCHA `error` EN LA CONEXIÓN, no sólo en el canal, y sin eso el proceso se cae.**
  `RecoveringChannelModel` es un `EventEmitter` y reemite el `error` del modelo de abajo
  (`lib/recovery.js:221`); Node LANZA cuando un `error` no tiene a quién ir. **El caso es el socket
  que se muere DESPUÉS de establecido** —broker reiniciado, red cortada, heartbeat vencido—, y no el
  que parece obvio: un rechazo de credenciales pasa en el handshake y sale como `connect-failed` más
  un reintento agendado (`lib/recovery.js:275-279`) sin tocar nunca ese `error`. **Por eso los dos
  dobles del test son `EventEmitter` de verdad** y no objetos con un `on: vi.fn()`: es lo único que
  puede poner roja esa falta.
- **`close()` espera el intento de conexión EN VUELO** antes de soltar las referencias, y tolera la
  conexión ya cerrada. Lo primero evita que un apagado disparado durante una entrega deje el socket
  abriéndose después del cierre —con `recovery: true` ese modelo reintenta para siempre y el proceso
  no termina de salir—; lo segundo es la lección de cerrar Redis dos veces.
- **`ping()` abre el canal y NO publica.** Su llamador es la sonda de LISTO, que corre en cada chequeo
  del balanceador: una sonda que publicara emitiría un evento de catálogo por chequeo.
- **No se portó `publishPattern`.** El envoltorio `{pattern,data,id}` es del camino de COLA de v1, que
  lo consume un `@EventPattern` de NestJS; el exchange `betaso` lleva el cuerpo CRUDO
  (`Betaso-Domino-Backend/src/storage/rabbitmq/publisher.ts:49-68`), y mezclarlos produce un mensaje
  que nadie consume, en silencio.
- **`amqplib@2` trae sus propios tipos**: no hay `@types/amqplib` que instalar. Y el `close` del canal
  no cuelga a nadie —resuelve sus callbacks pendientes con un `Error('channel closed')`,
  `lib/channel.js:36-43`—, así que no hay confirm esperando para siempre tras una caída.
- **Catorce mutaciones verificadas a mano**, cada una roja en su test y en ningún otro. La que decidió
  el diseño del test: lanzar las dos publicaciones EN EL MISMO TURNO. Esperar a que la primera
  termine deja pasar verde a un publicador sin memoización, que es justo lo que el archivo prohíbe.

Lo que dejó la Tarea 5:

- **`Lease.within` devuelve `T | undefined`, y ese `undefined` es un desenlace NORMAL**: la Tarea 8 lo
  convierte en 503 (`GameModeWriteBusyError`) y la 7 se saltea el tick. Un `within` que lanzara haría
  que un catálogo ocupado se viera como una caída.
- **v1 NO SERIALIZA NADA de esto, así que el lease es pieza nueva y no un port.** `create` hace
  `findOne({name, playersQuantity})` y después `create(...)` sin lock, sin transacción y sin índice
  que lo respalde (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts:57-69`); los únicos
  `Mutex` de v1 (`async-mutex`) son de PROCESO y son de las salas y del matchmaking del lobby, no del
  catálogo. v2 es estrictamente más fuerte acá.
- **La adquisición es UN `findOneAndUpdate`**, nunca "leo, decido, escribo": entre la lectura y la
  escritura hay un turno del event loop. El **E11000 del upsert competido no es una rareza de carrera
  sino el camino ORDINARIO de "lo tiene otro"** —Mongo deriva el `_id` del insert de la igualdad del
  filtro y choca con el documento que está—, y se reconoce por el CÓDIGO numérico: un `/E11000/`
  sobre el mensaje pasa la suite y se rompe el día que el servidor reescriba la frase.
- **La liberación lleva el `owner` en el filtro y es la línea más peligrosa del archivo.** Con
  `deleteOne({ _id: name })` a secas, un proceso cuyo lease venció mientras trabajaba le borra al
  salir el lease que ya tomó otro: un tercero entra creyendo que está libre y quedan dos escritores
  del catálogo sin que nada falle.
- **NO HAY RENOVACIÓN, a propósito.** Si `work()` tarda más que `ttlMs`, otro proceso puede entrar en
  paralelo. La contramedida es que adentro del lease no vayan trabajos largos —el dispatcher toma UNA
  entrada por tick y no un bucle—, no un renovador con su propio temporizador y su propia carrera.
- **El dueño es por PROCESO y no por llamada**, y hay que saber el precio: **este lease excluye
  PROCESOS, no llamadas concurrentes del mismo proceso.** Dos mutaciones que lleguen a la misma
  instancia entran las dos, y un `within` anidado libera al salir del de adentro dejando al de afuera
  sin lease. A favor: un `release` que no llegó a la base no deja al proceso esperando su propio
  vencimiento.
- **`MemoryLease` vive en el mismo archivo** (criterio de `shared/kv.ts`, que también lleva puerto e
  implementación de memoria juntos) y **corre siempre**: un proceso sin almacén compartido no tiene a
  quién excluir, que es exactamente lo que el adaptador Mongo hace contra un solo dueño. Un `Map` de
  leases simularía una negación que ni el real produce.
- **Ocho mutaciones verificadas a mano**, cada una roja en su test y en ningún otro. La que decidió el
  diseño del test: lanzar los dos `within` EN EL MISMO TURNO. Esperar a que el primero entre deja
  pasar verde a un adaptador de "leo, decido, escribo", que es justo lo que este archivo existe para
  prohibir.

Lo que dejó la Tarea 4:

- **El documento BSON vive SÓLO en el transporte** (`transports/mongo-repository.ts`), con el driver
  oficial y sin mongoose. Es el gemelo de `mongo-history.ts`: `CollectionSource` es un recorte
  estructural que `Mongo` satisface sin saberlo, así que la suite lo maneja sin un `as unknown as
  Mongo` y **sin ningún servicio externo** (`vitest.setup.ts` borra `MONGO_URI` a propósito).
- **Los defaults son los del SCHEMA de v1, no los de su DTO zod.** El DTO nunca se ejecutaba —las
  rutas de v1 desestructuran `req.body` crudo y jamás llaman `.parse()`—, así que su
  `pointsToWin: 10` era código muerto y los documentos productivos tienen el **25** del schema.
  Verificado en `Betaso-Domino-Backend/src/storage/mongo/schemas/game-mode.schema.ts:51-56`.
  `enableBots` es el único default que depende de otro campo (`:66-71`,
  `default() { return this.playersQuantity === 4 }`) y va con `??`, no con `||`: un `false`
  explícito sobre una mesa de cuatro es una elección del panel.
- **`__v` ES LA REVISIÓN Y NO SALE DEL RELOJ**: `$inc: { __v: 1 }` en Mongo, `version + 1` en
  memoria. Derivarla de `updatedAt` colapsa dos ediciones del mismo milisegundo; calcularla en el
  proceso colapsa dos concurrentes. El outbox de la Tarea 7 deduplica por `uuid + version`, así que
  dos cambios reales con la misma revisión son un evento publicado y otro **descartado en silencio**.
  ⚠ En v1 el `__v` **nunca se movía** (el `versionKey` de Mongoose sólo avanza con modificaciones de
  arreglos, y este documento no tiene ninguno): todo lo productivo está en `0`. Que v2 lo incremente
  es un uso NUEVO de un campo que ya estaba, no una ruptura — ningún lector de v1 lo consume.
- **`MemoryGameModeRepository` no es un doble**, es el adaptador de la instancia sin Mongo, igual que
  `MemoryHistory`. Los dos comparten el contrato de `transports/tests/repository-contract.ts`: dos
  suites paralelas derivan en cuanto una tarea toque un default y se acuerde de un solo archivo, y
  entonces el catálogo sale al revés en el despliegue que no configuró `MONGO_URI`.
- **El `Clock` se redeclara en el transporte** en vez de importarse de `features/match`. Es legal hoy
  (sale por su `index.ts`) y es un ciclo mañana: la Tarea 12 hace que el nacimiento de una mesa
  resuelva el modo activo.
- **La unicidad `name + playersQuantity` NO es un índice** y sigue sin implementarse acá: es lógica
  de servicio y la escribe la Tarea 8, que tiene anotado en el plan el hallazgo incómodo —en v1 la
  regla es **asimétrica**, `create` compara nombre+cantidad (`game-mode.service.ts:58`) y `update`
  compara **sólo el nombre** (`:100-103`)—.
- **Trece mutaciones verificadas a mano.** La que importa: `$set: { ...input }` crudo pasaba VERDE
  contra un contrato que sólo omitía claves. Las rutas de v1 desestructuran el cuerpo entero
  (`routes.ts:117-118`), así que lo que llega es `{ name: undefined, prize: 20, … }` — y en
  JavaScript esa clave existe, así que el spread la escribe encima y Mongo guarda un `null`. El caso
  del `undefined` explícito es el que lo mide.

Lo que dejó la Tarea 3:

- **`features/game-mode` nace con SOLO contratos**: la entidad portable (`core/game-mode.ts`), los dos
  puertos y los tres errores (`core/catalog.ts`) y el cuerpo literal de Rabbit (`events.ts`). Mongo,
  HTTP y AMQP son las Tareas 4, 9 y 6.
- **El `id` del payload Rabbit es el `uuid` del modo y NO el hex del `_id`**, y no estaba escrito en
  ningún lado: la entidad tiene los dos y la spec sólo declara `id: string`. Lo resuelve el v1
  productivo (`Betaso-Domino-Backend/src/game-modes/game-mode.publisher.ts:43`, `id: mode.uuid`).
  **Al revés no falla nada de este lado**: el consumidor upsertea por `id`, así que publicar el `_id`
  le duplica el catálogo en silencio. La asimetría que queda es deliberada: el `toDTO` HTTP sí mapea
  `id→_id`, porque el DTO de v1 devuelve los dos campos. El fixture del test los tiene **distintos**
  a propósito — con el mismo valor ninguna aserción distingue cuál se mapeó.
- **El cuerpo no lleva `isFreeRoom` ni `enableBots`**, que sí existen en la entidad y en Mongo. La
  omisión la mide el `toEqual`; medido por mutación, junto con `id: mode.id`, las claves
  intercambiadas y un `playerCount` fijo.
- **`index.ts` exporta dos nombres**, `GameMode` y `GameModeReader`. El repositorio, los errores y el
  contrato Rabbit los consumen adaptadores de esta misma feature; las tareas siguientes agrandan la
  superficie cuando aparezca el consumidor externo.

La Tarea 2 promovió `validated` a `src/shared/http/validated.ts` sin barrel. El guard de ubicación
vive en `src/architecture.test.ts` y **no** en `.dependency-cruiser.cjs` a propósito: depcruise
evalúa ARISTAS, y una copia del archivo que todavía nadie importa no produce ninguna.

Lo que dejó la Tarea 1:

- **`entryFee`/`prize`/`amount` son UC COMPLETAS** y no llevan más el sufijo `*UcMinor`:
  `entryFee: 10` son diez UC. Es la convención del catálogo de v1, que es de donde las tareas
  siguientes copian estos números — y copiarlos con el nombre viejo es lo que invitaba a un `* 100`
  en una sola de las dos puntas.
- **`configOf` ya no exige enteros, y las otras dos guardas siguen ahí.** `Number.isSafeInteger`
  cerraba tres puertas de un golpe y una era la fracción, que v1 usa (`1.5` es un UC y medio). El
  `ucAmount` que quedó es `z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)`. **No se
  escribe `.safe()`**: en zod 4 `.safe()` IMPLICA entero y volvería a rechazar el `1.5` (medido
  sobre la 4.6.1). Sin el `.max()`, `2 ** 53` sería un monto válido.
- **`rateId`, `currency` y las claves de idempotencia no se tocaron**, y se siguen asertando como
  literal.
- **El golden lo escribe `game-2p.e2e.test.ts` y el plan decía `replay.int.test.ts`**, que solo lo lee.
  Corregido en el plan. El renombre deja el fixture sin compilar y **vitest sigue verde**: quien lo
  atrape es `typecheck`.

Este incremento reemplaza completamente el catálogo de v1: conserva la colección
`game_modes_domino`, sus campos, defaults, índices, `_id`/`__v`/timestamps, las siete rutas HTTP y
los eventos `game_mode.created`/`game_mode.updated` del exchange `betaso`. Domino v2 será el único
writer. El panel no autentica administradores contra Domino: el futuro orquestador valida el admin y
llama las mutaciones con `X-Internal-Key`; los GET continúan públicos.

La compatibilidad productiva corrige la convención actual de dinero: en v1 `entryFee: 10` significa
**10 UC**, no `0,10 UC`. La Tarea 1 renombra `entryFeeUcMinor`/`prizeUcMinor`/`amountUcMinor` a
`entryFee`/`prize`/`amount` y acepta números finitos no negativos, incluidos decimales. Hasta que esa
tarea se implemente, el párrafo histórico anterior describe correctamente el código actual.

Rabbit no participa en el request administrativo: la mutación escribe Mongo y un outbox durable; un
dispatcher con confirmaciones, retry ilimitado y lease Mongo publica después. No se exige replica
set: un reconciliador compara `__v` para reparar la ventana modo→outbox y puede recuperar un `created` perdido como
`updated`, igual que el `/sync` de v1. La entrega es al menos una vez, por lo que consumidores deben
deduplicar. `multiplier`, `isFreeRoom` y `enableBots` se preservan en Mongo/HTTP; Rabbit conserva su
payload v1 y no añade los dos últimos. Este incremento no implementa bots, torneos, multiplicador
dinámico ni 4P; las mesas 4P se rechazan explícitamente antes de génesis. ⚠ Eso último dejó de
ser cierto: el incremento del final las abre, con la regla de reparto leída de v1.

## Incremento completo — el registro de la mano

Sin plan escrito: salió de barrer los últimos commits de truco (`8293fe0`, `c31c167`, `a7a318f`,
`43d19ca`, `fec2480`) contra este repo y quedarse SOLO con lo que el dominó necesita. Baseline
**779 → 798 tests / 76 archivos**, con `typecheck`, lint, `build` y `depcruise` (**241 módulos /
972 dependencias**) en verde.

### `RoundState.pastMoves`: la mano apunta las jugadas

Portado de truco `c31c167`, pero **leído de v1**: el equivalente son los `historyMoves` de
`rooms/schema/domino/*/round.state.ts`, que el panel del front lista en orden.

**SON LAS TRES JUGADAS DEL DOMINÓ Y NADA MÁS** —poner ficha, cargar del pozo, pasar— y esa
frontera es la mitad de la decisión. Los otros cuatro verbos no entran: `REVEAL_TILES` es la
ceremonia del reparto, `ABANDON` ya vive en `PlayerState.hasAbandoned` y en su evento, y los dos
del AUMENTO son economía, con su propio estado de trabajo (`betOffer`) y su propio lector —el
historial de soporte, que guarda el payload entero de los dos comandos—.

**Es la partición de v1 y no la de truco.** Allá el canto SÍ es un acto de la mano, así que un solo
registro con un solo vocabulario es lo correcto y el nodo tiene que llevar el escalón y la
respuesta. Acá v1 los separa: `historyMoves` con sus `isPassed`/`isLoaded` por un lado,
`betMultiplierProposals` por otro —que además no es un panel sino el estado de trabajo de la
negociación y la fuente de las métricas de Mongo (`metrics/router.ts`)—. Copiar la forma de truco
le colgaba a cada ficha puesta un `level` y un `accepted` que para ella son siempre cero, y hacía
del nodo el cajón de sastre que no es. **`PastMove` tiene DOS campos: `type` y `playerId`.**

Lo que se apunta es lo que el ÁRBOL NO GUARDA, y es la única justificación del campo:

| jugada | lo que queda hoy sin el registro |
|---|---|
| pasar | `Turn.consecutivePasses`, un contador que se reinicia |
| cargar | `BoneyardState.count`, que dice cuántas quedan y no quién sacó |
| el orden entre las tres | **nada**: `board.tiles` ordena las colocaciones y nada más |

- **Y NO es la máquina de v1.** Allá el arreglo ERA el estado —`getBoardEnds()` lo recorría para
  saber por dónde iba el tablero, y de ahí sus siete campos con `placedTile` y `lockedNumber`—. Acá
  el tablero es `BoardState` y el registro es un apunte que **ninguna regla puede leer**:
  `pastMoves` no está en `RoundView`, así que una regla que estire la mano hacia él no compila.
- **LA FICHA NO VIAJA ACÁ.** Ya vive en `board.tiles` con su `playedBy` y su `side`. Duplicarla
  sería una segunda copia que puede discrepar, y el día que el dominó tenga una jugada de dorso
  sería publicarla. El número de jugada tampoco es campo: es el índice del arreglo.
- **NO HAY BOCA DEL RELOJ, y la ausencia es una afirmación.** El historial de soporte tiene dos
  (`source: PLAYER|SYSTEM`) y truco también —allá el conductor canta por el que se calló—. Acá el
  reloj nunca juega por nadie: al vencer el turno RETIRA (`MatchDriver.timeout`), y retirarse no es
  una jugada. Por eso `MoveLog` no lleva `bySystem` y **ningún conductor lo recibe**. El día que
  haya bots o jugada automática, ahí aparece el segundo llamador y el campo que los distinga; hay
  un test que lo fija como frontera, no como detalle.
- **SE APUNTA ANTES DE MUTAR**, y es la única regla que los tres comandos tienen que respetar. No
  es estilo: `advance` puede cerrar la ronda —por dominó o por tranca— y abrir la siguiente, así
  que apuntar después mandaría la última jugada de una mano al registro de la mano que sigue.
- **MUERE CON LA RONDA**, como el pozo: el panel que lo lee es el de la mano en curso.
- ⚠ **`pastMoves` VA AL FINAL DE `RoundState`.** `@colyseus/schema` codifica por índice:
  insertarlo en el medio corre todos los campos posteriores y un cliente con el schema
  pre-generado decodifica basura — es la ruptura de wire que la identidad multiplataforma ya pagó
  una vez. Agregado al final, un cliente viejo lo ignora.
- **El registro NO sale por `EngineGraph`.** Escribe y nadie lo lee del lado del servidor, así que
  una puerta pública sería una segunda forma de apuntar una jugada —una que no pasa por el verbo—
  justo en el registro que el front lee como si fuera la verdad.
- **El golden se regrabó**, y de paso quedó al día: el commitado era anterior a `multiplier`,
  `betLevels`, `isFreeRoom` y `betResponseTimeoutMs` en `meta`. **No se pierde cobertura**: que un
  snapshot VIEJO rebobine igual lo mide `match-contract.test.ts` con un snapshot viejo escrito a
  mano y a propósito, que es donde corresponde.

⚠ **LO QUE ESTE INCREMENTO NO TRAE, y v1 sí tiene: el historial de propuestas de aumento**
(`betMultiplierProposals`). Hoy una propuesta RECHAZADA no deja rastro en el árbol —`settle` borra
`betOffer` y `acceptedBetLevel` guarda solo la aceptada—. No se portó porque en v1 ese arreglo es
(a) el estado de trabajo de la negociación, que acá ya es `betOffer`, y (b) la fuente de unas
métricas que en v2 se sacan del HISTORIAL DE SOPORTE, que guarda el payload entero de
`PROPOSE_BET_MULTIPLIER` y `RESPOND_BET_MULTIPLIER`. Si alguna vez el front necesita PINTAR las
propuestas de la partida, es un nodo propio al nivel de `MatchState` —donde ya viven
`acceptedBetExtra`/`acceptedBetLevel`—, **no un campo más en `PastMove`**.

### El vocabulario lleva adjetivo

Portado de truco `8293fe0`. Una sola palabra para dos cosas opuestas se leyó mal apenas existió el
registro: hay acciones que se PUEDEN hacer y acciones que se HICIERON. `legalActionsFor` pasó a
`availableActionsFor`, `GameAction` a `AvailableActionType`, `LegalAction` a `AvailableAction`, y
`MoveType` nombra la otra mitad.

- **`MoveType` es un `Extract` de las TRES jugadas**, no la lista entera ni un `Exclude`. Truco
  saca `PLAY_TAPADA` porque es un botón y no un verbo; acá los siete botones son verbos, pero solo
  tres son JUGADAS. El `Extract` es lo que mantiene el vocabulario único: un verbo renombrado
  arriba deja el tipo en `never` y el registro deja de compilar.
- **La aserción de `core/command.ts` es `MoveType extends CommandName`** (`MovesAreVerbs`), y la
  dirección importa: las jugadas son un SUBCONJUNTO de los verbos, no al revés.
- **Vive en `rules/` y no junto a los comandos** porque el ÁRBOL tiene que poder nombrarlo:
  `core/command.ts` importa `BoardSide` de `state/`, así que un `CommandName` adentro de un nodo
  del schema sería un ciclo.
- ⚠ **Rompe para el front** el día que tenga su copia de `rules/`. Hoy no la tiene.

### Lo que se decidió NO portar, de esta tanda

- **Los contadores del lobby por censo de asientos** (truco `a7a318f`). Allá el lobby había PERDIDO
  los tres contadores al quedarse sin estado, así que volverlos a poner era recuperar una
  regresión. **Acá nunca se perdieron**: `LobbyRoomState` ya lleva `totalPlayers`,
  `playersInLobby` y `gameModesCount`, y el defecto REAL de v1 —el cartel congelado, que allá solo
  se recalcula en el join/leave del propio lobby— ya está arreglado distinto: `refresh()` corre
  cada segundo sobre `matchMaker.query`.
  Lo único que el censo de truco agregaría es contar ASIENTOS en vez de SOCKETS —el que se queda
  sin wifi deja de contar aunque su silla siga jugando y su reloj corriendo—, y **eso no es una
  regresión contra v1: v1 también cuenta sockets** (`room.clients` en `countPlayers()`). O sea que
  es un cambio de producto, no un port. Y el resto del censo no compraría nada: el `live_seats` de
  truco tiene que cargarse el `poolId` y el modo para poder desglosar, que acá ya viene en la
  metadata de la sala.
  **Si alguna vez se quiere la semántica de asientos**, el camino barato NO es el hash: la sala ya
  escribe metadata (`gameModeId`), así que publicar ahí los asientos vivos y que `applyCounts` lea
  eso en vez de `room.clients` es el mismo arreglo en diez líneas, sin ops nuevas de `KeyValueStore`
  ni dos umbrales de caducidad.
- **El aislamiento de puertos de la suite** (truco `43d19ca`). Allá la suite habla con Mongo y Redis
  de verdad y chocaba con los 27017/6379 **de este repo**, que es quien los tiene tomados. Acá
  `vitest.setup.ts` borra `MONGO_URI`, `REDIS_URL` y `RABBITMQ_URL`: la suite no depende de ningún
  servicio externo, así que no hay puerto que aislar.
- **El sync de documentos** (`fec2480`, `c25cff8`) es de los docs de truco; este repo no los tiene.
- **El `PUT` como parche** (`d1f23fc`) y **la llave del `.env.example`** (`3308781`) ya estaban
  hechos, y el primero **mejor que en truco** — ya anotado más arriba.

## Incremento completo — censo del lobby y alcance explícito de tests

Portado selectivamente de truco `a7a318f`, `d4fc247` y `16a4bab`, después de que el producto pidió
la semántica de ASIENTOS que la revisión anterior había dejado afuera. Baseline **798 → 802 tests /
76 archivos**, con `typecheck`, suite, lint, `build` y `depcruise` (**241 módulos / 965
dependencias**) en verde. **Matchmaking sigue expresamente fuera.**

- `MatchRegistry` estampa un campo por sala en el hash compartido `live_seats`. Cuenta los asientos
  reservados aunque el socket se corte, deja de contar una sala tras dos latidos y barre su campo
  tras cuatro. `remove()` lo borra inmediatamente. El lobby conserva su estado v1 y su pulso de un
  segundo; solo cambió la fuente de los contadores.
- El censo entra al lobby por el token estrecho `MatchCensus`. Importar `MatchRegistry` desde el
  barrel de match creaba el ciclo lobby → match → lobby, porque `DominoRoom` consulta
  `LobbySettings`; el composition root registra la misma instancia bajo ambos contratos.
- La suite tiene dos ejes: ubicación por dueño y sufijo por alcance. `*.test.ts` es unitario,
  `*.int.test.ts` integra piezas sin levantar la app y `*.e2e.test.ts` levanta el servidor. Vitest
  expone los proyectos `unit`, `int` y `e2e`; CI ejecuta primero unit y luego int/e2e.
- El scaffold que comparten features vive en `src/tests/`. Las implementaciones `Memory*` no se
  movieron a tests: en dominó son adaptadores reales del despliegue sin Mongo/Redis, no fakes.

## Incremento completo — documentación local navegable

Portado del sitio de truco, adaptado a la arquitectura real del dominó. Baseline de código sin
cambios: **802 tests / 76 archivos**. El gate nuevo es `npm run docs:build`, además de los gates del
backend.

- `npm run docs:dev` sirve VitePress en la URL que imprime (normalmente
  `http://localhost:5173`); `docs:preview` sirve el build estático.
- `docs/index.md`, `arquitectura.md`, `api-y-mensajes.md` y `operacion.md` son las puertas del sitio.
  Reutilizan `reglas-de-juego-v1.md`, el diseño del orquestador y las specs existentes; los planes
  fechados son historial de ejecución y `srcExclude` no los publica.
- Mermaid renderiza los diagramas y el theme agrega zoom, paneo y controles con `svg-pan-zoom`, igual
  que truco. La búsqueda es local: no hay servicio externo ni endpoint de documentación en la app.
- CI construye el sitio después del bundle. Un enlace roto o un diagrama que no compile pone el job
  rojo antes del smoke de deploy.

## Incremento completo — integración con el front: identidad plana y las tres features de truco

Sin plan escrito: salió del pedido de dejar el dominó listo para que el front lo integre, con la
tercerización (el orquestador que cobra) diferida a un incremento propio. Baseline **820 → 1014
tests / 78 → 105 archivos**, con `typecheck`, suite, `biome check`, `depcruise` (**345 módulos /
1348 dependencias**) y `build` en verde.

Tres commits: `cea5bcc` la base del port, `18c99b0` el aplanado de la identidad, `d83732d` las 27
suites.

### La identidad es UN `userId`, y por qué

`features/matchmaking`, `features/tournament` y `features/economy` llegaron portadas de truco en una
sesión anterior, sin commitear y a medio cerrar. Lo que había quedado abierto era la identidad:
`Identity` ya era `{ userId }` pero `MatchRegistry`, `match-contract`, `settlement` y `configOf`
seguían con la pareja `{ platformId, userUuid }`, y `typecheck` no lo veía porque `matchOf` aceptaba
las dos formas. **`DominoRoom.onJoin` ya había dejado de comparar la plataforma**: el asiento se
otorgaba por `sub` solo, así que dos productos que firmaran el mismo `sub` reclamaban el mismo
asiento con la inscripción ya cobrada.

Se aplanó entero en vez de revertir, y el argumento es medible: **ni truco ni el v1 del dominó
tienen `platformId` en una sola línea**. Los únicos valores que existían —`betaso`, `partner`,
`third`, `fourth`, `replay`— eran fixtures de esta suite midiendo una multiplataforma que ningún
sistema alimenta. El vocabulario que queda es `userId`, que es el de truco y el del v1 (181 usos
contra 5 de `userUuid`).

- **`shared/player-ref.ts` SE BORRÓ.** Un campo `string` no justifica una interfaz compartida, y
  `MatchSeat` tampoco podría importar `Identity` de `features/auth`: el core solo importa de su
  feature y de `shared/` (Regla 1).
- **`playerKey` del registro dejó de serializar.** La pareja necesitaba `JSON.stringify` porque un
  `a:b:c` concatenado no dice dónde termina una mitad y empieza la otra. Con un componente no hay
  dos mitades que confundir. **Y con eso se fue la DOBLE ESCRITURA** que el port a medias había
  dejado: el registro anotaba la clave-pareja *y* la clave-string para que el `Matchmaker` de truco
  encontrara algo.
- **`idempotencyKey` CONSERVA el `JSON.stringify`**, y no es inercia: sigue concatenando `matchId` y
  `kind` con la identidad, que son los que reintroducen la colisión.
- **`PlayerState` perdió un campo `noSync()` y ninguno sincronizado**, así que esto NO es una
  ruptura de wire — a diferencia de la que los agregó.
- **`configOf` rechaza el `userId` repetido** donde antes rechazaba la pareja repetida: es
  estrictamente más estricto.
- Verificado por MUTACIÓN: `assertSameTable` sin comparar el `userId` (1 rojo de 12) y la unicidad
  indexando por posición en vez de por `userId` (2 rojos de 32).

### Las 27 suites que el port no había traído

Truco mide esas tres features con 29 archivos de test; habían llegado 2. Lo que cambia respecto de
truco, y por qué:

- **No hay `fake-backend`.** Allá el composition root cablea siempre lo real y la suite lo sustituye
  entero. Acá la presencia de `MONGO_URI`/`REDIS_URL`/`RABBITMQ_URL` ELIGE y `vitest.setup.ts` las
  borra: el container ya arma los adaptadores de memoria. Sustituirlos sería tapar la configuración
  que se quiere ejercitar.
- **El mantenimiento se mueve por `POST /internal/lobby/maintenance`** y no sustituyendo el libro:
  `PolledMaintenanceSignal` se construye UNA vez en `di-container.ts`, así que registrar un token
  después del arranque no llega a ningún lado. Sin base su libro lee `LobbySettings`, que es lo que
  ese endpoint escribe — el e2e recorre entonces la cadena entera.
- **`FREE_2P` se suma a `src/tests/game-mode-catalog.ts`.** Sin `BACKEND_URL` el `canAfford` del
  container contesta `false` siempre, así que toda mesa PAGA se rechaza con `INSUFFICIENT_FUNDS`
  antes de entrar a la cola: un e2e de matchmaking que quiera medir otra cosa necesita un `admit`
  que salga antes de tocar la billetera. Su `isFreeRoom` va EXPLÍCITO — el repositorio no lo deriva
  de `entryFee`.
- **Los dos `.int.test.ts` leen `MONGO_INT_URI`**, no `MONGO_URI`: esa la borra `vitest.setup.ts` a
  propósito, así que leerla los saltearía SIEMPRE, y un test que nunca puede correr se lee como
  cobertura. La lectura vive en `src/tests/int-services.ts`, tercera exclusión de
  `env-single-reader.test.ts`. Se corren con
  `MONGO_INT_URI=mongodb://127.0.0.1:27017/domino_int npm run test:int`.
- **`FakeWallet` y `FakeTournamentClient` viven en `src/tests/`** y no en su feature: `pools.test`
  es de matchmaking y los consume, y `feature-boundary` lo prohíbe. Exportarlos por el `index.ts`
  —que la Regla 4 sí permite— metería dos dobles en la superficie pública.
- **`MemoryLedger` no se duplicó.** Truco lo tiene en `tests/`; acá es un adaptador real del
  despliegue sin Mongo y ya vivía en `transports/`.
- **`PoolSpec.targetScore` se renombró a `pointsToWin`.** Los dos adaptadores escribían
  literalmente `targetScore: table.pointsToWin`: una traducción sin motivo entre dos tipos vecinos.

### ⚠ EL DEFECTO QUE EL PORT DESTAPÓ, y que ninguna suite podía ver

**`startServices()` lo llama SOLO `src/main.ts`**, que es el que CORRE. Los tests levantan la app
por `app.config.ts`, que es el que se IMPORTA — y esa separación existe a propósito para que
ningún test arrastre lo que main registra. O sea que **en la suite entera la cola de matchmaking
nunca tickeaba**.

El modo de falla no es un rojo, es un CUELGUE: el servidor levanta, acepta sockets, crea salas y
contesta `/health` con 200, y nadie se empareja jamás. Lo agrava que el emparejador se suscribe al
interruptor de mantenimiento ADENTRO de `start()`, así que el vaciado de colas tampoco existía.

Se arregla en `bootTestServer` —no en cada archivo, por lo mismo que el modo del catálogo se
siembra en un solo lugar: el que escriba el E2E número veinte no tiene por qué saberlo— y se PINEA
en `src/entrypoint.test.ts`.

**`bootTestServer(port)` sigue pidiendo el puerto** y no lo saca del índice del worker:
`env-single-reader.test.ts` prohíbe que nada bajo `src/` fuera de `env.ts` lea el entorno, y ese
guardarraíl busca la SUBSTRING — así que el comentario que lo explica tampoco puede escribirla. Es
la misma trampa que ya pagó `src/deploy-smoke.test.ts`.

### Deudas abiertas de ESTE incremento — NO CUMPLIDAS

1. **Los archivos portados están comentados en INGLÉS** y el resto del repo en español. Son ~70
   archivos de `matchmaking/`, `tournament/`, `economy/` y media docena de `shared/`. Es cosmético
   y es real: la doctrina de este repo vive en los comentarios, y media base en otro idioma la parte
   en dos. No se tocó por volumen.
2. **`features/lobby/` y `features/matchmaking/` conviven.** El `LobbyRoom` que `app.config.ts`
   registra es el de matchmaking; del viejo sobrevive `LobbySettings` —que es el almacén del
   mantenimiento y lo usa el libro del container— y su `LobbyRoomState`. **El `LobbyRoom` viejo sigue saliendo por el
   `index.ts` de su feature y NO lo importa nadie: es una exportación muerta.** Antes de borrarlo hay que decidir dónde vive la palanca de
   mantenimiento, porque hoy vive ahí al lado.
3. **El smoke real no se volvió a correr.** Pide Docker y no se ejecutó en esta tanda. La identidad plana
   tocó `src/smoke/engine-smoke.ts` —los dos asientos pasaron de compartir `shared-smoke-uuid` en
   dos plataformas a `smoke-ada`/`smoke-lin`, porque el `userId` repetido ya no valida— y eso solo
   lo certifica `npm run smoke:client` contra el compose.
4. **Sigue sin haber orquestador que cobre.** `settlementOf` proyecta y nadie la llama — es lo que
   este incremento difirió a propósito.

## Incremento completo — la revancha

Sin plan escrito: salió de comparar el dominó con truco archivo por archivo y encontrar que la
revancha era el único hueco que **v1 sí tiene** — o sea una regresión, no una feature de truco que
el dominó no necesite. Baseline **1056 → 1070 tests / 109 archivos**, con `typecheck`, suite,
`biome check` y `depcruise` (**358 módulos / 1415 dependencias**) en verde.

Cuatro commits, uno por capa: `1e81564` las reglas, `8512dd1` el motor, `ac2729a` los verbos,
`0a59b23` la red.

**ES POSIBLE RECIÉN AHORA**, y no por casualidad: la revancha necesita CREAR una partida, y eso lo
trajo el `MatchGateway` del incremento anterior. Su propio comentario lo anticipaba — «matchmaking
dejó de ser su único cliente el día que la revancha también abrió partidas».

### Se portó v1, no truco, y las diferencias importan

| | truco | **lo que quedó (v1)** |
|---|---|---|
| verbos | `OFFER_REMATCH` + QUIERO/NO_QUIERO | **`REQUEST_REMATCH` / `RESPOND_REMATCH {accept}`** |
| ventanas | una | **dos: 30 s para pedir, 5 s para contestar** (+ 6 s de traspaso) |
| sin elegibilidad | no hay ventana | **ventana abierta con el botón apagado** |
| el 2º que pide | ilegal | **cuenta como aceptación** |
| anti-abuso | veto al terminar | **`MAX_REMATCHES_PER_CHAIN = 1` + `rematchCount`** |

Las dos últimas son las que más cambian el comportamiento:

- **La ventana se abre aunque no sean elegibles.** Truco argumenta «que nadie vea un botón que no
  puede usar». Acá se abre con `eligible: false` y el front lo pinta apagado, porque «no te
  alcanza» se arregla poniendo saldo y no mostrar nada se lee como que la revancha no existe. Es
  además lo único que hace que `eligible` se gane el lugar en el árbol.
- **El segundo que PIDE durante la negociación está aceptando.** Truco lo declara ilegal porque
  «un verbo no puede significar dos cosas según cuándo llegue». El argumento es bueno y la
  consecuencia es peor: con los dos apretando «Revancha» en el mismo segundo —que es lo que pasa
  cuando los dos la quieren— uno recibe un error y la revancha muere. El doble sentido se paga a
  propósito y se rutea en el CONDUCTOR, no en la regla: es una transición, no una legalidad.

### La forma, en cuatro capas

- **`MatchPhase` ganó TRES fases** —`REMATCH_WINDOW`, `REMATCH_NEGOTIATION`, `REMATCH_ACCEPTED`—
  y el enum ya las esperaba: `rules/phases.ts` decía desde que `RESOLVED` y `FINISHED` se separaron
  que iban «después del veredicto y antes del terminal». La tercera es de v1 y no de truco: el
  front pinta una pantalla propia de «revancha aceptada». Ninguna es terminal.
- **`RematchState` es una RAMA NULA y NO lleva su propia fase.** v1 tiene un `RematchPhase` de
  cuatro valores porque su estado de partida no tiene dónde ponerlos; acá las tres vivas ya están
  en `MatchPhase` y la cuarta —`closed`— es el nodo ausente. Un eje, un campo. Va AL FINAL del
  schema, como `pastMoves`.
- **`acceptedIds` es un arreglo y no un contador**, y no es por el 4P: con dos jugadores el front
  ya necesita distinguir «ya acepté, espero» de «me están preguntando». Que deje el 4P resuelto es
  la consecuencia.
- **La compuerta tiene DOS preguntas.** «Esta mesa ofrece revancha» (el modo) y «estos dos pueden
  jugarla» (saldo, antifraude, cadena) son hechos distintos: colapsarlos dejaría al torneo
  mostrando un botón de revancha apagado, que miente sobre el motivo.
- **La mesa que no está entera no abre ventana**, y lo encontró la suite: `lifecycle.e2e` se colgó
  porque una partida ganada por ABANDONO abría treinta segundos de botón gris. Se vuelve a jugar LA
  MESA, no lo que quedó de ella. Y a diferencia del saldo, ahí no hay nada que el jugador arregle.
- **Las reglas no miran dinero**, y `eligible` ni siquiera está en `RematchView`: una regla que
  quisiera consultarlo no compila.

### ⚠ Cuatro defectos, y quién pudo encontrar cada uno

1. **`canRequestRematch` copiaba `if (match.rematch)` de truco.** Allá el nodo nace cuando alguien
   ofrece; acá nace al ABRIR la ventana, porque es quien lleva `eligible`. Resultado: rechazaba
   TODA solicitud. Se pregunta por el `requesterId`. **Lo encontró el E2E**; el fixture de reglas
   mentía (dejaba el nodo en `undefined` durante la ventana) y el del motor llama al conductor sin
   pasar por el juez.
2. **`SchemaMatchView` no exponía `rematch`, y COMPILÓ**: omitir un campo OPCIONAL sigue
   satisfaciendo la interfaz. Toda regla leía `undefined`. Dejó un guardarraíl en
   `rules/tests/view.test.ts` que compara las CLAVES del árbol contra las de la vista — y el
   fixture INSTANCIA las ramas nulas, porque sin eso el test es decorativo (`toJSON()` omite la
   clave de un `.optional()` ausente; medido).
3. **El E2E corrió en verde con cinco errores de compilación**: `Room.state` del SDK está tipado
   `object`. El gate sigue siendo `typecheck`.
4. **Un test propio que había que borrar**: «no espera al que se retiró» en mesa de cuatro
   fabricaba un estado que la máquina ya no alcanza —después del veredicto nadie se retira— desde
   que existe la regla de la mesa entera.

### ⚠ Lo que el E2E destapó y NO es de la revancha

**La sala tiene DOS caminos de creación con DOS convenciones de identidad**, y los trajo el port
de matchmaking:

- `configOf` (request del orquestador) reparte asientos OPACOS: `seat-1`, `seat-2`.
- `configFromRoomOptions` (el emparejador) usa **el id de cuenta como `playerId`**.

Y **sólo el segundo trae la economía de la mesa**, así que una sala creada por request no engancha
ni el sink de la plataforma ni el de la revancha. El arnés gana `seatPairAsMatchmaking`, que es el
único camino por el que la revancha se puede medir de punta a punta. **Es deuda abierta**: la
doctrina de la identidad opaca («`playerId` es OPACO y posicional») vale para un camino y no para
el otro.

### Deudas abiertas de ESTE incremento — NO CUMPLIDAS

1. ~~El veto se consulta pero no se escribe.~~ **CERRADO** por el bloque de más abajo: resultó ser
   más grande de lo que esta línea decía — no faltaba sólo el veto casual, faltaban los DOS
   productores, y la capa anti-colusión entera era inerte.
2. **Los dos caminos de creación con dos identidades** (arriba). Decidir cuál gana antes de que el
   front dependa de los dos.
3. **El smoke real no corrió.** Pide Docker. La revancha toca el ciclo de vida de la sala, que es
   justo lo que el smoke certifica.
4. **La revancha no re-chequea el saldo al abrir**, a diferencia de truco y de v1. Es deliberado y
   está argumentado en `network/rematch.ts` — la admisión de la mesa nueva rechaza sólo al que no
   puede — pero conviene medirlo el día que haya un backend de verdad contra el que probarlo.

## Corrección — el veto anti-colusión tenía consumidor y no tenía productor

Salió de comparar truco LISTENER POR LISTENER, no de una falla. Baseline **1070 → 1077 tests /
110 archivos**; `typecheck`, suite, lint y `depcruise` (**360 módulos / 1434 dependencias**) en
verde. Commit `0cebfb8`.

**`matchmakingSink` escuchaba `CASUAL_PAIR_VETOED` y `PAIR_VETOED` y llamaba `VetoBook.register`.
Nadie emitía ninguno de los dos.** Los dos listeners que los producen quedaron del otro lado del
port de matchmaking. Los libros se leían y nunca se escribían: `vetoedFor()` devolvía `[]` en cada
consulta, el emparejador no evitaba a nadie jamás, y la capa anti-colusión entera era inerte.

⚠ **NO LO VEÍA NADA, y eso es lo que hay que recordar de este defecto.** Leer un libro vacío es
indistinguible de leer uno que funciona, así que ningún test del consumidor podía fallar; el
productor no existía, así que no había qué testear; y `depcruise` estaba limpio porque el
consumidor compila solo. **Es la forma de defecto que deja un port: el que trae la mitad de una
conversación.** La única manera de encontrarlo fue enumerar los listeners de truco y buscar el
gemelo de cada uno.

Las dos reglas son distintas, y por eso son DOS eventos y no uno con un campo:

| | cuándo veta | alcance |
|---|---|---|
| casual | la partida que cierra **ya era la revancha** (`rematchCount > 0`) | todo el ámbito casual |
| torneo | la partida fue de **baja calidad** (la firma del que se rinde rápido) | **ese** torneo, que viaja en el evento |

Terminar una partida normal **no veta a nadie**: el objetivo no es prohibir que dos se crucen
—el emparejador junta a quien haya— sino desalentar REPETIR. Vetar en la primera le vaciaría el
pozo de rivales a cualquiera que juegue seguido.

Los productores **SOLO EMITEN**: escribir es de matchmaking, que es quien lo lee. Si el productor
pudiera escribir el libro, una partida estaría decidiendo a quién empareja el lobby.

⚠ **Y EL MISMO CABLEADO TENÍA OTRO AGUJERO DE LA MISMA FAMILIA**: `reportStandings` estaba detrás
de `isRegistered("RoomOptions") ? [] : [...]`, o sea que sólo corría en el camino del REQUEST y
nunca en el del emparejador — que es por donde nace toda mesa casual. **Las partidas reales no
llegaban ni al ranking ni a la liga**, sin fallar: un reporte que no sale deja una fila que nadie
escribe. Se arregló en el mismo commit porque es la misma expresión.

**EL TEST QUE FALTABA ES EL DEL CABLEADO Y NO EL DEL PRODUCTOR**, y es la lección transferible: el
defecto era que nadie lo CONSTRUÍA. El E2E juega una mesa nacida con `rematchCount: 1` y lee el
libro del otro lado de la cadena entera —listener → evento → sink → `register`—. Verificado por
mutación: sacando el productor del cableado, ese `it` es el único que se pone rojo.

### Lo que sigue faltando de truco, después de esto

Comparado archivo por archivo y símbolo por símbolo:

- **`reactions`** — deliberado: v1 del dominó no las tiene, sería feature nueva.
- **`bot.ts` / `BotPort`** — deuda escrita; v1 los tiene en 4P.
- ~~`charge-multiplier`~~ — **HECHO**, ver el bloque del final.
- ~~`logSink`~~ y ~~los cinco archivos de test~~ — **HECHOS**, ver el bloque del final.

## Incremento completo — el aumento de apuesta cobra

Salió de preguntar si truco ya lo había hecho: sí, y con implementación completa
(`casual/listeners/charge-multiplier.ts`). Baseline **1077 → 1108 tests / 113 archivos**, con
`typecheck`, suite, lint y `depcruise` (**365 módulos / 1466 dependencias**) en verde.

Tres commits: `30ea0b8` el modelo, `30478e0` el catálogo, `880cea4` el cobro.

### ⚠ El primer paso fue una corrección, no una feature

**`BetLevel` guardaba `additionalEntryFee` y `additionalPrize`, y NINGÚN catálogo puede
llenarlos.** El de v1 (`internal/bet-increase/config`) devuelve `{ level, extra, additionalPoints }`
y no podría traer más: **no sabe cuánto cuesta esta mesa**.

El costo de no verlo era **cobrar cero**: el listener habría leído un campo que nadie llena,
habría cobrado `0` a los dos y habría subido el premio igual — en silencio, sin excepción y sin
un solo test rojo, porque toda la suite armaba sus niveles a mano y los llenaba.

**EL `level` ES EL MULTIPLICADOR DE LA MESA y no un índice.** v1 usa 2, 3 y 5 y calcula
`entryFee * level`; lo que se cobra es la DIFERENCIA. Truco hace lo mismo
(`entryFee * (value - 1)`), así que los dos coincidían y el que estaba mal era este repo.
`betAmountsOf` es una REGLA y vive en `rules/`: el cliente la necesita para mostrar el precio
ANTES de proponer, que es cuando el jugador decide.

### El catálogo de niveles falla CERRADO, al revés que el antifraude

Y la asimetría es deliberada, escrita en los dos lados: el antifraude falla ENCENDIDO —dejar de
vetar es peor que vetar de más— y esto falla hacia el NO porque el `extra` determina PUNTOS DE
RANKING reales, y ofrecer un nivel inventado le entrega al jugador un puntaje que nadie configuró.

- **La cache es POR MODO**, única diferencia con `CachedAntifraudFlag`: con un solo valor, una
  mesa cara ofrecería los niveles de una barata.
- **El fallo también se cachea**: sin eso un backend caído recibiría una llamada por cada mesa
  que nace, que es cuando menos puede contestarlas.
- **El adaptador no atrapa nada**: el fallo tiene que SALIR para que la cache decida. Si devolviera
  `[]` ante un error, el que pueda tirar ese endpoint apagaría la feature sin que nadie lo vea.
- **Una fila mal cargada no deja sin aumentar a la mesa entera** — se filtra — pero NO se
  completa: un nivel sin `extra` se descarta en vez de valer `extra: 0`, que sería un aumento que
  cobra de más y no da un punto. `additionalPoints` sí se completa con cero. Uno es un default, el
  otro es una fila rota.
- **El torneo no pregunta**: la apuesta de una mesa de torneo es del TORNEO. Misma frontera que la
  revancha.

### El motor es síncrono, así que se COMPENSA y no se revierte

Es la decisión que `bet-charge.ts` dejaba abierta —compensar o reservar— y se resolvió como
truco. No hay forma de meter el cobro adentro de `RespondBetMultiplierCommand` sin romper que los
comandos sean síncronos, y eso es lo que impide que dos mensajes del mismo cliente se entrelacen a
mitad de una mutación. El orden queda: **asentar, cobrar, y si falla, un segundo acto que deshace.**

De ahí sale `revokeMultiplier`, la **tercera y última puerta del grafo hacia afuera**. Las otras
dos son la compuerta y el cierre de la revancha, y las tres existen por lo mismo: el mundo es
asíncrono y el juego no.

`MULTIPLIER_AGREED` lleva `level`, `extra`, `additionalEntryFee` y los asientos porque el cuánto
**no está en el payload del comando**: vive en la oferta, que `settle` borra en el mismo acto. Es
el gemelo de `REMATCH_ACCEPTED`.

**Las tres partes del «si no se puede» van juntas**, y cada una tapa algo distinto: en SERIE
(en paralelo no se sabe quién pagó), con PLAZO (una billetera muda deja el trato en el limbo con
la mesa diciendo x5), y al fallar REEMBOLSAR **y** ANULAR. La anulación va siempre, hayan salido o
no los reembolsos. Un reembolso fallido queda ASENTADO y a la vista: deshacer un cobro pide
reconciliación, y reconciliar pide que el registro sobreviva.

`revoke` entra por `sinkFor` y **no por el constructor**: el cobrador es del PROCESO y el motor es
de la MESA. Tomarlo al construir sería darle a todas las partidas el motor de una.

⚠ **DESHACER DEVUELVE EL CUPO**: `acceptedBetLevel` en cero es también lo que lleva el tope de
«uno aceptado por partida», así que tras una anulación se puede volver a proponer. Es correcto
—el aumento que no se pudo cobrar no ocupó el cupo— y está medido.

### ⚠ Lo que falta para verlo en producción es CONFIGURACIÓN, no código

`BACKEND_URL` + `INTERNAL_API_KEY`, y que el panel cargue niveles para el modo. Sin eso el libro
es el de reposo, ninguna mesa ofrece aumentar y este camino no corre — el mismo lado seguro de
antes. **Nada de esto está certificado contra un backend de verdad**: el smoke no lo toca.

### Lo que sigue faltando de truco, después de esto

- **`reactions`** — deliberado: v1 del dominó no las tiene.
- **`bot.ts` / `BotPort`** — deuda escrita; v1 los tiene en 4P.
- ~~`logSink`~~ y ~~los cinco archivos de test~~ — **HECHOS**, ver el bloque de abajo.

## Incremento completo — la traza de cada hecho, y los tests que el port no trajo

Lo último chico que quedaba de truco. Baseline **1108 → 1168 tests / 119 archivos**, con
`typecheck`, suite, lint y `depcruise` (**371 módulos / 1484 dependencias**) en verde.
Commit `9bfa6ae`.

**`logSink` ES UN SINK Y NO LÍNEAS ADENTRO DEL MOTOR**, y eso es todo el diseño. El motor es
dominio puro: no conoce un puerto de salida, y su forma de contar lo que pasó ya existe — devuelve
eventos. Así que la traza entera cuesta un archivo y ni una línea en los comandos, los conductores
o los aspectos. **No sabe de niveles ni pregunta por ninguno**: con el debug apagado la pieza
directamente no se construye, y de eso se ocupa `di-container.ts`, que es el único que lee la
configuración.

⚠ **EL FILTRO ES MÁS ANCHO QUE EL DE TRUCO, y la diferencia es deliberada.** Allá pasan SOLO
escalares, con un argumento de seguridad: las cartas viajan como objetos y un log con las cartas de
una partida en curso convierte el acceso al panel en un vector de trampa. Acá ningún evento lleva
fichas —`PLAY_TILE` es un COMANDO, y el criterio §5.1 es justamente que no haya eventos que repitan
el payload de un comando—, así que el filtro estricto no protegería nada y sí perdería lo único
interesante de cuatro hechos: `playerIds`. **Los objetos siguen afuera POR CONSTRUCCIÓN** y no por
una lista de campos prohibidos que alguien mantenga: el día que un evento del dominó lleve una
ficha, la lleva como objeto y no sale.

Los cinco tests son sobre código que ya estaba vivo, y lo que mide cada uno es lo que no puede
ponerse rojo por sí solo:

| archivo | lo que mide, y por qué ningún otro test lo ve |
|---|---|
| `logger` | el ORDEN de los argumentos. `pino` recibe campos-después-mensaje y nuestra interfaz es al revés; invertirlo NO FALLA, deja `{"msg":"[object Object]"}` — y todo el repo loguea por esta fachada sin mirar lo que sale |
| `retry` | las cuatro formas de SALIR: un rechazo no es una caída, el apagado no espera el backoff, el fallo intermedio avisa y el último avisa que ya no viene otro |
| `trace` | el contrato del cable W3C y las dos formas de romperlo — no continuar una causa que vino, o arrastrar una que ya no corresponde (el `withoutTrace` de la fuga del reloj de la sala) |
| `bearer` | que una falla NUESTRA no se disfrace de 401, y que el chequeo corra ANTES que la forma |
| `internal-key` | la guarda de largo, que **no** es redundante con la comparación constante |

Las dos que conviene no volver a descubrir:

- **Una falla nuestra no es un 401.** Si el verificador revienta por falta del secreto, contestar
  «no autorizado» manda al cliente a borrar una sesión que está bien: un incidente de configuración
  se vuelve todos los jugadores deslogueados. Va a `next(e)`, que lo hace 500.
- **`timingSafeEqual` LANZA con buffers de distinto tamaño**, así que sin el `a.length ===
  b.length` una llave de largo equivocado sale **500 en vez de 401** — o sea que el status le dice
  al que prueba que acertó el largo, justo lo que la comparación constante existe para no filtrar.

⚠ **Y EL QUINTO NO ERA EL QUE TRUCO NOMBRA**: `features/auth/transports/internal-key-guard.ts` era
**CÓDIGO MUERTO**, y se borró. Los tres consumidores —catálogo, lobby, historial— usan
`shared/http/internal-key.ts`, que es otro archivo con otro header. La confusión es de DIRECCIÓN:
`features/auth/internal-key.ts` es la mitad **SALIENTE** —la llave que NOSOTROS presentamos al
backend principal, `x-internal-api-key`, y esa sí está viva vía `internalAuthHeaders`— y el guard
duplicaba la **ENTRANTE** (`X-Internal-Key`) con el nombre equivocado. Testear el muerto habría
dejado cobertura verde sobre una puerta que ninguna ruta usa, que es la peor de las dos opciones.

Tres mutaciones verificadas a mano, cada una roja en el test que dice medirla: sin la guarda de
largo (2 rojos), todo error de verificación como 401 (2 rojos), el token sin recortar (1 rojo).

Una asimetría queda **fijada y no arreglada**: `Authorization: Bearer ` (el esquema pelado) llega
al verificador como `""` y no como `undefined`, porque el prefijo está y la credencial se extrae
vacía. Sale 401 igual. El test lo pinea para que nadie lo "corrija" moviendo a la puerta la
decisión de qué es un token vacío — ahí habría que mantenerla dos veces.

### Lo que sigue faltando de truco, después de esto

- **`reactions`** — deliberado: v1 del dominó no las tiene, sería feature nueva.
- ~~`bot.ts` / `BotPort`~~ — **HECHO**, y no como truco: ver el bloque de abajo.

## Incremento completo — la mesa de cuatro y la máquina que la sostiene

Salió de «porta el bot», y leer los dos repos cambió el alcance antes de escribir una línea.
Baseline **1168 → 1200 tests / 122 archivos**, con `typecheck`, suite, `biome check` y
`depcruise` (**376 módulos / 1515 dependencias**) en verde.

Tres commits, uno por capa: `91796a3` las reglas, `9cf4bfd` el motor, `6bf12e8` la red y las
guardas.

### ⚠ EL BOT DE TRUCO NO EXISTE, Y EL DE v1 ES OTRA COSA

`truco/src/features/match/betaso/bot.ts` son **quince líneas**: un `BotPort.attach(seat)` sin
implementación y sin llamador. Portarlo era escribir una interfaz que nadie llama — justo lo
que este repo prohíbe.

**El bot de verdad está en v1, y no es un jugador que se sienta: es el REEMPLAZO del que se
retira de una mesa de CUATRO.** Hereda su mano, su equipo y su lugar en la rueda. Existe por
una sola razón: en 4P se juega por parejas, así que el que pierde al compañero queda jugando
uno contra dos sin haber hecho nada. En 2P v1 lo **prohíbe explícitamente**
(`game-mode.dto.ts:28-36`): ahí el que queda simplemente gana.

O sea que el bot **no se podía disparar nunca** con el 4P rechazado en `configOf`. Por eso el
alcance real del pedido era abrir la mesa de cuatro, y eso se consultó antes de escribir código.

### ⚠⚠ LA DEUDA DEL 4P ERA FALSA: LA REGLA DE REPARTO EXISTÍA Y ESTABA EN v1

Tres bloques de este documento decían que abrir el 4P exigía **inventar** la regla de cómo se
parte el premio entre compañeros, y que hasta entonces la guarda de `settlementOf` mantenía la
deuda inerte. **La regla estaba escrita y argumentada en v1**
(`domino-room-state.ts:672-678`):

> Cada ganador cobra `prize` **entero** —el premio POR CABEZA del catálogo, no un pozo a
> repartir—. Si un socio abandonó, el que queda cobra **sólo lo suyo** y la otra mitad se queda
> en la casa. v1 lo escribe en el divisor, que es **nominal** (`playersQuantity / 2`) y no por
> cobradores reales: con el divisor real, un abandono le pagaría el pozo entero a uno solo.

Y `settlementOf` ya la implementaba **por construcción**: `winners.map((seat) => entryOf(...,
config.prize, seat))` paga `prize` por asiento ganador. Lo único que lo frenaba era
`winners.length !== 1`.

**La lección es del método, no del 4P**: la deuda se escribió tres veces sin volver a leer v1, y
lo que faltaba no era una decisión de producto sino una lectura. Cuando una deuda diga «hay que
decidir X», el primer paso es buscar si v1 ya lo decidió.

### Las dos reglas que la mesa de cuatro separa

Estaban escritas **por jugador**, y con parejas eso premia al equipo equivocado. En 2P las dos
formas dan lo mismo, así que nada podía ponerse rojo hasta que hubiera cuatro asientos.

| | estaba | es (v1) |
|---|---|---|
| puntos del dominó | todos menos el ganador | **los pips del equipo RIVAL** (`:412-415`) |
| tranca | el jugador con menos pips | **el equipo con menos pips TOTALES** (`:514-534`) |

La primera le sumaba al que dominó los pips de su **propio compañero**; la segunda dejaba que el
mejor de la pareja perdedora ganara la tranca contra una pareja que en total tenía menos.

**NINGUNA LLEVA UNA RAMA POR CANTIDAD DE ASIENTOS**, y es la decisión de esa capa: escritas por
equipo, el 2P es el caso de un equipo de un miembro y sale idéntico. Un `if (players.length ===
4)` habría dejado dos juegos de reglas para el mismo cierre.

⚠ **LA CARA DEL VEREDICTO DE LA TRANCA ES DERIVADA.** Lo que gana es un EQUIPO, pero
`RoundVerdict` viaja con un `winnerId` —lo leen el marcador, el evento y el historial— así que
hay que nombrar a alguien: el del equipo ganador con menos pips, desempatado por asiento. En 2P
es el de siempre, y en 4P es determinista, que es lo que el replay necesita.

### El bot, en tres piezas

- **`PlayerState.isBot`** (AL FINAL del schema, como `pastMoves`). **No se marca
  `hasAbandoned`**, y ésa es la mitad que decide el final: las dos banderas dicen «acá ya no hay
  nadie» y llevan a lados opuestos — con el retiro puesto, `MatchReferee` ve un equipo fuera y
  corona al otro, o sea que la mesa que el bot vino a salvar termina igual por forfeit con una
  máquina jugándola.
- **`rules/bot.ts`** — la política, y **elige entre lo legal en vez de decidir legalidad**: todo
  sale de `availableActionsFor`, la misma consulta que arma la barra de botones del front. Un bot
  con su propia idea de «esto engancha» manda una jugada que el comando rechaza, y ahí el asiento
  queda mudo hasta que vence el reloj — el compañero pierde igual, por un camino que ningún test
  de reglas ve. La elección es la de v1 (la jugable de más pips) y es **deliberadamente boba**:
  el bot está para que la mesa no muera, no para jugar bien. Una política fuerte le daría al que
  perdió a su socio uno mejor que el que se fue, que es el camino a retirarse a propósito.
- **`network/bot-turn.ts`** — el reloj. Es de la RED por lo mismo que el cobro del aumento: los
  comandos son síncronos por contrato y esto tiene que ESPERAR (1500 ms, de v1).

**LAS TRES GUARDAS SON LAS DE v1** (`canSeatBot`): la mesa lo ofrece, la partida está EN JUEGO, y
queda alguien más en su equipo de carne y hueso. La segunda traduce el `isGameValid` de v1 —
durante la ventana de reparto nadie participó todavía, y sentar un bot ahí sostendría una partida
que nunca arrancó, convirtiendo en cobro lo que tiene que ser un reembolso.

⚠ **LA TERCERA ES LA QUE APAGA EL 2P**, y por eso no hay chequeo del tamaño de la mesa: con un
jugador por bando el equipo del que se va queda vacío por construcción. Es la prohibición que v1
declara aparte, saliendo de la regla del equipo en vez de ser un segundo chequeo que la puede
contradecir.

**`retire` VIVE EN UN SOLO LUGAR** (`MatchDriver`), porque los dos caminos que retiran un asiento
—el verbo y el reloj del turno— tienen que dar lo mismo. Es interfaz propia (`Retirement`) y no
un cuarto verbo de `Driver`: el conductor de RONDA también implementa `Driver` y una mano no
decide si la mesa sigue existiendo. Sentar el bot **no llama a `advance`** —el asiento sigue en
la rueda con sus fichas, no hay mano que pueda haberse cerrado— y sí le devuelve el reloj al
turno, porque por el camino del timeout el que hereda viene vencido.

**SE LO EMPUJA, NO SE SUSCRIBE.** El turno cambia sin emitir evento —jugar no es un evento, el
comando ya es el registro— así que la sala pregunta después de cada mutación. **Los dos empujes
hacen falta**: el del mensaje y el del timeout, que es por donde se SIENTA el bot — sin ése, el
bot recién nacido espera un mensaje que en una mesa que lo está esperando a él no llega nunca.

**EL BOT NO ENTRA POR EL ROUTER**: el router es la frontera del CABLE y su handler graba la
fuente `"PLAYER"` por construcción. Una jugada de la máquina es un acto del SISTEMA, y el
historial que alguien va a auditar es justamente el de la partida que alguien abandonó. Es el
segundo llamador que `MoveLog` anticipaba — y `PastMove` **sigue sin `bySystem`**: `isBot` ya
está en el jugador, y repetirlo en cada jugada sería el campo derivado que la doctrina prohíbe.

### ⚠ Tres defectos, y quién pudo encontrar cada uno

1. **Un equipo de puras MÁQUINAS seguía contando como presente.** Se va uno, se le sienta un bot,
   se va su compañero — y como el bot no está marcado como retirado, `hasTeamAbandoned` decía que
   el equipo seguía ahí. La partida continuaba con un bot solo contra dos personas y **podía
   ganarla**: premio para un equipo donde nadie cobra, o sea plata trabada. Es el
   `checkOnlyOneTeam` de v1 filtrando bots. **Lo encontró el test de la capa del motor**, que
   decía medir otra cosa.
2. **Esparcir un nodo del schema devuelve un objeto VACÍO.** La ficha que la política elige sale
   del árbol VIVO —`SchemaMatchView` no copia nada— así que `{ ...move.tile }` mandaba
   `left`/`right` en `undefined` y el comando contestaba `TILE_NOT_IN_HAND` sobre una ficha que
   el bot tenía en la mano. **El modo de falla es cruel**: `JSON.stringify` del MISMO nodo sí
   imprime los números, así que el log muestra la ficha correcta mientras el payload va vacío. Es
   la trampa que `log-sink.ts` ya documentaba en su filtro. **Lo encontró el E2E**, instrumentado.
3. **Un plazo de reflexión más largo que el turno es un bot que nunca juega**: piensa hasta que
   se le vence y lo retiran, y como a un bot ya no se lo reemplaza por otro, ahí sí abandona — la
   mesa se comporta como si los bots no existieran y no falla nada. Se acota a medio turno. Lo
   destapó la suite, que corre con `TURN_TIMEOUT_MS=600` contra los 1500 de v1.

### Los tres invariantes, y cómo están fijados

El producto pide tres cosas, y las tres SALEN de la única guarda de `canSeatBot` —«queda alguien
más en tu equipo, de carne y hueso»— en vez de estar escritas una por una:

1. **UNA SOLA MÁQUINA POR EQUIPO.** El segundo que se va de un bando ya no encuentra compañero a
   quien proteger.
2. **UN EQUIPO DE PURAS MÁQUINAS NO JUEGA.** La partida se cierra en vez de enfrentar a alguien
   contra un bando que no tiene a nadie — que además podría GANARLA, con el premio yendo a un
   equipo donde nadie cobra.
3. **NUNCA MÁQUINAS CONTRA MÁQUINAS.** Se sigue de la 2: para llegar ahí harían falta dos por
   bando, y el segundo de cada bando ya cerró la mesa.

⚠ **ESTÁN MEDIDOS SOBRE LAS 64 SECUENCIAS DE RETIRO POSIBLES**
(`engine/tests/bot-invariants.int.test.ts`), con el invariante comprobado después de CADA paso.
No es cobertura de más: un `it` por caso fija UNA decisión y deja pasar el camino que nadie
pensó, y acá lo que se afirma es un «nunca». Verificado por mutación — permitir un segundo bot en
el mismo equipo pone rojos **54 de los 68**.

**El 2P no cambió en nada**, y eso también está medido: las dos reglas nuevas están escritas por
EQUIPO y un equipo de un miembro da el mismo resultado; `hasTeamAbandoned` filtra bots que en 2P
nunca existen; y `canSeatBot` devuelve `false` por construcción con un jugador por bando. El
golden rebobina, los E2E de dos siguen verdes y el único cambio del árbol es el `isBot` en
`false` de cada asiento.

### Deudas abiertas de ESTE incremento — NO CUMPLIDAS

1. ~~**El 4P no tiene E2E de partida COMPLETA.**~~ **CERRADO**: `tests/game-4p.e2e.test.ts` juega
   una partida de cuatro entera —seis rondas, 180 entradas de historial— y proyecta el premio
   sobre el estado REAL, no sobre uno armado a mano. ⚠ De paso destapó una **aserción
   tautológica**: sumar `round.points` por `winnerTeamId` y compararlo con el marcador no puede
   fallar, porque los dos lados salen del MISMO `RoundVerdict`. Medido — mutar el dominó para que
   vuelva a cobrar la mano del compañero dejaba ese archivo entero en verde. La regla se mide en
   `round-flow.int.test.ts`; lo que el E2E sí puede afirmar es la alineación entre las dos
   mitades del veredicto.
2. **El emparejador no arma mesas de cuatro.** `configFromRoomOptions` deja `enableBots: false`
   porque no recibe el modo entero: el camino del REQUEST sienta las de cuatro y el del
   matchmaking no. Es la deuda de los dos caminos de creación, que sigue abierta.
3. **El smoke real no corrió.** Pide Docker. Este incremento toca el ciclo de vida de la sala y
   el schema, que es lo que el smoke certifica.
4. **La tranca de 4P no tiene E2E.** Está medida como regla y en el motor; llevar una mesa de
   cuatro a una tranca real pide conducir las cuatro manos a mano.

## Actualización — Colyseus core 0.18.15 / colyseus 0.18.7 / sdk 0.18.3 / schema 5.0.33

Baseline **1273 tests / 122 archivos**, con `typecheck`, suite, lint y `depcruise` (**378 módulos /
1523 dependencias**) en verde. De las notas de release, dos tocan este repo y el resto no
(`IdleKickPlugin`, WebTransport, Vite+Nitro, el monitor y uWebSockets no se usan):

- **core 0.18.14: un `onCreate` que lanza ahora DISPONE la sala y corre `onDispose`.** Antes la
  sala quedaba viva y muda, así que `onDispose` nunca veía una mesa a medio armar. Ahora sí, y la
  guarda `this.notifier && !this.hasOutcome()` dejaba pasar una sala cuyo `register` falló (Redis
  caído al nacer): emitía `MATCH_ABORTED` —reembolso, resumen y cooldown— de una mesa donde nadie
  se sentó, y entre el `notifier` y el `hasOutcome` un throw daba `TypeError`. **La guarda es
  `opened`**, que se prende en la última línea de `onCreate`. El reembolso no sacaba plata
  (`refundMatch` revierte sólo lo cobrado, y la inscripción se cobra al ENTRAR), pero es un cierre
  que miente. Medido: el test nuevo de `domino-room.e2e.test.ts` salió rojo antes del arreglo.
- **core 0.18.13: el `onAuth` de instancia corre aunque el static de `@colyseus/auth` haya
  decodificado el token.** La override `static onAuth → true` de las salas SIGUE haciendo falta:
  sin ella, un token que ese decodificador no acepta sale `AUTH_FAILED` genérico en el
  matchmaking, antes de que el `TokenVerifier` diga por qué. Cambió el motivo, no la decisión.

⚠ `@colyseus/core` imprime al registrar `DominoRoom` y los lobbies «onAuth() defined at the
instance level will be ignored» porque tienen los dos `onAuth`. **Es falso** con la override que
devuelve `true`: `callOnAuth` no produce `authData` y el de instancia corre (`Room.mjs:1101-1102`).

## Cómo se ejecuta una tarea

Usá la skill `executing-plans`. El orden de los Steps del plan no es decorativo: es TDD.
Escribir el test, **correrlo y verlo fallar**, recién ahí la implementación. Ver el rojo es
lo que prueba que el test mide algo.

## El gate es `typecheck`, no el verde de vitest

```bash
npm run typecheck   # tsc --noEmit  <- ESTE es el gate
npm test            # vitest run
npm run test:unit  # solo *.test.ts
npm run test:int   # solo *.int.test.ts
npm run test:e2e   # solo *.e2e.test.ts
npm run lint        # biome check src
npm run format      # biome format --write src
```

**Vitest transpila con esbuild, que borra los tipos sin chequearlos.** En la Tarea 9 los 6
tests del historial dieron verde con 7 errores de compilación abiertos. Si cerrás una
tarea mirando solo la suite, el error aparece dos tareas después atribuido a otra cosa.

`npm run lint` falla por formato. Corré `npm run format` antes de commitear o el commit
queda con el lint rojo.

**Si el lint se pone rojo solo, sin que nadie toque una línea**, no es biome: es el
checkout. `core.autocrlf=true` rematerializa en CRLF blobs que están en LF, y el default de
biome es LF, así que el archivo entero cuenta como mal formateado. Lo cierra el
`.gitattributes` con `* text=auto eol=lf` (commit `3c18a2b`) — del lado de git y no de
biome a propósito: fijar `lineEnding: "crlf"` metería CRLF en el repo y rompería el lint de
cualquiera que no esté en Windows.

Antes de cerrar cualquier tarea: `npm run typecheck && npm test && npm run lint`.

## El plan tiene defectos. Corregilos y documentalos

Aparecen en **todas** las tareas: van más de quince. La causa es estructural — el plan se
escribió de corrido, así que cada tarea describe el sistema tal como quedará al final, no
como está a su propia altura.

| Tarea | Defecto | Commit |
|---|---|---|
| 7 | `MatchDriver.advance` con un parámetro contra una interfaz que pide dos | `e2d981f` |
| 8 | El test del decoder contradecía al `.strict()` de su propio `payloads.ts` | `cf2e9b9` |
| 9 | Tests del historial usando `PLAY_TILE`/`PASS`, verbos que llegan en la Tarea 19 | dentro de la Tarea 9 |
| 20 | Los tests esperaban `phase === "PLAYING"` con la mesa tapada; cuelgue de 15 s | `d399f62` |
| 20 | Dos aserciones del historial describían un contrato inexistente | `d399f62` |
| 21 | El grafo del plan no era el que la sala construye (firmas corridas) | `04f169b` |
| 21 | El replay inventaba `startedAt`: `begin()` no emite, el instante no está grabado | `70af3db` |
| 21 | El endpoint interno nacía **sin autorización**, diferida a una tarea inexistente | `fc5e18d` |
| 21 | Seis defectos de código venían escritos en el plan, no de la ejecución | `36eb6c3` |
| 22 | Seis defectos: `revealHands` pedido en prosa y no llamado, `currentTurn` sin `?.`, un `it` leyendo el historial de otro, tres promesas del SDK que 0.18 no cumple, el `unlock()` que no era lo medido, y un `git add` que se comía `vitest.setup.ts` | `d766384`, `f6fdb3d` |
| 23 | Puerto repetido, cuarto argumento inexistente, import faltante, IDs globales, vista medida en servidor y esperas de 20 s que escondían el rojo | `11d20f5` |

Y del plan del incremento activo (`2026-09-14-identidad-multiplataforma-y-smoke-pm2.md`):

| Tarea | Defecto | Commit |
|---|---|---|
| 1 | Seis defectos: la lista `Files:` se olvidaba de `round/tests/round-fixture.ts` y `round/tests/block.test.ts` —que también arman un `DominoMatchConfig` a mano—, `InvalidTokenError` perdía su `reason` en silencio, el snippet de visibilidad leía `Room.state` (tipado `object`) sin el cast, los dos `it.each` no compilaban sin tupla explícita, y `lifecycle-e2e` quedaba con tres `mintToken("<uuid>")` y dos aserciones de ids globales que el plan no nombraba | `b930b75` + el `docs:` siguiente |
| 1 | El séptimo, de la revisión: el snippet del Step 6 leía `payload.platformId` sin estrechar `string \| jwt.JwtPayload` (TS2339) y lanzaba `new InvalidTokenError()` sin argumento contra la firma que ese mismo Step dice conservar (TS2554) | el `fix:` de la revisión |
| 1 | Y el octavo, encontrado al escribir el test que pinea el cableado: desde que `configOf` valida, `onCreate` puede lanzar ANTES de que `this.log` exista, así que `crash()` moría con «Cannot read properties of undefined (reading 'error')» en vez de nombrar el campo inválido — y después lanzaba otra vez adentro del manejador, porque Colyseus rechaza `disconnect()` durante `onCreate` | el `fix:` de la revisión |
| 2 | Uno solo, y del lado del TEST: el `it` «rechaza un ganador imposible» solo armaba el caso de CERO ganadores, así que con el guard mutado a `winners.length === 0` los tres tests seguían verdes mientras el 4P —que `configOf` ya acepta— pagaba el premio entero a cada ganador. Se descubrió mutando el guard a mano; el cuarto `it` es el que mide esa rama | `8239ca1` + el `docs:` siguiente |
| 2 | Y los de la revisión, todos por lo mismo —el plan trata al tercer parámetro como si no pudiera estar mal—: `settlementOf(evento, estadoDeOtraMesa, config)` no da 0 ni 2 ganadores sino **exactamente 1**, porque los `seat-N` son posicionales, y paga una instrucción impecable a quien no jugó; el `if (type !== "MATCH_RESOLVED")` de salida acepta en silencio cualquier evento de plata futuro; el `objectContaining` del `REFUND` dejaba pasar el `kind` cambiado a `"REWARD"` (medido: suite verde); los tres `AbortReason` y el reembolso de cuatro entradas no los medía nadie; y la superficie exportaba la función sin los tipos de sus parámetros | `a55fa53` + este `docs:` |
| 3 | La revisión le encontró dos: el smoke importaba `settlementOf` con un import PROFUNDO (`network/settlement.js`), salteándose la superficie que la Task 2 acaba de construir —y `depcruise` no lo ve, porque `feature-boundary` solo mira aristas que SALEN de `src/features/`, y el smoke no vive ahí—; y `assertSettlements` recalculaba la `idempotencyKey` con el mismo `JSON.stringify` del código bajo prueba, o sea una aserción tautológica que acompañaría cualquier cambio de formato sin ponerse roja | `60d7c19` |
| 3 | El tercero apareció al empezar a ejecutarla: `settlementOf` compara la identidad privada del estado con el snapshot, pero el plan le pasaba `room.state`, que viene del SDK y **no puede** traer `platformId`/`userUuid` porque son `noSync()`. El smoke ahora toma ganador/equipos del deploy y reconstruye localmente solo el snapshot privado antes de proyectar; hacer sincronizables esos campos para satisfacer el test rompería la barrera de privacidad que la Task 1 vino a crear | `60d7c19` |
| 3/4 | El smoke real reveló dos falsos verdes conectados: tomaba el turno de la vista A y decidía con la vista del dueño sin esperar que alcanzara el mismo patch, por lo que mandó `DRAW_TILE`, recibió `MUST_PLAY_INSTEAD_OF_DRAWING` y dejó que venciera el turno; después aceptó `ABANDONMENT` como desenlace válido y salió 0. Ahora sincroniza ambas firmas antes de actuar y exige `SCORE`: un bot retirado ya no certifica el engine | `6a10918` |
| 3/4 | La primera corrección sí volvió rojo el falso verde, pero no evitó el comando: `signatureOf` comparaba la **cantidad** de fichas del tablero y no sus valores, justo los extremos que `nextAction` necesita. Dos vistas con igual largo y distinto último patch seguían pareciendo sincronizadas. La firma ahora incluye `placed.tile.{left,right}` y `placed.side` de todo el tablero público; el primer parche intentó leer `left/right` directamente de `PlacedTile`, campos que no existen, y una corrida instrumentada lo mostró como objetos con sólo `side` | `82706dd`, `4119278` |
| 4 | El smoke finalmente aisló un agujero anterior del engine: revelar `hand.tiles` no hace visibles para siempre las referencias que se agreguen después. Al robar, `tileCount` subía pero el dueño no recibía la ficha nueva; el servidor sí la veía y rechazaba el siguiente `DRAW_TILE` con `MUST_PLAY_INSTEAD_OF_DRAWING`. `RoundPlayer.drawTile` debe publicar cada ficha robada sólo a su dueño; un unit test mide la llamada y el smoke real mide el wire | `cc9125f` |
| 4 | El contrato estático del wrapper copiaba literalmente `process.env.RUN_ENGINE_SMOKE` dentro de `src/deploy-smoke.test.ts`. El gate completo lo identificó como lector directo porque `env-single-reader.test.ts` busca esa substring en todo `src/`; el test sólo inspecciona texto de `scripts/`, así que ahora construye `process.env` por partes sin abrir una excepción al guardarraíl | `e900c0a` |

Y del plan del catálogo de modos (`2026-09-15-catalogo-modos-v1-y-outbox-rabbitmq.md`):

| Tarea | Defecto | Commit |
|---|---|---|
| 9 | Cinco: el snippet del Step 3 escribía los montos `finite().nonnegative()` **sin el techo** que la Tarea 1 acababa de poner en `configOf` (`2 ** 53` volvía a ser una inscripción válida); «el update usa `.partial()` sin aplicar defaults» es **imposible en zod 4** —`.partial()` los deja vivos, medido— y produce un `PUT` parcial que reescribe con valores de fábrica lo que no viajó; `.transform(Number)` devuelve `number` y no `2 \| 4`, así que el snippet no compila contra la entidad y el gate es `typecheck`; el Step 4 llama `syncAll()` **sin el `batchId`** que la Tarea 8 exige y sin decir que va uno por request; y el orden de rutas que el Step 1 declara load-bearing **no lo es** con estos paths (medido contra express 5.2: `/:uuid` matchea un solo segmento), así que el test que lo mide tiene que ser el de la lista de registros y no un request | `dd16258` + este `docs:` |
| 8 | Tres: la Tarea 3 declaró **tres** errores y «repetir delete/reactivate devuelve el error específico» no tiene con qué expresarse —v1 lanza «El modo ya está inactivo»/«ya está activo» (`game-mode.service.ts:148-150`, `:203-205`) y ninguno de los tres sirve: `NotFound` diría 404 sobre un modo que el panel está listando y `Duplicate` comparte el código pero no la causa—, así que la lista `Files:` tampoco tenía dónde poner el cuarto; «con lease en memoria» y «si el lease no se obtiene» son **mutuamente insatisfacibles** (`MemoryLease` es pasa-manos y nunca devuelve `undefined`), el mismo defecto que ya se había pagado en la Tarea 7; y el Step 3 da por hecho que `lease.within` serializa las mutaciones cuando **excluye procesos y no llamadas**, o sea que la regla de unicidad queda sin proteger contra dos `POST` a la misma instancia | `bed7e88` + este `docs:` |
| 7 | Y el tercero, que lo encontró la revisión y es el más caro del incremento: **la corrección del segundo estuvo mal**. `revisionKeysOf` devolvía las dos claves SIEMPRE, y como la del `created` no lleva revisión y no hay TTL, existe para siempre: el modo daba «cubierto» en la v1, la v5 y la v50, o sea **el reconciliador apagado para todos los modos que crea el panel**. Sobre-corregir un defecto real es su propio defecto. El `created` sólo cuenta en la revisión cero. Ningún test lo vio porque ninguno combinaba un `created` con una revisión posterior: el hueco tenía la forma exacta del bug | `cf8fe11` + este `docs:` |
| 7 | Dos: la lista `Files:` no tenía dónde poner el contrato COMPARTIDO de los dos adaptadores ni el test del de memoria —el mismo defecto que la Tarea 4, y `MemoryGameModeOutbox` tampoco es un doble—; y el Step 3 declaraba la clave de `ensureUpdated` y la de `sync` pero **no la de `enqueueCreated` ni contra qué compara `reconcile`**. La lectura ingenua («reconcile llama a `ensureUpdated`») le agrega un `updated` espurio a TODA alta del panel en el primer tick posterior, para siempre, y nada falla | `1f03cd7` + este `docs:` |
| 6 | Tres, y los tres del «portar de truco» contra la `amqplib` 2.0.1 instalada: reconectar entero al soltar el canal abandona un `RecoveringChannelModel` que sigue reintentando para siempre (un zombi por caída del broker); nadie escucha `error` en la CONEXIÓN, y un `error` sin oyente **tumba el proceso** en Node; y `close()` no espera el intento en vuelo, así que un apagado durante una entrega deja el socket abriéndose después del cierre. El Step 2 tampoco pedía que los dobles fueran `EventEmitter` de verdad, que es lo único que pone roja la segunda | `3be878f` + este `docs:` |
| 5 | Uno, y de los que se cobran dos tareas después: falta el lease DE MEMORIA y no tiene archivo. La Tarea 8 pide "repositorio/outbox/lease en memoria" y la 11 "registrar repository/outbox/lease de memoria sin URI", pero ninguna de las dos crea un archivo donde pueda vivir y la lista `Files:` de la 5 tiene dos. Va junto al puerto en `src/shared/mongo-lease.ts`, por el criterio de `src/shared/kv.ts` | `348f527` + este `docs:` |
| 4 | Tres: la lista `Files:` no tenía dónde poner el contrato COMPARTIDO de los dos adaptadores, y cuatro archivos sueltos producen justo la deriva que el propio Step 3 dice evitar (`MemoryGameModeRepository` no es un doble); el snippet de los índices los asertaba como pares `[clave, opciones]`, que es la forma de `createIndex` y no la de `createIndexes`, que el mismo Step pide; y «update que no borra campos omitidos» no alcanza —medido por mutación: un `$set: { ...input }` crudo pasa verde, y la forma que de verdad llega desde las rutas de v1 es el `undefined` EXPLÍCITO— | `ce54f9e` + este `docs:` |
| 3 | Uno, y de los que rompen en silencio del OTRO lado: ni el plan ni la spec decían si el `id` del payload Rabbit es el `uuid` o el hex del `_id` —la entidad tiene los dos y §9.1 sólo declara `id: string`—. Lo resolvió el v1 productivo (`game-mode.publisher.ts:43`, `id: mode.uuid`), no el nombre del campo. El fixture del test lleva los dos identificadores distintos para que la aserción mida el mapeo | `ec63d71` + este `docs:` |
| 1 | Tres: el Step 4 regeneraba el golden con `replay.int.test.ts`, que solo LO LEE —el único llamador de `writeGolden` es `game-2p.e2e.test.ts`—, así que `WRITE_GOLDEN=1` no escribía nada y el fixture quedaba sin compilar con vitest en verde; la lista `Files:` se olvidaba de cinco archivos que también arman un `DominoRoomOptions` a mano (`match-registry.test.ts`, `replay.int.test.ts` del match, `history.test.ts`, `domino-room.e2e.test.ts`, `lobby.e2e.test.ts`) y del `README.md`; y el `ucAmount` del snippet dejaba `2 ** 53` como monto válido, porque `.safe()` —como estaba expresada la guarda vieja— implica entero en zod 4 y no se puede reusar | `ca9e68a` + este `docs:` |

Esperá encontrarlo otra vez. Cuatro formas concretas que ya se repitieron:

- **La mesa arranca TAPADA.** `configOf` enciende `isDealWindowEnabled` en toda mesa, la
  ronda nace en `DEALING` y las manos están ocultas hasta que cada jugador manda
  `REVEAL_TILES`. Los tests del plan que esperan `phase === "PLAYING"` y después leen fichas
  esperan hasta `dealingTimeoutMs` y el sistema retira a los dos. En E2E sale del entorno
  y vale 800 ms; usá `revealHands` del arnés cuando el test necesita una ronda en juego.
- **Un TODO diferido a una tarea que no existe es un defecto, no una nota.** El endpoint del
  historial nacía con el comentario "detrás de la API key interna cuando exista": nadie iba a
  cobrar ese TODO. Si el plan difiere una decisión de seguridad, resolvela en la tarea.
- **El plan describe las APIs de terceros de memoria.** En la Tarea 22, cuatro afirmaciones seguidas
  sobre `@colyseus/sdk` 0.18 eran falsas (`await leave(false)` resoluble, `onReconnect` disparando con
  los defaults, `FAILED_TO_RECONNECT` llegando por cerrar el socket, y `room.hasJoined`). El
  `node_modules` es la fuente: `build/*.d.ts` para las firmas y `build/*.mjs` para el comportamiento.
  Leelo ANTES de escribir el test, no cuando falle.
- **Si tocás `GlobalDominoConfig`, regenerá el fixture golden.** `replay()` lo recibe entero, así
  que un campo nuevo deja `golden-2p.json` sin compilar — y vitest sigue verde.
  `WRITE_GOLDEN=1 npx vitest run src/features/match/tests/game-2p.e2e.test.ts`.

El catálogo de verbos **crece de a uno** (`CommandPayloads`
en `src/features/match/core/command.ts`). Si un test del plan
nombra un verbo que todavía no está, reescribilo con el vocabulario de la altura — no
adelantes el catálogo para que el test compile.

**La convención**: corregís, y el parche al archivo del plan va en un commit aparte
`docs:` que explica qué estaba mal y cómo se descubrió. El plan es un documento vivo; si
lo dejás mentir, la próxima tarea arranca del mismo pozo.

## Las seis reglas de imports

Todas menos la quinta las aplica `.dependency-cruiser.cjs`, y todas las testea
`src/architecture.test.ts`; la quinta la aplica solo el test, porque depcruise resuelve los alias
antes de mirar el grafo. No son guía de estilo: el test se pone rojo.

1. **core-allowlist** — `features/X/core/` solo importa de `features/X/core/` y de
   `shared/`. Es allowlist. Lo de afuera (`network/`, `transports/`) sí puede importar
   `core/`; la restricción es solo saliente.
2. **core-no-runtime** — el core no importa paquetes de runtime. Excepción única:
   `@colyseus/schema`, porque el estado ES el Schema.
3. **tsyringe-only-in-roots** + **di-container-only-in-roots** — son DOS reglas porque hay
   dos puertas: importar el paquete `tsyringe`, y importar `rootContainer` de
   `src/di-container.ts`. La segunda es la que se usa de verdad, y durante tres tareas no
   estaba escrita: depcruise evalúa ARISTAS, no alcanzabilidad, así que la condición sobre
   `^node_modules/tsyringe/` miraba un camino que nadie toma y el test daba verde sobre una
   violación viva (`fdd99b6`). Composition roots: `src/di-container.ts`,
   `src/app.config.ts`, `src/replay.ts`, `.../colyseus/domino-room.ts` y
   `.../colyseus/commands/di-wiring.ts`. Los tests quedan afuera por categoría
   (`*.test.ts`, `/tests/`), con el argumento en el comentario del config.
4. **feature-boundary** — una feature importa de otra solo vía su `index.ts`.
5. **`@/` al salir del módulo** — un import que sale de su módulo se escribe `@/...`, nunca
   trepando con `../`. Adentro del módulo se usa relativo, y eso es lo correcto: son cortos y
   sobreviven a que el módulo entero se mueva. **El módulo es la FEATURE**, no el directorio —
   adentro de `features/match/` todo es relativo—; para lo de afuera de `features/` el módulo es
   el directorio de primer nivel (`shared/`, `smoke/`), y para los archivos de la raíz de `src/`
   sus vecinos son relativos y todo lo demás lleva alias.

   No es cosmética, y es la misma razón que sostiene a las otras cuatro: `../../../../` no dice
   de dónde a dónde va la arista. El alias marca la SALIDA, así que "este archivo cruza una
   frontera" se lee de un vistazo en vez de contando puntos. **DEPCRUISE NO PUEDE APLICARLA**:
   resuelve los alias ANTES de mirar el grafo, así que para él las dos formas del mismo import
   son la misma arista, y la forma del especificador solo se ve leyendo el archivo — el mismo
   motivo por el que el guard del validador HTTP tampoco tiene depcruise detrás.

   El alias se declara **dos veces y necesita una tercera cosa**, y las tres las pinea
   `src/entrypoint.test.ts`, que es donde ya viven los contratos escritos en N lugares que no se
   leen entre sí:

   1. el `paths` del `tsconfig.json` — de ahí lo leen `tsc`, `tsup`/esbuild, `depcruise` (por su
      `options.tsConfig`) y **`tsx`**, o sea `dev`, `replay` y los dos smokes;
   2. el `resolve.alias` de `vitest.config.ts` — Vite NO mira el tsconfig, y sin esa línea el
      typecheck queda verde y la suite entera no resuelve un solo import;
   3. **el `tsconfig.json` ADENTRO de la imagen del smoke**, que no es una declaración sino un
      archivo presente: `smoke:client` corre con `tsx` en el contenedor. Lo trae el `COPY . .` de
      la etapa `build`, y `smoke-client` deriva de ella. Derivarla de `runtime` para adelgazarla
      —ahí solo hay `dist/` y `package*.json`— da un `ERR_MODULE_NOT_FOUND: Cannot find package
      '@/features'` que no dice que falta un archivo de configuración. Es la única de las tres que
      no avisa en ninguna herramienta local; medido forzando un tsconfig sin `paths`.

   **Y SIN EXTENSIÓN**, como truco. El repo nació con `moduleResolution: NodeNext` y `.js` en cada
   especificador, y eso compraba UNA propiedad concreta: el árbol que emitía `tsc` a secas corría
   en Node sin bundler —medido, corría—. **El alias la rompió**, y no por descuido: TypeScript
   NUNCA reescribe los `paths`, así que el emit quedaba con 23 archivos pidiendo
   `"@/features/game-mode/index.js"`, que Node no resuelve. Con la propiedad ya perdida, el `.js`
   no compraba nada: lo único que resuelve el árbol es `tsup` o `tsx`, y los dos hacen legal el
   import sin extensión. Así que se fue a `moduleResolution: "Bundler"` + `module: "ESNext"` +
   `noEmit: true` —el emit ya no sirve y decirlo evita que alguien despliegue uno roto—, con
   `resolveJsonModule` para el golden.

   ⚠ **SI ALGÚN DÍA HAY QUE VOLVER A CORRER SIN BUNDLER**, el camino es al revés y completo:
   `NodeNext`, `.js` en todos los especificadores **y sacar el alias**, o reescribirlo en el emit
   con una herramienta aparte. Las dos mitades van juntas; quedarse con el alias y las extensiones
   —que es donde estuvo este repo un commit— es pagar el precio de las dos y no tener ninguna de
   las dos propiedades.

6. **`core/rules/` es un paquete** — son DOS reglas (`rules-self-contained`, `rules-no-colyseus`)
   porque son dos grietas distintas, y las dos sostienen lo que `rules/index.ts` afirma en voz
   alta: que algún día viaje en un paquete que el cliente también consuma.

   No importa NADA de afuera de sí misma, ni siquiera de `core/`. La grieta ya existió:
   `PlayerId`/`TeamId` vivían en `core/ids.ts`, así que "el paquete" era esta carpeta MÁS un
   archivo suelto de otra — o sea una carpeta con una nota al pie. Se mudaron a `rules/ids.ts` y
   `core/ids.ts` los re-exporta.

   Y no conoce Colyseus, **ni su schema**, que es la mitad que `core-no-runtime` NO cubre: esa
   regla concede `@colyseus/schema` como excepción única para todo el core, porque el estado ES el
   Schema. Las reglas no son el estado: reciben una VISTA que el nodo satisface por estructura
   (`rules/view.ts`), así que un import del schema acá sería la vista dejando de ser una vista.

   Los tests quedan afuera de las dos (`pathNot: "/tests/"`): `rules/tests/view.test.ts` mide
   justamente la frontera contra el árbol de verdad, así que tiene que poder construirlo.

Más `no-circular`, que no es regla de imports sino invariante del grafo.

## Doctrinas que vuelven en cada tarea

- **Sin campos derivados, con un criterio escrito.** Si se calcula de otro dato, es
  consulta pura del módulo dueño. Se guarda SOLO cuando el cliente no puede derivarlo:
  porque su fuente está gateada (`Hand.tileCount`, `BoneyardState.count`) o porque
  derivarlo exigiría reimplementar una regla (`Hand.isRevealed`). El caso canónico del
  criterio es `PlacedTile`, que **no** lleva `lockedNumber` — ver el comentario en
  `src/features/match/core/state/tile.ts`.
- **Ramas nulas.** Un nodo ausente codifica un caso; presente-y-vacío codifica otro
  distinto. `RoundState.boneyard` ausente = este modo no tiene pozo (4P); presente y vacío
  diría "pozo agotado", que es justo donde la tranca se calcula distinto.
- **Schema ancho, uniones angostas.** Colyseus no sincroniza uniones discriminadas, así
  que `phase`/`side`/`reason` son `t.string()` en el árbol. El cast vive en UN archivo,
  `core/engine/state-projections.ts` (`sideOf`, `roundPhaseOf`, `matchPhaseOf`), y de ahí
  para adentro el motor compara contra uniones cerradas.
- **Un evento existe ⟺ no hubo comando detrás.** Si el payload del evento solo repetiría
  el del comando, no es un evento. Por eso `ABANDON` aparece como evento (el retiro por
  timeout, que nadie pidió) y no como eco del verbo voluntario.
- **Los comandos se tipan contra interfaces, no contra clases concretas.** Un comando
  tipado contra `MatchDriver` puede alcanzar miembros que la interfaz `Driver` no expone;
  tipado contra la interfaz no puede, por construcción.
- **Plata de por medio.** Es un juego con dinero real. Un caso no cubierto no es un bug de
  estilo: es plata que sale. Cuando dudes entre rechazar y ignorar en silencio, rechazá.

## Commits

En español, imperativo, con el tipo convencional (`feat`/`fix`/`test`/`docs`/`refactor`) y
alcance. El cuerpo explica **por qué**, y sobre todo **qué se rompe si se hace al revés** —
mirá `git log` para el tono. Terminan con:

```
Co-Authored-By: <tu modelo> <noreply@anthropic.com>
```

Un commit por tarea del plan, más los `docs:` de los defectos que encuentres.

## Herramientas

`codebase-memory-mcp` está configurado: usá `search_graph` / `trace_path` /
`get_code_snippet` antes que grep para descubrir código. Reindexá con
`index_repository` después de agregar archivos.
