# La conexión de cada asiento — plan de implementación (dominó)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** que el registro de cada partida guarde el ping de cada asiento medido por el servidor, cada caída/vuelta/salida con su evidencia, y un veredicto de quién tuvo la culpa.

**Architecture:** una regla pura (`network/connection.ts`) decide el veredicto a partir de la evidencia. Un monitor por sala (`transports/colyseus/connection-monitor.ts`) sondea cada socket con `ws.ping(nonce)`, junta muestras y anota hechos. La sala lo alimenta desde sus hooks (`onJoin`, `onDrop`, `onReconnect`, `onLeave`, `onBeforeShutdown`). El grabador (`MatchHistory`) le pide la conexión de cada asiento al cerrar y la guarda en `players[].connection`.

**Tech Stack:** TypeScript, Colyseus 0.18 (`@colyseus/core` 0.18.15, `ws`), `node:perf_hooks`, vitest, Mongo.

**Spec:** `docs/superpowers/specs/2026-10-26-conexion-ping-y-culpa-de-las-caidas-design.md`. Esta es la primera parte. El panel (segunda parte) se planea aparte, en su repo, después de desplegar esto.

## Global Constraints

- Gate: `npm run typecheck && npm test && npm run lint` en verde antes de cada commit; `npm run format` antes de commitear.
- Sin dependencias nuevas.
- Comentarios y mensajes en español, con la densidad del archivo que se toca.
- Reglas de imports de `AGENTS.md`: `network/` no importa de `transports/`; `@/` al salir del módulo.
- Ningún campo nuevo en el estado sincronizado (sin ruptura de wire). Ningún plazo del motor cambia.
- `MATCH_RECORD_VERSION` sigue `2.1`. El campo es aditivo: un registro sin `connection` es válido.
- Instantes guardados como fecha BSON; duraciones como número.
- Constantes con estos valores exactos: `PROBE_INTERVAL_MS = 2_000`, `RECENT_SAMPLES = 10`, `HIGH_RTT_MS = 300`, `HIGH_JITTER_MS = 100`, `LOST_PROBES_POOR = 3`, `EVENT_LOOP_LAG_MS = 500`, `MAX_CONNECTION_EVENTS = 50`, `CONNECTION_VERDICT_VERSION = 1`.
- Commits en español, imperativo, tipo convencional con alcance, cuerpo con el porqué, terminando en `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Un jugador que se cae y vuelve muchas veces**: los hechos tienen tope de 50 y el asiento queda `truncated: true`, sin perder el resumen de ping. → Task 3, test `tope de hechos`.
2. **Un pong de un socket viejo que llega después de que el asiento volvió con otro**: no puede sumar una muestra a la conexión nueva. → Task 3, test `pong del socket reemplazado`.
3. **Una caída antes del primer pong**: resumen con `samples: 0`, `avgMs: 0` (nunca `NaN`), y el veredicto sale igual por el código. → Task 1 y Task 3.
4. **Asientos que nunca tuvieron socket** (bots, el que nunca entró): el jugador se guarda sin `connection`. → Task 2.
5. **Una caída durante el apagado con código 1006**: es NUESTRA, no RED. → Task 1, fila de la tabla.

---

### Task 1: La regla del veredicto

**Files:**
- Create: `src/features/match/network/connection.ts`
- Modify: `src/features/match/network/index.ts` (exportar lo nuevo)
- Test: `src/features/match/network/tests/connection.test.ts`

**Interfaces:**
- Produces (en `network/connection.ts`):
  - Las ocho constantes de Global Constraints.
  - `type ConnectionBlame = "OURS" | "NETWORK" | "INTENTIONAL" | "UNKNOWN"`
  - `type ConnectionCause = "SERVER_SHUTDOWN" | "SERVER_OVERLOAD" | "SERVER_ERROR" | "LEFT_THE_TABLE" | "CLOSED_APP" | "WENT_OFFLINE" | "POOR_CONNECTION" | "CONNECTION_LOST" | "UNKNOWN_CLOSE"`
  - `interface ConnectionVerdict { readonly blame: ConnectionBlame; readonly cause: ConnectionCause; readonly verdictVersion: typeof CONNECTION_VERDICT_VERSION }`
  - `interface ServerHealth { readonly eventLoopP99Ms: number; readonly othersWithHighRtt: number; readonly othersConnected: number; readonly shuttingDown: boolean }`
  - `interface DropEvidence { readonly closeCode: number | null; readonly replacedBySession: boolean; readonly recentRttMs: readonly (number | null)[]; readonly jitterMs: number; readonly server: ServerHealth }`
  - `interface RttSummary { readonly samples: number; readonly avgMs: number; readonly maxMs: number; readonly jitterMs: number; readonly lostProbes: number }`
  - `type ConnectionEvent` — la unión del spec §5 con `at: number` (epoch ms; el adaptador lo convierte a fecha):
    - `{ kind: "DROPPED"; at; roundNumber; closeCode: number | null; replacedBySession?: true; sinceLastPongMs: number | null; recentRttMs: (number | null)[]; server: ServerHealth; verdict: ConnectionVerdict }`
    - `{ kind: "RECONNECTED"; at; roundNumber; awayMs: number }`
    - `{ kind: "GONE"; at; roundNumber; closeCode: number | null; afterDrop?: true; verdict?: ConnectionVerdict }`
  - `interface SeatConnection { readonly rtt: RttSummary; readonly events: readonly ConnectionEvent[]; readonly truncated?: true }`
  - `function isHighRtt(recentRttMs: readonly (number | null)[]): boolean` — mediana de los no nulos ≥ `HIGH_RTT_MS`; `false` sin muestras.
  - `function isPoorConnection(recentRttMs: readonly (number | null)[], jitterMs: number): boolean` — `isHighRtt`, o `jitterMs ≥ HIGH_JITTER_MS`, o nulos ≥ `LOST_PROBES_POOR`.
  - `function connectionVerdictOf(evidence: DropEvidence): ConnectionVerdict`

- [ ] **Step 1: Escribir el test que falla**

Un `it.each` sobre la tabla del veredicto, en este orden, con `base` = `{ closeCode: 1006, replacedBySession: false, recentRttMs: [80, 90, 85], jitterMs: 5, server: { eventLoopP99Ms: 20, othersWithHighRtt: 0, othersConnected: 1, shuttingDown: false } }`:

| caso | cambio sobre `base` | blame / cause |
|---|---|---|
| apagado aunque el código sea 1006 | `server.shuttingDown: true` | `OURS` / `SERVER_SHUTDOWN` |
| 4001 | `closeCode: 4001` | `OURS` / `SERVER_SHUTDOWN` |
| event loop trabado | `server.eventLoopP99Ms: 500` | `OURS` / `SERVER_OVERLOAD` |
| a todos se les fue el ping | `server.othersWithHighRtt: 1, othersConnected: 1` | `OURS` / `SERVER_OVERLOAD` |
| nadie más conectado no es sobrecarga | `server.othersWithHighRtt: 0, othersConnected: 0` | `NETWORK` / `CONNECTION_LOST` |
| 4002 | `closeCode: 4002` | `OURS` / `SERVER_ERROR` |
| salió con el botón | `closeCode: 4000` | `INTENTIONAL` / `LEFT_THE_TABLE` |
| cerró o recargó | `closeCode: 1001` | `INTENTIONAL` / `CLOSED_APP` |
| cierre normal | `closeCode: 1000` | `INTENTIONAL` / `CLOSED_APP` |
| el navegador avisó offline | `closeCode: 4010` | `NETWORK` / `WENT_OFFLINE` |
| 4010 en apagado | `closeCode: 4010, server.shuttingDown: true` | `OURS` / `SERVER_SHUTDOWN` |
| corte de golpe | (base) | `NETWORK` / `CONNECTION_LOST` |
| 1005 | `closeCode: 1005` | `NETWORK` / `CONNECTION_LOST` |
| ping alto antes | `recentRttMs: [400, 350, 500]` | `NETWORK` / `POOR_CONNECTION` |
| fluctuación | `jitterMs: 100` | `NETWORK` / `POOR_CONNECTION` |
| tres perdidos | `recentRttMs: [80, null, null, null, 90]` | `NETWORK` / `POOR_CONNECTION` |
| desplazado sin código | `closeCode: null, replacedBySession: true` | `NETWORK` / `CONNECTION_LOST` |
| sin muestras | `recentRttMs: []` | `NETWORK` / `CONNECTION_LOST` |
| código desconocido | `closeCode: 4500` | `UNKNOWN` / `UNKNOWN_CLOSE` |
| sin código y sin desplazar | `closeCode: null` | `UNKNOWN` / `UNKNOWN_CLOSE` |

Cada fila afirma `toEqual({ blame, cause, verdictVersion: 1 })`. Más dos `it` sueltos: `isHighRtt([])` es `false`; `isHighRtt([100, 300, 900])` es `true` (mediana 300).

- [ ] **Step 2: Correrlo y verlo fallar**

Run: `npx vitest run src/features/match/network/tests/connection.test.ts`
Expected: FAIL, no resuelve `../connection`.

- [ ] **Step 3: Implementar `network/connection.ts`**

Las reglas se evalúan en el orden de la tabla. «A todos se les fue el ping» es `othersConnected > 0 && othersWithHighRtt * 2 >= othersConnected`. Dejar un `ponytail:` sobre esa regla: en 2P un solo rival con mal internet alcanza para culpar al servidor; si en el panel aparecen falsos NUESTRA, se sube el piso a dos asientos.

- [ ] **Step 4: Correrlo y verlo pasar**

Run: `npx vitest run src/features/match/network/tests/connection.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate y commit**

