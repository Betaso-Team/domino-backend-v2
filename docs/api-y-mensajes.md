# API HTTP y mensajes

El juego usa WebSocket/Colyseus para la partida y HTTP para configuración, operación, catálogo y la
API del orquestador. No hay Swagger: los mensajes de sala no son HTTP y los contratos se mantienen
tipados en el código.

## Salas Colyseus

| Sala | Quién entra | Estado principal |
|---|---|---|
| `domino` | Participante reservado con JWT válido | Partida, ronda, jugadores, tablero, pozo, turnos y deadlines |

Es la única sala. No hay lobby ni emparejamiento en este servidor: los hace el orquestador, que abre
cada mesa por `POST /internal/matches` y le entrega a cada jugador su reserva de asiento. El jugador
se conecta con esa reserva y su JWT; el `sub` del token es el `userId` con el que el orquestador lo
sentó, normalizado con `trim()`.

## Mensajes de la sala `domino`

| Tipo | Payload del cliente | Efecto |
|---|---|---|
| `REVEAL_TILES` | `{}` | Confirma que el jugador levantó su mano durante `DEALING` |
| `PLAY_TILE` | `{ left, right, side }` | Coloca una ficha legal en `LEFT` o `RIGHT` |
| `DRAW_TILE` | `{}` | Toma del pozo cuando no tiene jugada |
| `PASS` | `{}` | Pasa cuando no puede jugar ni cargar |
| `ABANDON` | `{}` | Abandono voluntario |
| `PROPOSE_BET_MULTIPLIER` | `{ level }` | Congela el turno y abre la negociación |
| `RESPOND_BET_MULTIPLIER` | `{ accept }` | Acepta o rechaza la propuesta vigente |

El cliente no envía `playerId`: el handler lo toma del asiento autenticado. Cada payload pasa por un
decoder estricto antes de alcanzar el comando.

## Mensajes del servidor

Lo que la sala `domino` le manda al cliente, además del estado sincronizado.

| Tipo | A quién | Payload | Cuándo |
|---|---|---|---|
| `config` | Al que entra o vuelve | La config pública de la mesa más `serverNow` (forma abajo) | Al final de cada entrada (`onJoin`) y de cada reconexión (`onReconnect`) |
| `events` | Toda la mesa | Lista de eventos del motor y de plataforma (`ROUND_STARTED`, `MATCH_RESOLVED`, `PLAYER_RECONNECTED`…) | Cada vez que la partida produce hechos |
| `illegal` | El que mandó el mensaje | `{ code, detail? }`: `code` es el de la regla violada, `MALFORMED` (con `detail`) o `UNKNOWN_COMMAND` | Su mensaje no prosperó; el estado no cambió |
| `matchCancelled` | Toda la mesa | `{ reason: "CHARGE_REJECTED" }` | El orquestador no cobró la entrada; la sala se cierra sin arrancar |

**`config`** trae lo mismo que `GET /config/:roomId`, sin pedirlo por HTTP:

```ts
{
  matchId: string;
  gameModeId: string;
  seats: string[];              // ids opacos: "seat-1", "seat-2"…
  pointsToWin: number;
  entryFee: number;             // UC completas
  prize: number;                // UC completas
  betLevels: { level: number; extra: number; additionalPoints: number }[]; // [] = no ofrece aumentar
  isFreeRoom: boolean;
  enableBots: boolean;
  timeouts: { turnMs: number; extraTimeMs: number; dealingMs: number; betResponseMs: number };
  serverNow: number;            // epoch ms del servidor al mandarlo, para el desfase de reloj
}
```

Nunca lleva el `seed`, ni identidad, moneda o tasa. Lo que la sala manda en `onJoin` Colyseus lo
encola hasta que el cliente confirma la entrada, así que llega apenas resuelve el `join` y antes de
cualquier `events` posterior. El handler se registra **justo después del `join`, sin un `await` en
el medio** (por ejemplo, no después de `waitForInitialState()`): si no, el mensaje llega antes que el
handler. Un cliente que no lo escucha solo ve un aviso del SDK.

## Estado visible

`StateView` filtra el árbol por cliente:

- Cada jugador ve sus fichas y sólo el conteo de las fichas rivales.
- Nadie ve el contenido del pozo; sí ve cuántas quedan.
- `displayName`, `username` y `profilePicture` son presentación sincronizada.
- `userId` (el `sub` del token) viaja en cada asiento: así el cliente reconoce el suyo con
  `players.find((p) => p.userId === sub)`, también antes de revelar las fichas. Es el último campo de
  `PlayerState`.
- La moneda no es del estado: vive en el `seat` de la config del servidor y no viaja por wire.
- Las fichas colocadas, el turno, puntajes, fases y deadlines son públicos.

## HTTP público

