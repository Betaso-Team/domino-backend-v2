# Domino v2 — esqueleto de conexión y juego 2P · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Levantar `domino-backend-v2` con el espinazo transporte + DI + wire + visibilidad, y sobre él una partida de dominó 2P jugable de punta a punta con historial reproducible.

**Architecture:** Hexagonal por feature. `features/match/core/` son las reglas puras del dominó (estado `Schema` inerte + actores Player/Referee/Driver + comandos síncronos); `features/match/network/` es el anillo de aplicación; `features/match/transports/colyseus/` es la única pieza que habla Colyseus y el composition root per-partida. Cuatro reglas de imports verificadas por dependency-cruiser como test.

**Tech Stack:** Node ≥22, ESM, TypeScript 5.7, Colyseus 0.18.5, `@colyseus/schema` 5.x (API builder, sin decoradores), tsyringe (solo `useValue`/`useFactory`), zod 4, vitest 2, tsup, biome, dependency-cruiser, pino.

**Spec:** `docs/superpowers/specs/2026-09-09-domino-v2-port-arquitectura-truco-design.md` (commit `f9b7ef0`).

**Repo destino:** `C:\Users\david\OneDrive\Documentos\Codigo\domino-backend-v2` — hermano de `truco-backend-v2`, del que toma la arquitectura. **No existe todavía**: lo crea la Tarea 1.

Todas las rutas de este plan son relativas a esa raíz, **salvo la Tarea 0**, que se hace en el repo actual (`Betaso-Domino-Backend`, rama `HopeAero/truco-domino-refactor-port`) porque lee el código del v1 para extraer las reglas.

El v2 nace **autocontenido**: la Tarea 1 copia los tres documentos —reglas, spec y plan— a su `docs/`, y entran en su primer commit.

---

## Alcance

| Rebanada | Tareas | Produce |
|---|---|---|
| **0 · Documento de reglas** | 0 | `reglas-de-juego-v1.md`: la fuente de verdad del dominó, con las divergencias 2P/4P/torneo anotadas. **Bloquea todo lo demás** |
| **1 · Esqueleto de conexión** | 1–13 | Servidor que arranca, una sala con child container, wire validado, un verbo de ida y vuelta, visibilidad por asiento, log correlacionado por partida, endpoint de config, arnés E2E |
| **2 · Repartir y jugar 2P** | 14–21 | Partida 2P completa: reparto determinista, jugada legal, pozo, pase, tranca, conteo, rondas, `pointsToWin`, fases con plazo, replay |
| **3 · Endurecimiento** | 22–23 | Los criterios de "hecho" del spec que no caen en ninguna tarea anterior: el test del semáforo, los tres caminos de reconexión, y la ventana de reparto de punta a punta (el único camino del motor donde nadie gana) |

**Fuera de este plan**, cada uno replanificado con lo aprendido acá: 4P, multiplicador de apuesta, identidad multi-operador (feature `operator/`, `auth` multi-issuer, `operator_players`, `MatchProfiles`), economía y admisión, matchmaking completo, torneos, revancha, bots.

De la identidad del spec §4.1, lo que **sí** entra acá es la mitad que no necesita infraestructura nueva: `name`, `lastname`, `username` y `currency` **no existen** en el árbol de estado (Tarea 4), y el `playerId` del motor es el uuid interno. El mapeo `{operatorId, externalPlayerId} → playerId` y los perfiles fuera del estado llegan con la feature `operator/`.

---

## File Structure

Qué archivo es responsable de qué. Esto fija la decomposición; las tareas la siguen.

### Raíz del proyecto

| Archivo | Responsabilidad |
|---|---|
| `package.json` · `tsconfig.json` · `tsup.config.ts` · `vitest.config.ts` · `biome.json` | tooling |
| `.dependency-cruiser.cjs` | las cuatro reglas de imports |
| `src/index.ts` | lo que Node ejecuta: `listen(app)` |
| `src/app.config.ts` | `defineServer`: qué salas y qué rutas HTTP existen. Exporta `server` con nombre, para tipos end-to-end |
| `src/di-container.ts` | composition root **global** (proceso): `GlobalDominoConfig`, `Clock`, `Logger`, `HistoryPort` |
| `src/env.ts` | única lectura de `process.env`, validada con zod |

### `src/shared/` — solo lo portable entre proyectos

| Archivo | Responsabilidad |
|---|---|
| `rng.ts` | `hashSeed` (FNV-1a) + `mulberry32`. No sabe de dominó |
| `sleep.ts` | `sleep(ms, signal)` con `unref()` |

### `src/features/match/core/` — las reglas del dominó, puro

| Archivo | Responsabilidad |
|---|---|
| `ids.ts` | `PlayerId`, `TeamId` |
| `config.ts` | `GlobalDominoConfig`, `DominoMatchConfig` (con el `seed`), `DEFAULT_GLOBAL_CONFIG` |
| `command.ts` | `CommandPayloads` (el mapa de verbos) + `Command<N, TEvent>` |
| `events.ts` | `MatchEvent` (unión discriminada) + `DeadlineKind` |
| `state/tile.ts` | `Tile`, `PlacedTile` (sin `lockedNumber`: es derivable de datos públicos) |
| `state/player.ts` | `PlayerState` (sin `score`: el marcador es del equipo), `Hand` (nodo mixto: `tileCount` público, `tiles` gated) |
| `state/board.ts` | `BoardState`: la cadena jugada. Los extremos se derivan |
| `state/boneyard.ts` | `BoneyardState`: `count` público, `tiles` sin audiencia. **Rama nula**: ausente en 4P |
| `state/round.ts` | `RoundState` (con `starterId`), `Turn`, `RoundSummary`, `RoundPhase` |
| `state/match.ts` | `MatchState`, `Scoreboard` (único acumulador), `MatchPhase` |
| `engine/clock.ts` | puerto `Clock` (`now()`, write-only para el negocio) |
| `engine/timeout-scheduler.ts` | puerto `TimeoutScheduler` (`schedule`/`cancel`) |
| `engine/visibility.ts` | puerto `SchemaVisibilityController` + `Audience` |
| `engine/errors.ts` | `DominoError` → `RuleViolationError`, `InvariantViolationError` |
| `engine/driver.ts` | interfaz `Driver` + `TransitionResult` |
| `engine/tile-set.ts` | las 28 fichas y el valor nominal. Derivación pura |
| `engine/genesis.ts` | `createMatchState(seats, config)`: el árbol inicial. El orden de `seats` asigna equipos |
| `engine/state-projections.ts` | proyecciones puras: `currentRoundOf`, `teamOf`, `isRoundActive`, `handOf`, `boneyardCountOf`/`boneyardOf` (la rama nula del pozo) y el narrowing de los ejes (`sideOf`, `roundPhaseOf`, `matchPhaseOf`) |
| `engine/deadline-kind.ts` | `deadlineKindOf(match)`: a qué ventana sirve el plazo vigente |
| `engine/dealer.ts` | SERVICIO: reparte por `(seed, roundNumber)`. `orderedTiles()` es `protected` — el seam de test |
| `engine/scorer.ts` | SERVICIO: tarifa mano→puntos **y** asienta. Único escritor del marcador |
| `engine/player-facade.ts` · `player-repository.ts` · `referee-facade.ts` | las dos facades y el repositorio por asiento |
| `engine/round/{player,referee,driver}.ts` | TRÍO de la RONDA |
| `engine/round/board-ends.ts` | `boardEndsOf(board)`: los dos extremos jugables |
| `engine/round/playable.ts` | `playableSides(tile, ends)` y `hasPlayableTile(hand, ends)` |
| `engine/round/block.ts` | `isBlocked(match)` y `blockWinnerOf(match)` |
| `engine/match/{player,referee,driver}.ts` | TRÍO de la PARTIDA |
| `commands/*.ts` | un caso de uso, un archivo |

### `src/features/match/network/` — el anillo

| Archivo | Responsabilidad |
|---|---|
| `events.ts` | `NetworkMatchEvent` = `MatchEvent | PlatformMatchEvent` |
| `listeners.ts` | `MatchEventListener`, `MatchEventSink`, `MatchEventNotifier` (con disyuntor de cascada) |
| `history.ts` | `HistoryPort`, `HistoryEntry`, `MatchHistory` (el grabador per-partida) |
| `admission.ts` | puerto `MatchAdmission` + `AdmissionRefusedError` |
| `pieces.ts` | `MatchPieces`: lo que el wiring le entrega a la sala |
| `transports/memory-history.ts` | implementación de memoria del `HistoryPort` |

### `src/features/match/transports/` — infraestructura

| Archivo | Responsabilidad |
|---|---|
| `match-contract.ts` | `DominoRoomOptions`, `SeatCredentials`, `configOf(options)` |
| `match-registry.ts` | las partidas vivas del proceso + el DTO público (sin `seed`) |
| `colyseus/domino-room.ts` | composition root per-partida + la única pieza que habla Colyseus |
| `colyseus/visibility.ts` | `StateViewVisibilityController`: implementación del puerto |
| `colyseus/timeout-scheduler.ts` | `RoomTimeoutScheduler`: espera y difunde. Tonto |
| `colyseus/errors.ts` | `ColyseusError`, `ValidationError`, `UnknownCommandError`, `SeatNotReservedError`, `PlayerAlreadyOutError` |
| `colyseus/commands/payloads.ts` | esquemas zod del wire |
| `colyseus/commands/decoders.ts` | `MessageDecoder`: valida e **inyecta el `playerId` autenticado** |
| `colyseus/commands/catalog.ts` | `CommandCatalog`: la frontera anti-trampa (`Object.hasOwn`) |
| `colyseus/commands/di-wiring.ts` | tokens, `registerIndividualCommands`, `buildCatalog`, `buildPieces` |
| `http/register-http.ts` | `GET /config/:roomId` (sin `seed`, con `serverNow` para corregir el desfase de reloj del front) |

### Tests

| Archivo | Responsabilidad |
|---|---|
| `*.test.ts` colocado al lado de la fuente | unitarios. >1 test para una carpeta ⇒ subcarpeta `tests/` |
| `src/features/match/core/engine/tests/build-engine.ts` | fixture: arma el grafo de actores sin tsyringe |
| `src/features/match/tests/e2e-harness.ts` | conduce clientes reales contra `boot(appConfig)` |
| `src/architecture.test.ts` | corre dependency-cruiser y falla si se viola una regla |

---

## Tarea 0: El documento de reglas

**Bloquea todas las demás tareas.** No es TDD: es investigación y redacción. Se hace **en el repo actual** (`C:\Users\david\orca\workspaces\Betaso-Domino-Backend\pickerel`), rama `HopeAero/truco-domino-refactor-port`.

Las reglas del dominó hoy no están escritas en ningún lado: viven en tres implementaciones que difieren entre sí. El objetivo es extraerlas, **anotar cada divergencia como decisión explícita**, y dejar una fuente de verdad contra la cual escribir tests.

**Files:**
- Create: `docs/reglas-de-juego-v1.md`
- Read (2P): `src/rooms/schema/domino/two-players/domino-room-state.ts`, `round.state.ts`, `player.state.ts`, `src/rooms/schema/domino/piece.ts`
- Read (4P): `src/rooms/schema/domino/four-players/domino-room-state.ts`, `round.state.ts`, `player.state.ts`
- Read (torneo): `src/tournaments/game/state/tournament-game.ts`
- Read (constantes): `src/shared/constants/domino.constants.ts`, `src/shared/utils/domino.utils.ts`

- [ ] **Step 1: Extraer cada regla con su origen**

Llenar esta tabla leyendo los archivos. Las rutas y líneas son el punto de partida verificado; si una línea se movió, corregirla en la tabla.

| Regla | 2P | 4P | Torneo |
|---|---|---|---|
| Set de fichas y tamaño | `shared/constants/domino.constants.ts:1-38` (28 fichas, 0-6) | idem | idem |
| Fichas por jugador | `domino.constants.ts:41` (`TILES_PER_PLAYER_2P_INITIAL = 7`) | `:42` (7) | ? |
| Crear/validar/mezclar mazo | `shared/utils/domino.utils.ts:15-62` | idem | idem |
| Repartir manos | `two-players/domino-room-state.ts:204-233` | `four-players/domino-room-state.ts` | `tournaments/game/state/tournament-game.ts` |
| Quién arranca | `two-players/domino-room-state.ts:252-268` | ? | ? |
| Extremos del tablero | `two-players/round.state.ts:184-235` | `four-players/round.state.ts` | reusa el de 2P |
| Jugada legal | `two-players/round.state.ts:243-287`, `:125-142` | `four-players/round.state.ts` | reusa el de 2P |
| Robar del pozo | `two-players/domino-room-state.ts:239-247` | ? | ? |
| Pasar turno | `round.state.ts:93-96`; se decide en `commands/on-play-tile.ts:71-84` y `on-load-tile.ts:34-44` | `four-players/commands/on-play-tile.ts` | ? |
| Tranca / juego bloqueado | `round.state.ts:320-338` | `round.state.ts:346-356` | ? |
| Ganador por tranca | `two-players/domino-room-state.ts:396-417` | ? | ? |
| Valor de la mano | `two-players/player.state.ts:84-90` | `four-players/player.state.ts` | `tournament-player.ts` |
| Conteo de la ronda | `two-players/domino-room-state.ts:320-347`; empate en `:352-370` | `four-players/domino-room-state.ts` | ? |
| Siguiente ronda | `two-players/domino-room-state.ts:375-387` | ? | ? |
| Fin de partida | `two-players/domino-room-state.ts:423-431` (`pointsToWin`) | ? | `pointsPerWin`/`pointsPerLoss` |
| Timeout de turno | `two-players/commands/on-timeout.ts` | `four-players/commands/on-timeout.ts` | `tournaments/game/commands/` |
| Revelado de fichas | `commands/on-reveal-tiles.ts`, `on-timeout-reveal.ts` | idem 4P | idem |

- [ ] **Step 2: Resolver las decisiones abiertas**

Estas no se deducen del código porque el código hace cosas distintas en cada modo. Elegir y escribir la elección con su razón:

1. **Qué hace el sistema al vencer el turno.** Hoy `on-timeout.ts` **expulsa al jugador**. La alternativa (modelo de truco) es ejecutar el verbo del que calló —jugar una ficha legal, o robar, o pasar— y retirar solo tras agotar un tiempo extra. Decidir cuál, porque cambia cuántas partidas mueren por una desconexión.
2. **`pointsToWin` por defecto.** El schema de Mongo dice 25, el state dice 15. Uno de los dos está muerto: averiguar cuál se usa de verdad y escribir el número.
3. **Empate de ronda.** `:352-370` maneja un caso de empate. Escribir qué pasa exactamente con los puntos cuando dos manos empatan en pips tras una tranca.

> **Al cerrarse, la lista quedó en OCHO decisiones y no en tres.** Las cinco que aparecieron
> auditando el documento están en `docs/reglas-de-juego-v1.md` §7: el reloj al robar (4), el primer
> turno sin doble-seis (5), 4P con bots deshabilitados (6), el tiempo extra como **reserva de partida**
> en vez de gracia por turno (7), y qué significa "partida válida" más quién cobra (8). Las tres de
> arriba se conservan tal como se escribieron porque son el punto de partida real; la lista completa
> manda.
>
> Y dos secciones que este step no pedía y el documento terminó necesitando: **§9 el catálogo del
> historial** (la tabla cerrada que reemplaza los booleanos `isPassed`/`isLoaded` del v1) y **§10 los
> tres consumidores** (tablero / cliente / auditoría, y de dónde lee cada uno). Sin ellas, el defecto
> que más incomodó en producción no quedaba escrito en ningún lado.

- [ ] **Step 3: Escribir `docs/reglas-de-juego-v1.md`**

Estructura obligatoria (espejo de `truco-backend-v2/docs/reglas-de-juego-v9.md`):

```markdown
# Reglas del Dominó Betaso

> **Versión:** v1 — primera redacción. Extraída del código de `Betaso-Domino-Backend`
> a fecha 2026-09-09, con las divergencias entre 2P, 4P y torneo anotadas.

## 1. El material
### 1.1 El set de fichas
### 1.2 La mano y el pozo
## 2. La mesa
### 2.1 2 jugadores
### 2.2 4 jugadores por parejas — el orden de los asientos asigna los equipos
## 3. La ronda
### 3.1 Reparto
### 3.2 Quién arranca
### 3.3 El tablero y sus extremos
### 3.4 Jugada legal
### 3.5 Cuando no se puede jugar: robar y pasar
### 3.6 Cierre por dominó
### 3.7 Cierre por tranca
### 3.8 Conteo
## 4. La partida
### 4.1 Secuencia de rondas
### 4.2 Fin de partida
### 4.3 Abandono y forfeit
## 5. Los plazos
### 5.1 El turno
### 5.2 Qué hace el sistema al vencer un plazo
## 6. Divergencias entre modos
## 7. Decisiones tomadas al redactar
## 8. Glosario
```

Reglas de redacción: cada afirmación que salga del código lleva su `archivo:línea`. Cada divergencia entre modos va en §6 con la decisión de cuál gana en el v2. Cada cosa que el código no contesta va en §7 con la decisión y su razón.

- [ ] **Step 4: Verificar que no queda ninguna interrogación**

Run: `grep -n "?" docs/reglas-de-juego-v1.md | grep -v "^\s*$"`
Expected: solo signos de interrogación de prosa en español. **Ninguna celda de tabla con `?`** — cada una de las que la tabla del Step 1 tiene en blanco tiene que estar resuelta o declarada explícitamente como "no aplica a este modo".

- [ ] **Step 5: Commit**

```bash
git add docs/reglas-de-juego-v1.md
git commit -m "docs: reglas del dominó v1, extraídas del código con sus divergencias

Primera redacción de la fuente de verdad del juego. Las reglas vivían en tres
implementaciones (2P, 4P, torneo) que difieren entre sí; cada divergencia queda
anotada en §6 con la decisión de cuál gana en el v2, y cada hueco que el código
no contesta en §7 con su razón.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

# Rebanada 1 — Esqueleto de conexión

## Tarea 1: Scaffold del repo y tooling

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `vitest.setup.ts`, `biome.json`, `.gitignore`

- [ ] **Step 1: Crear el repo y traerle sus tres documentos**

El v2 nace **autocontenido**: su spec, su plan y las reglas del juego viven adentro, no en el repo
viejo. Lo único que se queda del otro lado es el historial de cómo se llegó hasta acá.

```bash
V1="C:/Users/david/orca/workspaces/Betaso-Domino-Backend/pickerel"
V2="C:/Users/david/OneDrive/Documentos/Codigo/domino-backend-v2"

mkdir -p "$V2"
cd "$V2"
git init -b main

mkdir -p docs/superpowers/specs docs/superpowers/plans
cp "$V1/docs/reglas-de-juego-v1.md" docs/
cp "$V1/docs/superpowers/specs/2026-09-09-domino-v2-port-arquitectura-truco-design.md" docs/superpowers/specs/
cp "$V1/docs/superpowers/plans/2026-09-09-domino-v2-esqueleto-y-juego-2p.md" docs/superpowers/plans/
```

Los tres se commitean en el Step 7 junto con el tooling, así que el primer commit del repo ya trae
**qué se construye, por qué, y las reglas contra las que se testea**.

> **Las referencias `archivo:línea` de los documentos apuntan al v1**, que desde acá es otro repo.
> Es deliberado: son la evidencia de la auditoría y de dónde salió cada regla. Cuando el v1 se apague,
> quedan como registro histórico y no como instrucciones — igual que el `changelog.md` de truco.

- [ ] **Step 2: `package.json`**

```json
{
  "name": "@betaso/domino-backend",
  "version": "0.1.0",
  "description": "Backend del Dominó Betaso",
  "type": "module",
  "private": true,
  "engines": { "node": ">=22" },
  "scripts": {
    "build": "tsup",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src",
    "format": "biome format --write src",
    "test": "vitest run",
    "test:watch": "vitest",
    "depcruise": "depcruise src --config .dependency-cruiser.cjs"
  },
  "dependencies": {
    "@colyseus/schema": "^5.0.27",
    "@colyseus/tools": "^0.18.3",
    "colyseus": "^0.18.5",
    "express": "^5.2.1",
    "jsonwebtoken": "^9.0.3",
    "pino": "^10.1.0",
    "reflect-metadata": "^0.2.2",
    "tsyringe": "^4.8.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.4",
    "@colyseus/sdk": "^0.18.2",
    "@colyseus/testing": "^0.18.5",
    "@types/express": "^5.0.6",
    "@types/jsonwebtoken": "^9.0.10",
    "@types/node": "^24.10.1",
    "dependency-cruiser": "^16.10.0",
    "tsup": "^8.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.2",
    "vitest": "^3.2.7"
  }
}
```

> **`vitest` va en 3.x y no en 2.x, y no es preferencia: es lo único que resuelve.** `vitest@2`
> arrastra `vite@5`, y `colyseus@0.18.5` declara `peerOptional vite@">=6.0.0"`. Con el 2.x, `npm
> install` termina en `ERESOLVE` y la única salida es `--legacy-peer-deps`, o sea aceptar una
> resolución que npm mismo llama potencialmente rota. Con 3.2.7 entra `vite@7` y el árbol resuelve
> limpio, sin flags. Verificado al ejecutar esta tarea.

**Nota sobre lo que NO está:** no hay `unplugin-swc` ni `@swc/core`, y `tsconfig` no activa
`experimentalDecorators`. Truco los necesita porque conserva `@type` y esbuild no emite metadata de
decoradores; acá el estado usa la API builder de schema 5 y tsyringe se usa solo con
`useValue`/`useFactory`, así que **no hay un solo decorador en el codebase**.

- [ ] **Step 3: `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "sourceMap": true,
    "declaration": false
  },
  "include": ["src/**/*.ts"]
}
```

`verbatimModuleSyntax` + `NodeNext` obliga a que **todo import relativo lleve extensión `.js`**
(`import { Tile } from "./tile.js"`), aunque el archivo sea `.ts`. Es lo que hace truco.

- [ ] **Step 4: `tsup.config.ts`, `vitest.config.ts`, `vitest.setup.ts`, `biome.json`, `.gitignore`**

```ts
// tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  sourcemap: true,
  dts: false,
});
```

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
    // `forks` (el default) rompe: @colyseus/tools usa process.send y choca con su IPC.
    pool: "threads",
    testTimeout: 15_000,
  },
});
```

```ts
// vitest.setup.ts
import "reflect-metadata";

process.env.NODE_ENV ??= "test";
process.env.JWT_SECRET ??= "test-secret-do-not-use-in-production";
process.env.PORT ??= "2567";
```

```json
// biome.json
{
  "$schema": "https://biomejs.dev/schemas/1.9.4/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "suspicious": { "noConsole": "error" }
    }
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  }
}
```

```gitignore
node_modules/
dist/
*.log
.env
.env.*
!.env.example
```

- [ ] **Step 5: Instalar y verificar que el lint prohíbe `console`**

```bash
npm install
mkdir -p src
printf 'export function boom() {\n  console.log("nope");\n}\n' > src/scratch-console-check.ts
npm run lint
```

Expected: **FALLA**, con un diagnóstico de `suspicious/noConsole` en `src/scratch-console-check.ts`.

Si en cambio pasa, la regla se llama distinto en la versión instalada de biome. Averiguar el nombre
correcto y corregir `biome.json` antes de seguir:

```bash
npx biome explain noConsole
```

- [ ] **Step 6: Borrar el archivo de prueba**

```bash
rm src/scratch-console-check.ts
npm run lint
```

Expected: **falla, y con un error distinto** — `internalError/io: No files were processed in the
specified paths`. No es un problema: biome trata "cero archivos" como error, y `src/` acaba de quedar
vacío. Lo que importa es que **el diagnóstico de `noConsole` desapareció**, que es lo que este paso
verifica.

Lo mismo con `npm run typecheck`, que sale con `TS18003: No inputs were found in config file` por la
misma razón. **Los dos se arreglan solos en la Tarea 2**, que es la primera que pone un `.ts` dentro
de `src/`.

> **Por qué no se tapa con un archivo placeholder.** Un `src/index.ts` de mentira ahora sería código
> que la Tarea 12 tiene que reemplazar, y un stub que nadie ejecuta es justamente lo que este proyecto
> viene a sacarse de encima. El hueco dura una tarea y está documentado; eso alcanza.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json tsconfig.json tsup.config.ts vitest.config.ts vitest.setup.ts biome.json .gitignore docs
git commit -m "chore: scaffold del repo con Colyseus 0.18, schema 5, vitest y biome

El primer commit trae también los tres documentos —reglas, spec y plan—, así que
el repo nace autocontenido: qué se construye, por qué, y contra qué se testea.

Sin decoradores en el codebase: el estado usa la API builder de schema 5 y
tsyringe solo useValue/useFactory, así que no hacen falta experimentalDecorators
ni el plugin de SWC que truco necesita para emitir metadata.

vitest con pool: threads porque @colyseus/tools usa process.send.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 2: Las cuatro reglas de imports, como test

Las reglas de §3.2 del spec no valen nada si no fallan el build. Esta tarea las escribe **y prueba
que fallan** cuando se violan.

**Files:**
- Create: `.dependency-cruiser.cjs`
- Test: `src/architecture.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// src/architecture.test.ts
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

// Dos features desechables usadas solo para violar reglas a propósito. Nunca se commitean:
// afterEach las borra por completo después de cada test.
const FEATURE_A = "scratch";
const FEATURE_B = "scratch-peer";

const FEATURE_A_DIR = `src/features/${FEATURE_A}`;
const FEATURE_B_DIR = `src/features/${FEATURE_B}`;

const CORE_DIR = `${FEATURE_A_DIR}/core`;
const OUTSIDE_DIR = `${FEATURE_A_DIR}/outside`;
const PEER_CORE_DIR = `${FEATURE_B_DIR}/core`;

const VIOLATION_FILE = `${CORE_DIR}/violation.ts`;

function depcruise(): { ok: boolean; output: string } {
  // Se reusa el script de package.json (en vez de invocar `depcruise` directo) para que la
  // regla y el test no puedan divergir en la invocación. Verificado antes de este cambio:
  // `npm run` propaga el exit code del hijo (0 en éxito, 1 en violación) y el stdout que
  // captura sigue conteniendo el nombre de la regla violada.
  try {
    const output = execFileSync("npm", ["run", "depcruise"], { encoding: "utf8", shell: true });
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function writeFile(path: string, source: string): void {
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(path, source, "utf8");
}

function writeViolation(source: string): void {
  writeFile(VIOLATION_FILE, source);
}

afterEach(() => {
  rmSync(FEATURE_A_DIR, { recursive: true, force: true });
  rmSync(FEATURE_B_DIR, { recursive: true, force: true });
});

describe("reglas de arquitectura", () => {
  it("el codebase las cumple", () => {
    const { ok } = depcruise();
    expect(ok).toBe(true);
  });

  it("Regla 1: core-allowlist — core no puede importar fuera de core dentro de su propia feature", () => {
    writeFile(`${OUTSIDE_DIR}/thing.ts`, "export const thing = 1;\n");
    writeViolation(`import { thing } from "../outside/thing";\nexport const x = thing;\n`);
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("core-allowlist");
  });

  it("Regla 2: core no puede importar el runtime de Colyseus", () => {
    writeViolation(`import { Room } from "colyseus";\nexport type X = Room;\n`);
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("core-no-runtime");
  });

  it("Regla 2: core-no-runtime también cubre devDependencies (@colyseus/testing)", () => {
    // El hueco: dependencyTypes solo con "npm" no matchea devDependencies, que resuelven como
    // "npm-dev". @colyseus/testing es una devDependency real del proyecto (package.json).
    writeViolation(`import { boot } from "@colyseus/testing";\nexport const bootFn = boot;\n`);
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("core-no-runtime");
  });

  it("Regla 2: core SÍ puede importar @colyseus/schema", () => {
    writeViolation(
      `import { schema, t } from "@colyseus/schema";\nexport const X = schema({ a: t.number() }, "X");\n`,
    );
    const { ok } = depcruise();
    expect(ok).toBe(true);
  });

  it("Regla 3: tsyringe solo en los composition roots", () => {
    writeViolation(`import { container } from "tsyringe";\nexport const c = container;\n`);
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("tsyringe-only-in-roots");
  });

  it("Regla 4: feature-boundary — una feature no puede importar de otra salvo por su index.ts", () => {
    writeFile(`${PEER_CORE_DIR}/thing.ts`, "export const peerThing = 1;\n");
    writeFile(
      `${OUTSIDE_DIR}/cross-feature.ts`,
      `import { peerThing } from "../../${FEATURE_B}/core/thing";\nexport const x = peerThing;\n`,
    );
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("feature-boundary");
  });

  it("no-circular: dos módulos que se importan mutuamente forman un ciclo prohibido", () => {
    writeFile(
      `${FEATURE_A_DIR}/circular-a.ts`,
      `import { b } from "./circular-b";\nexport const a = 1;\nexport const useB = () => b;\n`,
    );
    writeFile(
      `${FEATURE_A_DIR}/circular-b.ts`,
      `import { a } from "./circular-a";\nexport const b = 1;\nexport const useA = () => a;\n`,
    );
    const { ok, output } = depcruise();
    expect(ok).toBe(false);
    expect(output).toContain("no-circular");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/architecture.test.ts`
Expected: FAIL — no existe `.dependency-cruiser.cjs`, así que `depcruise` sale con error y el primer
test (`el codebase las cumple`) falla.

- [ ] **Step 3: Escribir `.dependency-cruiser.cjs`**

```js
// .dependency-cruiser.cjs
// Las cuatro reglas de imports del spec §3.2 (core-allowlist, core-no-runtime,
// tsyringe-only-in-roots, feature-boundary) más no-circular, que no es una regla de imports
// sino un invariante estructural del grafo (spec §3.5). Cada una tiene su test en
// src/architecture.test.ts.
module.exports = {
  forbidden: [
    {
      name: "core-allowlist",
      comment:
        "Regla 1: features/X/core solo importa de features/X/core y de shared. Es allowlist, " +
        "no denylist: por eso el exterior puede nombrarse libremente.",
      severity: "error",
      from: { path: "^src/features/([^/]+)/core/" },
      to: {
        dependencyTypes: ["local"],
        pathNot: ["^src/features/$1/core/", "^src/shared/"],
      },
    },
    {
      name: "core-no-runtime",
      comment:
        "Regla 2: el core no importa paquetes de runtime. Excepción única y documentada: " +
        "@colyseus/schema, porque el estado ES el Schema (spec §3.4).",
      severity: "error",
      from: { path: "^src/features/[^/]+/core/" },
      to: {
        // "npm" cubre dependencies; "npm-dev" cubre devDependencies (@colyseus/testing,
        // @colyseus/sdk). Sin "npm-dev" un import de un paquete de test/dev en el core pasa
        // desapercibido: la regla estaría verde sin proteger nada.
        dependencyTypes: ["npm", "npm-dev"],
        // OJO: depcruise matchea `to.path` contra la ruta RESUELTA
        // ("node_modules/colyseus/build/index.cjs"), NO contra el specifier del import. El
        // prefijo "^node_modules/" es obligatorio: sin él "^colyseus" no matchea nada y la
        // regla queda deshabilitada en silencio — build verde, cero protección.
        path: "^node_modules/(colyseus|@colyseus/(?!schema)|mongoose|mongodb|pg|amqplib|axios|ioredis|tsyringe|express)",
      },
    },
    {
      name: "tsyringe-only-in-roots",
      comment: "Regla 3: registrar y resolver son operaciones de composición.",
      severity: "error",
      from: {
        pathNot: [
          "^src/di-container\\.ts$",
          "^src/features/match/transports/colyseus/domino-room\\.ts$",
          "^src/features/match/transports/colyseus/commands/di-wiring\\.ts$",
        ],
      },
      // Mismos dos motivos que arriba: "npm-dev" cierra el hueco, y el prefijo
      // "^node_modules/" es lo que hace que el patrón matchee algo.
      to: { dependencyTypes: ["npm", "npm-dev"], path: "^node_modules/tsyringe/" },
    },
    {
      name: "feature-boundary",
      comment: "Regla 4: una feature solo importa de otra vía su index.ts.",
      severity: "error",
      from: { path: "^src/features/([^/]+)/" },
      to: { path: "^src/features/(?!$1/)[^/]+/.+", pathNot: "^src/features/[^/]+/index\\.ts$" },
    },
    {
      name: "no-circular",
      comment: "El grafo de actores es un DAG acíclico solo hacia abajo (spec §3.5).",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: [".ts", ".js"] },
    reporterOptions: { text: { highlightFocused: true } },
  },
};
```

- [ ] **Step 4: Correr el test hasta que pase**

Run: `npx vitest run src/architecture.test.ts`
Expected: los **8** tests PASAN — uno por cada una de las cinco reglas, más el positivo de la
excepción `@colyseus/schema`, más el de devDependencies, más el del codebase limpio.

Si `core-allowlist` o `feature-boundary` no disparan como se espera, el problema casi siempre es la
sustitución de `$1`: dependency-cruiser la hace por template sobre el string de la regex, así que
`^src/features/$1/core/` se vuelve `^src/features/match/core/`. Comprobar con:

```bash
npx depcruise src --config .dependency-cruiser.cjs --output-type err-long
```

> **LAS CINCO REGLAS LLEVAN TEST, y la primera redacción de esta tarea se equivocó al decir que
> `core-allowlist` y `feature-boundary` no se podían testear "porque todavía no hay una segunda
> feature".** Sí se pueden: se violan con la misma técnica de scratch que usan las otras, creando dos
> directorios de feature desechables (`src/features/scratch`, `src/features/scratch-peer`) y
> borrándolos en el `afterEach`. Una regla sin test es una regla que puede estar muerta en verde, que
> es exactamente lo que esta tarea existe para impedir — y de hecho pasó: dos de las cinco estaban
> muertas por el regex sin prefijo, y ningún test lo veía.
>
> **La forma de verificar un test de este archivo es rompiendo su regla**, no leyéndolo: poner
> `severity: "ignore"` en esa regla y comprobar que ese test —y solo ese— se pone rojo. Si sigue
> verde, no está probando nada.

> **`npm run depcruise` en vez de hardcodear el comando.** El helper del test invoca el script de
> `package.json`, así que la invocación existe en un solo lugar y no puede desincronizarse. Verificado
> que `npm run` conserva las dos propiedades que el test necesita: propaga el exit code del hijo
> (0 / 1) y deja el nombre de la regla en la salida capturada.
>
> Y una propiedad que hay que conservar al tocar este helper: un config **roto** (error de sintaxis)
> tiene que hacer FALLAR los tests de violación, no pasarlos. Sale gratis porque el crash no imprime
> ningún nombre de regla, así que el `toContain(nombre)` no se cumple — pero si alguien cambia la
> aserción a "falló de cualquier manera", el guardarraíl entero queda en verde con el config podrido.

- [ ] **Step 5: Commit**

```bash
git add .dependency-cruiser.cjs src/architecture.test.ts
git commit -m "test: las cuatro reglas de imports como test de arquitectura

Cada regla tiene un test que escribe un archivo que la viola y afirma que
depcruise falla nombrándola. Sin eso, una regla puede estar mal escrita y
pasar sin proteger nada.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 3: `env.ts` — la única lectura de `process.env`

**Files:**
- Create: `src/env.ts`, `.env.example`
- Test: `src/env.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// src/env.test.ts
import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

describe("parseEnv", () => {
  it("acepta un entorno completo", () => {
    const env = parseEnv({ NODE_ENV: "production", PORT: "3000", JWT_SECRET: "s".repeat(16) });
    expect(env.port).toBe(3000);
    expect(env.nodeEnv).toBe("production");
    expect(env.jwtSecret).toBe("s".repeat(16));
  });

  it("aplica los defaults de desarrollo", () => {
    const env = parseEnv({ JWT_SECRET: "s".repeat(16) });
    expect(env.nodeEnv).toBe("development");
    expect(env.port).toBe(2567);
    expect(env.logLevel).toBe("debug");
  });

  it("en producción el nivel de log baja a info", () => {
    const env = parseEnv({ NODE_ENV: "production", JWT_SECRET: "s".repeat(16) });
    expect(env.logLevel).toBe("info");
  });

  it("rechaza un entorno sin JWT_SECRET", () => {
    expect(() => parseEnv({})).toThrow(/JWT_SECRET/);
  });

  it("rechaza un JWT_SECRET corto", () => {
    expect(() => parseEnv({ JWT_SECRET: "corto" })).toThrow(/JWT_SECRET/);
  });

  it("rechaza un PORT que no es número", () => {
    expect(() => parseEnv({ JWT_SECRET: "s".repeat(16), PORT: "abc" })).toThrow(/PORT/);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/env.test.ts`
Expected: FAIL con `Failed to resolve import "./env.js"`.

- [ ] **Step 3: Escribir `src/env.ts`**

```ts
// src/env.ts
// El ÚNICO lugar del repo que lee process.env. Todo lo demás recibe la config
// por constructor o por el container.
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(2567),
  // Compartido con el backend principal. El dominó verifica y NUNCA firma.
  JWT_SECRET: z.string().min(16, "JWT_SECRET debe tener al menos 16 caracteres"),
});

export interface Env {
  readonly nodeEnv: "development" | "test" | "production";
  readonly port: number;
  readonly jwtSecret: string;
  readonly logLevel: "debug" | "info";
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Entorno inválido — ${detail}`);
  }
  const parsed = result.data;
  return {
    nodeEnv: parsed.NODE_ENV,
    port: parsed.PORT,
    jwtSecret: parsed.JWT_SECRET,
    logLevel: parsed.NODE_ENV === "production" ? "info" : "debug",
  };
}

export const env: Env = parseEnv(process.env);
```

- [ ] **Step 4: Correr el test hasta que pase**

Run: `npx vitest run src/env.test.ts`
Expected: los 6 tests PASAN.

- [ ] **Step 5: Escribir `.env.example` y commitear**

```bash
printf 'NODE_ENV=development\nPORT=2567\nJWT_SECRET=change-me-at-least-16-chars\n' > .env.example
git add src/env.ts src/env.test.ts .env.example
git commit -m "feat: env.ts con validación zod como única lectura de process.env

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 6: El guardarraíl — hacer cumplir "el único lector"**

El título de esta tarea afirma una invariante y hasta acá **nada la hace cumplir**: ni un test, ni una
regla de depcruise, ni el lint. Se cumple por casualidad, y el día que una feature meta un
`process.env` suelto la afirmación pasa a ser falsa sin que nadie se entere. Es la misma forma de bug
que las dos reglas muertas de la Tarea 2 — una garantía declarada sin nada detrás.

Va en **su propio archivo**, `src/env-single-reader.test.ts`, y no en `architecture.test.ts`: ese
escanea texto del sistema de archivos y no invoca depcruise nunca, así que compartirían archivo solo
por reusar el helper de fixtures. Eso es casualidad, no parentesco.

```ts
// src/env-single-reader.test.ts
const ENV_MODULE_PATH = "src/env.ts";
// Este archivo se excluye también: su fuente contiene literalmente "process.env" (en el
// patrón y en los fixtures). Excluirlo por ruta es más simple y legible que ofuscar esas
// apariciones, y no abre un hueco real — no lee configuración, solo texto sobre cómo detectarla.
const THIS_FILE_PATH = "src/env-single-reader.test.ts";
const EXCLUDED_PATHS = new Set([ENV_MODULE_PATH, THIS_FILE_PATH]);

// Detecta la substring `process.env` Y los imports de `process`/`node:process`.
const IMPORTS_PROCESS_MODULE = /from\s+["'](?:node:)?process["']/;

function readsProcessEnv(source: string): boolean {
  return source.includes("process.env") || IMPORTS_PROCESS_MODULE.test(source);
}
```

Más un recorrido recursivo real de `src/` (no `git ls-files`: así el fixture del test dispara sin
tener que pasar por el índice), el filtro por exclusiones, y tres tests — el codebase limpio, un
`process.env` suelto, y un `import { env } from "node:process"`.

> **Ese segundo detector es la mitad del valor, y la primera versión no lo tenía.**
> `import { env } from "node:process"` es la vía idiomática para leer la configuración **sin que la
> substring `process.env` aparezca nunca en el archivo**. Con solo el escaneo de substring, el
> guardarraíl decía proteger algo que no protegía. Que sea un patrón normal y no un rebusque es
> justamente lo que lo hacía grave.
>
> **Y los blind spots que quedan se documentan, no se resuelven**: `process["env"]`, acceso
> computado, `globalThis.process.env`, reexportar `process.env` desde otro módulo, o desestructurar
> `process` en un alias. Un hueco documentado es honesto; uno sin documentar es el bug. Resolverlos
> pediría escanear el AST, y eso no se paga para lo que este test cuida.

**La forma de verificar este test es rompiéndolo**, igual que en la Tarea 2: escribir un archivo bajo
`src/` que lea la configuración por cada una de las dos vías, ver el test rojo **nombrando el
archivo**, y borrarlo. Un guardarraíl que nadie vio fallar no es un guardarraíl.

- [ ] **Step 7: Documentar el acoplamiento de import-time, en las dos direcciones**

`export const env = parseEnv(process.env)` corre **al importar**. O sea que importar `env.ts` con un
entorno inválido revienta antes de que corra una línea del que importa — deseable (falla temprano),
pero hay que decirlo:

- En la cabecera de `src/env.ts`: importar este módulo valida el entorno y lanza si falta algo.
- En `vitest.setup.ts`: por qué existen esas tres líneas `??=`, referenciando lo de arriba.

Sin esos dos comentarios, el próximo que escriba un script que importe `env.ts` va a perder media hora
con un stack trace en el import.

---

## Tarea 4: El árbol de estado con la API builder de schema 5

Esta tarea toca la API que menos conocemos, así que **empieza verificándola contra la referencia**
antes de escribir el estado entero.

**Files:**
- Create: `src/features/match/core/ids.ts`, `src/features/match/core/state/tile.ts`, `.../state/player.ts`, `.../state/board.ts`, `.../state/boneyard.ts`, `.../state/round.ts`, `.../state/match.ts`, `.../state/index.ts`
- Test: `src/features/match/core/state/state.test.ts`

- [ ] **Step 1: Verificar la API builder y `.view()` contra la referencia**

```bash
grep -n "view" ~/.claude/skills/colyseus/references/schema.md | head -40
grep -n -A 12 "Defining a Schema structure" ~/.claude/skills/colyseus/references/schema.md
```

Anotar tres cosas antes de escribir código:
1. La firma exacta de `schema(fields, name)` y de `SchemaType`.
2. Cómo se marca un campo como vista: `t.array(Tile).view()` o un helper aparte.
3. Si existen constructores de enteros angostos (`t.uint8()`) o solo `t.number()`.

**Este plan usa `t.number()` en todas partes**, que es seguro. Si la referencia confirma `t.uint8()`,
NO cambiarlo en esta tarea: es una optimización de ancho de banda, y se hace cuando haya una medición
que la justifique.

- [ ] **Step 2: Escribir el test que falla**

```ts
// src/features/match/core/state/state.test.ts
import { StateView } from "@colyseus/schema";
import { describe, expect, it } from "vitest";
import { Hand, MatchState, PlayerState, Tile } from "./index.js";

describe("árbol de estado", () => {
  it("una ficha lleva sus dos números", () => {
    const tile = new Tile();
    tile.left = 6;
    tile.right = 4;
    expect(tile.toJSON()).toEqual({ left: 6, right: 4 });
  });

  it("la mano expone el conteo como campo público", () => {
    const hand = new Hand();
    const tile = new Tile();
    tile.left = 3;
    tile.right = 3;
    hand.tiles.push(tile);
    hand.tileCount = hand.tiles.length;
    expect(hand.tileCount).toBe(1);
  });

  it("MatchState arranca vacío y en NOT_STARTED", () => {
    const match = new MatchState();
    expect(match.phase).toBe("NOT_STARTED");
    expect(match.players.length).toBe(0);
    expect(match.currentRound).toBeUndefined();
    expect(match.activeDeadline).toBe(0);
  });

  it("las fichas de la mano son un campo de VISTA: una StateView vacía no las tiene", () => {
    const hand = new Hand();
    // El Encoder está SOLO para darle un Root al nodo. `StateView.add()` es un no-op
    // silencioso si el ChangeTree del objetivo no tiene root (`StateView.ts`, `_bindRoot`),
    // y en una sala real el Root lo attachea el Encoder de Colyseus al asignar `this.state`.
    // Acá no se encodea nada: sin esta línea el test pasaría en verde midiendo nada.
    new Encoder(hand);
    const view = new StateView();
    // El contrato que importa: `tiles` está marcado como vista, así que su
    // pertenencia se decide por StateView y no por estar en el árbol.
    expect(view.has(hand.tiles)).toBe(false);
    view.add(hand.tiles);
    expect(view.has(hand.tiles)).toBe(true);
  });

  // EL TEST QUE PROTEGE LA RAMA NULA, y el más valioso de esta tarea. La asimetría es
  // deliberada: una ronda siempre tiene tablero y un jugador siempre tiene mano, pero solo
  // algunos modos tienen pozo. Si alguien saca un `.optional()`, este test es lo único que
  // lo ve — el resto de la suite sigue verde y el bug vuelve en silencio.
  it("las ramas nulas arrancan ausentes; lo que siempre existe, no", () => {
    const round = new RoundState();
    expect(round.boneyard).toBeUndefined();
    expect(round.currentTurn).toBeUndefined();
    expect(round.board).toBeDefined();

    const match = new MatchState();
    expect(match.currentRound).toBeUndefined();
    expect(match.scoreboard).toBeUndefined();
    expect(new PlayerState().hand).toBeDefined();
  });
});
```

El import del test suma `Encoder` y `RoundState`:

```ts
import { Encoder, StateView } from "@colyseus/schema";
import { Hand, MatchState, PlayerState, RoundState, Tile } from "./index.js";
```

- [ ] **Step 3: Correr el test para verificar que falla**

Run: `npx vitest run src/features/match/core/state/state.test.ts`
Expected: FAIL con `Failed to resolve import "./index.js"`.

Si el test de `StateView.has` falla porque ese método no existe con esa firma, corregir **el test**
usando lo que la referencia del Step 1 diga, y dejar el comentario explicando qué se afirma. Lo que no
se negocia es que el test demuestre que `tiles` es un campo de vista.

- [ ] **Step 4: Escribir los archivos de estado**

```ts
// src/features/match/core/ids.ts
export type PlayerId = string;
export type TeamId = "A" | "B";
```

```ts
// src/features/match/core/state/tile.ts
import { type SchemaType, schema, t } from "@colyseus/schema";

// Una ficha. `left` y `right` son los dos números, 0..6.
export const Tile = schema({ left: t.number(), right: t.number() }, "Tile");
export type Tile = SchemaType<typeof Tile>;

// Una ficha ya puesta en la mesa: qué ficha, quién la puso, y de qué extremo se colgó.
//
// NO lleva `lockedNumber`. El número por el que enganchó es DERIVABLE de la cadena
// (`board.tiles` + `side`), con el mismo recorrido que hace `boardEndsOf`, y `board.tiles`
// es PÚBLICO — así que el cliente puede derivarlo. Guardarlo sería el campo derivado que
// spec §7.1 prohíbe, y de paso arrastraba el centinela `-1` del v1 a un campo donde 0 es
// un valor legítimo (la blanca).
//
// El criterio, escrito una vez: un campo derivado se guarda SOLO cuando el cliente no
// puede derivarlo —porque su fuente está gateada (`Hand.tileCount`, `BoneyardState.count`)
// o porque derivarlo exigiría reimplementar una regla del juego—. `lockedNumber` no
// califica por ninguna de las dos.
export const PlacedTile = schema(
  {
    tile: t.ref(Tile),
    playedBy: t.string(),
    side: t.string(), // BoardSide — narrowing vía sideOf() en state-projections.ts
  },
  "PlacedTile",
);
export type PlacedTile = SchemaType<typeof PlacedTile>;

export type BoardSide = "LEFT" | "RIGHT";
```

```ts
// src/features/match/core/state/player.ts
import { type SchemaType, schema, t } from "@colyseus/schema";
import { Tile } from "./tile.js";

// NODO MIXTO, y es la pieza que cierra el agujero de trampa del v1 (spec §7.1):
// `tileCount` es público —el front tiene que saber cuántas fichas le quedan al rival—
// y `tiles` es de VISTA, así que solo llega al dueño del asiento.
//
// `isRevealed` es la decisión CON MEMORIA del cierre de ronda: la mano se hace pública a
// TODOS para contar los pips, y eso vive en el estado para que el árbol sea autocontenido
// para el front y para el replay.
//
// ⚠ NO CONFUNDIR con `PlayerState.hasSeenTiles`. Son dos ejes distintos y el v1 los
// habría metido en un booleano:
//   · `hasSeenTiles`  → el DUEÑO levantó sus fichas. Audiencia: él. Pasa una vez por
//                       partida, en la ventana de reparto.
//   · `Hand.isRevealed` → la mano es pública para TODOS. Pasa al cerrar cada ronda.
// Que el dueño las haya visto no las hace públicas, y hacerlas públicas al final no dice
// nada sobre si las levantó al principio.
export const Hand = schema(
  {
    tileCount: t.number().default(0),
    isRevealed: t.boolean().default(false),
    tiles: t.array(Tile).view(),
  },
  "Hand",
);
export type Hand = SchemaType<typeof Hand>;

// `extraTimeRemainingMs` es la RESERVA de tiempo extra para TODA la partida, y solo
// decrece (modelo de truco, `PlayerState.extraTimeRemainingMs`). Es un cambio DELIBERADO
// respecto del v1, que reseteaba los 30 s de gracia en cada turno: acá el que la gasta se
// queda sin colchón. Va en el jugador y no en config porque es un saldo con memoria —lo
// único que el motor le resta— y va acá y no en `Turn` porque cruza los turnos y las rondas.
//
// NO lleva `score`. El marcador vive SOLO en `MatchState.scoreboard`: el puntaje de un
// jugador es `scoreboard[teamOf(player)]`, incluso en 4P, donde la regla del v1 le da a
// los dos compañeros el total idéntico (por eso el v1 leía un "capitán"). Tenerlo en los
// dos lados era doble contabilidad del mismo dinero, con un solo escritor que actualizaba
// ambos —justo la desincronización que spec §7.1 quiere evitar—. Truco tampoco lo tiene.
//
// `hasSeenTiles`: ¿ya levantó sus fichas? Se marca UNA vez por partida, con el verbo
// `REVEAL_TILES`, y NO se resetea entre rondas —la ventana de reparto es solo la de la
// ronda 1—. Es **público** a propósito: el front tiene que poder decir *a quién se está
// esperando*, que es la mitad del valor de la ventana.
export const PlayerState = schema(
  {
    playerId: t.string(),
    teamId: t.string(),
    seatIndex: t.number(),
    connected: t.boolean().default(true),
    hasAbandoned: t.boolean().default(false),
    hasSeenTiles: t.boolean().default(false),
    extraTimeRemainingMs: t.number().default(0),
    hand: t.ref(Hand),
  },
  "PlayerState",
);
export type PlayerState = SchemaType<typeof PlayerState>;
```

Lo que **no** está en `PlayerState`, y es deliberado (spec §4.1): `name`, `lastname`, `username`,
`currency`, `profilePicture`. Nickname y avatar viven fuera del estado, en `network/profiles.ts`.

Y lo que **sí** está aunque truco no lo tenga: `connected`. Truco no lleva ningún campo de conexión
—`grep -rn "connected" src/` da cero— porque la conexión es plataforma y la cuenta con
`PLAYER_DISCONNECTED`/`PLAYER_RECONNECTED`. Acá se conserva el campo del v1 **a propósito**: un
evento es un delta y el estado es el acumulado, así que un cliente que reconecta a mitad de partida
tiene que poder ver que su rival está caído sin que nadie le reenvíe un evento pasado. Los eventos
de plataforma siguen existiendo para quien quiera el instante; el campo es para quien llega tarde.

```ts
// src/features/match/core/state/board.ts
import { type SchemaType, schema, t } from "@colyseus/schema";
import { PlacedTile } from "./tile.js";

// La cadena jugada. Los extremos NO son campos: se derivan de `tiles`
// (spec §7.1, "sin campos derivados") con boardEndsOf().
export const BoardState = schema({ tiles: t.array(PlacedTile) }, "BoardState");
export type BoardState = SchemaType<typeof BoardState>;
```

```ts
// src/features/match/core/state/boneyard.ts
import { type SchemaType, schema, t } from "@colyseus/schema";
import { Tile } from "./tile.js";

// El pozo. Este nodo solo se INSTANCIA en los modos que tienen pozo: en 4P la rama
// `RoundState.boneyard` queda ausente (ver el comentario de `RoundState`).
// `count` es un campo derivado PERMITIDO por el criterio de `PlacedTile`: su fuente
// (`tiles`) está gateada, así que el cliente no tiene de dónde contarla.
// `count` es público (el front lo muestra); `tiles` es de vista y
// NUNCA se le agrega a ninguna audiencia, así que el dominio las tiene y
// nadie las ve. Es la forma de dejar la fuente de verdad en el árbol
// sin sincronizarla (spec §7.1).
export const BoneyardState = schema(
  { count: t.number().default(0), tiles: t.array(Tile).view() },
  "BoneyardState",
);
export type BoneyardState = SchemaType<typeof BoneyardState>;
```

```ts
// src/features/match/core/state/round.ts
import { type SchemaType, schema, t } from "@colyseus/schema";
import { BoardState } from "./board.js";
import { BoneyardState } from "./boneyard.js";

// UN EJE, UN CAMPO (spec §7.1): la fase reemplaza los booleanos del v1
// (isRoundFinished + bloqueo derivado + roundEndReason codificaban lo mismo tres veces).
//
// UNA FASE ES UN ESTADO QUE ESPERA ALGO —input, o el vencimiento de su plazo—.
//
// `DEALING` es la VENTANA DE REPARTO (reglas §3.1): al empezar la partida las fichas se
// reparten pero NO se hacen públicas, y cada jugador levanta las suyas con `REVEAL_TILES`
// dentro de 15 s. Mientras falte alguien la ronda no arranca; al vencer, el que no las
// levantó se retira. Es de la RONDA 1 nada más: de la 2 en adelante el reparto revela
// solo. Portado de truco (negocio v27 §12.7).
//
// Es la fase que hace que esperar sea observable, así que existe de verdad: repartir sí
// es síncrono, pero *esperar a que los dos estén ahí* no.
export type RoundPhase = "DEALING" | "PLAYING" | "PRESENTING_ROUND";
export type RoundEndReason = "DOMINO" | "BLOCKED";

// El turno: de quién es, y en qué tramo del plazo va. El instante de vencimiento vive
// UNIFICADO en `MatchState.activeDeadline` —no acá—, así que no hay `startedAt`: sería
// un segundo timestamp del mismo turno y nadie lo leería.
//
// `isConsumingExtendedTime` es el DISCRIMINADOR del front: los dos tramos (el normal y
// el de la reserva extra) ocurren con la misma `phase`, así que sin este campo el cliente
// ve una cuenta atrás y no sabe cuál de los dos está mirando.
//
// `consecutivePasses` es la ÚNICA huella que un pase deja en el estado: pasar no pone
// ficha en el tablero ni saca del pozo, así que sin este contador el rival no tiene de
// dónde enterarse (el historial de Mongo NO se sincroniza — spec §5.1).
export const Turn = schema(
  {
    playerId: t.string(),
    isConsumingExtendedTime: t.boolean().default(false),
    consecutivePasses: t.number().default(0),
  },
  "Turn",
);
export type Turn = SchemaType<typeof Turn>;

export const RoundSummary = schema(
  {
    roundNumber: t.number(),
    winnerId: t.string(),
    winnerTeamId: t.string(),
    points: t.number(),
    reason: t.string(),
  },
  "RoundSummary",
);
export type RoundSummary = SchemaType<typeof RoundSummary>;

// `starterId` es quién abrió ESTA ronda. No es adorno: la regla de secuencia
// (reglas §4.1) es que la ronda siguiente la abre el rival de quien abrió la anterior,
// así que sin este campo no hay de dónde sacar la alternancia una vez que el turno se
// movió. El v1 lo tenía (`currentRoundStarterId`); el doble-seis solo decide la RONDA 1.
//
// `boneyard` es una RAMA NULA (doctrina de truco, negocio §4.1: "ramas nulas para flujos
// condicionales; su ausencia codifica el caso"). AUSENTE = este modo no tiene pozo, que
// es exactamente 4P (4×7 = 28 = el set entero). Si estuviera siempre presente, un 4P
// arrancaría con `count: 0` y "modo sin pozo" sería indistinguible de "pozo agotado" —
// y esos dos casos son justo donde la tranca se calcula distinto (reglas §3.7).
export const RoundState = schema(
  {
    roundNumber: t.number(),
    phase: t.string().default("DEALING"),
    starterId: t.string(),
    // SIN `.optional()`: una ronda siempre tiene tablero, así que auto-instanciar es correcto.
    board: t.ref(BoardState),
    // CON `.optional()`, y es obligatorio para que la rama nula exista: un `t.ref()` sin
    // `.optional()` se AUTO-INSTANCIA (ver la nota del Step 5), y un pozo siempre presente
    // con `count: 0` hace indistinguible "este modo no tiene pozo" de "el pozo se agotó".
    boneyard: t.ref(BoneyardState).optional(),
    // CON `.optional()`: la instancia el arranque de la ronda, no la construcción del nodo.
    currentTurn: t.ref(Turn).optional(),
  },
  "RoundState",
);
export type RoundState = SchemaType<typeof RoundState>;
```

```ts
// src/features/match/core/state/match.ts
import { type SchemaType, schema, t } from "@colyseus/schema";
import { PlayerState } from "./player.js";
import { RoundState, RoundSummary } from "./round.js";

// DOS PALABRAS, DOS HECHOS (truco negocio v26, changelog "Revancha" §3). `RESOLVED` es el
// VEREDICTO —el juego dictaminó— y por eso vive SOLO en eventos (`ROUND_RESOLVED`,
// `MATCH_RESOLVED`); `FINISHED` es el terminal de ESTA MÁQUINA —no queda nada por hacer en
// esta mesa— y por eso vive SOLO en fases. Coinciden mientras la partida se apaga al
// dictaminarse; la REVANCHA los separa, y ahí el nombre repetido pasa a mentir. Truco lo
// pagó y lo renombró: acá se nace con la separación hecha.
//
// `FINISHED` es el ÚNICO terminal, y NO hay un `ABORTED` que lo acompañe: una partida que
// muere sin veredicto no es una transición del juego, es la sala que se muere. Eso lo
// cuenta `MATCH_ABORTED`, que es evento de PLATAFORMA (network/events.ts).
//
// Las dos fases de la REVANCHA (`REMATCH_WINDOW`, `REMATCH_NEGOTIATION`) van DESPUÉS del
// veredicto y ANTES del terminal. NO entran en esta rebanada, pero el enum está ordenado
// para recibirlas sin renombrar nada: es la razón entera de haber separado las palabras.
export type MatchPhase = "NOT_STARTED" | "PLAYING" | "PRESENTING_MATCH" | "FINISHED";

export const Scoreboard = schema(
  { teamA: t.number().default(0), teamB: t.number().default(0) },
  "Scoreboard",
);
export type Scoreboard = SchemaType<typeof Scoreboard>;

// Raíz persistente de la partida. `currentRound` se REEMPLAZA entera cada ronda;
// de las pasadas solo sobrevive el resumen. El detalle completo vive en el
// historial de Mongo (spec §5).
// El `seed` NO está acá — vive en DominoMatchConfig, inyectado (spec §7.1).
//
// `activeDeadline` es UN SOLO campo: un solo plazo temporizado a la vez. Es un instante
// ABSOLUTO en **epoch ms del servidor**, no un resto que baje. Dos consecuencias:
//   · El servidor no lo re-emite nunca: se estampa una vez por transición. Ahí muere el
//     patch por segundo del v1.
//   · El front tiene que restarle "ahora", y su propio reloj puede estar corrido. Por eso
//     `GET /config/:roomId` devuelve `serverNow`: con eso calcula el offset una vez.
// Es epoch y no la timeline de la sala a propósito — ver spec §7.4.
export const MatchState = schema(
  {
    phase: t.string().default("NOT_STARTED"),
    // Los dos con `.optional()`: los instancia la génesis y el arranque de ronda
    // respectivamente. Sin él se auto-instancian y `currentRound` nunca sería `undefined`,
    // así que "todavía no hay ronda" dejaría de ser un estado representable.
    scoreboard: t.ref(Scoreboard).optional(),
    players: t.array(PlayerState),
    currentRound: t.ref(RoundState).optional(),
    pastRounds: t.array(RoundSummary),
    pointsToWin: t.number().default(0),
    activeDeadline: t.number().default(0),
    startedAt: t.number().default(0),
  },
  "MatchState",
);
export type MatchState = SchemaType<typeof MatchState>;
```

```ts
// src/features/match/core/state/index.ts
export * from "./board.js";
export * from "./boneyard.js";
export * from "./match.js";
export * from "./player.js";
export * from "./round.js";
export * from "./tile.js";
```

- [ ] **Step 5: Correr el test hasta que pase**

Run: `npx vitest run src/features/match/core/state/state.test.ts`
Expected: los 5 tests PASAN — los cuatro del árbol más el de la rama nula. El del cap de 63 campos
se borró; la nota de abajo explica por qué no protegía nada.

> **⚠ `t.ref()` NO arranca en `undefined`: AUTO-INSTANCIA.** La primera redacción de esta tarea
> afirmaba lo contrario y estaba mal. En `@colyseus/schema` 5, un `t.ref(X)` sin `.default()` se
> auto-instancia al construir el padre (`annotations.ts`, `makeAutoDefaultFactory`) siempre que `X`
> tenga constructor sin argumentos — que es el caso de todas las clases de este árbol. Verificado
> ejecutándolo, no leyéndolo.
>
> **Y eso rompe la rama nula, que es una decisión de diseño, no un detalle.** Sin `.optional()`, un
> `RoundState.boneyard` existiría SIEMPRE como `{count: 0}`, y ahí "este modo no tiene pozo" (4P
> reparte las 28) vuelve a ser indistinguible de "el pozo se agotó" — exactamente el caso que la rama
> nula existe para separar, y exactamente donde la tranca se calcula distinto.
>
> Llevan `.optional()`, entonces: `MatchState.scoreboard`, `MatchState.currentRound`,
> `RoundState.currentTurn` y `RoundState.boneyard`.
>
> **NO lo llevan `RoundState.board` ni `PlayerState.hand`**, y la asimetría es el punto: una ronda
> siempre tiene tablero y un jugador siempre tiene mano. Solo algunos modos tienen pozo.
>
> **Consecuencia para la génesis (Tarea 6): tiene que instanciar explícitamente `scoreboard`,
> `currentRound`, `currentTurn` y —condicionalmente— `boneyard`.** Ya no vienen gratis.

> **El cap de 63 campos lo hace cumplir la librería, no un test.** `Metadata.defineField` lanza
> cuando el índice llega a 63, e incluye los heredados, así que pasarse **revienta al importar** — no
> en runtime. La primera redacción tenía acá un test que contaba `Object.keys(node.toJSON()).length`,
> y era doblemente inútil: `toJSON()` omite los campos `undefined` (un `PlayerState` recién construido
> declara 8 campos y devuelve 5 claves), y un test no puede ser lo primero que falla cuando el import
> ya crashea. Se borró. El hecho que ese test buscaba proteger es esta nota.

- [ ] **Step 6: Correr la suite completa y commitear**

```bash
npm run typecheck && npm test
git add src/features/match/core
git commit -m "feat(state): árbol de estado con la API builder de schema 5

La mano es un nodo MIXTO: tileCount público, tiles de vista. Es lo que cierra el
agujero del v1, donde players era un MapSchema completo y cada cliente recibía la
mano exacta de sus rivales.

El pozo usa el mismo mecanismo al revés: tiles de vista sin audiencia, así que el
dominio las tiene y nadie las ve.

Fuera del estado, deliberadamente: name, lastname, username, currency, y el seed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 5: Los puertos del engine y la jerarquía de errores

**Files:**
- Create: `src/features/match/core/engine/clock.ts`, `.../timeout-scheduler.ts`, `.../visibility.ts`, `.../errors.ts`, `.../driver.ts`, `src/features/match/core/config.ts`, `src/features/match/core/events.ts`
- Test: `src/features/match/core/engine/errors.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// src/features/match/core/engine/errors.test.ts
import { describe, expect, it } from "vitest";
import { DominoError, InvariantViolationError, RuleViolationError } from "./errors.js";

describe("jerarquía de errores", () => {
  it("una violación de regla lleva un código para la UI y los logs", () => {
    const error = new RuleViolationError("NOT_YOUR_TURN");
    expect(error.code).toBe("NOT_YOUR_TURN");
    expect(error).toBeInstanceOf(DominoError);
    expect(error).toBeInstanceOf(Error);
  });

  it("una invariante rota es un bug, y se distingue por su clase", () => {
    const error = new InvariantViolationError("no hay ronda en curso");
    expect(error).toBeInstanceOf(DominoError);
    expect(error).not.toBeInstanceOf(RuleViolationError);
  });

  it("el nombre de la clase sobrevive, para que el log sea legible", () => {
    expect(new RuleViolationError("NOT_YOUR_TURN").name).toBe("RuleViolationError");
    expect(new InvariantViolationError("x").name).toBe("InvariantViolationError");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/features/match/core/engine/errors.test.ts`
Expected: FAIL con `Failed to resolve import "./errors.js"`.

- [ ] **Step 3: Escribir los puertos y los errores**

```ts
// src/features/match/core/engine/errors.ts
export abstract class DominoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// El jugador intentó algo ilegal. Se traduce a un mensaje al cliente; NO cierra la partida
// y NO entra al historial (spec §5.1): va al log como rastro antifraude.
export type RuleViolationCode =
  | "NOT_PLAYING"
  | "NOT_YOUR_TURN"
  | "TILE_NOT_IN_HAND"
  | "TILE_NOT_PLAYABLE"
  | "SIDE_NOT_PLAYABLE"
  | "MUST_PLAY_INSTEAD_OF_DRAWING"
  | "MUST_DRAW_INSTEAD_OF_PASSING"
  | "BONEYARD_EMPTY"
  // Los dos de la ventana de reparto (reglas §3.1): levantar fichas fuera de la ventana,
  // y levantarlas dos veces.
  | "NOT_DEALING"
  | "TILES_ALREADY_SEEN"
  | "MATCH_NOT_IN_PROGRESS";

export class RuleViolationError extends DominoError {
  constructor(readonly code: RuleViolationCode) {
    super(`Regla violada: ${code}`);
  }
}

// El estado dejó de ser confiable. Es un bug: la política de errores lo traduce a
// cerrar la partida (spec §10).
export class InvariantViolationError extends DominoError {}
```

```ts
// src/features/match/core/engine/clock.ts
// El negocio usa el reloj SOLO para escribir: calcula `now() + duración` y lo estampa
// en MatchState.activeDeadline. NUNCA lee el tiempo para decidir, así que no compara
// now() contra un deadline (spec §3.4 de truco).
export interface Clock {
  now(): number;
}
```

```ts
// src/features/match/core/engine/timeout-scheduler.ts
import type { MatchEvent } from "../events.js";

// Puerto de SALIDA. El engine, al final de cada transición, le pasa el instante vigente
// y —por callback opaco— la transición a correr al vencer. La infraestructura solo espera
// y difunde: no lee fases ni deadlines.
export interface TimeoutScheduler {
  schedule(at: number, onExpire: () => readonly MatchEvent[]): void;
  cancel(): void;
}
```

```ts
// src/features/match/core/engine/visibility.ts
import type { Schema } from "@colyseus/schema";
import type { PlayerId } from "../ids.js";

// La audiencia es de DOMINIO: un JUGADOR o la mesa, nunca una conexión. Eso es lo que
// permite que la vista sea del ASIENTO y no del socket (spec §7.3).
//
// SON DOS Y NO TRES: no hay audiencia de EQUIPO, porque en dominó no existe ninguna
// mecánica que le muestre algo a tu compañero y no a la mesa. Truco tiene tres —el
// intercambio de carta entre compañeros, la flor, el pegado—, y de ahí venía la tercera
// rama en la primera redacción de este plan: una `case "TEAM"` inalcanzable, con un test
// afirmando que lanzaba. Estado especulativo con test propio.
//
// Si algún día apareciera un modo de dominó con señas legales entre compañeros, la rama
// se agrega acá y el compilador señala los dos sitios que la tienen que resolver.
export type Audience = { kind: "PLAYER"; playerId: PlayerId } | { kind: "ALL" };

// El dominio ordena "hacé público este nodo a esta audiencia"; el puerto hace el view.add.
// El dominio nunca toca client.view.
export interface SchemaVisibilityController {
  makePublic(node: Schema, audience: Audience): void;
  hide(node: Schema, audience: Audience): void;
}
```

```ts
// src/features/match/core/engine/driver.ts
import type { MatchEvent } from "../events.js";
import type { PlayerId } from "../ids.js";

export interface TransitionResult {
  readonly events: readonly MatchEvent[];
  readonly finished: boolean;
}

// QUÉ hizo el actor. El conductor lo necesita porque las acciones reconcilian
// distinto: jugar puede cerrar la mano por dominó y pasa el turno; robar conserva
// el turno pero reinicia el plazo (reglas §7 decisión 4); pasar puede destapar una
// tranca. `ABANDONED` reconcilia igual que `PASSED` —el que se va tiene fichas, así
// que no cierra por dominó— pero se nombra aparte para que el conductor no tenga
// que mentir sobre qué pasó.
// `REVEALED` no es una jugada: es la salida de la ventana de reparto (reglas §3.1). Está
// en la misma unión porque entra por el mismo `advance`, pero se reconcilia ANTES que
// todo lo demás y no llega a la guarda de `PLAYING` —es la única fase, además de esa, en
// la que un verbo de jugador es legal—.
export type RoundAction = "PLAYED" | "DREW" | "PASSED" | "ABANDONED" | "REVEALED";

// La superficie pública de un conductor son estos tres verbos y nada más.
// `advance` recibe QUIÉN actuó y QUÉ hizo: sin lo primero no puede saber si el
// actor sigue en la mano, y sin lo segundo tendría que adivinar la reconciliación
// comparando el estado contra sí mismo.
export interface Driver {
  begin(): void;
  advance(actorId: PlayerId, action: RoundAction): TransitionResult;
  timeout(): TransitionResult;
}
```

```ts
// src/features/match/core/events.ts
import type { PlayerId, TeamId } from "./ids.js";

// A qué ventana sirve el único plazo del juego. Un solo campo en el estado
// ⇒ un solo evento de vencimiento y un solo eje que lo discrimine.
//
// `DEALING` es la ventana de reparto (reglas §3.1). Es de nivel RONDA como el turno, pero
// a diferencia del turno **no es de nadie en particular**: corre para todos a la vez, y
// eso es exactamente para lo que existe —el reloj del turno solo mira al que le toca—.
export type DeadlineKind = "DEALING" | "TURN" | "PRESENTING_ROUND" | "PRESENTING_MATCH";

// EL CRITERIO (spec §5.1): un evento existe SOLO si ocurre un hecho que no se puede
// reconstruir del comando ni del estado resultante. Si el payload del evento solo
// repetiría el del comando, no es un evento.
//
// Por eso PLAY_TILE y PASS dichos por el JUGADOR no están acá: el comando ya es el
// registro. Los mismos verbos SÍ aparecen cuando los dice el SISTEMA por quien calló,
// porque ahí no hay comando que los cuente. El evento existe ⟺ no hubo comando detrás.
export type MatchEvent =
  // ── Consecuencias computadas ────────────────────────────────────────────
  | { type: "ROUND_RESOLVED"; roundNumber: number; winnerId: PlayerId; winnerTeamId: TeamId; points: number; reason: "DOMINO" | "BLOCKED" }
  // ── Lo que el SISTEMA hizo ──────────────────────────────────────────────
  | { type: "DEADLINE_EXPIRED"; kind: DeadlineKind }
  // Retirado POR TIMEOUT, nunca por el verbo voluntario. Es el caso canónico de
  // "el evento existe ⟺ no hubo comando detrás": el ABANDON voluntario ya quedó
  // registrado como comando, así que emitirlo encima sería la transcripción 1:1
  // que el criterio prohíbe. Éste, en cambio, no lo pidió nadie — y para soporte
  // es toda la diferencia entre "se fue" y "lo sacaron".
  | { type: "ABANDON"; playerId: PlayerId }
  // ── Hitos terminales ────────────────────────────────────────────────────
  | { type: "MATCH_RESOLVED"; winnerTeamId: TeamId; reason: "SCORE" | "ABANDONMENT" };
```

```ts
// src/features/match/core/config.ts
// Value-object INMUTABLE, fuera del estado de Colyseus e inyectado por DI.
// Acá vive el `seed`: hace el reparto determinista y reproducible, y como no está
// en el árbol no hay superficie por donde filtrarse al cliente (spec §7.1).
// Cómo se forman las parejas. Hoy el producto pide SHUFFLED; cambiar de modelo es
// cambiar este valor en la config del modo de juego, sin tocar el motor (spec §4.3).
export type TeamAssignmentMode = "SHUFFLED" | "SEAT_ORDER";

export interface DominoMatchConfig {
  readonly matchId: string;
  readonly gameModeId: string;
  readonly seed: string;
  readonly seats: readonly string[];
  readonly pointsToWin: number;
  readonly teamAssignment: TeamAssignmentMode;
  /**
   * ¿La mano se reparte tapada y hay que pedirla? (reglas §3.1). A diferencia de
   * `teamAssignment` **no depende del modo ni de los asientos**: va en toda mesa, porque
   * es el control de presencia del arranque. Es config igual, por dos razones: producto
   * tiene que poder apagarla sin deploy, y los tests de integración del motor —que
   * prueban la tranca o el conteo, no esto— no tienen por qué pagar la ceremonia.
   */
  readonly isDealWindowEnabled: boolean;
}

export interface GlobalDominoConfig {
  /** El plazo normal del turno. Se reinicia en cada turno. */
  readonly turnTimeoutMs: number;
  /**
   * La RESERVA de tiempo extra con la que cada jugador arranca la partida. NO es una
   * gracia por turno: es un saldo que solo decrece durante toda la partida (reglas §5.1,
   * decisión 7). El arranque lo siembra en `PlayerState.extraTimeRemainingMs`.
   */
  readonly extraTimeReserveMs: number;
  /**
   * La VENTANA DE REPARTO (reglas §3.1): cuánto tiene cada uno para levantar sus fichas
   * al empezar la partida. Es el plazo más corto de la mesa y el único que controla a
   * TODOS a la vez —el del turno solo mira al que le toca jugar—, y por eso es el que
   * agarra al que se sentó, vio lo que le tocó y se fue.
   */
  readonly dealingTimeoutMs: number;
  readonly presentingRoundMs: number;
  readonly presentingMatchMs: number;
  readonly seatingTimeoutMs: number;
  readonly tilesPerPlayer: number;
}

// Los plazos son los del v1, verificados en docs/reglas-de-juego-v1.md §5.1: 60 s de
// turno, idénticos en 2P, 4P y torneo. Los 30 s de gracia del v1 se conservan como
// CANTIDAD pero cambian de MODELO —de gracia por turno a reserva por partida—, que es
// un cambio deliberado escrito en el documento de reglas (decisión 7).
export const DEFAULT_GLOBAL_CONFIG: GlobalDominoConfig = {
  turnTimeoutMs: 60_000,
  extraTimeReserveMs: 30_000,
  // El número del v1 (`initialTilesTimeRemaining`).
  dealingTimeoutMs: 15_000,
  presentingRoundMs: 6_000,
  presentingMatchMs: 6_000,
  seatingTimeoutMs: 30_000,
  tilesPerPlayer: 7,
};
```

`presentingRoundMs` y `presentingMatchMs` son los `sleep(6000)` del v1, convertidos en **config de una
fase con plazo**. El motor no espera: estampa el instante y sigue.

> **La reserva de tiempo extra no es la gracia del v1, y el cambio es a propósito.** El v1 reinicia
> los 30 s en cada turno, así que un jugador que se cuelga en los diez turnos se lleva 300 s gratis.
> Acá los 30 s son el saldo de **toda** la partida: se consumen una vez y no vuelven. Es el modelo de
> truco (`PlayerState.extraTimeRemainingMs`, "solo decrece"), y es lo que hace que el campo tenga que
> vivir en el estado y no en config — un saldo con memoria no es un parámetro.

- [ ] **Step 3b: Los dos campos que el tiempo extra necesita en el estado**

Ya están declarados en la Tarea 4: `PlayerState.extraTimeRemainingMs` (el saldo) y
`Turn.isConsumingExtendedTime` (el discriminador para el front). El segundo existe porque los dos
tramos del plazo ocurren con la misma `phase`: sin él, el cliente ve una cuenta atrás en
`activeDeadline` y no sabe si está mirando los 60 s del turno o lo que queda de la reserva.

> **`teamAssignment` es obligatorio y sin default, a propósito.** Las tareas siguientes construyen
> `DominoMatchConfig` en trece lugares (fixtures de test, `configOf`, `DominoRoomOptions`, el meta del
> replay y el golden). Todos necesitan el campo, y **el compilador los señalaría uno por uno** — es la
> misma garantía que da `satisfies` en el catálogo de verbos. Para las mesas de dos asientos el valor
> da igual (las dos políticas dan `["A", "B"]`); el de producción es `"SHUFFLED"`, y **los trece
> bloques de este plan ya lo traen**, así que copiarlos no deja el typecheck en rojo.

- [ ] **Step 4: Correr el test hasta que pase**

Run: `npx vitest run src/features/match/core/engine/errors.test.ts`
Expected: los 3 tests PASAN.

- [ ] **Step 5: Verificar que el core no rompió ninguna regla de imports**

Run: `npm test`
Expected: TODO pasa, incluido `src/architecture.test.ts`. `visibility.ts` importa `@colyseus/schema`,
que es la excepción documentada de la Regla 2 — el test `core SÍ puede importar @colyseus/schema` es
el que lo cubre.

- [ ] **Step 6: Commit**

```bash
git add src/features/match/core
git commit -m "feat(engine): los tres puertos, la jerarquía de errores y el contrato de Driver

Clock es write-only para el negocio: estampa now()+duración en activeDeadline y
nunca compara el tiempo para decidir. TimeoutScheduler invierte el control (el
engine programa, la infra solo espera y difunde). La audiencia de visibilidad es
de dominio —un jugador o la mesa, nunca una conexión—, que es lo que permite que
la vista sea del asiento. Son dos valores y no tres: en dominó no hay nada que se
le muestre a tu compañero y no a la mesa (reglas §3.1.1).

MatchEvent con el criterio de existencia escrito: el evento existe si y solo si
no hubo comando detrás.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 6: Génesis, política de equipos y proyecciones puras

**Files:**
- Create: `src/features/match/core/engine/team-assignment.ts`, `.../genesis.ts`, `.../state-projections.ts`
- Test: `.../tests/team-assignment.test.ts`, `.../tests/genesis.test.ts`, `.../tests/state-projections.test.ts`

> **La política de equipos es lo que decide cómo se forman las parejas** (spec §4.3). El producto pide
> **sorteo aleatorio**, y la palanca para cambiar a parejas por asiento es un valor de config, no un
> cambio de código. **Restricción no negociable: el sorteo se deriva del `seed`.** El v1 mezcla con
> `Math.random()` (`four-players/commands/on-ready.ts:70-101`), así que las parejas de una partida
> jugada no se pueden reconstruir — y sin eso el replay de la Tarea 21 no reproduce nada.

> **⚠ HERENCIA DE LA TAREA 4: los `t.ref()` con `.optional()` ya no vienen instanciados.** Los cuatro
> campos que llevan `.optional()` en el árbol —`MatchState.scoreboard`, `MatchState.currentRound`,
> `RoundState.currentTurn`, `RoundState.boneyard`— arrancan en `undefined` **a propósito**, porque
> `t.ref()` sin `.optional()` se auto-instancia y eso rompería la rama nula del pozo.
>
> Así que `createMatchState` tiene que instanciar `scoreboard` explícitamente, y quien arranca la
> ronda tiene que instanciar `board`, `currentTurn` y —solo si la mesa tiene pozo— `boneyard`. Lo que
> **no** hay que instanciar es lo que no lleva `.optional()`: `board` y `hand` ya vienen.
>
> Si esto se olvida, el síntoma no es un `undefined` prolijo: es un `TypeError` la primera vez que
> alguien lea `match.scoreboard.teamA`.

> **⚠ ORDEN: esta tarea necesita `src/shared/rng.ts`, que la primera redacción creaba recién en la
> Tarea 15.** `team-assignment.ts` importa `hashSeed`/`mulberry32`/`shuffled` para derivar el sorteo
> del `seed`, así que sin ese módulo la tarea no puede quedar verde. Se descubrió ejecutando: el plan
> ponía al consumidor quince tareas antes que a su dependencia.
>
> **`rng.ts` y su test se crean acá, en el Step 0, y la Tarea 15 pasa a solo consumirlos.** Es el
> orden correcto de todas formas: el primer consumidor es quien lo necesita, y el `Dealer` de la
> Tarea 15 es el segundo.

- [ ] **Step 0: El RNG sembrado (movido desde la Tarea 15)**

Portable y sin dominio: FNV-1a de 32 bits sobre `${seed}:${round}`, `mulberry32` como PRNG sin estado
compartido, y un Fisher-Yates sobre una copia. Lo que hace posible el replay es que **cada llamada a
`mulberry32` devuelve una secuencia nueva desde su semilla**, así que cada ronda es reproducible de
forma aislada y no depende del orden de consumo de ningún generador global.

El test (`src/shared/rng.test.ts`) y la implementación (`src/shared/rng.ts`) están escritos completos
en la **Tarea 15, Steps 1 y 2** — se copian de ahí tal cual. Son 7 tests.

Run: `npx vitest run src/shared/rng.test.ts` → los 7 PASAN antes de seguir.

- [ ] **Step 0a: Escribir el test de la política de equipos**

```ts
// src/features/match/core/engine/tests/team-assignment.test.ts
import { describe, expect, it } from "vitest";
import { assignTeams } from "../team-assignment.js";

const seats4 = ["u1", "u2", "u3", "u4"];

describe("assignTeams — SEAT_ORDER", () => {
  it("alterna por índice de asiento", () => {
    expect(assignTeams(seats4, "SEAT_ORDER", "s")).toEqual(["A", "B", "A", "B"]);
  });

  it("no depende del seed", () => {
    expect(assignTeams(seats4, "SEAT_ORDER", "uno")).toEqual(
      assignTeams(seats4, "SEAT_ORDER", "dos"),
    );
  });
});

describe("assignTeams — SHUFFLED", () => {
  it("reparte exactamente la mitad a cada equipo", () => {
    const teams = assignTeams(seats4, "SHUFFLED", "seed-x");
    expect(teams.filter((team) => team === "A")).toHaveLength(2);
    expect(teams.filter((team) => team === "B")).toHaveLength(2);
  });

  // LA RESTRICCIÓN QUE HACE POSIBLE EL REPLAY. Sin esto, una partida jugada no se
  // puede reconstruir porque las parejas fueron un Math.random() que nadie guardó.
  it("es determinista: mismo seed, mismas parejas", () => {
    expect(assignTeams(seats4, "SHUFFLED", "seed-x")).toEqual(
      assignTeams(seats4, "SHUFFLED", "seed-x"),
    );
  });

  it("distinto seed da (en general) parejas distintas", () => {
    const seeds = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const results = new Set(seeds.map((seed) => assignTeams(seats4, "SHUFFLED", seed).join("")));
    // Con 8 semillas y 3 emparejamientos posibles, ver uno solo sería un PRNG roto.
    expect(results.size).toBeGreaterThan(1);
  });

  it("no depende del orden en que vengan los asientos para ser válido", () => {
    const teams = assignTeams(["z", "y", "x", "w"], "SHUFFLED", "seed-x");
    expect(teams).toHaveLength(4);
    expect(new Set(teams)).toEqual(new Set(["A", "B"]));
  });
});

describe("assignTeams — 2 asientos", () => {
  // Con dos jugadores las dos políticas coinciden: uno de cada equipo, siempre.
  it("los dos modos dan lo mismo", () => {
    expect(assignTeams(["u1", "u2"], "SEAT_ORDER", "s")).toEqual(["A", "B"]);
    expect(assignTeams(["u1", "u2"], "SHUFFLED", "s")).toEqual(["A", "B"]);
  });
});

describe("assignTeams — bordes", () => {
  it("una cantidad impar de asientos rompe la invariante", () => {
    expect(() => assignTeams(["u1", "u2", "u3"], "SHUFFLED", "s")).toThrow();
  });

  it("cero asientos rompe la invariante", () => {
    expect(() => assignTeams([], "SEAT_ORDER", "s")).toThrow();
  });
});
```

- [ ] **Step 0b: Correr el test para verificar que falla, y escribir la política**

Run: `npx vitest run src/features/match/core/engine/tests/team-assignment.test.ts`
Expected: FAIL con `Failed to resolve import "../team-assignment.js"`.

```ts
// src/features/match/core/engine/team-assignment.ts
// CÓMO SE FORMAN LAS PAREJAS. Pura, y el único lugar del motor que lo decide.
//
// El producto pide sorteo aleatorio; truco usa orden de asiento. Las dos formas
// viven acá y se eligen por config, así que cambiar de modelo no toca el motor.
// El día que aparezcan parejas elegidas por los jugadores o armadas por ranking,
// es un caso más en este switch.
import { hashSeed, mulberry32, shuffled } from "../../../../shared/rng.js";
import type { TeamAssignmentMode } from "../config.js";
import type { PlayerId, TeamId } from "../ids.js";
import { InvariantViolationError } from "./errors.js";

export function assignTeams(
  seats: readonly PlayerId[],
  mode: TeamAssignmentMode,
  seed: string,
): readonly TeamId[] {
  if (seats.length === 0 || seats.length % 2 !== 0) {
    throw new InvariantViolationError(`una mesa necesita un número par de asientos, no ${seats.length}`);
  }

  if (mode === "SEAT_ORDER") return seats.map((_, index) => teamAt(index));

  // SHUFFLED: se permutan las POSICIONES y se reparte A/B sobre la permutación.
  // Determinista desde el seed —el mismo PRNG que el Dealer— así que para el
  // jugador es indistinguible del azar y para el servidor es reproducible.
  const permutation = shuffled(
    seats.map((_, index) => index),
    mulberry32(hashSeed(seed, TEAM_DRAW_ROUND)),
  );
  const teams: TeamId[] = new Array(seats.length);
  permutation.forEach((seatIndex, position) => {
    teams[seatIndex] = teamAt(position);
  });
  return teams;
}

// El sorteo de equipos consume su propia "ronda" del seed, así que no le roba
// entropía a ningún reparto ni cambia si se juega una mano más.
const TEAM_DRAW_ROUND = -1;

function teamAt(index: number): TeamId {
  return index % 2 === 0 ? "A" : "B";
}
```

Run el test de nuevo.
Expected: los 9 tests PASAN.

- [ ] **Step 1: Escribir el test de la génesis**

```ts
// src/features/match/core/engine/tests/genesis.test.ts
import { describe, expect, it } from "vitest";
import type { DominoMatchConfig } from "../../config.js";
import { createMatchState } from "../genesis.js";
// El test compara contra la política DIRECTAMENTE, y por eso la importa: así afirma que la
// génesis la DELEGA en vez de reimplementar `i % 2` y coincidir por casualidad.
import { assignTeams } from "../team-assignment.js";

const config = (
  seats: string[],
  overrides: Partial<DominoMatchConfig> = {},
): DominoMatchConfig => ({
  matchId: "m1",
  gameModeId: "clasica-2p",
  seed: "seed-1",
  seats,
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  isDealWindowEnabled: false,
  ...overrides,
});

describe("createMatchState", () => {
  it("sienta a los jugadores en el orden de seats", () => {
    const match = createMatchState(config(["u1", "u2"]));
    expect(match.players.map((p) => p.playerId)).toEqual(["u1", "u2"]);
    expect(match.players.map((p) => p.seatIndex)).toEqual([0, 1]);
  });

  // La génesis NO decide los equipos: los delega en la política (spec §4.3). Lo que
  // este test protege es que los delegue de verdad y no reimplemente `i % 2`.
  it("aplica la política de equipos que dice el config", () => {
    const seats = ["u1", "u2", "u3", "u4"];
    const bySeat = createMatchState(config(seats, { teamAssignment: "SEAT_ORDER" }));
    expect(bySeat.players.map((p) => p.teamId)).toEqual(["A", "B", "A", "B"]);

    const shuffledMatch = createMatchState(config(seats, { teamAssignment: "SHUFFLED" }));
    expect(shuffledMatch.players.map((p) => p.teamId)).toEqual(
      assignTeams(seats, "SHUFFLED", "seed-1"),
    );
  });

  it("con el mismo seed, las parejas sorteadas son siempre las mismas", () => {
    const seats = ["u1", "u2", "u3", "u4"];
    expect(createMatchState(config(seats)).players.map((p) => p.teamId)).toEqual(
      createMatchState(config(seats)).players.map((p) => p.teamId),
    );
  });

  it("arranca en NOT_STARTED, sin ronda y sin marcador", () => {
    const match = createMatchState(config(["u1", "u2"]));
    expect(match.phase).toBe("NOT_STARTED");
    expect(match.currentRound).toBeUndefined();
    expect(match.scoreboard.teamA).toBe(0);
    expect(match.scoreboard.teamB).toBe(0);
    expect(match.startedAt).toBe(0);
  });

  it("copia pointsToWin del config", () => {
    const match = createMatchState({ ...config(["u1", "u2"]), pointsToWin: 55 });
    expect(match.pointsToWin).toBe(55);
  });

  it("cada jugador nace con una mano vacía y no revelada", () => {
    const match = createMatchState(config(["u1", "u2"]));
    for (const player of match.players) {
      expect(player.hand.tiles.length).toBe(0);
      expect(player.hand.tileCount).toBe(0);
      expect(player.hand.isRevealed).toBe(false);
      expect(player.connected).toBe(true);
      expect(player.hasAbandoned).toBe(false);
    }
  });

  // La reserva de tiempo extra nace en 0 y la SIEMBRA el arranque de la partida
  // (`MatchDriver.begin`), que es quien tiene el `GlobalDominoConfig`. La génesis
  // recibe solo el config por partida, y no se le agrega un segundo parámetro para
  // esto: la reserva empieza a existir cuando la partida empieza, no cuando se
  // arma la mesa.
  it("la reserva de tiempo extra nace vacía; la siembra el arranque", () => {
    const match = createMatchState(config(["u1", "u2"]));
    for (const player of match.players) {
      expect(player.extraTimeRemainingMs).toBe(0);
    }
  });

  it("el seed NO entra al estado", () => {
    const match = createMatchState(config(["u1", "u2"]));
    expect(JSON.stringify(match.toJSON())).not.toContain("seed-1");
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/features/match/core/engine/tests/genesis.test.ts`
Expected: FAIL con `Failed to resolve import "../genesis.js"`.

- [ ] **Step 3: Escribir `genesis.ts`**

```ts
// src/features/match/core/engine/genesis.ts
import type { DominoMatchConfig } from "../config.js";
import { Hand, MatchState, PlayerState, Scoreboard } from "../state/index.js";
import { InvariantViolationError } from "./errors.js";
import { assignTeams } from "./team-assignment.js";

// El árbol inicial. Vive en el DOMINIO y no en la sala, porque formar la mesa
// —quién se sienta dónde y con quién juega— es una regla del juego.
//
// La génesis NO decide los equipos: se los pide a la política (spec §4.3), que es
// lo que permite cambiar de sorteo a parejas por asiento sin tocar el motor.
export function createMatchState(config: DominoMatchConfig): MatchState {
  const match = new MatchState();
  match.scoreboard = new Scoreboard();
  match.pointsToWin = config.pointsToWin;

  const teams = assignTeams(config.seats, config.teamAssignment, config.seed);

  config.seats.forEach((playerId, seatIndex) => {
    const teamId = teams[seatIndex];
    if (!teamId) throw new InvariantViolationError(`sin equipo para el asiento ${seatIndex}`);

    const player = new PlayerState();
    player.playerId = playerId;
    player.seatIndex = seatIndex;
    player.teamId = teamId;
    player.hand = new Hand();
    match.players.push(player);
  });

  return match;
}
```

El equipo se resuelve **una sola vez, acá**, y queda en el estado. El motor nunca vuelve a
preguntarse de qué equipo es nadie: lo lee de `PlayerState.teamId`.

- [ ] **Step 4: Correr el test hasta que pase**

Run: `npx vitest run src/features/match/core/engine/tests/genesis.test.ts`
Expected: los 8 tests PASAN.

- [ ] **Step 5: Escribir el test de las proyecciones**

```ts
// src/features/match/core/engine/tests/state-projections.test.ts
import { describe, expect, it } from "vitest";
import { BoardState, BoneyardState, RoundState } from "../../state/index.js";
import { InvariantViolationError } from "../errors.js";
import { createMatchState } from "../genesis.js";
import {
  currentRoundOf,
  handOf,
  isRoundActive,
  opponentTeam,
  playerOf,
  teamOf,
  turnOrderFrom,
} from "../state-projections.js";

// SEAT_ORDER y no SHUFFLED, a propósito: este test prueba las PROYECCIONES, no el sorteo.
// Con SHUFFLED las aserciones de abajo (u1→A, u2→B, u3→A) dependerían de que la permutación
// del seed "s" resulte ser la identidad — o sea que pasarían por casualidad, y se romperían
// el día que alguien toque el PRNG. El sorteo tiene su propio test en el Step 0a.
const build = (seats = ["u1", "u2"]) =>
  createMatchState({
    matchId: "m1",
    gameModeId: "g",
    seed: "s",
    seats,
    pointsToWin: 100,
    teamAssignment: "SEAT_ORDER",
    isDealWindowEnabled: false,
  });

describe("proyecciones puras del estado", () => {
  it("teamOf mapea asiento a equipo", () => {
    const match = build(["u1", "u2", "u3", "u4"]);
    expect(teamOf("u1", match)).toBe("A");
    expect(teamOf("u2", match)).toBe("B");
    expect(teamOf("u3", match)).toBe("A");
  });

  it("playerOf lanza una invariante si el jugador no tiene asiento", () => {
    const match = build();
    expect(() => playerOf("intruso", match)).toThrow(InvariantViolationError);
  });

  it("currentRoundOf estrecha el opcional afirmando la invariante", () => {
    const match = build();
    expect(() => currentRoundOf(match)).toThrow(InvariantViolationError);

    const round = new RoundState();
    round.roundNumber = 1;
    round.board = new BoardState();
    round.boneyard = new BoneyardState();
    match.currentRound = round;
    expect(currentRoundOf(match).roundNumber).toBe(1);
  });

  it("isRoundActive es falso para quien abandonó", () => {
    const match = build();
    const player = playerOf("u1", match);
    expect(isRoundActive(player)).toBe(true);
    player.hasAbandoned = true;
    expect(isRoundActive(player)).toBe(false);
  });

  it("opponentTeam invierte, porque solo hay dos equipos", () => {
    expect(opponentTeam("A")).toBe("B");
    expect(opponentTeam("B")).toBe("A");
  });

  it("turnOrderFrom recorre los asientos en ciclo desde uno dado", () => {
    const match = build(["u1", "u2", "u3", "u4"]);
    expect(turnOrderFrom("u3", match).map((p) => p.playerId)).toEqual(["u3", "u4", "u1", "u2"]);
  });

  it("handOf devuelve las fichas del asiento", () => {
    const match = build();
    expect(handOf("u1", match).tiles.length).toBe(0);
  });
});
```

- [ ] **Step 6: Correr el test para verificar que falla**

Run: `npx vitest run src/features/match/core/engine/tests/state-projections.test.ts`
Expected: FAIL con `Failed to resolve import "../state-projections.js"`.

- [ ] **Step 7: Escribir `state-projections.ts`**

```ts
// src/features/match/core/engine/state-projections.ts
// Proyecciones PURAS del árbol. Sin reglas del dominó: solo estructura (asientos,
// equipos, actividad en la mano). No son métodos del Schema —el estado es dato
// inerte— y reciben el MatchState por parámetro, así que no son match-bound.
//
// Convención: el SUJETO va primero y el match al final, salvo cuando el match ES
// el sujeto. Así `teamOf(playerId, match)` se lee "el equipo de playerId en esta partida".
import type { PlayerId, TeamId } from "../ids.js";
import type {
  BoneyardState,
  Hand,
  MatchState,
  MatchPhase,
  PlacedTile,
  PlayerState,
  RoundPhase,
  RoundState,
} from "../state/index.js";
import type { BoardSide } from "../state/tile.js";
import { InvariantViolationError } from "./errors.js";

export function playerOf(playerId: PlayerId, match: MatchState): PlayerState {
  const player = match.players.find((candidate) => candidate.playerId === playerId);
  if (!player) throw new InvariantViolationError(`sin asiento para ${playerId}`);
  return player;
}

export function teamOf(playerId: PlayerId, match: MatchState): TeamId {
  return playerOf(playerId, match).teamId as TeamId;
}

export function handOf(playerId: PlayerId, match: MatchState): Hand {
  return playerOf(playerId, match).hand;
}

// Estrecha el `currentRound?` del schema afirmando la invariante: una vez en juego,
// hay ronda. Extrae a un solo lugar el `require*` que si no se repetiría por actor.
export function currentRoundOf(match: MatchState): RoundState {
  if (!match.currentRound) throw new InvariantViolationError("no hay ronda en curso");
  return match.currentRound;
}

// EL COSTO DE LA RAMA NULA SE PAGA UNA VEZ, ACÁ. `scoreboard` es `.optional()` porque
// `t.ref()` se auto-instancia y el árbol necesita que las ramas nulas sean de verdad
// (Tarea 4). El precio es que con `strict: true` ningún consumidor puede escribir
// `match.scoreboard.teamA += x` — y `?.` no compila del lado de la escritura, así que no
// alcanza con encogerse de hombros en cada call site. Se estrecha una vez y listo.
export function scoreboardOf(match: MatchState): Scoreboard {
  if (!match.scoreboard) throw new InvariantViolationError("no hay marcador");
  return match.scoreboard;
}

// EL POZO ES UNA RAMA NULA, y estas dos proyecciones son la única forma de tocarlo.
//
// `boneyardCountOf` es para PREGUNTAR: ausente y agotado dan 0, que es lo correcto para
// toda regla que quiera saber "¿queda de dónde robar?" — la tranca, el veto de pasar.
// `boneyardOf` es para MUTAR: si no hay rama, robar es un bug, no una jugada ilegal, así
// que revienta la invariante en vez de devolver un vacío que el mutador tendría que mirar.
export function boneyardCountOf(round: RoundState): number {
  return round.boneyard?.count ?? 0;
}

export function boneyardOf(round: RoundState): BoneyardState {
  if (!round.boneyard) throw new InvariantViolationError("esta mesa no tiene pozo");
  return round.boneyard;
}

// NARROWING. Colyseus no sincroniza uniones discriminadas, así que en el árbol los ejes
// son `t.string()` (es lo que truco documenta en negocio §4.1, "schema ancho"). Pero eso
// NO tiene por qué llegar a las reglas: el cast vive acá, en un solo archivo, y de este
// lado todo el motor compara contra uniones cerradas. Sin esto, un `side === "Left"` en
// `boardEndsOf` compila, deriva la cadena por el lado equivocado, y como los extremos son
// derivados el tablero entero queda mal sin que nada reviente.
export function sideOf(placed: PlacedTile): BoardSide {
  return placed.side as BoardSide;
}

export function roundPhaseOf(round: RoundState): RoundPhase {
  return round.phase as RoundPhase;
}

export function matchPhaseOf(match: MatchState): MatchPhase {
  return match.phase as MatchPhase;
}

export function isRoundActive(player: PlayerState): boolean {
  return !player.hasAbandoned;
}

export function roundActivePlayers(match: MatchState): PlayerState[] {
  return match.players.filter(isRoundActive);
}

export function hasTeamAbandoned(teamId: TeamId, match: MatchState): boolean {
  const members = match.players.filter((player) => player.teamId === teamId);
  return members.length > 0 && members.every((player) => player.hasAbandoned);
}

// Solo hay dos equipos.
export function opponentTeam(teamId: TeamId): TeamId {
  return teamId === "A" ? "B" : "A";
}

// El orden de turno es el orden de los asientos, en ciclo, empezando por uno dado.
export function turnOrderFrom(playerId: PlayerId, match: MatchState): PlayerState[] {
  const start = playerOf(playerId, match).seatIndex;
  const total = match.players.length;
  const ordered: PlayerState[] = [];
  for (let offset = 0; offset < total; offset += 1) {
    const seat = (start + offset) % total;
    const player = match.players.find((candidate) => candidate.seatIndex === seat);
    if (!player) throw new InvariantViolationError(`asiento ${seat} vacío`);
    ordered.push(player);
  }
  return ordered;
}
```

- [ ] **Step 8: Correr los tests y commitear**

Run: `npx vitest run src/features/match/core/engine/tests/`
Expected: 25 tests PASAN — 9 de la política, 8 de la génesis y 8 de las proyecciones (las 7 del
bloque más `scoreboardOf`). Los 7 del RNG corren aparte, en `src/shared/rng.test.ts`.

`src/shared` va en el `git add` porque el Step 0 crea `rng.ts` ahí. Sin eso, la tarea commitea el
consumidor y deja la dependencia sin versionar.

```bash
npm run typecheck && npm test
git add src/features/match/core/engine src/shared
git commit -m "feat(engine): génesis del árbol y proyecciones puras del estado

El orden de los asientos ES la asignación de equipos, con test propio: con el
orden equivocado la partida corre perfecto con los compañeros cambiados.

La génesis vive en el dominio, no en la sala, porque repartir equipos es una
regla del juego. En el v1 estaba en la room y duplicada en un fixture de tests.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 7: El primer verbo — `ABANDON`, el trío de PARTIDA y el camino del timer

Un solo verbo, pero atraviesa todo: juez → player → conductor → plazo → evento. Es lo que valida el
espinazo antes de que exista una sola regla de dominó.

**Files:**
- Create: `src/features/match/core/command.ts`, `.../engine/match/player.ts`, `.../match/referee.ts`, `.../match/driver.ts`, `.../match/index.ts`, `.../engine/deadline-kind.ts`, `.../engine/player-repository.ts`, `.../engine/player-facade.ts`, `.../engine/referee-facade.ts`, `src/features/match/core/commands/abandon.ts`, `.../commands/index.ts`
- Test: `src/features/match/core/engine/tests/build-engine.ts`, `.../tests/abandon.test.ts`

- [ ] **Step 1: Escribir `command.ts`**

```ts
// src/features/match/core/command.ts
import type { PlayerId } from "./ids.js";

// El mapa de verbos. Crece de a uno: cada verbo nuevo rompe la compilación en TRES
// lugares —el schema del wire, los decoders y los comandos— cada uno apuntando a lo
// que falta. Eso reemplaza a un test de exhaustividad del catálogo.
export interface CommandPayloads {
  ABANDON: { playerId: PlayerId };
}

export type CommandName = keyof CommandPayloads;
export type CommandPayload<N extends CommandName> = CommandPayloads[N];

// SÍNCRONO POR CONTRATO. Nada que espere red cabe adentro: si no hay await,
// Node no puede entrelazar dos mensajes del mismo cliente (spec §6).
export interface Command<N extends CommandName, TEvent> {
  execute(payload: CommandPayload<N>): readonly TEvent[];
}
```

- [ ] **Step 2: Escribir el fixture del engine**

```ts
// src/features/match/core/engine/tests/build-engine.ts
// Fixture de los tests de engine: arma el grafo de actores sobre un MatchState de
// prueba, SIN tsyringe y sin levantar una Room. Es el espejo del wiring de producción.
import type { DominoMatchConfig, GlobalDominoConfig } from "../../config.js";
import { DEFAULT_GLOBAL_CONFIG } from "../../config.js";
import type { MatchEvent } from "../../events.js";
import type { MatchState } from "../../state/index.js";
import type { Clock } from "../clock.js";
import { createMatchState } from "../genesis.js";
import { MatchDriver } from "../match/driver.js";
import { MatchPlayer } from "../match/player.js";
import { MatchReferee } from "../match/referee.js";
import { Player } from "../player-facade.js";
import { PlayerRepository } from "../player-repository.js";
import { Referee } from "../referee-facade.js";
import type { TimeoutScheduler } from "../timeout-scheduler.js";
import type { SchemaVisibilityController } from "../visibility.js";

export interface EngineHarness {
  readonly match: MatchState;
  readonly players: Player;
  readonly referee: Referee;
  readonly matchDriver: MatchDriver;
  /** Mueve el reloj a mano. Nada espera tiempo real. */
  readonly clockBox: { now: number };
  /** Los deadlines que el engine programó, en orden. */
  readonly scheduled: number[];
  /** Dispara el último vencimiento programado. */
  fireTimeout(): readonly MatchEvent[];
}

export function buildEngine(
  seats: string[] = ["u1", "u2"],
  overrides: Partial<GlobalDominoConfig> = {},
): EngineHarness {
  const globalConfig: GlobalDominoConfig = { ...DEFAULT_GLOBAL_CONFIG, ...overrides };
  const config: DominoMatchConfig = {
    matchId: "m-test",
    gameModeId: "test",
    seed: "seed-test",
    seats,
    pointsToWin: 100,
    teamAssignment: "SHUFFLED",
    isDealWindowEnabled: false,
  };
  const match = createMatchState(config);

  const clockBox = { now: 1_000 };
  const clock: Clock = { now: () => clockBox.now };

  const scheduled: number[] = [];
  let pending: (() => readonly MatchEvent[]) | undefined;
  // Scheduler NO-OP: registra el instante y guarda el callback, pero no espera.
  const scheduler: TimeoutScheduler = {
    schedule(at, onExpire) {
      scheduled.push(at);
      pending = onExpire;
    },
    cancel() {
      pending = undefined;
    },
  };

  const visibility: SchemaVisibilityController = { makePublic() {}, hide() {} };

  const matchReferee = new MatchReferee(match);
  const matchDriver = new MatchDriver(match, clock, scheduler, globalConfig, matchReferee);
  const repository = new PlayerRepository(
    seats,
    (playerId) => new MatchPlayer(playerId, match),
  );
  const players = new Player(repository);
  const referee = new Referee(matchReferee);

  return {
    match,
    players,
    referee,
    matchDriver,
    clockBox,
    scheduled,
    fireTimeout() {
      if (!pending) throw new Error("no hay timeout programado");
      const run = pending;
      pending = undefined;
      return run();
    },
  };
}

```

- [ ] **Step 3: Escribir el test que falla**

```ts
// src/features/match/core/engine/tests/abandon.test.ts
import { describe, expect, it } from "vitest";
import { AbandonCommand } from "../../commands/abandon.js";
import { RuleViolationError } from "../errors.js";
import { playerOf } from "../state-projections.js";
import { buildEngine } from "./build-engine.js";

function engine(seats?: string[]) {
  const harness = buildEngine(seats);
  const command = new AbandonCommand(harness.referee, harness.players, harness.matchDriver);
  return { ...harness, command };
}

describe("ABANDON", () => {
  it("no se puede abandonar una partida que no arrancó", () => {
    const { command } = engine();
    expect(() => command.execute({ playerId: "u1" })).toThrow(RuleViolationError);
  });

  // EL VEREDICTO SALE AL ENTRAR A LA PRESENTACIÓN, NO AL VENCERLA. El listener que paga
  // cuelga de `MATCH_RESOLVED`, así que si el evento saliera al final de la pausa el
  // premio esperaría los 6 s enteros —y con las fases de revancha, mucho más—. Este test
  // es el que fija esa latencia: el forfeit paga en el acto.
  it("marca al jugador, abre la pausa de cierre, y dictamina YA", () => {
    const e = engine();
    e.matchDriver.begin();
    expect(e.match.phase).toBe("PLAYING");

    const events = e.command.execute({ playerId: "u1" });

    expect(playerOf("u1", e.match).hasAbandoned).toBe(true);
    expect(e.match.phase).toBe("PRESENTING_MATCH");
    // El plazo se estampa en el estado Y se programa por el puerto.
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 6_000);
    expect(e.scheduled).toEqual([e.clockBox.now + 6_000]);
    // El verbo dicho por el JUGADOR no emite evento —el comando ya es el registro—,
    // pero el VEREDICTO no es el verbo: es consecuencia computada, y sale acá.
    expect(events).toEqual([
      { type: "MATCH_RESOLVED", winnerTeamId: "B", reason: "ABANDONMENT" },
    ]);
  });

  it("al vencer la pausa solo se cierra la máquina; el veredicto ya salió", () => {
    const e = engine();
    e.matchDriver.begin();
    e.command.execute({ playerId: "u1" });

    const events = e.fireTimeout();

    expect(e.match.phase).toBe("FINISHED");
    expect(events).toEqual([{ type: "DEADLINE_EXPIRED", kind: "PRESENTING_MATCH" }]);
  });

  it("abandonar dos veces es ilegal la segunda", () => {
    const e = engine();
    e.matchDriver.begin();
    e.command.execute({ playerId: "u1" });
    expect(() => e.command.execute({ playerId: "u1" })).toThrow(RuleViolationError);
  });

  it("begin() es idempotente: la sala lo llama en cada conexión", () => {
    const e = engine();
    e.matchDriver.begin();
    const startedAt = e.match.startedAt;
    e.clockBox.now += 5_000;
    e.matchDriver.begin();
    expect(e.match.startedAt).toBe(startedAt);
  });
});
```

- [ ] **Step 4: Correr el test para verificar que falla**

Run: `npx vitest run src/features/match/core/engine/tests/abandon.test.ts`
Expected: FAIL — no existen `AbandonCommand`, `MatchDriver`, `MatchPlayer`, `MatchReferee`, `Player`,
`Referee`, `PlayerRepository`.

- [ ] **Step 5: Escribir el trío de PARTIDA, las facades y `deadline-kind.ts`**

```ts
// src/features/match/core/engine/deadline-kind.ts
import type { DeadlineKind } from "../events.js";
import type { MatchState } from "../state/index.js";
import { InvariantViolationError } from "./errors.js";

// A qué VENTANA sirve el plazo vigente. Un solo campo en el estado ⇒ un solo evento
// de vencimiento y un solo eje que lo discrimine. La usan los conductores para
// despachar al vencer Y el registro para explicar el hueco donde el reloj decidió,
// así que la rama tomada y lo que queda escrito no pueden discrepar.
//
// `TURN` cubre los DOS tramos del turno —el plazo normal y el consumo de la reserva—
// porque los dos ocurren en `phase === "PLAYING"`. Eso es correcto acá: para el
// despacho da igual cuál de los dos venció, la rama es la misma. Quién los distingue
// es `Turn.isConsumingExtendedTime`, y existe para el FRONT (que si no muestra una
// cuenta atrás sin saber de qué) y para que el conductor sepa que ya no hay más colchón.
export function deadlineKindOf(match: MatchState): DeadlineKind {
  if (match.phase === "PRESENTING_MATCH") return "PRESENTING_MATCH";
  if (match.currentRound?.phase === "PRESENTING_ROUND") return "PRESENTING_ROUND";
  // La ventana de reparto tiene plazo PROPIO, distinto del turno: cuando vence no se
  // retira a uno, se retira a todos los que no levantaron sus fichas (reglas §3.1).
  if (match.currentRound?.phase === "DEALING") return "DEALING";
  if (match.currentRound?.phase === "PLAYING") return "TURN";
  throw new InvariantViolationError(`sin ventana temporizada en fase ${match.phase}`);
}
```

```ts
// src/features/match/core/engine/match/player.ts
import type { PlayerId } from "../../ids.js";
import type { MatchState } from "../../state/index.js";
import { playerOf } from "../state-projections.js";

// ÚNICO escritor de hasAbandoned. Que sea el único es verificable con grep, y es
// lo que hace que la frontera entre actores se sostenga.
export class MatchPlayer {
  constructor(
    private readonly playerId: PlayerId,
    private readonly match: MatchState,
  ) {}

  abandon(): void {
    playerOf(this.playerId, this.match).hasAbandoned = true;
  }
}
```

```ts
// src/features/match/core/engine/match/referee.ts
import type { PlayerId, TeamId } from "../../ids.js";
import type { MatchState } from "../../state/index.js";
import { RuleViolationError } from "../errors.js";
import {
  hasTeamAbandoned,
  isRoundActive,
  opponentTeam,
  playerOf,
  scoreboardOf,
  teamOf,
} from "../state-projections.js";

export interface MatchOutcome {
  readonly winnerTeamId: TeamId;
  readonly reason: "SCORE" | "ABANDONMENT";
}

// JUEZ: read-only. Valida, deriva, dictamina. No muta nada.
export class MatchReferee {
  constructor(private readonly match: MatchState) {}

  // Va delante de TODA acción de jugador. Repetida y no envuelta en un genérico,
  // a propósito: así se ve de un vistazo cuáles la tienen, y es grepeable.
  assertIsPlaying(playerId: PlayerId): void {
    if (this.match.phase !== "PLAYING") {
      throw new RuleViolationError("MATCH_NOT_IN_PROGRESS");
    }
    if (!isRoundActive(playerOf(playerId, this.match))) {
      throw new RuleViolationError("NOT_PLAYING");
    }
  }

  assertCanAbandon(playerId: PlayerId): void {
    this.assertIsPlaying(playerId);
  }

  outcome(): MatchOutcome | undefined {
    // SI SE FUERON LOS DOS, NO GANÓ NADIE — y hay que decirlo ANTES que nada. Preguntando
    // por un equipo primero, el orden de evaluación coronaría al otro, y esa partida
    // —que nadie jugó— **pagaría premio**. En un juego con dinero eso no es un detalle
    // de estilo: es plata que sale por un `for` que no miró el caso.
    //
    // Era inalcanzable hasta la ventana de reparto (reglas §3.1): el primer forfeit
    // resolvía la partida y ya no quedaba a quién retirar. El vencimiento de la ventana
    // puede retirar a varios de una, así que ahora se alcanza. Truco lo descubrió al
    // implementar la ventana; acá nace cubierto.
    if (hasTeamAbandoned("A", this.match) && hasTeamAbandoned("B", this.match)) {
      return undefined;
    }

    for (const teamId of ["A", "B"] as const) {
      if (hasTeamAbandoned(teamId, this.match)) {
        return { winnerTeamId: opponentTeam(teamId), reason: "ABANDONMENT" };
      }
    }
    // Por la proyección y no directo: `scoreboard` es `.optional()` (Tarea 4), así que
    // con `strict: true` desestructurarlo a pelo no compila.
    const { teamA, teamB } = scoreboardOf(this.match);
    const target = this.match.pointsToWin;
    if (teamA >= target) return { winnerTeamId: "A", reason: "SCORE" };
    if (teamB >= target) return { winnerTeamId: "B", reason: "SCORE" };
    return undefined;
  }

  teamOf(playerId: PlayerId): TeamId {
    return teamOf(playerId, this.match);
  }
}
```

```ts
// src/features/match/core/engine/match/driver.ts
import type { GlobalDominoConfig } from "../../config.js";
import type { MatchEvent } from "../../events.js";
import type { PlayerId } from "../../ids.js";
import type { MatchState } from "../../state/index.js";
import type { Clock } from "../clock.js";
import { deadlineKindOf } from "../deadline-kind.js";
import type { Driver, RoundAction, TransitionResult } from "../driver.js";
import { InvariantViolationError } from "../errors.js";
import type { TimeoutScheduler } from "../timeout-scheduler.js";
import type { MatchReferee } from "./referee.js";

// CONDUCTOR de la PARTIDA. Dueño de las transiciones de fase y de los plazos.
// Su superficie pública son begin/advance/timeout y nada más.
export class MatchDriver implements Driver {
  constructor(
    private readonly match: MatchState,
    private readonly clock: Clock,
    private readonly scheduler: TimeoutScheduler,
    private readonly config: GlobalDominoConfig,
    private readonly referee: MatchReferee,
  ) {}

  // IDEMPOTENTE: la sala lo llama en cada conexión, y una reconexión vuelve a
  // completar la mesa. Arrancar dos veces no puede repartir de nuevo.
  begin(): void {
    if (this.match.phase !== "NOT_STARTED") return;
    this.match.phase = "PLAYING";
    this.match.startedAt = this.clock.now();
    // La reserva de tiempo extra empieza a existir cuando la partida empieza. Es el
    // único lugar que la siembra: de acá en adelante SOLO decrece (reglas §5.1,
    // decisión 7). La génesis no puede hacerlo porque no recibe el config global.
    for (const player of this.match.players) {
      player.extraTimeRemainingMs = this.config.extraTimeReserveMs;
    }
  }

  // Los DOS parámetros, aunque esta altura no use ninguno: la firma la fija la interfaz
  // `Driver`, y el comando ya llama `advance(playerId, "ABANDONED")`. Con un solo
  // parámetro esto no compila —`TS2554: Expected 1 arguments, but got 2`— y la Tarea 19,
  // que reescribe este método para delegar en la ronda, sí los usa los dos.
  advance(_actorId: PlayerId, _action: RoundAction): TransitionResult {
    if (this.match.phase !== "PLAYING") return { events: [], finished: false };
    if (this.referee.outcome()) {
      return { events: this.enterPresentingMatch(), finished: false };
    }
    return { events: [], finished: false };
  }

  timeout(): TransitionResult {
    const kind = deadlineKindOf(this.match);
    const events: MatchEvent[] = [{ type: "DEADLINE_EXPIRED", kind }];

    // La presentación terminó. El VEREDICTO ya salió al ENTRAR a esta fase, así que
    // acá no se dictamina nada: solo se cierra la máquina. Ver `enterPresentingMatch`.
    if (kind === "PRESENTING_MATCH") {
      this.match.phase = "FINISHED";
      this.match.activeDeadline = 0;
      this.scheduler.cancel();
      return { events, finished: true };
    }

    throw new InvariantViolationError(`el conductor de PARTIDA no maneja ${kind}`);
  }

  // `MATCH_RESOLVED` sale al ENTRAR a la presentación, NO al vencerla.
  //
  // Es la corrección que truco documentó en su changelog de revancha (negocio v26 §2):
  // con el evento al vencer, el premio esperaba toda la pausa —y con las fases de
  // revancha del otro lado, hasta 40 segundos—. La regla de producto es la contraria:
  // en lo que finaliza una partida se paga al ganador, haya revancha o no. El listener
  // que paga cuelga de este evento, así que de dónde se emite ES la latencia del pago.
  //
  // Consecuencia que hay que ver antes de escribirla: cualquier guarda de reembolso en
  // `onDispose` NO puede comparar contra la fase terminal, porque con fases después del
  // veredicto reembolsaría una partida ya pagada. Se pregunta por el veredicto
  // (`referee.outcome()`), no por `phase === "FINISHED"`.
  private enterPresentingMatch(): readonly MatchEvent[] {
    const outcome = this.referee.outcome();
    if (!outcome) throw new InvariantViolationError("presentación de partida sin veredicto");
    this.match.phase = "PRESENTING_MATCH";
    this.stampDeadline(this.config.presentingMatchMs);
    return [{ type: "MATCH_RESOLVED", ...outcome }];
  }

  // Estampa el instante en el estado Y arma el timer por el puerto. Las dos cosas
  // juntas, siempre: el estado dice CUÁNDO vence y el puerto lo hace ocurrir.
  private stampDeadline(durationMs: number): void {
    const at = this.clock.now() + durationMs;
    this.match.activeDeadline = at;
    this.scheduler.schedule(at, () => this.timeout().events);
  }
}
```

```ts
// src/features/match/core/engine/match/index.ts
export * from "./driver.js";
export * from "./player.js";
export * from "./referee.js";
```

```ts
// src/features/match/core/engine/player-repository.ts
import type { PlayerId } from "../ids.js";
import { InvariantViolationError } from "./errors.js";
import type { MatchPlayer } from "./match/player.js";

// Los Player son match-bound y por ASIENTO. El repositorio los arma una vez y
// los sirve por id, así que el facade no fabrica nada en caliente.
export class PlayerRepository {
  private readonly players = new Map<PlayerId, MatchPlayer>();

  constructor(seats: readonly PlayerId[], factory: (playerId: PlayerId) => MatchPlayer) {
    for (const playerId of seats) this.players.set(playerId, factory(playerId));
  }

  get(playerId: PlayerId): MatchPlayer {
    const player = this.players.get(playerId);
    if (!player) throw new InvariantViolationError(`sin Player para ${playerId}`);
    return player;
  }
}
```

```ts
// src/features/match/core/engine/player-facade.ts
import type { PlayerId } from "../ids.js";
import type { PlayerRepository } from "./player-repository.js";

// FACADE de mutación: redirige cada verbo al sub-player del asiento.
// Lo que esconde es la multiplicidad por asiento, no la lógica.
export class Player {
  constructor(private readonly repository: PlayerRepository) {}

  abandon(playerId: PlayerId): void {
    this.repository.get(playerId).abandon();
  }
}
```

```ts
// src/features/match/core/engine/referee-facade.ts
import type { PlayerId } from "../ids.js";
import type { MatchReferee } from "./match/referee.js";

// FACADE solo-juez: agrega los assertCanX en una superficie. Read-only.
export class Referee {
  constructor(private readonly matchReferee: MatchReferee) {}

  assertCanAbandon(playerId: PlayerId): void {
    this.matchReferee.assertCanAbandon(playerId);
  }
}
```

- [ ] **Step 6: Escribir el comando**

```ts
// src/features/match/core/commands/abandon.ts
import type { Command } from "../command.js";
import type { MatchEvent } from "../events.js";
import type { MatchDriver } from "../engine/match/driver.js";
import type { Player } from "../engine/player-facade.js";
import type { Referee } from "../engine/referee-facade.js";

// El único verbo de PARTIDA. Delgado y en el orden de siempre:
// juez valida → player muta → conductor avanza.
//
// NO emite evento: el comando ya es el registro del acto (spec §5.1). El ABANDON
// como EVENTO existe solo cuando lo dice el sistema, que es otro camino.
export class AbandonCommand implements Command<"ABANDON", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: MatchDriver,
  ) {}

  execute({ playerId }: { playerId: string }): readonly MatchEvent[] {
    this.referee.assertCanAbandon(playerId);
    this.players.abandon(playerId);
    return this.matchDriver.advance(playerId, "ABANDONED").events;
  }
}
```

```ts
// src/features/match/core/commands/index.ts
export * from "./abandon.js";
```

- [ ] **Step 7: Correr el test hasta que pase**

Run: `npx vitest run src/features/match/core/engine/tests/abandon.test.ts`
Expected: los 5 tests PASAN.

- [ ] **Step 8: Commit**

```bash
npm run typecheck && npm test
git add src/features/match/core
git commit -m "feat(engine): el trío de PARTIDA, las dos facades y el verbo ABANDON

Un solo verbo, pero atraviesa el espinazo completo: juez valida, player muta,
conductor transiciona, emite MATCH_RESOLVED al ENTRAR a la presentación, estampa
el plazo en el estado y lo arma por el puerto, y al vencer solo cierra la máquina.

El veredicto sale al entrar y no al vencer porque el listener que paga cuelga de
ese evento: de dónde se emite es la latencia del premio (truco negocio v26 §2).

MatchPlayer es el único escritor de hasAbandoned, verificable con grep.
begin() es idempotente porque la sala lo llama en cada conexión.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 8: El wire — payloads, decoder y la frontera anti-trampa

**Files:**
- Create: `src/features/match/transports/colyseus/errors.ts`, `.../commands/payloads.ts`, `.../commands/decoders.ts`, `.../commands/catalog.ts`, `.../commands/index.ts`
- Test: `src/features/match/transports/colyseus/commands/tests/catalog.test.ts`, `.../tests/decoders.test.ts`

- [ ] **Step 1: Escribir el test del catálogo**

El caso que importa es el del prototipo: es un DoS de una línea.

```ts
// src/features/match/transports/colyseus/commands/tests/catalog.test.ts
import { describe, expect, it, vi } from "vitest";
import { UnknownCommandError } from "../../errors.js";
import { CommandCatalog } from "../catalog.js";

const build = () =>
  new CommandCatalog(
    { ABANDON: { decode: vi.fn(() => ({ playerId: "u1" })) } },
    { ABANDON: { execute: vi.fn(() => []) } },
  );

describe("CommandCatalog", () => {
  it("acepta un verbo que existe", () => {
    expect(build().accepts("ABANDON")).toBe(true);
  });

  it("rechaza un verbo que no existe", () => {
    expect(build().accepts("PLAY_TILE")).toBe(false);
  });

  // EL CASO QUE IMPORTA. Con `in` en vez de Object.hasOwn, "toString" pasa la
  // frontera —el prototipo cuenta—, se lleva un command() undefined, su .execute
  // revienta en TypeError y la política de errores traduce eso a CERRAR la partida.
  // Un mensaje de una línea mataba la mesa.
  it("rechaza los nombres heredados de Object.prototype", () => {
    const catalog = build();
    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(catalog.accepts(name)).toBe(false);
    }
  });

  it("pedir el decoder de un verbo inexistente lanza UnknownCommandError", () => {
    expect(() => build().decoder("toString")).toThrow(UnknownCommandError);
  });

  it("pedir el comando de un verbo inexistente lanza UnknownCommandError", () => {
    expect(() => build().command("nope")).toThrow(UnknownCommandError);
  });
});
```

- [ ] **Step 2: Escribir el test del decoder**

```ts
// src/features/match/transports/colyseus/commands/tests/decoders.test.ts
import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors.js";
import { identityDecoder } from "../decoders.js";

describe("identityDecoder", () => {
  // EL INVARIANTE DEL WIRE: el playerId no viaja en el mensaje. Lo inyecta el
  // decoder desde la identidad autenticada, así que no hay forma de jugar por otro.
  it("inyecta el playerId autenticado", () => {
    expect(identityDecoder("ABANDON").decode({}, "u1")).toEqual({ playerId: "u1" });
  });

  // RECHAZA, no ignora. El plan decía "ignora ... y devuelve {playerId:'u1'}", y eso
  // contradecía al `.strict()` de `payloads.ts` dos bloques más abajo: con `.strict()`
  // zod emite `unrecognized_keys` y el decoder lanza. Gana `.strict()`, que es la
  // doctrina escrita ("un campo de más es un rechazo, no algo que se ignore en
  // silencio") y además la conducta más fuerte: el que intenta suplantar se come un
  // error duro, no un no-op mudo que lo deja creyendo que el tiro salió.
  it("rechaza un playerId mandado por el cliente", () => {
    expect(() => identityDecoder("ABANDON").decode({ playerId: "victima" }, "u1")).toThrow(
      ValidationError,
    );
  });

  it("acepta un payload ausente", () => {
    expect(identityDecoder("ABANDON").decode(undefined, "u1")).toEqual({ playerId: "u1" });
  });

  it("rechaza un payload que no es objeto", () => {
    expect(() => identityDecoder("ABANDON").decode(42, "u1")).toThrow(ValidationError);
  });
});
```

- [ ] **Step 3: Correr los dos tests para verificar que fallan**

Run: `npx vitest run src/features/match/transports/colyseus/commands/tests/`
Expected: FAIL — no existen `catalog.js`, `decoders.js` ni `errors.js`.

- [ ] **Step 4: Escribir los errores del transporte y el wire**

```ts
// src/features/match/transports/colyseus/errors.ts
// Rama de la jerarquía que le toca al transporte. Lo que tienen en común: son
// rechazos legítimos, NO bugs, así que la política de errores de la sala los deja
// pasar sin cerrar la partida.
export abstract class ColyseusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends ColyseusError {
  constructor(readonly detail: string) {
    super(`Payload inválido: ${detail}`);
  }
}

export class UnknownCommandError extends ColyseusError {
  constructor(readonly type: string) {
    super(`Verbo desconocido: ${type}`);
  }
}

export class SeatNotReservedError extends ColyseusError {
  constructor(playerId: string) {
    super(`${playerId} no tiene asiento en esta partida`);
  }
}

export class PlayerAlreadyOutError extends ColyseusError {
  constructor(playerId: string) {
    super(`${playerId} ya fue retirado de esta partida`);
  }
}
```

```ts
// src/features/match/transports/colyseus/commands/payloads.ts
import { z } from "zod";
import type { CommandName } from "../../../core/command.js";

// EL WIRE NO EXPONE PALANCAS. `.strict()` en todos: un campo de más es un rechazo,
// no algo que se ignore en silencio. Y el playerId NO está en ningún schema —lo
// inyecta el decoder desde client.auth—, así que no hay forma de mandarlo.
//
// `satisfies` cierra el mapa: un verbo nuevo en CommandPayloads sin su fila acá
// NO COMPILA.
export const COMMAND_PAYLOADS = {
  ABANDON: z.object({}).strict(),
} satisfies Record<CommandName, z.ZodType>;

export type WirePayload<N extends CommandName> = z.infer<(typeof COMMAND_PAYLOADS)[N]>;
```

```ts
// src/features/match/transports/colyseus/commands/decoders.ts
import type { CommandName, CommandPayload } from "../../../core/command.js";
import type { PlayerId } from "../../../core/ids.js";
import { ValidationError } from "../errors.js";
import { COMMAND_PAYLOADS } from "./payloads.js";

export interface MessageDecoder<N extends CommandName> {
  decode(raw: unknown, playerId: PlayerId): CommandPayload<N>;
}

// Valida con zod y le suma la identidad AUTENTICADA. El cliente no elige quién es.
export function identityDecoder<N extends CommandName>(name: N): MessageDecoder<N> {
  return {
    decode(raw: unknown, playerId: PlayerId): CommandPayload<N> {
      const result = COMMAND_PAYLOADS[name].safeParse(raw ?? {});
      if (!result.success) {
        throw new ValidationError(
          result.error.issues.map((issue) => issue.message).join("; "),
        );
      }
      return { ...(result.data as object), playerId } as CommandPayload<N>;
    },
  };
}
```

```ts
// src/features/match/transports/colyseus/commands/catalog.ts
import type { Command, CommandName } from "../../../core/command.js";
import type { MatchEvent } from "../../../core/events.js";
import { UnknownCommandError } from "../errors.js";
import type { MessageDecoder } from "./decoders.js";

type Decoders = { readonly [N in CommandName]: MessageDecoder<N> };
type Commands = { readonly [N in CommandName]: Command<N, MatchEvent> };

export class CommandCatalog {
  constructor(
    private readonly decoders: Decoders,
    private readonly commands: Commands,
  ) {}

  // LA FRONTERA ANTI-TRAMPA. Object.hasOwn y NO `in`: con `in`, los nombres
  // heredados de Object.prototype la pasan (ver el test).
  //
  // Se resuelve sobre el mapa de DECODERS, así que la lista de verbos aceptados y
  // la frontera son la misma cosa: un verbo sin decoder no puede llegar por el cable.
  accepts(type: string): type is CommandName {
    return Object.hasOwn(this.decoders, type);
  }

  decoder(type: string): MessageDecoder<CommandName> {
    if (!this.accepts(type)) throw new UnknownCommandError(type);
    return this.decoders[type];
  }

  command(type: string): Command<CommandName, MatchEvent> {
    if (!this.accepts(type)) throw new UnknownCommandError(type);
    return this.commands[type];
  }
}
```

```ts
// src/features/match/transports/colyseus/commands/index.ts
export * from "./catalog.js";
export * from "./decoders.js";
export * from "./payloads.js";
```

- [ ] **Step 5: Correr los tests hasta que pasen**

Run: `npx vitest run src/features/match/transports/colyseus/commands/tests/`
Expected: 9 tests PASAN.

- [ ] **Step 6: Commit**

```bash
npm run typecheck && npm test
git add src/features/match/transports
git commit -m "feat(wire): payloads zod, decoder que inyecta identidad y frontera anti-trampa

catalog.accepts usa Object.hasOwn y no \`in\`: con \`in\`, un cliente que manda
type: \"toString\" pasa la frontera, se lleva un command() undefined, su .execute
revienta en TypeError, y la política de errores traduce eso a cerrar la partida.
Un mensaje de una línea mataba la mesa. Va con test.

El playerId no viaja en el wire: lo inyecta el decoder desde la identidad
autenticada, así que no hay forma de jugar por otro.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 9: El historial y el notificador

**Files:**
- Create: `src/features/match/network/events.ts`, `.../history.ts`, `.../listeners.ts`, `.../pieces.ts`, `.../transports/memory-history.ts`, `.../index.ts`
- Test: `src/features/match/network/tests/history.test.ts`, `.../tests/listeners.test.ts`

- [ ] **Step 1: Escribir el test del historial**

```ts
// src/features/match/network/tests/history.test.ts
import { describe, expect, it } from "vitest";
import type { Clock } from "../../core/engine/clock.js";
import { createMatchState } from "../../core/engine/genesis.js";
import { BoardState, BoneyardState, RoundState, Tile } from "../../core/state/index.js";
import type { HistoryEntry, HistoryPort } from "../history.js";
import { MatchHistory } from "../history.js";

function build() {
  const recorded: HistoryEntry[] = [];
  const port: HistoryPort = { record: (entries) => recorded.push(...entries) };
  const clockBox = { now: 5_000 };
  const clock: Clock = { now: () => clockBox.now };
  const match = createMatchState({
    matchId: "m1",
    gameModeId: "g",
    seed: "s",
    seats: ["u1", "u2"],
    pointsToWin: 100,
    teamAssignment: "SHUFFLED",
    isDealWindowEnabled: false,
  });
  const round = new RoundState();
  round.roundNumber = 3;
  round.board = new BoardState();
  round.boneyard = new BoneyardState();
  match.currentRound = round;
  return { history: new MatchHistory("m1", match, clock, port), recorded, clockBox };
}

// EL VOCABULARIO DE ESTOS TESTS ES EL DE HOY, no el final. Este bloque decía PLAY_TILE
// y PASS —verbos que llegan recién en la Tarea 19—, y contra el catálogo de esta altura
// (`CommandPayloads` = { ABANDON }) eso no compila: siete TS2345/TS2322.
//
// Y el modo en que NO se descubre es la parte que hay que recordar: vitest transpila con
// esbuild, que BORRA los tipos sin chequearlos, así que los seis tests daban verde
// mientras `tsc --noEmit` tenía siete errores. En este repo el test verde no es prueba de
// que compile; el gate es `npm run typecheck`.
//
// ABANDON alcanza para las seis propiedades, y para la del `source` alcanza MEJOR: es el
// único verbo que a esta altura existe de las dos bocas —comando voluntario y evento
// emitido por timeout— y core/events.ts lo documenta justamente como el caso canónico de
// la distinción ("se fue" contra "lo sacaron").
describe("MatchHistory", () => {
  // El punto central: actos y hechos INTERCALADOS con UN SOLO seq que los ordena
  // entre sí. Un registro de solo eventos tendría los desenlaces y ninguna jugada.
  it("intercala comandos y eventos con un solo seq monótono", () => {
    const { history, recorded } = build();
    history.command("PLAYER", "ABANDON", { playerId: "u1" });
    history.events([{ type: "DEADLINE_EXPIRED", kind: "TURN" }]);
    history.command("PLAYER", "ABANDON", { playerId: "u2" });

    expect(recorded.map((e) => [e.seq, e.source, e.type])).toEqual([
      [1, "PLAYER", "ABANDON"],
      [2, "SYSTEM", "DEADLINE_EXPIRED"],
      [3, "PLAYER", "ABANDON"],
    ]);
  });

  // El source es un campo y no un adorno: el mismo verbo puede venir de las dos
  // bocas, y para un reclamo —"yo nunca me fui, me sacaron"— esa es toda la pregunta.
  it("distingue el verbo del jugador del mismo verbo dicho por el sistema", () => {
    const { history, recorded } = build();
    history.command("PLAYER", "ABANDON", { playerId: "u1" });
    history.events([{ type: "ABANDON", playerId: "u2" }]);

    expect(recorded[0]).toMatchObject({ type: "ABANDON", source: "PLAYER", kind: "COMMAND" });
    expect(recorded[1]).toMatchObject({ type: "ABANDON", source: "SYSTEM", kind: "EVENT" });
  });

  it("envuelve cada entrada con matchId, timestamp del Clock y roundNumber", () => {
    const { history, recorded, clockBox } = build();
    clockBox.now = 7_777;
    history.command("PLAYER", "ABANDON", { playerId: "u1" });

    expect(recorded[0]).toMatchObject({ matchId: "m1", at: 7_777, roundNumber: 3 });
  });

  // En @colyseus/schema 5 los campos dejaron de ser propiedades propias del objeto,
  // así que { ...tile } devuelve {} y la ficha se registraría VACÍA. Sin este
  // aplanado el replay no puede reconstruir nada.
  it("aplana un Schema con toJSON en vez de spread", () => {
    const { history, recorded } = build();
    const tile = new Tile();
    tile.left = 6;
    tile.right = 4;
    history.command("PLAYER", "ABANDON", { playerId: "u1", tile });

    expect(recorded[0]?.payload).toEqual({ playerId: "u1", tile: { left: 6, right: 4 } });
  });

  it("aplana Schemas dentro de arrays", () => {
    const { history, recorded } = build();
    const a = new Tile();
    a.left = 1;
    a.right = 1;
    const b = new Tile();
    b.left = 2;
    b.right = 3;
    history.command("PLAYER", "ABANDON", { playerId: "u1", tiles: [a, b] });

    expect(recorded[0]?.payload).toEqual({
      playerId: "u1",
      tiles: [{ left: 1, right: 1 }, { left: 2, right: 3 }],
    });
  });

  it("un lote de eventos consume un seq por evento", () => {
    const { history, recorded } = build();
    history.events([
      { type: "DEADLINE_EXPIRED", kind: "PRESENTING_MATCH" },
      { type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "ABANDONMENT" },
    ]);
    expect(recorded.map((e) => e.seq)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/features/match/network/tests/history.test.ts`
Expected: FAIL con `Failed to resolve import "../history.js"`.

- [ ] **Step 3: Escribir `events.ts` y `history.ts`**

```ts
// src/features/match/network/events.ts
import type { MatchEvent } from "../core/events.js";
import type { PlayerId } from "../core/ids.js";

// Lo que solo la SALA sabe: que un socket se cayó, que volvió, y que esta partida
// se murió sin veredicto. El dominio no tiene un final sin veredicto.
//
// Los tres motivos son tres momentos distintos, y la diferencia es plata: los tres
// reembolsan, pero soporte tiene que poder decir CUÁL fue.
//   · NEVER_STARTED — la mesa nunca se llenó (venció el plazo de ocupación).
//   · NEVER_PLAYED  — se llenó y se repartió, pero NADIE levantó sus fichas: venció la
//                     ventana de reparto con los dos ausentes (reglas §3.1). Es el
//                     hermano tardío del anterior: allá nunca se llenó, acá nunca arrancó.
//   · INTERRUPTED   — se estaba jugando y la sala se murió sin veredicto.
export type AbortReason = "NEVER_STARTED" | "NEVER_PLAYED" | "INTERRUPTED";

export type PlatformMatchEvent =
  | { type: "PLAYER_DISCONNECTED"; playerId: PlayerId }
  | { type: "PLAYER_RECONNECTED"; playerId: PlayerId }
  | { type: "MATCH_ABORTED"; reason: AbortReason };

// Ensanche por INCLUSIÓN desde arriba: un MatchEvent YA ES un NetworkMatchEvent,
// así que la covarianza es segura e implícita y no hay traducción.
export type NetworkMatchEvent = MatchEvent | PlatformMatchEvent;
```

```ts
// src/features/match/network/history.ts
// El registro para el operador de soporte y para el replay. NO es event sourcing:
// la fuente de verdad del estado es el árbol Schema; esto es un registro paralelo.
//
// Se graban las DOS cosas —el ACTO y el HECHO— intercaladas en el orden en que
// pasaron, porque por el criterio de MatchEvent la mayoría de los verbos no emite
// nada: un historial de solo eventos tendría los desenlaces y ninguna jugada.
import type { CommandPayloads } from "../core/command.js";
import type { Clock } from "../core/engine/clock.js";
import type { MatchState } from "../core/state/index.js";
import type { NetworkMatchEvent } from "./events.js";

// EL VOCABULARIO DEL HISTORIAL ES CERRADO, y eso es el punto entero de la corrección
// del v1. Ahí una entrada era un tipo único discriminado por dos booleanos
// (`isPassed`/`isLoaded`), así que `isPassed && isLoaded` typechequeaba y no significaba
// nada. Acá el discriminante es `type`, y su dominio es la unión de los verbos del
// catálogo con los tipos de evento — no `string`.
//
// Si esto fuera `string`, un `type: "LOAD_TILE"` (el nombre del v1) se grabaría sin que
// nada chille, y el replay lo descubriría en runtime rebobinando una partida real.
export type HistoryEntryType = keyof CommandPayloads | NetworkMatchEvent["type"];

export interface HistoryEntry {
  readonly matchId: string;
  /** Monótono POR PARTIDA. Es el orden, y es lo único que ordena actos y hechos entre sí. */
  readonly seq: number;
  readonly at: number;
  readonly roundNumber: number;
  readonly source: "PLAYER" | "SYSTEM";
  readonly kind: "COMMAND" | "EVENT";
  readonly type: HistoryEntryType;
  readonly payload: Record<string, unknown>;
}

// Devuelve `void`, no promesa, a propósito: lo llaman el camino de un comando y el
// de un timer, y ninguno espera. Las decisiones de persistencia —buffering, qué
// hacer si Mongo falla SIN FRENAR LA PARTIDA— quedan de este lado.
export interface HistoryPort {
  record(entries: readonly HistoryEntry[]): void;
}

// Grabador PER-PARTIDA. Lo arma el wiring; la sala solo lo usa.
export class MatchHistory {
  private seq = 0;

  constructor(
    private readonly matchId: string,
    private readonly match: MatchState,
    private readonly clock: Clock,
    private readonly port: HistoryPort,
  ) {}

  // `source` es PARÁMETRO y no una constante `"PLAYER"`. Hoy todos los comandos los dice
  // un jugador, así que la sala pasa siempre `"PLAYER"` — pero el spec §5.1 dice que el
  // MISMO verbo dicho por el sistema se graba con el nombre del verbo y `source: SYSTEM`,
  // y que "el mecanismo del historial no depende de esa elección". Con la firma fijada en
  // PLAYER, sí dependía: cambiar la decisión de qué hace el reloj al vencer el turno
  // habría exigido tocar esta clase. Ahora es un argumento.
  command(
    source: HistoryEntry["source"],
    type: keyof CommandPayloads,
    payload: object,
  ): void {
    this.port.record([this.wrap(source, "COMMAND", type, payload)]);
  }

  events(events: readonly NetworkMatchEvent[]): void {
    if (events.length === 0) return;
    this.port.record(
      events.map((event) => {
        const { type, ...rest } = event as NetworkMatchEvent & Record<string, unknown>;
        return this.wrap("SYSTEM", "EVENT", type, rest);
      }),
    );
  }

  private wrap(
    source: HistoryEntry["source"],
    kind: HistoryEntry["kind"],
    type: HistoryEntryType,
    payload: object,
  ): HistoryEntry {
    this.seq += 1;
    return {
      matchId: this.matchId,
      seq: this.seq,
      at: this.clock.now(),
      roundNumber: this.match.currentRound?.roundNumber ?? 0,
      source,
      kind,
      type,
      payload: flatten(payload) as Record<string, unknown>,
    };
  }
}

// En @colyseus/schema 5 los campos NO son propiedades propias del objeto: viven en
// un símbolo interno. Un `{ ...tile }` devuelve `{}` y la ficha se registra vacía.
// Todo lo que pueda ser un Schema pasa por toJSON(), recursivo dentro de arrays.
function flatten(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(flatten);
  const candidate = value as { toJSON?: () => unknown };
  if (typeof candidate.toJSON === "function") return candidate.toJSON();
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, flatten(item)]),
  );
}
```

- [ ] **Step 4: Correr el test hasta que pase**

Run: `npx vitest run src/features/match/network/tests/history.test.ts`
Expected: los 6 tests PASAN.

- [ ] **Step 5: Escribir el test del notificador**

```ts
// src/features/match/network/tests/listeners.test.ts
import { describe, expect, it } from "vitest";
import { InvariantViolationError } from "../../core/engine/errors.js";
import type { NetworkMatchEvent } from "../events.js";
import { MatchEventNotifier } from "../listeners.js";

describe("MatchEventNotifier", () => {
  it("difunde al cliente y a los sinks lo que el dominio produjo", () => {
    const broadcast: NetworkMatchEvent[] = [];
    const sink: NetworkMatchEvent[] = [];
    const notifier = new MatchEventNotifier(
      [],
      (events) => broadcast.push(...events),
      [(events) => sink.push(...events)],
    );

    notifier.notify([{ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }]);

    expect(broadcast).toHaveLength(1);
    expect(sink).toHaveLength(1);
  });

  it("los listeners pueden producir eventos, y esos también llegan a los sinks", () => {
    const sink: NetworkMatchEvent[] = [];
    const notifier = new MatchEventNotifier(
      [(event) => (event.type === "MATCH_RESOLVED" ? [{ type: "MATCH_ABORTED", reason: "INTERRUPTED" }] : [])],
      () => {},
      [(events) => sink.push(...events)],
    );

    notifier.notify([{ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }]);

    expect(sink.map((e) => e.type)).toEqual(["MATCH_RESOLVED", "MATCH_ABORTED"]);
  });

  // DISYUNTOR. Un listener que reacciona a lo que él mismo produce cuelga la partida
  // en un bucle mudo. Superar el límite no es "quedó corto": es un ciclo.
  it("una cascada infinita de listeners rompe la invariante en vez de colgar", () => {
    const notifier = new MatchEventNotifier(
      [() => [{ type: "MATCH_ABORTED", reason: "INTERRUPTED" }]],
      () => {},
      [],
    );

    expect(() => notifier.notify([{ type: "MATCH_ABORTED", reason: "INTERRUPTED" }])).toThrow(
      InvariantViolationError,
    );
  });

  it("un lote vacío no llama a nadie", () => {
    let calls = 0;
    const notifier = new MatchEventNotifier([], () => calls++, [() => calls++]);
    notifier.notify([]);
    expect(calls).toBe(0);
  });
});
```

- [ ] **Step 6: Correr el test para verificar que falla**

Run: `npx vitest run src/features/match/network/tests/listeners.test.ts`
Expected: FAIL con `Failed to resolve import "../listeners.js"`.

- [ ] **Step 7: Escribir `listeners.ts`, `pieces.ts`, `memory-history.ts` y el barrel**

```ts
// src/features/match/network/listeners.ts
import { InvariantViolationError } from "../core/engine/errors.js";
import type { NetworkMatchEvent } from "./events.js";

// Reacciona DESPUÉS y solo PRODUCE: no puede rechazar nada. Es una de las dos
// costuras del anillo; la otra es la admisión, que decide antes y sí puede rechazar.
export type MatchEventListener = (event: NetworkMatchEvent) => readonly NetworkMatchEvent[];

// Consume y no produce: difundir, persistir el historial.
export type MatchEventSink = (events: readonly NetworkMatchEvent[]) => void;

export class MatchEventNotifier {
  // Superarlo no es "quedó corto", es un ciclo.
  private static readonly MAX_CASCADE = 10;

  constructor(
    private readonly listeners: readonly MatchEventListener[],
    private readonly broadcast: MatchEventSink,
    private readonly sinks: readonly MatchEventSink[],
  ) {}

  // El ORDEN de los pasos garantiza tres propiedades sin programarlas: el dominio
  // se publica primero y tal cual entró; al cliente no le llega nada que produjeran
  // los listeners; y un efecto de plataforma que falle no puede tapar lo del dominio,
  // porque ya salió.
  notify(events: readonly NetworkMatchEvent[]): void {
    if (events.length === 0) return;

    this.broadcast(events);
    for (const sink of this.sinks) sink(events);

    let pending = [...events];
    let rounds = 0;
    while (pending.length > 0) {
      rounds += 1;
      if (rounds > MatchEventNotifier.MAX_CASCADE) {
        throw new InvariantViolationError(
          `cascada de listeners superó ${MatchEventNotifier.MAX_CASCADE} rondas: hay un ciclo`,
        );
      }
      const produced: NetworkMatchEvent[] = [];
      for (const event of pending) {
        for (const listener of this.listeners) produced.push(...listener(event));
      }
      if (produced.length > 0) for (const sink of this.sinks) sink(produced);
      pending = produced;
    }
  }
}
```

```ts
// src/features/match/network/pieces.ts
import type { MatchHistory } from "./history.js";
import type { MatchEventListener, MatchEventSink } from "./listeners.js";

// Lo que el wiring le entrega a la sala. La sala no arma nada de esto: solo lo usa.
export interface MatchPieces {
  readonly history: MatchHistory;
  readonly listeners: readonly MatchEventListener[];
  readonly sinks: readonly MatchEventSink[];
}
```

```ts
// src/features/match/network/transports/memory-history.ts
import type { HistoryEntry, HistoryPort } from "../history.js";

// Implementación de memoria. El adaptador de Mongo llega con la persistencia;
// esto es lo que permite que el mecanismo entero —envoltura, seq, intercalado—
// esté probado antes de que haya base.
const MAX_MATCHES = 200;

export class MemoryHistory implements HistoryPort {
  private readonly byMatch = new Map<string, HistoryEntry[]>();

  record(entries: readonly HistoryEntry[]): void {
    for (const entry of entries) {
      const existing = this.byMatch.get(entry.matchId);
      if (existing) {
        existing.push(entry);
        continue;
      }
      if (this.byMatch.size >= MAX_MATCHES) {
        const oldest = this.byMatch.keys().next().value;
        if (oldest !== undefined) this.byMatch.delete(oldest);
      }
      this.byMatch.set(entry.matchId, [entry]);
    }
  }

  /** Para tests y para la consola de soporte. No es API de producto. */
  of(matchId: string): readonly HistoryEntry[] {
    return this.byMatch.get(matchId) ?? [];
  }
}
```

```ts
// src/features/match/network/index.ts
export * from "./events.js";
export * from "./history.js";
export * from "./listeners.js";
export * from "./pieces.js";
```

- [ ] **Step 8: Correr los tests y commitear**

Run: `npx vitest run src/features/match/network/`
Expected: 10 tests PASAN.

```bash
npm run typecheck && npm test
git add src/features/match/network
git commit -m "feat(network): grabador del historial y notificador con disyuntor

El historial graba actos Y hechos intercalados con un solo seq. El source no es un
adorno: el mismo verbo puede venir de las dos bocas, y para un reclamo esa es toda
la pregunta.

El aplanado pasa por toJSON() y no por spread, porque en schema 5 los campos no son
propiedades propias del objeto: { ...tile } devuelve {} y la ficha se registraría
vacía, con lo cual el replay no reconstruiría nada.

El notificador corta la cascada de listeners a las 10 rondas: un listener que
reacciona a lo que él mismo produce cuelga la partida en un bucle mudo.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 10: Los adaptadores de infraestructura y el wiring

**Files:**
- Create: `src/features/match/transports/colyseus/visibility.ts`, `.../timeout-scheduler.ts`, `src/features/match/transports/match-contract.ts`, `.../match-registry.ts`, `src/logger.ts`, `.../colyseus/commands/di-wiring.ts`
- Test: `src/features/match/transports/colyseus/visibility.test.ts`, `.../timeout-scheduler.test.ts`, `.../match-registry.test.ts`

- [ ] **Step 1: Escribir el test de la visibilidad**

Se prueba **sin levantar una sala**, y eso es la prueba de que la clase no conoce `Client`.

```ts
// src/features/match/transports/colyseus/visibility.test.ts
import { Encoder, StateView } from "@colyseus/schema";
import { describe, expect, it } from "vitest";
import { Tile } from "../../core/state/index.js";
import { StateViewVisibilityController } from "./visibility.js";

function build() {
  const views = new Map([
    ["u1", new StateView()],
    ["u2", new StateView()],
  ]);
  return { views, controller: new StateViewVisibilityController(views) };
}

function attachedTile() {
  const tile = new Tile();
  new Encoder(tile);
  return tile;
}

describe("StateViewVisibilityController", () => {
  it("PLAYER agrega el nodo solo a la vista de ese asiento", () => {
    const { views, controller } = build();
    const tile = attachedTile();
    controller.makePublic(tile, { kind: "PLAYER", playerId: "u1" });

    expect(views.get("u1")?.has(tile)).toBe(true);
    expect(views.get("u2")?.has(tile)).toBe(false);
  });

  it("ALL agrega el nodo a todas las vistas", () => {
    const { views, controller } = build();
    const tile = attachedTile();
    controller.makePublic(tile, { kind: "ALL" });

    expect(views.get("u1")?.has(tile)).toBe(true);
    expect(views.get("u2")?.has(tile)).toBe(true);
  });

  it("hide lo quita de esa vista", () => {
    const { views, controller } = build();
    const tile = attachedTile();
    controller.makePublic(tile, { kind: "ALL" });
    controller.hide(tile, { kind: "PLAYER", playerId: "u2" });

    expect(views.get("u1")?.has(tile)).toBe(true);
    expect(views.get("u2")?.has(tile)).toBe(false);
  });

  // La audiencia es de DOMINIO. Un asiento que en este momento no tiene conexión
  // igual recibe lo revelado, porque la vista es del ASIENTO y no del socket: es lo
  // que hace que al volver no entres ciego.
  it("un asiento sin conexión igual recibe lo revelado", () => {
    const { views, controller } = build();
    const tile = attachedTile();
    // Nadie se conectó nunca; las vistas se crearon en onCreate.
    controller.makePublic(tile, { kind: "PLAYER", playerId: "u2" });
    expect(views.get("u2")?.has(tile)).toBe(true);
  });

  it("repetir makePublic es no-op", () => {
    const { views, controller } = build();
    const tile = attachedTile();
    controller.makePublic(tile, { kind: "ALL" });
    controller.makePublic(tile, { kind: "ALL" });
    expect(views.get("u1")?.has(tile)).toBe(true);
  });

  it("PLAYER para un asiento ausente lanza InvariantViolationError con el id", () => {
    const { controller } = build();
    expect(() => controller.makePublic(attachedTile(), { kind: "PLAYER", playerId: "u9" })).toThrow(
      /u9/,
    );
  });

});
```

- [ ] **Step 1b: Escribir el test del scheduler**

Usar un reloj mínimo que registre callbacks y `clear()`. Cubrir que `schedule` difunde el
resultado al vencer, que un segundo `schedule` limpia y reemplaza el primero, que `cancel`
evita la difusión y es idempotente, y que un deadline pasado se programa con delay `0`.
El test de reemplazo debe fallar si se quita temporalmente el `clear` del timer anterior.

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/features/match/transports/colyseus/visibility.test.ts src/features/match/transports/colyseus/timeout-scheduler.test.ts`
Expected: FAIL con `Failed to resolve import "./visibility.js"`.

- [ ] **Step 3: Escribir los dos adaptadores**

```ts
// src/features/match/transports/colyseus/visibility.ts
import type { Schema, StateView } from "@colyseus/schema";
import { InvariantViolationError } from "../../core/engine/errors.js";
import type { Audience, SchemaVisibilityController } from "../../core/engine/visibility.js";
import type { PlayerId } from "../../core/ids.js";

// LA VISTA ES DEL ASIENTO, NO DEL SOCKET, y ese es todo el diseño de esta clase.
//
// La versión ingenua traduce jugador → cliente conectado → vista, recorriendo
// room.clients. Eso tiene un bug que no se ve hasta que alguien se cae: Colyseus
// borra al cliente de room.clients ANTES de llamar a cualquier hook, así que lo que
// se revele mientras está fuera no llega nunca a su vista, y al volver entra CIEGO
// —sin su propia mano— incluso reusándola.
//
// Recibiendo el mapa de vistas por ASIENTO, creado en onCreate antes de que se
// conecte nadie, el problema no existe. Efecto colateral: esta clase no conoce
// `Client`, así que se prueba sin levantar una sala.
export class StateViewVisibilityController implements SchemaVisibilityController {
  constructor(private readonly views: ReadonlyMap<PlayerId, StateView>) {}

  makePublic(node: Schema, audience: Audience): void {
    for (const view of this.resolve(audience)) view.add(node);
  }

  hide(node: Schema, audience: Audience): void {
    for (const view of this.resolve(audience)) view.remove(node);
  }

  private resolve(audience: Audience): StateView[] {
    switch (audience.kind) {
      case "ALL":
        return [...this.views.values()];
      case "PLAYER": {
        const view = this.views.get(audience.playerId);
        if (!view) {
          throw new InvariantViolationError(`sin vista para el asiento ${audience.playerId}`);
        }
        return [view];
      }
    }
  }
}
```

```ts
// src/features/match/transports/colyseus/timeout-scheduler.ts
import type { Delayed } from "colyseus";
import type { MatchEvent } from "../../core/events.js";
import type { TimeoutScheduler } from "../../core/engine/timeout-scheduler.js";

// Adaptador TONTO del puerto. No conoce el engine, no sabe qué hace el callback
// ni para qué es el timeout: solo espera hasta el instante y difunde lo que salga.
//
// Sostiene el ÚNICO timer de fase y lo reemplaza en cada schedule, porque el engine
// lo re-arma al final de cada transición. Es idempotente porque el instante es absoluto.
export class RoomTimeoutScheduler implements TimeoutScheduler {
  private timer?: Delayed;

  constructor(
    private readonly clock: { setTimeout(fn: () => void, ms: number): Delayed },
    private readonly emit: (events: readonly MatchEvent[]) => void,
  ) {}

  schedule(at: number, onExpire: () => readonly MatchEvent[]): void {
    this.timer?.clear();
    this.timer = this.clock.setTimeout(() => this.emit(onExpire()), Math.max(0, at - Date.now()));
  }

  cancel(): void {
    this.timer?.clear();
    this.timer = undefined;
  }
}
```

- [ ] **Step 4: Correr los tests hasta que pasen**

Run: `npx vitest run src/features/match/transports/colyseus/visibility.test.ts src/features/match/transports/colyseus/timeout-scheduler.test.ts`
Expected: los 6 tests de visibilidad y los 4 del scheduler PASAN.

Si `StateView` no expone `has()`, cambiar las aserciones por lo que sí exponga (comprobado en la
referencia del Step 1 de la Tarea 4). Lo que no se negocia es que el test demuestre que un asiento
**sin conexión** recibe lo revelado.

- [ ] **Step 5: Escribir el test del registro de partidas vivas**

```ts
// src/features/match/transports/match-registry.test.ts
import { describe, expect, it } from "vitest";
import type { DominoMatchConfig } from "../core/config.js";
import { MatchRegistry } from "./match-registry.js";

const config = {
  matchId: "m1",
  gameModeId: "clasica-2p",
  seed: "secreto-que-no-sale",
  seats: ["u1", "u2"],
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  isDealWindowEnabled: true,
} satisfies DominoMatchConfig;

describe("MatchRegistry", () => {
  it("responde el DTO público por roomId", () => {
    const registry = new MatchRegistry();
    registry.register("room-1", config);
    expect(registry.publicConfigOf("room-1")).toEqual({
      matchId: "m1",
      gameModeId: "clasica-2p",
      seats: ["u1", "u2"],
      pointsToWin: 100,
    });
  });

  // El seed hace el reparto determinista: si sale al cliente, el cliente sabe
  // qué le va a tocar al rival.
  it("el DTO público NO lleva el seed", () => {
    const registry = new MatchRegistry();
    registry.register("room-1", config);
    expect(JSON.stringify(registry.publicConfigOf("room-1"))).not.toContain("secreto");
  });

  it("contesta undefined para una sala que no existe", () => {
    expect(new MatchRegistry().publicConfigOf("nope")).toBeUndefined();
  });

  it("matchOf encuentra la partida viva de un jugador", () => {
    const registry = new MatchRegistry();
    registry.register("room-1", config);
    expect(registry.matchOf("u2")).toBe("room-1");
    expect(registry.matchOf("u9")).toBeUndefined();
  });

  it("remove la saca, y con ella la sesión única", () => {
    const registry = new MatchRegistry();
    registry.register("room-1", config);
    registry.remove("room-1");
    expect(registry.publicConfigOf("room-1")).toBeUndefined();
    expect(registry.matchOf("u1")).toBeUndefined();
  });
});
```

- [ ] **Step 6: Escribir `match-contract.ts` y `match-registry.ts`**

```ts
// src/features/match/transports/match-contract.ts
// EL CONTRATO de una sala: con qué se abre y con qué se sienta uno. Nada de esto
// menciona Colyseus, y lo importa el emparejamiento —que es quien crea las salas—,
// así que vive en la raíz de transports y no dentro de colyseus/.
import type { DominoMatchConfig, TeamAssignmentMode } from "../core/config.js";

// Unión discriminada por modo, no un objeto con todo opcional: así no existe la
// combinación ilegal ni hay que confiar en que nadie la arme. Hoy hay una rama;
// las de torneo y apuesta llegan con sus incrementos.
export type DominoRoomOptions = {
  readonly mode: "CASUAL";
  readonly matchId: string;
  readonly gameModeId: string;
  readonly seats: readonly string[];
  readonly seed: string;
  readonly pointsToWin: number;
  readonly teamAssignment: TeamAssignmentMode;
};

// Lo que onAuth produce y queda en client.auth.
export interface SeatCredentials {
  readonly userId: string;
  readonly token: string;
}

// Derivación PURA, fuera de la sala.
export function configOf(options: DominoRoomOptions): DominoMatchConfig {
  return {
    matchId: options.matchId,
    gameModeId: options.gameModeId,
    seed: options.seed,
    seats: options.seats,
    pointsToWin: options.pointsToWin,
    teamAssignment: options.teamAssignment,
    // NO viaja en las opciones de la sala, y es deliberado: la ventana de reparto es el
    // control de presencia del arranque (reglas §3.1) y **va en toda mesa**. Si fuera un
    // campo de `DominoRoomOptions`, quien cree salas —hoy los tests, mañana matchmaking—
    // podría olvidarlo, y olvidarlo apaga un control antifraude en silencio. Acá está
    // fijo y sigue siendo un solo lugar para que producto lo apague.
    isDealWindowEnabled: true,
  };
}
```

```ts
// src/features/match/transports/match-registry.ts
import type { DominoMatchConfig } from "../core/config.js";

// El DTO que el front consume por HTTP. SIN seed.
export interface PublicMatchConfig {
  readonly matchId: string;
  readonly gameModeId: string;
  readonly seats: readonly string[];
  readonly pointsToWin: number;
}

// Lo que DEVUELVE el endpoint: el config inmutable más UNA muestra del reloj del
// servidor. `serverNow` no es config —cambia en cada request— y por eso es un tipo
// aparte y no un campo de `PublicMatchConfig`: nadie lo puede cachear por error junto
// con el resto, y `publicConfigOf` sigue siendo puro.
//
// PARA QUÉ. `MatchState.activeDeadline` es un instante ABSOLUTO en epoch del servidor
// (§7.1 del spec explica por qué epoch y no la timeline de la sala). El front dibuja la
// cuenta atrás restándole "ahora", y si le resta su propio `Date.now()` un dispositivo
// con el reloj corrido —móvil sin NTP, zona mal configurada, emulador— muestra el turno
// ya vencido o con minutos de sobra. Con esta muestra el cliente calcula
// `offset = serverNow - Date.now()` UNA vez y dibuja
// `activeDeadline - (Date.now() + offset)`.
//
// El error residual es medio round-trip: decenas de ms contra una ventana de 60.000 ms.
// Colyseus tiene maquinaria fina para esto (`room.clock.serverNow()`), pero su estimador
// solo existe en salas que llaman `defineInput()` —el camino de predicción, con timestep
// fijo y `step()`—; una sala por turnos se queda con un stub que lee el reloj local. La
// propia doc bendice la salida: "¿traés tu propio algoritmo de sync? `room.clock = new
// MyClock()`". Esto es ese algoritmo, en su versión más simple.
export interface MatchConfigResponse extends PublicMatchConfig {
  /** Muestra de `Date.now()` del servidor al momento del request. NO cachear. */
  readonly serverNow: number;
}

// LO QUE NO ENTRA EN EL DTO, y es una decisión: `isDealWindowEnabled` y su duración.
//
// Truco los pone en el suyo para que el front dibuje el botón y su cuenta atrás. Acá no
// hacen falta, y agregarlos sería duplicar estado derivable:
//   · ¿hay ventana? → `currentRound.phase === "DEALING"`.
//   · ¿me toca a mí? → `!player.hasSeenTiles`.
//   · ¿cuánto queda? → `activeDeadline` (se estampa también para esta fase) menos
//     `Date.now() + offset`.
// El único caso que el DTO cubriría es pintar una barra de progreso que necesite el TOTAL
// además del resto. Cuando aparezca ese requerimiento se agrega el campo; hoy sería
// especulación, y un campo de config que contradice al estado es el peor de los dos.

// Las partidas VIVAS del proceso. De acá salen dos respuestas: el config público
// por roomId, y "¿este jugador ya está jugando?" —la sesión única—.
//
// Es process-local. El día que haya varios procesos, esto va detrás de Redis; es la
// misma decisión que hace atómico el take de la cola.
export class MatchRegistry {
  private readonly byRoom = new Map<string, DominoMatchConfig>();

  register(roomId: string, config: DominoMatchConfig): void {
    this.byRoom.set(roomId, config);
  }

  remove(roomId: string): void {
    this.byRoom.delete(roomId);
  }

  publicConfigOf(roomId: string): PublicMatchConfig | undefined {
    const config = this.byRoom.get(roomId);
    if (!config) return undefined;
    // Se listan los campos que SALEN, en vez de borrar el seed de una copia:
    // así un campo nuevo en el config no se filtra por olvido.
    return {
      matchId: config.matchId,
      gameModeId: config.gameModeId,
      seats: config.seats,
      pointsToWin: config.pointsToWin,
    };
  }

  matchOf(playerId: string): string | undefined {
    for (const [roomId, config] of this.byRoom) {
      if (config.seats.includes(playerId)) return roomId;
    }
    return undefined;
  }
}
```

- [ ] **Step 7: Correr el test hasta que pase**

Run: `npx vitest run src/features/match/transports/match-registry.test.ts`
Expected: los 5 tests PASAN.

- [ ] **Step 8: Escribir el logger**

```ts
// src/logger.ts
import pino from "pino";
import { env } from "./env.js";

// UNA sola fachada, y su método que importa es child(): la sala crea
// logger.child({ matchId, roomId, gameModeId }) en onCreate, y NADA dentro de una
// partida loguea sin él. Eso es todo el requerimiento de "buscar el log por el id
// de la partida": {matchId="…"} devuelve la traza completa y solo esa.
//
// El DOMINIO NO LOGUEA. Solo transports/ y network/.
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

function wrap(instance: pino.Logger): Logger {
  return {
    debug: (message, fields) => instance.debug(fields ?? {}, message),
    info: (message, fields) => instance.info(fields ?? {}, message),
    warn: (message, fields) => instance.warn(fields ?? {}, message),
    error: (message, fields) => instance.error(fields ?? {}, message),
    child: (fields) => wrap(instance.child(fields)),
  };
}

export const logger: Logger = wrap(
  pino({ level: env.logLevel, base: { app: "domino-backend-v2", env: env.nodeEnv } }),
);
```

- [ ] **Step 9: Escribir el wiring**

```ts
// src/features/match/transports/colyseus/commands/di-wiring.ts
// Uno de los tres archivos del repo que importan tsyringe. Registra con useValue y
// useFactory EXPLÍCITAS, nunca useClass —que exigiría decorar clases—, así que los
// actores y los comandos son clases planas instanciables con new.
//
// Este archivo documenta las dependencias exactas de cada comando en el único lugar
// cuyo trabajo es saberlas.
import type { DependencyContainer } from "tsyringe";
import type { GlobalDominoConfig } from "../../../core/config.js";
import type { Clock } from "../../../core/engine/clock.js";
import { MatchDriver } from "../../../core/engine/match/driver.js";
import { MatchPlayer } from "../../../core/engine/match/player.js";
import { MatchReferee } from "../../../core/engine/match/referee.js";
import { Player } from "../../../core/engine/player-facade.js";
import { PlayerRepository } from "../../../core/engine/player-repository.js";
import { Referee } from "../../../core/engine/referee-facade.js";
import type { TimeoutScheduler } from "../../../core/engine/timeout-scheduler.js";
import type { MatchState } from "../../../core/state/index.js";
import { AbandonCommand } from "../../../core/commands/index.js";
import { MatchHistory } from "../../../network/history.js";
import type { HistoryPort } from "../../../network/history.js";
import type { MatchPieces } from "../../../network/pieces.js";
import type { MatchEventSink } from "../../../network/listeners.js";
import type { DominoMatchConfig } from "../../../core/config.js";
import { CommandCatalog } from "./catalog.js";
import { identityDecoder } from "./decoders.js";

// La sala NO puede llamarle advance/timeout al conductor, así que el MatchDriver no
// se registra: es un const interno de esta función. De él la sala solo alcanza dos
// closures de una línea.
export type MatchStarter = () => void;
export type MatchSeatGuard = (playerId: string) => boolean;

export function registerIndividualCommands(child: DependencyContainer): void {
  const match = child.resolve<MatchState>("MatchState");
  const config = child.resolve<DominoMatchConfig>("Config");
  const globalConfig = child.resolve<GlobalDominoConfig>("GlobalDominoConfig");
  const clock = child.resolve<Clock>("Clock");
  const scheduler = child.resolve<TimeoutScheduler>("TimeoutScheduler");

  // EN ORDEN DE DEPENDENCIA: jueces, conductor, players, facades, comandos.
  const matchReferee = new MatchReferee(match);
  const matchDriver = new MatchDriver(match, clock, scheduler, globalConfig, matchReferee);
  const repository = new PlayerRepository(
    config.seats,
    (playerId) => new MatchPlayer(playerId, match),
  );
  const players = new Player(repository);
  const referee = new Referee(matchReferee);

  child.register("Referee", { useValue: referee });
  child.register("MatchStarter", { useValue: (() => matchDriver.begin()) satisfies MatchStarter });
  child.register("MatchSeatGuard", {
    useValue: ((playerId: string) =>
      !match.players.find((p) => p.playerId === playerId)?.hasAbandoned) satisfies MatchSeatGuard,
  });
  child.register("Command:ABANDON", {
    useValue: new AbandonCommand(referee, players, matchDriver),
  });
}

export function buildCatalog(child: DependencyContainer): CommandCatalog {
  return new CommandCatalog(
    { ABANDON: identityDecoder("ABANDON") },
    { ABANDON: child.resolve("Command:ABANDON") },
  );
}

export function buildPieces(child: DependencyContainer, emit: MatchEventSink): MatchPieces {
  const config = child.resolve<DominoMatchConfig>("Config");
  const match = child.resolve<MatchState>("MatchState");
  const clock = child.resolve<Clock>("Clock");
  const port = child.resolve<HistoryPort>("HistoryPort");

  // Lo que NO depende del ámbito va afuera de cualquier rama: el grabador registra
  // lo mismo en casual que en torneo.
  const history = new MatchHistory(config.matchId, match, clock, port);
  void emit; // los listeners de ámbito llegan con la economía; hoy no hay ninguno.

  return { history, listeners: [], sinks: [(events) => history.events(events)] };
}
```

- [ ] **Step 10: Verificar que el wiring no violó la Regla 3 y commitear**

Run: `npm test`
Expected: TODO pasa. `src/architecture.test.ts` confirma que `tsyringe` solo aparece en
`di-wiring.ts` (y, tras la Tarea 11, en `di-container.ts` y `domino-room.ts`).

```bash
npm run typecheck && npm test
git add src
git commit -m "feat(transports): adaptadores de visibilidad y timer, registro de partidas y wiring

La vista es del ASIENTO y no del socket: el controlador recibe el mapa de vistas
por asiento creado en onCreate, así que lo revelado mientras un jugador está fuera
le espera al volver. La versión que recorre room.clients tiene un bug que no se ve
hasta que alguien se cae, porque Colyseus lo borra de esa lista antes de llamar a
ningún hook.

El adaptador del timer es tonto a propósito: espera hasta el instante y difunde,
sin leer fases ni deadlines.

El DTO público del config lista los campos que salen en vez de borrar el seed de
una copia, para que un campo nuevo no se filtre por olvido.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 11: `auth` — quién es el que se conecta

Feature chica, pero con puerto y con secreto, y eso es lo que la separa de `shared/`.

**Files:**
- Create: `src/features/auth/identity.ts`, `.../transports/jwt-verifier.ts`, `.../index.ts`
- Test: `src/features/auth/transports/jwt-verifier.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// src/features/auth/transports/jwt-verifier.test.ts
import jwt from "jsonwebtoken";
import { describe, expect, it } from "vitest";
import { InvalidTokenError } from "../identity.js";
import { JwtVerifier } from "./jwt-verifier.js";

const SECRET = "s".repeat(32);
const verifier = new JwtVerifier(SECRET);

describe("JwtVerifier", () => {
  it("acepta un token válido y devuelve la identidad", async () => {
    const token = jwt.sign({ sub: "u1" }, SECRET, { algorithm: "HS256", expiresIn: "1h" });
    await expect(verifier.verify(token)).resolves.toEqual({ userId: "u1" });
  });

  it("rechaza la ausencia de token", async () => {
    await expect(verifier.verify(undefined)).rejects.toThrow(InvalidTokenError);
  });

  it("rechaza un token firmado con otro secreto", async () => {
    const token = jwt.sign({ sub: "u1" }, "otro-secreto-largo-largo", { algorithm: "HS256" });
    await expect(verifier.verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rechaza un token vencido", async () => {
    const token = jwt.sign({ sub: "u1" }, SECRET, { algorithm: "HS256", expiresIn: "-1h" });
    await expect(verifier.verify(token)).rejects.toThrow(InvalidTokenError);
  });

  // EL AGUJERO CLÁSICO DE JWT: si la lista de algoritmos no está fijada, un token
  // con alg: none pasa sin firma y cualquiera se hace pasar por cualquiera.
  it("rechaza alg: none", async () => {
    const token = jwt.sign({ sub: "u1" }, "", { algorithm: "none" });
    await expect(verifier.verify(token)).rejects.toThrow(InvalidTokenError);
  });

  // `alg: none` no alcanza para probar la allowlist: jsonwebtoken también lo rechaza
  // automáticamente cuando recibe un secreto. HS384 con el secreto correcto demuestra
  // que el verificador no acepta algoritmos HMAC distintos del contratado.
  it("rechaza HS384 aunque use el secreto correcto", async () => {
    const token = jwt.sign({ sub: "u1" }, SECRET, { algorithm: "HS384" });
    await expect(verifier.verify(token)).rejects.toThrow(InvalidTokenError);
  });

  it("rechaza un token sin claim sub", async () => {
    const token = jwt.sign({ foo: "bar" }, SECRET, { algorithm: "HS256" });
    await expect(verifier.verify(token)).rejects.toThrow(InvalidTokenError);
  });

  // Poder emitir identidades es una capacidad que este servidor no debe tener ni
  // por accidente. El dominó VERIFICA y nunca firma.
  it("no expone ninguna forma de firmar", () => {
    expect((verifier as unknown as Record<string, unknown>).sign).toBeUndefined();
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/features/auth/transports/jwt-verifier.test.ts`
Expected: FAIL con `Failed to resolve import "../identity.js"`.

- [ ] **Step 3: Escribir la feature**

```ts
// src/features/auth/identity.ts
export interface Identity {
  readonly userId: string;
}

// El PUERTO. Es lo que impide que match y matchmaking importen una librería de JWT.
// Cuando llegue el multi-operador, esta misma interfaz resuelve el verificador por
// `iss`/`kid` y nada de arriba se entera.
export interface TokenVerifier {
  verify(token: string | undefined): Promise<Identity>;
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`Token inválido: ${reason}`);
    this.name = "InvalidTokenError";
  }
}
```

```ts
// src/features/auth/transports/jwt-verifier.ts
import jwt from "jsonwebtoken";
import { type Identity, InvalidTokenError, type TokenVerifier } from "../identity.js";

// FIJADA a propósito: sin esta lista, un token con `alg: none` pasa sin firma.
const ALGORITHMS: jwt.Algorithm[] = ["HS256"];

// No hay `sign` en esta clase, y es deliberado: poder emitir identidades es una
// capacidad que este servidor no debe tener ni por accidente. El secreto es
// compartido con el backend principal, que es quien firma.
export class JwtVerifier implements TokenVerifier {
  constructor(private readonly secret: string) {}

  async verify(token: string | undefined): Promise<Identity> {
    if (!token) throw new InvalidTokenError("ausente");

    let payload: jwt.JwtPayload | string;
    try {
      payload = jwt.verify(token, this.secret, { algorithms: ALGORITHMS });
    } catch (error) {
      throw new InvalidTokenError(error instanceof Error ? error.message : "irreconocible");
    }

    if (typeof payload === "string" || typeof payload.sub !== "string" || payload.sub === "") {
      throw new InvalidTokenError("sin claim sub");
    }
    return { userId: payload.sub };
  }
}
```

```ts
// src/features/auth/index.ts
export * from "./identity.js";
export * from "./transports/jwt-verifier.js";
```

- [ ] **Step 4: Correr el test hasta que pase**

Run: `npx vitest run src/features/auth/transports/jwt-verifier.test.ts`
Expected: los 8 tests PASAN.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm test
git add src/features/auth
git commit -m "feat(auth): puerto de identidad y verificador JWT HS256

La lista de algoritmos está fijada: sin eso, un token con alg: none pasa sin firma
y cualquiera se hace pasar por cualquiera. Va con test.

No hay método sign, y es deliberado: poder emitir identidades es una capacidad
que este servidor no debe tener ni por accidente.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 12: `DominoRoom` — transporte y composition root per-partida

La única pieza que habla Colyseus. Además de transportar, **cuenta** los tres hechos que el juego no
tiene por qué saber: que un socket se cayó, que volvió, y que esta partida murió sin veredicto.

**Files:**
- Create: `src/features/match/transports/colyseus/domino-room.ts`, `src/features/match/transports/colyseus/domino-room.test.ts`, `src/features/match/transports/http/register-http.ts`, `src/features/match/index.ts`, `src/di-container.ts`, `src/app.config.ts`, `src/index.ts`
- Modify: `src/features/match/transports/colyseus/commands/di-wiring.ts`

La sala se prueba acá con `boot(app)` y clientes reales. La revisión contra el runtime instalado
descubrió comportamientos que un test instanciado a mano no ve: `@colyseus/auth` parchea el
`onAuth` estático, las reservas pendientes cuentan para `maxClients`, y el camino de reconexión no
vuelve a ejecutar `onAuth` ni `onJoin`.

- [ ] **Step 1: Escribir el composition root global**

```ts
// src/di-container.ts
// Root GLOBAL del proceso. Registra lo verdaderamente global y stateless. Los actores
// del engine NO viven acá: son match-bound (sostienen el MatchState), así que los arma
// el child per-partida.
import "reflect-metadata";
import { container } from "tsyringe";
import { JwtVerifier } from "./features/auth/index.js";
import { DEFAULT_GLOBAL_CONFIG } from "./features/match/core/config.js";
import type { Clock } from "./features/match/core/engine/clock.js";
import { MemoryHistory } from "./features/match/network/transports/memory-history.js";
import { MatchRegistry } from "./features/match/transports/match-registry.js";
import { env } from "./env.js";
import { logger } from "./logger.js";

export const rootContainer = container;

rootContainer.register("GlobalDominoConfig", { useValue: DEFAULT_GLOBAL_CONFIG });
rootContainer.register("Clock", { useValue: { now: () => Date.now() } satisfies Clock });
rootContainer.register("Logger", { useValue: logger });
rootContainer.register("TokenVerifier", { useValue: new JwtVerifier(env.jwtSecret) });

// Viven MÁS que una sala: el registro tiene que poder contestar "¿este jugador está
// jugando?" y el historial tiene que seguir aceptando entradas de una partida que
// ya cerró.
rootContainer.register(MatchRegistry, { useValue: new MatchRegistry() });
// El adaptador de Mongo llega con la persistencia; cambiarlo no toca ninguna pieza
// de arriba, que es todo el punto del puerto.
rootContainer.register("HistoryPort", { useValue: new MemoryHistory() });
```

- [ ] **Step 2: Escribir la sala**

Antes, exponer desde el wiring una consulta angosta del veredicto; la sala no recibe el
`MatchDriver` concreto ni decide de nuevo cuándo una partida tiene resultado:

```ts
export type MatchHasOutcome = () => boolean;

child.register<MatchHasOutcome>("MatchHasOutcome", {
  useValue: () => matchReferee.outcome() !== undefined,
});
```

```ts
// src/features/match/transports/colyseus/domino-room.ts
import { StateView } from "@colyseus/schema";
import { type AuthContext, type Client, CloseCode, type Delayed, Room } from "colyseus";
import { rootContainer } from "../../../../di-container.js";
import type { Logger } from "../../../../logger.js";
import { InvalidTokenError, type TokenVerifier } from "../../../auth/index.js";
import type { GlobalDominoConfig } from "../../core/config.js";
import { createMatchState } from "../../core/engine/genesis.js";
import { RuleViolationError } from "../../core/engine/errors.js";
import type { PlayerId } from "../../core/ids.js";
import type { MatchState } from "../../core/state/index.js";
import type { AbortReason } from "../../network/events.js";
import type { MatchHistory } from "../../network/history.js";
import { MatchEventNotifier } from "../../network/listeners.js";
import { configOf, type DominoRoomOptions, type SeatCredentials } from "../match-contract.js";
import { MatchRegistry } from "../match-registry.js";
import type { CommandCatalog } from "./commands/catalog.js";
import {
  buildCatalog,
  buildPieces,
  type MatchHasOutcome,
  type MatchSeatGuard,
  type MatchStarter,
  registerIndividualCommands,
} from "./commands/di-wiring.js";
import {
  PlayerAlreadyOutError,
  SeatNotReservedError,
  UnknownCommandError,
  ValidationError,
} from "./errors.js";
import { RoomTimeoutScheduler } from "./timeout-scheduler.js";
import { StateViewVisibilityController } from "./visibility.js";

const RECONNECTION_WINDOW_SECONDS = 120;

export class DominoRoom extends Room<{ state: MatchState; client: Client }> {
  private seats: readonly PlayerId[] = [];
  private catalog!: CommandCatalog;
  private notifier!: MatchEventNotifier;
  private scheduler!: RoomTimeoutScheduler;
  private history!: MatchHistory;
  private hasOutcome!: MatchHasOutcome;
  private isStillPlaying!: MatchSeatGuard;
  private startMatch!: MatchStarter;
  private log!: Logger;
  private seating?: Delayed;
  /** La vista es del ASIENTO, no del socket: una por asiento, creada antes de que se conecte nadie. */
  private readonly views = new Map<PlayerId, StateView>();
  /** Qué asientos ya tuvieron conexión: distingue "llegó" de "volvió". */
  private readonly seated = new Set<PlayerId>();

  // Importar `colyseus` carga @colyseus/auth, que instala un onAuth estático y, si
  // acepta el token, hace que Colyseus saltee el verificador de instancia. Esta sala
  // neutraliza ese default: TokenVerifier sigue siendo la única autoridad.
  static override async onAuth(
    _token: string,
    _options: unknown,
    _context: AuthContext,
  ): Promise<true> {
    return true;
  }

  override onCreate(options: DominoRoomOptions): void {
    const global = rootContainer.resolve<GlobalDominoConfig>("GlobalDominoConfig");
    // Colyseus suma sockets y reservas pendientes antes de llegar a onJoin. El cupo
    // técnico doble conserva un token viejo mientras admite un reemplazo autenticado;
    // la puerta de asientos reales sigue siendo el guard de onJoin.
    this.maxClients = options.seats.length * 2;
    this.seats = options.seats;

    const config = configOf(options);
    const match = createMatchState(config);

    const child = rootContainer.createChildContainer();
    child.register("Config", { useValue: config });
    child.register("MatchState", { useValue: match });

    // ANTES de que se conecte nadie: revelar tiene que llegarle también al asiento
    // que en ese momento no está.
    for (const playerId of options.seats) this.views.set(playerId, new StateView());
    child.register("SchemaVisibilityController", {
      useValue: new StateViewVisibilityController(this.views),
    });

    // Se registra ANTES del wiring del engine, para que el MatchDriver lo reciba.
    this.scheduler = new RoomTimeoutScheduler(this.clock, (events) => this.notifier.notify(events));
    child.register("TimeoutScheduler", { useValue: this.scheduler });

    registerIndividualCommands(child);
    this.catalog = buildCatalog(child);

    const pieces = buildPieces(child, (events) => this.notifier.notify(events));
    this.history = pieces.history;
    this.notifier = new MatchEventNotifier(
      pieces.listeners,
      (events) => this.broadcast("events", events),
      pieces.sinks,
    );

    // Se resuelven UNA vez acá: resolver pertenece al momento de composición,
    // no al request.
    this.hasOutcome = child.resolve<MatchHasOutcome>("MatchHasOutcome");
    this.isStillPlaying = child.resolve<MatchSeatGuard>("MatchSeatGuard");
    this.startMatch = child.resolve<MatchStarter>("MatchStarter");

    // Cada línea de log de esta partida cuelga de acá, sin excepción.
    // {matchId="…"} en Loki devuelve la traza completa y solo esa.
    this.log = rootContainer
      .resolve<Logger>("Logger")
      .child({ matchId: config.matchId, roomId: this.roomId, gameModeId: config.gameModeId });

    this.setState(match);
    rootContainer.resolve(MatchRegistry).register(this.roomId, config);

    // Colyseus auto-destruye una sala con CERO clientes, pero no la que tiene UNO
    // esperando a alguien que no llega — y ésa es justo la que ya cobró.
    this.seating = this.clock.setTimeout(() => {
      this.log.warn("plazo de ocupación vencido, cerrando la sala");
      void this.disconnect();
    }, global.seatingTimeoutMs);

    this.onMessage("*", (client, type, message) =>
      this.handleMessage(client, String(type), message),
    );
    this.log.info("sala creada", { seats: options.seats.length });
  }

  override async onAuth(_client: Client, _options: unknown, context: AuthContext): Promise<SeatCredentials> {
    const token = context.token ?? undefined;
    const identity = await rootContainer.resolve<TokenVerifier>("TokenVerifier").verify(token);
    return { userId: identity.userId, token: token ?? "" };
  }

  // LA PUERTA, y es la misma para el que llega y para el que vuelve.
  // maxClients NO es la puerta de seguridad: lo es este orden de comprobaciones.
  override onJoin(client: Client): void {
    const { userId } = client.auth as SeatCredentials;
    if (!this.seats.includes(userId)) throw new SeatNotReservedError(userId);
    if (!this.isStillPlaying(userId)) throw new PlayerAlreadyOutError(userId);

    client.userData = { playerId: userId };
    client.view = this.views.get(userId); // la vista de su ASIENTO, con lo ya revelado
    const player = this.state.players.find((candidate) => candidate.playerId === userId);
    if (player) player.connected = true;

    // UNA conexión por asiento. Se registra primero la nueva identidad para que
    // onLeave del socket desplazado no marque el asiento offline por una carrera.
    this.clientOf(userId, client)?.leave(CloseCode.CONSENTED);

    const isBack = this.seated.has(userId);
    this.seated.add(userId);
    if (isBack) this.notifier.notify([{ type: "PLAYER_RECONNECTED", playerId: userId }]);

    this.log.info(isBack ? "asiento reconectado" : "asiento ocupado", { playerId: userId });
    this.startIfSeated();
  }

  // Se le cayó el socket. NO es rendirse —para eso está el verbo ABANDON—, así que
  // el jugador sigue en la partida y el reloj del juego no se pausa.
  override onDrop(client: Client): void {
    const playerId = client.userData?.playerId as PlayerId | undefined;
    if (!playerId) return;

    void this.allowReconnection(client, RECONNECTION_WINDOW_SECONDS).catch(() => undefined);

    // unlock() abre el listing, pero NO libera la reserva ni baja
    // hasReachedMaxClients(). El cupo técnico doble de onCreate es lo que permite
    // que un reemplazo fresco llegue a onJoin.
    void this.unlock();

    const player = this.state.players.find((candidate) => candidate.playerId === playerId);
    if (player) player.connected = false;
    this.log.info("socket caído, ventana de reconexión abierta", {
      playerId,
      windowSeconds: RECONNECTION_WINDOW_SECONDS,
    });
  }

  override onReconnect(client: Client): void {
    const playerId = client.userData?.playerId as PlayerId | undefined;
    if (!playerId) return;
    // La reconexión SDK saltea onAuth y onJoin: repite sus guards en el mismo orden.
    if (!this.seats.includes(playerId)) throw new SeatNotReservedError(playerId);
    if (!this.isStillPlaying(playerId)) throw new PlayerAlreadyOutError(playerId);
    // Si un reemplazo fresco ya ganó el asiento, el token del socket viejo no lo expulsa.
    if (this.clientOf(playerId, client)) {
      client.leave(CloseCode.CONSENTED);
      return;
    }
    const player = this.state.players.find((candidate) => candidate.playerId === playerId);
    if (player) player.connected = true;
    if (this.clients.length >= this.maxClients) this.lock();
    this.notifier.notify([{ type: "PLAYER_RECONNECTED", playerId }]);
    this.log.info("reconectado", { playerId });
  }

  // Se fue para siempre: venció la ventana, o cerró consentido.
  override onLeave(client: Client): void {
    const playerId = client.userData?.playerId as PlayerId | undefined;
    if (!playerId) return;
    // El asiento ya tiene otra conexión: eso no es una caída, es la anterior
    // cerrándose porque la desplazamos.
    if (this.clientOf(playerId)) return;

    const player = this.state.players.find((candidate) => candidate.playerId === playerId);
    if (player) player.connected = false;
    this.notifier.notify([{ type: "PLAYER_DISCONNECTED", playerId }]);
    this.log.info("desconectado", { playerId });
  }

  override onDispose(): void {
    // El hecho es de la SALA: el juego no tiene un final sin veredicto. Sin este
    // aviso, el anillo nunca se entera y una entrada cobrada se queda sin reembolsar.
    //
    // ABANDON ya produce un veredicto en PRESENTING_MATCH. Preguntar por la fase
    // emitiría después MATCH_ABORTED y dejaría dos instrucciones de liquidación.
    if (this.notifier && !this.hasOutcome()) {
      const reason = this.abortReason();
      this.notifier.notify([{ type: "MATCH_ABORTED", reason }]);
      this.log.warn("partida abortada sin veredicto", { reason });
    }
    this.scheduler?.cancel();
    this.seating?.clear();
    // Determinista, en vez de esperar al GC.
    for (const view of this.views.values()) view.dispose();
    rootContainer.resolve(MatchRegistry).remove(this.roomId);
  }

  // Los tres momentos en que una partida puede morir sin veredicto, del más temprano al
  // más tardío. Los tres reembolsan; la diferencia es lo que soporte puede contestar.
  private abortReason(): AbortReason {
    if (this.state.startedAt === 0) return "NEVER_STARTED";
    // Se repartió y NADIE levantó sus fichas: venció la ventana de reparto con todos
    // ausentes (reglas §3.1). Se reconoce sin campo nuevo — nadie vio nada y nadie sigue
    // en pie— y es la razón por la que `outcome()` devuelve `undefined` en ese caso.
    if (this.state.players.every((player) => !player.hasSeenTiles)) return "NEVER_PLAYED";
    return "INTERRUPTED";
  }

  // UNA sola política, con lista blanca EXPLÍCITA de lo que no es bug. Sin esa lista,
  // un rechazo legítimo de la puerta cierra la partida de los que sí habían entrado.
  override onUncaughtException(error: Error & { cause?: unknown }, methodName: string): void {
    const cause = (error.cause ?? error) as Error;
    if (
      cause instanceof SeatNotReservedError ||
      cause instanceof PlayerAlreadyOutError ||
      cause instanceof ValidationError ||
      cause instanceof UnknownCommandError ||
      cause instanceof InvalidTokenError
    ) {
      this.log.warn("rechazo en la puerta", { methodName, error: cause.message });
      return;
    }
    this.crash(cause, methodName);
  }

  // El camino del comando es SÍNCRONO de punta a punta: sin un solo await, Node no
  // puede entrelazar dos mensajes del mismo cliente.
  private handleMessage(client: Client, type: string, raw: unknown): void {
    const playerId = client.userData?.playerId as PlayerId | undefined;
    if (!playerId) return;

    try {
      if (!this.catalog.accepts(type)) throw new UnknownCommandError(type);
      const payload = this.catalog.decoder(type).decode(raw, playerId);
      const events = this.catalog.command(type).execute(payload);
      // ANTES de notificar: primero el acto, después los hechos que provocó.
      // Y solo se registra lo que EJECUTÓ.
      this.history.command("PLAYER", type, payload);
      this.notifier.notify(events);
    } catch (error) {
      // Nunca `throw` desde acá: en 0.18 los handlers de onMessage no están envueltos.
      if (error instanceof RuleViolationError) {
        // Rastro antifraude: va al LOG, no al historial.
        this.log.warn("jugada ilegal", { playerId, type, code: error.code });
        client.send("illegal", { code: error.code });
        return;
      }
      if (error instanceof ValidationError) {
        this.log.warn("payload malformado", { playerId, type, detail: error.detail });
        client.send("illegal", { code: "MALFORMED", detail: error.detail });
        return;
      }
      if (error instanceof UnknownCommandError) {
        this.log.warn("verbo desconocido", { playerId, type });
        client.send("illegal", { code: "UNKNOWN_COMMAND" });
        return;
      }
      this.crash(error as Error, "onMessage");
    }
  }

  private startIfSeated(): void {
    if (this.seated.size < this.seats.length) return;
    this.seating?.clear();
    this.seating = undefined;
    // Idempotente por dentro: una reconexión vuelve a completar la mesa.
    this.startMatch();
  }

  private clientOf(playerId: PlayerId, except?: Client): Client | undefined {
    return this.clients.find(
      (client) => client !== except && client.userData?.playerId === playerId,
    );
  }

  private crash(error: Error, methodName: string): void {
    this.log.error("bug: el estado dejó de ser confiable, cerrando la partida", {
      methodName,
      error: error.message,
      stack: error.stack,
    });
    void this.disconnect();
  }
}
```

Antes de seguir, `domino-room.test.ts` debe arrancar `boot(app)` y cubrir con sockets reales:

1. Un JWT HS256 válido llega al `TokenVerifier` de instancia pese al parche de `@colyseus/auth`.
2. Una sesión fresca ocupa un asiento caído aunque siga viva su reserva de reconexión.
3. El token viejo no desplaza después a la sesión fresca.
4. Un jugador que abandonó tampoco vuelve por el camino especial de reconexión.
5. Disponer después de `MATCH_RESOLVED` no agrega `MATCH_ABORTED`; sin veredicto sí lo agrega.
6. El config público responde `Cache-Control: no-store`.

Run: `npx vitest run src/features/match/transports/colyseus/domino-room.test.ts`
Expected: los 6 tests PASAN.

- [ ] **Step 3: Escribir el endpoint HTTP, el barrel de la feature y el arranque**

```ts
// src/features/match/transports/http/register-http.ts
import type { Express } from "express";
import { rootContainer } from "../../../../di-container.js";
import type { Clock } from "../../core/engine/clock.js";
import { MatchRegistry } from "../match-registry.js";
import type { MatchConfigResponse } from "../match-registry.js";

// El config es inmutable y el seed no debe salir NUNCA, así que el front lo consume
// una sola vez por HTTP en vez de por estado sincronizado.
//
// Y de paso viaja `serverNow`, que es lo que le permite al front corregir el desfase de
// su propio reloj antes de dibujar la primera cuenta atrás (ver `MatchConfigResponse`).
// Va acá y no en un endpoint aparte porque el front YA pega este request antes de
// unirse: un campo más no cuesta un round-trip, y un endpoint `/time` sí.
export function registerMatchHttp(app: Express): void {
  app.get("/config/:roomId", (request, response) => {
    const config = rootContainer.resolve(MatchRegistry).publicConfigOf(request.params.roomId);
    if (!config) {
      response.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    // Por el puerto `Clock` y no con `Date.now()` directo: así el test puede congelarlo
    // y afirmar el valor exacto en vez de un rango.
    const clock = rootContainer.resolve<Clock>("Clock");
    const body: MatchConfigResponse = { ...config, serverNow: clock.now() };
    response.set("Cache-Control", "no-store").json(body);
  });
}
```

```ts
// src/features/match/index.ts
// La superficie pública de la feature. Otra feature solo importa de acá.
export { DominoRoom } from "./transports/colyseus/domino-room.js";
export { registerMatchHttp } from "./transports/http/register-http.js";
export { configOf } from "./transports/match-contract.js";
export type { DominoRoomOptions, SeatCredentials } from "./transports/match-contract.js";
export { MatchRegistry } from "./transports/match-registry.js";
export type { MatchConfigResponse, PublicMatchConfig } from "./transports/match-registry.js";
```

```ts
// src/app.config.ts
import { defineRoom, defineServer } from "colyseus";
import { DominoRoom, registerMatchHttp } from "./features/match/index.js";

// El export CON NOMBRE es lo que un cliente TypeScript importa para tener tipos
// end-to-end: `new Client<typeof server>(url)`.
export const server = defineServer({
  rooms: {
    domino: defineRoom(DominoRoom),
  },
  express: (app) => {
    registerMatchHttp(app);
  },
});

export default server;
```

```ts
// src/index.ts
import { listen } from "@colyseus/tools";
import app from "./app.config.js";
import { env } from "./env.js";
import { logger } from "./logger.js";

// En Node una promesa rechazada sin manejar TERMINA el proceso, y este proceso
// tiene TODAS las partidas adentro.
process.on("unhandledRejection", (reason) => {
  logger.error("unhandledRejection", { reason: String(reason) });
});

await listen(app, env.port);
```

- [ ] **Step 4: Verificar que el servidor arranca**

Run: `JWT_SECRET=$(printf 's%.0s' {1..32}) npm run dev`
Expected: arranca y loguea que escucha en el puerto 2567, sin excepciones. Cortar con Ctrl-C.

En PowerShell: `$env:JWT_SECRET = "s" * 32; npm run dev`

- [ ] **Step 5: Verificar que las reglas de arquitectura siguen valiendo**

Run: `npm run typecheck && npm test`
Expected: TODO pasa. `src/architecture.test.ts` ahora tiene que ver `tsyringe` en exactamente tres
archivos: `di-container.ts`, `domino-room.ts` y `di-wiring.ts`. Si aparece en un cuarto, falla — y es
correcto que falle.

- [ ] **Step 6: Commit**

```bash
npm run format && npm run typecheck && npm test && npm run lint
git add src
git commit -m "feat(room): DominoRoom como transporte y composition root per-partida

La puerta de seguridad es el orden de comprobaciones de onJoin (asiento reservado,
sigue jugando) y no maxClients, que queda como tope de llenado. Eso es lo que
permite el unlock() de onDrop.

El unlock() no es opcional: mientras allowReconnection está pendiente, Colyseus
cuenta el asiento en hasReachedMaxClients(), la sala queda llena y el matchmaker
rechaza el joinById de quien perdió su token. Cancelar la reserva desde onJoin
llega tarde, porque el rechazo ocurre antes de que ese hook corra.

El camino del comando es síncrono de punta a punta y nunca hace throw: en 0.18 los
handlers de onMessage no están envueltos. Las jugadas ilegales van al log como
rastro antifraude, no al historial.

onUncaughtException lleva lista blanca explícita: sin ella, un rechazo legítimo de
la puerta cierra la partida de los que sí habían entrado.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 13: Arnés E2E y el test que cierra la rebanada

Los tests de esta tarea corren contra `boot(appConfig)`, o sea **el mismo wiring de producción**. Es
lo único que prueba que las piezas de las 12 tareas anteriores encajan.

**Files:**
- Modify: `src/features/match/core/config.ts` (las duraciones salen de env), `src/env.ts`, `vitest.setup.ts`
- Create: `src/features/match/tests/e2e-harness.ts`, `src/features/match/tests/lifecycle-e2e.test.ts`

- [ ] **Step 1: Hacer configurables las duraciones, para que los tests no esperen 6 s reales**

En `src/env.ts`, añadir al schema de zod y a la interfaz:

```ts
// dentro de `const schema = z.object({ … })`
  TURN_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  EXTRA_TIME_RESERVE_MS: z.coerce.number().int().positive().default(30_000),
  PRESENTING_ROUND_MS: z.coerce.number().int().positive().default(6_000),
  PRESENTING_MATCH_MS: z.coerce.number().int().positive().default(6_000),
  SEATING_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
```

```ts
// añadir a la interfaz Env
  readonly turnTimeoutMs: number;
  readonly extraTimeReserveMs: number;
  readonly presentingRoundMs: number;
  readonly presentingMatchMs: number;
  readonly seatingTimeoutMs: number;
```

```ts
// añadir al objeto que devuelve parseEnv
    turnTimeoutMs: parsed.TURN_TIMEOUT_MS,
    extraTimeReserveMs: parsed.EXTRA_TIME_RESERVE_MS,
    presentingRoundMs: parsed.PRESENTING_ROUND_MS,
    presentingMatchMs: parsed.PRESENTING_MATCH_MS,
    seatingTimeoutMs: parsed.SEATING_TIMEOUT_MS,
```

En `src/features/match/core/config.ts`, reemplazar la constante por una función pura. El core no
puede leer `env` (Regla 1), así que **recibe los valores por parámetro** y quien los pasa es el root:

```ts
// NO se reemplaza DEFAULT_GLOBAL_CONFIG: se le suma la función. La constante de la
// Tarea 5 ya tiene los valores de las reglas (60 s de turno, 30 s de reserva) y es
// el default que un test sin env usa; `globalConfigWith` es el hueco por donde el
// root le mete lo que vino de env.
//
// Ojo con la tentación de re-declarar la constante acá con otros números: perdería
// `extraTimeReserveMs` (dejaría de satisfacer la interfaz) y bajaría el plazo de turno
// sin que ninguna regla lo pida.
export function globalConfigWith(overrides: Partial<GlobalDominoConfig>): GlobalDominoConfig {
  return { ...DEFAULT_GLOBAL_CONFIG, ...overrides };
}
```

En `src/di-container.ts`, cambiar el registro:

```ts
rootContainer.register("GlobalDominoConfig", {
  useValue: globalConfigWith({
    turnTimeoutMs: env.turnTimeoutMs,
    extraTimeReserveMs: env.extraTimeReserveMs,
    presentingRoundMs: env.presentingRoundMs,
    presentingMatchMs: env.presentingMatchMs,
    seatingTimeoutMs: env.seatingTimeoutMs,
  }),
});
```

En `vitest.setup.ts`, añadir:

```ts
// Plazos cortos: los tests no esperan 6 s reales, y el determinismo lo dan los
// seams del engine, no el reloj de pared.
process.env.PRESENTING_MATCH_MS ??= "120";
process.env.PRESENTING_ROUND_MS ??= "120";
process.env.TURN_TIMEOUT_MS ??= "600";
// La reserva también se acorta: si no, un test de timeout tendría que agotar 30 s
// reales antes de que el sistema actúe.
process.env.EXTRA_TIME_RESERVE_MS ??= "300";
process.env.SEATING_TIMEOUT_MS ??= "3000";
```

Run: `npm test`
Expected: los tests de `env.test.ts` siguen pasando (los defaults nuevos no rompen las aserciones
existentes) y todo lo demás también.

- [ ] **Step 2: Confirmar la superficie de `@colyseus/testing` 0.18**

```bash
cat node_modules/@colyseus/testing/build/index.d.ts
```

Anotar tres cosas antes de escribir el arnés:
1. La firma de `boot(config, port?)` y qué devuelve.
2. Cómo se crea una sala server-side desde el test (`server.createRoom(name, options)` o vía
   `matchMaker`).
3. Cómo se conecta un cliente con token (`server.sdk` + `auth.token`, o un parámetro de
   `connectTo`).

El arnés de abajo asume `server.createRoom` + `server.connectTo`. Si la API difiere, **ajustar el
arnés y no los tests**: los tests expresan el comportamiento y no deben conocer el transporte.

- [ ] **Step 3: Escribir el arnés**

```ts
// src/features/match/tests/e2e-harness.ts
import { boot, type ColyseusTestServer } from "@colyseus/testing";
import jwt from "jsonwebtoken";
import appConfig from "../../../app.config.js";
import { rootContainer } from "../../../di-container.js";
import { env } from "../../../env.js";
import type { MatchState } from "../core/state/index.js";
import type { HistoryEntry } from "../network/history.js";
import { MemoryHistory } from "../network/transports/memory-history.js";
import type { DominoRoomOptions } from "../transports/match-contract.js";

// El dominó NO firma tokens, así que emitirlos es trabajo del arnés.
export function mintToken(userId: string): string {
  return jwt.sign({ sub: userId }, env.jwtSecret, { algorithm: "HS256", expiresIn: "1h" });
}

export function casualTable(seats: string[], seed = "seed-e2e"): DominoRoomOptions {
  return {
    mode: "CASUAL",
    matchId: `m-${seats.join("-")}`,
    gameModeId: "clasica-2p",
    seats,
    seed,
    pointsToWin: 100,
    teamAssignment: "SHUFFLED",
  };
}

// Cada suite arranca en su PROPIO puerto: las suites corren en paralelo.
export async function bootServer(port: number): Promise<ColyseusTestServer> {
  return boot(appConfig, port);
}

export async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: se agotó el plazo");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// FIRMA DEL ESTADO. Permite esperar a que el servidor PROCESÓ el mensaje en vez de
// dormir un tiempo arbitrario.
//
// TRAMPA: si un verbo no cambia ninguna de estas claves, act() cuelga. Cuando se
// sume un verbo que sea un overlay del turno (una negociación de apuesta, por
// ejemplo), hay que sumar su rama acá.
//
// `hasSeenTiles` está en la lista por esa trampa exacta: el PRIMER `REVEAL_TILES` de la
// ventana de reparto no mueve ninguna otra clave —no pone ficha, no toca el pozo, no
// cambia el turno ni la fase, porque todavía falta el otro—. Sin este campo, `act` se
// cuelga esperando un cambio que ocurrió pero no estaba mirando.
export function signatureOf(state: MatchState): string {
  return JSON.stringify([
    state.phase,
    state.activeDeadline,
    state.currentRound?.phase ?? null,
    state.currentRound?.roundNumber ?? null,
    state.currentRound?.currentTurn?.playerId ?? null,
    state.currentRound?.board.tiles.length ?? null,
    state.currentRound?.boneyard?.count ?? null,
    state.scoreboard.teamA,
    state.scoreboard.teamB,
    state.players.map((player) => [
      player.hand.tileCount,
      player.hasAbandoned,
      player.hasSeenTiles,
      player.connected,
    ]),
  ]);
}

export interface SeatedMatch {
  readonly roomId: string;
  readonly serverState: MatchState;
  readonly clients: Record<string, Awaited<ReturnType<ColyseusTestServer["connectTo"]>>>;
}

// La sala nace LLENA: se crea con todos sus asientos y después se conectan.
// Sienta a los dos y, por defecto, LEVANTA LAS FICHAS de los dos: en producción la
// ventana de reparto está encendida en toda mesa (`configOf`), así que un e2e que la
// saltee estaría probando un camino que no existe.
//
// `skipDealWindow: true` es para el único test que necesita la ventana ABIERTA: el suyo.
export async function seatPair(
  server: ColyseusTestServer,
  seats: [string, string],
  seed?: string,
  options: { skipDealWindow?: boolean } = {},
): Promise<SeatedMatch> {
  const room = await server.createRoom("domino", casualTable([...seats], seed));
  const clients: SeatedMatch["clients"] = {};
  for (const userId of seats) {
    server.sdk.auth.token = mintToken(userId);
    clients[userId] = await server.connectTo(room);
  }
  const match = { roomId: room.roomId, serverState: room.state as MatchState, clients };
  if (!options.skipDealWindow) await revealAll(match);
  return match;
}

// Los dos levantan sus fichas y la ronda arranca. Un `act` por jugador, así cada uno
// espera a que el servidor lo procesó: el último cierra la ventana y la fase pasa a
// `PLAYING`, que es el cambio de firma que `act` está esperando.
export async function revealAll(match: SeatedMatch): Promise<void> {
  for (const userId of Object.keys(match.clients)) {
    await act(match, userId, "REVEAL_TILES");
  }
  await waitUntil(() => match.serverState.currentRound?.phase === "PLAYING");
}

// Manda y espera a que la firma del estado cambie.
export async function act(
  match: SeatedMatch,
  userId: string,
  type: string,
  payload: unknown = {},
): Promise<void> {
  const before = signatureOf(match.serverState);
  match.clients[userId]?.send(type, payload);
  await waitUntil(() => signatureOf(match.serverState) !== before);
}

export function historyOf(matchId: string): readonly HistoryEntry[] {
  return (rootContainer.resolve("HistoryPort") as MemoryHistory).of(matchId);
}

/** "SOURCE TYPE" por entrada, que es la forma en que se lee un reclamo. */
export function linesOf(matchId: string): string[] {
  return historyOf(matchId).map((entry) => `${entry.source} ${entry.type}`);
}
```

- [ ] **Step 4: Escribir el test E2E**

```ts
// src/features/match/tests/lifecycle-e2e.test.ts
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { act, bootServer, casualTable, historyOf, linesOf, mintToken, seatPair, waitUntil } from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2585);
});

afterAll(async () => {
  await server.shutdown();
});

describe("ciclo de vida de una partida", () => {
  it("la partida arranca sola al ocuparse el último asiento", async () => {
    const match = await seatPair(server, ["u1", "u2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    expect(match.serverState.startedAt).toBeGreaterThan(0);
    expect(match.serverState.players.map((p) => p.playerId)).toEqual(["u1", "u2"]);
    expect(match.serverState.players.map((p) => p.teamId)).toEqual(["A", "B"]);
  });

  it("abandonar cierra la partida por forfeit, y el historial queda intercalado", async () => {
    const match = await seatPair(server, ["a1", "a2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    await act(match, "a1", "ABANDON");
    expect(match.serverState.phase).toBe("PRESENTING_MATCH");

    await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);

    // El ACTO del jugador entró como comando; los HECHOS que provocó, como eventos
    // del sistema. Un registro de solo eventos no tendría la primera línea.
    //
    // Y el ORDEN importa: el veredicto va ANTES del vencimiento, porque sale al ENTRAR
    // a la presentación. Si algún día estas dos líneas aparecen al revés, el pago se
    // atrasó una pausa entera (ver `MatchDriver.enterPresentingMatch`).
    expect(linesOf("m-a1-a2")).toEqual([
      "PLAYER ABANDON",
      "SYSTEM MATCH_RESOLVED",
      "SYSTEM DEADLINE_EXPIRED",
    ]);

    const resolved = historyOf("m-a1-a2").find((entry) => entry.type === "MATCH_RESOLVED");
    expect(resolved?.payload).toEqual({ winnerTeamId: "B", reason: "ABANDONMENT" });
  });

  it("el seq no tiene huecos y es estrictamente creciente", async () => {
    const match = await seatPair(server, ["s1", "s2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");
    await act(match, "s1", "ABANDON");
    await waitUntil(() => match.serverState.phase === "FINISHED", 3_000);

    const seqs = historyOf("m-s1-s2").map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  // Un mensaje rechazado es rastro antifraude, no historia de la partida.
  it("un verbo desconocido se rechaza y NO entra al historial", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    const illegal: unknown[] = [];
    match.clients.r1?.onMessage("illegal", (payload) => illegal.push(payload));
    match.clients.r1?.send("DROP_TABLE", {});

    await waitUntil(() => illegal.length > 0);
    expect(illegal[0]).toEqual({ code: "UNKNOWN_COMMAND" });
    expect(historyOf("m-r1-r2")).toHaveLength(0);
    // Y la partida sigue viva: un mensaje basura no mata la mesa.
    expect(match.serverState.phase).toBe("PLAYING");
  });

  // El caso del prototipo. Con `in` en vez de Object.hasOwn esto cerraba la partida.
  it("un mensaje llamado toString no mata la mesa", async () => {
    const match = await seatPair(server, ["p1", "p2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    const illegal: unknown[] = [];
    match.clients.p1?.onMessage("illegal", (payload) => illegal.push(payload));
    match.clients.p1?.send("toString", {});

    await waitUntil(() => illegal.length > 0);
    expect(illegal[0]).toEqual({ code: "UNKNOWN_COMMAND" });
    expect(match.serverState.phase).toBe("PLAYING");
  });

  it("una segunda conexión del mismo asiento desplaza a la primera", async () => {
    const match = await seatPair(server, ["d1", "d2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    server.sdk.auth.token = mintToken("d1");
    const second = await server.sdk.joinById(match.roomId);
    await waitUntil(() => second.hasJoined === true);

    // Sigue habiendo exactamente dos conexiones: la nueva reemplazó, no sumó.
    await waitUntil(() => server.getRoomById(match.roomId).clients.length === 2);
    // Y el desplazamiento NO se contó como caída.
    expect(linesOf("m-d1-d2").filter((line) => line.includes("PLAYER_DISCONNECTED"))).toEqual([]);
  });

  it("quien no tiene asiento no entra", async () => {
    const room = await server.createRoom("domino", casualTable(["x1", "x2"]));
    server.sdk.auth.token = mintToken("intruso");
    await expect(server.connectTo(room)).rejects.toThrow();
    // Y la sala sigue en pie para los que sí tienen asiento.
    expect(server.getRoomById(room.roomId)).toBeDefined();
  });

  it("sin token no entra", async () => {
    const room = await server.createRoom("domino", casualTable(["y1", "y2"]));
    server.sdk.auth.token = undefined;
    await expect(server.connectTo(room)).rejects.toThrow();
  });

  it("el endpoint de config responde el DTO sin seed", async () => {
    const match = await seatPair(server, ["c1", "c2"], "seed-secretisimo");
    const response = await fetch(`http://localhost:2585/config/${match.roomId}`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain("seed-secretisimo");
    expect(JSON.parse(body)).toEqual({
      matchId: "m-c1-c2",
      gameModeId: "clasica-2p",
      seats: ["c1", "c2"],
      pointsToWin: 100,
      serverNow: expect.any(Number),
    });
  });

  // LA MUESTRA DEL RELOJ ES LO QUE HACE DIBUJABLE EL `activeDeadline`. Sin ella el front
  // le resta su propio `Date.now()` a un instante estampado por el servidor, y un
  // dispositivo con el reloj corrido muestra el turno vencido. El test afirma las dos
  // cosas que el front necesita: que el campo viene, y que es de la misma escala que el
  // deadline (epoch ms), porque compararlos es exactamente lo que va a hacer.
  it("el config trae una muestra del reloj del servidor, en la escala del deadline", async () => {
    const match = await seatPair(server, ["t1", "t2"]);
    await waitUntil(() => match.serverState.activeDeadline > 0);

    const body = (await (
      await fetch(`http://localhost:2585/config/${match.roomId}`)
    ).json()) as { serverNow: number };

    // Mismo origen de tiempo: el deadline vigente cae DESPUÉS de la muestra, y no a
    // cincuenta años de distancia. Si alguien pasa el deadline a la timeline de la sala
    // (ms desde el arranque), esta aserción es la que lo caza.
    expect(body.serverNow).toBeGreaterThan(1_700_000_000_000);
    expect(match.serverState.activeDeadline).toBeGreaterThan(body.serverNow);
  });
});
```

- [ ] **Step 5: Correr el test hasta que pase**

Run: `npx vitest run src/features/match/tests/lifecycle-e2e.test.ts`
Expected: los 10 tests PASAN.

Tres fallos probables y qué significan:

| Síntoma | Causa | Arreglo |
|---|---|---|
| `waitUntil: se agotó el plazo` esperando `PLAYING` | `startIfSeated` no dispara: `seated` no se llenó | Comprobar que `onJoin` corre para los dos clientes y que `maxClients` no los rechaza |
| El test del asiento ajeno cierra la sala | `onUncaughtException` trata `SeatNotReservedError` como bug | Verificar la lista blanca de `onUncaughtException` |
| El historial sale vacío | `HistoryPort` se resolvió de un child y no del root | El grabador se arma en `buildPieces` resolviendo `"HistoryPort"`, que está registrado en el root |

- [ ] **Step 6: Commit — cierra la rebanada 1**

```bash
npm run typecheck && npm run lint && npm test
git add src
git commit -m "test(e2e): arnés y ciclo de vida contra el wiring de producción

Cierra la rebanada del esqueleto. Los tests corren contra boot(appConfig), o sea
el mismo wiring que producción, y es lo único que prueba que las doce tareas
anteriores encajan.

signatureOf permite esperar a que el servidor procesó el mensaje en vez de dormir
un tiempo arbitrario. Las duraciones de fase salen de env para que los tests no
esperen 6 s reales.

Cubre: arranque al ocuparse el último asiento, forfeit con su historial
intercalado, seq sin huecos, verbo desconocido rechazado y fuera del historial,
el mensaje llamado toString que con \`in\` mataba la mesa, desplazamiento de
conexión sin contarlo como caída, la puerta de asiento, y el DTO sin seed.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

# Rebanada 2 — Repartir y jugar 2P

> **Precondición:** la Tarea 0 está hecha y `docs/reglas-de-juego-v1.md` existe. Cada test de esta
> rebanada afirma una regla de ese documento; si el documento dice otra cosa que este plan, **manda el
> documento** y hay que corregir el test citando su sección.

## Tarea 14: `tile-set` — las 28 fichas y el valor nominal

**Files:**
- Create: `src/features/match/core/engine/tile-set.ts`
- Test: `src/features/match/core/engine/tile-set.test.ts`

- [ ] **Step 1: Escribir el test que falla**

```ts
// src/features/match/core/engine/tile-set.test.ts
import { describe, expect, it } from "vitest";
import {
  DOMINO_MAX_PIP,
  DOMINO_SET_SIZE,
  handValue,
  isDouble,
  orderedTileSet,
  sameTile,
  tileValue,
} from "./tile-set.js";

describe("tile-set", () => {
  it("son 28 fichas", () => {
    expect(orderedTileSet()).toHaveLength(DOMINO_SET_SIZE);
    expect(DOMINO_SET_SIZE).toBe(28);
  });

  it("no hay dos fichas iguales, tratando [a,b] y [b,a] como la misma", () => {
    const keys = orderedTileSet().map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`);
    expect(new Set(keys).size).toBe(DOMINO_SET_SIZE);
  });

  it("están las siete dobles", () => {
    const doubles = orderedTileSet().filter(([a, b]) => a === b);
    expect(doubles.map(([a]) => a)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("ningún número sale del rango 0..6", () => {
    for (const [a, b] of orderedTileSet()) {
      expect(a).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(DOMINO_MAX_PIP);
    }
  });

  it("el set completo suma 168 puntos", () => {
    // 28 fichas, cada número aparece 8 veces: 8 * (0+1+2+3+4+5+6) = 168.
    const total = orderedTileSet().reduce((sum, [a, b]) => sum + a + b, 0);
    expect(total).toBe(168);
  });

  it("tileValue suma los dos números", () => {
    expect(tileValue({ left: 6, right: 4 })).toBe(10);
    expect(tileValue({ left: 0, right: 0 })).toBe(0);
  });

  it("isDouble reconoce las dobles", () => {
    expect(isDouble({ left: 3, right: 3 })).toBe(true);
    expect(isDouble({ left: 3, right: 4 })).toBe(false);
  });

  it("sameTile ignora el orden de los números", () => {
    expect(sameTile({ left: 6, right: 4 }, { left: 4, right: 6 })).toBe(true);
    expect(sameTile({ left: 6, right: 4 }, { left: 6, right: 5 })).toBe(false);
  });

  it("handValue suma toda la mano, y una mano vacía vale 0", () => {
    expect(handValue([{ left: 6, right: 4 }, { left: 3, right: 3 }])).toBe(16);
    expect(handValue([])).toBe(0);
  });
});
```

- [ ] **Step 2: Correr el test para verificar que falla**

Run: `npx vitest run src/features/match/core/engine/tile-set.test.ts`
Expected: FAIL con `Failed to resolve import "./tile-set.js"`.

- [ ] **Step 3: Escribir `tile-set.ts`**

```ts
// src/features/match/core/engine/tile-set.ts
// Vocabulario del dominó anterior a cualquier fase: qué fichas existen y cuánto vale
// una. Derivación PURA, sin estado. Lo consumen el Dealer y el Scorer.

export const DOMINO_MAX_PIP = 6;
export const DOMINO_SET_SIZE = 28;

export interface TileLike {
  readonly left: number;
  readonly right: number;
}

// El set doble-seis: todas las combinaciones no ordenadas de 0..6. Se GENERA en vez
// de listarse, así que no puede tener un typo ni faltarle una.
export function orderedTileSet(): ReadonlyArray<readonly [number, number]> {
  const tiles: [number, number][] = [];
  for (let left = 0; left <= DOMINO_MAX_PIP; left += 1) {
    for (let right = left; right <= DOMINO_MAX_PIP; right += 1) {
      tiles.push([left, right]);
    }
  }
  return tiles;
}

export function tileValue(tile: TileLike): number {
  return tile.left + tile.right;
}

export function isDouble(tile: TileLike): boolean {
  return tile.left === tile.right;
}

// Una ficha es la MISMA sin importar de qué lado se mire.
export function sameTile(a: TileLike, b: TileLike): boolean {
  return (a.left === b.left && a.right === b.right) || (a.left === b.right && a.right === b.left);
}

export function handValue(tiles: readonly TileLike[]): number {
  return tiles.reduce((sum, tile) => sum + tileValue(tile), 0);
}
```

- [ ] **Step 4: Correr el test hasta que pase**

Run: `npx vitest run src/features/match/core/engine/tile-set.test.ts`
Expected: los 9 tests PASAN.

- [ ] **Step 5: Commit**

```bash
git add src/features/match/core/engine/tile-set.ts src/features/match/core/engine/tile-set.test.ts
git commit -m "feat(engine): tile-set con las 28 fichas generadas y el valor nominal

El set se genera en vez de listarse: no puede tener un typo ni faltarle una ficha.
El v1 lo tiene como array literal de 28 pares.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 15: RNG sembrado y el `Dealer` determinista

Es lo que hace posible el replay: mismo `seed` → mismo reparto, y cada ronda reproducible **de forma
aislada** porque la aleatoriedad se deriva de `(seed, roundNumber)` sin estado mutable.

**Files:**
- Create: `src/features/match/core/engine/dealer.ts`
- Test: `src/features/match/core/engine/tests/dealer.test.ts`

> **`src/shared/rng.ts` YA EXISTE**: lo creó la Tarea 6, que es su primer consumidor
> (`team-assignment.ts` deriva el sorteo de equipos del `seed`). Los Steps 1 y 2 de abajo quedan como
> la referencia de su contenido —de ahí los copió la Tarea 6— pero **acá no hay nada que escribir**:
> verificar que `npx vitest run src/shared/rng.test.ts` sigue en verde y saltar al Step 3.

- [ ] **Step 1: Escribir el test del RNG**

```ts
// src/shared/rng.test.ts
import { describe, expect, it } from "vitest";
import { hashSeed, mulberry32, shuffled } from "./rng.js";

describe("rng sembrado", () => {
  it("la misma semilla y ronda dan el mismo hash", () => {
    expect(hashSeed("abc", 1)).toBe(hashSeed("abc", 1));
  });

  it("distinta ronda da distinto hash", () => {
    expect(hashSeed("abc", 1)).not.toBe(hashSeed("abc", 2));
  });

  it("distinta semilla da distinto hash", () => {
    expect(hashSeed("abc", 1)).not.toBe(hashSeed("abd", 1));
  });

  it("mulberry32 es determinista y queda en [0,1)", () => {
    const first = Array.from({ length: 5 }, mulberry32(42));
    const second = Array.from({ length: 5 }, mulberry32(42));
    expect(first).toEqual(second);
    for (const value of first) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("shuffled es una permutación y no muta la entrada", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const output = shuffled(input, mulberry32(7));
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect([...output].sort((a, b) => a - b)).toEqual(input);
  });

  it("shuffled con la misma semilla da el mismo orden", () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(shuffled(input, mulberry32(7))).toEqual(shuffled(input, mulberry32(7)));
  });

  it("shuffled con semillas distintas da órdenes distintos", () => {
    const input = Array.from({ length: 28 }, (_, index) => index);
    expect(shuffled(input, mulberry32(1))).not.toEqual(shuffled(input, mulberry32(2)));
  });
});
```

- [ ] **Step 2: Correr el test y escribir `rng.ts`**

Run: `npx vitest run src/shared/rng.test.ts` → FAIL (no existe `./rng.js`).

```ts
// src/shared/rng.ts
// Portable entre proyectos: no sabe de dominó. Vive en shared/ por eso.

// FNV-1a de 32 bits sobre `${seed}:${round}`. Determinista y sin dependencias.
export function hashSeed(seed: string, round: number): number {
  const input = `${seed}:${round}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// PRNG sin estado compartido: cada llamada a mulberry32 devuelve una secuencia
// nueva desde su semilla. Es lo que hace cada ronda reproducible AISLADA.
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Fisher-Yates sobre una copia.
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = result[index] as T;
    result[index] = result[swap] as T;
    result[swap] = held;
  }
  return result;
}
```

Run: `npx vitest run src/shared/rng.test.ts`
Expected: los 7 tests PASAN.

- [ ] **Step 3: Escribir el test del Dealer**

```ts
// src/features/match/core/engine/tests/dealer.test.ts
import { describe, expect, it } from "vitest";
import { DEFAULT_GLOBAL_CONFIG, type DominoMatchConfig } from "../../config.js";
import { BoardState, BoneyardState, RoundState, Tile } from "../../state/index.js";
import { Dealer } from "../dealer.js";
import { createMatchState } from "../genesis.js";
import { handOf } from "../state-projections.js";
import { DOMINO_SET_SIZE, handValue, sameTile } from "../tile-set.js";

function build(seed = "seed-1") {
  const config: DominoMatchConfig = {
    matchId: "m1",
    gameModeId: "g",
    seed,
    seats: ["u1", "u2"],
    pointsToWin: 100,
    teamAssignment: "SHUFFLED",
    isDealWindowEnabled: false,
  };
  const match = createMatchState(config);
  const round = new RoundState();
  round.roundNumber = 1;
  round.board = new BoardState();
  round.boneyard = new BoneyardState();
  match.currentRound = round;

  return { match, dealer: new Dealer(match, config, DEFAULT_GLOBAL_CONFIG) };
}

const tilesOf = (match: ReturnType<typeof build>["match"], playerId: string) =>
  [...handOf(playerId, match).tiles];

describe("Dealer", () => {
  it("da 7 fichas a cada jugador y el resto al pozo", () => {
    const { match, dealer } = build();
    dealer.deal(1);

    expect(tilesOf(match, "u1")).toHaveLength(7);
    expect(tilesOf(match, "u2")).toHaveLength(7);
    expect(match.currentRound?.boneyard?.tiles.length).toBe(DOMINO_SET_SIZE - 14);
    expect(match.currentRound?.boneyard?.count).toBe(DOMINO_SET_SIZE - 14);
  });

  it("mantiene tileCount al día, que es el campo que ve el rival", () => {
    const { match, dealer } = build();
    dealer.deal(1);
    for (const player of match.players) expect(player.hand.tileCount).toBe(7);
  });

  it("reparte las 28 fichas sin repetir ninguna", () => {
    const { match, dealer } = build();
    dealer.deal(1);
    const all = [
      ...tilesOf(match, "u1"),
      ...tilesOf(match, "u2"),
      ...(match.currentRound?.boneyard?.tiles ?? []),
    ];
    expect(all).toHaveLength(DOMINO_SET_SIZE);
    for (const tile of all) {
      expect(all.filter((other) => sameTile(tile, other))).toHaveLength(1);
    }
    expect(handValue(all)).toBe(168);
  });

  // DETERMINISMO: es lo que hace posible el replay.
  it("la misma semilla y ronda dan el mismo reparto", () => {
    const a = build("igual");
    const b = build("igual");
    a.dealer.deal(1);
    b.dealer.deal(1);
    expect(tilesOf(a.match, "u1").map((t) => t.toJSON())).toEqual(
      tilesOf(b.match, "u1").map((t) => t.toJSON()),
    );
  });

  it("distinta ronda da distinto reparto con la misma semilla", () => {
    const a = build("igual");
    const b = build("igual");
    a.dealer.deal(1);
    b.dealer.deal(2);
    expect(tilesOf(a.match, "u1").map((t) => t.toJSON())).not.toEqual(
      tilesOf(b.match, "u1").map((t) => t.toJSON()),
    );
  });

  it("distinta semilla da distinto reparto", () => {
    const a = build("uno");
    const b = build("dos");
    a.dealer.deal(1);
    b.dealer.deal(1);
    expect(tilesOf(a.match, "u1").map((t) => t.toJSON())).not.toEqual(
      tilesOf(b.match, "u1").map((t) => t.toJSON()),
    );
  });

  // REPARTIR NO REVELA (reglas §3.1). Antes esto eran dos tests con un spy sobre el
  // puerto de visibilidad —uno afirmando que la mano se revelaba a su dueño, otro que el
  // pozo no se revelaba a nadie—. Ahora el `Dealer` no tiene el puerto, así que las dos
  // cosas son ciertas por construcción y lo único que queda por afirmar es que las
  // fichas quedaron REPARTIDAS y todavía NO vistas.
  //
  // Dónde vive ahora cada mitad: que la mano llegue a su dueño lo prueba
  // `round/tests/player.test.ts` (`revealTiles`), y que nunca llegue a un rival lo
  // prueba el smoke de visibilidad de punta a punta.
  it("reparte sin revelar: nadie levantó nada todavía", () => {
    const { match, dealer } = build();
    dealer.deal(1);

    for (const player of match.players) {
      expect(player.hand.tiles.length).toBe(7);
      expect(player.hasSeenTiles).toBe(false);
    }
  });

  it("repartir dos veces reemplaza la mano, no la acumula", () => {
    const { match, dealer } = build();
    dealer.deal(1);
    dealer.deal(2);
    expect(tilesOf(match, "u1")).toHaveLength(7);
  });

  it("el seam de test permite forzar el orden del mazo", () => {
    // El uso real del seam está en tests posteriores con FixedDealer; acá solo se
    // afirma que orderedTiles es sobreescribible desde una subclase.
    class Fixed extends Dealer {
      protected override orderedTiles(): Tile[] {
        const tile = new Tile();
        tile.left = 6;
        tile.right = 6;
        return [tile];
      }
    }
    expect(Fixed.prototype).toBeInstanceOf(Dealer);
  });
});
```

- [ ] **Step 4: Correr el test y escribir el `Dealer`**

Run: `npx vitest run src/features/match/core/engine/tests/dealer.test.ts` → FAIL (no existe `../dealer.js`).

```ts
// src/features/match/core/engine/dealer.ts
// SERVICIO: reparte, y NADA MÁS. No es Player (nadie lo "hace" como verbo) ni Referee
// (no juzga nada), así que va suelto al lado del Scorer. Revelar dejó de ser suyo con
// la ventana de reparto (reglas §3.1): ahora es del `RoundPlayer`, que es el actor.
//
// Es la ÚNICA fuente de no-determinismo del negocio, y está encapsulada: deriva de
// (seed, roundNumber) sin estado mutable, así que el replay no depende del orden de
// consumo de ningún RNG y cada ronda es reproducible aislada.
import { hashSeed, mulberry32, shuffled } from "../../../../shared/rng.js";
import type { DominoMatchConfig, GlobalDominoConfig } from "../config.js";
import { Tile } from "../state/index.js";
import type { MatchState } from "../state/index.js";
import { boneyardOf, currentRoundOf, playerOf } from "./state-projections.js";
import { orderedTileSet } from "./tile-set.js";

// NO recibe el puerto de visibilidad, y eso es una garantía y no un olvido: desde la
// ventana de reparto (reglas §3.1) repartir no revela nada, así que "repartir no puede
// filtrar una ficha" es cierto por la FORMA de esta clase. Antes era un test con un spy.
export class Dealer {
  constructor(
    private readonly match: MatchState,
    private readonly config: DominoMatchConfig,
    private readonly globalConfig: GlobalDominoConfig,
  ) {}

  deal(roundNumber: number): void {
    const round = currentRoundOf(this.match);
    const deck = shuffled(this.orderedTiles(), mulberry32(hashSeed(this.config.seed, roundNumber)));

    let cursor = 0;
    for (const playerId of this.config.seats) {
      const hand = playerOf(playerId, this.match).hand;
      hand.tiles.clear();
      for (let dealt = 0; dealt < this.globalConfig.tilesPerPlayer; dealt += 1) {
        const tile = deck[cursor];
        cursor += 1;
        if (!tile) break;
        hand.tiles.push(tile);
      }
      hand.tileCount = hand.tiles.length;
      hand.isRevealed = false;
      // REPARTIR YA NO REVELA (reglas §3.1). Antes acá iba un `makePublic` a su dueño;
      // ahora la mano nace sin hacerse pública a nadie y la levanta el propio jugador
      // con `REVEAL_TILES` (`RoundPlayer.revealTiles`).
      //
      // Ojo con la diferencia, que es la que hace que la ventana de reparto sea una
      // línea MENOS y no un mecanismo nuevo: la ficha **no se esconde** —no hay nada que
      // esconder—, simplemente todavía no se hizo pública, que es el estado natural de
      // cualquier nodo gateado.
      //
      // ⚠ Y OJO CON LO QUE LA RONDA ANTERIOR DEJÓ PÚBLICO: quien des-revela es el
      // `RoundDriver` antes de llamar acá (`hideAllHands`), no este servicio. Ver el
      // comentario de `RoundPlayer.hideTiles`.
    }

    // El pozo puede no existir (4P reparte el set entero). Si existe, lo que sobró del
    // mazo ES el pozo; si no existe, `deck.slice(cursor)` está vacío de todos modos, así
    // que la rama ausente y el resto vacío no se contradicen nunca.
    if (round.boneyard) {
      const boneyard = boneyardOf(round);
      boneyard.tiles.clear();
      for (const tile of deck.slice(cursor)) boneyard.tiles.push(tile);
      boneyard.count = boneyard.tiles.length;
    }
    // El pozo NO se revela a nadie, nunca. Está en el árbol porque el dominio lo
    // necesita, y fuera de toda audiencia porque nadie lo debe ver.
  }

  // EL SEAM DE TEST. `protected` a propósito: una subclase lo sobreescribe para
  // forzar manos exactas, que es la única forma de testear la tranca, el conteo y
  // el empate — hay que poder repartir la mano que produce el caso.
  protected orderedTiles(): Tile[] {
    return orderedTileSet().map(([left, right]) => {
      const tile = new Tile();
      tile.left = left;
      tile.right = right;
      return tile;
    });
  }
}
```

Run: `npx vitest run src/features/match/core/engine/tests/dealer.test.ts`
Expected: los 10 tests PASAN.

Si `hand.tiles.clear()` no existe en `ArraySchema` de schema 5, usar `while (hand.tiles.length) hand.tiles.pop()` y corregir también el uso en `boneyard`.

- [ ] **Step 5: Commit**

```bash
npm run typecheck && npm test
git add src/shared src/features/match/core/engine
git commit -m "feat(engine): RNG sembrado y Dealer determinista por (seed, roundNumber)

Cada ronda es reproducible AISLADA porque la aleatoriedad se deriva del par
(seed, roundNumber) sin estado mutable: el replay no depende del orden de consumo
de ningún RNG.

orderedTiles() es protected a propósito: es el seam que permite forzar manos
exactas, sin el cual no se puede testear la tranca ni el conteo.

El pozo queda en el árbol y fuera de toda audiencia, con un test que afirma que
NUNCA se revela.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 16: Extremos del tablero y jugada legal

Dos funciones puras y son el corazón de las reglas físicas.

**Files:**
- Create: `src/features/match/core/engine/round/board-ends.ts`, `.../round/playable.ts`
- Test: `src/features/match/core/engine/round/tests/board-ends.test.ts`, `.../tests/playable.test.ts`

- [ ] **Step 1: Escribir el test de los extremos**

```ts
// src/features/match/core/engine/round/tests/board-ends.test.ts
import { describe, expect, it } from "vitest";
import { BoardState, PlacedTile, Tile } from "../../../state/index.js";
import { boardEndsOf } from "../board-ends.js";

function board(placements: [number, number, "LEFT" | "RIGHT"][]): BoardState {
  const state = new BoardState();
  for (const [left, right, side] of placements) {
    const tile = new Tile();
    tile.left = left;
    tile.right = right;
    const placed = new PlacedTile();
    placed.tile = tile;
    placed.playedBy = "u1";
    placed.side = side;
    state.tiles.push(placed);
  }
  return state;
}

describe("boardEndsOf", () => {
  it("un tablero vacío no tiene extremos", () => {
    expect(boardEndsOf(board([]))).toEqual({ left: undefined, right: undefined });
  });

  it("la primera ficha fija los dos extremos", () => {
    expect(boardEndsOf(board([[6, 4, "RIGHT"]]))).toEqual({ left: 6, right: 4 });
  });

  it("una doble inicial deja los dos extremos iguales", () => {
    expect(boardEndsOf(board([[6, 6, "RIGHT"]]))).toEqual({ left: 6, right: 6 });
  });

  it("colgar a la derecha cambia solo el extremo derecho", () => {
    // 6|4 y después 4|2 a la derecha → extremos 6 y 2
    expect(boardEndsOf(board([[6, 4, "RIGHT"], [4, 2, "RIGHT"]]))).toEqual({ left: 6, right: 2 });
  });

  it("colgar a la izquierda cambia solo el extremo izquierdo", () => {
    // 6|4 y después 3|6 a la izquierda → extremos 3 y 4
    expect(boardEndsOf(board([[6, 4, "RIGHT"], [3, 6, "LEFT"]]))).toEqual({ left: 3, right: 4 });
  });

  it("no importa de qué lado venga escrita la ficha que se cuelga", () => {
    // 6|4 y después 6|3 a la izquierda → el 6 engancha, queda el 3
    expect(boardEndsOf(board([[6, 4, "RIGHT"], [6, 3, "LEFT"]]))).toEqual({ left: 3, right: 4 });
  });

  it("una doble colgada no cambia el extremo", () => {
    expect(boardEndsOf(board([[6, 4, "RIGHT"], [4, 4, "RIGHT"]]))).toEqual({ left: 6, right: 4 });
  });

  it("una cadena larga por los dos lados", () => {
    const ends = boardEndsOf(
      board([
        [6, 6, "RIGHT"],
        [6, 3, "RIGHT"],
        [3, 1, "RIGHT"],
        [2, 6, "LEFT"],
        [0, 2, "LEFT"],
      ]),
    );
    expect(ends).toEqual({ left: 0, right: 1 });
  });
});
```

- [ ] **Step 2: Escribir el test de la jugada legal**

```ts
// src/features/match/core/engine/round/tests/playable.test.ts
import { describe, expect, it } from "vitest";
import { hasPlayableTile, playableSides } from "../playable.js";

const empty = { left: undefined, right: undefined };
const ends = { left: 6, right: 2 };

describe("playableSides", () => {
  it("con el tablero vacío cualquier ficha entra, y de un solo lado", () => {
    expect(playableSides({ left: 5, right: 1 }, empty)).toEqual(["RIGHT"]);
  });

  it("engancha por izquierda si alguno de sus números es el extremo izquierdo", () => {
    expect(playableSides({ left: 6, right: 5 }, ends)).toEqual(["LEFT"]);
    expect(playableSides({ left: 5, right: 6 }, ends)).toEqual(["LEFT"]);
  });

  it("engancha por derecha si alguno de sus números es el extremo derecho", () => {
    expect(playableSides({ left: 2, right: 5 }, ends)).toEqual(["RIGHT"]);
  });

  it("una ficha que sirve de los dos lados devuelve los dos", () => {
    expect(playableSides({ left: 6, right: 2 }, ends)).toEqual(["LEFT", "RIGHT"]);
  });

  it("una ficha que no engancha no devuelve ningún lado", () => {
    expect(playableSides({ left: 5, right: 4 }, ends)).toEqual([]);
  });

  it("con los dos extremos iguales, una ficha que engancha sirve de los dos lados", () => {
    expect(playableSides({ left: 6, right: 5 }, { left: 6, right: 6 })).toEqual(["LEFT", "RIGHT"]);
  });
});

describe("hasPlayableTile", () => {
  it("es verdadero si al menos una ficha engancha", () => {
    expect(hasPlayableTile([{ left: 5, right: 4 }, { left: 6, right: 1 }], ends)).toBe(true);
  });

  it("es falso si ninguna engancha", () => {
    expect(hasPlayableTile([{ left: 5, right: 4 }, { left: 3, right: 1 }], ends)).toBe(false);
  });

  it("con el tablero vacío, cualquier mano no vacía tiene jugada", () => {
    expect(hasPlayableTile([{ left: 5, right: 4 }], empty)).toBe(true);
  });

  it("una mano vacía nunca tiene jugada", () => {
    expect(hasPlayableTile([], ends)).toBe(false);
  });
});

```

- [ ] **Step 3: Correr los dos tests para verificar que fallan**

Run: `npx vitest run src/features/match/core/engine/round/tests/`
Expected: FAIL — no existen `board-ends.js` ni `playable.js`.

- [ ] **Step 4: Escribir las dos funciones**

```ts
// src/features/match/core/engine/round/board-ends.ts
import type { BoardState } from "../../state/index.js";
import { sideOf } from "../state-projections.js";

// Los extremos NO son campos del estado: se DERIVAN de la cadena jugada.
// Almacenarlos invitaría a la desincronización (spec §7.1).
export interface BoardEnds {
  readonly left: number | undefined;
  readonly right: number | undefined;
}

export function boardEndsOf(board: BoardState): BoardEnds {
  const first = board.tiles.at(0);
  if (!first) return { left: undefined, right: undefined };

  let left = first.tile.left;
  let right = first.tile.right;

  for (let index = 1; index < board.tiles.length; index += 1) {
    const placed = board.tiles[index];
    if (!placed) continue;
    const { left: a, right: b } = placed.tile;
    // `sideOf` y no `placed.side`: el campo del schema es `string`, así que comparar
    // contra el literal a pelo deja pasar un typo que rompería la derivación entera.
    if (sideOf(placed) === "LEFT") {
      // El número que engancha es el que coincide con el extremo; queda el otro.
      // Con una doble, `a === b === left`, así que el extremo no cambia — correcto.
      left = a === left ? b : a;
    } else {
      right = a === right ? b : a;
    }
  }

  return { left, right };
}
```

```ts
// src/features/match/core/engine/round/playable.ts
import type { BoardSide, TileLike } from "../../state/tile.js";
import type { BoardEnds } from "./board-ends.js";

// Nota: `TileLike` se importa desde tile-set; se re-exporta desde state/tile.ts en
// el Step 5 para que este archivo no dependa de dos lugares.

export function playableSides(tile: TileLike, ends: BoardEnds): BoardSide[] {
  // Tablero vacío: la primera ficha entra, y la cadena todavía no tiene lados,
  // así que se normaliza a uno solo. Sin esto, la primera jugada tendría dos
  // representaciones del mismo tablero.
  if (ends.left === undefined || ends.right === undefined) return ["RIGHT"];

  const sides: BoardSide[] = [];
  if (tile.left === ends.left || tile.right === ends.left) sides.push("LEFT");
  if (tile.left === ends.right || tile.right === ends.right) sides.push("RIGHT");
  return sides;
}

export function hasPlayableTile(tiles: readonly TileLike[], ends: BoardEnds): boolean {
  return tiles.some((tile) => playableSides(tile, ends).length > 0);
}

// No hay `lockedNumberFor`: el número de engarce no se guarda (ver el comentario de
// `PlacedTile`), así que nadie del lado del servidor lo necesita. El front lo deriva
// recorriendo `board.tiles` con `side`, exactamente como `boardEndsOf`.
```

- [ ] **Step 5: Re-exportar `TileLike` desde `state/tile.ts`**

Añadir al final de `src/features/match/core/state/tile.ts`:

```ts
export type { TileLike } from "../engine/tile-set.js";
```

- [ ] **Step 6: Correr los tests hasta que pasen**

Run: `npx vitest run src/features/match/core/engine/round/tests/`
Expected: 8 + 10 = 18 tests PASAN.

- [ ] **Step 7: Commit**

```bash
npm run typecheck && npm test
git add src/features/match/core
git commit -m "feat(round): extremos derivados del tablero y reglas de jugada legal

Los extremos no son campos del estado: se derivan de la cadena jugada, porque
almacenarlos invita a la desincronización. La derivación maneja las dobles (el
extremo no cambia) y que la ficha venga escrita de cualquier lado.

Con el tablero vacío la primera ficha se normaliza a un solo lado: sin eso, la
primera jugada tendría dos representaciones del mismo tablero.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 17: Tranca y primer turno

> **⚠ Dependencia del documento de reglas.** Las dos reglas de esta tarea son las que más difieren
> entre los tres modos del v1. Lo que va abajo es lo que hace `determineFirstTurnPlayer`
> (`two-players/domino-room-state.ts:252-268`) y `getBlockWinner` (`:396-417`). **Si
> `docs/reglas-de-juego-v1.md` §3.2 y §3.7 dicen otra cosa, manda el documento**: corregir el test
> citando su sección, y después la implementación.

**Files:**
- Create: `src/features/match/core/engine/round/first-turn.ts`, `.../round/block.ts`
- Test: `.../round/tests/first-turn.test.ts`, `.../round/tests/block.test.ts`

- [ ] **Step 1: Escribir el test del primer turno**

```ts
// src/features/match/core/engine/round/tests/first-turn.test.ts
import { describe, expect, it } from "vitest";
import { firstPlayerOf } from "../first-turn.js";

// [playerId, mano] — la mano como pares [left, right].
const hands = (entries: [string, [number, number][]][]) =>
  entries.map(([playerId, tiles]) => ({
    playerId,
    tiles: tiles.map(([left, right]) => ({ left, right })),
  }));

describe("firstPlayerOf — reglas §3.2", () => {
  it("arranca quien tiene el doble seis", () => {
    const who = firstPlayerOf(
      hands([
        ["u1", [[5, 4], [3, 2]]],
        ["u2", [[6, 6], [0, 1]]],
      ]),
    );
    expect(who).toBe("u2");
  });

  it("si nadie tiene el doble seis, arranca quien tiene la ficha de mayor valor", () => {
    const who = firstPlayerOf(
      hands([
        ["u1", [[5, 4], [1, 1]]], // máximo 9
        ["u2", [[6, 5], [0, 0]]], // máximo 11
      ]),
    );
    expect(who).toBe("u2");
  });

  it("empate de valor máximo: gana el asiento más bajo, y es determinista", () => {
    const entries = hands([
      ["u1", [[6, 5]]],
      ["u2", [[5, 6]]],
    ]);
    expect(firstPlayerOf(entries)).toBe("u1");
    expect(firstPlayerOf(entries)).toBe("u1");
  });

  it("el doble seis manda incluso contra una ficha de valor igual", () => {
    const who = firstPlayerOf(
      hands([
        ["u1", [[6, 6]]],
        ["u2", [[6, 6]]], // imposible en una partida real; fija la precedencia
      ]),
    );
    expect(who).toBe("u1");
  });

  it("una lista sin manos rompe la invariante", () => {
    expect(() => firstPlayerOf([])).toThrow();
  });
});
```

- [ ] **Step 2: Escribir el test de la tranca**

```ts
// src/features/match/core/engine/round/tests/block.test.ts
import { describe, expect, it } from "vitest";
import { BoardState, BoneyardState, PlacedTile, RoundState, Tile } from "../../../state/index.js";
import { createMatchState } from "../../genesis.js";
import { handOf } from "../../state-projections.js";
import { blockVerdictOf, isBlocked } from "../block.js";

function build(handsBySeat: Record<string, [number, number][]>, boneyard: [number, number][] = []) {
  const seats = Object.keys(handsBySeat);
  const match = createMatchState({
    matchId: "m1",
    gameModeId: "g",
    seed: "s",
    seats,
    pointsToWin: 100,
    teamAssignment: "SHUFFLED",
    isDealWindowEnabled: false,
  });
  const round = new RoundState();
  round.roundNumber = 1;
  round.phase = "PLAYING";
  round.board = new BoardState();
  // La rama del pozo se instancia porque estos fixtures son de MESA DE DOS, que sí lo
  // tiene. Un fixture de 4P la deja ausente, y ahí `isBlocked` ya da la tranca correcta.
  const boneyardState = new BoneyardState();
  round.boneyard = boneyardState;

  // Una ficha en la mesa para que haya extremos: 6|4.
  const placedTile = new Tile();
  placedTile.left = 6;
  placedTile.right = 4;
  const placed = new PlacedTile();
  placed.tile = placedTile;
  placed.playedBy = seats[0] ?? "";
  placed.side = "RIGHT";
  round.board.tiles.push(placed);

  for (const [left, right] of boneyard) {
    const tile = new Tile();
    tile.left = left;
    tile.right = right;
    boneyardState.tiles.push(tile);
  }
  boneyardState.count = boneyardState.tiles.length;
  match.currentRound = round;

  for (const [playerId, tiles] of Object.entries(handsBySeat)) {
    const hand = handOf(playerId, match);
    for (const [left, right] of tiles) {
      const tile = new Tile();
      tile.left = left;
      tile.right = right;
      hand.tiles.push(tile);
    }
    hand.tileCount = hand.tiles.length;
  }
  return match;
}

describe("isBlocked", () => {
  it("no está trancado si alguien puede jugar", () => {
    // extremos 6 y 4; u1 tiene el 6|1
    expect(isBlocked(build({ u1: [[6, 1]], u2: [[3, 2]] }))).toBe(false);
  });

  it("no está trancado si queda pozo, aunque nadie pueda jugar", () => {
    // Nadie engancha, pero hay de dónde robar.
    expect(isBlocked(build({ u1: [[3, 2]], u2: [[5, 1]] }, [[0, 0]]))).toBe(false);
  });

  it("está trancado si nadie puede jugar y el pozo está vacío", () => {
    expect(isBlocked(build({ u1: [[3, 2]], u2: [[5, 1]] }))).toBe(true);
  });

  it("una mano vacía no traba nada: eso es dominó, no tranca", () => {
    // u1 se quedó sin fichas: la ronda cierra por dominó, no por tranca.
    expect(isBlocked(build({ u1: [], u2: [[5, 1]] }))).toBe(false);
  });
});

describe("blockVerdictOf — reglas §3.7", () => {
  it("gana quien tiene menos puntos en la mano", () => {
    const verdict = blockVerdictOf(build({ u1: [[3, 2]], u2: [[5, 1]] }));
    expect(verdict).toEqual({ winnerId: "u1", isTie: false, points: 6 });
  });

  it("los puntos son la suma de TODAS las manos perdedoras", () => {
    const verdict = blockVerdictOf(build({ u1: [[1, 0]], u2: [[5, 1], [4, 4]] }));
    // u1 gana con 1; el rival tiene 6 + 8 = 14.
    expect(verdict).toEqual({ winnerId: "u1", isTie: false, points: 14 });
  });

  it("empate de puntos: no hay ganador y lo dice", () => {
    const verdict = blockVerdictOf(build({ u1: [[3, 2]], u2: [[4, 1]] }));
    expect(verdict).toEqual({ winnerId: undefined, isTie: true, points: 0 });
  });

  it("quien abandonó no compite por el menor conteo", () => {
    const match = build({ u1: [[6, 6]], u2: [[0, 1]] });
    const abandoned = match.players.find((player) => player.playerId === "u2");
    if (abandoned) abandoned.hasAbandoned = true;
    const verdict = blockVerdictOf(match);
    expect(verdict.winnerId).toBe("u1");
  });
});
```

- [ ] **Step 3: Correr los dos tests para verificar que fallan**

Run: `npx vitest run src/features/match/core/engine/round/tests/first-turn.test.ts src/features/match/core/engine/round/tests/block.test.ts`
Expected: FAIL — no existen `first-turn.js` ni `block.js`.

- [ ] **Step 4: Escribir las dos reglas**

```ts
// src/features/match/core/engine/round/first-turn.ts
import type { PlayerId } from "../../ids.js";
import { InvariantViolationError } from "../errors.js";
import { DOMINO_MAX_PIP, type TileLike, isDouble, tileValue } from "../tile-set.js";

export interface SeatHand {
  readonly playerId: PlayerId;
  readonly tiles: readonly TileLike[];
}

// Reglas §3.2. El orden de la lista ES el orden de los asientos, y eso desempata:
// sin un desempate determinista, dos repartos idénticos podrían arrancar distinto y
// el replay dejaría de reproducir.
export function firstPlayerOf(hands: readonly SeatHand[]): PlayerId {
  if (hands.length === 0) throw new InvariantViolationError("no hay manos que comparar");

  const withMaxDouble = hands.find((hand) =>
    hand.tiles.some((tile) => isDouble(tile) && tile.left === DOMINO_MAX_PIP),
  );
  if (withMaxDouble) return withMaxDouble.playerId;

  let best = hands[0] as SeatHand;
  let bestValue = maxTileValueOf(best);
  for (const hand of hands.slice(1)) {
    const value = maxTileValueOf(hand);
    // `>` y no `>=`: en empate gana el asiento más bajo, que es el primero visto.
    if (value > bestValue) {
      best = hand;
      bestValue = value;
    }
  }
  return best.playerId;
}

function maxTileValueOf(hand: SeatHand): number {
  return hand.tiles.reduce((max, tile) => Math.max(max, tileValue(tile)), -1);
}
```

```ts
// src/features/match/core/engine/round/block.ts
import type { PlayerId } from "../../ids.js";
import type { MatchState } from "../../state/index.js";
import { boneyardCountOf, currentRoundOf, roundActivePlayers } from "../state-projections.js";
import { handValue } from "../tile-set.js";
import { boardEndsOf } from "./board-ends.js";
import { hasPlayableTile } from "./playable.js";

// TRANCA: nadie puede jugar Y no queda de dónde robar. Mientras haya pozo, quien no
// puede jugar roba, así que la ronda no está cerrada.
//
// `boneyardCountOf` y no `round.boneyard.count`: en 4P la rama no existe, y ahí "no
// queda de dónde robar" es cierto DESDE EL PRIMER TURNO. Es la razón entera de que los
// dos modos compartan esta función en vez de tener un `isGameBlockedFourPlayers` como
// el v1 (reglas §3.7 y el hallazgo de duplicación de §6).
export function isBlocked(match: MatchState): boolean {
  const round = currentRoundOf(match);
  if (boneyardCountOf(round) > 0) return false;

  const active = roundActivePlayers(match);
  // Una mano vacía cierra por DOMINÓ, no por tranca: no es este camino.
  if (active.some((player) => player.hand.tiles.length === 0)) return false;

  const ends = boardEndsOf(round.board);
  return !active.some((player) => hasPlayableTile([...player.hand.tiles], ends));
}

export interface BlockVerdict {
  readonly winnerId: PlayerId | undefined;
  readonly isTie: boolean;
  /** Suma de las manos PERDEDORAS. Cero si hay empate: no se tarifa nada. */
  readonly points: number;
}

// Reglas §3.7: gana quien tiene menos puntos en la mano, y cobra la suma de las
// manos ajenas. El empate lo declara y no lo resuelve: qué hacer con los puntos
// cuando dos manos empatan es decisión de §3.7 del documento de reglas, y la
// ejecuta el Scorer.
//
// ⚠ ESTO ES LA REGLA DE 2P, Y EN 4P NO ES LA MISMA. Acá se compara jugador contra
// jugador; en 4P la tranca se resuelve comparando el **total del EQUIPO** —la suma de
// los pips de los dos compañeros— y empata si los dos totales coinciden (reglas §7,
// decisión 3). Con cuatro asientos, esta función coronaría al jugador de mano más liviana
// aunque su equipo tenga más pips que el rival.
//
// No se generaliza ahora porque la rebanada es de 2P y una implementación de 4P sin sus
// tests sería adivinar. Pero el riesgo es REAL y silencioso: el motor es uno solo, así
// que 4P heredaría esta versión sin que nada chille. Cuando entre 4P, esta función se
// parte en dos o toma la agrupación como parámetro.
export function blockVerdictOf(match: MatchState): BlockVerdict {
  const active = roundActivePlayers(match);
  const totals = active.map((player) => ({
    playerId: player.playerId,
    value: handValue([...player.hand.tiles]),
  }));

  const lowest = Math.min(...totals.map((entry) => entry.value));
  const contenders = totals.filter((entry) => entry.value === lowest);
  if (contenders.length !== 1) return { winnerId: undefined, isTie: true, points: 0 };

  const winnerId = (contenders[0] as { playerId: PlayerId }).playerId;
  const points = totals
    .filter((entry) => entry.playerId !== winnerId)
    .reduce((sum, entry) => sum + entry.value, 0);
  return { winnerId, isTie: false, points };
}
```

- [ ] **Step 5: Correr los tests y commitear**

Run: `npx vitest run src/features/match/core/engine/round/tests/`
Expected: 5 + 8 + 21 = 34 tests PASAN.

```bash
npm run typecheck && npm test
git add src/features/match/core
git commit -m "feat(round): tranca y primer turno, con el desempate determinista

El primer turno desempata por asiento más bajo, y eso no es un detalle: sin un
desempate determinista, dos repartos idénticos podrían arrancar distinto y el
replay dejaría de reproducir.

isBlocked distingue tranca de dominó: una mano vacía no traba nada. Y mientras
haya pozo la ronda no está cerrada, porque quien no puede jugar roba.

blockVerdictOf declara el empate en vez de resolverlo: qué pasa con los puntos es
decisión de las reglas §3.7 y la ejecuta el Scorer.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 18: `RoundReferee` y `RoundPlayer`

Solo el juez y el mutador, probados **directo contra el estado**: sin conductor y sin comandos, que
llegan en la Tarea 19. Así esta tarea no depende de nada que no exista todavía.

> **⚠ ACÁ HACE FALTA `currentTurnOf(round)`, y es la tercera vez que aparece el mismo patrón.**
> `RoundState.currentTurn` es `.optional()` (Tarea 4), así que con `strict: true` los usos de esta
> tarea y de la 19 —`round.currentTurn.playerId`, `currentTurn.consecutivePasses = …`— no compilan. Y
> `?.` no sirve: del lado de la **escritura** no compila de ninguna forma.
>
> Se resuelve igual que `currentRoundOf` y `scoreboardOf`: una proyección que estrecha y lanza la
> invariante si falta, en `state-projections.ts`, con su test de las dos ramas. **No se creó antes a
> propósito** —en la Tarea 6 no había consumidor y habría sido construir por adelantado—, pero acá sí
> lo hay, así que es el primer paso de esta tarea.
>
> `boneyard` ya está cubierto por `boneyardOf`/`boneyardCountOf`. Con `currentTurnOf`, las cuatro
> ramas nulas del árbol quedan con su proyección.

**Files:**
- Create: `src/features/match/core/engine/round/player.ts`, `.../round/referee.ts`, `.../round/index.ts`
- Test: `src/features/match/core/engine/round/tests/referee.test.ts`, `.../tests/player.test.ts`

- [ ] **Step 1: Escribir un helper de estado para los dos tests**

```ts
// src/features/match/core/engine/round/tests/round-fixture.ts
import { BoardState, BoneyardState, PlacedTile, RoundState, Tile, Turn } from "../../../state/index.js";
import type { BoardSide } from "../../../state/tile.js";
import type { MatchState, RoundPhase } from "../../../state/index.js";
import { createMatchState } from "../../genesis.js";
import { handOf } from "../../state-projections.js";

export interface RoundSetup {
  hands: Record<string, [number, number][]>;
  /** Fichas ya en la mesa, en orden de juego. */
  board?: [number, number, BoardSide][];
  boneyard?: [number, number][];
  turn?: string;
  phase?: RoundPhase;
}

function tileOf([left, right]: [number, number]): Tile {
  const tile = new Tile();
  tile.left = left;
  tile.right = right;
  return tile;
}

export function roundState(setup: RoundSetup): MatchState {
  const seats = Object.keys(setup.hands);
  const match = createMatchState({
    matchId: "m1",
    gameModeId: "g",
    seed: "s",
    seats,
    pointsToWin: 100,
    teamAssignment: "SHUFFLED",
    isDealWindowEnabled: false,
  });
  match.phase = "PLAYING";

  const round = new RoundState();
  round.roundNumber = 1;
  round.phase = setup.phase ?? "PLAYING";
  round.board = new BoardState();
  const boneyardState = new BoneyardState();
  round.boneyard = boneyardState;
  round.starterId = setup.turn ?? seats[0] ?? "";

  for (const [left, right, side] of setup.board ?? []) {
    const placed = new PlacedTile();
    placed.tile = tileOf([left, right]);
    placed.playedBy = seats[0] ?? "";
    placed.side = side;
    round.board.tiles.push(placed);
  }
  for (const pair of setup.boneyard ?? []) boneyardState.tiles.push(tileOf(pair));
  boneyardState.count = boneyardState.tiles.length;

  const turn = new Turn();
  turn.playerId = setup.turn ?? seats[0] ?? "";
  turn.isConsumingExtendedTime = false;
  turn.consecutivePasses = 0;
  round.currentTurn = turn;

  match.currentRound = round;

  for (const [playerId, tiles] of Object.entries(setup.hands)) {
    const hand = handOf(playerId, match);
    for (const pair of tiles) hand.tiles.push(tileOf(pair));
    hand.tileCount = hand.tiles.length;
  }
  return match;
}
```

Añadir `Turn` al import de `state/index.js` en ese archivo.

- [ ] **Step 2: Escribir el test del juez**

```ts
// src/features/match/core/engine/round/tests/referee.test.ts
import { describe, expect, it } from "vitest";
import { RuleViolationError } from "../../errors.js";
import { RoundReferee } from "../referee.js";
import { roundState } from "./round-fixture.js";

const refereeFor = (setup: Parameters<typeof roundState>[0]) =>
  new RoundReferee(roundState(setup));

describe("RoundReferee.assertCanPlay", () => {
  const base = {
    hands: { u1: [[6, 1], [3, 2]] as [number, number][], u2: [[5, 5]] as [number, number][] },
    board: [[6, 4, "RIGHT"]] as [number, number, "RIGHT"][], // extremos 6 y 4
    turn: "u1",
  };

  it("acepta una jugada legal", () => {
    expect(() => refereeFor(base).assertCanPlay("u1", { left: 6, right: 1 }, "LEFT")).not.toThrow();
  });

  it("rechaza jugar fuera de turno", () => {
    expect(() => refereeFor(base).assertCanPlay("u2", { left: 5, right: 5 }, "LEFT")).toThrow(
      new RuleViolationError("NOT_YOUR_TURN"),
    );
  });

  it("rechaza una ficha que no está en la mano", () => {
    expect(() => refereeFor(base).assertCanPlay("u1", { left: 0, right: 0 }, "LEFT")).toThrow(
      new RuleViolationError("TILE_NOT_IN_HAND"),
    );
  });

  it("rechaza colgar de un lado donde no engancha", () => {
    expect(() => refereeFor(base).assertCanPlay("u1", { left: 6, right: 1 }, "RIGHT")).toThrow(
      new RuleViolationError("SIDE_NOT_PLAYABLE"),
    );
  });

  it("rechaza cualquier jugada si la ronda no está en PLAYING", () => {
    expect(() =>
      refereeFor({ ...base, phase: "PRESENTING_ROUND" }).assertCanPlay(
        "u1",
        { left: 6, right: 1 },
        "LEFT",
      ),
    ).toThrow(new RuleViolationError("NOT_PLAYING"));
  });

  it("reconoce la ficha aunque venga escrita al revés", () => {
    expect(() => refereeFor(base).assertCanPlay("u1", { left: 1, right: 6 }, "LEFT")).not.toThrow();
  });
});

describe("RoundReferee — robar y pasar", () => {
  // extremos 6 y 4; la mano no engancha
  const stuck = {
    hands: { u1: [[3, 2]] as [number, number][], u2: [[5, 5]] as [number, number][] },
    board: [[6, 4, "RIGHT"]] as [number, number, "RIGHT"][],
    turn: "u1",
  };

  it("se puede robar si no hay jugada y queda pozo", () => {
    expect(() => refereeFor({ ...stuck, boneyard: [[0, 0]] }).assertCanDraw("u1")).not.toThrow();
  });

  it("NO se puede robar pudiendo jugar: robar es el recurso de quien no puede", () => {
    const canPlay = { ...stuck, hands: { u1: [[6, 1]] as [number, number][], u2: [[5, 5]] as [number, number][] }, boneyard: [[0, 0]] as [number, number][] };
    expect(() => refereeFor(canPlay).assertCanDraw("u1")).toThrow(
      new RuleViolationError("MUST_PLAY_INSTEAD_OF_DRAWING"),
    );
  });

  it("NO se puede robar de un pozo vacío", () => {
    expect(() => refereeFor(stuck).assertCanDraw("u1")).toThrow(
      new RuleViolationError("BONEYARD_EMPTY"),
    );
  });

  it("se puede pasar solo con el pozo vacío y sin jugada", () => {
    expect(() => refereeFor(stuck).assertCanPass("u1")).not.toThrow();
  });

  it("NO se puede pasar habiendo pozo: primero se roba", () => {
    expect(() => refereeFor({ ...stuck, boneyard: [[0, 0]] }).assertCanPass("u1")).toThrow(
      new RuleViolationError("MUST_DRAW_INSTEAD_OF_PASSING"),
    );
  });

  it("NO se puede pasar pudiendo jugar", () => {
    const canPlay = { ...stuck, hands: { u1: [[6, 1]] as [number, number][], u2: [[5, 5]] as [number, number][] } };
    expect(() => refereeFor(canPlay).assertCanPass("u1")).toThrow(
      new RuleViolationError("MUST_PLAY_INSTEAD_OF_DRAWING"),
    );
  });
});
```

- [ ] **Step 3: Escribir el test del mutador**

```ts
// src/features/match/core/engine/round/tests/player.test.ts
import { describe, expect, it } from "vitest";
import { handOf } from "../../state-projections.js";
import { boardEndsOf } from "../board-ends.js";
import { RoundPlayer } from "../player.js";
import { roundState } from "./round-fixture.js";

describe("RoundPlayer.playTile", () => {
  it("saca la ficha de la mano, la pone en la mesa y mantiene tileCount", () => {
    const match = roundState({
      hands: { u1: [[6, 1], [3, 2]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
    });
    new RoundPlayer("u1", match).playTile({ left: 6, right: 1 }, "LEFT");

    const hand = handOf("u1", match);
    expect(hand.tiles.length).toBe(1);
    expect(hand.tileCount).toBe(1);
    expect(match.currentRound?.board.tiles.length).toBe(2);
  });

  it("guarda quién la jugó, de qué lado y por qué número enganchó", () => {
    const match = roundState({
      hands: { u1: [[6, 1]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
    });
    new RoundPlayer("u1", match).playTile({ left: 6, right: 1 }, "LEFT");

    const placed = match.currentRound?.board.tiles.at(-1);
    expect(placed?.playedBy).toBe("u1");
    expect(placed?.side).toBe("LEFT");
  });

  // El array del tablero es el orden de JUEGO, no el orden espacial de la cadena:
  // boardEndsOf recorre asumiendo que el primero fijó los extremos y que cada
  // siguiente se colgó del lado que dice su `side`. Insertar al frente lo rompe.
  it("siempre añade AL FINAL del array, incluso jugando a la izquierda", () => {
    const match = roundState({
      hands: { u1: [[6, 1]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
    });
    new RoundPlayer("u1", match).playTile({ left: 6, right: 1 }, "LEFT");

    expect(match.currentRound?.board.tiles.at(0)?.tile.toJSON()).toEqual({ left: 6, right: 4 });
    expect(boardEndsOf(match.currentRound!.board)).toEqual({ left: 1, right: 4 });
  });

  it("acepta la ficha escrita al revés y guarda la que tenía en la mano", () => {
    const match = roundState({
      hands: { u1: [[6, 1]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
    });
    new RoundPlayer("u1", match).playTile({ left: 1, right: 6 }, "LEFT");
    expect(match.currentRound?.board.tiles.at(-1)?.tile.toJSON()).toEqual({ left: 6, right: 1 });
  });
});

describe("RoundPlayer.drawTile", () => {
  it("mueve una ficha del pozo a la mano y actualiza los dos contadores", () => {
    const match = roundState({
      hands: { u1: [[3, 2]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
      boneyard: [[0, 0], [1, 1]],
    });
    new RoundPlayer("u1", match).drawTile();

    expect(handOf("u1", match).tiles.length).toBe(2);
    expect(handOf("u1", match).tileCount).toBe(2);
    expect(match.currentRound?.boneyard?.tiles.length).toBe(1);
    expect(match.currentRound?.boneyard?.count).toBe(1);
  });

  it("roba del frente del pozo, así que el orden es determinista", () => {
    const match = roundState({
      hands: { u1: [[3, 2]], u2: [[5, 5]] },
      board: [[6, 4, "RIGHT"]],
      boneyard: [[0, 0], [1, 1]],
    });
    new RoundPlayer("u1", match).drawTile();
    expect(handOf("u1", match).tiles.at(-1)?.toJSON()).toEqual({ left: 0, right: 0 });
  });
});
```

- [ ] **Step 4: Correr los tests para verificar que fallan**

Run: `npx vitest run src/features/match/core/engine/round/tests/referee.test.ts src/features/match/core/engine/round/tests/player.test.ts`
Expected: FAIL — no existen `referee.js` ni `player.js`.

- [ ] **Step 5: Escribir `RoundReferee` y `RoundPlayer`**

```ts
// src/features/match/core/engine/round/referee.ts
import type { PlayerId } from "../../ids.js";
import type { BoardSide, TileLike } from "../../state/tile.js";
import type { MatchState } from "../../state/index.js";
import { RuleViolationError } from "../errors.js";
import {
  boneyardCountOf,
  currentRoundOf,
  handOf,
  playerOf,
  roundActivePlayers,
} from "../state-projections.js";
import { sameTile } from "../tile-set.js";
import { boardEndsOf } from "./board-ends.js";
import { hasPlayableTile, playableSides } from "./playable.js";

// JUEZ de la RONDA. Read-only: valida y deriva, no muta.
export class RoundReferee {
  constructor(private readonly match: MatchState) {}

  assertCanPlay(playerId: PlayerId, tile: TileLike, side: BoardSide): void {
    this.assertIsTurn(playerId);
    const held = this.tileInHand(playerId, tile);
    if (!held) throw new RuleViolationError("TILE_NOT_IN_HAND");
    const ends = boardEndsOf(currentRoundOf(this.match).board);
    if (!playableSides(tile, ends).includes(side)) {
      throw new RuleViolationError("SIDE_NOT_PLAYABLE");
    }
  }

  assertCanDraw(playerId: PlayerId): void {
    this.assertIsTurn(playerId);
    const round = currentRoundOf(this.match);
    // No se roba pudiendo jugar: robar es el recurso de quien NO puede.
    if (this.hasPlayable(playerId)) throw new RuleViolationError("MUST_PLAY_INSTEAD_OF_DRAWING");
    // Vale tanto para "el pozo se agotó" como para "esta mesa no tiene pozo" (4P): las
    // dos son la misma respuesta al jugador, y el código de regla ya lo dice.
    if (boneyardCountOf(round) === 0) throw new RuleViolationError("BONEYARD_EMPTY");
  }

  assertCanPass(playerId: PlayerId): void {
    this.assertIsTurn(playerId);
    const round = currentRoundOf(this.match);
    if (this.hasPlayable(playerId)) throw new RuleViolationError("MUST_PLAY_INSTEAD_OF_DRAWING");
    // Mientras haya pozo, no se pasa: se roba. En 4P nunca hay, así que pasar es legal
    // en cuanto no hay jugada — sin una rama por modo.
    if (boneyardCountOf(round) > 0) throw new RuleViolationError("MUST_DRAW_INSTEAD_OF_PASSING");
  }

  // Levantar la propia mano (`REVEAL_TILES`, reglas §3.1): solo durante la ventana de
  // reparto y una sola vez. **No pide turno** —los dos miran a la vez, que es todo el
  // punto de la ventana—, y por eso es el único verbo de jugador que no pasa por
  // `assertIsTurn`.
  assertCanRevealTiles(playerId: PlayerId): void {
    if (currentRoundOf(this.match).phase !== "DEALING") {
      throw new RuleViolationError("NOT_DEALING");
    }
    if (playerOf(playerId, this.match).hasSeenTiles) {
      throw new RuleViolationError("TILES_ALREADY_SEEN");
    }
  }

  // ¿Quiénes de los que siguen en la partida NO levantaron sus fichas? Vacío = ya se
  // puede jugar. Lo consulta el conductor en las DOS salidas de la ventana: el verbo
  // (¿falta alguien?) y el vencimiento (¿a quién se retira?).
  playersWithoutTilesSeen(): readonly PlayerId[] {
    return roundActivePlayers(this.match)
      .filter((player) => !player.hasSeenTiles)
      .map((player) => player.playerId);
  }

  hasPlayable(playerId: PlayerId): boolean {
    const ends = boardEndsOf(currentRoundOf(this.match).board);
    return hasPlayableTile([...handOf(playerId, this.match).tiles], ends);
  }

  tileInHand(playerId: PlayerId, tile: TileLike): TileLike | undefined {
    return [...handOf(playerId, this.match).tiles].find((held) => sameTile(held, tile));
  }

  private assertIsTurn(playerId: PlayerId): void {
    const round = currentRoundOf(this.match);
    if (round.phase !== "PLAYING") throw new RuleViolationError("NOT_PLAYING");
    if (round.currentTurn.playerId !== playerId) throw new RuleViolationError("NOT_YOUR_TURN");
  }
}
```

```ts
// src/features/match/core/engine/round/player.ts
import type { PlayerId } from "../../ids.js";
import { PlacedTile, Tile } from "../../state/index.js";
import type { BoardSide, TileLike } from "../../state/tile.js";
import type { MatchState } from "../../state/index.js";
import { InvariantViolationError } from "../errors.js";
import { boneyardOf, currentRoundOf, handOf, playerOf } from "../state-projections.js";
import { sameTile } from "../tile-set.js";
import type { SchemaVisibilityController } from "../visibility.js";

// Solo MUTA. Referee-free: la legalidad ya la comprobó el juez.
//
// Sostiene el puerto de VISIBILIDAD porque es el actor que revela: el `Dealer` reparte
// tapado y el jugador levanta lo suyo (reglas §3.1).
export class RoundPlayer {
  constructor(
    private readonly playerId: PlayerId,
    private readonly match: MatchState,
    private readonly visibility: SchemaVisibilityController,
  ) {}

  // LEVANTA la mano: la hace pública a su dueño y deja anotado que ya la vio. Es el verbo
  // con el que se sale de la ventana de reparto, y el único revelado del juego que **no le
  // muestra nada a nadie más** — de ahí que no haya nada que decidir sobre la audiencia.
  //
  // Lo que la ventana viene a buscar no es información (el dueño ya sabe qué le tocó en
  // cuanto lo ve): es una PRUEBA DE QUE ESTÁ AHÍ. Eso es lo que el reloj del turno no
  // puede dar, porque solo mira al que le toca jugar.
  //
  // `hasSeenTiles` NO se resetea entre rondas: la ventana es solo la de la ronda 1, y de
  // ahí en adelante el reparto revela solo (`RoundDriver.revealAllHands`).
  revealTiles(): void {
    const player = playerOf(this.playerId, this.match);
    player.hasSeenTiles = true;
    this.visibility.makePublic(player.hand.tiles, {
      kind: "PLAYER",
      playerId: this.playerId,
    });
  }

  // DES-REVELA la mano de todas las audiencias. Es el gemelo de `revealTiles`, y la
  // ÚNICA razón por la que el puerto de visibilidad tiene un `hide`.
  //
  // POR QUÉ HACE FALTA, que no es obvio: al cerrar una ronda las manos se muestran a
  // TODOS para contar los pips (`Hand.isRevealed`), y `hand.tiles` es **el mismo nodo**
  // ronda a ronda —`clear()` + `push()` vacía el array pero NO lo saca de ninguna
  // `StateView`—. Sin des-revelar antes de repartir, a partir de la segunda ronda cada
  // mano nace pública para la mesa entera: el agujero de trampa del v1, reabierto por la
  // puerta de atrás y sin que ningún test de la ronda 1 lo note.
  //
  // Se llama SIEMPRE, aunque el revelado del cierre todavía no esté implementado en esta
  // rebanada. En la ronda 1 es un no-op; el día que el conteo revele, ya está cubierto.
  // Si esto se borra por "no lo usa nadie", vuelve el agujero.
  hideTiles(): void {
    this.visibility.hide(playerOf(this.playerId, this.match).hand.tiles, { kind: "ALL" });
  }

  playTile(tile: TileLike, side: BoardSide): void {
    const round = currentRoundOf(this.match);
    const hand = handOf(this.playerId, this.match);
    const index = [...hand.tiles].findIndex((held) => sameTile(held, tile));
    if (index < 0) throw new InvariantViolationError("la ficha no está en la mano");

    const [removed] = hand.tiles.splice(index, 1);
    if (!removed) throw new InvariantViolationError("splice no devolvió la ficha");
    hand.tileCount = hand.tiles.length;

    const placed = new PlacedTile();
    placed.tile = removed;
    placed.playedBy = this.playerId;
    placed.side = side;
    // SIEMPRE al final, incluso jugando a la izquierda. El array es el orden de
    // JUEGO, no el orden espacial de la cadena: `boardEndsOf` recorre asumiendo que
    // el primer elemento fijó los dos extremos y que cada siguiente se colgó del
    // lado que dice su `side`, así que insertar al frente rompería esa derivación.
    // El front reconstruye la disposición visual con `side`, con ese mismo recorrido.
    round.board.tiles.push(placed);
  }

  drawTile(): void {
    // `boneyardOf` y no `round.boneyard?`: robar en una mesa SIN pozo no es una jugada
    // ilegal —eso ya lo cortó `assertCanDraw`—, es un bug del motor. Revienta como
    // invariante, que es la clase de error que corresponde.
    const boneyard = boneyardOf(currentRoundOf(this.match));
    const [tile] = boneyard.tiles.splice(0, 1);
    if (!tile) throw new InvariantViolationError("el pozo está vacío");
    boneyard.count = boneyard.tiles.length;

    const hand = handOf(this.playerId, this.match);
    hand.tiles.push(tile);
    hand.tileCount = hand.tiles.length;
  }
}
```

```ts
// src/features/match/core/engine/round/index.ts
export * from "./block.js";
export * from "./board-ends.js";
export * from "./first-turn.js";
export * from "./playable.js";
export * from "./player.js";
export * from "./referee.js";
```

- [ ] **Step 6: Correr los tests hasta que pasen**

Run: `npx vitest run src/features/match/core/engine/round/tests/`
Expected: 12 + 6 + 34 = 52 tests PASAN.

- [ ] **Step 7: Commit**

```bash
npm run typecheck && npm test
git add src/features/match/core
git commit -m "feat(round): juez y mutador de la ronda

El juez separa tres reglas que el v1 tenía mezcladas: no se roba pudiendo jugar,
no se pasa habiendo pozo, y no se juega fuera de PLAYING. Cada una con su código
de violación, así que el front puede explicar por qué.

El array del tablero es el orden de JUEGO y no el orden espacial de la cadena, y
por eso el mutador siempre añade al final: insertar al frente rompería la
derivación de boardEndsOf. El front reconstruye la disposición con side, con el
mismo recorrido: el número de engarce no se guarda porque es derivable de datos
públicos.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 19: `Scorer`, `RoundDriver` y los tres verbos de juego

La tarea más grande de la rebanada: acá muere el `sleep()` y nace la ronda completa.

> **Dos reglas ya decididas, y esta tarea las implementa.** Salieron de la Tarea 0 y están en
> `docs/reglas-de-juego-v1.md`:
>
> - **§5.2 — al vencer el turno se RETIRA al jugador.** El motor no juega por él. Se conserva el
>   comportamiento del v1, y se **emite** `ABANDON` porque no hubo comando detrás — es lo que distingue
>   "se fue" de "lo sacamos". La consecuencia arquitectónica es que el vencimiento del turno lo resuelve
>   el conductor de **PARTIDA**, no el de ronda: retirar a alguien es un verbo de esa altura
>   (`MatchPlayer` es el único escritor de `hasAbandoned`).
>
>   **En 2P eso deja un solo jugador y la partida cae por forfeit — que es lo único que implementa esta
>   tarea.** En 4P el v1 rellena el asiento con un **bot** y la partida sigue; eso llega con el
>   incremento de 4P y **no cambia una línea del motor**: el engine emite `ABANDON` igual, y quien
>   engancha el bot es un listener del anillo (`network/`), que es donde vive la diferencia entre
>   forfeit y sustitución. Ver reglas §7 decisión 1, "Cómo se modela el bot en el v2".
> - **§7 decisión 4 — robar SIEMPRE reinicia el plazo del turno.** El v1 solo lo reiniciaba al robar
>   una ficha inservible, lo que premiaba robar mal. Por eso `DRAW_TILE` pasa por el conductor: el
>   reloj lo tocan las transiciones, nunca un comando por su cuenta.

**Files:**
- Create: `src/features/match/core/engine/scorer.ts`, `.../engine/round/driver.ts`, `src/features/match/core/commands/play-tile.ts`, `.../commands/draw-tile.ts`, `.../commands/pass.ts`
- Modify: `src/features/match/core/command.ts`, `.../engine/match/driver.ts`, `.../engine/player-facade.ts`, `.../engine/player-repository.ts`, `.../engine/referee-facade.ts`, `.../commands/index.ts`, `.../transports/colyseus/commands/payloads.ts`, `.../commands/di-wiring.ts`, `src/features/match/core/engine/tests/build-engine.ts`
- Test: `src/features/match/core/engine/tests/scorer.test.ts`, `.../tests/round-flow.test.ts`

- [ ] **Step 1: Sumar los tres verbos al contrato y ver romperse la compilación**

En `src/features/match/core/command.ts`:

```ts
import type { PlayerId } from "./ids.js";
import type { BoardSide } from "./state/tile.js";

export interface CommandPayloads {
  ABANDON: { playerId: PlayerId };
  PLAY_TILE: { playerId: PlayerId; left: number; right: number; side: BoardSide };
  DRAW_TILE: { playerId: PlayerId };
  PASS: { playerId: PlayerId };
  // Levantar la propia mano en la ventana de reparto (reglas §3.1). No lleva nada: el
  // verbo ES el acto, y qué fichas son ya lo sabe el motor desde que repartió.
  REVEAL_TILES: { playerId: PlayerId };
}
```

Run: `npm run typecheck`
Expected: **FALLA**, y eso es la garantía funcionando. `payloads.ts` no satisface
`Record<CommandName, z.ZodType>` y los mapas de `buildCatalog` están incompletos. Cada error apunta a
lo que falta. No arreglarlo todavía: se cierra en el Step 7.

- [ ] **Step 2: Escribir el test del Scorer**

```ts
// src/features/match/core/engine/tests/scorer.test.ts
import { describe, expect, it } from "vitest";
import { createMatchState } from "../genesis.js";
import { Scorer } from "../scorer.js";

const build = (pointsToWin = 100) =>
  createMatchState({
    matchId: "m1",
    gameModeId: "g",
    seed: "s",
    seats: ["u1", "u2"],
    pointsToWin,
    teamAssignment: "SHUFFLED",
    isDealWindowEnabled: false,
  });

describe("Scorer", () => {
  it("acredita los puntos al equipo del ganador", () => {
    const match = build();
    new Scorer(match).credit({ roundNumber: 1, winnerId: "u1", points: 14, reason: "DOMINO" });

    expect(match.scoreboard.teamA).toBe(14);
    expect(match.scoreboard.teamB).toBe(0);
  });

  // El marcador es del EQUIPO y solo del equipo: no hay `PlayerState.score` que
  // mantener en paralelo. Lo que el front muestra en la ficha del jugador es
  // `scoreboard[teamOf(player)]`, que en 4P es además la regla correcta (los dos
  // compañeros comparten el total; el v1 lo lograba duplicándolo en los dos).
  it("acredita al equipo del ganador y a nadie más", () => {
    const match = build();
    new Scorer(match).credit({ roundNumber: 1, winnerId: "u2", points: 9, reason: "BLOCKED" });

    expect(match.scoreboard.teamB).toBe(9);
    expect(match.scoreboard.teamA).toBe(0);
  });

  it("acumula entre rondas", () => {
    const match = build();
    const scorer = new Scorer(match);
    scorer.credit({ roundNumber: 1, winnerId: "u1", points: 10, reason: "DOMINO" });
    scorer.credit({ roundNumber: 2, winnerId: "u1", points: 5, reason: "BLOCKED" });

    expect(match.scoreboard.teamA).toBe(15);
  });

  it("archiva un resumen por ronda, que es lo único que sobrevive de las pasadas", () => {
    const match = build();
    new Scorer(match).credit({ roundNumber: 3, winnerId: "u1", points: 12, reason: "BLOCKED" });

    expect(match.pastRounds.length).toBe(1);
    expect(match.pastRounds.at(0)?.toJSON()).toEqual({
      roundNumber: 3,
      winnerId: "u1",
      winnerTeamId: "A",
      points: 12,
      reason: "BLOCKED",
    });
  });

  it("un empate no mueve el marcador pero deja rastro de la ronda", () => {
    const match = build();
    new Scorer(match).credit({ roundNumber: 1, winnerId: undefined, points: 0, reason: "BLOCKED" });

    expect(match.scoreboard.teamA).toBe(0);
    expect(match.scoreboard.teamB).toBe(0);
    expect(match.pastRounds.length).toBe(1);
    expect(match.pastRounds.at(0)?.winnerId).toBe("");
  });
});
```

- [ ] **Step 3: Escribir el `Scorer`**

```ts
// src/features/match/core/engine/scorer.ts
import type { PlayerId } from "../ids.js";
import { RoundSummary } from "../state/index.js";
import type { MatchState } from "../state/index.js";
import type { RoundEndReason } from "../state/round.js";
import { playerOf } from "./state-projections.js";

export interface RoundVerdict {
  readonly roundNumber: number;
  /** Ausente si la ronda empató. */
  readonly winnerId: PlayerId | undefined;
  readonly points: number;
  readonly reason: RoundEndReason;
}

// SERVICIO. Es el ÚNICO que escribe el marcador y el único que archiva una ronda:
// que sea el único es verificable con grep, y es lo que impide que dos piezas
// tarifen la misma cosa distinto.
export class Scorer {
  constructor(private readonly match: MatchState) {}

  credit(verdict: RoundVerdict): void {
    const summary = new RoundSummary();
    summary.roundNumber = verdict.roundNumber;
    summary.points = verdict.points;
    summary.reason = verdict.reason;

    if (verdict.winnerId) {
      const winner = playerOf(verdict.winnerId, this.match);
      // UN SOLO acumulador. El puntaje del jugador no se guarda: es
      // `scoreboard[teamOf(player)]` (ver el comentario de `PlayerState`).
      if (winner.teamId === "A") this.match.scoreboard.teamA += verdict.points;
      else this.match.scoreboard.teamB += verdict.points;
      summary.winnerId = verdict.winnerId;
      summary.winnerTeamId = winner.teamId;
    } else {
      // El empate no tarifa, pero la ronda ocurrió y tiene que quedar en el resumen.
      summary.winnerId = "";
      summary.winnerTeamId = "";
    }

    this.match.pastRounds.push(summary);
  }
}
```

Run: `npx vitest run src/features/match/core/engine/tests/scorer.test.ts`
Expected: los 5 tests PASAN.

- [ ] **Step 4: Escribir el `RoundDriver`**

```ts
// src/features/match/core/engine/round/driver.ts
import type { DominoMatchConfig, GlobalDominoConfig } from "../../config.js";
import type { MatchEvent } from "../../events.js";
import type { PlayerId } from "../../ids.js";
import { BoardState, BoneyardState, RoundState, Turn } from "../../state/index.js";
import type { MatchState } from "../../state/index.js";
import type { BoardSide } from "../../state/tile.js";
import type { Clock } from "../clock.js";
import type { Dealer } from "../dealer.js";
import type { Driver, TransitionResult } from "../driver.js";
import { InvariantViolationError } from "../errors.js";
import type { RoundVerdict, Scorer } from "../scorer.js";
import { currentRoundOf, handOf, playerOf, roundActivePlayers, turnOrderFrom } from "../state-projections.js";
import type { TimeoutScheduler } from "../timeout-scheduler.js";
import { DOMINO_SET_SIZE, tileValue } from "../tile-set.js";
import { blockVerdictOf, isBlocked } from "./block.js";
import { boardEndsOf } from "./board-ends.js";
import { firstPlayerOf } from "./first-turn.js";
import { playableSides } from "./playable.js";
import type { RoundPlayer } from "./player.js";
import type { RoundReferee } from "./referee.js";

// CONDUCTOR de la RONDA: dueño de la génesis de la mano, del orden de turnos, de
// TODOS los plazos de esta altura, y del cierre.
//
// Acá mueren los sleep(3000) y sleep(6000) del v1: la pausa de presentación es una
// FASE con plazo (PRESENTING_ROUND), no una espera dentro de la mutación. El motor
// estampa el instante y devuelve; nadie bloquea el event loop.
export class RoundDriver implements Driver {
  constructor(
    private readonly match: MatchState,
    private readonly clock: Clock,
    private readonly scheduler: TimeoutScheduler,
    private readonly config: GlobalDominoConfig,
    // Del config per-partida lo único que este conductor pregunta es si la mesa reparte
    // con ventana. Es un booleano compuesto AFUERA: acá no se sabe qué es "casual" ni
    // qué pidió producto.
    private readonly matchConfig: DominoMatchConfig,
    private readonly referee: RoundReferee,
    private readonly dealer: Dealer,
    private readonly scorer: Scorer,
    private readonly playerAt: (playerId: PlayerId) => RoundPlayer,
  ) {}

  begin(): void {
    const previous = this.match.currentRound;
    const roundNumber = this.match.pastRounds.length + 1;

    // La ronda se REEMPLAZA entera: no hay que resetear campo por campo.
    const round = new RoundState();
    round.roundNumber = roundNumber;
    // Nace en DEALING (el default del schema). Quién la pasa a PLAYING es
    // `continueAfterDeal`, y por eso hay tres caminos y no una asignación acá.
    round.board = new BoardState();
    round.currentTurn = new Turn();
    // RAMA NULA: el pozo solo se instancia en los modos que lo tienen. 4P reparte el set
    // entero (4×7 = 28), así que su rama queda AUSENTE — no un pozo vacío, que sería
    // indistinguible de un pozo agotado justo donde la tranca se calcula distinto.
    if (this.hasBoneyard()) round.boneyard = new BoneyardState();
    this.match.currentRound = round;

    // ANTES DE REPARTIR: des-revelar lo que la ronda pasada hizo público. El nodo
    // `hand.tiles` sobrevive a la ronda, así que lo que quedó en una `StateView` sigue
    // ahí aunque el array se vacíe. Ver `RoundPlayer.hideTiles`.
    this.hideAllHands();
    this.dealer.deal(roundNumber);

    // QUIÉN ABRE. La ronda 1 la abre el doble-seis (reglas §3.2). De la 2 en adelante
    // NO se vuelve a mirar la mano: la regla es alternancia estricta —abre el siguiente
    // al que abrió la anterior (reglas §4.1)—, y de ahí sale que `starterId` tenga que
    // estar en el estado: sin él, una vez que el turno se movió no hay de dónde sacarlo.
    round.starterId = previous?.starterId
      ? this.nextPlayerAfter(previous.starterId)
      : firstPlayerOf(
          roundActivePlayers(this.match).map((player) => ({
            playerId: player.playerId,
            tiles: [...player.hand.tiles],
          })),
        );

    // LA VENTANA DE REPARTO (reglas §3.1), y solo en la ronda 1: repartir ya no revela,
    // así que la fase deja de ser un paso instantáneo y pasa a ESPERAR a que cada uno
    // levante lo suyo. Es lo que controla que los dos estén ahí antes de que empiece a
    // correr el reloj del turno, que solo mira al que le toca jugar.
    //
    // De la ronda 2 en adelante no hay ceremonia: ya se demostró que están, así que el
    // reparto revela solo.
    if (this.matchConfig.isDealWindowEnabled && round.roundNumber === 1) {
      this.stampDeadline(this.config.dealingTimeoutMs);
      return;
    }
    this.revealAllHands();
    this.continueAfterDeal();
  }

  // Sale de la fase de reparto hacia el juego. Lo llaman los TRES caminos que la cierran:
  // el reparto sin ventana, el último que levanta sus fichas, y el vencimiento que retira
  // a los que no lo hicieron.
  private continueAfterDeal(): void {
    const round = currentRoundOf(this.match);
    round.phase = "PLAYING";
    this.startTurn(round.starterId);
  }

  // El revelado que antes hacía el reparto, para las rondas que no tienen ventana. Cada
  // mano a su dueño y a nadie más.
  private revealAllHands(): void {
    for (const player of this.match.players) this.playerAt(player.playerId).revealTiles();
  }

  private hideAllHands(): void {
    for (const player of this.match.players) this.playerAt(player.playerId).hideTiles();
  }

  // Hay pozo si el reparto no consume el set entero. Se DERIVA de la mesa y del
  // reparto, así que no hace falta un flag de config que pueda contradecirlos.
  private hasBoneyard(): boolean {
    return this.match.players.length * this.config.tilesPerPlayer < DOMINO_SET_SIZE;
  }

  // Reconcilia después de una acción. Recibe QUIÉN actuó y QUÉ hizo: sin lo primero
  // no puede saber si el actor sigue en la mano; sin lo segundo tendría que deducir
  // la reconciliación comparando el estado contra sí mismo.
  advance(actorId: PlayerId, action: RoundAction): TransitionResult {
    const round = currentRoundOf(this.match);

    // LA VENTANA DE REPARTO se reconcilia antes que nada y NO llega a la guarda de
    // `PLAYING` de abajo: es la única fase, además de esa, en la que un verbo de jugador
    // es legal (reglas §3.1). Cuando ya no falta nadie, la ronda arranca.
    if (round.phase === "DEALING") {
      if (this.referee.playersWithoutTilesSeen().length === 0) this.continueAfterDeal();
      return { events: [], finished: false };
    }

    if (round.phase !== "PLAYING") return { events: [], finished: false };

    // ROBAR conserva el turno pero REINICIA el plazo (reglas §7 decisión 4).
    // No puede cerrar la mano: robar no vacía una mano ni destapa una tranca
    // —si había de dónde robar, la ronda no estaba trabada—.
    if (action === "DREW") {
      this.startTurn(actorId);
      return { events: [], finished: false };
    }

    // PASAR es la única acción que no deja rastro en el tablero ni en el pozo, así que
    // el contador ES su rastro: sin esto, el rival no tiene de dónde enterarse de que
    // alguien pasó (el historial de Mongo no se sincroniza — spec §5.1). Jugar lo
    // resetea, porque lo que el front dibuja es la racha, no el total de la ronda.
    round.currentTurn.consecutivePasses =
      action === "PASSED" || action === "ABANDONED"
        ? round.currentTurn.consecutivePasses + 1
        : 0;

    // ¿DOMINÓ? El que se quedó sin fichas cierra y cobra las manos ajenas.
    if (handOf(actorId, this.match).tiles.length === 0) {
      return this.closeRound({
        roundNumber: round.roundNumber,
        winnerId: actorId,
        points: this.opposingHandsValue(actorId),
        reason: "DOMINO",
      });
    }

    // ¿TRANCA? Nadie puede jugar y no queda de dónde robar.
    if (isBlocked(this.match)) {
      const verdict = blockVerdictOf(this.match);
      return this.closeRound({
        roundNumber: round.roundNumber,
        winnerId: verdict.winnerId,
        points: verdict.points,
        reason: "BLOCKED",
      });
    }

    this.startTurn(this.nextPlayerAfter(actorId));
    return { events: [], finished: false };
  }

  // El conductor de RONDA solo maneja SU pausa. El vencimiento del turno lo resuelve
  // el de PARTIDA, porque retirar a un jugador es un verbo de esa altura
  // (`MatchPlayer.abandon` es el único escritor de `hasAbandoned`).
  timeout(): TransitionResult {
    const round = currentRoundOf(this.match);
    if (round.phase === "PRESENTING_ROUND") {
      // La pausa de presentación terminó. Quien decide si sigue otra ronda o cierra
      // la partida es el conductor de PARTIDA: acá solo se declara terminada la mano.
      return { events: [], finished: true };
    }
    // La ventana de reparto la vence el conductor de PARTIDA: su consecuencia es RETIRAR
    // gente, y `hasAbandoned` lo escribe solo `MatchPlayer`. Acá arriba queda lo que sí es
    // de esta altura —revelar y arrancar la mano—, en `resumeAfterDealWindow`.
    throw new InvariantViolationError(`el conductor de RONDA no maneja la fase ${round.phase}`);
  }

  /** Quiénes siguen en la partida y NO levantaron sus fichas. Lo lee el conductor de PARTIDA. */
  playersMissingTiles(): readonly PlayerId[] {
    return this.referee.playersWithoutTilesSeen();
  }

  // Cierra la ventana de reparto DESPUÉS de que el conductor de PARTIDA retiró a los
  // ausentes. A los que sí miraron se les revela igual: si la ronda sigue (4P con uno
  // menos), no van a jugar a ciegas por culpa del que se fue.
  resumeAfterDealWindow(): void {
    this.revealAllHands();
    this.continueAfterDeal();
  }

  /** De quién es el turno. Lo lee el conductor de PARTIDA para saber a quién retirar. */
  currentTurnPlayerId(): PlayerId {
    return currentRoundOf(this.match).currentTurn.playerId;
  }

  private closeRound(verdict: RoundVerdict): TransitionResult {
    const round = currentRoundOf(this.match);
    this.scorer.credit(verdict);
    round.phase = "PRESENTING_ROUND";
    this.stampDeadline(this.config.presentingRoundMs);

    const winner = verdict.winnerId ? playerOf(verdict.winnerId, this.match) : undefined;
    return {
      events: [
        {
          type: "ROUND_RESOLVED",
          roundNumber: verdict.roundNumber,
          winnerId: verdict.winnerId ?? "",
          winnerTeamId: (winner?.teamId ?? "") as "A" | "B",
          points: verdict.points,
          reason: verdict.reason,
        },
      ],
      finished: false,
    };
  }

  // Lo que cobra el que cerró por dominó: los pips que quedaron en las manos ajenas.
  //
  // ⚠ MISMA ADVERTENCIA QUE `blockVerdictOf`: esto es 2P. Filtra al ganador y suma a
  // TODOS los demás, y en 4P eso incluiría a su propio COMPAÑERO — que no es lo que
  // dicen las reglas (§3.8: el equipo ganador cobra los pips de los DOS jugadores del
  // equipo perdedor, no los de tres asientos). En una mesa de dos el filtro por jugador
  // y el filtro por equipo dan lo mismo; en una de cuatro, no.
  private opposingHandsValue(winnerId: PlayerId): number {
    return roundActivePlayers(this.match)
      .filter((player) => player.playerId !== winnerId)
      .reduce(
        (sum, player) =>
          sum + [...player.hand.tiles].reduce((inner, tile) => inner + tileValue(tile), 0),
        0,
      );
  }

  private nextPlayerAfter(playerId: PlayerId): PlayerId {
    const order = turnOrderFrom(playerId, this.match).filter(
      (player) => !player.hasAbandoned,
    );
    // El primero del ciclo es el actor: el siguiente activo es el segundo.
    return (order[1] ?? order[0])?.playerId ?? playerId;
  }

  private startTurn(playerId: PlayerId): void {
    const round = currentRoundOf(this.match);
    this.settleExtraTime();
    round.currentTurn.playerId = playerId;
    round.currentTurn.isConsumingExtendedTime = false;
    this.stampDeadline(this.config.turnTimeoutMs);
  }

  // El turno normal venció y el jugador todavía tiene reserva: se extiende con lo que le
  // queda, en vez de retirarlo. Devuelve si pudo. Lo pregunta el conductor de PARTIDA
  // antes de retirar a nadie, porque retirar es verbo de esa altura pero el saldo es de
  // este nivel (es el turno el que se estira).
  extendWithReserve(playerId: PlayerId): boolean {
    const remaining = playerOf(playerId, this.match).extraTimeRemainingMs;
    if (remaining <= 0) return false;
    currentRoundOf(this.match).currentTurn.isConsumingExtendedTime = true;
    this.stampDeadline(remaining);
    return true;
  }

  // Si el turno que se va estaba consumiendo la reserva, le devuelve lo que NO gastó.
  // Sin esto, tocar la reserva la quemaría entera —y la regla es que solo decrece por
  // lo consumido, no por haberla usado (reglas §5.1, decisión 7)—.
  private settleExtraTime(): void {
    const turn = currentRoundOf(this.match).currentTurn;
    if (!turn.isConsumingExtendedTime || !turn.playerId) return;
    const unused = this.match.activeDeadline - this.clock.now();
    playerOf(turn.playerId, this.match).extraTimeRemainingMs = Math.max(0, unused);
  }

  private stampDeadline(durationMs: number): void {
    const at = this.clock.now() + durationMs;
    this.match.activeDeadline = at;
    this.scheduler.schedule(at, () => this.match.currentRound?.phase === "PRESENTING_ROUND"
      ? this.onRoundPauseExpired()
      : this.timeout().events);
  }

  // La pausa de la mano venció: se lo cuenta al conductor de PARTIDA por su
  // callback, porque decidir "otra ronda o cerrar" es de esa altura.
  private onRoundPauseExpired(): readonly MatchEvent[] {
    return this.onRoundFinished();
  }

  /** Lo inyecta el conductor de PARTIDA en el wiring. */
  onRoundFinished: () => readonly MatchEvent[] = () => [];

  /** El juez de la ronda, para que el conductor de PARTIDA no lo resuelva aparte. */
  get roundReferee(): RoundReferee {
    return this.referee;
  }
}
```

- [ ] **Step 5: Reescribir el `MatchDriver` para que rutee los plazos**

Reemplazar `timeout()` y `begin()` en `src/features/match/core/engine/match/driver.ts`, y sumar la
dependencia del `RoundDriver`:

```ts
// añadir al constructor, después de `referee`
    private readonly roundDriver: RoundDriver,
```

```ts
  begin(): void {
    if (this.match.phase !== "NOT_STARTED") return;
    this.match.phase = "PLAYING";
    this.match.startedAt = this.clock.now();
    for (const player of this.match.players) {
      player.extraTimeRemainingMs = this.config.extraTimeReserveMs;
    }
    // El conductor de RONDA nos avisa cuando su pausa vence, y de ahí sale la
    // decisión de esta altura: otra ronda, o cerrar la partida.
    this.roundDriver.onRoundFinished = () => this.afterRound();
    this.roundDriver.begin();
  }

  timeout(): TransitionResult {
    const kind = deadlineKindOf(this.match);
    const events: MatchEvent[] = [{ type: "DEADLINE_EXPIRED", kind }];

    // VENCIÓ EL TURNO: se retira al jugador (reglas §5.2, decisión 1). No se juega
    // por él. En 2P eso deja un solo jugador y la partida se resuelve por forfeit,
    // que es lo que hace el v1 y lo que el producto decidió conservar.
    //
    // Se EMITE `ABANDON` porque no hubo comando detrás: es lo que distingue
    // "se fue" de "lo sacamos", y para un reclamo esa es toda la pregunta.
    // VENCIÓ LA VENTANA DE REPARTO (reglas §3.1). El que no levantó sus fichas no está, y
    // se lo retira por el MISMO camino que al que no juega su turno: `players.abandon()`,
    // el verbo del jugador ejecutado por el sistema. Un `ABANDON` por cada uno, que es lo
    // que distingue "se fue" de "lo sacaron".
    //
    // Vive acá y no en el conductor de RONDA aunque el plazo sea de ese nivel, porque su
    // consecuencia es retirar gente y `hasAbandoned` lo escribe solo `MatchPlayer`. El
    // conductor de ronda hace su mitad después, en `resumeAfterDealWindow`.
    if (kind === "DEALING") {
      const missing = this.roundDriver.playersMissingTiles();
      for (const playerId of missing) this.players.abandon(playerId);
      events.push(...missing.map((playerId) => ({ type: "ABANDON", playerId }) as const));

      // Tres desenlaces, en orden de gravedad.
      //
      // 1) NO QUEDÓ NADIE: nadie levantó nada, así que nadie jugó. No hay veredicto que
      //    dar —`outcome()` devuelve `undefined` con los dos equipos retirados, y eso es
      //    deliberado (ver `MatchReferee`)—, la mesa se muere sin ganador y la sala
      //    reembolsa con `MATCH_ABORTED { reason: "NEVER_PLAYED" }`.
      //
      //    Y HAY QUE APAGAR EL PLAZO. No es prolijidad: el instante ya venció, así que
      //    cualquier cosa que vuelva a mirar `activeDeadline` lo encuentra vencido,
      //    despierta en el acto, encuentra la misma fase muerta y se vuelve a programar —
      //    un bucle mudo que no termina nunca. Es el bug que en truco encontró su propio
      //    test, y el plan lo hereda gratis por haberlo leído.
      if (roundActivePlayers(this.match).length === 0) {
        this.match.activeDeadline = 0;
        this.scheduler.cancel();
        return { events, finished: false };
      }

      // 2) UN LADO SE VACIÓ: forfeit. El juez ya sabe leerlo, y el veredicto sale al
      //    entrar a la presentación como en cualquier otro cierre.
      if (this.referee.outcome()) {
        return { events: [...events, ...this.enterPresentingMatch()], finished: false };
      }

      // 3) QUEDÓ GENTE DE LOS DOS LADOS: la ronda arranca, con uno menos si hace falta.
      this.roundDriver.resumeAfterDealWindow();
      return { events, finished: false };
    }

    if (kind === "TURN") {
      const playerId = this.roundDriver.currentTurnPlayerId();

      // PRIMERO la reserva. El plazo normal venció, pero si al jugador le queda saldo
      // de tiempo extra el turno se ESTIRA en vez de retirarlo (reglas §5.1, decisión 7).
      // Solo cuando la reserva está en cero se lo retira. El evento del vencimiento sale
      // igual: venció un plazo de verdad, y para soporte esa línea es la que explica por
      // qué el turno duró 90 s.
      if (this.roundDriver.extendWithReserve(playerId)) {
        return { events, finished: false };
      }

      this.players.abandon(playerId);
      events.push({ type: "ABANDON", playerId });
      const transition = this.advance(playerId, "ABANDONED");
      return { events: [...events, ...transition.events], finished: transition.finished };
    }

    if (kind === "PRESENTING_ROUND") {
      const inner = this.roundDriver.timeout();
      return { events: [...events, ...inner.events, ...this.afterRound()], finished: false };
    }

    // Vencida la presentación solo queda cerrar la máquina: el veredicto ya salió
    // al ENTRAR (ver `enterPresentingMatch`).
    this.match.phase = "FINISHED";
    this.match.activeDeadline = 0;
    this.scheduler.cancel();
    return { events, finished: true };
  }

  // ¿Se alcanzó el objetivo? Se cierra la partida. Si no, otra ronda.
  private afterRound(): readonly MatchEvent[] {
    if (this.referee.outcome()) return this.enterPresentingMatch();
    this.roundDriver.begin();
    return [];
  }
```

Y `advance` pasa a delegar en la ronda:

```ts
  advance(actorId: PlayerId, action: RoundAction): TransitionResult {
    if (this.match.phase !== "PLAYING") return { events: [], finished: false };
    // Un abandono se resuelve a esta altura; todo lo demás es de la ronda.
    if (this.referee.outcome()) {
      return { events: this.enterPresentingMatch(), finished: false };
    }
    return this.roundDriver.advance(actorId, action);
  }
```

Con `import type { RoundDriver } from "../round/driver.js";` y `roundActivePlayers` de
`state-projections.js` arriba, y el `Player` facade en el constructor —el conductor de PARTIDA
necesita retirar al que dejó vencer el turno, y al que no levantó sus fichas—:

```ts
    private readonly players: Player,
```

El `Player` se construye antes que el `MatchDriver` en el wiring, así que el orden de dependencias
sigue siendo acíclico: facades → conductores, nunca al revés.

- [ ] **Step 6: Escribir los tres comandos y ampliar las facades**

```ts
// src/features/match/core/commands/play-tile.ts
import type { Command, CommandPayload } from "../command.js";
import type { MatchEvent } from "../events.js";
import type { MatchDriver } from "../engine/match/driver.js";
import type { Player } from "../engine/player-facade.js";
import type { Referee } from "../engine/referee-facade.js";

export class PlayTileCommand implements Command<"PLAY_TILE", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: MatchDriver,
  ) {}

  execute({ playerId, left, right, side }: CommandPayload<"PLAY_TILE">): readonly MatchEvent[] {
    const tile = { left, right };
    this.referee.assertCanPlay(playerId, tile, side);
    this.players.playTile(playerId, tile, side);
    return this.matchDriver.advance(playerId, "PLAYED").events;
  }
}
```

```ts
// src/features/match/core/commands/draw-tile.ts
import type { Command, CommandPayload } from "../command.js";
import type { MatchEvent } from "../events.js";
import type { MatchDriver } from "../engine/match/driver.js";
import type { Player } from "../engine/player-facade.js";
import type { Referee } from "../engine/referee-facade.js";

export class DrawTileCommand implements Command<"DRAW_TILE", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: MatchDriver,
  ) {}

  // Robar NO pasa el turno —el jugador roba hasta poder jugar— pero SÍ reinicia el
  // plazo (reglas §7 decisión 4). Por eso pasa por el conductor: el reloj lo tocan
  // las transiciones, nunca un comando por su cuenta.
  execute({ playerId }: CommandPayload<"DRAW_TILE">): readonly MatchEvent[] {
    this.referee.assertCanDraw(playerId);
    this.players.drawTile(playerId);
    return this.matchDriver.advance(playerId, "DREW").events;
  }
}
```

```ts
// src/features/match/core/commands/pass.ts
import type { Command, CommandPayload } from "../command.js";
import type { MatchEvent } from "../events.js";
import type { MatchDriver } from "../engine/match/driver.js";
import type { Referee } from "../engine/referee-facade.js";

export class PassCommand implements Command<"PASS", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly matchDriver: MatchDriver,
  ) {}

  // Pasar no muta nada del jugador: solo cede el turno. Por eso no toca el Player.
  execute({ playerId }: CommandPayload<"PASS">): readonly MatchEvent[] {
    this.referee.assertCanPass(playerId);
    return this.matchDriver.advance(playerId, "PASSED").events;
  }
}
```

```ts
// src/features/match/core/commands/index.ts
export * from "./abandon.js";
export * from "./draw-tile.js";
export * from "./pass.js";
export * from "./play-tile.js";
export * from "./reveal-tiles.js";
```

```ts
// src/features/match/core/commands/reveal-tiles.ts
import type { Command, CommandPayload } from "../command.js";
import type { MatchEvent } from "../events.js";
import type { MatchDriver } from "../engine/match/driver.js";
import type { Player } from "../engine/player-facade.js";
import type { Referee } from "../engine/referee-facade.js";

// LEVANTAR LAS FICHAS (reglas §3.1). El verbo con el que se sale de la ventana de
// reparto, y el más delgado de todos: juez valida, player revela, conductor reconcilia.
//
// La reconciliación es la parte que importa: `advance` con `"REVEALED"` es lo que hace
// que la mano arranque cuando ya no falta nadie. Sin pasar por el conductor, el último
// en levantar sus fichas quedaría esperando para siempre.
export class RevealTilesCommand implements Command<"REVEAL_TILES", MatchEvent> {
  constructor(
    private readonly referee: Referee,
    private readonly players: Player,
    private readonly matchDriver: MatchDriver,
  ) {}

  execute({ playerId }: CommandPayload<"REVEAL_TILES">): readonly MatchEvent[] {
    this.referee.assertCanRevealTiles(playerId);
    this.players.revealTiles(playerId);
    return this.matchDriver.advance(playerId, "REVEALED").events;
  }
}
```

Ampliar `player-facade.ts`:

```ts
import type { BoardSide, TileLike } from "../state/tile.js";

  playTile(playerId: PlayerId, tile: TileLike, side: BoardSide): void {
    this.repository.round(playerId).playTile(tile, side);
  }

  drawTile(playerId: PlayerId): void {
    this.repository.round(playerId).drawTile();
  }

  revealTiles(playerId: PlayerId): void {
    this.repository.round(playerId).revealTiles();
  }
```

Ampliar `referee-facade.ts`. Las cuatro abren con la guarda de partida; `assertCanRevealTiles`
también, y por una razón que conviene no adivinar: durante el reparto la **PARTIDA** sí está en
`PLAYING` —lo que espera es la **RONDA**—.

```ts
  assertCanPlay(playerId: PlayerId, tile: TileLike, side: BoardSide): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanPlay(playerId, tile, side);
  }

  assertCanDraw(playerId: PlayerId): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanDraw(playerId);
  }

  assertCanPass(playerId: PlayerId): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanPass(playerId);
  }

  assertCanRevealTiles(playerId: PlayerId): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanRevealTiles(playerId);
  }
```

Ampliar `player-repository.ts` para sostener los dos players por asiento:

```ts
export class PlayerRepository {
  private readonly matchPlayers = new Map<PlayerId, MatchPlayer>();
  private readonly roundPlayers = new Map<PlayerId, RoundPlayer>();

  constructor(
    seats: readonly PlayerId[],
    matchFactory: (playerId: PlayerId) => MatchPlayer,
    roundFactory: (playerId: PlayerId) => RoundPlayer,
  ) {
    for (const playerId of seats) {
      this.matchPlayers.set(playerId, matchFactory(playerId));
      this.roundPlayers.set(playerId, roundFactory(playerId));
    }
  }

  get(playerId: PlayerId): MatchPlayer {
    const player = this.matchPlayers.get(playerId);
    if (!player) throw new InvariantViolationError(`sin MatchPlayer para ${playerId}`);
    return player;
  }

  round(playerId: PlayerId): RoundPlayer {
    const player = this.roundPlayers.get(playerId);
    if (!player) throw new InvariantViolationError(`sin RoundPlayer para ${playerId}`);
    return player;
  }
}
```

Ampliar `referee-facade.ts`:

```ts
  constructor(
    private readonly matchReferee: MatchReferee,
    private readonly roundReferee: RoundReferee,
  ) {}

  assertCanPlay(playerId: PlayerId, tile: TileLike, side: BoardSide): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanPlay(playerId, tile, side);
  }

  assertCanDraw(playerId: PlayerId): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanDraw(playerId);
  }

  assertCanPass(playerId: PlayerId): void {
    this.matchReferee.assertIsPlaying(playerId);
    this.roundReferee.assertCanPass(playerId);
  }
```

`assertIsPlaying` va repetido delante de cada uno y **no** envuelto en un genérico, a propósito: así
se ve de un vistazo cuáles la tienen y es grepeable.

- [ ] **Step 7: Cerrar el wire y el wiring**

En `payloads.ts`:

```ts
export const COMMAND_PAYLOADS = {
  ABANDON: z.object({}).strict(),
  PLAY_TILE: z
    .object({
      left: z.number().int().min(0).max(6),
      right: z.number().int().min(0).max(6),
      side: z.enum(["LEFT", "RIGHT"]),
    })
    .strict(),
  DRAW_TILE: z.object({}).strict(),
  PASS: z.object({}).strict(),
  REVEAL_TILES: z.object({}).strict(),
} satisfies Record<CommandName, z.ZodType>;
```

En `di-wiring.ts`, dentro de `registerIndividualCommands`, reemplazar el bloque de construcción:

```ts
  const visibility = child.resolve<SchemaVisibilityController>("SchemaVisibilityController");
  const matchReferee = new MatchReferee(match);
  const roundReferee = new RoundReferee(match);
  const scorer = new Scorer(match);
  // El `Dealer` NO recibe el puerto de visibilidad: desde la ventana de reparto no
  // revela nada, así que la invariante "repartir no filtra" es estructural y no un test.
  // Quien revela es el `RoundPlayer`, que es el actor del verbo.
  const dealer = new Dealer(match, config, globalConfig);
  const repository = new PlayerRepository(
    config.seats,
    (playerId) => new MatchPlayer(playerId, match),
    (playerId) => new RoundPlayer(playerId, match, visibility),
  );
  const roundDriver = new RoundDriver(
    match, clock, scheduler, globalConfig, config, roundReferee, dealer, scorer,
    (playerId) => repository.round(playerId),
  );
  const matchDriver = new MatchDriver(match, clock, scheduler, globalConfig, matchReferee, roundDriver);
  const players = new Player(repository);
  const referee = new Referee(matchReferee, roundReferee);

  child.register("Referee", { useValue: referee });
  child.register("MatchStarter", { useValue: (() => matchDriver.begin()) satisfies MatchStarter });
  child.register("MatchSeatGuard", { /* igual que antes */ });
  child.register("Command:ABANDON", { useValue: new AbandonCommand(referee, players, matchDriver) });
  child.register("Command:PLAY_TILE", { useValue: new PlayTileCommand(referee, players, matchDriver) });
  child.register("Command:DRAW_TILE", { useValue: new DrawTileCommand(referee, players, matchDriver) });
  child.register("Command:PASS", { useValue: new PassCommand(referee, matchDriver) });
  child.register("Command:REVEAL_TILES", {
    useValue: new RevealTilesCommand(referee, players, matchDriver),
  });
```

Y `buildCatalog`:

```ts
export function buildCatalog(child: DependencyContainer): CommandCatalog {
  return new CommandCatalog(
    {
      ABANDON: identityDecoder("ABANDON"),
      PLAY_TILE: identityDecoder("PLAY_TILE"),
      DRAW_TILE: identityDecoder("DRAW_TILE"),
      PASS: identityDecoder("PASS"),
    },
    {
      ABANDON: child.resolve("Command:ABANDON"),
      PLAY_TILE: child.resolve("Command:PLAY_TILE"),
      DRAW_TILE: child.resolve("Command:DRAW_TILE"),
      PASS: child.resolve("Command:PASS"),
    },
  );
}
```

Run: `npm run typecheck`
Expected: PASA. Los tres errores del Step 1 están cerrados.

- [ ] **Step 8: Cerrar el fixture con `engineWithHands`**

Reemplazar en `build-engine.ts` la función `buildEngine` por una que cablee todo el grafo, con el
`FixedDealer` como seam:

```ts
class FixedDealer extends Dealer {
  constructor(
    match: MatchState,
    config: DominoMatchConfig,
    globalConfig: GlobalDominoConfig,
    visibility: SchemaVisibilityController,
    private readonly deck: readonly { left: number; right: number }[],
  ) {
    super(match, config, globalConfig, visibility);
  }

  protected override orderedTiles(): Tile[] {
    return this.deck.map(({ left, right }) => {
      const tile = new Tile();
      tile.left = left;
      tile.right = right;
      return tile;
    });
  }
}

// Las manos tienen que declararse TODAS del mismo largo: el Dealer reparte de a
// `tilesPerPlayer` desde el frente del mazo, así que un largo distinto por asiento
// desalinearía el reparto.
export function engineWithHands(
  handsBySeat: Record<string, [number, number][]>,
  boneyard: [number, number][] = [],
) {
  const seats = Object.keys(handsBySeat);
  const lengths = new Set(Object.values(handsBySeat).map((tiles) => tiles.length));
  if (lengths.size !== 1) throw new Error("todas las manos tienen que tener el mismo largo");
  const tilesPerPlayer = [...lengths][0] as number;

  const deck = [
    ...seats.flatMap((seat) =>
      (handsBySeat[seat] ?? []).map(([left, right]) => ({ left, right })),
    ),
    ...boneyard.map(([left, right]) => ({ left, right })),
  ];

  const globalConfig: GlobalDominoConfig = {
    ...DEFAULT_GLOBAL_CONFIG,
    tilesPerPlayer,
    turnTimeoutMs: 600,
    presentingRoundMs: 120,
    presentingMatchMs: 120,
  };
  const config: DominoMatchConfig = {
    matchId: "m-test", gameModeId: "test", seed: "seed-test", seats, pointsToWin: 100, teamAssignment: "SHUFFLED", isDealWindowEnabled: false,
  };
  const match = createMatchState(config);

  const clockBox = { now: 1_000 };
  const clock: Clock = { now: () => clockBox.now };
  const scheduled: number[] = [];
  let pending: (() => readonly MatchEvent[]) | undefined;
  const scheduler: TimeoutScheduler = {
    schedule(at, onExpire) { scheduled.push(at); pending = onExpire; },
    cancel() { pending = undefined; },
  };
  const visibility: SchemaVisibilityController = { makePublic() {}, hide() {} };

  const matchReferee = new MatchReferee(match);
  const roundReferee = new RoundReferee(match);
  const scorer = new Scorer(match);
  const dealer = new FixedDealer(match, config, globalConfig, visibility, deck);
  const repository = new PlayerRepository(
    seats,
    (playerId) => new MatchPlayer(playerId, match),
    (playerId) => new RoundPlayer(playerId, match),
  );
  const roundDriver = new RoundDriver(
    match, clock, scheduler, globalConfig, roundReferee, dealer, scorer,
    (playerId) => repository.round(playerId),
  );
  const matchDriver = new MatchDriver(match, clock, scheduler, globalConfig, matchReferee, roundDriver);
  const players = new Player(repository);
  const referee = new Referee(matchReferee, roundReferee);

  const commands = {
    ABANDON: new AbandonCommand(referee, players, matchDriver),
    PLAY_TILE: new PlayTileCommand(referee, players, matchDriver),
    DRAW_TILE: new DrawTileCommand(referee, players, matchDriver),
    PASS: new PassCommand(referee, matchDriver),
  };

  return {
    match, clockBox, scheduled,
    start: () => matchDriver.begin(),
    round: () => currentRoundOf(match),
    hand: (playerId: string) => handOf(playerId, match),
    playTile: (playerId: string, tile: { left: number; right: number }, side: BoardSide) =>
      commands.PLAY_TILE.execute({ playerId, ...tile, side }),
    drawTile: (playerId: string) => commands.DRAW_TILE.execute({ playerId }),
    pass: (playerId: string) => commands.PASS.execute({ playerId }),
    abandon: (playerId: string) => commands.ABANDON.execute({ playerId }),
    fireTimeout(): readonly MatchEvent[] {
      if (!pending) throw new Error("no hay timeout programado");
      const run = pending;
      pending = undefined;
      return run();
    },
  };
}
```

Borrar la vieja `buildEngine` y ajustar `abandon.test.ts` para usar `engineWithHands` con manos de
una ficha:

```ts
// en abandon.test.ts, reemplazar el helper `engine()`
function engine() {
  const e = engineWithHands({ u1: [[6, 6]], u2: [[5, 5]] });
  return { ...e, command: { execute: (p: { playerId: string }) => e.abandon(p.playerId) } };
}
```

- [ ] **Step 9: Escribir el test del flujo de la ronda**

```ts
// src/features/match/core/engine/tests/round-flow.test.ts
import { describe, expect, it } from "vitest";
import { engineWithHands } from "./build-engine.js";

describe("flujo de la ronda", () => {
  it("reparte, elige quién arranca y entra en PLAYING", () => {
    const e = engineWithHands({ u1: [[6, 6], [5, 4]], u2: [[3, 2], [1, 0]] });
    e.start();

    expect(e.round().phase).toBe("PLAYING");
    expect(e.round().currentTurn.playerId).toBe("u1"); // tiene el doble seis
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 600);
  });

  it("jugar pasa el turno y re-arma el plazo", () => {
    const e = engineWithHands({ u1: [[6, 6], [5, 4]], u2: [[6, 3], [1, 0]] });
    e.start();
    e.clockBox.now += 100;
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");

    expect(e.round().currentTurn.playerId).toBe("u2");
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 600);
  });

  // Reglas §7 decisión 4: robar conserva el turno y REINICIA el plazo. El v1 solo lo
  // reiniciaba al robar una ficha inservible, lo que premiaba robar mal.
  it("robar NO pasa el turno pero SÍ reinicia el plazo", () => {
    const e = engineWithHands({ u1: [[6, 6], [5, 4]], u2: [[3, 2], [1, 0]] }, [[6, 1]]);
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    const before = e.match.activeDeadline;

    e.clockBox.now += 400;
    e.drawTile("u2"); // no engancha con nada, y hay pozo

    expect(e.round().currentTurn.playerId).toBe("u2");
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 600);
    expect(e.match.activeDeadline).not.toBe(before);
    expect(e.hand("u2").tileCount).toBe(3);
  });

  it("robar no emite evento: el comando ya es el registro", () => {
    const e = engineWithHands({ u1: [[6, 6], [5, 4]], u2: [[3, 2], [1, 0]] }, [[6, 1]]);
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    expect(e.drawTile("u2")).toEqual([]);
  });

  it("jugar la última ficha cierra por dominó y abre la pausa", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 3]] });
    e.start();
    const events = e.playTile("u1", { left: 6, right: 6 }, "RIGHT");

    expect(e.round().phase).toBe("PRESENTING_ROUND");
    expect(events).toEqual([
      { type: "ROUND_RESOLVED", roundNumber: 1, winnerId: "u1", winnerTeamId: "A", points: 9, reason: "DOMINO" },
    ]);
    expect(e.match.scoreboard.teamA).toBe(9);
  });

  // ACÁ MUERE EL sleep(6000): la pausa es una fase con plazo, no una espera.
  it("la pausa de la mano es una fase con plazo, y al vencer arranca la ronda 2", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 3]] });
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 120);

    e.fireTimeout();

    expect(e.round().roundNumber).toBe(2);
    expect(e.round().phase).toBe("PLAYING");
    expect(e.match.pastRounds.length).toBe(1);
  });

  // Reglas §5.2 decisión 1: al vencer el plazo se RETIRA al jugador. El motor no
  // juega por él. En 2P eso deja un solo jugador y la partida cae por forfeit.
  it("al vencer el turno se retira al jugador y se EMITE el ABANDON", () => {
    const e = engineWithHands({ u1: [[6, 6], [5, 4]], u2: [[6, 3], [1, 0]] });
    e.start();
    const events = e.fireTimeout();

    expect(events[0]).toEqual({ type: "DEADLINE_EXPIRED", kind: "TURN" });
    expect(events[1]).toEqual({ type: "ABANDON", playerId: "u1" });
    expect(e.match.players.find((p) => p.playerId === "u1")?.hasAbandoned).toBe(true);
  });

  // El ABANDON del EVENTO existe porque no hubo comando detrás. El voluntario no
  // emite nada: el comando ya es el registro del acto. Es la misma regla leída de
  // los dos lados, y para soporte es la diferencia entre "se fue" y "lo sacaron".
  it("el ABANDON voluntario no emite evento; el del timeout sí", () => {
    const voluntary = engineWithHands({ u1: [[6, 6], [5, 4]], u2: [[6, 3], [1, 0]] });
    voluntary.start();
    expect(voluntary.abandon("u1")).toEqual([]);

    const forced = engineWithHands({ u1: [[6, 6], [5, 4]], u2: [[6, 3], [1, 0]] });
    forced.start();
    expect(forced.fireTimeout().map((event) => event.type)).toContain("ABANDON");
  });

  it("retirar al jugador en 2P resuelve la partida por forfeit", () => {
    const e = engineWithHands({ u1: [[6, 6], [5, 4]], u2: [[6, 3], [1, 0]] });
    e.start();
    e.fireTimeout(); // vence el turno de u1 → se lo retira

    expect(e.match.phase).toBe("PRESENTING_MATCH");

    const events = e.fireTimeout(); // vence la pausa de cierre
    expect(e.match.phase).toBe("FINISHED");
    expect(events).toEqual([
      { type: "DEADLINE_EXPIRED", kind: "PRESENTING_MATCH" },
      { type: "MATCH_RESOLVED", winnerTeamId: "B", reason: "ABANDONMENT" },
    ]);
  });

  it("cierra por tranca cuando nadie puede jugar y el pozo está vacío", () => {
    // 6|6 en la mesa; ninguno de los dos tiene un 6 después.
    const e = engineWithHands({ u1: [[6, 6], [5, 5]], u2: [[3, 2], [1, 0]] });
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    e.pass("u2");
    const events = e.pass("u1");

    expect(e.round().phase).toBe("PRESENTING_ROUND");
    expect(events).toEqual([
      // u2 tiene 3+2+1+0 = 6; u1 tiene 5+5 = 10. Gana u2 y cobra 10.
      { type: "ROUND_RESOLVED", roundNumber: 1, winnerId: "u2", winnerTeamId: "B", points: 10, reason: "BLOCKED" },
    ]);
  });

  it("alcanzar pointsToWin cierra la partida en vez de abrir otra ronda", () => {
    const e = engineWithHands({ u1: [[6, 6]], u2: [[6, 3]] });
    e.match.pointsToWin = 9; // exactamente lo que cobra el dominó de abajo
    e.start();
    e.playTile("u1", { left: 6, right: 6 }, "RIGHT");
    e.fireTimeout(); // vence la pausa de la mano

    expect(e.match.phase).toBe("PRESENTING_MATCH");

    const events = e.fireTimeout(); // vence la pausa de la partida
    expect(e.match.phase).toBe("FINISHED");
    expect(events).toEqual([
      { type: "DEADLINE_EXPIRED", kind: "PRESENTING_MATCH" },
      { type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" },
    ]);
  });
});
```

- [ ] **Step 10: Correr toda la suite hasta que pase**

Run: `npm test`
Expected: TODO pasa, incluidos los 10 tests nuevos de `round-flow` y los de `abandon` adaptados.

- [ ] **Step 11: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src
git commit -m "feat(round): conductor de la ronda, Scorer y los tres verbos de juego

Acá mueren los sleep() del v1: la pausa de presentación es una FASE con plazo
(PRESENTING_ROUND), no una espera dentro de la mutación del estado. El motor
estampa el instante y devuelve, así que no hay ventana en la que otro mensaje
corra sobre estado a medio mutar.

Al vencer el turno el sistema ejecuta el verbo del que calló —juega la legal de
mayor valor, o roba, o pasa— por el mismo camino que el hablado, y lo EMITE
porque no hubo comando que lo registre. La elección es determinista, así que el
replay reproduce la misma jugada.

Robar no pasa el turno ni toca el plazo: el jugador roba hasta poder jugar, y por
eso ese comando no llama a advance().

El Scorer es el único que escribe el marcador y el único que archiva una ronda.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 20: El smoke de visibilidad y la partida completa E2E

El primer test de esta tarea es **el que habría atrapado el agujero del v1**. Contra el v1 falla;
contra el v2 tiene que pasar.

**Files:**
- Create: `src/features/match/tests/visibility.smoke.test.ts`, `src/features/match/tests/game-2p-e2e.test.ts`

- [ ] **Step 1: Escribir el smoke de visibilidad**

```ts
// src/features/match/tests/visibility.smoke.test.ts
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state/index.js";
import { bootServer, seatPair, waitUntil } from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2586);
});

afterAll(async () => {
  await server.shutdown();
});

// Lee el estado TAL COMO LO RECIBIÓ el cliente, ya filtrado por su StateView.
const clientState = (match: Awaited<ReturnType<typeof seatPair>>, userId: string) =>
  match.clients[userId]?.state as MatchState;

const handTilesSeenBy = (match: Awaited<ReturnType<typeof seatPair>>, viewer: string, owner: string) =>
  [...(clientState(match, viewer).players.find((p) => p.playerId === owner)?.hand.tiles ?? [])];

describe("visibilidad — el rival no ve fichas ajenas", () => {
  it("cada jugador ve SU mano completa", async () => {
    const match = await seatPair(server, ["v1", "v2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");
    await waitUntil(() => handTilesSeenBy(match, "v1", "v1").length === 7);

    expect(handTilesSeenBy(match, "v1", "v1")).toHaveLength(7);
    expect(handTilesSeenBy(match, "v2", "v2")).toHaveLength(7);
  });

  // EL AGUJERO DEL V1. Allí `players` era un MapSchema completo con las fichas
  // reales, así que cualquier cliente leía la mano exacta de su rival en cada patch.
  it("NINGÚN jugador ve las fichas del rival", async () => {
    const match = await seatPair(server, ["w1", "w2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");
    await waitUntil(() => handTilesSeenBy(match, "w1", "w1").length === 7);

    expect(handTilesSeenBy(match, "w1", "w2")).toHaveLength(0);
    expect(handTilesSeenBy(match, "w2", "w1")).toHaveLength(0);
  });

  it("pero SÍ ve cuántas le quedan: tileCount es público", async () => {
    const match = await seatPair(server, ["x1", "x2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");
    await waitUntil(() => handTilesSeenBy(match, "x1", "x1").length === 7);

    const rival = clientState(match, "x1").players.find((p) => p.playerId === "x2");
    expect(rival?.tileCount ?? rival?.hand.tileCount).toBe(7);
  });

  it("NADIE ve el pozo", async () => {
    const match = await seatPair(server, ["y1", "y2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");
    await waitUntil(() => handTilesSeenBy(match, "y1", "y1").length === 7);

    for (const viewer of ["y1", "y2"]) {
      expect([...(clientState(match, viewer).currentRound?.boneyard?.tiles ?? [])]).toHaveLength(0);
      // El conteo sí, que es lo que el front muestra.
      expect(clientState(match, viewer).currentRound?.boneyard?.count).toBe(14);
    }
  });

  it("una ficha jugada pasa a ser pública para los dos", async () => {
    const match = await seatPair(server, ["z1", "z2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");
    await waitUntil(() => handTilesSeenBy(match, "z1", "z1").length === 7);

    const turnHolder = match.serverState.currentRound?.currentTurn.playerId as string;
    const own = handTilesSeenBy(match, turnHolder, turnHolder);
    const chosen = own[0];
    if (!chosen) throw new Error("mano vacía");

    match.clients[turnHolder]?.send("PLAY_TILE", {
      left: chosen.left,
      right: chosen.right,
      side: "RIGHT",
    });

    await waitUntil(() => match.serverState.currentRound?.board.tiles.length === 1);
    for (const viewer of ["z1", "z2"]) {
      await waitUntil(() => clientState(match, viewer).currentRound?.board.tiles.length === 1);
      expect(clientState(match, viewer).currentRound?.board.tiles.at(0)?.tile.toJSON()).toEqual({
        left: chosen.left,
        right: chosen.right,
      });
    }
  });

  // Es el bug de la vista del socket. Si la audiencia se resolviera sobre
  // room.clients, lo revelado mientras el jugador está fuera no llegaría nunca a su
  // vista y volvería CIEGO — sin su propia mano de la ronda nueva.
  it("lo revelado mientras estaba fuera le espera al volver", async () => {
    const match = await seatPair(server, ["r1", "r2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");
    await waitUntil(() => handTilesSeenBy(match, "r1", "r1").length === 7);

    await match.clients.r1?.leave(false);
    await waitUntil(() => match.serverState.players.find((p) => p.playerId === "r1")?.connected === false);

    const { rejoinAs } = await import("./e2e-harness.js");
    const back = await rejoinAs(server, match.roomId, "r1");
    await waitUntil(() => back.state !== undefined && (back.state as MatchState).players.length === 2);

    const ownAfter = [...((back.state as MatchState).players.find((p) => p.playerId === "r1")?.hand.tiles ?? [])];
    expect(ownAfter).toHaveLength(7);
    // Y sigue sin ver la del rival.
    const rivalAfter = [...((back.state as MatchState).players.find((p) => p.playerId === "r2")?.hand.tiles ?? [])];
    expect(rivalAfter).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Añadir `rejoinAs` al arnés**

```ts
// añadir a src/features/match/tests/e2e-harness.ts
// El camino del que perdió su token: vuelve por roomId. Es lo que verifica que el
// unlock() de onDrop funciona — sin él, el matchmaker rechaza este join porque la
// sala cuenta el asiento reservado.
export async function rejoinAs(server: ColyseusTestServer, roomId: string, userId: string) {
  server.sdk.auth.token = mintToken(userId);
  return server.sdk.joinById(roomId);
}
```

- [ ] **Step 3: Correr el smoke hasta que pase**

Run: `npx vitest run src/features/match/tests/visibility.smoke.test.ts`
Expected: los 6 tests PASAN.

Si el test de `tileCount` falla, es porque `Hand` es un sub-nodo y el campo público vive en
`player.hand.tileCount` y no en `player.tileCount`: ajustar la aserción a la estructura real y quitar
el `??`.

- [ ] **Step 4: Escribir el E2E de partida completa**

```ts
// src/features/match/tests/game-2p-e2e.test.ts
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state/index.js";
import { boardEndsOf } from "../core/engine/round/board-ends.js";
import { playableSides } from "../core/engine/round/playable.js";
import { boneyardCountOf } from "../core/engine/state-projections.js";
import { bootServer, historyOf, seatPair, waitUntil } from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2587);
});

afterAll(async () => {
  await server.shutdown();
});

// Juega una jugada legal del que tiene el turno, o roba, o pasa. Devuelve false
// cuando la ronda dejó de estar en PLAYING.
async function playOneTurn(match: Awaited<ReturnType<typeof seatPair>>): Promise<boolean> {
  const state = match.serverState;
  const round = state.currentRound;
  if (!round || round.phase !== "PLAYING") return false;

  const playerId = round.currentTurn.playerId;
  const hand = state.players.find((p) => p.playerId === playerId)?.hand;
  if (!hand) return false;

  const ends = boardEndsOf(round.board);
  const candidate = [...hand.tiles]
    .map((tile) => ({ tile, sides: playableSides(tile, ends) }))
    .find((entry) => entry.sides.length > 0);

  const before = round.board.tiles.length + hand.tiles.length + boneyardCountOf(round);
  if (candidate) {
    match.clients[playerId]?.send("PLAY_TILE", {
      left: candidate.tile.left,
      right: candidate.tile.right,
      side: candidate.sides[0],
    });
  } else if (boneyardCountOf(round) > 0) {
    match.clients[playerId]?.send("DRAW_TILE", {});
  } else {
    match.clients[playerId]?.send("PASS", {});
  }

  // Espera a que el servidor procesó algo: cualquiera de los tres verbos mueve al
  // menos uno de los tres conteos, o cambia de fase.
  await waitUntil(() => {
    const now = match.serverState.currentRound;
    if (!now || now.phase !== "PLAYING") return true;
    const nowHand = match.serverState.players.find((p) => p.playerId === playerId)?.hand;
    return now.board.tiles.length + (nowHand?.tiles.length ?? 0) + now.boneyard.count !== before
      || now.currentTurn.playerId !== playerId;
  });
  return true;
}

describe("partida 2P completa", () => {
  it("se juega de punta a punta hasta que hay veredicto", async () => {
    const match = await seatPair(server, ["g1", "g2"], "seed-partida-completa");
    await waitUntil(() => match.serverState.phase === "PLAYING");

    // Tope de seguridad: una partida a 100 puntos no debería pasar de esto, y si
    // lo pasa es un bucle y hay que verlo como fallo, no como cuelgue.
    for (let turns = 0; turns < 3_000; turns += 1) {
      if (match.serverState.phase === "FINISHED") break;
      const played = await playOneTurn(match);
      if (!played) {
        // Fuera de PLAYING: o es la pausa de la mano, o la de la partida. Los dos
        // plazos son cortos en test, así que se espera a que el reloj los venza.
        await waitUntil(
          () =>
            match.serverState.currentRound?.phase === "PLAYING" ||
            match.serverState.phase === "FINISHED",
          3_000,
        );
      }
    }

    expect(match.serverState.phase).toBe("FINISHED");
    const { teamA, teamB } = match.serverState.scoreboard;
    expect(Math.max(teamA, teamB)).toBeGreaterThanOrEqual(match.serverState.pointsToWin);
    expect(match.serverState.pastRounds.length).toBeGreaterThan(0);
  });

  it("el historial de esa partida cierra con MATCH_RESOLVED y sin huecos de seq", async () => {
    const entries = historyOf("m-g1-g2");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.map((entry) => entry.seq)).toEqual(
      entries.map((_, index) => index + 1),
    );
    expect(entries.at(-1)?.type).toBe("MATCH_RESOLVED");
  });

  it("cada DEADLINE_EXPIRED tiene detrás el verbo que el sistema ejecutó", async () => {
    const entries = historyOf("m-g1-g2");
    entries.forEach((entry, index) => {
      if (entry.type !== "DEADLINE_EXPIRED") return;
      const next = entries[index + 1];
      expect(next).toBeDefined();
      expect(next?.source).toBe("SYSTEM");
    });
  });

  it("ningún comando quedó registrado con source SYSTEM ni al revés", async () => {
    for (const entry of historyOf("m-g1-g2")) {
      if (entry.kind === "COMMAND") expect(entry.source).toBe("PLAYER");
      if (entry.kind === "EVENT") expect(entry.source).toBe("SYSTEM");
    }
  });
});
```

- [ ] **Step 5: Correr el E2E hasta que pase**

Run: `npx vitest run src/features/match/tests/game-2p-e2e.test.ts`
Expected: los 4 tests PASAN.

Si el bucle se agota sin llegar a `FINISHED`, casi siempre es una de dos: la pausa de la mano no
re-arranca la ronda siguiente (revisar `MatchDriver.afterRound`), o `nextPlayerAfter` devuelve
siempre el mismo asiento (revisar `turnOrderFrom`).

- [ ] **Step 6: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src
git commit -m "test: smoke de visibilidad y partida 2P completa de punta a punta

El smoke es el test que habría atrapado el agujero del v1: afirma sobre el estado
TAL COMO LO RECIBIÓ el cliente, ya filtrado por su StateView, que ningún jugador
ve las fichas del rival ni el pozo, que sí ve el conteo, y que lo revelado
mientras estaba fuera le espera al volver.

El E2E juega una partida entera contra el wiring de producción y afirma sobre el
historial: seq sin huecos, cierra con MATCH_RESOLVED, cada DEADLINE_EXPIRED tiene
detrás el verbo del sistema, y ningún comando quedó marcado como SYSTEM.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 21: El replay — auditoría reproducible

Cierra el requerimiento de auditar partidas. El mismo runner sirve dos propósitos: la herramienta de
soporte y el test de regresión más fuerte del motor.

**Files:**
- Create: `src/features/match/history/replay.ts`, `src/features/match/history/engine-factory.ts`, `src/replay.ts`, `src/features/match/tests/replay.test.ts`, `src/features/match/tests/fixtures/golden-2p.json`
- Modify: `package.json` (script `replay`), `src/features/match/transports/http/register-http.ts`

- [ ] **Step 1: Extraer la construcción del engine a una fábrica reusable**

El replay necesita el mismo grafo de actores que la sala, pero **sin** Colyseus ni container. Sacarlo
a una función pura que las dos usen elimina la duplicación —que es exactamente el bug que truco
documenta: la génesis vivía en la room *y duplicada* en un fixture de tests, con dos implementaciones
de una regla obligadas a coincidir.

```ts
// src/features/match/history/engine-factory.ts
import type { DominoMatchConfig, GlobalDominoConfig } from "../core/config.js";
import type { Command, CommandName } from "../core/command.js";
import { AbandonCommand, DrawTileCommand, PassCommand, PlayTileCommand } from "../core/commands/index.js";
import type { Clock } from "../core/engine/clock.js";
import { Dealer } from "../core/engine/dealer.js";
import { createMatchState } from "../core/engine/genesis.js";
import { MatchDriver } from "../core/engine/match/driver.js";
import { MatchPlayer } from "../core/engine/match/player.js";
import { MatchReferee } from "../core/engine/match/referee.js";
import { Player } from "../core/engine/player-facade.js";
import { PlayerRepository } from "../core/engine/player-repository.js";
import { Referee } from "../core/engine/referee-facade.js";
import { RoundDriver } from "../core/engine/round/driver.js";
import { RoundPlayer } from "../core/engine/round/player.js";
import { RoundReferee } from "../core/engine/round/referee.js";
import { Scorer } from "../core/engine/scorer.js";
import type { TimeoutScheduler } from "../core/engine/timeout-scheduler.js";
import type { SchemaVisibilityController } from "../core/engine/visibility.js";
import type { MatchEvent } from "../core/events.js";
import type { MatchState } from "../core/state/index.js";

export interface EngineGraph {
  readonly match: MatchState;
  readonly matchDriver: MatchDriver;
  readonly commands: { readonly [N in CommandName]: Command<N, MatchEvent> };
}

export interface EngineDeps {
  readonly clock: Clock;
  readonly scheduler: TimeoutScheduler;
  readonly visibility: SchemaVisibilityController;
  readonly dealer?: Dealer;
}

// EN ORDEN DE DEPENDENCIA: jueces, servicios, conductores, players, facades, comandos.
// Es la única definición del grafo; la sala y el replay la comparten.
export function buildEngineGraph(
  config: DominoMatchConfig,
  globalConfig: GlobalDominoConfig,
  deps: EngineDeps,
): EngineGraph {
  const match = createMatchState(config);
  const matchReferee = new MatchReferee(match);
  const roundReferee = new RoundReferee(match);
  const scorer = new Scorer(match);
  const dealer = deps.dealer ?? new Dealer(match, config, globalConfig);
  const repository = new PlayerRepository(
    config.seats,
    (playerId) => new MatchPlayer(playerId, match),
    (playerId) => new RoundPlayer(playerId, match, deps.visibility),
  );
  const roundDriver = new RoundDriver(
    match, deps.clock, deps.scheduler, globalConfig, config, roundReferee, dealer, scorer,
    (playerId) => repository.round(playerId),
  );
  const matchDriver = new MatchDriver(
    match, deps.clock, deps.scheduler, globalConfig, matchReferee, roundDriver,
  );
  const players = new Player(repository);
  const referee = new Referee(matchReferee, roundReferee);

  return {
    match,
    matchDriver,
    commands: {
      ABANDON: new AbandonCommand(referee, players, matchDriver),
      PLAY_TILE: new PlayTileCommand(referee, players, matchDriver),
      DRAW_TILE: new DrawTileCommand(referee, players, matchDriver),
      PASS: new PassCommand(referee, matchDriver),
    },
  };
}
```

Y en `di-wiring.ts`, reemplazar el bloque de construcción por una llamada a `buildEngineGraph`,
registrando lo que la sala necesita alcanzar. Run `npm test` después: la suite entera tiene que seguir
pasando sin cambios.

- [ ] **Step 2: Escribir el test del replay**

```ts
// src/features/match/tests/replay.test.ts
import { describe, expect, it } from "vitest";
import type { HistoryEntry } from "../network/history.js";
import { replay } from "../history/replay.js";
import golden from "./fixtures/golden-2p.json" with { type: "json" };

const meta = {
  matchId: "m-replay",
  gameModeId: "clasica-2p",
  seed: "seed-replay",
  seats: ["u1", "u2"],
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  // TIENE QUE ESPEJAR PRODUCCIÓN, no la comodidad del test. Con `false`, el motor del
  // replay saltearía la ventana y arrancaría en `PLAYING`; los dos `REVEAL_TILES` que la
  // partida grabada tiene al principio caerían con `NOT_DEALING` y el replay no
  // reproduciría nada. El config del replay es parte del contrato, igual que el `seed`.
  isDealWindowEnabled: true,
};

describe("replay", () => {
  it("mismo seed reconstruye el mismo reparto sin reaplicar nada", () => {
    const a = replay({ meta, entries: [] });
    const b = replay({ meta, entries: [] });
    expect(a.toJSON()).toEqual(b.toJSON());
    expect(a.players.every((player) => player.hand.tiles.length === 7)).toBe(true);
  });

  it("reaplica un comando del historial", () => {
    const state = replay({ meta, entries: [] });
    const turnHolder = state.currentRound?.currentTurn.playerId as string;
    const tile = state.players.find((p) => p.playerId === turnHolder)?.hand.tiles.at(0);
    if (!tile) throw new Error("mano vacía");

    const entries: HistoryEntry[] = [
      {
        matchId: meta.matchId, seq: 1, at: 1_000, roundNumber: 1,
        source: "PLAYER", kind: "COMMAND", type: "PLAY_TILE",
        payload: { playerId: turnHolder, left: tile.left, right: tile.right, side: "RIGHT" },
      },
    ];
    const after = replay({ meta, entries });
    expect(after.currentRound?.board.tiles.length).toBe(1);
  });

  it("ignora los eventos que son consecuencia, porque se re-derivan", () => {
    const entries: HistoryEntry[] = [
      {
        matchId: meta.matchId, seq: 1, at: 1_000, roundNumber: 1,
        source: "SYSTEM", kind: "EVENT", type: "ROUND_RESOLVED",
        payload: { roundNumber: 1, winnerId: "u1", winnerTeamId: "A", points: 10, reason: "DOMINO" },
      },
    ];
    // No lanza y no acredita puntos: el evento no es una entrada del motor.
    expect(replay({ meta, entries }).scoreboard.teamA).toBe(0);
  });

  // EL TEST DE REGRESIÓN. Una partida real grabada; si el motor cambia de forma que
  // no la reproduzca, esto falla y nombra la regla que se movió.
  it("reproduce la partida golden hasta el estado final exacto", () => {
    const state = replay({ meta: golden.meta, entries: golden.entries as HistoryEntry[] });
    expect(state.toJSON()).toEqual(golden.finalState);
  });
});
```

- [ ] **Step 3: Escribir el replay**

```ts
// src/features/match/history/replay.ts
// Reconstruir una partida = mismo config (mismo seed) + mismo Dealer + los COMANDOS
// y los vencimientos reaplicados en orden de seq. Son las dos únicas entradas del
// motor; todo lo demás del historial es consecuencia y se re-deriva.
import { DEFAULT_GLOBAL_CONFIG, type DominoMatchConfig, type GlobalDominoConfig } from "../core/config.js";
import type { CommandName } from "../core/command.js";
import type { Clock } from "../core/engine/clock.js";
import type { TimeoutScheduler } from "../core/engine/timeout-scheduler.js";
import type { SchemaVisibilityController } from "../core/engine/visibility.js";
import type { MatchEvent } from "../core/events.js";
import type { MatchState } from "../core/state/index.js";
import type { HistoryEntry } from "../network/history.js";
import { buildEngineGraph } from "./engine-factory.js";

export interface ReplayInput {
  readonly meta: DominoMatchConfig;
  readonly entries: readonly HistoryEntry[];
  readonly globalConfig?: GlobalDominoConfig;
}

export function replay(input: ReplayInput): MatchState {
  // El reloj avanza con los timestamps del historial, así que los deadlines que se
  // estampan son los mismos que la partida real tuvo.
  const clockBox = { now: input.entries.at(0)?.at ?? 0 };
  const clock: Clock = { now: () => clockBox.now };

  // No hay timers: los vencimientos ya están EN el historial como DEADLINE_EXPIRED,
  // y se disparan a mano en el orden en que ocurrieron.
  let pending: (() => readonly MatchEvent[]) | undefined;
  const scheduler: TimeoutScheduler = {
    schedule(_at, onExpire) { pending = onExpire; },
    cancel() { pending = undefined; },
  };

  // Sin visibilidad: el replay reconstruye el ESTADO, no lo sincroniza a nadie.
  const visibility: SchemaVisibilityController = { makePublic() {}, hide() {} };

  const graph = buildEngineGraph(input.meta, input.globalConfig ?? DEFAULT_GLOBAL_CONFIG, {
    clock, scheduler, visibility,
  });
  graph.matchDriver.begin();

  for (const entry of [...input.entries].sort((a, b) => a.seq - b.seq)) {
    clockBox.now = entry.at;

    if (entry.kind === "COMMAND") {
      const name = entry.type as CommandName;
      const command = graph.commands[name];
      if (!command) throw new Error(`seq ${entry.seq}: verbo desconocido ${entry.type}`);
      // El payload se guardó ya decodificado, así que entra tal cual.
      (command as { execute(payload: unknown): unknown }).execute(entry.payload);
      continue;
    }

    // El único EVENTO que es entrada del motor: el reloj decidió. Todo lo demás
    // (ROUND_RESOLVED, MATCH_RESOLVED, los verbos del sistema) es consecuencia de
    // este, y se re-deriva al dispararlo.
    if (entry.type === "DEADLINE_EXPIRED") {
      if (!pending) throw new Error(`seq ${entry.seq}: vencimiento sin timer programado`);
      const run = pending;
      pending = undefined;
      run();
    }
  }

  return graph.match;
}
```

- [ ] **Step 4: Generar el golden desde una partida real**

El golden se captura **dentro** del test de la partida completa, que es el único lugar donde el estado
final y su historial están los dos en alcance. Añadir un helper al arnés:

```ts
// añadir a src/features/match/tests/e2e-harness.ts
import { mkdirSync, writeFileSync } from "node:fs";
import type { DominoMatchConfig } from "../core/config.js";

const GOLDEN_DIR = "src/features/match/tests/fixtures";

// Solo escribe si se pide con WRITE_GOLDEN=1. En una corrida normal es no-op, así
// que el fixture no se regenera por accidente y una regresión no se auto-aprueba.
export function writeGolden(
  name: string,
  meta: DominoMatchConfig,
  state: { toJSON(): unknown },
): void {
  if (process.env.WRITE_GOLDEN !== "1") return;
  mkdirSync(GOLDEN_DIR, { recursive: true });
  const payload = { meta, entries: historyOf(meta.matchId), finalState: state.toJSON() };
  writeFileSync(`${GOLDEN_DIR}/${name}.json`, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}
```

Y al final del `it("se juega de punta a punta…")` de `game-2p-e2e.test.ts`, después del último
`expect`:

```ts
    writeGolden(
      "golden-2p",
      {
        matchId: "m-g1-g2",
        gameModeId: "clasica-2p",
        seed: "seed-partida-completa",
        seats: ["g1", "g2"],
        pointsToWin: 100,
        teamAssignment: "SHUFFLED",
        isDealWindowEnabled: true,
      },
      match.serverState,
    );
```

Generarlo una sola vez:

```bash
WRITE_GOLDEN=1 npx vitest run src/features/match/tests/game-2p-e2e.test.ts
```

En PowerShell: `$env:WRITE_GOLDEN = "1"; npx vitest run src/features/match/tests/game-2p-e2e.test.ts; $env:WRITE_GOLDEN = $null`

Verificar a ojo antes de commitear: `entries` con decenas de entradas, un `MATCH_RESOLVED` seguido
por el `DEADLINE_EXPIRED` de la presentación (**en ese orden** — el veredicto sale al entrar a la
pausa, no al vencerla), y `finalState.phase === "FINISHED"`. **Ese archivo se commitea**: es el
contrato de regresión, y aprobarlo a ojo una vez es lo que le da valor.

- [ ] **Step 5: Escribir el CLI y el endpoint de soporte**

```ts
// src/replay.ts
// npm run replay -- <matchId>
// Rebobina la partida desde el historial y IMPRIME el estado final reconstruido. Es
// la herramienta de SOPORTE: no afirma nada, porque el historial no lleva un snapshot
// contra el que comparar —y no lo lleva a propósito, ver abajo—.
//
// El que AFIRMA es `replay.test.ts`, contra los fixtures golden: ahí el estado final
// esperado vive en el propio fixture (`finalState`), versionado en el repo y aprobado
// a ojo una vez. Ése es el test de regresión del motor.
//
// Por qué el snapshot no está en `match_history`: una entrada del historial es un ACTO
// o un HECHO, las dos cosas inmutables y de tamaño acotado. Un snapshot del árbol es
// otra clase de cosa —un volcado, grande, y solo interesante al cierre—, así que si
// alguna vez hace falta va en `match_meta` al cerrar la partida, no colgado de una
// entrada. Un campo opcional que nadie escribe es peor que no tenerlo: hace creer que
// el replay puede autoverificarse contra producción cuando no puede.
import { rootContainer } from "./di-container.js";
import { replay } from "./features/match/history/replay.js";
import type { HistoryEntry } from "./features/match/network/history.js";
import { MemoryHistory } from "./features/match/network/transports/memory-history.js";
import { logger } from "./logger.js";

const matchId = process.argv[2];
if (!matchId) {
  logger.error("uso: npm run replay -- <matchId>");
  process.exit(1);
}

// Con la implementación de memoria esto solo sirve dentro del mismo proceso; el
// adaptador de Mongo lo vuelve útil desde la consola.
const entries: readonly HistoryEntry[] = (
  rootContainer.resolve("HistoryPort") as MemoryHistory
).of(matchId);

if (entries.length === 0) {
  logger.error("no hay historial para esa partida", { matchId });
  process.exit(1);
}

// El meta sale de `match_meta` cuando exista la persistencia; hasta entonces va por
// argumentos, porque el `seed` NO está en el historial a propósito.
//
// Los tres son OBLIGATORIOS y no tienen default. El `pointsToWin` sobre todo: el
// veredicto de la partida depende de él —entrar en PRESENTING_MATCH es alcanzarlo—,
// así que un valor inventado no reproduce el final. Con 0, además, `teamA >= 0` es
// verdadero desde el arranque y la partida cerraría en la primera comprobación.
const seed = process.argv[3];
const pointsToWin = Number(process.argv[4]);
const seats = process.argv.slice(5);
if (!seed || !Number.isInteger(pointsToWin) || pointsToWin <= 0 || seats.length === 0) {
  logger.error("uso: npm run replay -- <matchId> <seed> <pointsToWin> <asiento...>");
  process.exit(1);
}

logger.info("rebobinando", { matchId, entries: entries.length });
const state = replay({
  meta: { matchId, gameModeId: "replay", seed, seats, pointsToWin },
  entries,
});
logger.info("estado final reconstruido", { matchId, state: state.toJSON() });
```

En `package.json`:

```json
    "replay": "tsx src/replay.ts",
```

En `register-http.ts`, sumar el endpoint de soporte:

```ts
  // Para soporte. Detrás de la API key interna cuando exista `auth/internal-key`.
  app.get("/internal/matches/:matchId/history", (request, response) => {
    const entries = (rootContainer.resolve("HistoryPort") as MemoryHistory).of(
      request.params.matchId,
    );
    if (entries.length === 0) {
      response.status(404).json({ error: "NOT_FOUND" });
      return;
    }
    response.json({ matchId: request.params.matchId, entries });
  });
```

- [ ] **Step 6: Correr el test del replay hasta que pase**

Run: `npx vitest run src/features/match/tests/replay.test.ts`
Expected: los 4 tests PASAN.

Si el golden falla en el estado final, hay una fuente de no-determinismo que se escapó. Los
sospechosos, en orden: `Date.now()` en algún sitio del core (tiene que ser el `Clock`),
`Math.random()` fuera del `Dealer`, o un `Map`/`Set` cuyo orden de iteración entra en una decisión.

- [ ] **Step 7: Commit — cierra la rebanada 2**

```bash
npm run typecheck && npm run lint && npm test
git add src package.json
git commit -m "feat(history): replay determinista, CLI de soporte y test golden

Reconstruir una partida es mismo config (mismo seed) + los comandos y los
vencimientos reaplicados en orden de seq: son las dos únicas entradas del motor.
Todo lo demás del historial es consecuencia y se re-deriva, así que el replay lo
ignora — y hay un test que lo afirma.

El grafo de actores se extrajo a buildEngineGraph, que la sala y el replay
comparten. Duplicarlo era el bug que truco documenta: la génesis vivía en la room
y duplicada en un fixture, con dos implementaciones de una regla obligadas a
coincidir.

El fixture golden es una partida real grabada: si el motor cambia de forma que no
la reproduzca, el test falla y nombra la regla que se movió.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

# Rebanada 3 — Endurecimiento

## Tarea 22: El test del semáforo y los tres caminos de reconexión

Los dos criterios de "hecho" del spec que no caen en ninguna tarea anterior. El primero es el que
contesta la pregunta original —¿se puede spamear una acción y saltarse una validación?—; el segundo
es el que verifica que el `unlock()` de `onDrop` no es teórico.

**Files:**
- Create: `src/features/match/tests/concurrency-e2e.test.ts`, `src/features/match/tests/reconnection-e2e.test.ts`

- [ ] **Step 1: Escribir el test del semáforo**

```ts
// src/features/match/tests/concurrency-e2e.test.ts
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { boardEndsOf } from "../core/engine/round/board-ends.js";
import { playableSides } from "../core/engine/round/playable.js";
import type { MatchState } from "../core/state/index.js";
import { bootServer, historyOf, seatPair, waitUntil } from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2588);
});

afterAll(async () => {
  await server.shutdown();
});

function legalPlayFor(state: MatchState, playerId: string) {
  const round = state.currentRound;
  if (!round) return undefined;
  const hand = state.players.find((player) => player.playerId === playerId)?.hand;
  if (!hand) return undefined;
  const ends = boardEndsOf(round.board);
  for (const tile of hand.tiles) {
    const sides = playableSides(tile, ends);
    if (sides[0]) return { left: tile.left, right: tile.right, side: sides[0] };
  }
  return undefined;
}

describe("concurrencia — no hay ventana para saltarse una validación", () => {
  // LA PREGUNTA ORIGINAL. El camino del comando es síncrono de punta a punta: sin
  // un solo await, Node no puede entrelazar dos mensajes del mismo cliente. El
  // primero muta el turno y los demás rebotan leyendo el estado YA mutado.
  it("N envíos de la misma jugada en el mismo tick aplican exactamente uno", async () => {
    const match = await seatPair(server, ["c1", "c2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    const playerId = match.serverState.currentRound?.currentTurn.playerId as string;
    const play = legalPlayFor(match.serverState, playerId);
    if (!play) throw new Error("sin jugada legal");

    const illegal: { code: string }[] = [];
    match.clients[playerId]?.onMessage("illegal", (payload) => illegal.push(payload));

    // Veinte veces, sin await entre medio: todos salen en el mismo tick.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      match.clients[playerId]?.send("PLAY_TILE", play);
    }

    await waitUntil(() => illegal.length >= 19, 5_000);

    // UNA sola ficha en la mesa, y una sola entrada en el historial.
    expect(match.serverState.currentRound?.board.tiles.length).toBe(1);
    const plays = historyOf("m-c1-c2").filter((entry) => entry.type === "PLAY_TILE");
    expect(plays).toHaveLength(1);

    // Los 19 restantes rebotaron por regla de dominio, no por throttle.
    expect(illegal).toHaveLength(19);
    for (const rejection of illegal) {
      expect(["NOT_YOUR_TURN", "TILE_NOT_IN_HAND"]).toContain(rejection.code);
    }
  });

  it("una ráfaga durante la pausa de la mano no toca el estado", async () => {
    const match = await seatPair(server, ["k1", "k2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    // Abandonar abre PRESENTING_MATCH, que es una fase de pausa: nada de juego es
    // legal ahí. Es el equivalente al hueco que el v1 dejaba con sleep(6000).
    match.clients.k1?.send("ABANDON", {});
    await waitUntil(() => match.serverState.phase === "PRESENTING_MATCH");

    const illegal: { code: string }[] = [];
    match.clients.k2?.onMessage("illegal", (payload) => illegal.push(payload));
    const before = match.serverState.currentRound?.board.tiles.length ?? 0;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      match.clients.k2?.send("PLAY_TILE", { left: 6, right: 6, side: "RIGHT" });
    }

    await waitUntil(() => illegal.length >= 10, 5_000);
    expect(match.serverState.currentRound?.board.tiles.length).toBe(before);
    for (const rejection of illegal) {
      expect(rejection.code).toBe("MATCH_NOT_IN_PROGRESS");
    }
  });

  it("los rechazos NO entran al historial: son rastro antifraude", async () => {
    const rejected = historyOf("m-k1-k2").filter((entry) => entry.type === "PLAY_TILE");
    expect(rejected).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Verificar por grep que el camino del comando no tiene un solo `await`**

Es el complemento estructural del test: el test prueba el comportamiento de hoy, el grep impide que
mañana alguien meta un `await` y lo rompa en silencio.

Añadir a `src/architecture.test.ts`:

```ts
  // El camino del comando es SÍNCRONO POR CONTRATO. Un await acá reabre la ventana
  // de interleaving que el test del semáforo cierra.
  it("no hay await en el core del engine ni en los comandos", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = `${dir}/${entry}`;
        if (statSync(path).isDirectory()) return walk(path);
        return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
      });

    const offenders = [
      ...walk("src/features/match/core/commands"),
      ...walk("src/features/match/core/engine"),
    ].filter((path) => {
      if (path.includes("/tests/")) return false;
      const source = readFileSync(path, "utf8");
      return /\bawait\b/.test(source) || /\basync\b/.test(source);
    });

    expect(offenders).toEqual([]);
  });
```

Run: `npx vitest run src/architecture.test.ts`
Expected: PASA. Si aparece un ofensor, no relajar el test: sacar la espera del comando y moverla a la
puerta o a un listener.

- [ ] **Step 3: Escribir el test de los tres caminos de reconexión**

```ts
// src/features/match/tests/reconnection-e2e.test.ts
import { CloseCode } from "@colyseus/sdk";
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state/index.js";
import { bootServer, linesOf, rejoinAs, seatPair, waitUntil } from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2589);
});

afterAll(async () => {
  await server.shutdown();
});

const connectedOf = (state: MatchState, playerId: string) =>
  state.players.find((player) => player.playerId === playerId)?.connected;

describe("reconexión — los tres caminos", () => {
  // CAMINO 1: bache de red. El SDK reintenta solo sobre la MISMA instancia de Room,
  // con los callbacks intactos.
  it("un bache de red no cuesta la partida y dispara onDrop/onReconnect", async () => {
    const match = await seatPair(server, ["n1", "n2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    let dropped = false;
    let reconnected = false;
    match.clients.n1?.onDrop(() => { dropped = true; });
    match.clients.n1?.onReconnect(() => { reconnected = true; });

    // Cierre NO consentido: es lo que Colyseus trata como caída.
    await match.clients.n1?.leave(false);

    await waitUntil(() => dropped, 3_000);
    expect(connectedOf(match.serverState, "n1")).toBe(false);
    // La partida sigue viva, y el reloj del juego no se pausó.
    expect(match.serverState.phase).toBe("PLAYING");
    expect(match.serverState.activeDeadline).toBeGreaterThan(0);

    await waitUntil(() => reconnected, 5_000);
    expect(connectedOf(match.serverState, "n1")).toBe(true);
    expect(linesOf("m-n1-n2")).toContain("SYSTEM PLAYER_RECONNECTED");
  });

  // CAMINO 2: token perdido. ESTE es el test que verifica el unlock() de onDrop.
  // Sin él, la sala cuenta el asiento reservado en hasReachedMaxClients(), el
  // matchmaker rechaza el joinById, y el jugador queda fuera de SU propia partida.
  it("quien perdió su token vuelve por roomId", async () => {
    const match = await seatPair(server, ["t1", "t2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    await match.clients.t1?.leave(false);
    await waitUntil(() => connectedOf(match.serverState, "t1") === false, 3_000);

    // Sin el unlock() esta línea lanza.
    const back = await rejoinAs(server, match.roomId, "t1");
    await waitUntil(() => back.hasJoined === true, 5_000);

    await waitUntil(() => connectedOf(match.serverState, "t1") === true, 3_000);
    // Ve su mano completa: la vista es del ASIENTO y le esperó.
    const own = [...((back.state as MatchState).players.find((p) => p.playerId === "t1")?.hand.tiles ?? [])];
    expect(own).toHaveLength(7);
  });

  // CAMINO 3: la ventana venció. Cerrar el socket NO es rendirse: al jugador lo
  // retira el motor por timeout, no el transporte.
  it("al vencer la ventana el jugador sigue en la partida", async () => {
    const match = await seatPair(server, ["e1", "e2"]);
    await waitUntil(() => match.serverState.phase === "PLAYING");

    let leaveCode: number | undefined;
    match.clients.e1?.onLeave((code) => { leaveCode = code; });
    await match.clients.e1?.leave(false);

    // La ventana de producción son 120 s; para este test se baja por env.
    await waitUntil(() => leaveCode !== undefined, 20_000);
    expect(leaveCode).toBe(CloseCode.FAILED_TO_RECONNECT);

    expect(linesOf("m-e1-e2")).toContain("SYSTEM PLAYER_DISCONNECTED");
    // NO fue expulsado del juego: sigue siendo jugador.
    expect(match.serverState.players.find((p) => p.playerId === "e1")?.hasAbandoned).toBe(false);
  });
});
```

- [ ] **Step 4: Hacer configurable la ventana de reconexión**

El camino 3 no puede esperar 120 s. Igual que las duraciones de fase, la ventana sale de env.

En `src/env.ts`, sumar al schema, a la interfaz y al retorno:

```ts
  RECONNECTION_WINDOW_SECONDS: z.coerce.number().int().positive().default(120),
```
```ts
  readonly reconnectionWindowSeconds: number;
```
```ts
    reconnectionWindowSeconds: parsed.RECONNECTION_WINDOW_SECONDS,
```

En `GlobalDominoConfig` (`core/config.ts`), sumar `readonly reconnectionWindowSeconds: number;` con
default `120` en `DEFAULT_GLOBAL_CONFIG`, y pasarlo desde `di-container.ts` como los demás.

En `domino-room.ts`: borrar la constante del módulo, declarar el campo, asignarlo en `onCreate` y
usarlo en `onDrop`.

```ts
// 1. BORRAR la línea del tope del archivo:
//    const RECONNECTION_WINDOW_SECONDS = 120;

// 2. DECLARAR el campo, con los demás de la clase:
  private reconnectionWindowSeconds = 120;

// 3. ASIGNARLO en onCreate, después de resolver `global`:
    this.reconnectionWindowSeconds = global.reconnectionWindowSeconds;

// 4. USARLO en onDrop:
    this.allowReconnection(client, this.reconnectionWindowSeconds);
```

El default del campo es el mismo que el del env, así que si algún día `onDrop` corriera antes de que
`onCreate` termine, la ventana no sería cero.

En `vitest.setup.ts`:

```ts
// Tres segundos: el camino de la ventana vencida tiene que poder testearse.
process.env.RECONNECTION_WINDOW_SECONDS ??= "3";
```

Y bajar el plazo de espera del camino 3 a `10_000`.

- [ ] **Step 5: Correr los dos tests hasta que pasen**

Run: `npx vitest run src/features/match/tests/concurrency-e2e.test.ts src/features/match/tests/reconnection-e2e.test.ts`
Expected: 3 + 3 tests PASAN.

Si el camino 1 nunca dispara `onReconnect`, es que `leave(false)` en el SDK de test no simula una
caída: usar el mecanismo que la referencia de `@colyseus/testing` ofrezca para cortar el transporte, y
si no existe, marcar ese caso como verificación **manual** de la tabla del spec y dejar en el test solo
los caminos 2 y 3. Lo que no se negocia es el camino 2: es el que prueba el `unlock()`.

- [ ] **Step 6: Correr la suite completa y commitear**

```bash
npm run typecheck && npm run lint && npm test
git add src
git commit -m "test: el semáforo y los tres caminos de reconexión

El test del semáforo contesta la pregunta que originó el rediseño: veinte envíos
de la misma jugada en el mismo tick aplican exactamente uno, y los diecinueve
restantes rebotan por regla de dominio —leyendo el estado ya mutado—, no por
throttle. Los rechazos no entran al historial.

Lo acompaña un test de arquitectura que prohíbe await y async en core/commands y
core/engine: el test prueba el comportamiento de hoy, el grep impide que mañana
alguien reabra la ventana en silencio.

El camino del token perdido es el que verifica que el unlock() de onDrop no es
teórico: sin él la sala cuenta el asiento reservado, el matchmaker rechaza el
joinById y el jugador queda fuera de su propia partida.

La ventana de reconexión pasa a salir de env para poder testear su vencimiento.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Tarea 23: La ventana de reparto de punta a punta

> **Por qué tiene tarea propia y no un `it` más.** Los tres desenlaces de la ventana son tres
> desenlaces **de la partida** —sigue, forfeit, o se muere sin ganador—, y el tercero es el único
> camino del motor en el que **nadie gana**. En un juego con dinero ese camino se prueba explícito o
> no se prueba.

**Files:**
- Create: `src/features/match/tests/deal-window-e2e.test.ts`

- [ ] **Step 1: Escribir los cuatro tests**

```ts
// src/features/match/tests/deal-window-e2e.test.ts
import type { ColyseusTestServer } from "@colyseus/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MatchState } from "../core/state/index.js";
import { act, bootServer, linesOf, seatPair, waitUntil } from "./e2e-harness.js";

let server: ColyseusTestServer;

beforeAll(async () => {
  server = await bootServer(2588);
});

afterAll(async () => {
  await server.shutdown();
});

const seenOf = (state: MatchState, playerId: string) =>
  state.players.find((player) => player.playerId === playerId)?.hasSeenTiles;

const tilesVisibleTo = (state: MatchState, playerId: string) =>
  [...(state.players.find((player) => player.playerId === playerId)?.hand.tiles ?? [])];

describe("la ventana de reparto", () => {
  // EL PUNTO DE PARTIDA: se repartió, pero nadie vio nada todavía.
  it("reparte tapado y espera: la ronda no arranca hasta que los dos levantan", async () => {
    const match = await seatPair(server, ["d1", "d2"], undefined, { skipDealWindow: true });

    await waitUntil(() => match.serverState.currentRound?.phase === "DEALING");
    expect(match.serverState.activeDeadline).toBeGreaterThan(0);
    expect(seenOf(match.serverState, "d1")).toBe(false);
    expect(seenOf(match.serverState, "d2")).toBe(false);

    // Uno levanta: se marca, y la ronda SIGUE esperando al otro.
    await act(match, "d1", "REVEAL_TILES");
    expect(seenOf(match.serverState, "d1")).toBe(true);
    expect(match.serverState.currentRound?.phase).toBe("DEALING");

    // El otro levanta: recién ahí arranca el turno.
    await act(match, "d2", "REVEAL_TILES");
    await waitUntil(() => match.serverState.currentRound?.phase === "PLAYING");
    expect(match.serverState.currentRound?.currentTurn.playerId).not.toBe("");
  });

  // LEVANTAR ES DEL DUEÑO Y DE NADIE MÁS. Es la mitad antifraude: si levantar revelara
  // a la mesa, la ventana sería peor que no tenerla.
  it("levantar revela solo al dueño", async () => {
    const match = await seatPair(server, ["v1", "v2"], undefined, { skipDealWindow: true });
    await waitUntil(() => match.serverState.currentRound?.phase === "DEALING");

    await act(match, "v1", "REVEAL_TILES");

    // En el estado del SERVIDOR las fichas están (el dominio las tiene); lo que se
    // prueba acá es que la vista del rival no las tiene. El smoke de visibilidad afirma
    // esa mitad desde el cliente; acá basta con que el rival siga sin levantar.
    expect(tilesVisibleTo(match.serverState, "v1")).toHaveLength(7);
    expect(seenOf(match.serverState, "v2")).toBe(false);
  });

  // CAMINO 2: uno no está. Se lo retira y el otro gana por forfeit — sin haber jugado
  // una ficha, que es exactamente lo que la regla quiere.
  it("al vencer, el que no levantó se retira y el otro gana por forfeit", async () => {
    const match = await seatPair(server, ["f1", "f2"], undefined, { skipDealWindow: true });
    await waitUntil(() => match.serverState.currentRound?.phase === "DEALING");

    await act(match, "f1", "REVEAL_TILES");

    await waitUntil(() => match.serverState.phase === "PRESENTING_MATCH", 20_000);
    expect(match.serverState.players.find((p) => p.playerId === "f2")?.hasAbandoned).toBe(true);
    expect(match.serverState.players.find((p) => p.playerId === "f1")?.hasAbandoned).toBe(false);

    // El ABANDON del ausente lo dijo el SISTEMA, no él: para un reclamo esa es toda la
    // diferencia. Y el veredicto sale al entrar a la presentación, no al vencerla.
    const lines = linesOf("m-f1-f2");
    expect(lines).toContain("SYSTEM ABANDON");
    expect(lines).toContain("SYSTEM MATCH_RESOLVED");
  });

  // CAMINO 3, Y EL QUE IMPORTA: NO LA LEVANTA NADIE. Nadie jugó, así que nadie gana. Si
  // este test se pone verde con un `MATCH_RESOLVED` en el historial, el motor está
  // pagando el premio de una partida que no existió.
  it("si no la levanta nadie, no gana nadie y la mesa se muere", async () => {
    const match = await seatPair(server, ["z1", "z2"], undefined, { skipDealWindow: true });
    await waitUntil(() => match.serverState.currentRound?.phase === "DEALING");

    await waitUntil(
      () => match.serverState.players.every((player) => player.hasAbandoned),
      20_000,
    );

    // NADIE gana: sin veredicto no hay `MATCH_RESOLVED`, y la fase no llega al terminal
    // por la vía del juego.
    expect(linesOf("m-z1-z2")).not.toContain("SYSTEM MATCH_RESOLVED");
    expect(match.serverState.phase).not.toBe("FINISHED");

    // Y el plazo quedó APAGADO: si siguiera vencido, el conductor despertaría en el
    // acto, encontraría la misma fase muerta y se re-programaría para siempre.
    expect(match.serverState.activeDeadline).toBe(0);

    // La sala cierra y el motivo es auditable: no es lo mismo que nunca se llenó.
    await server.getRoomById(match.roomId)?.disconnect();
    await waitUntil(() => linesOf("m-z1-z2").includes("SYSTEM MATCH_ABORTED"), 5_000);
    const aborted = historyOf("m-z1-z2").find((entry) => entry.type === "MATCH_ABORTED");
    expect(aborted?.payload).toEqual({ reason: "NEVER_PLAYED" });
  });
});
```

Con `historyOf` en el import de `./e2e-harness.js`.

- [ ] **Step 2: Correr y ajustar los plazos**

Run: `npx vitest run src/features/match/tests/deal-window-e2e.test.ts`
Expected: los 4 tests PASAN.

Los dos tests de vencimiento esperan el plazo REAL de la ventana, así que en `vitest.setup.ts` va
corto igual que los demás:

```ts
process.env.DEALING_TIMEOUT_MS ??= "800";
```

Y en `src/env.ts`, junto a los otros: `DEALING_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000)`,
su campo en `Env`, su línea en `parseEnv`, y su override en el registro de `GlobalDominoConfig`.

Si el camino 3 falla porque `MATCH_ABORTED` nunca llega, el sospechoso es la guarda de `onDispose`:
con la partida en `DEALING` y `phase !== "FINISHED"`, tiene que entrar — y `abortReason()` tiene que
devolver `NEVER_PLAYED` porque nadie tiene `hasSeenTiles`.

- [ ] **Step 3: Commit**

```bash
npm run typecheck && npm run lint && npm test
git add src
git commit -m "test: la ventana de reparto de punta a punta

Los cuatro caminos: los dos levantan y la ronda arranca; levantar revela solo al
dueño; uno no está y el otro gana por forfeit sin jugar una ficha; y no la
levanta nadie.

El último es el que justifica la tarea. Con los dos equipos retirados el juez
NO dictamina —outcome() devuelve undefined a propósito—, así que no hay
MATCH_RESOLVED y la mesa se muere sin ganador: reembolsa con
MATCH_ABORTED { reason: NEVER_PLAYED }. Sin esa guarda, el orden de evaluación
coronaría a uno de los dos y el motor pagaría el premio de una partida que nadie
jugó.

También afirma que el plazo queda apagado cuando no queda nadie: un instante ya
vencido en una fase muerta es un bucle de re-programación sin fin.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Verificación final

Con las 24 tareas hechas, esto tiene que valer:

```bash
npm run typecheck      # sin errores
npm run lint           # biome, con no-console en error
npm test               # toda la suite, incluidas las reglas de arquitectura
npm run build          # tsup produce dist/index.js
```

Y los cuatro criterios de "hecho" del spec, cada uno con su test nombrado:

| Criterio | Test |
|---|---|
| **Trampa cerrada** | `visibility.smoke.test.ts` — el rival no recibe ninguna ficha ajena ni del pozo, en ninguna fase |
| **Auditoría** | `game-2p-e2e.test.ts` (seq sin huecos, `MATCH_RESOLVED` ANTES del `DEADLINE_EXPIRED` de la presentación, cada `DEADLINE_EXPIRED` con su verbo detrás) + `replay.test.ts` (el golden reproduce el estado final exacto) |
| **Semáforo** | `concurrency-e2e.test.ts` + la regla de arquitectura que prohíbe `await` en el core |
| **Logs** | Manual: levantar el servidor, jugar una partida, y comprobar en Loki que `{matchId="…"}` devuelve la traza completa y solo esa, incluidos los rechazos |
| **Reconexión** | `reconnection-e2e.test.ts` — los tres caminos |
| **Nadie cobra sin jugar** | `deal-window-e2e.test.ts` — con los dos ausentes NO hay `MATCH_RESOLVED`, y la mesa reembolsa con `NEVER_PLAYED` |

---
