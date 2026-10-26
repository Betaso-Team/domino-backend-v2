# La conexión de cada asiento: ping, caídas y de quién fue la culpa

Diseño, 2026-10-26. Pedido del dueño del producto; lo va a leer el panel (Tablea) en el detalle de
cada partida.

## Por qué

Hoy, cuando un jugador se cae, el registro de la partida (`match_history`, v2.1) dice una sola cosa:
`players[].exit.reason = "DISCONNECTED"`, y sólo si la caída terminó en retiro. No dice:

- **cuándo** se cayó (sólo cuándo el reloj lo retiró);
- las caídas de las que **volvió** (`onDrop` no deja nada en el registro, sólo una línea de log);
- **cómo** se cerró el socket (Colyseus pasa el código a `onDrop(client, code)` y `domino-room.ts`
  lo ignora);
- **qué ping tenía** antes de caerse.

Con eso, el que mira el panel no puede contestar la pregunta que importa: **¿la caída fue culpa
nuestra, del internet del jugador, o se fue a propósito?** Hay plata de por medio y reclamos de
jugadores; hoy se contestan a ojo.

El modelo es el de los shooters competitivos (Valorant y parecidos): el servidor mide el ping de
cada jugador todo el tiempo, y ante una caída se mira la evidencia —ping, fluctuación, quién cerró
el socket, cómo estaba el servidor— y no la palabra del cliente.

Truco no tiene nada de esto. **Es pieza nueva y queda como el estándar** para los juegos de Betaso
Games: la forma del dato está pensada para que truco la copie tal cual.

## Qué es el éxito

Abrir una partida en el panel y, por cada jugador, ver:

1. su ping durante la partida (promedio, peor, fluctuación, sondeos perdidos);
2. cada caída y cada vuelta, con hora y mano;
3. para cada caída, un veredicto —**NUESTRA**, **RED** o **INTENCIONAL** (o **DESCONOCIDA**)— con la
   evidencia que lo sostiene, de modo que una persona pueda estar en desacuerdo con el veredicto
   mirando los mismos números.

## Metas, no-metas y anti-metas

**Metas**

- Medir el ping de cada asiento **desde el servidor**, sin cambios en el front.
- Registrar toda caída, vuelta y salida definitiva con su evidencia.
- Clasificar cada caída con una regla pura, testeable y versionada.
- Que el dato llegue al panel por las rutas que ya existen (`GET /internal/matches/:matchId`,
  `GET /game-data/:roomId`), sin endpoint nuevo, y que el panel lo muestre legible (segunda parte,
  abajo).

**No-metas (por ahora)**

- **Mover plata por el veredicto.** Es diagnóstico: el registro explica, no reembolsa. Si algún día
  «culpa nuestra» devuelve la entrada, eso es del orquestador y es otro incremento. *(Decisión de
  diseño, tomada sin respuesta explícita del dueño; ver «Llamadas mías».)*
- Mostrarle el ping a los jugadores en la mesa (el icono de «mala conexión» de Valorant). La medición
  lo deja posible; publicarlo en el estado sincronizado es una decisión del front.
- Filtrar el listado del panel por veredicto. Con el dato guardado, es un índice y un parámetro más.
- Mandar el dato al orquestador en el resultado de `betaso_games`.
- Usarlo en el replay. El replay rebobina el juego; la conexión no es juego.

**Anti-metas — lo que lo haría un fracaso aunque funcione**

- **Culpar al jugador de lo que fue nuestro.** Si el servidor estaba trabado y el veredicto dice RED,
  el panel le da la razón a la casa con un dato falso. Por eso NUESTRA se evalúa primero.
- **Confiar en lo que reporta el cliente para decidir la culpa.** Un cliente puede inventar su ping.
  Todo lo que entra al veredicto lo midió el servidor.
- **Un documento que crece sin techo.** Una partida larga con un jugador inestable no puede inflar
  `match_history`: se guarda resumen, no cada muestra, y las caídas tienen tope.
- **Un sondeo que mueve el juego.** Medir no puede cambiar ni un plazo ni un estado del motor.

## Lo que hay hoy (medido sobre `node_modules`, Colyseus 0.18)

- `@colyseus/ws-transport` ya le manda un **ping de WebSocket** a cada socket cada 3 s y lo corta
  (`terminate()`) tras 2 sin respuesta (`WebSocketTransport.mjs:161`). No mide nada: sólo resetea un
  contador en `pong`. El navegador y React Native contestan esos pings solos, en la capa de red.
