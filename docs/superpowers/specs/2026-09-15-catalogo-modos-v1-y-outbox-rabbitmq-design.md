# Catálogo de modos compatible con v1 y outbox RabbitMQ

> **Spec de diseño** · 2026-09-15 · Aprobado por el usuario durante la conversación.
>
> Este documento corrige una decisión del incremento de identidad del 2026-09-14: los importes
> `entryFee` y `prize` no son UC minor. Conservan la semántica productiva de v1: `10` significa
> `10 UC`. El orquestador convierte después a la moneda congelada de cada participante usando el
> `rateId` de la mesa.

## 1. Objetivo

Domino v2 reemplazará completamente a v1 como dueño del catálogo de modos. Debe poder leer y
modificar sin migración los documentos productivos de `game_modes_domino`, conservar la API HTTP que
consume el panel actual y publicar los mismos eventos RabbitMQ que v1.

La implementación debe respetar las fronteras de v2:

- el motor no conoce Mongo, RabbitMQ, Betaso, administradores ni tokens de una plataforma;
- la autorización administrativa ocurre en el orquestador;
- Domino recibe llamadas de servicio ya autorizadas;
- Mongo y RabbitMQ son adaptadores reemplazables detrás de contratos de la feature;
- una caída de RabbitMQ no detiene partidas ni pierde el cambio del catálogo;
- cada partida conserva un snapshot del modo con el que nació y no cambia si el catálogo se edita.

## 2. Decisiones aprobadas

1. **V2 es el único escritor después del corte.** V1 no puede seguir modificando la colección en
   paralelo.
2. **La colección y la forma BSON se conservan.** No se renombra ningún campo productivo.
3. **La API HTTP de v1 se conserva.** Se mantienen rutas, métodos, success envelopes y DTOs.
4. **El orquestador es la puerta administrativa.** El panel autentica contra su plataforma; el
   orquestador verifica el rol y llama Domino con credencial interna.
5. **RabbitMQ conserva el contrato productivo.** Exchange `betaso`, routing keys
   `game_mode.created`/`game_mode.updated` y cuerpo idéntico al de v1.
6. **La entrega mejora internamente.** Los eventos quedan en un outbox durable, se publican con
   confirmación y se reintentan.
7. **No se exige replica set.** Una reconciliación repara la ventana entre escribir el modo y escribir
   el outbox.
8. **Este incremento entrega el catálogo completo, no nuevas mecánicas.** `multiplier`, `isFreeRoom`
   y `enableBots` se conservan, validan y exponen por HTTP, pero no activan todavía apuestas
   dinámicas, bots ni el motor 4P. El payload Rabbit sigue siendo exactamente el de v1 y por eso no
   añade los dos últimos campos.

## 3. Alcance

### Entra

- Contrato de dominio y repositorio del catálogo.
- Adaptador Mongo nativo sobre `game_modes_domino`.
- CRUD HTTP compatible con v1.
- Lectura pública y mutaciones autorizadas por credencial de servicio.
- Publicador AMQP con confirm channel.
- Outbox Mongo, reintentos, reconciliación y liderazgo seguro entre procesos PM2.
- Integración del catálogo al nacimiento de una mesa 2P.
- Corrección completa de la convención UC-minor introducida en v2.
- Readiness, apagado ordenado, Docker smoke e integración en CI.

### No entra

- Construir el orquestador ni el panel administrativo.
- Autenticar usuarios administradores dentro de Domino.
- Consultar el Postgres de Betaso.
- Matchmaking, pools, veto de pares o cooldown.
- Implementar el motor 4P, bots, torneos o apuestas dinámicas.
- Entregar recompensas o reembolsos de partidas por RabbitMQ. El outbox de este incremento sólo
  publica cambios del catálogo; la liquidación multiplataforma sigue perteneciendo al orquestador.

## 4. Arquitectura

```text
Panel administrativo
        │ Bearer del usuario
        ▼
Orquestador / gateway ── valida plataforma y rol admin
        │ X-Internal-Key
        ▼
API de modos de Domino v2
        │
        ├── GameModeService ── GameModeRepository ── game_modes_domino
        │                                      └──── game_mode_outbox
        │
        └── OutboxDispatcher ── AmqpDelivery ── exchange betaso
```

