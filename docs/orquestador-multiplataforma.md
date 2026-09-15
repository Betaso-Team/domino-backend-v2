# Orquestador multiplataforma para juegos

Este documento describe lo que necesita el orquestador para conectar Domino y otros juegos con
distintas plataformas de usuarios, sin acoplar los motores a Betaso ni mover dinero dentro del juego.

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
  transactionOf(idempotencyKey: string): Promise<PlatformTransaction | undefined>;
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
  amountUc: number;       // entero
  rate: number;
  amountMinor: number;    // Math.round(amountUc * rate * 100)
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