```bash
npm run typecheck && npm run lint
git add src/features/match/network/connection.ts src/features/match/network/index.ts src/features/match/network/tests/connection.test.ts
git commit -m "feat(match): la regla que dice de quién fue la culpa de una caída"
```

---

### Task 2: El registro guarda la conexión de cada asiento

**Files:**
- Modify: `src/features/match/network/history.ts` (`StoredPlayer`, `MatchHistory`)
- Modify: `src/features/match/network/transports/stored-record.ts` (`storedClosingOf`)
- Test: `src/features/match/network/tests/history.test.ts`
- Test: `src/features/match/network/transports/tests/history-contract.ts`

**Interfaces:**
- Consumes: `SeatConnection`, `ConnectionEvent` (Task 1).
- Produces:
  - `StoredPlayer` gana `readonly connection?: SeatConnection`.
  - `MatchHistory.trackConnections(source: (playerId: PlayerId) => SeatConnection | undefined): void`. `close()` llama al `source` por asiento y agrega `connection` solo si no es `undefined`. Sin `trackConnections`, `close()` se comporta como hoy.
  - `storedClosingOf` convierte `players[].connection.events[].at` a `Date`; el resto de la conexión queda igual.

- [ ] **Step 1: Escribir los tests que fallan**

En `history.test.ts`, al lado de los `close(ENDING)` existentes:
- `"el cierre lleva la conexión que le da la sala, y nada para el asiento sin socket"`: `trackConnections(id => id === "seat-1" ? CONN : undefined)`, cerrar, y afirmar que el jugador `seat-1` del cierre tiene `connection: CONN` y que `seat-2` **no tiene la clave** (`not.toHaveProperty("connection")`).
- `"sin trackConnections el cierre no cambia"`: ningún jugador tiene la clave `connection`.

