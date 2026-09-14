# AGENTS.md — domino-backend-v2

Backend de dominó multijugador sobre Colyseus 0.18. Es un **port de la arquitectura de
truco** (`truco-backend-v2`), no un rediseño: cuando algo no cierra, la respuesta suele
estar en cómo lo resolvió truco.

## El plan es la autoridad

`docs/superpowers/plans/2026-09-09-domino-v2-esqueleto-y-juego-2p.md` — 23 tareas, cada
una con sus Steps, su código y sus tests escritos. **No improvises el diseño**: el plan ya
decidió, y las decisiones están argumentadas en los comentarios del propio código.

Los otros dos documentos:

- `docs/superpowers/specs/2026-09-09-domino-v2-port-arquitectura-truco-design.md` — el
  porqué de cada decisión. Lo que el plan ejecuta, esto lo justifica.
- `docs/reglas-de-juego-v1.md` — las reglas del dominó **y** la anatomía del v1, con
  referencias a archivo:línea del backend viejo. Es la fuente cuando hay que saber qué
  hacía el sistema anterior.

**Estado: Tareas 0–22 hechas. La próxima es la 23.** Para confirmarlo, `git log --oneline`.
**Deuda abierta**: la Tarea 22 dejó UN criterio sin cumplir —el `unlock()` de `onDrop` no tiene
test y es inalcanzable bajo el `maxClients` de hoy—. Está en el recuadro ⛔ del encabezado de esa
tarea en el plan, con la condición exacta que lo vuelve a activar. **Si tocás `maxClients`, leelo.**
Esta línea se quedó stale doce tareas seguidas: **actualizala al cerrar la tuya**, o el que
sigue arranca desorientado.

## Traspaso abierto — leé esto ANTES de arrancar la Tarea 23

Las Tareas 20, 21 y 22 se ejecutaron con un ciclo de dos revisiones por tarea: primero
cumplimiento de spec, después calidad de código. **La 20 y la 21 cerraron las dos. La 22
tiene la revisión de calidad hecha pero SIN APLICAR** — el ciclo se cortó ahí.

Nada está roto: `f8b1882`, árbol limpio, typecheck limpio, **249 tests verdes**. Lo que sigue
es deuda conocida, no sorpresas.

### Lo pendiente de la Tarea 22 (aplicalo antes de la 23)

Los dos primeros tocan el arnés compartido, así que la Tarea 23 los hereda si no se arreglan:

1. **`e2e-harness.ts:94-96` miente.** El comentario de `rejoinAs` todavía dice que ese test
   *"verifica que el `unlock()` de `onDrop` funciona"*. Es exactamente la afirmación que la
   Tarea 22 desmontó en `reconnection-e2e.test.ts`, en `domino-room.ts` y en tres commits.
   Lo que sostiene el `joinById` es `maxClients = seats.length * 2`, no el `unlock()`.
   Reescribilo: es el archivo que la 23 importa primero.
2. **`clientOf` duplicado** entre `concurrency-e2e.test.ts:43-44` y
   `reconnection-e2e.test.ts:148-152`, y sin usar en `concurrency-e2e.test.ts:93,103` —
   justo donde el comentario de `:40-42` lo exige. Subilo al arnés junto con `turnHolderOf`
   (`:132-136`), que duplica la guarda de `visibility.smoke.test.ts:91-92`. Si no, la 23 lo
   clona una tercera vez.
3. **`concurrency-e2e.test.ts:79` puede parpadear.** `phaseAtBurst` compara contra una
   ventana de 120 ms observada por un poll de 10 ms; si el worker se traba más que eso, la
   aserción se pone roja sin que nada esté mal. Acumulá las fases en un `seen: string[]`
   desde antes del `ABANDON` y afirmá `toContain("PRESENTING_MATCH")`.
4. **Colisión de matchIds**: `c1/c2` y `k1/k2` generan `m-c1-c2` y `m-k1-k2`, los mismos que
   `lifecycle-e2e.test.ts:119` y `:179`. Hoy no chocan solo por el aislamiento de módulos de
   vitest; un `isolate: false` futuro mezcla los historiales. Prefijos propios por suite.

Menores: el `out += " "` de `architecture.test.ts:166,175` es **load-bearing** (sin ese
espacio `x/*c*/async` se fusiona en `xasync` y escapa del `\basync\b`) y no está comentado;
el stripper vive dentro del `it` en vez de a nivel de módulo; `domino-room.ts:48` tiene la
tercera copia del `120` (usá `DEFAULT_GLOBAL_CONFIG.reconnectionWindowSeconds`);
`architecture.test.ts:118` hace `await import("node:fs")` con el import estático ya arriba;
los dos `it` de `concurrency-e2e.test.ts:109,118` son `async` sin `await`; `onMessage` sin
tipar en `:47,93`; y el reparto de puertos (2585-2589) no está registrado en ningún lado.

### Defectos de la Tarea 23 ya detectados, sin arreglar

Los vi leyendo el plan, antes de ejecutarla:

- **Colisión de puerto**: pide 2588, que la Tarea 22 ya tomó para `concurrency-e2e`. Usá 2590.
- **`seatPair(server, seats, undefined, { skipDealWindow: true })`** — ese cuarto parámetro
  no existe en el arnés, y el nombre está al revés: estos tests **quieren** la ventana de
  reparto, no saltearla. La ventana ya viene encendida por `configOf`.
- **`historyOf` se usa en el último test pero falta en el import** (el plan lo aclara en
  prosa debajo del bloque, no en el código).
- **`git add src` se come `vitest.setup.ts`**, que está en la raíz. Es el mismo defecto que
  la Tarea 22 ya documentó.

Y verificá que existan de verdad antes de escribir el test: `hasSeenTiles`, `abortReason()`,
y `MATCH_ABORTED { reason: "NEVER_PLAYED" }`. El Step 2 agrega `DEALING_TIMEOUT_MS` a `env.ts`
—hoy está hardcodeado en 15 s y **no** es overridable—, así que tocás `GlobalDominoConfig`:
**regenerá el golden** (ver abajo).

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
| 22 | Seis defectos: `revealHands` pedido en prosa y no llamado, `currentTurn` sin `?.`, un `it` leyendo el historial de otro, tres promesas del SDK que 0.18 no cumple, el `unlock()` que no era lo medido, y un `git add` que se comía `vitest.setup.ts` | (ver abajo) |

Esperá encontrarlo otra vez. Cuatro formas concretas que ya se repitieron:

- **La mesa arranca TAPADA.** `configOf` enciende `isDealWindowEnabled` en toda mesa, la
  ronda nace en `DEALING` y las manos están ocultas hasta que cada jugador manda
  `REVEAL_TILES`. Los tests del plan que esperan `phase === "PLAYING"` y después leen fichas
  se cuelgan 15 s contra `dealingTimeoutMs` —que **no** es overridable por entorno— y el
  sistema retira a los dos. Usá `revealHands` del arnés.
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
3. **tsyringe-only-in-roots** — solo en `src/di-container.ts`,
   `.../colyseus/domino-room.ts` y `.../colyseus/commands/di-wiring.ts`. Esos tres nombres
   están escritos en el config; los archivos llegan en las Tareas 10–12.
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