| Método y ruta | Uso |
|---|---|
| `GET /health` | Liveness del proceso; nunca consulta dependencias |
| `GET /ready` | Readiness; responde `503` y lista dependencias faltantes |
| `GET /config/:roomId` | Config pública de una mesa (la misma forma que el mensaje `config`: `betLevels: [{ level, extra, additionalPoints }]`, vacío si no ofrece aumentar, `isFreeRoom`, `enableBots`, `timeouts`) y `serverNow`; nunca devuelve el seed. Respaldo del mensaje `config` |
| `GET /matches/:roomId` | La misma config pública, con `Authorization: Bearer <JWT>` |
| `GET /me/matches?page=&limit=` | Historial del dueño del token (`Authorization: Bearer <JWT>`): sus partidas terminadas, la más nueva primero, desde su asiento (`id` es el `matchId`, `roomId` la sala de Colyseus; `result`, `bet` y `prize` en UC, `score`, `playedAt`). Página de 1 a 50, 10 por defecto |
| `GET /game-modes` | Modos **compartidos** activos del catálogo, con el DTO de siempre (sin dueño ni suscriptores) |
| `GET /game-modes/:uuid` | Un modo compartido activo; uno dado de baja o propio de un proveedor responde 404 |

Los dos `GET /game-modes` responden los `200` con `Cache-Control: public, max-age=10` (el `404`, con
`no-store`), y el servidor guarda la lista de activos 5 s por proceso: una edición hecha en otra
instancia puede tardar hasta 5 s en verse en ésta, más lo que la guarde un caché intermedio. La
instancia que atiende la edición la ve en el acto. Abrir una mesa nunca usa esa lista: lee el modo
fresco.

Todas las respuestas HTTP exponen el header `Date`, que permite recalcular el desfase del reloj del
cliente. `/config/:roomId` agrega `serverNow` para la medición inicial.

## HTTP interno

Estas rutas requieren una de dos credenciales:

- el header `x-internal-api-key` con la llave de administración (scripts y soporte). Vale como un
  admin de **Tablea Gaming** con rol `admin`;
- `Authorization: Bearer <token>` con el token de admin que billing-auth emite cuando un admin inicia
  sesión (`POST /v1/auth/login` de billing-auth): ES256, audiencia `tablea-gaming-admin` y
  `typ: admin`. Sus claims `prv` (el proveedor del admin; `null` es Tablea Gaming) y `role` (`admin` o
  `support`) dicen qué abre, y son **obligatorias**: un token sin `prv` (texto o `null` explícito) o
  sin `role` es `401`, igual que un rol desconocido o un `prv` vacío o que no es texto.

