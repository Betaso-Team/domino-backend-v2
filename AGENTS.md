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
(`validated` en `features/match/transports/http/`, gemelo del decoder del wire).

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

**Baseline actual: 320 tests / 48 archivos.**

## Incremento activo — identidad multiplataforma y smoke real

Autoridad operativa:
`docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md`.
Diseño aprobado:
`docs/superpowers/specs/2026-09-14-identidad-multiplataforma-y-smoke-pm2-design.md`.

Estado: **Tareas 1–3 completas y revisadas** (`b930b75`…`ce8a895` la 1; `d3617cb`, `8239ca1`,
`0339dca`, `a55fa53`, `ceb6957` la 2; `60d7c19` y el commit siguiente la 3); baseline
**360 tests / 51 archivos**; siguiente: **Task 4, Step 1** —levantar el artefacto bajo PM2 y Nginx
en Docker y ejecutar ahí el cliente smoke completo—.
La identidad externa pasa a ser `{ platformId, userUuid }`; `currency` es la moneda ya cobrada y
queda congelada, y toda recompensa/reembolso usa el `rateId` único de la mesa. Los montos
`*UcMinor` son enteros seguros: los dos últimos dígitos son decimales (`1234 = 12,34 UC`).

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
  `entryFeeUcMinor` a todos los asientos, `MATCH_RESOLVED` → `REWARD` de `prizeUcMinor` al
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
  que importar de `features/match/index.js`**, no de `network/settlement.js`.
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
2. **El 4P no tiene regla de reparto del premio.** `configOf` acepta cuatro participantes y
   `settlementOf` lanza contra cualquier final de mesa de cuatro. Hoy es inofensivo porque nadie
   liquida; con el orquestador puesto, ese throw cae DESPUÉS del veredicto y la mesa se queda sin
   premio (tiró) y sin reembolso (hubo desenlace): **plata trabada**. Escrito en tres lugares a
   propósito —`configOf`, `network/settlement.ts` y el Criterio de cierre del plan—, porque el que
   abra el 4P va a llegar por cualquiera de los tres. Empieza por la regla, no por borrar la guarda.
3. **No existe el orquestador que cobre.** `settlementOf` es una proyección pura y exportada, y
   nadie la llama todavía fuera de su test: no hay puerto de wallet, ni adaptador remoto, ni
   outbox, **y es deliberado** (el plan lo dice en su Mapa de archivos). Diseñar el puerto sin un
   consumidor es diseñarlo dos veces. Lo que falta para que el dinero se mueva de verdad —entrega
   al menos una vez, reintentos, quién persiste la instrucción— **no está resuelto en ningún
   lado**: es el incremento siguiente, no una omisión de éste.

## Cómo se ejecuta una tarea

Usá la skill `executing-plans`. El orden de los Steps del plan no es decorativo: es TDD.
Escribir el test, **correrlo y verlo fallar**, recién ahí la implementación. Ver el rojo es
lo que prueba que el test mide algo.

## El gate es `typecheck`, no el verde de vitest

```bash
npm run typecheck   # tsc --noEmit  <- ESTE es el gate
npm test            # vitest run
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
  `WRITE_GOLDEN=1 npx vitest run src/features/match/tests/game-2p-e2e.test.ts`.

El catálogo de verbos **crece de a uno** (`CommandPayloads`
en `src/features/match/core/command.ts`). Si un test del plan
nombra un verbo que todavía no está, reescribilo con el vocabulario de la altura — no
adelantes el catálogo para que el test compile.

**La convención**: corregís, y el parche al archivo del plan va en un commit aparte
`docs:` que explica qué estaba mal y cómo se descubrió. El plan es un documento vivo; si
lo dejás mentir, la próxima tarea arranca del mismo pozo.

## Las cuatro reglas de imports

Las aplica `.dependency-cruiser.cjs` y las testea `src/architecture.test.ts`. No son
guía de estilo: el test se pone rojo.

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
