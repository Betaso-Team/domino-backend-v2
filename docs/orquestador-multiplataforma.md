# Orquestador multiplataforma para juegos

Este documento describe lo que necesita el orquestador para conectar Domino y otros juegos con
distintas plataformas de usuarios, sin acoplar los motores a Betaso ni mover dinero dentro del juego.

## Tecnología elegida

El orquestador debe ser un backend y repositorio independiente de Domino y de Betaso:

```text
TypeScript estricto
Node.js 24 LTS
NestJS
```

**NestJS sobre Node es la recomendación.** Este servicio no está limitado por el rendimiento del
router HTTP: espera a bases de datos, RabbitMQ y APIs externas. Importan más los módulos, inyección
de dependencias, guards, validación, apagado ordenado, pruebas y observabilidad. Además, Betaso ya
usa NestJS, por lo que el equipo puede reutilizar experiencia sin acoplar el nuevo servicio a su
código.

Comparación:

| Opción         | Decisión                    | Motivo                                                                                                                                                      |
| -------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node + NestJS  | **Elegida**                 | Mejor estructura para adapters, operaciones monetarias, HTTP, consumidores y procesos en background.                                                        |
| Node + Express | Válida, pero no recomendada | Es más pequeño al inicio, pero habría que volver a decidir y mantener DI, módulos, ciclo de vida, guards, errores y documentación.                          |
| Bun + Elysia   | No para la primera versión  | Es rápido y agradable, pero la compatibilidad de Bun con Node sigue siendo incompleta; ese riesgo no aporta valor en un servicio contable dominado por I/O. |

Node 24 está en LTS y recibe soporte hasta abril de 2028. No se debe usar una versión `Current` en
producción.

### Cómo usar NestJS sin sobrecargar el servicio

- una sola aplicación desplegable al inicio, con HTTP y consumidor Rabbit en el mismo proceso;
- usar el adapter Express que Nest trae por defecto; cambiarlo sólo si una medición real lo exige;
- módulos por capacidad: partidas, dinero, plataformas, juegos y entrega durable;
- dominio escrito en TypeScript normal, sin decorators de Nest;
- adapters de Betaso, Domino, HTTP, Rabbit y persistencia inyectados desde los módulos;
- `amqplib`/`amqp-connection-manager` directamente para RabbitMQ, con publisher confirms y ACK
  manual;
- no agregar Bull, CQRS ni otro broker: el outbox de base de datos y RabbitMQ ya cubren el trabajo;
- separar API y worker en procesos distintos sólo cuando una medición o aislamiento operativo lo
  justifique.

Nest ofrece transporte RabbitMQ, persistencia de mensajes y ACK manual, pero el flujo monetario
necesita controlar exactamente cuándo se confirma la publicación y cuándo se marca el outbox. Por
eso Rabbit debe quedar en un provider explícito y pequeño, no escondido detrás de un transporte RPC.

Referencias de la decisión:

- [Node.js — versiones y estado LTS](https://nodejs.org/en/about/previous-releases)
- [NestJS — transporte RabbitMQ](https://docs.nestjs.com/microservices/rabbitmq)
- [Bun — compatibilidad con Node.js](https://bun.sh/docs/runtime/nodejs-compat)
- [Elysia — runtimes soportados](https://elysiajs.com/quick-start)

## Responsabilidad de cada sistema

### Orquestador

El orquestador es responsable de:

- autenticar plataformas y administradores;
- resolver perfiles e identidad de usuarios;
- consultar las tasas de UC;
- cobrar entradas;
- crear partidas únicamente después de confirmar los cobros;
- reembolsar cobros si no se puede iniciar la partida;
- recibir el resultado económico de los juegos;
- convertir UC a la moneda congelada de cada jugador;
- ordenar recompensas o reembolsos a las plataformas;
- persistir idempotencia, reintentos, auditoría e instrucciones pendientes.

### Juego

Cada juego es responsable de:

- ser autoridad de sus reglas y modos de juego;
- crear y ejecutar la partida;
- validar que cada conexión corresponde a un asiento reservado;
- conservar el snapshot económico recibido al crear la mesa;
- decidir quién ganó o por qué se canceló;
- emitir una instrucción de recompensa o reembolso expresada en UC;
- reintentar de forma durable la entrega de esa instrucción.

El juego no consulta wallets, no convierte monedas y no necesita conocer la base de datos de Betaso.

### Plataforma

Cada plataforma es responsable de:

- autenticar a sus propios usuarios;
- devolver perfil, moneda y estado de cuenta;
- ejecutar cobros, recompensas y reembolsos;
- aceptar una clave de idempotencia o permitir consultar una transacción anterior.

## Cómo funciona hoy Betaso con Domino v1

Se revisó el flujo real de `Betaso-Backend` y `Betaso-Domino-Backend`. La integración actual está
partida en dos caminos porque tienen necesidades distintas:

| Operación                  | Transporte actual  | Contrato actual                                     | Motivo                                                                       |
| -------------------------- | ------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------- |
| Cobro de entrada (`CUT`)   | HTTP síncrono      | `POST /wallet-movements/betaso-game-movement`       | La partida necesita saber inmediatamente si hay saldo suficiente.            |
| Premio o reembolso (`ADD`) | RabbitMQ asíncrono | cola `transactions_queue`, patrón `domino.movement` | El resultado puede entregarse y reintentarse después de terminar la partida. |

Domino v1 convierte primero las UC a la unidad menor de la moneda y envía a Betaso el importe ya
convertido. El request HTTP contiene `userId`, `tokenId`, `reason`, `amount`, `bet`, `currency`,
`transactionType` y `gameMovementType`. Betaso reparte un `CUT` entre las wallets disponibles de esa
moneda; un `ADD` se acredita en la wallet `REAL`.

Para RabbitMQ, Domino v1 envía un mensaje persistente con el wrapper de NestJS:

```ts
{
  pattern: "domino.movement",
  data: {
    roomId,
    userId,
    amount,
    transactionType,
    currency,
    walletType,
    gameType,
    gameMovementType,
    reason,
    username,
    profilePicture,
    bet
  },
  id
}
```

Betaso consume `domino.movement`, selecciona el servicio por `gameType`, crea el movimiento y hace
`ack`. Si falla, hace `nack(requeue: false)`; por tanto, la recuperación depende de que la topología
del broker tenga un dead-letter exchange, algo que ese handler no garantiza por sí solo.

La deduplicación actual de Domino en Betaso calcula un SHA-256 con:

```text
gameMovementType | roomId | userId | transactionType | reason | walletType
```

Eso evita repetir el mismo movimiento semántico, pero `amount` y `currency` no forman parte de la
huella. Un reintento conflictivo con la misma identidad y distinto importe podría devolver el
movimiento anterior sin denunciar el conflicto. El orquestador debe conservar y comparar además la
huella canónica completa de la operación.

### Defectos actuales que no deben copiarse

- el endpoint HTTP de movimiento no declara un guard en la propia ruta;
- su DTO no recibe una clave de idempotencia proporcionada por el llamador;
- el publisher de Domino v1 no espera confirmación de RabbitMQ;
- el consumidor descarta el mensaje fallido de la cola activa con `requeue: false`;
- la interfaz Rabbit de Betaso está tipada para `ADD`, no como un contrato monetario bidireccional;
- una API key global compartida o una allowlist de IP no identifican ni permiten revocar cada
  plataforma por separado.

Estos puntos describen el código actual; no cambian el comportamiento que el adaptador inicial de
Betaso deba conservar.

Archivos usados para verificar este flujo:

```text
Betaso-Backend/src/modules/wallets/controllers/wallet-movements.controller.ts
Betaso-Backend/src/modules/wallets/dto/create-betaso-movement.dto.ts
Betaso-Backend/src/modules/queues-manager/controllers/queues-manager.controller.ts
Betaso-Backend/src/modules/queues-manager/services/queues-manager.service.ts
Betaso-Backend/src/modules/wallets/service/game-movement-services/domino-game-movement/domino-game-movement.service.ts
Betaso-Backend/src/modules/wallets/service/wallet-movement.service.ts
Betaso-Domino-Backend/src/storage/rabbitmq/publisher.ts
Betaso-Domino-Backend/src/rooms/domino-two-room.ts
Betaso-Domino-Backend/src/rooms/domino-four-room.ts
```

## Identidad común

La identidad global es la pareja:

```ts
interface UserRef {
  platformId: string;
  userUuid: string;
}
```

Reglas:

- `platformId` y `userUuid` se normalizan con `trim()`;
- un mismo `userUuid` en dos plataformas representa usuarios diferentes;
- `username` nunca se usa como identificador;
- la plataforma autenticada determina el `platformId`: no se confía en uno enviado libremente por
  el cliente.

La información entregada al juego por participante es:

```ts
interface GameParticipant {
  platformId: string;
  userUuid: string;
  currency: string;
  displayName: string;
  username: string;
  profilePicture: string;
}
```

`currency` es exactamente la moneda con la que se cobró a ese usuario. Queda congelada al crear la
partida y no puede cambiar aunque el usuario modifique después su perfil o moneda predeterminada.

## Regla económica de UC

Los importes del catálogo y del juego son **UC enteras**:

```text
12 = 12 UC
15 = 15 UC
18 = 18 UC
```

No existen `12,50 UC`, `1.5 UC` ni dos decimales implícitos dentro del valor UC. `entryFee`, `prize`
y `amount` deben ser enteros seguros, finitos y no negativos.

La conversión a la unidad menor de la moneda sigue exactamente la fórmula de Domino v1:

```ts
const finalAmount = Math.round(ucAmount * rate * 100);
```

Domino v1 la usa tanto en 2P como en 4P dentro de `createTransaction`:

```text
src/rooms/domino-two-room.ts
src/rooms/domino-four-room.ts
```

Ejemplo:

```text
ucAmount = 18
rate = 36.50

finalAmount = Math.round(18 × 36.50 × 100)
finalAmount = 65700
```

La plataforma recibe `65700`, que representa `657,00` en la moneda seleccionada.

El juego sólo conserva y devuelve:

- el importe entero en UC;
- `rateId`;
- la moneda congelada del jugador.

El orquestador consulta la tasa mediante `rateId + currency` y aplica la fórmula. El mismo `rateId`
debe utilizarse para cobrar, recompensar y reembolsar. Preferiblemente el UUID identifica un conjunto
de tasas inmutable; si el proveedor permite editarlo, el orquestador debe guardar también la tasa
exacta aplicada durante el cobro.

## Adaptador de plataforma

Cada plataforma integrada implementa como mínimo:

```ts
interface PlatformAdapter {
  getProfile(userUuid: string): Promise<PlatformProfile>;
  charge(operation: MoneyOperation): Promise<PlatformTransaction>;
  refund(operation: MoneyOperation): Promise<PlatformTransaction>;
  reward(operation: MoneyOperation): Promise<PlatformTransaction>;
  transactionOf(
    idempotencyKey: string,
  ): Promise<PlatformTransaction | undefined>;
}

interface PlatformProfile {
  displayName: string;
  username: string;
  profilePicture: string;
  currency: string;
}
```

Configuración mínima:

```ts
interface PlatformConfig {
  platformId: string;
  baseUrl: string;
  credentials: EncryptedCredentials;
  enabled: boolean;
}
```

### Adaptador inicial de Betaso

El orquestador debe esconder el contrato legado detrás de `PlatformAdapter`; ningún juego nuevo debe
conocer `betaso-game-movement`, `transactions_queue` ni `domino.movement`.

La migración mínima es:

1. `charge` llama al HTTP actual porque necesita una respuesta definitiva antes de crear la mesa;
2. `reward` y `refund` pueden publicar temporalmente el movimiento Rabbit actual, pero permanecen
   `PENDING` porque esa cola no devuelve el resultado contable;
3. el orquestador guarda antes su propia operación e `idempotencyKey`;
4. si un timeout deja resultado ambiguo, pasa a `RECONCILIATION_REQUIRED` y no reenvía a ciegas;
5. el adaptador compara `amount`, `currency`, usuario y tipo contra la operación original antes de
   aceptar una deduplicación de Betaso.

El destino estable debería ser una API interna de movimientos de Betaso que acepte la misma
`idempotencyKey` del orquestador y permita consultarla:

```text
POST /internal/orchestrator/money-movements
GET  /internal/orchestrator/money-movements/:idempotencyKey
```

No hace falta cambiar de una vez la contabilidad interna de Betaso. Ese endpoint puede traducir al
servicio actual, pero debe responder uno de estos resultados explícitos:

```text
APPLIED | ALREADY_APPLIED | REJECTED | PENDING | CONFLICT
```

`CONFLICT` significa que la clave ya existe con otro usuario, moneda, importe o tipo. Esto cierra el
hueco que tiene hoy el hash legado.

## Seguridad plataforma-orquestador sin JWT

Para la primera versión se elige **HTTPS + una API key opaca diferente por plataforma**. Es menos
completa que firmar cada request, pero reduce mucho el tiempo de implementación y la explicación a
los integradores. La API key vive únicamente en el backend de la plataforma y en el orquestador;
nunca en el navegador ni en la aplicación móvil.

Cada request lleva `X-Platform-Key`; las mutaciones idempotentes añaden un segundo header:

```http
X-Platform-Key: pk_live_public-id.secret-aleatorio
Idempotency-Key: 7b718f8f-...
```

La API key identifica a la plataforma; el orquestador deriva de ella `platformId` y permisos. Si el
body también contiene `platformId`, debe coincidir, pero nunca es la fuente de autoridad.

Esta key autentica llamadas **hacia** el orquestador. Para llamar desde el orquestador a la API de
una plataforma, su adapter usa otra credencial emitida por esa plataforma; no se reutiliza la key de
entrada en ambas direcciones.

Validación obligatoria del orquestador:

1. exigir TLS y rechazar HTTP;
2. generar al menos 32 bytes aleatorios para el secreto;
3. guardar sólo el identificador público y el hash SHA-256 del secreto, nunca la key recuperable;
4. verificar el hash en tiempo constante y rechazar keys revocadas o del entorno incorrecto;
5. derivar `platformId`, juegos, rutas y permisos desde la credencial;
6. exigir `Idempotency-Key` en cobros, premios, reembolsos y creación de partidas;
7. limitar la tasa de requests por plataforma y registrar auditoría sin escribir la key en logs;
8. permitir dos keys activas por plataforma para rotarlas sin cortar el servicio.

Las keys de sandbox y producción son diferentes. Una credencial comprometida puede revocarse por su
identificador público sin afectar a las demás plataformas. Una allowlist de IP puede añadirse como
defensa adicional, pero no reemplaza la key.

### Endurecimiento posterior, no requisito del MVP

HTTP Message Signatures con HMAC-SHA256 según RFC 9421 y mTLS siguen siendo opciones válidas, pero no
forman parte del contrato inicial. Se justifican cuando una plataforma regulada los exija, el tráfico
atraviese intermediarios no controlados o una auditoría requiera integridad y protección de replay a
nivel de cada request. Pueden agregarse después en el middleware de autenticación sin cambiar los
DTO ni los endpoints del negocio.

### Inicio de juego desde navegador o app

El contrato toma como referencia el flujo **Game launch** de _Vibra RGS Casino Wallet Integration_:
la plataforma abre una URL entregada por el proveedor dentro de un `iframe` o una ventana nueva.
Vibra incluye `siteId`, juego, usuario, moneda, idioma, canal, regreso al lobby y token en esa URL.
El orquestador conserva sólo lo necesario para abrir el lobby del juego y deja en la URL pública
únicamente un código opaco.

Equivalencias:

| Vibra         | Orquestador                                              |
| ------------- | -------------------------------------------------------- |
| `siteId`      | `platformId`, derivado de `X-Platform-Key`               |
| `gameId`      | `game`, nombre estable como `domino` o `truco`           |
| `userId`      | `userUuid`, estable dentro de la plataforma              |
| `currency`    | moneda de la sesión, congelada al aceptar el lanzamiento |
| `lobbyURL`    | `returnUrl` hacia la plataforma                          |
| `lobbyTarget` | `returnTarget`                                           |
| `token`       | `launchCode` opaco, corto y de un solo uso               |

No se reciben modo de juego, idioma ni tipo de dispositivo. El destino siempre es el lobby del
juego; ese lobby ya conoce su catálogo, presenta sus modos y adapta su interfaz al cliente.
`POST /v1/launches` no selecciona modo, no crea una partida y no cobra.

La API key nunca se instala en un cliente. El backend de la plataforma crea el lanzamiento:

```http
POST /v1/launches HTTP/1.1
Host: orchestrator.example.com
Content-Type: application/json
X-Platform-Key: pk_live_public-id.secret-aleatorio
Idempotency-Key: 3ccd0cf2-e995-4d5f-a926-51b3ebd4a996

{
  "game": "domino",
  "userUuid": "usuario-77",
  "currency": "VES",
  "returnUrl": "https://partner.example.com/games",
  "returnTarget": "_top"
}
```

`platformId` no se recibe: sale de la API key. Tampoco se reciben nombre, avatar ni saldo; el
orquestador los consulta al adapter autenticado de la plataforma. `game` se resuelve contra el
registro interno de juegos habilitados y siempre apunta a su lobby. La moneda se valida con la
plataforma y queda inmutable: cobro, premio y reembolso deben usar esa misma moneda.

Respuesta:

```http
HTTP/1.1 201 Created
Content-Type: application/json

{
  "launchId": "2f58e699-d83d-49ca-a447-1ff8328b7434",
  "launchUrl": "https://play.example.com/launch?code=lc_live_Zi5x...",
  "expiresAt": "2026-09-15T18:31:00.000Z"
}
```

La plataforma usa `launchUrl` en una ventana nueva o en un `iframe`:

```html
<iframe
  src="https://play.example.com/launch?code=lc_live_Zi5x..."
  allow="fullscreen"
></iframe>
```

El flujo completo es:

1. la plataforma autentica al usuario por su mecanismo habitual;
2. su backend crea el lanzamiento con su API key;
3. el orquestador valida plataforma, nombre del juego, moneda y `returnUrl`;
4. devuelve una URL con un código aleatorio de 32 bytes, de un solo uso y válido por 60 s;
5. el navegador abre esa URL y el orquestador consume el código atómicamente;
6. el usuario entra al lobby del juego;
7. el propio juego muestra sus modos, recibe la selección y gestiona la entrada a partida;
8. el cobro ocurre después, cuando el flujo del juego confirma el modo elegido.

El código se guarda sólo como hash y no contiene identidad ni dinero. Un retry con la misma
`Idempotency-Key` devuelve el mismo lanzamiento mientras siga vigente; para generar uno nuevo se usa
otra clave. `returnUrl` debe pertenecer a los orígenes HTTPS permitidos para esa plataforma y
`returnTarget` sólo acepta `_self`, `_parent` o `_top`; no se admiten URLs `javascript:`.
El host de juego también limita qué plataformas pueden embeberlo mediante CSP `frame-ancestors`.

El `token` rotativo de Vibra acompaña después todas sus llamadas de wallet. No se copia esa parte:
el `launchCode` sirve únicamente para entregar la sesión al navegador, mientras las operaciones de
wallet usan las credenciales del adapter y sus claves de idempotencia.

La guía para integrar una plataforma necesita únicamente la URL base, su API key y estos ejemplos
de creación y apertura. No tiene que implementar criptografía ni una librería propietaria.

Referencias normativas:

- [RFC 9421 — HTTP Message Signatures](https://www.rfc-editor.org/rfc/rfc9421.html)
- [RFC 8446 — TLS 1.3](https://www.rfc-editor.org/rfc/rfc8446.html)

## Adaptador de juego

No hace falta un sistema dinámico de plugins. Un adapter explícito por juego es suficiente:

```ts
interface GameAdapter {
  listGameModes(): Promise<readonly GameMode[]>;
  createMatch(input: CreateGameMatch): Promise<CreatedGameMatch>;
  cancelMatch(matchId: string, reason: string): Promise<void>;
  matchStatus(matchId: string): Promise<GameMatchStatus>;
}
```

Configuración mínima:

```ts
interface GameConfig {
  gameId: string;
  baseUrl: string;
  internalApiKey: string;
  enabled: boolean;
}
```

El catálogo pertenece al juego. El orquestador puede consultarlo o proxificarlo, pero no debe
mantener una segunda copia autoritativa.

## Creación de una partida

No existe una transacción distribuida entre plataformas y juegos. El orquestador debe ejecutar una
saga:

1. autenticar a los participantes y sus plataformas;
2. obtener perfiles y monedas desde cada plataforma;
3. consultar al juego el modo seleccionado;
4. comprobar que esté activo y admita la cantidad de participantes;
5. obtener un `rateId` válido y resolver la tasa para cada moneda;
6. calcular cada cobro con `Math.round(entryFee * rate * 100)`;
7. cobrar a cada participante usando una clave idempotente;
8. crear la partida sólo cuando todos los cobros estén confirmados;
9. emitir un token de acceso para cada participante;
10. si falla un cobro o la creación del juego, reembolsar todos los cobros confirmados.

Estados mínimos:

```text
CREATED
  → CHARGING
  → STARTING_GAME
  → ACTIVE
  → SETTLING
  → SETTLED
```

Camino de compensación:

```text
CHARGING o STARTING_GAME
  → REFUNDING
  → REFUNDED
```

Si una plataforma responde con timeout y no puede determinarse si movió el dinero:

```text
RECONCILIATION_REQUIRED
```

En ese estado se consulta primero `transactionOf(idempotencyKey)`; nunca se repite el movimiento a
ciegas.

## Request esperado por Domino

Cuando Domino termine la integración de su catálogo, el orquestador creará una partida con:

```json
{
  "mode": "CASUAL",
  "matchId": "5d01d1eb-3971-42aa-bb14-9c669c16551c",
  "gameModeId": "uuid-del-modo",
  "rateId": "uuid-del-conjunto-de-tasas",
  "seed": "seed-seguro",
  "teamAssignment": "SHUFFLED",
  "participants": [
    {
      "platformId": "betaso",
      "userUuid": "usuario-1",
      "currency": "VES",
      "displayName": "David",
      "username": "david",
      "profilePicture": "https://..."
    },
    {
      "platformId": "partner-x",
      "userUuid": "usuario-77",
      "currency": "USD",
      "displayName": "Ana",
      "username": "ana",
      "profilePicture": "https://..."
    }
  ]
}
```

El orquestador no envía `entryFee`, `prize` ni `pointsToWin`: Domino los obtiene del modo identificado
por `gameModeId`. La creación debe ser idempotente por `gameId + matchId`.

## Token para entrar a Domino

Domino actualmente valida JWT `HS256` y requiere:

```json
{
  "sub": "usuario-1",
  "platformId": "betaso",
  "exp": 1234567890
}
```

El orquestador emite un token corto por jugador y devuelve al cliente `roomId`, dirección del juego y
token. El secreto de firma sólo se comparte entre el orquestador y Domino.

Este JWT es el ticket interno que Domino ya sabe validar; no autentica a una plataforma ante el
orquestador. La comunicación B2B usa la API key anterior. Cambiar también el ticket interno por
uno opaco requeriría agregar introspección a Domino y no aporta nada a la primera integración.

## Instrucción económica emitida por un juego

Contrato común recomendado:

```ts
interface SettlementInstruction {
  eventId: string;
  version: 1;
  gameId: string;
  matchId: string;
  rateId: string;
  kind: "REWARD" | "REFUND";
  entries: readonly SettlementEntry[];
}

interface SettlementEntry {
  platformId: string;
  userUuid: string;
  currency: string;
  amount: number; // UC enteras
  idempotencyKey: string;
}
```

Recompensa:

```json
{
  "eventId": "evento-1",
  "version": 1,
  "gameId": "domino",
  "matchId": "match-1",
  "rateId": "rate-1",
  "kind": "REWARD",
  "entries": [
    {
      "platformId": "betaso",
      "userUuid": "usuario-1",
      "currency": "VES",
      "amount": 18,
      "idempotencyKey": "[\"match-1\",\"REWARD\",\"betaso\",\"usuario-1\"]"
    }
  ]
}
```

El orquestador transforma esa entrada así:

```ts
const amountMinor = Math.round(entry.amount * rate * 100);
```

Un `REFUND` contiene una entrada por cada jugador cobrado y devuelve exactamente el `entryFee` UC de
la mesa usando su moneda y tasa congeladas.

## Operaciones monetarias e idempotencia

```ts
interface MoneyOperation {
  gameId: string;
  matchId: string;
  platformId: string;
  userUuid: string;
  currency: string;
  rateId: string;
  amountUc: number; // entero
  rate: number;
  amountMinor: number; // Math.round(amountUc * rate * 100)
  idempotencyKey: string;
}
```

Claves recomendadas:

```text
[gameId, matchId, "CHARGE", platformId, userUuid]
[gameId, matchId, "REFUND", platformId, userUuid]
[gameId, matchId, "REWARD", platformId, userUuid]
```

Cada clave es única. Un reintento devuelve la operación ya existente y no mueve dinero otra vez.

## Entrega durable

```text
Juego
  → guarda el desenlace
  → guarda el evento en outbox
  → publica y reintenta
  → orquestador guarda el evento en inbox
  → confirma recepción
  → convierte UC
  → guarda la operación monetaria
  → llama a la plataforma y reintenta
```

Garantías necesarias:

- entrega al menos una vez;
- eventos duplicados inocuos;
- un Rabbit caído no pierde el resultado;
- un timeout no produce un segundo pago;
- retries con backoff y sin descarte silencioso;
- estado de revisión manual para resultados externos ambiguos.

El exchange `betaso` y los eventos `game_mode.*` de Domino son compatibilidad del catálogo v1. Los
desenlaces económicos deberían viajar por un contrato cuyo nombre no dependa de Betaso.

### RabbitMQ entre juegos y orquestador

El Rabbit nuevo termina en el orquestador, no en Betaso:

```text
Domino u otro juego
  → exchange del orquestador
  → evento game.settlement.v1
  → inbox idempotente del orquestador
  → PlatformAdapter correspondiente
  → Betaso u otra plataforma
```

Cada juego usa su propio usuario Rabbit, TLS y permisos limitados a su routing key. El publisher usa
confirm channel; mensajes y colas son durables; el juego marca su outbox como enviado sólo después
del confirm. El consumidor confirma únicamente después de persistir el evento en su inbox. Un fallo
va a retry/dead-letter con alerta, nunca a descarte silencioso.

Envelope común recomendado:

```ts
interface GameEvent<T> {
  eventId: string;
  version: 1;
  gameId: string;
  type: "game.settlement";
  occurredAt: string;
  data: T;
}
```

La unicidad `(gameId, eventId)` hace inocua la entrega al menos una vez. El wrapper
`{ pattern, data, id }` de NestJS puede aceptarse durante la transición, pero no debe ser el contrato
común de todos los juegos.

## Administración de modos

El orquestador autentica el administrador y llama al juego con una credencial interna. Para Domino:

```text
GET    /game-modes
GET    /game-modes/:uuid
POST   /game-modes
PUT    /game-modes/:uuid
DELETE /game-modes/:uuid
GET    /game-modes/reactive/:uuid
POST   /game-modes/sync
```

Las mutaciones llevan `X-Internal-Key`. La llave nunca se entrega al navegador.

## Persistencia mínima del orquestador

El orquestador necesita almacenar:

- juegos;
- plataformas;
- partidas;
- participantes y su moneda congelada;
- tasa aplicada por participante;
- operaciones monetarias;
- eventos recibidos en inbox;
- trabajos pendientes en outbox.

Restricciones mínimas:

```text
gameId único
platformId único
(gameId, matchId) único
(gameId, eventId) único
(gameId, idempotencyKey) único
```

`currency`, `rateId`, `amountUc`, `rate` y `amountMinor` quedan inmutables después del cobro.

## Trabajo pendiente en Domino

Para una integración completa todavía hacen falta:

- terminar el cableado del catálogo a la creación de partidas;
- impedir UC fraccionarias en catálogo, config de mesa y liquidación;
- dejar de recibir dinero/puntos desde el request y resolverlos por `gameModeId`;
- creación idempotente por `matchId`;
- endpoint interno idempotente para cancelar una partida;
- endpoint interno para consultar estado y desenlace;
- entrega durable de `settlementOf` al orquestador;
- outbox de desenlaces separado del outbox de `game_mode.*`;
- regla de reparto 4P antes de permitir liquidación de mesas de cuatro.

El `settlementOf` actual ya proyecta `REWARD` y `REFUND`, pero nadie lo entrega fuera del proceso.

## Pruebas mínimas de aceptación

1. Dos usuarios de plataformas distintas pueden jugar aunque compartan el mismo `userUuid`.
2. Cada jugador se cobra y recompensa en su moneda congelada.
3. `18 UC` se convierte exactamente con `Math.round(18 * rate * 100)`.
4. El catálogo, la mesa y el resultado rechazan `1.5 UC`.
5. Si falla el segundo cobro, se reembolsa el primero.
6. Si falla la creación de la partida después de cobrar, se reembolsa a todos.
7. Un evento duplicado no genera un segundo movimiento.
8. Rabbit caído no pierde una recompensa o reembolso.
9. Cambiar la tasa o moneda después del cobro no altera la partida.
10. Un cliente no puede ocupar un asiento reservado a otra pareja `{platformId, userUuid}`.
11. Un request B2B sin key, con key inválida, revocada o de otro entorno se rechaza.
12. Una key no puede usar rutas, juegos ni operaciones fuera de sus permisos.
13. Repetir una `Idempotency-Key` con el mismo contenido devuelve el resultado anterior.
14. Repetir una `Idempotency-Key` con distinto usuario, moneda, importe o tipo devuelve `CONFLICT`.
15. La URL pública de lanzamiento no contiene `platformId`, `userUuid`, moneda ni API key.
16. Un `launchCode` sólo puede consumirse una vez y falla después de 60 s.
17. Un `returnUrl` fuera de los orígenes permitidos para la plataforma se rechaza.
18. La moneda aceptada en el lanzamiento no puede cambiarse al cobrar o liquidar.