Si `ADMIN_API_KEY` no existe, no se registran y responden 404: fallan cerradas. Los errores de todas
salen `{ code, detail? }` (ver [«Errores»](#errores)).

**Quién entra.** El default es el cerrado: una ruta es de Tablea Gaming y de escritura salvo que diga
lo contrario. `support` sólo lee. Un admin de **proveedor** sólo entra a las rutas del catálogo que
acotan su ámbito; en todas las demás recibe `403 { code: "FORBIDDEN" }`.

| Rutas | Tablea Gaming `admin` (y la llave) | Tablea Gaming `support` | Proveedor `admin` | Proveedor `support` |
|---|---|---|---|---|
| `/internal/matches…`, `/game-data/:roomId` | sí | sí | 403 | 403 |
| `GET /internal/settings…` | sí | sí | 403 | 403 |
| `PATCH`/`DELETE /internal/settings/:section` | sí | 403 | 403 | 403 |
| `GET /game-modes/admin`, `/admin/:uuid` | todo (o el catálogo de `?providerId=`) | ídem | los suyos y todos los compartidos activos (con `subscribed`) | ídem |
| `POST /game-modes` | compartido o propio de cualquiera | 403 | sólo propio suyo | 403 |
| `PUT`/`DELETE /game-modes/:uuid`, `GET /game-modes/reactive/:uuid` | todo | 403 | sólo los propios suyos | 403 |
| `PUT`/`DELETE /game-modes/:uuid/subscription` | el de `?providerId=` | 403 | él mismo | 403 |
| `POST /game-modes/copies` | para el de `?providerId=` | 403 | para él mismo | 403 |
| `PUT /game-modes/source` | la del de `?providerId=` | 403 | la suya | 403 |

**El proveedor sobre el que actúa una ruta sale del token**, nunca del path ni del cuerpo. Un admin de
proveedor no lo nombra: es el suyo (un `?providerId=` igual al suyo se acepta; uno distinto responde
`404 { code: "UNKNOWN_PROVIDER" }`: otro proveedor no existe para él, como sus modos propios). Tablea
Gaming (token sin `prv`, o la llave) lo nombra con `?providerId=`, obligatorio en las rutas que actúan
sobre un proveedor (suscripción, copias, fuente): sin él, `400 { code: "PROVIDER_REQUIRED", detail }`.
En `GET /game-modes/admin` es opcional.

Dentro del catálogo, un modo **propio de otro proveedor** no existe para un proveedor: toda operación
sobre él responde `404 { code: "MODE_NOT_FOUND" }`. Un modo **compartido** no es secreto (lo lista el
catálogo público): tocarlo sin poder responde `403 { code: "FORBIDDEN", detail }`.

| Método y ruta | Uso |
|---|---|
| `GET /internal/matches/:matchId/history` | Historial ordenado por `seq` para soporte (lee `timeline` y, en los documentos viejos, `entries`) |
| `GET /internal/matches?pageSize=&after=&from=&to=&matchId=&roomId=&id=&userId=&matchEndReason=&status=` | Listado de partidas para el panel, la más nueva primero, filtrado y paginado por cursor (ver «El registro de cada partida») |
| `GET /internal/matches/:matchId` | El documento guardado de una partida, entero |
| `GET /game-data/:roomId` | El documento guardado, pelado, para el detalle de movimientos del backend principal |
| `GET /internal/players/:userId/matches?page=&limit=` | Historial de un jugador para el panel: la misma página que `GET /me/matches` le devuelve a ese `userId` (mismos parámetros y límites), dentro de `{ status: "success", data }`. El `userId` sigue la regla de texto del filtro del listado |
| `GET /game-modes/admin[?providerId=]` | Los modos que ve el admin, dados de baja incluidos, y la fuente del catálogo si hay un proveedor (ver abajo) |
| `GET /game-modes/admin/:uuid` | Un modo que ve el admin; 404 si no existe o no lo ve |
| `POST /game-modes` | Crea un modo; `ownerProviderId` opcional (ver abajo) |
| `PUT /game-modes/:uuid` | Aplica un patch al modo (el dueño y los suscriptores no se editan acá) |
| `DELETE /game-modes/:uuid` | Baja lógica: escribe sólo `isActive`, los suscriptores se conservan |
| `GET /game-modes/reactive/:uuid` | Reactiva; conserva el verbo de v1 por compatibilidad |
| `PUT /game-modes/:uuid/subscription[?providerId=]` | Suscribe al proveedor a un compartido activo; responde `200` con el modo |
| `DELETE /game-modes/:uuid/subscription[?providerId=]` | Lo da de baja; responde `200` con el modo |
| `POST /game-modes/copies[?providerId=]` | Copia a modos propios los compartidos a los que el proveedor está suscrito (sin cuerpo) |
| `PUT /game-modes/source[?providerId=]` | Cambia la fuente del catálogo del proveedor: `{ source: "shared" \| "own" }` |
| `GET /internal/settings` | Las secciones de config en caliente (`match`; en local y dev también `deal` y `starting-score`): en vigor, overrides y editables |
| `GET /internal/settings/:section` | Una sección |
| `PATCH /internal/settings/:section` | Parche de uno o más campos; cotas estrictas, clave desconocida = 400 |
| `DELETE /internal/settings/:section` | Vuelve la sección a los defaults del entorno |

### Modos con dueño y suscripciones

Cada modo tiene un dueño, `ownerProviderId`: `null` es un modo **compartido** de Tablea Gaming; un id es
un modo **propio** de ese proveedor, que sólo juegan sus jugadores. Un admin de proveedor crea sólo
modos propios suyos: sin el campo se lo pone el servicio; con `null` es `403 FORBIDDEN` y con el id de
otro proveedor, `404 UNKNOWN_PROVIDER` (lo de otro proveedor no existe para él). Los compartidos llevan
además `subscribers`, los proveedores que los juegan:

- **La lista es explícita.** Un compartido se ofrece sólo a los proveedores de su lista; un documento
  sin el campo se lee `[]`, igual que un compartido nuevo: no se ofrece a nadie hasta que se
  suscriban. Un modo propio también lleva `[]`: no tiene suscriptores. Los compartidos de antes de las
  suscripciones se suscriben una vez con `npm run modes:subscribe-existing` (`operacion.md`).
- Cada proveedor se suscribe o se da de baja él mismo (Tablea Gaming puede hacerlo por cualquiera, con
  `?providerId=`). Las dos son idempotentes. La suscripción vale sólo sobre compartidos **activos**;
  sobre uno inactivo o propio, `409`. No hay ruta para fijar la lista entera.
- Las escrituras de suscriptores **no avanzan `__v` ni `updatedAt`**: suscribirse no es una edición
  del modo.
- La unicidad (`name + playersQuantity` al crear, `name` al renombrar, con el hueco heredado de v1)
  vale **por dueño**: dos proveedores pueden tener cada uno su «Clásica».

Lo que ve cada uno en `GET /game-modes/admin` y `/admin/:uuid`: el DTO de v1 más `ownerProviderId`.
Tablea Gaming ve también `subscribers`; un proveedor no (es información de los otros), sino
`subscribed: true | false` en cada compartido: si él está suscrito. Un proveedor ve sus modos propios
(también los dados de baja) y **todos los compartidos activos**, para elegir a cuáles suscribirse; un
compartido dado de baja sólo lo sigue viendo si estaba suscrito. Lo que JUEGA no cambia: sus propios o
los compartidos a los que está suscrito, según la fuente. Tablea Gaming ve todos los modos, o con
`?providerId=` lo que ve ese proveedor.

**`POST /game-modes/copies`** (sin cuerpo) copia los compartidos **activos** a los que el proveedor está
suscrito a modos propios suyos, con los mismos números y niveles. El uuid de cada copia
es determinista (v5 de RFC 4122: espacio = uuid del origen, nombre = `providerId`), así que repetirla
completa una copia a medias sin duplicar y no pisa lo que el proveedor ya editó. Responde `200`:

```json
{ "status": "success", "data": {
  "created":  [{ "sourceUuid": "…", "uuid": "…" }],
  "existing": [{ "sourceUuid": "…", "uuid": "…" }],
  "skipped":  [{ "sourceUuid": "…", "name": "…", "playersQuantity": 2,
                 "reason": "NAME_TAKEN", "conflictUuid": "…" }] } }
```

`NAME_TAKEN`: el proveedor ya tenía un modo propio con ese nombre y esa cantidad y otro uuid.
`INVALID_SOURCE_UUID`: el uuid del origen no tiene forma de UUID y no se puede derivar el de la copia.

### La fuente del catálogo de cada proveedor

Cada proveedor elige qué catálogo juega, **entero**: `shared` (los compartidos activos a los que está
suscrito) u `own` (sólo sus modos propios activos). Un proveedor que nunca la cambió está en `shared`.
La guarda el dominó (colección `provider_catalogs`) y la aplica el orquestador al armar el catálogo
efectivo (un proveedor que juega contra todos usa siempre el compartido, decida lo que decida acá).
El camino habitual para pasar a `own`: `POST /game-modes/copies`, editar las copias, y recién ahí la
fuente.

**La fuente se lee en `GET /game-modes/admin`** cuando hay un proveedor resuelto (un token de proveedor,
o Tablea Gaming con `?providerId=`): la respuesta suma `source` junto a `data`. Tablea Gaming sin
`?providerId=` recibe todos los modos y ningún `source`.

```json
{ "status": "success", "data": [ … ], "source": "own" }
```

**`PUT /game-modes/source` `{ "source": "shared" | "own" }`** responde `200`:

```json
{ "status": "success", "data": {
  "providerId": "parley", "source": "own",
  "updatedAt": "2026-10-28T12:00:00.000Z", "updatedBy": "pia" } }
```

 Pasar a `own` exige **al menos un modo propio activo** del proveedor: si no, `409`
(quedaría sin lobby). Volver a `shared` siempre se puede. Y al revés: con la fuente en `own`, dar de baja (o
desactivar por `PUT` con `isActive: false`) el **último** modo propio activo del proveedor es `409`;
primero hay que volver a `shared`. Un proveedor sólo lee y cambia la suya
(`404 UNKNOWN_PROVIDER` sobre otra); `support` lee y no cambia.

Los códigos del catálogo, ruta por ruta, están en [«Errores»](#errores).

### El registro de cada partida

Cada partida deja **un documento** en `match_history`, con la forma v2.1 de truco (`version: 2.1`). Se
abre al primer reparto (`status: "started"`, con `roomId`, `table`, `matchConfig` —seed y parejas
incluidos—, `seats` y `matchStartedAt`), se alimenta durante la partida (`timeline`, la secuencia de
actos y hechos; `rounds`, lo que las reglas concluyeron de cada mano) y se cierra al terminar
(`status: "finished" | "aborted"`, `matchEndedAt`, `matchDurationInMs`, `matchEndReason`, ganadores,
`players` con su salida y su plata, `rateId`, `betMultiplier` y `rankingMultiplier`). Una mesa que nunca
arrancó nace en el cierre. Los instantes son fechas (ISO en el JSON); las duraciones, números. Los
documentos de antes de la v2.1 (`{ matchId, entries, createdAt, updatedAt }`) se siguen leyendo en las
cuatro rutas.

**`GET /internal/matches`** — el listado del panel, la más nueva primero (`createdAt` descendente y
`_id` de desempate), paginado **por cursor**. Todos los parámetros son opcionales y los filtros se
combinan con AND:

| Parámetro | Qué es | Inválido (400 `MALFORMED`) |
|---|---|---|
| `pageSize` | Filas por página, entero de 1 a 100; default 20 | fuera de rango, no entero |
| `after` | El `nextCursor` de la página anterior, tal cual | cualquier cosa que no sea un cursor emitido por esta ruta |
| `from`, `to` | Instantes ISO 8601 **con hora y zona** (`2026-10-01T00:00:00.000Z`, `…-04:00`): `createdAt >= from` y `createdAt < to` | una fecha sin hora, un instante imposible, `from` posterior a `to` |
| `matchId` | Igual a | vacío, más de 128 caracteres, caracteres de control |
| `roomId` | Igual a | ídem |
| `id` | El `_id` del documento: 24 hexadecimales | otra cosa |
| `userId` | Un jugador: igual al `userId` de **alguno** de los asientos (`seats[].userId`), en mesas de dos o de cuatro. Una partida en la que el mismo usuario ocupa dos asientos sale una vez. Los documentos de antes de la v2.1 no tienen asientos y no coinciden nunca | ídem `matchId`, o repetido |
| `matchEndReason` | El motivo del cierre, exacto: `SCORE`, `ABANDONMENT`, `NEVER_STARTED`, `TILES_NOT_SEEN`, `NEVER_PLAYED`, `INTERRUPTED` o `CHARGE_REJECTED`. Una partida todavía abierta no tiene motivo y no coincide con ninguno | otro valor (en minúsculas incluido), vacío o repetido |
| `status` | El estado del documento, exacto: `started` (abierta), `finished` o `aborted`. Sin él salen todos los estados. Los documentos de antes de la v2.1 no tienen estado y no coinciden nunca | otro valor (en mayúsculas incluido), vacío o repetido |

Un parámetro que no está en la tabla se ignora (`page` incluido: ya no existe). `from` igual a `to` es
un rango vacío, no un error.

```json
{
  "status": "success",
  "data": {
    "items": [
      {
        "_id": "6717a2f0c3bf3e710572f941",
        "matchId": "orq-8f2c",
        "roomId": "ZYIVoz6TQ",
        "game": "domino",
        "status": "finished",
        "table": { "gameModeId": "…", "name": "Clásica 1v1", "entryFeeInUC": 10, "prizeInUC": 18, "isFree": false },
        "createdAt": "2026-10-22T14:00:00.000Z",
        "updatedAt": "2026-10-22T14:09:31.000Z",
        "matchStartedAt": "2026-10-22T14:00:03.000Z",
        "matchEndedAt": "2026-10-22T14:09:00.000Z",
        "matchEndReason": "SCORE",
        "winnerIds": ["seat-1"]
      }
    ],
    "pageSize": 20,
    "nextCursor": "eyJ0IjoxNzkyNjc3NjAwMDAwLCJpZCI6IjY3MTdhMmYwYzNiZjNlNzEwNTcyZjk0MSJ9",
    "total": 1234,
    "totalExact": true
  }
}
```

- **`nextCursor`** es opaco (base64url de `{ t, id }`: el `createdAt` en epoch ms y el `_id` de la última
  fila) y es `null` en la última página. La página siguiente se pide con `after=<nextCursor>` **y los
  mismos filtros**; empieza estrictamente después de esa fila, así que un empate en el mismo
  milisegundo no repite ni pierde filas, y una página honda cuesta lo mismo que la primera.
- **`total`** se cuenta barato: sin filtros es el estimado de la colección (`totalExact: false`); con
  algún filtro se cuenta hasta 10 000 (`totalExact: true`, o `total: 10000` y `totalExact: false` si
  hay más); con `after` no se cuenta (`total: null`, `totalExact: false`).
- **Plazo**: cada consulta tiene 5 s. Si la base no contesta a tiempo:
  `503 { code: "MATCH_LIST_TIMEOUT", detail: "La búsqueda tardó demasiado; acota el rango de fechas" }`.

Cada fila es un resumen: sin `timeline` ni `rounds`. Un documento viejo aparece con lo que tiene
(`_id`, `matchId`, `game`, `createdAt`, `updatedAt`) y sale en todo listado que no filtre por sala.

**`GET /internal/matches/:matchId`** — `200 { status: "success", data: <documento> }`, con el `_id`
como texto y `rounds`/`timeline` al final; `404 { code: "MATCH_NOT_FOUND" }`.

**`GET /game-data/:roomId`** — el contrato del backend principal, igual que en truco: `200` con el
documento pelado (sin envelope y sin `_id`) y `404 { code: "MATCH_NOT_FOUND" }`. Busca por `roomId` y,
si no, por `matchId` (los documentos viejos no guardaban la sala).

Las tres van con la llave o el token de admin; sin credencial, `401 { code: "UNAUTHORIZED" }` antes de
mirar la forma. El `POST /internal/matches` del orquestador es otra ruta, con su llave.

**Niveles de aumento de un modo.** `POST` y `PUT /game-modes` aceptan `betLevels`:
`[{ level, extra, additionalPoints }]`. `level` es el multiplicador de la entrada y el premio (entero
≥ 2), `extra` se suma al multiplicador de ranking y `additionalPoints` es lo que el ganador suma de
más. Los niveles son únicos y el `extra` crece con el nivel; si no, la respuesta es 400. Sin
`betLevels`, un modo nuevo no ofrece aumentar (`[]`). En el `PUT`, la lista reemplaza a la anterior y
`[]` apaga los aumentos. El `GET` público devuelve `betLevels` ordenados por nivel, y el orquestador los
lee de ahí (y de `GET /internal/game-modes`).

**Config en caliente.** Una edición llega a las mesas que nacen DESPUÉS; una mesa ya abierta conserva
los plazos con los que nació. El proceso que atiende el `PATCH` se refresca en el acto y el resto
del clúster converge en 5 s. Fuera de lo editable queda `tilesPerPlayer` (regla de juego): se rechaza
con 400 en vez de aceptarse e ignorarse.

### API del orquestador

Cinco rutas que sólo usa el orquestador de Tablea Gaming; las de las mesas son la única puerta
de entrada a una partida. Van con `x-internal-api-key` igual a
`ORCHESTRATOR_API_KEY` (`ADMIN_API_KEY` no las abre); sin esa variable no se registran y responden 404.
Un `401 { code: "UNAUTHORIZED" }` es una llave ausente o equivocada, y se decide ANTES de mirar el
cuerpo.

**`POST /internal/matches`** abre una mesa. Cuerpo (`CreateMatchRequest`, estricto: una clave de más
es 400): `mode` (`"CASUAL"`), `matchId`, `gameModeId` (uuid del catálogo), `participants` (2 a 4;
cada uno `userId`, `displayName`, `currency` y, opcionales, `username` y `profilePicture`), `seed`,
`teamAssignment` (`SHUFFLED` o `SEAT_ORDER`) y `rateId` (opaco: el `_id` de Mongo de la tasa de
Betaso).

| Estado | Cuerpo | Cuándo |
|---|---|---|
| `201` | `{ status, data: { roomId, seats: [{ userId, reservation }] } }` | La sala nació; cada jugador consume su `reservation` |
| `400` | `{ code: "MALFORMED", detail }` | El cuerpo no cumple la forma |
| `401` | `{ code: "UNAUTHORIZED" }` | Llave ausente o equivocada |
| `422` | `{ code: "UNKNOWN_GAME_MODE" }`, `"UNSUPPORTED_GAME_MODE"` o `"SEAT_COUNT_MISMATCH"` | La sala rechazó la mesa: modo inexistente o dado de baja, 4P, o cantidad que no coincide con el modo |
| `500` | `{ code: "INTERNAL" }` | Cualquier otra falla es nuestra |

**`POST /internal/players/:userId/seat`** devuelve el asiento de quien sigue jugando (sin cuerpo).

| Estado | Cuerpo | Cuándo |
|---|---|---|
| `200` | `{ status, data: { matchId, reservation } }` | Sigue en una mesa; el `matchId` es el del orquestador |
| `400` | `{ code: "MALFORMED", detail }` | El `userId` es inválido |
| `401` | `{ code: "UNAUTHORIZED" }` | Llave ausente o equivocada |
| `404` | `{ code: "NO_LIVE_MATCH" }` | No está en ninguna mesa viva |
| `500` | `{ code: "INTERNAL" }` | La sala existe pero `joinById` falló igual (la sala no tiene `maxClients`, así que no debería bloquearse): el orquestador lo trata como desconocido y nunca abre una segunda mesa |

**`GET /internal/players/:userId/match`** dice en qué mesa está sentado un jugador, **sin reservar
asiento**: dos lecturas del registro compartido y ninguna llamada a Colyseus. Es lo que el orquestador
pregunta para no abrirle una segunda mesa; para volver a entrar sigue siendo `POST .../seat`.

| Estado | Cuerpo | Cuándo |
|---|---|---|
| `200` | `{ status: "success", data: { matchId, roomId } }` | Sigue en una mesa viva; el `matchId` es el del orquestador |
| `400` | `{ code: "MALFORMED", detail }` | El `userId` es inválido |
| `401` | `{ code: "UNAUTHORIZED" }` | Llave ausente o equivocada |
| `404` | `{ code: "NO_LIVE_MATCH" }` | No está en ninguna mesa viva (o ya lo soltó: se retiró, la partida tiene veredicto o se anuló) |

**`GET /internal/census`** cuenta quién está jugando, en todo el clúster: el total y por modo. El
orquestador lo muestra en los números de su lobby.

| Estado | Cuerpo | Cuándo |
|---|---|---|
| `200` | `{ status, data: { playersInMatch, byGameMode: [{ gameModeId, playersInMatch }] } }` | Siempre; un modo sin nadie jugando no aparece |
| `401` | `{ code: "UNAUTHORIZED" }` | Llave ausente o equivocada |

**`GET /internal/game-modes`** devuelve, en una sola lectura, lo que el orquestador necesita para
armar el catálogo efectivo de cada proveedor: los modos activos —compartidos y propios— con el DTO de
v1 más `ownerProviderId` y `subscribers` (siempre una lista; `[]` es nadie), y las **fuentes** que se
apartan del default. `?includeInactive=1` suma los dados de baja (para el historial y para que un
proveedor como Betaso vea las bajas); un valor que no sea `0` o `1` es `400`.

```json
{ "status": "success",
  "data": [ { "_id": "…", "uuid": "…", "name": "Clásica", "multiplier": 1, "prize": 18,
              "entryFee": 10, "playersQuantity": 2, "pointsToWin": 25, "isActive": true,
              "isFreeRoom": false, "enableBots": false, "betLevels": [],
              "createdAt": "…", "updatedAt": "…", "__v": 0,
              "ownerProviderId": null, "subscribers": ["betaso"] } ],
  "catalogs": { "parley": "own" } }
```

`catalogs` es un mapa `providerId → fuente` con **sólo** los proveedores que no están en `shared`: un
proveedor ausente del mapa juega el compartido suscrito. Hoy el único valor posible es `"own"`.

| Estado | Cuerpo | Cuándo |
|---|---|---|
| `200` | `{ status, data: [GameModeDTO & { ownerProviderId, subscribers }], catalogs: { [providerId]: "own" } }` | Siempre |
| `401` | `{ code: "UNAUTHORIZED" }` | Llave ausente o equivocada (la del panel tampoco la abre) |

⚠ **El dominó no verifica el proveedor al abrir una mesa.** `POST /internal/matches` resuelve el modo
activo por uuid sin mirar su dueño: que un jugador sólo use los modos de su proveedor lo garantiza el
orquestador.

`CreateMatchRequest` acepta además `betLevels` (opcional, `[{ level, extra, additionalPoints }]`):
los niveles de aumento que ofrece la mesa los decide el orquestador, que es quien los cobra.

**Las mesas no mueven dinero: piden que se cobre y dicen qué pasó.** El dominó no tiene billetera,
ni ledger, ni credenciales de ninguna; tampoco reporta ranking ni liga. En cambio:

- **Con la mesa completa**, la sala pide al orquestador `POST {ORCHESTRATOR_URL}v1/matches/:matchId/charges`
  (`x-internal-api-key: ORCHESTRATOR_CALLBACK_API_KEY`) y espera. Con `200` arranca; con cualquier otra
  cosa —un `409`, un orquestador caído, un plazo vencido— se cierra sin arrancar y sale abortada con
  `CHARGE_REJECTED`. El plazo del cliente HTTP cubre la respuesta entera, cabeceras y cuerpo, y al
  vencer corta la conexión: un orquestador que manda las cabeceras y se cuelga en el cuerpo también es
  un plazo vencido, y la mesa no queda esperando el cobro.
- **Un aumento acordado** se pide igual, `POST …/bets { step, level }`; vale solo con `200`, y si no se
  anula (`MULTIPLIER_REVOKED`).
- **El resultado** sale por un outbox durable al exchange `tablea_gaming` (broker y vhost de
  `TABLEA_GAMING_RABBITMQ_URL`), con `mandatory` y publisher confirm: `domino.match.finished` al
  dictaminarse (participantes, apuesta de la mesa y los premios en `payouts`, ya con el aumento) y
  `domino.match.aborted` al cerrarse sin veredicto (sin montos: el orquestador devuelve lo que cobró).
  `messageId = <matchId>:finished|aborted`.

`domino.match.finished` (`MatchFinishedPayload`, en `network/match-results.ts`):

| Campo | Qué es |
|---|---|
| `gameSlug`, `matchId`, `roomId`, `gameModeId`, `rateId` | La mesa; `matchId` es el del orquestador |
| `endedAt` | ISO 8601, el instante del veredicto |
| `reason` | `SCORE` o `ABANDONMENT` |
| `stakes` | `{ entryFee, prize, multiplier, isFreeRoom, bet: { level, extra } \| null }`, en UC |
| `participants` | `[{ userId, teamId, result }]`; `result` es `won`, `lost` o `abandoned` (el asiento que juega la máquina cuenta como `abandoned`) |
| `payouts` | `[{ userId, amountUc }]`: los premios que se deben, calculados por `payoutOf` (bots y retirados no cobran; el aumento aceptado va adentro). Solo créditos: el juego no dice qué se cobró |

`domino.match.aborted` (`MatchAbortedPayload`): `gameSlug`, `matchId`, `roomId`, `gameModeId`,
`abortedAt`, `reason` (`NEVER_STARTED`, `TILES_NOT_SEEN`, `NEVER_PLAYED`, `INTERRUPTED` o `CHARGE_REJECTED`) y
`participants: [{ userId }]`.

El contrato completo vive en el monorepo del orquestador:
`docs/superpowers/specs/2026-10-05-dinero-mock-resultados-y-reportes-design.md`.

### Anuncios del catálogo (`domino.config.*`)

Cada cambio del catálogo se anuncia en el exchange `tablea_gaming` (el de `TABLEA_GAMING_RABBITMQ_URL`), para el
servicio de notificaciones de Tablea Gaming. Salen de su propio outbox (`catalog_event_outbox`, con su propio
despachador): un anuncio que no sale nunca frena un resultado de partida. Se encolan **después** de escribir
el cambio (Mongo no tiene transacciones en este despliegue): un proceso que muere entre las dos cosas pierde
ese aviso. `messageId = <uuid>:<topic>`.

| Topic | Payload (además de `gameSlug`, `occurredAt`, `actor`) | Cuándo |
| --- | --- | --- |
| `domino.config.shared_game_mode.{created,updated,deactivated,reactivated}` | `modeId`, `name` | un modo compartido se crea, se edita, se da de baja o se reactiva |
| `domino.config.provider_game_mode.{created,updated,deactivated,reactivated}` | `providerId`, `modeId`, `name` | lo mismo con un modo propio de un proveedor |
| `domino.config.provider_game_mode.subscribed` · `.unsubscribed` | `providerId`, `modeId`, `name` | un proveedor se suscribe a un compartido o se da de baja (solo si cambió) |
| `domino.config.provider_game_mode.copied` | `providerId` | se copiaron compartidos como propios (solo si se creó alguno) |
| `domino.config.catalog_source.changed` | `providerId`, `source` | cambió la fuente del catálogo de un proveedor (solo si cambió) |

`gameSlug` es `domino`. `actor` es `{ kind: "admin", name }`: el `sub` del token de admin, o `ADMIN_API_KEY`
para la llave de administración.

## Errores

**Todo error HTTP del dominó es `{ code, detail? }`.** `code` es una constante en mayúsculas que el
cliente compara; `detail`, cuando viaja, es texto para una persona y no se parsea. Es el mismo
vocabulario que los rechazos del socket (`{ code: "MALFORMED", detail }`). Las respuestas de éxito no
cambian (`{ status: "success", data }` del catálogo y del panel, `{ status: "success", message }` de
la baja y la reactivación), y `/health` y `/ready` siguen siendo sondas del balanceador con su propia
forma (`503 { status: "not-ready", missing }`).

**Comunes a toda ruta** (no se repiten abajo):

| Estado | `code` | Cuándo |
|---|---|---|
| `400` | `MALFORMED` (+ `detail`) | El path, el query o el cuerpo no cumplen la forma, o el cuerpo no es JSON válido |
| `413` | `PAYLOAD_TOO_LARGE` | El cuerpo pasa el límite del parser de JSON |
| `500` | `INTERNAL` | Un bug nuestro; el detalle queda en el log, nunca en la respuesta |

**Comunes a las rutas con credencial:** `401 UNAUTHORIZED` (sin credencial, o una inválida: llave
equivocada, token vencido, sin `prv` o sin `role`), y en las del panel `403 FORBIDDEN` (la credencial
vale pero esta ruta no abre a ese rol o a ese proveedor; ver «Quién entra»). La credencial se decide
antes de mirar la forma.

| Ruta | Códigos propios |
|---|---|
| `GET /config/:roomId` | `404 ROOM_NOT_FOUND` |
| `GET /matches/:roomId` | `401 UNAUTHORIZED`, `404 ROOM_NOT_FOUND` |
| `GET /me/matches` | `401 UNAUTHORIZED`, `503 MATCH_LIST_TIMEOUT` (+ `detail`) |
| `GET /me/stats` | `401 UNAUTHORIZED`, `503 STATS_TIMEOUT` (+ `detail`) |
| `GET /game-modes` | — |
| `GET /game-modes/:uuid` | `404 MODE_NOT_FOUND` |
| `GET /internal/matches` | `503 MATCH_LIST_TIMEOUT` (+ `detail`) |
| `GET /internal/matches/:matchId` | `404 MATCH_NOT_FOUND` |
| `GET /internal/matches/:matchId/history` | `404 MATCH_NOT_FOUND` |
| `GET /game-data/:roomId` | `404 MATCH_NOT_FOUND` |
| `GET /internal/players/:userId/matches` | `503 MATCH_LIST_TIMEOUT` (+ `detail`) |
| `GET /game-modes/admin[?providerId=]` | `404 UNKNOWN_PROVIDER` |
| `GET /game-modes/admin/:uuid` | `404 MODE_NOT_FOUND` |
| `POST /game-modes` | `400 FREE_ROOM_WITH_ENTRY`, `403 FORBIDDEN` (un proveedor pide un compartido, `ownerProviderId: null`), `404 UNKNOWN_PROVIDER` (un proveedor crea para otro), `409 MODE_DUPLICATE`, `503 CATALOG_BUSY` |
| `PUT /game-modes/:uuid` | `400 FREE_ROOM_WITH_ENTRY`, `403 FORBIDDEN` (un proveedor sobre un compartido), `404 MODE_NOT_FOUND`, `409 MODE_DUPLICATE`, `409 OWN_CATALOG_EMPTY`, `503 CATALOG_BUSY` |
| `DELETE /game-modes/:uuid` | `403 FORBIDDEN`, `404 MODE_NOT_FOUND`, `409 MODE_ALREADY_INACTIVE`, `409 OWN_CATALOG_EMPTY`, `503 CATALOG_BUSY` |
| `GET /game-modes/reactive/:uuid` | `403 FORBIDDEN`, `404 MODE_NOT_FOUND`, `409 MODE_ALREADY_ACTIVE`, `503 CATALOG_BUSY` |
| `PUT`/`DELETE /game-modes/:uuid/subscription[?providerId=]` | `400 PROVIDER_REQUIRED`, `404 UNKNOWN_PROVIDER`, `404 MODE_NOT_FOUND`, `409 MODE_NOT_SHARED`, `409 MODE_INACTIVE`, `503 CATALOG_BUSY` |
| `POST /game-modes/copies[?providerId=]` | `400 PROVIDER_REQUIRED`, `404 UNKNOWN_PROVIDER`, `503 CATALOG_BUSY` |
| `PUT /game-modes/source[?providerId=]` | `400 PROVIDER_REQUIRED`, `404 UNKNOWN_PROVIDER`, `409 OWN_CATALOG_EMPTY`, `503 CATALOG_BUSY` |
| `GET`/`PATCH`/`DELETE /internal/settings/:section` | `404 SETTINGS_SECTION_NOT_FOUND` |
| `GET /internal/settings` | — |
| `POST /internal/matches` (orquestador) | `422 UNKNOWN_GAME_MODE` \| `UNSUPPORTED_GAME_MODE` \| `SEAT_COUNT_MISMATCH` |
| `POST /internal/players/:userId/seat` (orquestador) | `404 NO_LIVE_MATCH` |
| `GET /internal/players/:userId/match` (orquestador) | `404 NO_LIVE_MATCH` |
| `GET /internal/census` (orquestador) | — |
| `GET /internal/game-modes` (orquestador) | — |

Los `409`, `403`, `400 FREE_ROOM_WITH_ENTRY` y `503 CATALOG_BUSY` del catálogo llevan en `detail` el
mensaje del servicio (por ejemplo, «el modo … es el último propio activo de parley…: primero volvé la
fuente a shared»). Los `404` no llevan `detail`: un modo, una partida o un proveedor de otro proveedor
responden igual que uno que no existe.

Fuera de esta tabla quedan las rutas que no se registran (sin `ADMIN_API_KEY` u
`ORCHESTRATOR_API_KEY`) y cualquier path desconocido: los contesta el 404 por defecto de Express, en
HTML.

## Eventos y salidas

```mermaid
flowchart LR
  Command["Comando"] --> Domain["Eventos del motor"]
  Timer["Deadline"] --> Domain
  Socket["Conexión"] --> Platform["Eventos de plataforma"]
  Domain --> History["Historial de soporte"]
  Platform --> History
  Domain --> Clients["Clientes de la sala"]
  Domain --> Payouts["payoutOf\nproyección de dinero"]
  Payouts --> Result["Resultado al orquestador\n(outbox → tablea_gaming)"]
```

Los eventos de dominio describen consecuencias (`ROUND_STARTED` en cada reparto, `ROUND_RESOLVED`,
`MATCH_RESOLVED`, expiraciones). Los de plataforma describen conexión y aborto. Un comando voluntario
ya está en el historial como comando; no se duplica como evento salvo que exista información nueva.

Detrás de cada `ROUND_STARTED` el historial graba `TILES_DEALT`: las manos y el pozo tal como se
repartieron, leídos del árbol en ese instante. No es un evento (no se difunde a la mesa) y es lo que
soporte tiene cuando la partida se jugó con un reparto preparado y el replay no la reproduce. Cada
entrada lleva la mano en que pasó, tomada de `ROUND_STARTED` y no del árbol.
