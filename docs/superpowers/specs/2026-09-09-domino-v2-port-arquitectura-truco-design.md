# Domino v2 — port de la arquitectura de `truco-backend-v2`

> **Spec de diseño** · 2026-09-09 · Aprobado en seis secciones · **revisado 2026-09-10** contra
> `truco-backend-v2` v26/v10/v12
> Este documento fija **qué** se construye y **por qué**. El *cuándo* y el *en qué orden* viven en el
> plan de implementación.
>
> **Alcance y decomposición.** El diseño es de todo el sistema porque las piezas se sostienen entre sí
> —el motor síncrono es lo que permite el historial reproducible, y la identidad es lo que permite el
> multi-operador—, pero **no se implementa de una vez**: el plan lo corta en rebanadas verticales
> jugables, y las primeras (documento de reglas · esqueleto de conexión · repartir y jugar 2P) son las
> únicas que se planifican en detalle ahora. Cada rebanada posterior se replanifica con lo aprendido en
> la anterior.
>
> **Referencias:** en `truco-backend-v2/docs/`: `arquitectura-negocio-v27.md`,
> `arquitectura-app-e-infra-v11.md`, `estructura-de-carpetas-v13.md`, y **`changelog.md`**. En este
> repo: `docs/ruta-critica.md`, `docs/multi-operator-mvp-plan.md`, `docs/abrir-la-red.md`.
>
> **La primera redacción citaba v25/v9/v11, y esa diferencia costó cuatro decisiones.** El delta entre
> esas versiones y las actuales son **dos** entradas del changelog de truco:
>
> - **La revancha** (v26/v10/v12) — de ahí salen: que la negociación de revancha la hospeda el MOTOR
>   (§5.6), que `MATCH_RESOLVED` se emite al ENTRAR a la fase de presentación y no al vencerla (§5.7),
>   y que `RESOLVED` (veredicto, siempre evento) es una palabra distinta de `FINISHED` (terminal de la
>   máquina, siempre fase) (§5.8).
> - **La ventana de reparto** (v27/v11/v13, `feat(match): ver mis cartas`) — de ahí sale §7.5, que en
>   dominó no es una feature más: es el control antifraude del arranque.
>
> Regla de mantenimiento que sale de esto: **antes de revisar cualquier decisión de arquitectura, leer
> `truco-backend-v2/docs/changelog.md` y comparar contra la versión que este documento cita.** Las dos
> veces que se hizo, apareció algo que este spec necesitaba.

---

## 1. El problema

`Betaso-Domino-Backend` no es un microservicio autónomo. La lógica del juego vive **dentro de las
clases `Schema` de Colyseus**, que resuelven dependencias por DI y llaman HTTP, Mongo, Postgres y
RabbitMQ desde adentro. Dos ejemplos que fijan la escala:

- `finishGame` (`src/rooms/schema/domino/two-players/domino-room-state.ts:437-613`) son **176 líneas**
  que mezclan anti-abuso, estadísticas, core-loop, pago, ranking, last-winners, liga, persistencia y
  revancha.
- `src/auth/middleware.ts:88-93` consulta `public.user` con Kysely **contra la base de datos del
  backend principal**, y `src/storage/postgres/schema.ts` mapea cinco tablas ajenas.

Eso bloquea cuatro cosas distintas a la vez:

| Necesidad | Qué la bloquea hoy |
|---|---|
| **Servir el juego a otros operadores** | No hay frontera juego/plataforma. El motor trata con ids de usuario de Betaso y lee su Postgres: servir a un tercero exigiría darle credenciales de esa base. Es **TA + TA2 del camino crítico** de `ruta-critica.md` |
| **Auditar partidas** | La persistencia es un `findOneAndUpdate($set, upsert)` por `tokenId` (`src/game-state/game-two-state.service.ts:63-71`): se **sobreescribe**. Existe `historyMoves` por ronda, pero no hay registro de acciones rechazadas ni de decisiones del sistema, así que no se puede contestar "¿por qué pasó esto?" |
| **Seguir una partida en los logs** | `pino` + `pino-loki` ya están, pero hay **123 `console.*` en 35 archivos**, un tercer canal (`import { logger } from 'colyseus'` en 5 sitios), y `Logger.child()` existe en `src/logger/logger.ts:39` y **no se usa en ningún lado**. La correlación es prefijos a mano tipo `[LOBBY]`, y el `state.token` casi nunca se loguea |
| **Integridad del juego** | **Cero `StateView`/`@filter` en todo `src/`.** `PlayerState.hand.tiles` lleva `left`/`right` reales y `players` es un `MapSchema` sincronizado completo, así que **cada cliente recibe la mano exacta de sus rivales** en cada patch. Y hay `sleep(3000)`/`sleep(6000)` **dentro de la mutación del estado**, con 2P sin un solo mutex |

Además: **cero tests** de reglas de dominó (los seis `test:*` de `package.json` son `*.demo.ts`
ejecutados con `ts-node`, y cubren matchmaking, revancha y core-loop), y las reglas están
**triplicadas** — `round.state.ts` de 2P y 4P son ~95 % idénticos, `PlayerHand` está duplicado, y el
torneo importa el `RoundState` de 2P y reimplementa el reparto.

`truco-backend-v2` ya resolvió la parte arquitectónica y la documentó en 11.211 líneas de `docs/`.
Este diseño **la porta**, y añade lo que truco dejó pendiente (persistencia del historial, su Inc. 13)
o nunca necesitó (multi-operador, logging estructurado).

**Resultado buscado:** un motor de dominó puro y síncrono, agnóstico de plataforma, con historial
reproducible por `matchId`, y sin superficie para saltarse validaciones por interleaving de `await`.

---

## 2. Restricciones y decisiones de partida

| | Decisión | Nota |
|---|---|---|
| Ubicación | Repo nuevo **`domino-backend-v2`** | Espejo de lo que se hizo con truco. El v1 sigue en producción hasta el cutover, y los dos corren en paralelo durante la certificación |
| Stack | ESM, Node ≥22, **Colyseus 0.18.5**, **`@colyseus/schema` 5.x**, vitest, tsup, biome, tsyringe, zod 4 | Idéntico a truco. Hoy el domino está en Colyseus **0.16** y schema **3.0.68**, CommonJS |
| Alcance del release | Casual 2P + 4P, torneos, revancha | Los bots de 4P entran porque ya existen y sostienen la mesa cuando alguien abandona |
| Multi-operador | Puertos + adaptador por operador | Betaso es el **operador #1** y se consume por el mismo puerto |
| Auditoría | Mongo append-only + endpoint HTTP interno + replay por CLI | El replay es además el test de regresión del motor |
| Fuera de alcance | La **cámara de compensación** (libro entre operadores, corte, neteo) | Es servicio aparte —TB del camino crítico—. `economy` le habla por un puerto |

---

## 3. Arquitectura

### 3.1 El corte

Hexagonal, **por feature** (vertical slices) en el primer nivel. Dentro de cada feature un solo nombre
reservado, `core/`, y el exterior nombrado **por su contenido**, con presencia ganada: una carpeta nace
cuando su contenido la justifica, nunca por simetría con otra feature.

Features: `match` (el corazón), `matchmaking`, `auth`, `operator`, `economy`, `tournament`, `bots`.
Más `shared/`, solo para lo portable entre proyectos.

Dos vocabularios para dos niveles, deliberadamente distintos: los documentos hablan de **dominio,
aplicación e infraestructura** como topología global; el árbol nombra el interior **relativo** de cada
feature. El árbol no usa las palabras de los documentos, y viceversa.

### 3.2 Las cuatro reglas mecánicas

La frontera pura/impura no la garantizan las carpetas: la garantizan reglas de imports verificables.

1. `features/X/core/**` solo importa de `features/X/core/**` y de `shared/**`. Es una **allowlist**,
   no una denylist: por eso el exterior puede nombrarse libremente.
2. `features/*/core/**` no importa `colyseus`, `mongoose`, `pg`, `amqplib` ni `axios`.
   **Excepción única y documentada: `@colyseus/schema`** (ver §3.4).
3. `tsyringe` solo en los tres composition roots: `src/di-container.ts`,
   `features/match/transports/colyseus/domino-room.ts` y `.../commands/di-wiring.ts`. Registros con
   `useValue`/`useFactory`, **nunca `useClass`** — así los decoradores desaparecen del codebase y
   `emitDecoratorMetadata` se apaga.
4. Una feature solo importa de otra vía su `index.ts`.

Se expresan en ~15 líneas de **dependency-cruiser** y corren como test. Aplican **también a los
`*.test.ts` de `core/`**, sin excepciones: un test de core que necesite el exterior para construir su
sujeto es exactamente la señal de acoplamiento que se quiere atrapar.