La lectura del catálogo y el caso de uso administrativo viven en `features/game-mode`. El repositorio
Mongo, el transporte HTTP y el transporte AMQP son adaptadores de esa feature. La conexión AMQP y el
lease Mongo son piezas compartidas porque su ciclo de vida pertenece al proceso y no a una sala.

Domino no recibe ni interpreta el JWT del administrador. Desde el punto de vista del panel, el
orquestador conserva la API de v1. Desde el límite interno de Domino, las mutaciones exigen la misma
`X-Internal-Key` constante y comparada en tiempo constante que ya protege `/internal/*`. Los GET del
catálogo siguen siendo públicos.

## 5. Contrato Mongo exacto

### 5.1 Colección

Nombre: `game_modes_domino`.

```ts
interface GameModeDocument {
  _id: ObjectId;
  uuid: string;
  name: string;
  multiplier: number;
  prize: number;
  entryFee: number;
  playersQuantity: 2 | 4;
  pointsToWin: number;
  isActive: boolean;
  isFreeRoom: boolean;
  enableBots: boolean;
  createdAt: Date;
  updatedAt: Date;
  __v: number;
}
```

No se añaden campos de outbox, plataforma, moneda, tasa, auditoría ni autorización al documento.
`createdBy` y `updatedBy` no forman parte del schema real de Mongoose de v1 y no se incorporan.

### 5.2 Defaults y validación compatible

| Campo | Regla productiva |
|---|---|
| `uuid` | generado con UUID v4, requerido y único |
| `name` | string requerido |
| `multiplier` | número `>= 1`, default `1` |
| `prize` | número `>= 0` |
| `entryFee` | número `>= 0` |
| `playersQuantity` | `2` o `4` |
| `pointsToWin` | número `<= 100`, default operativo `25` |
| `isActive` | boolean, default `true` |
| `isFreeRoom` | boolean, default `false` |
| `enableBots` | default `playersQuantity === 4` |
| `createdAt`, `updatedAt` | fechas puestas por el repositorio |
| `__v` | `0` al crear e incrementado en cada mutación efectiva |

El DTO Zod de v1 no se ejecutaba; su default `pointsToWin = 10` era código muerto. V2 usa el default
real del schema Mongo: `25`. La frontera HTTP acepta `playersQuantity` como `2`/`4` numérico y también
`"2"`/`"4"`, porque Mongoose hacía coerción y el DTO histórico declaraba strings.

Los importes siguen siendo números en UC completas y pueden contener decimales, igual que el schema
Mongoose productivo. V2 valida que sean finitos y no negativos, pero no los escala.

### 5.3 Índices

Se recrean idempotentemente los índices de v1, sin renombrar ni eliminar índices existentes:

```js
{ uuid: 1 }                    // unique
{ isActive: 1 }
{ isActive: 1, name: 1 }
{ isActive: 1, uuid: 1 }
```

La regla lógica de creación continúa siendo “no repetir `name + playersQuantity`”. Como el índice de
v1 no la impone, todas las mutaciones se serializan mediante un lease Mongo global. Es una decisión
deliberadamente simple: el catálogo recibe muy pocas escrituras; si ese volumen cambia, se reemplaza
por una restricción/migración explícita y no por concurrencia optimista improvisada.

## 6. Contrato HTTP compatible

Base: `/game-modes`.

| Método y ruta | Autorización | Respuesta exitosa |
|---|---|---|
| `GET /` | pública | `200 { status: "success", data: GameMode[] }` activos, recientes primero |
| `GET /:uuid` | pública | `200 { status: "success", data: GameMode }` sólo si está activo |
| `POST /` | orquestador | `201 { status: "success", data: GameMode }` |
| `PUT /:uuid` | orquestador | `200 { status: "success", data: GameMode }` |
| `DELETE /:uuid` | orquestador | `200 { status: "success", message: "Modo de juego eliminado correctamente" }` |
| `GET /reactive/:uuid` | orquestador | `200 { status: "success", message: "Modo de juego reactivado correctamente" }` |
| `POST /sync` | orquestador | `200 { status: "success", data: { synced: number } }` |

`GameMode` se serializa con los mismos nombres de Mongo, incluidos `_id`, `__v`, `createdAt` y
`updatedAt`. No se devuelve el modelo de dominio interno.