En `history-contract.ts`, un `it` nuevo después de «al cerrar»: `"al cerrar: la conexión de cada asiento, con los instantes de sus hechos como fechas"`. Cierra un `CLOSING` cuyo `players[0]` lleva `connection: { rtt: { samples: 3, avgMs: 85, maxMs: 90, jitterMs: 4, lostProbes: 0 }, events: [DROPPED en at 20_000 con verdict NETWORK/CONNECTION_LOST, RECONNECTED en at 25_000 con awayMs 5_000] }`, y afirma con `toMatchObject` que vuelve con `events[0].at === new Date(20_000)`, `events[1].at === new Date(25_000)`, `rtt` idéntico y `verdict` idéntico.

- [ ] **Step 2: Correrlos y verlos fallar**

Run: `npx vitest run src/features/match/network/tests/history.test.ts src/features/match/network/transports/tests`
Expected: FAIL, `trackConnections` no existe y `at` vuelve como número.

- [ ] **Step 3: Implementar** en `history.ts` y `stored-record.ts` según Interfaces.

- [ ] **Step 4: Verlos pasar, y la suite contra Mongo si hay uno a mano**

Run: `npx vitest run src/features/match/network`
Expected: PASS.
Opcional: `MONGO_INT_URI=mongodb://127.0.0.1:27017/domino_int npm run test:int`, que corre el mismo contrato contra Mongo.

- [ ] **Step 5: Gate y commit**