La regla 4 funciona en dos direcciones: hacia afuera verifica que los bordes declarados son los
reales; hacia adentro es **señal de promoción** — el día que un pedazo interno le hable al resto solo
por eventos, es una feature pidiendo nacer.

### 3.3 El árbol

```
src/
├── index.ts · di-container.ts · env.ts
├── features/
│   ├── match/
│   │   ├── index.ts
│   │   ├── core/                 # las reglas del dominó — puro, protegido por §3.2
│   │   │   ├── command.ts · config.ts · events.ts · ids.ts · index.ts
│   │   │   ├── state/            # árbol Schema INERTE, sin lógica
│   │   │   │   ├── match.ts      # MatchState, Scoreboard, MatchPhase
│   │   │   │   ├── player.ts     # PlayerState, Hand (nodo mixto: tileCount público, tiles gated)
│   │   │   │   ├── tile.ts       # Tile, PlacedTile
│   │   │   │   ├── board.ts      # la cadena jugada + los dos extremos
│   │   │   │   ├── round.ts      # RoundState, Turn, RoundSummary, RoundPhase
│   │   │   │   ├── boneyard.ts   # pozo: count público, tiles sin audiencia
│   │   │   │   ├── multiplier.ts # negociación de apuesta (rama nula de la RONDA)
│   │   │   │   └── rematch.ts
│   │   │   ├── engine/
│   │   │   │   ├── driver.ts · clock.ts · timeout-scheduler.ts · visibility.ts · errors.ts
│   │   │   │   ├── state-projections.ts · genesis.ts · deadline-kind.ts
│   │   │   │   ├── tile-set.ts   # las 28 fichas + valor nominal (derivación pura)
│   │   │   │   ├── dealer.ts     # SERVICIO: reparte por (seed, roundNumber)
│   │   │   │   ├── scorer.ts     # SERVICIO: tarifa mano→puntos Y asienta
│   │   │   │   ├── player-facade.ts · player-repository.ts · referee-facade.ts
│   │   │   │   ├── round/        # TRÍO player/referee/driver + board-ends · playable · block
│   │   │   │   ├── match/        # TRÍO player(abandon)/referee/driver
│   │   │   │   ├── multiplier/   # DÚO + revoker
│   │   │   │   └── tests/        # fixtures build-engine · create-match-state
│   │   │   └── commands/         # un caso de uso, un archivo
│   │   ├── network/              # el ANILLO (era `betaso/` en truco) — ver §3.6
│   │   │   ├── listeners.ts · admission.ts · pieces.ts · profiles.ts
│   │   │   ├── events.ts · errors.ts · history.ts
│   │   │   ├── bot.ts            # el PUERTO BotPort/BotEvent (lo implementa features/bots/)
│   │   │   ├── casual/ · tournament/     # TRADUCTORES de ámbito
│   │   │   └── transports/ · tests/
│   │   ├── history/              # adaptador Mongo del HistoryPort + el replay
│   │   ├── transports/
│   │   │   ├── match-contract.ts · match-registry.ts
│   │   │   ├── colyseus/         # domino-room.ts · visibility.ts · events · errors · commands/
│   │   │   └── http/             # GET /config/:roomId · GET /internal/matches/:id/history
│   │   └── tests/                # e2e-harness.ts · *.test.ts · replay.test.ts
│   ├── matchmaking/              # core/{grouping,cooldown} + puertos + pools/ + transports/
│   ├── auth/                     # identity.ts (multi-issuer) · internal-key.ts · transports/
│   ├── operator/                 # registry · puertos · alias · credenciales
│   ├── economy/                  # wallet · ledger · outbox · events
│   ├── tournament/               # config · quality · penalty · client · participation
│   └── bots/                     # la decisión del bot de 4P
└── shared/                       # rng · retry · sleep · deadline
```

Archivos en **kebab-case** sin excepción; las clases conservan PascalCase.

### 3.4 El estado ES el `Schema` de Colyseus

No hay dos tipos (interfaz pura + implementación), no hay capa de traducción ni DTO intermedio: hay
una sola clase `Schema` por nodo, que es a la vez el dato que el dominio muta y el que Colyseus
serializa.

Por eso la frontera hexagonal **no está en qué tipos conoce el dominio** —conoce `Schema`, y está
bien: para el dominio es una clase de datos serializable— sino en **qué hace**:

> **El dominio describe; la infraestructura ejecuta.**

- El dominio **describe**: muta estado (incluidos los campos de visibilidad), estampa deadlines como
  instantes en campos del estado, y devuelve `MatchEvent`.
- El dominio **nunca** toca: `Room`, `client`, `sessionId`, `StateView`, el `clock` de Colyseus, el
  envío o recepción de mensajes, ni el `ChangeTree` como entrada de decisión.

Esto no se sostiene por portabilidad —no se planea cambiar de Colyseus— sino por tres cosas que se
cobran a diario: la lógica se prueba construyendo estado, sin levantar una `Room`; los efectos de red
viven en un solo lugar; y el motor sigue siendo función de `(estado, comando) → (estado', descripciones)`,
reproducible y auditable.

### 3.5 Modelo de actores

Por cada nivel del juego, un trío:

| Rol | Qué hace |
|---|---|
| **Player** | solo **muta**, por asiento. Referee-free |
| **Referee** | read-only: valida legalidad, deriva, dictamina. Lanza `RuleViolationError` |
| **Driver** | dueño de las **transiciones de fase** y de los plazos. Superficie pública: `begin` / `advance` / `timeout` |

Niveles del dominó: `round/` y `match/`. La negociación de apuesta es un **dúo** (Player + Referee,
sin conductor: el acto *es* la transición — aceptar es `phase = ACCEPTED`, no hay nada que derivar) más
un `revoker` para lo que le *pasa* a la apuesta sin que un jugador lo haga.

Dos facades que consumen los comandos: `Referee` (agrega los `assertCanX` en una superficie) y
`Player` (resuelve por asiento vía `PlayerRepository`). **La conducción no tiene facade** — no hay
multiplicidad que esconder.

Un comando es delgado y siempre en el mismo orden: **juez valida → player muta → driver avanza**.

```ts
execute({ playerId, tile, end }) {
  this.referee.assertCanPlay(playerId, tile, end)
  this.players.get(playerId).playTile(tile, end)
  return this.matchDriver.advance(playerId).events
}
```

Grafo **acíclico y solo hacia abajo**. La frontera se define **por lo que cada actor escribe**, y es
verificable con grep: un solo escritor de `hasAbandoned`, un solo escritor del marcador (`Scorer`), y
los que estampan `activeDeadline` son exactamente los conductores.

### 3.6 El anillo se llama `network/`