- `client.ref` es el `WebSocket` de `ws` (`WebSocketClient`), así que la sala puede llamar
  `client.ref.ping(payload)` y escuchar `client.ref.on("pong", data => …)`. El `pong` devuelve el
  `payload`, y los pings del transporte van sin payload: los nuestros se distinguen por construcción.
- `CloseCode` (`@colyseus/shared-types`): `1000` normal, `1001` going away (cerró pestaña/app),
  `1005` sin código, `1006` anormal (el socket murió sin cierre: red caída, o `terminate()` nuestro),
  `4000` consentido, `4001` apagado del servidor, `4002` con error, `4010` puede reintentar (el
  apagado en modo dev).
- `onDrop(client, code?)` y `onLeave(client, code?)` reciben el código; `domino-room.ts:409` y `:445`
  no lo leen.
- **Un cierre consentido (`4000`) nunca pasa por `onDrop`**: va directo a `onLeave`
  (`Room.mjs:1445`). Y `4000` no es sólo del cliente: la sala lo emite ella misma al vencer la espera
  del rival (`domino-room.ts:340`), al desplazar una conexión vieja (`:394`, `:437`) y al rechazarse
  el cobro (`:644`), porque `disconnect()` usa `CONSENTED` por defecto (`Room.mjs:1008`).
- **Después de una caída, `onLeave` recibe el código ORIGINAL de la caída** (`Room.mjs:1466-1476`),
  no uno propio.
- **Hoy la sala no sabe que se está apagando hasta `onDispose`** (`domino-room.ts:462`), cuando los
  clientes ya se fueron. Sólo `4001`/`4010` (`Room.mjs:424-425`) lo delatan.
- El transporte detecta un socket muerto recién a los 6–9 s (`WebSocketTransport.mjs:162-169`), y su
  `heartbeat` resetea el contador con CUALQUIER `pong`, el nuestro incluido (`:10-12`, `:175`). Es
  inofensivo: un cliente muerto no contesta ni uno ni otro.
- El SDK del cliente tiene `room.ping(cb)` y `room.clock.rtt()/smoothedRtt()/jitter()`. **No se usan
  en este diseño** (anti-meta: no se confía en el cliente). Y `room.clock` **no serviría igual**: su
  RTT viaja en los acks de input, y una sala que nunca llama `defineInput()` le deja al cliente un
  reloj de mentira (skill `colyseus`, `references/netcode.md:162`). El dominó no define input.
- **`1001` no es «se fue»**: el SDK lo trata como caída y reintenta solo (`onDrop` del cliente con
  `1005`, `1006`, `1001` y `4010`, `references/client-sdk.md:1083-1088`). Un `1001` es cerrar la
  pestaña o la app, pero también **recargar la página**, que vuelve con su token.
- **En el apagado ordenado `onLeave` llega con `4001` para todos** (`references/room.md:1027`), y
  `onBeforeShutdown` es el hook que corre antes (`references/room.md:1130`).

## Cómo funciona

### 1. La sonda (servidor, por asiento)

Cada `PROBE_INTERVAL_MS` (2 000 ms) la sala manda `client.ref.ping(nonce)` a cada asiento
conectado, con un `nonce` propio (contador + id de sala, unos pocos bytes) y anota el instante. El
`pong` con ese `nonce` da una muestra de RTT. Un sondeo sin `pong` antes del siguiente cuenta como
**perdido**.

- Corre en el reloj de la sala y se apaga en `onDispose`. Con la sala vacía no corre.
- Usa el reloj monotónico (`performance.now()`), no `Date.now()`: un ajuste del reloj del sistema no
  puede fabricar un ping negativo o de un minuto.
- Por asiento se lleva, en memoria:
  - **resumen de la partida**: muestras, promedio, máximo, perdidos, fluctuación;
  - **ventana reciente**: las últimas `RECENT_SAMPLES` (10, o sea ~20 s) muestras, perdidas incluidas
    (`null`), que es lo que se congela junto a cada caída;
  - **último pong**: instante del último `pong` recibido, propio o del transporte.
- **Fluctuación** al estilo RFC 3550: `J += (|RTTᵢ − RTTᵢ₋₁| − J) / 16`. Es lo que el SDK llama
  `jitter()`, medido del lado que no puede mentir.