```bash
npm run typecheck && npm run lint
git add src/features/match/network
git commit -m "feat(history): el cierre guarda la conexión de cada asiento"
```

---

### Task 3: El monitor de conexión

**Files:**
- Create: `src/shared/event-loop-lag.ts`
- Create: `src/features/match/transports/colyseus/connection-monitor.ts`
- Test: `src/features/match/transports/colyseus/connection-monitor.test.ts`

**Interfaces:**
- Consumes: todo lo de Task 1.
- Produces:
  - `src/shared/event-loop-lag.ts`: `export function eventLoopP99Ms(): number`. Arranca perezoso un `monitorEventLoopDelay({ resolution: 20 })` la primera vez, lo resetea cada 10 s con un `setInterval(...).unref()`, y devuelve `percentile(99) / 1e6` en ms. Sin test: es un envoltorio de `perf_hooks`.
  - `connection-monitor.ts`:
    - `interface ProbeSocket { ping(data: Buffer): void; on(event: "pong", listener: (data: Buffer) => void): unknown; off(event: "pong", listener: (data: Buffer) => void): unknown }`
    - `function probeSocketOf(ref: unknown): ProbeSocket | undefined` — devuelve el `ref` solo si tiene `ping`, `on` y `off` como funciones. Otro transporte (H3) queda sin sonda en vez de reventar.
    - `interface ConnectionMonitorDeps { readonly monotonicNow: () => number; readonly wallNow: () => number; readonly eventLoopP99Ms: () => number }`
    - `class ConnectionMonitor`:
      - `constructor(deps: ConnectionMonitorDeps)`
      - `attach(playerId: PlayerId, socket: ProbeSocket): void` — suelta el listener del socket anterior del asiento, si había, y escucha `pong` en el nuevo.
      - `probe(): void` — manda `socket.ping(nonce)` a cada asiento con socket y anota `monotonicNow()`. El nonce es un contador `UInt32BE` de 4 bytes, propio del monitor.
      - `dropped(playerId, ctx: { closeCode: number | null; roundNumber: number; shuttingDown: boolean; replacedBySession?: true }): ConnectionEvent` — arma la evidencia, la juzga con `connectionVerdictOf`, anota el hecho, marca el asiento afuera desde `wallNow()` y suelta el socket.
      - `reconnected(playerId, roundNumber: number): ConnectionEvent | undefined` — solo si el asiento estaba afuera; `awayMs = wallNow() − instante de la caída`.
      - `gone(playerId, ctx: { closeCode: number | null; roundNumber: number; shuttingDown: boolean }): ConnectionEvent` — si el asiento estaba afuera, `afterDrop: true` sin `verdict`; si no, juzga con evidencia propia (`replacedBySession: false`).
      - `connectionOf(playerId): SeatConnection | undefined` — `undefined` si el asiento nunca tuvo socket.
      - `dispose(): void` — suelta todos los listeners.

Reglas de las muestras, que el test fija:
- Un `pong` cuyo payload es un nonce pendiente da una muestra `monotonicNow() − envío`. Los pendientes **anteriores** a ese nonce pasan a perdidos: `null` en la ventana y `lostProbes + 1`. Los posteriores siguen pendientes.
- Un `pong` sin payload (el del transporte) o con nonce desconocido solo actualiza el último pong.
- Ventana reciente: últimas `RECENT_SAMPLES` entradas, muestras y `null` mezclados, en orden de llegada.
- Fluctuación: `J += (|RTTᵢ − RTTᵢ₋₁| − J) / 16`, desde la segunda muestra.
- `sinceLastPongMs`: `monotonicNow()` menos el último pong, o `null` si nunca hubo uno.
- `server.othersConnected`: los demás asientos con socket en este momento. `othersWithHighRtt`: cuántos de ellos dan `isHighRtt` sobre su ventana.
- Hechos: tope `MAX_CONNECTION_EVENTS`; el que sobra no se agrega y el asiento queda `truncated: true`.

- [ ] **Step 1: Escribir los tests que fallan**

Doble de socket: un `EventEmitter` con `ping = vi.fn()`. Responder es `socket.emit("pong", socket.ping.mock.calls[i][0])`. Reloj: dos variables que el test avanza a mano.