**Decisión, con su razón.** La regla de truco es nombrar el exterior por su **contenido**, y rechaza
explícitamente nombres de estrato (`services/`, `application/`, `impl/`). El contenido de este anillo ya
no es "lo que Betaso hace con una partida" sino lo que **la red** hace: cobrar la entrada, pagar el
premio, reportar la participación y notificar al operador dueño de cada asiento. `network/` es además el
vocabulario que ya usan los documentos de negocio (`network_rounds`, `network_ledger_entries`, "Betaso
Network — Partner API").

Cadena de eventos, declarada **donde vive cada eslabón**, no en un archivo central:

```
MatchEvent (core/events.ts)  ⊆  NetworkMatchEvent (network/events.ts)  ⊆  ColyseusMatchEvent (transports/colyseus/events.ts)
```

El ensanche es por inclusión: seguro e implícito. Un `MatchEvent` **ya es** un `NetworkMatchEvent`.

**Asimetría deliberada:** hay feature `tournament` y **no** hay feature `casual`. Los dos *ámbitos*
leen el `MatchState` (el premio escala por multiplicador, el reporte necesita rondas y marcador), así
que fallan el test de "nunca toca el `Match`" y viven como **traductores** en
`network/{casual,tournament}/`. Promoverlos exigiría engordar los eventos para que no leyeran estado, y
eso choca con el criterio de §5.1.

---

## 4. Identidad y multi-operador

### 4.1 Dos niveles, y el motor conoce el segundo

**Decisión:** el motor usa `playerId` (uuid interno), **igual que truco**. Se evaluó y **se descartó**
un tercer nivel de id efímero de asiento.

```
{ operatorId, externalPlayerId }              ← lo que el operador manda en el launch
        │  operator_players  (unique { operatorId, externalPlayerId })
        ▼
   playerId  (uuid interno, lo genera Betaso) ← auth, matchmaking, economy, history,
        │                                        y el MatchState: es el PlayerId del engine
        ▼
   seats[]  — el orden de los asientos. Los equipos NO salen de él: los decide
              una política parametrizable, determinista desde el seed (§4.3)
```

Lo que **nunca** entra al estado sincronizado: `operatorId` y `externalPlayerId`. Como el `playerId` es
un uuid que genera Betaso, difundirlo no revela nada de la base de usuarios del socio.

De los tres problemas de `multi-operator-mvp-plan.md` §3.6 se corrige el que de verdad cede datos
personales: **salen del estado sincronizado `name`, `lastname`, `username` y `currency`**. Hoy
`player.state.ts:119-134` los difunde al rival — es un problema que ya existe entre jugadores de
Betaso, y con un socio en la mesa pasa a ser cesión entre dos empresas. `currency` además delataba el
mercado del rival.

Nickname y avatar viven **fuera del `MatchState`**, en `network/profiles.ts` (`MatchProfiles`, el
patrón que truco ya usa). La desambiguación de nicks en colisión —solo cuando colisionan, para no
exponer la marca del competidor en la mesa— y el proxy/caché del avatar son decisiones de esa capa,
invisibles para el motor.

**Ganancia:** `core/ids.ts`, `core/engine/genesis.ts` y `core/engine/state-projections.ts` quedan
**idénticos a truco**, sin capa de traducción entre identidad de plataforma e identidad de mesa.

**Residuo aceptado:** el `playerId` es estable entre partidas, así que un cliente puede correlacionar
"este es el mismo rival de ayer". Importa para colusión, no para privacidad, y el antifraude es
server-side. Si algún día pesa, pasar a un id efímero toca **solo** el estado y las proyecciones — es
un cambio aislado, no un rediseño.

### 4.2 Betaso es el operador #1

Es la decisión que ahorra la mitad del trabajo: **no se construyen "el camino normal" y "el camino del
partner"**. Se construye una interfaz y se escriben dos implementaciones. Si el socio encuentra un bug,
nosotros ya lo sufrimos primero.

| Puerto | Superficie | Implementaciones |
|---|---|---|
| `OperatorRegistry` | config por `operatorId`/`siteId`: wallet base URL, timeouts, IPs permitidas, monedas, juegos habilitados | Mongo. **Cero CRUD y cero panel** — el socio va quemado en config, por decisión de `ruta-critica.md` §1 |
| `OperatorWallet` | `balance(playerRef)` · `roundResult(tx)`, idempotente por `transactionId` **generado por Betaso** | `BetasoInternalWallet` · `PartnerHttpWallet` (HMAC + allowlist de IP) |
| `PlayerDirectory` | `{operatorId, externalPlayerId}` → `playerId`, nickname, avatar | Mongo `operator_players` |
| `TokenVerifier` (en `auth/`) | resuelve secreto o JWKS **por `iss`/`kid`**, valida `aud` | JWT HS256 hoy. Lista de algoritmos **fijada** para cerrar el `alg: none`. **El dominó nunca firma, solo verifica**: poder emitir identidades es una capacidad que este servidor no debe tener ni por accidente |

**El socio no gestiona dinero.** Le preguntamos un saldo y le informamos un resultado; el débito a su
jugador y el abono del premio los hace él, en su casa. Cada punto donde pudiéramos equivocarnos
cobrando en su billetera sería una disputa de factura futura, y ese camino no existe. Una ronda que se
cae no necesita `rollback` propio: viaja por el mismo `roundResult` con resultado «anulada».

Tres decisiones de diseño que se derivan de esto:

- **La consulta de saldo se adelanta al lobby**, antes de reservar asiento. Hoy vive dentro de la sala
  al momento de cobrar (`domino-two-room.ts:669-692`), y en un juego P2P sentar a alguien que no puede
  pagar **le quema la mesa al rival**, que no hizo nada mal. Un fallo de fondos cuesta dos jugadores,
  no uno.
- **Consultar no es reservar.** El chequeo del lobby es filtro de UX: timeout corto (1-2 s), circuit
  breaker por operador, micro-caché de 2-3 s (tras cada mano el jugador reencola en 2-7 s por el
  cooldown; sin caché se martilla la API del socio con ráfagas del mismo jugador). El **débito de la
  puerta es la autoridad y nunca usa caché**. Falla cerrado: si la wallet no responde, no se entra a
  mesas de pago. Nada de esto aplica a mesas gratis.
- **Tres familias de respuesta, no dos.** Error de datos / **fondos insuficientes** (vuelve al lobby
  con mensaje) / **bloqueo de juego responsable** —autoexclusión, límite de pérdida, límite de sesión—
  que **termina la sesión completa**: sale del pool y no reentra hasta relanzar. Confundir las dos
  últimas deja a un autoexcluido reintentando en la cola, y el problema regulatorio es de los dos.

`economy/` conserva su forma de truco: `wallet.ts` (el puerto), `ledger.ts` con idempotencia por
`(partida, jugador, razón)` y reserva de la clave **antes** del efecto monetario, y `outbox.ts` con
entrega garantizada y reintentos — **no fire-and-forget**. Eso cierra D3, D4 y D5 de la auditoría de
`multi-operator-mvp-plan.md` §2.3.

---

### 4.3 La asignación de equipos es una política, no una regla fija

**Decidido:** las parejas de 4P se forman **al azar** —es requerimiento de producto—, pero detrás de
una política parametrizable, para que cambiar a parejas asignadas sea configuración y no código.

Truco resuelve esto con una regla fija: el orden de los asientos ES la asignación de equipos
(`i % 2`), y eso le da gratis una propiedad antifraude —dos cómplices que entran juntos a la cola caen
en equipos opuestos—. Domino no puede adoptarla porque el producto pide parejas aleatorias. La
política deja las dos formas disponibles y hace explícito el costo de cada una.

```ts
// core/config.ts
export type TeamAssignmentMode = "SHUFFLED" | "SEAT_ORDER";

// core/engine/team-assignment.ts — PURA, con test propio
export function assignTeams(
  seats: readonly PlayerId[],
  mode: TeamAssignmentMode,
  seed: string,
): readonly TeamId[];   // el teamId de cada asiento, por índice
```

| Modo | Qué hace | Propiedad |
|---|---|---|
| `SHUFFLED` | permuta los asientos y reparte `i % 2` sobre la permutación | El jugador no puede predecir con quién le toca. **Es el modo de hoy** |
| `SEAT_ORDER` | `i % 2` directo sobre `seats` | Dos que entran juntos a la cola caen en equipos opuestos, siempre |

**La restricción que el v1 no cumple: el sorteo tiene que ser determinista desde el `seed`.** Hoy
`assignTeams()` mezcla con `Math.random()` (`four-players/commands/on-ready.ts:70-101`), así que las
parejas de una partida jugada **no se pueden reconstruir** — y sin eso el replay de §5.4 no reproduce
nada. La permutación se deriva de `(seed, "teams")` con el mismo PRNG que el `Dealer`: indistinguible
del azar para el jugador, exacta para el servidor.

`assignTeams` se llama **una vez, en la génesis**, y su resultado entra al `MatchState`. El motor no
vuelve a preguntarse de qué equipo es nadie: lo lee del estado.

**Cambiar de modelo es cambiar un valor en la config del modo de juego**, sin tocar el motor. El día
que aparezcan parejas elegidas por los jugadores o armadas por ranking, es un tercer caso en esa
función y una rama más en el enum.

**Lo que se pierde y hay que compensar en otro lado:** con `SHUFFLED`, dos cómplices caen de
compañeros una de cada tres veces en una mesa de cuatro. La defensa contra colusión no puede apoyarse
en la formación de equipos, así que recae entera sobre el veto de par y el cooldown del matchmaking
(§9), que ya existen y son por cuenta.

---

## 5. Auditoría: historial, replay y logging

### 5.1 Historial y log son dos cosas, y no se mezclan

| | **Historial** | **Log** |
|---|---|---|
| Qué guarda | los actos y los hechos de la partida, intercalados | qué hizo el proceso |
| Dónde | Mongo, append-only | pino → Loki |
| Quién lo lee | soporte, conciliación, el replay | ingeniería |
| Granularidad | un documento por entrada, con `seq` | una línea JSON |

**El criterio de existencia de un evento.** Un `MatchEvent` existe **solo si ocurre un hecho que no se
puede reconstruir del comando mismo ni del estado resultante**: una consecuencia computada o un hito
terminal. Regla práctica: *si el payload del evento solo repetiría el del comando, no es un evento.*

De ahí sale la regla que unifica todo:

> **El evento existe ⟺ no hubo comando detrás.**

Un verbo dicho por el jugador ya queda registrado como comando. Dicho por el **sistema** en nombre de
quien calló, se emite **con el nombre del verbo**: el acto es el mismo, lo único que cambia es quién lo
dijo. Sin flags, sin vocabulario paralelo — de qué lado entró al grabador ya lo dice el `source`.

> **Resuelto en el documento de reglas §5.2 (decisión 1):** al vencer el turno el sistema **retira** al
> jugador y no juega por nadie. El mecanismo del historial no dependía de esa elección, y para que de
> verdad no dependa, `MatchHistory.command()` recibe el `source` **por parámetro** en vez de fijarlo en
> `"PLAYER"`. Si algún día el sistema dice un verbo, se graba con el nombre del verbo y
> `source: SYSTEM` sin tocar el grabador.

#### El criterio gobierna el HISTORIAL, no la sincronización

Dos preguntas distintas, y confundirlas es cómo el v1 terminó con `historyMoves` dentro del `Schema`
haciendo de auditoría y de feed de UI a la vez:

| | Historial | Estado sincronizado |
|---|---|---|
| Qué es | un **delta**: el acto o el hecho, en su instante | el **acumulado**: lo que sigue siendo cierto |
| Quién lo lee | soporte, conciliación, el replay | el cliente, incluido el que **reconecta** |
| Criterio | *el evento existe ⟺ no hubo comando detrás* | *¿un cliente que llega tarde necesita saberlo?* |

De ahí salen tres campos que el criterio del historial habría dejado fuera y que el estado **sí**
lleva, cada uno porque un cliente que reconecta no puede reconstruirlo de ningún evento pasado:

- **`Turn.consecutivePasses`** — pasar no pone ficha ni saca del pozo, así que es la única huella que
  un pase deja en el árbol. Sin él, el rival no tiene de dónde enterarse.
- **`Turn.isConsumingExtendedTime`** — los dos tramos del plazo ocurren en la misma fase; sin el
  discriminador el front muestra una cuenta atrás sin saber de cuál.
- **`PlayerState.connected`** — truco no lo tiene (lo cuenta con eventos de plataforma). Acá se
  conserva el del v1, porque "mi rival está caído" tiene que sobrevivir a la reconexión.

**Por eso un historial de solo eventos no alcanza.** Por ese criterio la mayoría de los verbos no
emite nada, así que tendría los desenlaces y **ninguna jugada** — y un hueco justo donde más se
reclama: la jugada que hizo el reloj. Se registran **las dos cosas**, intercaladas en el orden en que
pasaron, con un `seq` único que las ordena entre sí y un `source` que dice por qué boca entró:

```
PLAY_TILE        { playerId: u1, tile: {6,4}, side: RIGHT } PLAYER
DRAW_TILE        { playerId: u2 }                           PLAYER
PASS             { playerId: u2 }                           PLAYER
DEADLINE_EXPIRED { kind: TURN }                             SYSTEM
ABANDON          { playerId: u1 }                           SYSTEM   ← lo retiró el reloj, no se fue
ROUND_RESOLVED   { roundNumber: 1, winnerId: u2, … }        SYSTEM
MATCH_RESOLVED   { winnerTeamId: B, reason: ABANDONMENT }   SYSTEM   ← al ENTRAR a la presentación
DEADLINE_EXPIRED { kind: PRESENTING_MATCH }                 SYSTEM   ← recién acá se apaga la mesa
```

El `source` es un campo y no un adorno: para un reclamo —"yo nunca pasé"— esa es toda la pregunta.

**Fuera quedan** los mensajes **rechazados** (una jugada ilegal es rastro antifraude, no historia de la
partida: va al log) y el **`seed`**.

**El vocabulario es cerrado.** `HistoryEntry.type` no es `string`: es
`keyof CommandPayloads | NetworkMatchEvent["type"]`. Es la corrección del pecado del v1, donde una
entrada era **un solo tipo discriminado por dos booleanos** (`isPassed`/`isLoaded`), de modo que
`isPassed && isLoaded` typechequeaba y no significaba nada. Con el discriminante tipado, grabar el
nombre viejo de un verbo (`LOAD_TILE`) es un error de compilación y no un hallazgo del replay en
runtime.

### 5.2 Colecciones

```
match_history  { matchId, seq, source: PLAYER|SYSTEM, kind: COMMAND|EVENT,
                 type, payload, roundNumber, at }
                 índices: unique { matchId: 1, seq: 1 } · { at: -1 }

match_meta     { matchId, roomId, gameModeId, seats[], operatorIds[], seed,
                 openedAt, closedAt, phase, verdict }
```

El `seed` vive en `match_meta`, nunca en el estado sincronizado ni en el DTO del endpoint de config.

**Una entrada del historial NO lleva `snapshot`.** La primera redacción lo tenía como campo opcional y
nada lo escribía nunca, lo cual es peor que no tenerlo: hacía creer que el replay podía autoverificarse
contra producción. Una entrada es un acto o un hecho —inmutable y de tamaño acotado—; un volcado del
árbol es otra clase de cosa y solo interesa al cierre, así que si alguna vez hace falta va en
`match_meta`. El replay que **afirma** es el de fixtures: el estado final esperado vive en el propio
golden, versionado en el repo. El CLI de soporte reconstruye e imprime, y no compara contra nada.

### 5.3 Quién graba

`MatchHistory` es **per-partida**, lo arma el wiring y la sala lo usa. Tiene dos entradas y un solo
contador:

- **la ruta PLAYER** graba el comando decodificado **antes** de notificar — ese orden *es* el orden del
  registro: primero el acto, después los hechos que provocó;
- **el notificador** lo tiene enganchado como **sink** para los eventos.

Vive en la sala porque es la única capa que ve los dos lados que hay que intercalar. **No se inyecta
una interfaz de historial a los comandos**: rompería la pureza `(payload) → MatchEvent[]`. El
`HistoryPort` devuelve `void`, no promesa —lo llaman el camino de un comando y el de un timer, y
ninguno espera—, y detrás quedan las decisiones de buffering y qué hacer si Mongo falla **sin frenar la
partida**.

Detalle que cuesta una tarde si se descubre tarde: en `@colyseus/schema` 5 los campos dejaron de ser
propiedades propias del objeto, así que `{ ...schemaInstance }` devuelve `{}`. Todo aplanado pasa por
`toJSON()`, recursivo dentro de arrays — si no, una ficha se registra vacía y el replay no reconstruye
nada.

### 5.4 Replay determinista

> Reconstruir una partida = mismo config (mismo `seed`) + mismo `Dealer` + historial de comandos y
> vencimientos reaplicado en orden de `seq`.

Son **las dos únicas entradas del motor**. El `Dealer` deriva cada reparto de `(seed, roundNumber)`
**sin estado mutable**, así que el replay no depende del orden de consumo de ningún RNG: cada ronda es
reproducible de forma aislada.

Dos consumidores:

- `GET /internal/matches/:matchId/history` — para soporte, detrás de la API key interna.
- `npm run replay -- <matchId>` — rebobina e **imprime** el estado final reconstruido; es la
  herramienta de soporte, y no compara contra nada (§5.2). El que **afirma** es
  `match/tests/replay.test.ts`, apuntado a fixtures golden versionados en el repo con su propio
  `finalState`: el test de regresión más fuerte del motor.

### 5.5 Logging

Acá domino va **por delante** de truco, que no tiene librería de logging: son 10 `console.error` con un
prefijo entre corchetes y ninguna correlación. Así que esto no se porta — se **reusa** lo que domino ya
tiene (`src/logger/`: fachada `Logger` + pino + `pino-loki` + `pino-gelf`). No hace falta librería
nueva. Cambian tres cosas:

1. **`logger.child({ matchId, roomId, gameModeId })` se crea una vez en `onCreate`, y nada dentro de
   una partida loguea sin él.** Eso es todo el requerimiento de buscar el log por id de partida:
   `{matchId="…"}` en Loki devuelve la traza completa. El método `child()` ya existe en
   `logger.ts:39` y hoy no se usa en ningún sitio.
2. **`no-console: error`** en eslint, y prohibido `import { logger } from 'colyseus'` fuera del
   adaptador. Los 123 `console.*` sueltos son exactamente por qué el log de hoy no es buscable.
3. **El dominio no loguea.** Solo `transports/` y `network/`. El dominio describe; quien ejecuta,
   cuenta. Los mensajes rechazados van al log con `matchId` + `playerId` + código — están en el log
   *porque* no están en el historial.

### 5.6 La negociación de revancha la hospeda el MOTOR

La primera redacción de este spec la ponía **fuera**, en la capa de aplicación. Truco probó ese camino
y lo descartó, y su changelog v26 dice por qué en una línea: *"cuatro mecanismos en paralelo a los que
la sala ya tiene, para una sola feature"* — su propia puerta de verbos, su propio reloj, su propia
forma de contarle al front en qué fase está.

El argumento que la trae adentro no es de dominó ni de truco: **la negociación es un acto de mesa**,
con oferta, respuesta y plazo, y ese vocabulario ya vive en el motor. El multiplicador de apuesta del
v1 —que tampoco es una regla del dominó, tampoco puntúa, y cuyo significado es económico— es el mismo
caso un piso más abajo:

| | Multiplicador | Revancha |
|---|---|---|
| ¿Regla del dominó? | no | no |
| Negociación | motor | motor |
| Consecuencia económica | app | app (abre la sala siguiente) |
| Lo que el motor sabe de plata | nada | nada |

**No entra en la rebanada de 2P**, pero sí entra la forma: `MatchState.rematch?: RematchOffer`
(`offererId` + `isAccepted`, rama nula) y dos fases de partida (`REMATCH_WINDOW`,
`REMATCH_NEGOTIATION`) entre la presentación y el terminal. Y no lleva `responderId`: el respondedor se
deriva del ofertante, así que sería estado duplicado — el v1 lo tenía y su propio comentario admitía
*"derivable de requesterId"*.

Si el multiplicador se porta, se porta con esta forma y no con la del v1: el valor **acordado** es un
escalar de partida con elemento neutro (`multiplier = 1` es "sin acuerdo", sin rama nula que enumerar),
la **oferta** es una rama nula de la ronda, y los seis valores de enum más el `isActive` del v1
colapsan a *presencia del nodo* + `multiplier > 1`.

### 5.7 `MATCH_RESOLVED` se emite al ENTRAR a la presentación, no al vencerla

Regla de producto: **en lo que finaliza una partida se paga al ganador, haya revancha o no.** El
listener que paga cuelga de `MATCH_RESOLVED`, así que **de dónde se emite ese evento ES la latencia del
premio**. Emitido al vencer la pausa, el pago espera los 6 s de la presentación — y con las dos fases
de revancha del otro lado, hasta 40 s. Truco lo vivió y lo movió (changelog v26 §2).

Consecuencia que hay que ver **antes** de escribirla, y que truco documentó porque la pagó: con fases
después del veredicto, **una guarda de reembolso que compare contra la fase terminal reembolsa una
partida ya pagada**. Se pregunta por el veredicto (`referee.outcome()`), nunca por
`phase === "FINISHED"`.

### 5.8 `RESOLVED` es el veredicto; `FINISHED` es el final

Dos palabras, dos hechos, y en este repo "resolver" significa **dictaminar** (`ROUND_RESOLVED`,
`MATCH_RESOLVED`):

- **`RESOLVED`** — el juego dictaminó. Aparece **solo en eventos**.
- **`FINISHED`** — no queda nada por hacer en esta mesa. Aparece **solo en fases**, y es el único
  terminal: una partida que muere sin veredicto no es una transición del juego (eso lo cuenta
  `MATCH_ABORTED`, evento de plataforma).

Coinciden mientras la partida se apaga al dictaminarse, que es justo por qué la primera redacción usó
`RESOLVED` como nombre de fase sin que chillara nada. **La revancha los separa** y ahí el nombre
repetido pasa a mentir. Las tres pausas se llaman `PRESENTING_ROUND` / `PRESENTING_MATCH` (y
`PRESENTING_VUELTA` en truco), que es como los documentos ya las llamaban en prosa.

Renombrar esto cuesta un find-and-replace mientras es un `.md`, y un commit mecánico sobre código
después. Se hace ahora.

---

## 6. Concurrencia: un motor síncrono, no más mutex

El problema es real y tiene línea: `initializeDeck` espera 3 s y `finishCurrentRound` 6 s **dentro de
la mutación del estado**, y 2P no tiene un solo lock. Cualquier mensaje que llegue en esa ventana corre
sobre estado a medio mutar. Los mutex son el parche; el arreglo es estructural, en cuatro capas:

1. **`Command.execute(payload): readonly MatchEvent[]` es síncrono por contrato.** Cero `await` en el
   camino del comando. Si no hay await, Node no puede entrelazar nada: el handler corre de punta a
   punta sin ceder el event loop, y dos mensajes del mismo cliente **no pueden intercalarse**. Los
   `sleep()` de hoy pasan a ser **fases con plazo** (`PRESENTING_ROUND`, `PRESENTING_MATCH`) estampadas
   en `MatchState.activeDeadline` y ejecutadas por el puerto `TimeoutScheduler`. El motor describe el
   instante; la infraestructura espera.
2. **Toda la red vive en la puerta.** `onJoin` → `admission.admit()` es el único punto de la sala que
   espera red. Cobrar en la puerta es *lo que permite* que el motor sea síncrono: cuando corre el
   primer comando, la plata ya se movió y no queda nada que preguntarle al mundo. Pagos y reportes
   salen **después del hecho**, por listeners con `outbox`.
3. **Frontera anti-trampa antes de tocar un decoder.** `catalog.accepts(type)` con `Object.hasOwn`
   (**no `in`**), payloads con zod, y el `playerId` **fuera del wire**: lo inyecta el decoder desde
   `client.auth`.
4. **Lo demás lo rechaza el dominio**, no un throttle. Un cliente que manda 50 `PLAY_TILE`: el primero
   pasa y muta el turno, los 49 siguientes rebotan con `NOT_YOUR_TURN` porque **leen el estado ya
   mutado**. Más `assertIsPlaying` delante de toda acción de jugador.

**Del mutex sobrevive un solo punto:** `MatchPool.take` en matchmaking, donde dos procesos podrían
llevarse al mismo jugador a dos partidas. Truco lo parkeó porque corre en un proceso; domino ya corre
**PM2 con 2 instancias**, así que `take` nace atómico sobre Redis. Los mutex por sala se borran — uno
de ellos (`domino-four-room.ts:47`) devuelve un `Mutex` nuevo cuando la clave falta, o sea que no
excluye nada, en silencio.

**Idempotencia como sustituto estructural de los locks**, cada pieza en su dueño: `admission.admit`
(se llama en cada conexión), `MatchDriver.begin()` (una reconexión vuelve a completar la mesa),
`Ledger.reserve` (antes de mover plata), `scheduler.schedule` (reemplaza el único timer),
`makePublic` (opera por refId: repetirlo es no-op).

---

## 7. Estado y visibilidad

### 7.1 Cambios de schema

| Cambio | Motivo |
|---|---|
| API builder `schema({…}, "Name")` de schema 5 | Es la API primaria en 5.x y no necesita flags de compilador. **Divergencia menor respecto de truco**, que conservó `@type`: sin decoradores en el estado, vitest no necesita el plugin de SWC que truco usa solo porque esbuild no emite metadata de decoradores. Si aparece fricción, volver a decoradores iguala a truco |
| **`Hand` como nodo MIXTO**: `tileCount` público, `tiles` con `.view()` | Cierra el agujero de trampa sin dejar ciego al front: sabe cuántas fichas tiene el rival, no cuáles. Es el patrón exacto del `PlayedCard` de truco |
| `Boneyard.tiles` con `.view()` y **sin audiencia** | El pozo lo necesita el dominio y no lo ve nadie. Queda en el estado (fuente única) fuera de todo `StateView` |
| `Hand.isRevealed` + `makePublic({kind:"ALL"})` al cierre de ronda | El revelado es decisión **con memoria**, no derivación: vive en el estado, así queda autocontenido para el front y para el replay, y desaparece la consulta de reconexión |
| **`PlayerState.hasSeenTiles`**, y NO es lo mismo que `Hand.isRevealed` | Dos ejes que el v1 habría metido en un booleano. `hasSeenTiles`: el **dueño** levantó sus fichas, una vez por partida, en la ventana de reparto (§7.5). `Hand.isRevealed`: la mano es pública para **todos**, al cerrar cada ronda para contar pips. Que el dueño las vea no las hace públicas; hacerlas públicas al final no dice nada sobre si las levantó al principio |
| El `Dealer` **sin** el puerto de visibilidad | Desde la ventana de reparto no revela nada, así que "repartir no puede filtrar una ficha" es cierto por la forma de la clase y no por un test con un spy (§7.5). Divergencia menor con truco, que conservó el puerto |
| `seed` fuera del estado, en el config inyectado | Sin superficie por donde filtrarse |
| `RoundState.phase` en vez de los booleanos actuales | Un eje, un campo. Hoy `isRoundFinished` + bloqueo derivado + `roundEndReason` codifican el mismo eje tres veces |
| **Fuera `PlacedTile.lockedNumber`** | Derivable de `board.tiles` + `side` con el mismo recorrido que `boardEndsOf`, y `board.tiles` es público, así que el front lo deriva. De paso muere el centinela `-1` del v1 en un campo donde `0` es legítimo (la blanca) |
| **Fuera `PlayerState.score`** | Doble contabilidad del mismo dinero: el marcador es del EQUIPO (`Scoreboard`) y el del jugador es `scoreboard[teamOf(player)]` — incluso en 4P, donde la regla del v1 le daba a los dos compañeros el total idéntico. Truco tampoco lo tiene |
| **Fuera el eje `startedAt` del turno** | El instante de vencimiento vive unificado en `MatchState.activeDeadline`; un segundo timestamp del mismo turno no lo leía nadie. (`MatchState.startedAt` **sí** queda: un instante no se reconstruye de nada, y la app necesita la duración) |
| **`RoundState.boneyard` como RAMA NULA** | Ausente = este modo no tiene pozo (4P: 4×7 = 28 = el set entero). Presente y vacío diría "pozo agotado", que es un hecho distinto justo donde la tranca se calcula distinto. Es la doctrina de ramas nulas de truco (negocio §4.1) aplicada a la divergencia más grande entre 2P y 4P — y es lo que permite **un solo `isBlocked`** en vez del par duplicado del v1 |
| **`RoundState.starterId`** | La ronda siguiente la abre el rival de quien abrió la anterior (reglas §4.1); el doble-seis decide solo la ronda 1. Sin el campo no hay de dónde sacar la alternancia una vez que el turno se movió. El v1 lo tenía (`currentRoundStarterId`) |
| **`PlayerState.extraTimeRemainingMs`** | El tiempo extra pasa de gracia por turno (v1) a **reserva por partida que solo decrece** (modelo de truco). Un saldo con memoria no es un parámetro de config: es estado |
| **`Turn.isConsumingExtendedTime`** y **`Turn.consecutivePasses`** | Los dos existen para el cliente que **llega tarde**: los dos tramos del plazo ocurren en la misma fase, y un pase no deja huella en el tablero ni en el pozo. Ver §5.1 |
| Sin campos derivados, **con un criterio** | Si se calcula de otro dato es consulta pura del módulo dueño. **Excepción única: se guarda cuando el cliente NO puede derivarlo** —porque su fuente está gateada (`Hand.tileCount`, `BoneyardState.count`) o porque derivarlo exigiría reimplementar una regla del juego (`Hand.isRevealed`)—. Sin este criterio escrito, la regla parece rota en tres lugares y el próximo campo derivado entra por discusión en vez de por pregunta |
| **Los ejes son `t.string()` en el wire, pero NO en las reglas** | Colyseus no sincroniza uniones discriminadas, así que en el árbol `phase`/`side`/`reason` son string (es lo que truco documenta como "schema ancho", negocio §4.1). El cast vive en **un solo archivo**, `state-projections.ts` (`sideOf`, `roundPhaseOf`, `matchPhaseOf`), y de ese lado el motor compara contra uniones cerradas. Sin eso, un `side === "Left"` compila, deriva la cadena por el lado equivocado, y como los extremos son derivados el tablero entero queda mal sin que nada reviente |
| **Un solo `RoundState` para 2P y 4P**, con `teams` en el config | Hoy los dos son ~95 % idénticos, `PlayerHand` está duplicado, y el torneo importa el de 2P y reimplementa el reparto. Tres implementaciones de la misma regla obligadas a coincidir. **Con una advertencia**: ver §7.6 |
| Revisar el cap de **63 campos** por clase | En 0.18 **lanza en la definición**, e incluye los heredados |

### 7.2 Visibilidad: dos piezas, una por cada lado de la frontera

1. **El campo de dominio** (`isRevealed`) es la fuente de verdad. El front lee el estado sincronizado y
   deriva por sí mismo qué mostrar, sin preguntar nada al backend.
2. **El puerto `SchemaVisibilityController`**, con `Audience = PLAYER | TEAM | ALL`, ejecuta el
   `view.add`. Es agnóstico al atributo de negocio.

Revelar son dos líneas explícitas en el módulo dueño:

```ts
hand.isRevealed = true                                  // verdad de negocio
this.visibility.makePublic(hand.tiles, { kind: 'ALL' }) // efecto de infra
```

La atomicidad de esas dos líneas es **disciplina, no estructura** — y por eso el smoke test de
visibilidad no es "recomendado": es la garantía real de este punto.

### 7.3 La vista es del ASIENTO, no del socket

Las `StateView` se crean en `onCreate`, **una por asiento y antes de que se conecte nadie**, y el
controlador resuelve la audiencia sobre ese mapa.

Si se resolviera sobre `room.clients`, Colyseus ya borró al cliente caído de esa lista antes de llamar
a cualquier hook, así que lo revelado mientras estabas fuera **no llegaría nunca a tu vista y volverías
ciego** — incluso reusándola. Es el bug que truco documenta en `arquitectura-app-e-infra-v11.md` §5.4.1,
y es el que hace que "resuscribir la vista" no alcance.

Efecto colateral útil: el controlador deja de conocer el `Client` de Colyseus, así que se prueba sin
levantar una sala.

### 7.4 El plazo es un instante absoluto en epoch, y el front recibe una muestra del reloj

`MatchState.activeDeadline` es un **instante**, no un resto que baje. Eso es lo que borra el patch por
segundo del v1: el servidor lo estampa una vez por transición y no lo vuelve a tocar.

El costo se lo lleva el cliente: para dibujar la cuenta atrás tiene que restarle "ahora", y **su reloj
puede estar corrido** —móvil sin NTP, zona mal configurada, emulador—. Con el reloj adelantado cinco
minutos, el jugador ve el turno ya vencido. Es el único punto donde el modelo nuevo le complica la vida
al front, y el v1 no lo tenía porque mandaba un entero pre-decrementado.

**Decisión: `GET /config/:roomId` devuelve `serverNow` (una muestra de `Date.now()` del servidor).** El
cliente calcula `offset = serverNow - Date.now()` una vez y dibuja
`activeDeadline - (Date.now() + offset)`. Se re-muestrea al reconectar, que es cuando el drift importa.

**Por qué no la maquinaria de Colyseus.** El accesor previsto para esto es `room.clock.serverNow()`,
pero su estimador **solo existe en salas que llaman `defineInput()`** —el camino de predicción, con
schema de input, timestep fijo y `step()`—; una sala por turnos se queda con *"un stub que lee tu reloj
local"*, que es exactamente el bug. Y `serverNow()` está en **ms desde el arranque de la sala**, otra
timeline que la de `activeDeadline`. La propia doc bendice la salida: *"¿traés tu propio algoritmo de
sync? `room.clock = new MyClock()`"*. `serverNow` **es** ese algoritmo, en su versión mínima.

**Por qué epoch y no la timeline de la sala.** Alinearse con `serverNow()` exigiría estampar sobre
`room.clock.currentTime` (ms desde el arranque), y ahí `HistoryEntry.at` y `MatchState.startedAt`
dejarían de servir: soporte necesita *"esto pasó a las 14:32"* y la app necesita el instante absoluto
de arranque para la duración. Serían **dos relojes** en el motor —uno de pared para el registro, uno de
sala para los plazos— y un eje nuevo que confundir, por un problema de presentación. Un solo reloj de
pared, y el front corrige con una resta.

**Error residual:** medio round-trip, decenas de ms contra una ventana de 60.000. Si alguna vez hace
falta afinarlo, `client.getLatency({ pingCount: 5 })` mide el RTT antes de unirse.

### 7.5 La ventana de reparto: repartir no revela

**La regla está en `reglas-de-juego-v1.md` §3.1.** Acá va lo que le toca a la arquitectura, que es
poco — y que sea poco es el punto.

Portado de truco (negocio v27 §12.7). Al empezar la partida las fichas se reparten pero **no se hacen
públicas**, y cada jugador levanta las suyas con `REVEAL_TILES` dentro de 15 s. En dominó pesa más que
en truco: 7 fichas dicen bastante sobre si conviene jugar esa mano, así que **ver el reparto y salirse
gratis sería elegir con qué reparto jugar**. Levantar las fichas ES la prueba de presencia.

**Ocultar no es un mecanismo.** No hay nada que esconder: la ficha se adjunta al árbol y simplemente
**todavía no se hizo pública para nadie**, que es el estado natural de cualquier nodo con `.view()`
(§7.2). Repartir dejó de llamar a `makePublic`; lo llama el verbo. De ahí que la feature entera no
traiga maquinaria de visibilidad nueva — es **una línea menos** en el `Dealer`, no una más.

Y una consecuencia que conviene cobrar: **el `Dealer` deja de recibir el puerto de visibilidad**. La
invariante "repartir no puede filtrar una ficha" pasa de ser un test con un spy a ser cierta por la
forma de la clase. Truco conservó el puerto; acá se saca.

**Las piezas, y ninguna es nueva:**

| Pieza | Qué suma |
|---|---|
| `RoundPhase.DEALING` | la fase que ya estaba declarada. Ahora tiene plazo, así que **es** una fase (un estado que espera algo) |
| `PlayerState.hasSeenTiles` | público: el front tiene que poder decir a quién se espera. No se resetea entre rondas — la ventana es solo la de la 1 |
| `RoundPlayer.revealTiles()` | marca y hace pública su propia mano. Va en el jugador de la RONDA porque es quien sostiene el puerto de visibilidad |
| `RoundReferee` | `assertCanRevealTiles` (fase + una sola vez, **sin turno**: los dos miran a la vez) y `playersWithoutTilesSeen()` |
| `RoundDriver` | `begin()` estampa el plazo solo en la ronda 1; `advance()` sale cuando no falta nadie; `resumeAfterDealWindow()` cierra |
| `MatchDriver` | el vencimiento, porque su consecuencia es **retirar** gente y `hasAbandoned` lo escribe solo `MatchPlayer`. Acá el reparto de niveles difiere de truco a propósito: el plazo es de ronda, la consecuencia es de partida |

**Dos valores de audiencia, no tres.** `Audience = PLAYER | ALL`. No hay EQUIPO, porque en dominó no
existe ninguna mecánica que le muestre algo a tu compañero y no a la mesa: no hay señas legales, no hay
intercambio de fichas entre compañeros (el `SHARING_CARD` del truco de 4), y no hay jugadas tapadas —
una ficha en la mesa es pública siempre. La primera redacción traía la tercera rama de truco, con un
`case` inalcanzable y un test afirmando que lanzaba. Ver `reglas-de-juego-v1.md` §3.1.1 para la lista
completa de lo que dominó **no** tiene.

**Y la trampa que esa lista destapa, que sí es de arquitectura.** El revelado del cierre de ronda
muestra las manos a **todos**, y `hand.tiles` es el **mismo nodo** ronda a ronda: `clear()` no lo saca
de ninguna `StateView`. Así que el conductor **des-revela** antes de repartir
(`RoundPlayer.hideTiles`), o desde la segunda ronda cada mano nace pública para la mesa entera. Es el
agujero del v1 reabierto por la puerta de atrás, y no lo atraparía ningún test de la ronda 1. Es la
única razón por la que el puerto tiene `hide`, y está escrito para que nadie lo borre por "no lo usa
nadie".

**Y el matiz que no es de arquitectura sino de plata: `MatchReferee.outcome()` devuelve `undefined`
con los DOS equipos retirados.** Preguntando por un equipo primero, el orden de evaluación corona al
otro y una partida que nadie jugó **paga premio**. Era inalcanzable antes —el primer forfeit resolvía
la partida y ya no quedaba a quién retirar—; el vencimiento de esta ventana puede retirar a varios de
una. Truco lo descubrió implementándola; acá nace cubierto, con su test en `deal-window-e2e`.

De ahí sale también el tercer `AbortReason`: **`NEVER_PLAYED`**. Los tres reembolsan, pero soporte
tiene que poder distinguir "nunca se llenó" (`NEVER_STARTED`) de "se llenó, se repartió, y nadie
apareció".

### 7.6 Dónde el motor unificado NO puede unificar: 2P puntúa por jugador, 4P por equipo

Truco es **siempre** por equipos: el 1v1 son equipos de uno, y toda la cobranza es de equipo. Ese es
el modelo que este spec porta, y por eso `PlayerState.teamId` y `Scoreboard` existen también en las
mesas de dos.

**En dominó eso es cierto para el marcador pero NO para el conteo**, y ahí está el riesgo del motor
único:

| Regla | 2P | 4P |
|---|---|---|
| Quién gana la tranca | el jugador con menos pips en mano | el **equipo** con menos pips sumando a los dos compañeros; empata si los totales coinciden |
| Cuánto cobra el que cierra por dominó | los pips del rival | los pips de los **dos** del equipo perdedor — no de los otros tres asientos |

Las dos funciones que implementan esto (`blockVerdictOf`, `opposingHandsValue`) están escritas para
2P, que es la rebanada, y **quedan marcadas en el código con esa advertencia**. Es deliberado no
generalizarlas todavía: una implementación de 4P sin sus tests sería adivinar. Lo que no puede pasar es
que 4P las herede en silencio — el motor es uno, así que nada chillaría. Cuando entre 4P, se parten en
dos o toman la agrupación (jugador / equipo) como parámetro.

**La lección general, para el próximo port desde truco:** las reglas de truco que se adoptan sin
pensar son las que *no se notan*, porque son las que coinciden en las mesas de dos. Adoptar "todo es
equipo" es correcto para el marcador y equivocado para el conteo, y la mesa de dos no distingue las dos
cosas.

---

## 8. Reconexión

**Decisión:** se conserva la ventana de reconexión, con los hooks nuevos de 0.18. Se evaluó y **se
descartó** el modelo de truco (sin ventana; volver es un `joinById`).

```ts
onDrop(client, code)  { this.allowReconnection(client, 120); player.connected = false; this.unlock() }
onReconnect(client)   { player.connected = true; notify PLAYER_RECONNECTED; this.relockIfFull() }
onLeave(client, code) { notify PLAYER_DISCONNECTED }   // NO saca al jugador de la partida
```

**El `unlock()` no es opcional: es lo que evita el bug de `maxClients`.** Mientras `allowReconnection`
está pendiente, Colyseus sostiene el asiento por `sessionId` y `hasReachedMaxClients()` lo **cuenta**:
la sala queda llena y el matchmaker **rechaza el `joinById`** de quien perdió su token —app matada,
recarga de página, otro dispositivo—, o sea que lo deja fuera de su propia partida. Y cancelar la
reserva desde `onJoin` llega tarde: el rechazo ocurre antes de que ese hook corra.

**Consecuencia de diseño: `maxClients` deja de ser la puerta de seguridad** y queda como tope de
llenado. La puerta es `onJoin`, en este orden:

```
seats.includes(playerId)  →  isStillPlaying(playerId)  →  admission.admit()   (idempotente)
```

Un intruso falla el primer check. Si al llegar hay una reconexión pendiente **o** un cliente vivo para
ese asiento, se cancela/desplaza: **una conexión por asiento, gana la más nueva**, y ese
desplazamiento **no se cuenta como caída**.

**La ventana no pausa el reloj del juego.** El plazo real lo pone el motor, así que la duración de la
ventana no es crítica: si el motor ya retiró al jugador, `isStillPlaying` rechaza igual. **120 s**, en
vez de los 300 s de hoy.

Cerrar el socket **no es rendirse** —para eso está el verbo `ABANDON`—, así que `onLeave` solo cuenta
el hecho; al jugador lo retira el motor por timeout, que es decisión de dominio.

**Muere `src/sessions/sessions.service.ts` (341 líneas)** con su contador de `reconnectionFailures`, su
cron y su `remoteRoomCall(roomId, '_forceClientDisconnect', …)` (API interna de Colyseus). No hace falta
persistir el `reconnectionToken` ni el `GET /reconnection`: la recarga de página se resuelve por
`LiveMatches.matchOf(playerId)` → `gateway.rejoin(roomId)`, que además es el camino de la sesión única.

**Frontend:** la UI de "reconectando…" sale gratis con `room.onDrop()` / `room.onReconnect()`, que
operan sobre **la misma instancia** de `Room` con los callbacks intactos. Ojo con la recarga:
`client.reconnect(token)` devuelve una `Room` **nueva** y hay que re-enganchar los callbacks.
`room.onLeave(code)` con `FAILED_TO_RECONNECT` (4003) es donde se ofrece el reingreso.

---

## 9. Matchmaking

Se porta el mecanismo actual —que es bueno y ya tiene self-checks— a la forma de truco: `core/` puro
más puertos.

- **`core/grouping.ts`** — quiénes juegan juntos **y en qué orden**. En truco el orden *es* la
  asignación de equipos; acá no, porque las parejas se sortean (§4.3), así que lo que este archivo
  decide es el `seats[]` que recibe la política. Va con test propio igual: es lo que fija el orden de
  turno, y con el orden equivocado la partida corre perfecto con los jugadores sentados mal.
  **Como la formación de equipos ya no separa cómplices**, la defensa contra colusión recae entera
  sobre lo de abajo. El veto se comprueba en **todos los pares** del grupo, no solo entre rivales:
  en una mesa de 4 también cuenta que dos cómplices caigan como compañeros.
- **`core/cooldown.ts`** — la escalera 2 s → 7 s sobre ids barajados, que ya existe en
  `matchmaking-cooldown.service.ts:42-48`. Que los retrasos sean **desiguales** es todo el punto: si
  los dos reentraran a la vez, ninguno estaría esperando y el escape del veto no tendría a quién
  emparejar.
- **Puertos**: `pool.ts` (`take` atómico en Redis), `gateway.ts` (el único importador de `matchMaker`),
  `pool-spec.ts`, `catalog.ts`, `live-matches.ts`.
- **`veto.ts`** — **un solo libro** con eje `scope` (casual global 30 min / torneo por torneo 6 h),
  unificando `pair-veto.service.ts` y `tournament-veto.service.ts`. El keyspace queda **común** entre
  operadores y se prefija el **id**, no el set: la colusión cross-operador es precisamente lo que hay
  que detectar.
- **`soft-profile.ts`** — el filtro blando del core-loop (winrate, ventana de protección). Es propio de
  domino; truco no lo tiene. Falla **abierta** (sin perfil, no filtra), como hoy.
- **`antifraud-flag.ts`** — **corrige el fail-open actual**: hoy un error asume `false` y desactiva la
  protección, o sea que quien tumbe ese endpoint apaga el veto. Ante error, **el veto sigue vigente**.
- **`filterBy(['poolId'])`** en las salas y contadores del lobby segmentados. El punto único es la
  reserva de asiento: cambiar el filtro ahí propaga a todo.
- Se conserva el **hasheo de ids** en `metadata.waitingPlayerIds` —Colyseus difunde la metadata a todo
  el lobby— y el escape del veto por espera.

**La sala nace LLENA**, y eso borra una clase entera de bugs. El gateway abre la partida en dos pasos de
0.18 sin hueco entre ellos:

```ts
const room  = await matchMaker.createRoom('domino', options)
const seats = await matchMaker.reserveMultipleSeatsFor(room, sessionIds)  // los N asientos, de una
```

Hoy se hace `createRoom` + `joinById` por jugador, y por ese hueco se cuelan las carreras que
`MAX_JOIN_ATTEMPTS = 3` intenta tolerar y las salas huérfanas que `disposeOrphanWaitingRooms()` limpia
después. **Las dos piezas se borran.** Y como la génesis del `MatchState` se arma de `options.seats`,
tampoco hay que admitir un estado de un jugador, que no es una mesa legal.

**El cliente recibe una reserva opaca, no un `roomId`**, y el token se verifica **dos veces** (lobby y
sala): la reserva no lleva identidad adentro, y pasar `authData` haría que Colyseus **saltee el hook
`onAuth`**.

---

## 10. Manejo de errores

Jerarquía declarada donde vive cada eslabón: `DominoError` (raíz) → `MatchError` (dominio, con
`RuleViolationError` e `InvariantViolationError`) / `NetworkError` / `ColyseusError`.

| Clase | Qué significa | Qué se hace |
|---|---|---|
| `RuleViolationError` | jugada ilegal | `client.send('illegal', { code })`. **Log sí, historial no** |
| `ValidationError` | payload malformado | `code: 'MALFORMED'` |
| `UnknownCommandError` | verbo inexistente | `code: 'UNKNOWN_COMMAND'` |
| `AdmissionRefusedError` / `InvalidTokenError` | rechazo de la puerta | traducido a rechazo de conexión |
| `InvariantViolationError` y cualquier otra | **bug**: el estado dejó de ser confiable | log + cerrar la partida |

**Una sola política**, en `onUncaughtException`, con **lista blanca explícita** de lo que no es bug. Sin
esa lista, un rechazo legítimo de la puerta —saldo insuficiente, no inscrito— se trata como bug y
**cierra la partida de los que sí habían entrado**. Es un bug real que la suite de truco encontró.

Cuatro reglas más, todas por la misma razón (un solo proceso con todas las partidas adentro):

- **`onMessage` no está envuelto en 0.18**: el handler nunca debe hacer `throw`.
- **`unhandledRejection` mata el proceso**: handler global más `.catch()` en cada `void promise`.
- **`unref()` en todos los timers**, para que uno dormido no impida el apagado ordenado.
- **Disyuntor en la cascada de listeners**: un listener que reacciona a lo que él mismo produce cuelga
  la partida en un bucle mudo. Superar el límite no es "quedó corto", es un ciclo →
  `InvariantViolationError`.

---

## 11. Testing

| Nivel | Dónde | Qué |
|---|---|---|
| Unitario | **colocado** al lado del archivo; >1 test ⇒ subcarpeta `tests/` | funciones puras: set de fichas, extremos del tablero, jugada legal, tranca, conteo, `grouping`, `cooldown` |
| De comando | fixture `buildEngine` sobre un `MatchState` de prueba + fakes de puertos, **sin tsyringe** | cada verbo: estado resultante y eventos emitidos |
| De feature | `features/<f>/tests/` | colaboración entre partes de una misma feature |
| E2E de partida | `match/tests/e2e-harness.ts`, con wire real | partida completa 2P y 4P contra el documento de reglas |
| E2E con SDK real | contra `boot(appConfig)` con `@colyseus/testing` 0.18 | ciclo de vida y los tres caminos de reconexión |
| **Smoke de visibilidad** | `match/tests/visibility.smoke.test.ts` | dos clientes falsos; **en cada fase**, que el rival no reciba ninguna ficha ajena ni del pozo, y que `isRevealed` y el `StateView` coincidan tras cada comando que revela |
| **Replay** | `match/tests/replay.test.ts` sobre fixtures golden | rebobinar y afirmar estado final idéntico |
| Arquitectura | dependency-cruiser como test | las cuatro reglas de imports |
| Criterio de eventos | `match/core/commands/` | que los verbos de negociación **no** emitan evento, que los computados y terminales **sí**, y la simetría de §5.1 |

**Los tres seams que hacen determinista el motor**, los tres portados de truco:

| Seam | Para qué |
|---|---|
| `Dealer.orderedTiles()` **`protected`** → `FixedDealer` en tests | Forzar manos exactas. **Sin esto no se puede testear la tranca, el conteo ni el empate**: hay que poder repartir la mano que produce el caso |
| `noopScheduler` + `matchDriver.timeout()` a mano | El engine nunca espera tiempo real |
| `clockBox = { now }` inyectado como `Clock` | Plazos, cooldowns y decay sin `setTimeout` |

`signatureOf(state)` en el harness E2E —una firma del estado: fase, turno, marcador, ofertas abiertas—
permite **esperar a que el servidor procesó el mensaje** en vez de dormir un tiempo arbitrario. Trampa
documentada: si un verbo no cambia la fase (negociar una apuesta es un overlay del turno), hay que
incluir su rama en la firma o el helper cuelga. Cada suite E2E arranca en un **puerto fijo propio**,
porque corren en paralelo.

Los fakes siguen la regla del código: el fake de un puerto de match vive en `match/tests/fakes/`, no
baja a `shared/`. Los seis `.demo.ts` de hoy —que viven dentro de `src/` y se compilan a `build/`— pasan
a ser `*.test.ts` de vitest.

---

## 12. Riesgos

| Riesgo | Cómo se controla |
|---|---|
| **El documento de reglas no existe**, y las reglas viven en tres implementaciones duplicadas que difieren entre sí | Escribirlo es la primera tarea y la más fácil de subestimar. Se escribe leyendo el código y **anotando cada divergencia entre 2P, 4P y torneo** como decisión explícita, no como detalle |
| El refactor se desborda: es el camino crítico de `ruta-critica.md` y su mayor incertidumbre | Se acota tomando truco como referencia en vez de diseñar de cero. Cada incremento es una rebanada jugable que se integra con el frontend antes de seguir |
| Divergencia de reglas entre v1 y v2 durante el solapamiento | Los fixtures golden del replay se generan **del v1** y se corren contra el v2: si el v2 no reproduce una partida real del v1, hay una regla que se leyó mal |
| Cutover con dos backends en producción | El v1 no se toca. La deuda del camino del dinero (~1 semana) se paga **en el v1**, en paralelo, porque afecta a los jugadores de hoy con o sin socio |

---

## 13. Divergencias deliberadas respecto de truco

Resumen, para que ninguna se lea como descuido:

| # | Divergencia | Razón |
|---|---|---|
| 1 | El anillo se llama **`network/`**, no `betaso/` | El contenido ya no es lo que hace Betaso con una partida sino lo que hace la red. La regla de truco es nombrar por contenido (§3.6) |
| 2 | Nace **`features/operator/`** | Truco no tiene ni necesita multi-operador (§4.2) |
| 3 | `auth` resuelve el verificador **por `iss`/`kid`** | Truco tiene un secreto escalar; un segundo operador exigiría un segundo proceso |
| 4 | `history/` nace con **adaptador Mongo real y replay** | En truco es memoria y está parkeado en su Inc. 13. Acá es el requerimiento (§5) |
| 5 | **Logging estructurado con `child({matchId})`** obligatorio | Truco no tiene librería de logging. Domino ya la tiene y no la usa (§5.5) |
| 6 | **`pool.take` atómico en Redis** desde el día uno | Truco lo parkeó porque corre en un proceso; domino ya corre 2 instancias PM2 (§6) |
| 7 | `antifraud-flag` falla **cerrado** | Corrige el fail-open del domino actual (§9) |
| 8 | **Con ventana de reconexión** (120 s) más `unlock()` | Truco no tiene ventana. Se conserva la UX de reconexión automática del SDK, resolviendo el conteo de `maxClients` (§8) |
| 9 | **API builder de schema 5** en vez de `@type` | Sin decoradores en el estado, el runner de tests no necesita el plugin de SWC (§7.1) |
| 10 | `soft-profile` en matchmaking | Filtro del core-loop propio de domino |

Y **una simplificación respecto del domino actual** que vale registrar: `RoundState` deja de estar
triplicado (2P / 4P / torneo) y pasa a ser uno, con `teams` en el config.