La compatibilidad cubre rutas, métodos, DTOs exitosos y mensajes conocidos. No se conservan dos bugs
accidentales de v1: cuerpos inválidos ya no terminan como 500 y los “not found” inalcanzables ya no se
convierten en 500. V2 responde 400 para forma inválida, 404 para ausencia, 409 para conflicto y 503 si
la infraestructura administrativa no está disponible, siempre con el envelope
`{ status: "error", message }`.

Si `INTERNAL_API_KEY` no existe, los GET se registran y las mutaciones no. En producción la variable
es obligatoria, porque v2 no puede declararse reemplazo de v1 dejando el catálogo sin dueño seguro.

## 7. Semántica UC corregida

Esta spec reemplaza la convención `*UcMinor` de la spec del 2026-09-14 y del incremento de lobby.

- `DominoMatchConfig.entryFeeUcMinor` pasa a `entryFee`.
- `DominoMatchConfig.prizeUcMinor` pasa a `prize`.
- `SettlementEntry.amountUcMinor` pasa a `amount`.
- `PublicMatchConfig.entryFee` y `prize` conservan sus nombres, pero su comentario y sus tests pasan
  a UC completas.
- `settlementOf` devuelve el mismo importe UC que recibió la mesa, sin multiplicar por 100.
- El orquestador aplica `rateId + currency` y decide redondeo/centavos al comunicarse con la
  plataforma.

Ejemplo: un modo con `entryFee: 10`, `prize: 18` produce un reembolso `amount: 10` y una recompensa
`amount: 18`. Si un modo productivo tiene `entryFee: 1.5`, se conserva `1.5 UC` de punta a punta.

## 8. Nacimiento de una partida

El orquestador crea una mesa con identidad, `gameModeId`, `rateId`, seed y política de equipos; deja
de ser autoridad de `pointsToWin`, `entryFee` y `prize`. Domino resuelve el modo activo y construye el
snapshot inmutable:

```ts
interface CreateMatchRequest {
  readonly mode: "CASUAL";
  readonly matchId: string;
  readonly gameModeId: string;
  readonly participants: readonly MatchParticipant[];
  readonly seed: string;
  readonly teamAssignment: TeamAssignmentMode;
  readonly rateId: string;
}
```

La creación falla antes de cobrar/asignar sala cuando:

- el modo no existe o está inactivo;
- `participants.length !== playersQuantity`;
- el modo pide cuatro jugadores, porque ese motor todavía no está certificado.

La restricción 4P es explícita y temporal. El catálogo sí lista, modifica y publica modos 4P; abrirlos
para partidas requiere el incremento separado de motor, bots y reparto del premio.

Replay no consulta el catálogo actual. Recibe el `DominoMatchConfig` completo grabado al abrir la
mesa; así una edición posterior no cambia la reconstrucción histórica.

## 9. RabbitMQ y outbox

### 9.1 Contrato externo exacto

Exchange durable tipo `topic`: `betaso`.

Routing keys:

- creación: `game_mode.created`;
- actualización, desactivación, reactivación y sincronización: `game_mode.updated`.

Cuerpo crudo, sin wrapper NestJS:

```ts
interface GameModePayload {
  id: string;
  game: "domino";
  name: string;
  isActive: boolean;
  prize: number;
  entryFee: number;
  multiplier: number;
  pointsToWin: number;
  playerCount: number;
}
```

`isFreeRoom` y `enableBots` no se añaden al mensaje porque no existen en el contrato Rabbit de v1.
Las properties AMQP pueden llevar `messageId`, `contentType` y trazas; el body no cambia.

### 9.2 Garantías internas

- El cambio Mongo se confirma primero.
- Antes de responder éxito, la intención queda persistida en `game_mode_outbox`.
- El HTTP no espera a RabbitMQ.
- Un único dispatcher global, elegido con lease Mongo, publica en orden de inserción del outbox.
- La publicación usa confirm channel, mensajes persistentes y reintento exponencial acotado.
- Si el líder muere, el lease vence y otro proceso continúa.
- La entrega es **al menos una vez**: puede haber duplicados si el proceso cae después del confirm y
  antes de marcar `SENT`. Los consumidores deben hacer upsert por `id`, como ya permite el payload.