- `"una sonda contestada da una muestra con su tiempo de ida y vuelta"`: probe en t=0, pong en t=80 → `connectionOf().rtt` es `{ samples: 1, avgMs: 80, maxMs: 80, jitterMs: 0, lostProbes: 0 }`.
- `"un sondeo sin respuesta cuenta perdido solo cuando llega uno posterior"`: tres probes, solo se contesta el tercero → `lostProbes: 2`; tres probes sin contestar y después `dropped` → `lostProbes: 0` y `recentRttMs` sin `null` del final.
- `"la ventana guarda las últimas diez"`: 12 muestras → `dropped(...).recentRttMs` tiene largo 10 y empieza en la tercera.
- `"pong del socket reemplazado"`: `attach(seat, a)`, probe, `attach(seat, b)`, `a.emit("pong", nonce)` → `samples: 0`.
- `"el pong del transporte no es muestra pero cuenta como señal de vida"`: pong con `Buffer.alloc(0)` en t=500, `dropped` en t=700 → `samples: 0` y `sinceLastPongMs: 200`.
- `"caída antes del primer pong"`: `dropped` sin muestras → `rtt.avgMs === 0` y `sinceLastPongMs === null`.
- `"la caída lleva la salud del servidor"`: rival con muestras de 400 ms; `dropped(seat-1)` → `server` es `{ eventLoopP99Ms: <deps>, othersWithHighRtt: 1, othersConnected: 1, shuttingDown: false }` y `verdict.blame === "OURS"`.
- `"caída, vuelta y salida definitiva"`: `dropped` en wall 10_000, `reconnected` en 13_000 → `awayMs: 3_000`; otro `dropped` y `gone` → `{ kind: "GONE", afterDrop: true }` sin `verdict`.
- `"una salida sin caída lleva su propio veredicto"`: `gone({ closeCode: 4000 })` → `verdict.cause === "LEFT_THE_TABLE"`.
- `"vuelta sin caída no anota nada"`: `reconnected` sin `dropped` → `undefined`.
- `"tope de hechos"`: 26 pares `dropped`/`reconnected` (52 hechos) → `events.length === 50`, `truncated: true`.
- `"probeSocketOf rechaza lo que no es un ws"`: `probeSocketOf({})` y `probeSocketOf(undefined)` dan `undefined`.

- [ ] **Step 2: Correrlos y verlos fallar**

Run: `npx vitest run src/features/match/transports/colyseus/connection-monitor.test.ts`
Expected: FAIL, no resuelve el módulo.

- [ ] **Step 3: Implementar** `event-loop-lag.ts` y `connection-monitor.ts` según Interfaces.

- [ ] **Step 4: Verlos pasar**