- **Perdido cuenta sólo si DESPUÉS llegó un pong.** Los sondeos sin respuesta del final, los que
  siguen al último pong, no son mala conexión: son la caída misma, que el transporte tarda 6–9 s en
  notar (3 o 4 sondeos). Contarlos haría que toda caída se lea como `POOR_CONNECTION` y que
  `CONNECTION_LOST` no salga nunca. La ventana reciente que se congela con la caída termina en el
  último pong; lo que vino después se resume en `sinceLastPongMs`.

### 2. La salud del servidor

Un `perf_hooks.monitorEventLoopDelay()` por proceso, leído en el instante de cada caída (p99 y
máximo de la ventana, después `reset()` periódico). Un event loop trabado hace que el servidor
conteste tarde a TODOS: eso es lag nuestro aunque el ping de un solo jugador lo muestre.

Junto a cada caída se guarda además cuántos de los **otros** asientos conectados de la mesa tenían
su ping reciente por encima de `HIGH_RTT_MS` en el mismo momento. Si a todos se les fue el ping a la
vez, el problema no está en la casa de uno.

### 3. Los hechos de conexión

La sala anota un hecho por cada transición:

| hecho | cuándo | lo que lleva |
|---|---|---|
| `DROPPED` | `onDrop`, **y también el desplazamiento**: el jugador vuelve con sesión nueva antes de que el transporte note muerta la vieja, y la sala cierra la vieja con `4000` (`domino-room.ts:394`). En el celular es probablemente la caída más común, y hoy no deja ningún rastro porque `onLeave` sale temprano (`:447`). Se anota con `closeCode: null`, `replacedBySession: true` y la evidencia de la sesión vieja | código de cierre, ms desde el último pong, ventana reciente, salud del servidor, si la sala se estaba apagando, veredicto |
| `RECONNECTED` | `onReconnect`, la vuelta por asiento nuevo (`domino-room.ts:400`) y el desplazamiento | ms que estuvo afuera |
| `GONE` | `onLeave` sin vuelta | ver abajo |

- **`GONE` después de un `DROPPED`** (vence la ventana): repite el código de la caída
  (`Room.mjs:1466-1476`), así que no lleva veredicto propio; lleva `afterDrop: true` y el panel lee el
  del `DROPPED`.
- **`GONE` sin caída previa** es un cierre consentido (`onLeave` directo): lleva su propio veredicto.
- **Los cierres que hace la sala** (espera del rival vencida, cobro rechazado, conexión desplazada) se
  marcan ANTES de cerrar el socket (`closedByRoom` con el motivo), así que su `onLeave` no se lee como
  intencional del jugador. El desplazamiento ya quedó como `DROPPED`; los otros dos pasan antes de que
  la partida arranque o después del veredicto, y no producen hecho.
- **Sólo se anota hasta el cierre del registro.** `MatchHistory.close` escribe una vez
  (`history.ts:495-497`) y llega con el veredicto; lo que pase después —la gente que se va de la
  mesa ya resuelta— no le cambia nada a la partida y se pierde a propósito. Lo que importa, la caída
  que terminó en retiro, siempre pasa antes: el `DROPPED` se anota en el instante, y el retiro del
  reloj va antes que el veredicto.
- **El apagado se marca en `onBeforeShutdown`** (la sala lo sobrescribe para prender una marca), así
  que se ve aunque el cliente cierre antes de recibir el `4001`.

Además, una línea de log estructurada por hecho (`info`), con `matchId`, `playerId` y el veredicto,
para verlo en vivo sin esperar al cierre.

### 4. El veredicto: una regla pura

`connectionVerdictOf(evidence)` en `features/match/network/` (no es regla de juego, así que no va a
`core/rules/`). Se evalúa **en este orden**, y el orden es la anti-meta: lo nuestro primero.

1. **NUESTRA / `SERVER_SHUTDOWN`** — la sala se estaba cerrando por apagado (la marca de
   `onBeforeShutdown`, o `4001`). **`4010` solo no alcanza**: el apagado en modo dev lo usa, pero
   el SDK también lo manda él mismo cuando el navegador dispara el evento `offline`
   (`@colyseus/sdk/build/Connection.mjs:28`), o sea cuando el jugador se quedó sin red.
2. **NUESTRA / `SERVER_OVERLOAD`** — p99 del event loop ≥ `EVENT_LOOP_LAG_MS` (500), **o** al menos
   la mitad de los otros asientos conectados con ping alto a la vez (y al menos uno).