- Los registros `SENT` se conservan. El volumen es una entrada por cambio administrativo, por lo que
  no se introduce compactación hasta que una medición lo justifique.

Mongo standalone no puede hacer atómica la escritura entre dos colecciones. Para cerrar esa ventana,
el dispatcher reconcilia cada modo contra su revisión `__v`: si existe un documento actual sin evento
correspondiente, inserta `game_mode.updated`. `__v` y no `updatedAt` evita colapsar dos mutaciones del
mismo milisegundo. Perder un `created` durante una caída puede convertirlo en `updated`, exactamente
la estrategia de recuperación que ya usa `POST /sync` en v1.

El costo explícito de no exigir replica set es una respuesta ambigua si Mongo acepta el cambio del
modo y falla justo antes de aceptar el outbox: el HTTP devuelve 503 aunque el cambio puede haber
quedado aplicado. El orquestador debe releer el catálogo antes de reintentar; el reconciliador asegura
la entrega posterior. No se disfraza esa ventana como atomicidad inexistente.

`POST /sync` fuerza un nuevo `game_mode.updated` por cada modo, incluso si su revisión ya había sido
publicada, y responde `synced` con la cantidad de modos encolados.

## 10. Disponibilidad y ciclo de vida

- `MONGO_URI`, `RABBITMQ_URL` e `INTERNAL_API_KEY` son obligatorias con `NODE_ENV=production`.
- En test/desarrollo pueden omitirse y se usan adaptadores de memoria explícitos.
- `/health` sigue sin consultar dependencias.
- `/ready` comprueba Mongo, Redis si existe y RabbitMQ si existe, cada uno con su plazo independiente.
- Rabbit caído no impide jugar una mesa existente ni guardar cambios del catálogo en el outbox.
- Mongo caído impide listar/modificar modos y crear mesas nuevas, pero una mesa viva continúa con su
  snapshot.
- El apagado detiene el dispatcher, drena entregas en vuelo, drena historial, cierra AMQP y al final
  cierra Mongo. Redis sigue siendo responsabilidad de Colyseus.

## 11. Verificación y corte productivo

La suite ordinaria continúa sin servicios externos. Una suite de integración separada levanta Mongo y
RabbitMQ reales y verifica:

1. forma BSON, defaults e índices contra una colección vacía;
2. lectura de documentos con la forma exacta de v1;
3. todas las rutas HTTP y su protección;
4. bodies Rabbit literales para `created` y `updated`;
5. edición exitosa con Rabbit apagado y entrega posterior al recuperarlo;
6. reconciliación de un modo sin evento;
7. dos procesos compitiendo sin publicar actualizaciones fuera de orden;
8. una partida 2P creada desde un modo real y terminada por `SCORE`.

Orden de corte:

1. desplegar v2 conectado a una copia/restauración de producción y ejecutar la suite de contrato;
2. desplegar v2 sin apuntar todavía el panel;
3. detener las escrituras de v1;
4. dirigir el endpoint administrativo del orquestador a v2;
5. ejecutar `POST /game-modes/sync` una vez;
6. comprobar outbox vacío de pendientes y eventos consumidos;
7. retirar v1.

No hay migración de documentos. El rollback puede volver a v1 porque v2 conserva la forma productiva;
antes de hacerlo se detiene v2 para mantener un solo escritor.

## 12. Criterios de cierre

- Un dump real de `game_modes_domino` puede ser leído y devuelto sin transformación destructiva.
- Crear/editar/desactivar/reactivar produce documentos compatibles con Mongoose v1.
- El panel observa la misma API exitosa de v1 a través del orquestador.
- El cuerpo Rabbit es byte-equivalente en estructura y valores al contrato v1.
- Ninguna ruta administrativa acepta una llamada directa sin credencial del orquestador.
- Rabbit caído no pierde el cambio; la entrega ocurre al volver.
- Dos instancias comparten catálogo y outbox sin depender de memoria local.
- `10` se conserva como `10 UC` en catálogo, config pública y liquidación.
- El smoke real completa una partida 2P por `SCORE` usando un modo leído de Mongo.
- 4P, bots, torneo y apuesta dinámica siguen cerrados y explícitamente documentados.