Run: `npx vitest run src/features/match/transports/colyseus/connection-monitor.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate y commit**

```bash
npm run typecheck && npm run lint && npm run depcruise
git add src/shared/event-loop-lag.ts src/features/match/transports/colyseus/connection-monitor.ts src/features/match/transports/colyseus/connection-monitor.test.ts
git commit -m "feat(match): el monitor que sondea cada socket y anota caídas y vueltas"
```

---

### Task 4: La sala alimenta al monitor

**Files:**
- Modify: `src/features/match/transports/colyseus/domino-room.ts`
- Test: `src/features/match/tests/connection.e2e.test.ts` (nuevo, puerto `2640`)
- Modify: `AGENTS.md` (bloque nuevo al final de los incrementos), `docs/operacion.md` (cómo leer `players[].connection`)

**Interfaces:**
- Consumes: `ConnectionMonitor`, `probeSocketOf`, `PROBE_INTERVAL_MS` (Tasks 1 y 3); `eventLoopP99Ms` (Task 3); `MatchHistory.trackConnections` (Task 2).
- Produces: nada que otra tarea use.

Cableado, punto por punto:
- `onCreate`: `this.connections = new ConnectionMonitor({ monotonicNow: () => performance.now(), wallNow: () => Date.now(), eventLoopP99Ms })`. Después de `this.history = pieces.history`, llamar `this.history.trackConnections((id) => this.connections.connectionOf(id))`. La sonda va por el reloj de la sala: `this.probing = this.clock.setInterval(() => this.connections.probe(), PROBE_INTERVAL_MS)`.
- Ronda actual: `this.state.currentRound?.roundNumber ?? 0`, en un helper privado `roundNow()`.
- `onJoin`: si `previous.length > 0` (desplazamiento), antes de echar a los anteriores: `connections.dropped(playerId, { closeCode: null, roundNumber, shuttingDown, replacedBySession: true })` y después `connections.reconnected(...)`. Si `isBack`, `connections.reconnected(...)`. En los dos casos, `const socket = probeSocketOf(client.ref); if (socket) connections.attach(playerId, socket)`.
- `onDrop(client, code?)`: `connections.dropped(playerId, { closeCode: code ?? null, ... })`, con `shuttingDown: this.shuttingDown`.
- `onReconnect`: después de la guarda del desplazado, `connections.reconnected(...)` y `attach` del socket nuevo.
- `onLeave(client, code?)`: después de la guarda temprana existente, y solo si `!this.closingByRoom`: `connections.gone(playerId, { closeCode: code ?? null, ... })`.
- `onBeforeShutdown()`: override que prende `this.shuttingDown = true` y llama `super.onBeforeShutdown()`.
- `closingByRoom = true` justo antes de los dos `disconnect()` propios: el plazo de ocupación vencido y el cobro rechazado. No en `crash()`: su `4002` tiene que llegar al veredicto.
- `onDispose`: `this.probing?.clear()` y `this.connections?.dispose()`.
- Log `info` por hecho anotado: `"conexión"` con `{ playerId, kind, closeCode, blame, cause }`.

- [ ] **Step 1: Escribir el e2e que falla**

`connection.e2e.test.ts`, con `bootServer(2640)`, `seatPair`, `revealHands` y `recordOf` (copiar el helper de `match-record.e2e.test.ts`). Para cerrar la partida, el otro jugador manda `ABANDON` después de lo que se mide, y se espera el cierre del registro con `waitUntil(closed, 3_000)`.

- `"el registro guarda el ping de los dos asientos"`: jugar unos turnos con `playOneTurn` durante al menos 2,5 s, cerrar, y afirmar en los dos jugadores `connection.rtt.samples >= 1` y `avgMs >= 0`.
- `"cerrar la app es intencional, y la vuelta queda anotada"`: `clientOf(match,"c1").reconnection.minUptime = 0`, `clientOf(match,"c1").connection.close(1001)`, esperar `connected === true` de vuelta, cerrar la partida → `events[0]` es `{ kind: "DROPPED", closeCode: 1001, verdict: { blame: "INTENTIONAL", cause: "CLOSED_APP" } }` y `events[1].kind === "RECONNECTED"`.
- `"un socket que muere de golpe es la red"`: del lado del servidor, `matchMaker.getLocalRoomById(match.roomId)` y `terminate()` del `ref` del cliente de `c1` (encontrarlo por `userData.playerId`), esperar `connected === false`, cerrar → el `DROPPED` lleva `closeCode: 1006` y `verdict.blame === "NETWORK"`.
- `"volver con otra sesión es caída y vuelta"`: `rejoinAs(server, match, "c1")` con el socket viejo vivo → `DROPPED` con `replacedBySession: true` seguido de `RECONNECTED`.

- [ ] **Step 2: Correrlo y verlo fallar**

Run: `npx vitest run src/features/match/tests/connection.e2e.test.ts`
Expected: FAIL, el jugador del registro no tiene `connection`.

- [ ] **Step 3: Cablear la sala** según la lista de arriba.

- [ ] **Step 4: Verlo pasar, y la suite entera**

Run: `npx vitest run src/features/match/tests/connection.e2e.test.ts`, después `npm run typecheck && npm test && npm run lint && npm run depcruise`.
Expected: PASS en todo. Si `game-2p.e2e` se pone rojo, el golden no debería cambiar (la conexión no está en `finalState` ni en `meta`): investigar antes de regrabar.

- [ ] **Step 5: Documentar**

`AGENTS.md`: bloque «Incremento completo — la conexión de cada asiento», con el porqué, la tabla del veredicto en una línea por regla, los dos hallazgos del SDK (`4010` lo manda el navegador al quedar offline; `room.clock` sin `defineInput()` no mide) y la baseline nueva. `docs/operacion.md`: cómo leer `players[].connection` en un reclamo, en cinco líneas.

- [ ] **Step 6: Gate y commit**

```bash
npm run format && npm run typecheck && npm test && npm run lint
git add src/features/match/transports/colyseus/domino-room.ts src/features/match/tests/connection.e2e.test.ts AGENTS.md docs/operacion.md
git commit -m "feat(match): la sala anota el ping, las caídas y la culpa de cada asiento"
```