3. **NUESTRA / `SERVER_ERROR`** — código `4002`.
4. **INTENCIONAL** — el cliente cerró prolijamente, en dos causas distintas:
   - `LEFT_THE_TABLE`: `4000` en un `onLeave` sin caída previa y sin marca `closedByRoom`. Apretó
     salir: es lo único inequívoco.
   - `CLOSED_APP`: `1000` o `1001` en `onDrop`. Cerró la pestaña o la app, **o recargó**. Si después
     viene un `RECONNECTED`, fue una recarga, y el panel lo ve en la línea siguiente; el veredicto no
     se reescribe.
5. **RED / `WENT_OFFLINE`** — `4010` sin marca de apagado: el navegador avisó que perdió la red.
5b. **RED / `POOR_CONNECTION`** — `1005`/`1006` o desplazamiento, y la ventana reciente (hasta el
   último pong) muestra mala conexión: mediana ≥ `HIGH_RTT_MS` (300), **o** fluctuación ≥
   `HIGH_JITTER_MS` (100), **o** ≥ 3 sondeos perdidos con un pong después.
6. **RED / `CONNECTION_LOST`** — `1005`/`1006` o desplazamiento con la ventana reciente sana: se
   cortó de golpe.
7. **DESCONOCIDA** — cualquier otro código, o sin muestras para juzgar.

El veredicto se guarda **con** su evidencia y con `verdictVersion: 1`. Es lo único derivado que se
guarda, y se guarda a propósito: el panel muestra lo que se concluyó en el momento, y si mañana la
regla cambia, el número de versión dice con cuál se juzgó y la evidencia permite rejuzgar.

El retiro por el verbo `ABANDON` no pasa por acá: ya queda como `exit.reason = "LEFT"`, que es
intencional por definición.

### 5. Dónde queda en el registro

Un campo nuevo por jugador en `match_history`, `players[].connection`, escrito en el **cierre** (lo
lleva `MatchHistory.close`, que ya arma `players`):

```ts
interface SeatConnection {
  readonly rtt: {
    readonly samples: number;
    readonly avgMs: number;
    readonly maxMs: number;
    readonly jitterMs: number;
    readonly lostProbes: number;
  };
  readonly events: readonly ConnectionEvent[]; // tope: MAX_CONNECTION_EVENTS (50); se marca `truncated`
  readonly truncated?: true;
}

type ConnectionEvent =
  | { kind: "DROPPED"; at: Date; roundNumber: number; closeCode: number | null;
      replacedBySession?: true;
      sinceLastPongMs: number | null; recentRttMs: (number | null)[];
      server: { eventLoopP99Ms: number; othersWithHighRtt: number; othersConnected: number;
                shuttingDown: boolean };
      verdict: { blame: "OURS" | "NETWORK" | "INTENTIONAL" | "UNKNOWN"; cause: string;
                 verdictVersion: 1 } }
  | { kind: "RECONNECTED"; at: Date; roundNumber: number; awayMs: number }
  | { kind: "GONE"; at: Date; roundNumber: number; closeCode: number | null;
      afterDrop?: true;                       // sin veredicto propio: vale el del DROPPED
      verdict?: { blame: …; cause: string; verdictVersion: 1 } };
```

- Instantes como fecha BSON, como el resto del registro v2.1.
- **Es aditivo**: los documentos viejos no lo tienen y los lectores lo tratan como ausente. No cambia
  la versión del registro (`MATCH_RECORD_VERSION` sigue `2.1`).
- Los dos adaptadores (`MemoryHistory`, `MongoHistory`) lo guardan igual; el contrato compartido de
  `transports/tests/history-contract.ts` lo cubre.
- `exit.reason = "DISCONNECTED"` se conserva tal cual: lo leen otros. La explicación vive al lado.

### 6. Lo que NO toca

- Ningún campo del estado sincronizado: el cliente no recibe nada nuevo y no hay ruptura de wire.
- Ningún plazo del motor. La sonda no decide quién se retira: eso sigue siendo del reloj del turno y
  de la ventana de reconexión.
- El `pingInterval` del transporte, que sigue siendo quien corta sockets muertos.

## Segunda parte: el panel (Tablea, repo aparte)

El panel ya existe: `Tablea-Gaming-Panel`, worktree de Orca `tarpon`. Lo que hace hoy y lo que importa
para esto:

- El detalle (`apps/web/src/features/matches/components/match-detail.tsx`) arma la tabla «Jugadores»
  desde `players[]` y traduce `exit.reason` en la columna «Salida» (`EXIT_LABEL`). Debajo muestra el
  documento entero en un árbol JSON.
- La API del panel (`apps/api/src/features/matches/domain/match.ts`) pasa el registro como
  `Record<string, unknown>`: **el campo nuevo no rompe nada** y aparece en el árbol desde el primer
  despliegue del dominó, aunque el panel no cambie.
- La partida cuyo proceso murió ya se ve: el estado «Sin cierre» (`UNCLOSED_AFTER_MS`, una hora en
  `started`) dice «el servidor se cayó a mitad de partida». Es el hueco del `kill -9`, ya cubierto.

Lo que se le agrega, después de que el dominó despliegue:

1. **En la tabla «Jugadores»**, al lado de la salida, el veredicto de la caída que terminó en retiro
   («Desconectado · Internet malo», «Desconectado · Culpa nuestra») y una columna **Ping** con
   promedio y peor valor.
2. **Una sección «Conexión»** debajo de la tabla: por jugador, la lista de hechos en orden —hora, mano,
   caída o vuelta, veredicto en castellano, y la evidencia que lo sostiene (código, ping de los
   segundos previos, salud del servidor)—. Un `RECONNECTED` justo después de un `CLOSED_APP` se lee
   como «recargó».
3. **Los textos en castellano** viven en el panel, como `END_REASON` y `EXIT_LABEL`: el dominó guarda
   códigos (`OURS`, `CONNECTION_LOST`…), el panel los traduce. Un código desconocido se muestra tal
   cual, que es lo que ya hacen esas tablas.
4. Registros viejos sin `connection`: la columna muestra `-` y la sección no aparece.

## Constantes

Viven juntas en un solo archivo, con nombre y comentario, y los tests las importan:
`PROBE_INTERVAL_MS = 2000`, `RECENT_SAMPLES = 10`, `HIGH_RTT_MS = 300`, `HIGH_JITTER_MS = 100`,
`LOST_PROBES_POOR = 3`, `EVENT_LOOP_LAG_MS = 500`, `MAX_CONNECTION_EVENTS = 50`. No son editables en
caliente en esta versión.

## Huecos conocidos

- **Minimizar la app en el celular se ve como RED.** iOS y Android matan el socket en segundo plano y
  el servidor ve un `1006` igual que un wifi caído. Separarlo pide ayuda del front (fase 2, abajo).
- **Una caída del proceso (`kill -9`, OOM) no deja hechos**: la memoria de la sala muere con él y el
  registro queda abierto en `started`. Esa marca ya dice «la interrumpimos nosotros»; registrarlo
  como hecho de conexión es otro incremento.
- **El ping de WebSocket mide la red y la pila del cliente**, no cuánto tarda en dibujar el juego. Un
  teléfono saturado con buena red da ping bajo. Es lo que miden también los shooters.

## Fase 2, opcional y fuera de este diseño: lo que puede sumar el front

Un mensaje `CLIENT_CONNECTION` (validado y con tope de frecuencia) con `visibility: hidden|visible`,
y opcionalmente el ping que mida el front con `room.ping()` (no `room.clock`, que sin `defineInput()`
no mide nada). Entraría como evidencia **marcada como del
cliente**: puede convertir una RED en INTENCIONAL / `APP_BACKGROUNDED`, nunca una NUESTRA en otra
cosa.

## Lo que se deja al que construye

- Dónde exactamente vive el monitor por asiento (una pieza en `transports/colyseus/` inyectada a la
  sala es lo natural) y cómo llega al grabador al cierre.
- El nombre exacto de los archivos y los tests, siguiendo las reglas de imports del repo.
- Cómo se mide en los e2e: cerrar un socket con `1001`, con `terminate()` (1006) y por apagado, y
  afirmar el veredicto en el documento guardado.

## Llamadas mías (para que el dueño las revise)

- **Solo diagnóstico, sin efecto en la plata.**
- Las cuatro etiquetas y el orden de evaluación, con NUESTRA primero.
- Los umbrales de arriba (300 ms, 100 ms, 3 perdidos, 500 ms de event loop): son valores de partida
  razonables para un juego por turnos, no medidos con jugadores reales.
- Guardar resumen y caídas, no cada muestra.
- Sin cambios en el front en esta versión.
- Que el desplazamiento (volver con sesión nueva) cuente como caída + vuelta.
- Que lo que pase después del cierre del registro no se anote.
- Que los sondeos sin respuesta del final no cuenten como perdidos.
- El orden: primero el dominó (el dato), después el panel (mostrarlo). Son dos repos y dos planes.
- Qué muestra el panel: veredicto junto a la salida, columna de ping y sección «Conexión».
