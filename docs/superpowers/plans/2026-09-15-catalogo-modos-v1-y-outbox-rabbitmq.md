# Catálogo de modos v1 y outbox RabbitMQ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reemplazar el catálogo de modos de Domino v1 con una implementación v2 compatible con su colección Mongo, API HTTP y eventos RabbitMQ, sin acoplar el juego a Betaso y sin perder cambios cuando el broker esté caído.

**Architecture:** `features/game-mode` contiene contratos y casos de uso; Mongo, HTTP y AMQP son adaptadores. El orquestador autentica administradores y llama las mutaciones con `X-Internal-Key`; un outbox Mongo reconciliable entrega al exchange `betaso` con confirmación y liderazgo por lease, mientras cada partida conserva un snapshot del modo que resolvió al nacer.

**Tech Stack:** TypeScript 5.7, Node 22, Express 5, Zod 4, MongoDB driver 7, amqplib 2, Colyseus 0.18, Vitest 3, Docker Compose, PM2 y Nginx.

**Design authority:** `docs/superpowers/specs/2026-09-15-catalogo-modos-v1-y-outbox-rabbitmq-design.md`.

---

## Mapa de archivos

### Nuevos

- `src/features/game-mode/core/game-mode.ts` — entidad portable y entradas de creación/edición.
- `src/features/game-mode/core/catalog.ts` — puertos de lectura/escritura y errores de aplicación.
- `src/features/game-mode/events.ts` — payload Rabbit literal y claves de evento.
- `src/features/game-mode/service.ts` — CRUD, defaults, bloqueo de escrituras y encolado.
- `src/features/game-mode/outbox.ts` — contrato del outbox y dispatcher.
- `src/features/game-mode/transports/memory-repository.ts` — catálogo de proceso para test/desarrollo.
- `src/features/game-mode/transports/mongo-repository.ts` — documento BSON, índices y adapter Mongo.
- `src/features/game-mode/transports/memory-outbox.ts` — outbox de proceso para tests sin servicios.
- `src/features/game-mode/transports/mongo-outbox.ts` — persistencia y reconciliación durable.
- `src/features/game-mode/transports/http/schemas.ts` — schemas Zod compatibles con v1.
- `src/features/game-mode/transports/http/register-http.ts` — rutas `/game-modes`.
- `src/features/game-mode/index.ts` — única superficie importable desde otras features.
- `src/shared/amqp.ts` — conexión/canal confirm portable.
- `src/shared/mongo-lease.ts` — exclusión distribuida usada por CRUD y dispatcher.
- `src/shared/http/validated.ts` — promoción del validador HTTP al aparecer la segunda feature.
- Tests gemelos junto a cada archivo anterior.
- `src/smoke/game-mode-smoke.ts` — fases reales Mongo/Rabbit/HTTP dentro del smoke existente.

### Modificados

- `src/features/match/core/config.ts`, `network/settlement.ts`, `transports/match-contract.ts`,
  `transports/match-registry.ts` — UC completa y snapshot resuelto desde catálogo.
- `src/features/match/transports/colyseus/domino-room.ts` — resolución del modo activo antes de crear
  estado.
- Fixtures, replay, golden y smoke que todavía escriben `*UcMinor`.
- `src/env.ts`, `src/di-container.ts`, `src/app.config.ts`, `src/main.ts` — configuración, wiring,
  readiness y apagado.
- `.env.example`, `package.json`, `package-lock.json`, `compose.smoke.yaml`, `.github/workflows/ci.yml`.
- `AGENTS.md` y las specs anteriores que describen UC minor.

---

### Task 1: Restaurar la semántica UC de v1

**Files:**
- Modify: `src/features/match/core/config.ts`
- Modify: `src/features/match/transports/match-contract.ts`
- Modify: `src/features/match/transports/match-registry.ts`
- Modify: `src/features/match/network/settlement.ts`
- Modify: `src/features/match/network/tests/settlement.test.ts`
- Modify: `src/features/match/transports/match-contract.test.ts`
- Modify: `src/features/match/core/engine/tests/match-config-fixture.ts`
- Modify: `src/features/match/tests/e2e-harness.ts`
- Modify: `src/replay.ts`
- Modify: `src/smoke/engine-smoke.ts`
- Modify: `src/features/match/tests/fixtures/golden-2p.json`
- Modify: `src/features/match/transports/match-registry.test.ts`
- Modify: `src/features/match/tests/replay.test.ts`
- Modify: `src/features/match/network/tests/history.test.ts`
- Modify: `src/features/match/transports/colyseus/domino-room.test.ts`
- Modify: `src/features/lobby/tests/lobby-e2e.test.ts`
- Modify: `README.md`

- [ ] **Step 1: escribir el test rojo que distingue UC de UC minor**

En `settlement.test.ts`, construir una mesa con `entryFee: 1.5` y `prize: 2.75` y afirmar literales,
sin recalcularlos con la implementación:

```ts
expect(refund).toMatchObject({
  kind: "REFUND",
  entries: [
    { platformId: "betaso", userUuid: "u1", currency: "VES", amount: 1.5 },
    { platformId: "partner", userUuid: "u2", currency: "USD", amount: 1.5 },
  ],
});
expect(reward).toMatchObject({ kind: "REWARD", entries: [{ amount: 2.75 }] });
```

En `match-contract.test.ts`, enviar `entryFee`/`prize` y comprobar que el snapshot conserva el número
exacto. Añadir un caso que rechace `NaN`, `Infinity` y negativos, pero acepte decimales finitos.

- [ ] **Step 2: ejecutar el rojo esperado**

Run:

```bash
npx vitest run src/features/match/transports/match-contract.test.ts src/features/match/network/tests/settlement.test.ts
```

Expected: FAIL porque el contrato todavía exige `entryFeeUcMinor`/`prizeUcMinor` y la instrucción aún
expone `amountUcMinor`.

- [ ] **Step 3: renombrar sin escalar**

Aplicar estas formas, sin `* 100` ni `/ 100`:

```ts
export interface DominoMatchConfig {
  // campos existentes...
  readonly entryFee: number;
  readonly prize: number;
}

export interface SettlementEntry extends PlayerRef {
  readonly currency: string;
  readonly amount: number;
  readonly idempotencyKey: string;
}

const ucAmount = z.number().finite().nonnegative();
```

`PublicMatchConfig` conserva `entryFee`/`prize`; quitar el comentario que dice UC minor. Reemplazar
todas las ocurrencias de `entryFeeUcMinor`, `prizeUcMinor` y `amountUcMinor` en código, fixtures y
smoke. No cambiar `rateId`, `currency` ni las claves de idempotencia.

⚠ **`.safe()` no sirve para expresar el techo del entero seguro.** En zod 4 `.safe()` IMPLICA
entero y rechaza `1.5` (medido sobre la 4.6.1 instalada), así que la guarda que `Number.isSafeInteger`
daba contra el desborde de la mantisa —dos montos distintos que son el mismo número— se escribe
`.max(Number.MAX_SAFE_INTEGER)`. El `ucAmount` que quedó es
`z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER)`: la forma del snippet sola habría
aceptado `2 ** 53` como monto de una mesa.

⚠ **También hay que tocar `match-registry.test.ts`.** Su aserción de fuga listaba
`"entryFeeUcMinor"`/`"prizeUcMinor"` entre los nombres que el DTO público NO puede contener; con el
renombre, ese mismo `not.toContain` contradice al `toMatchObject({ entryFee: 125 })` de dos líneas
abajo. Un `sed` ciego deja el test rojo. La aserción deja de tener qué medir —el nombre del wire y
el del campo interno pasan a ser el mismo— y lo que se conserva es la lista de identidad, moneda y
tasa.

- [ ] **Step 4: regenerar el golden y ejecutar gates del task**

Run:

```bash
$env:WRITE_GOLDEN='1'; npx vitest run src/features/match/tests/game-2p-e2e.test.ts; Remove-Item Env:WRITE_GOLDEN
npx vitest run src/features/match/transports/match-contract.test.ts src/features/match/network/tests/settlement.test.ts src/features/match/tests/replay.test.ts src/deploy-smoke.test.ts
npm run typecheck
```

Expected: todos PASS y el golden contiene `entryFee`/`prize`, nunca `*UcMinor`.

⚠ **El golden lo escribe `game-2p-e2e.test.ts`, no `replay.test.ts`.** `replay.test.ts` solo LEE
`fixtures/golden-2p.json`; el único llamador de `writeGolden` es el `beforeAll` de
`game-2p-e2e.test.ts`, que es el único punto donde el árbol final y su historial están los dos
completos (`tests/e2e-harness.ts`). Con el comando del plan, `WRITE_GOLDEN=1` no escribe nada y el
gate siguiente falla en `typecheck` —no en vitest, que transpila con esbuild— con el `as
DominoMatchConfig` de la línea 103 rechazado por los dos campos que faltan.

- [ ] **Step 5: commit**

```bash
git add src/features/match src/replay.ts src/smoke/engine-smoke.ts
git commit -m "fix(economy): restaura los importes UC de domino v1"
```

---

### Task 2: Promover el validador HTTP compartido

**Files:**
- Create: `src/shared/http/validated.ts`
- Create: `src/shared/http/validated.test.ts`
- Delete: `src/features/match/transports/http/validated.ts`
- Delete: `src/features/match/transports/http/validated.test.ts`
- Modify: `src/features/match/transports/http/register-http.ts`
- Modify: `src/architecture.test.ts`

- [ ] **Step 1: escribir el guard rojo de ubicación única**

En `architecture.test.ts`, afirmar que toda feature que necesite `validated` importa
`shared/http/validated.js` y que no existe una copia bajo `features/`:

```ts
expect(files.some((file) => /features\/.*\/validated\.ts$/.test(file))).toBe(false);
```

- [ ] **Step 2: ejecutar el rojo**

```bash
npx vitest run src/architecture.test.ts
```

Expected: FAIL porque el archivo todavía vive en `features/match`.

- [ ] **Step 3: mover sin cambiar comportamiento**

Copiar íntegros implementación y tests a `src/shared/http/`, actualizar el import de
`register-http.ts` a:

```ts
import { validated } from "../../../../shared/http/validated.js";
```

Eliminar los archivos viejos. No añadir un barrel de `shared/http`: ningún consumidor lo necesita.

- [ ] **Step 4: verificar y commit**

```bash
npx vitest run src/shared/http/validated.test.ts src/architecture.test.ts
npm run typecheck
git add src/shared/http src/features/match/transports/http src/architecture.test.ts
git commit -m "refactor(http): comparte la validacion de fronteras"
```

Expected: PASS.

---

### Task 3: Definir el catálogo portable y el contrato Rabbit

**Files:**
- Create: `src/features/game-mode/core/game-mode.ts`
- Create: `src/features/game-mode/core/catalog.ts`
- Create: `src/features/game-mode/events.ts`
- Create: `src/features/game-mode/events.test.ts`
- Create: `src/features/game-mode/index.ts`

- [ ] **Step 1: escribir el test rojo del payload literal**

```ts
it("conserva el contrato Rabbit de domino v1", () => {
  expect(updatedEventOf(mode)).toEqual({
    key: "game_mode.updated",
    payload: {
      id: "mode-1",
      game: "domino",
      name: "Clásica",
      isActive: true,
      prize: 18,
      entryFee: 10,
      multiplier: 2,
      pointsToWin: 25,
      playerCount: 2,
    },
  });
});
```

El objeto `mode` debe incluir además `isFreeRoom` y `enableBots`; su ausencia del payload se mide al
usar `toEqual`, no `objectContaining`.

⚠ **`payload.id` es el `uuid` del modo, NO el hex del `_id`**, y ni este plan ni la spec lo decían: la
entidad tiene los dos identificadores y §9.1 sólo declara `id: string`. Lo resuelve el v1 productivo,
que es la autoridad del contrato: `Betaso-Domino-Backend/src/game-modes/game-mode.publisher.ts:43`
hace `id: mode.uuid` (el mismo `buildPayload` para `created` y `updated`). **Al revés no falla nada
del lado de Domino**: el consumidor upsertea por `id`, así que publicar el `_id` le crea un registro
nuevo por cada modo en vez de actualizar el que ya tiene. Por eso el `mode` del test lleva `id` y
`uuid` DISTINTOS —`id` con forma de hex de ObjectId y `uuid: "mode-1"`—: con el mismo valor ninguna
aserción distingue cuál se mapeó. Ojo con la asimetría que queda: `toDTO` de la Tarea 9 sí mapea
`id→_id`, porque el DTO HTTP de v1 devuelve los dos campos.

De paso, dos cosas más que el mismo archivo de v1 confirma y que valen para las Tareas 5 y 6: el
cuerpo va **pelado**, sin el wrapper `{ pattern, data, id }` de NestJS —ése es el camino de colas
(`publish`), no el del exchange (`publishToExchange`)—, y el exchange se declara `topic` y `durable`
con properties `persistent`, `contentType: "application/json"` y `messageId`.

- [ ] **Step 2: ejecutar el rojo**

```bash
npx vitest run src/features/game-mode/events.test.ts
```

Expected: FAIL por módulos inexistentes.

- [ ] **Step 3: crear contratos mínimos**

`core/game-mode.ts`:

```ts
export interface GameMode {
  readonly id: string;
  readonly uuid: string;
  readonly name: string;
  readonly multiplier: number;
  readonly prize: number;
  readonly entryFee: number;
  readonly playersQuantity: 2 | 4;
  readonly pointsToWin: number;
  readonly isActive: boolean;
  readonly isFreeRoom: boolean;
  readonly enableBots: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly version: number;
}

type DefaultedGameModeFields =
  | "multiplier"
  | "pointsToWin"
  | "isFreeRoom"
  | "enableBots";

export type CreateGameMode = Omit<
  GameMode,
  | "id"
  | "uuid"
  | "createdAt"
  | "updatedAt"
  | "version"
  | "isActive"
  | DefaultedGameModeFields
> & Partial<Pick<GameMode, DefaultedGameModeFields>>;

export type UpdateGameMode = Partial<
  Pick<GameMode, "name" | "multiplier" | "prize" | "entryFee" | "playersQuantity" |
    "pointsToWin" | "isActive" | "isFreeRoom" | "enableBots">
>;
```

`core/catalog.ts`:

```ts
export interface GameModeReader {
  active(): Promise<readonly GameMode[]>;
  all(): Promise<readonly GameMode[]>;
  activeByUuid(uuid: string): Promise<GameMode | undefined>;
  byUuid(uuid: string): Promise<GameMode | undefined>;
}

export interface GameModeRepository extends GameModeReader {
  create(input: CreateGameMode): Promise<GameMode>;
  update(uuid: string, input: UpdateGameMode): Promise<GameMode | undefined>;
}

export class GameModeNotFoundError extends Error {}
export class DuplicateGameModeError extends Error {}
export class GameModeWriteBusyError extends Error {}
```

`events.ts` debe exportar `GAME_MODE_EXCHANGE = "betaso"`, los dos routing keys, el tipo exacto de
payload y `createdEventOf`/`updatedEventOf`. Exportar desde `features/game-mode/index.ts` solamente lo
que otras capas deban nombrar.

- [ ] **Step 4: verde y commit**

```bash
npx vitest run src/features/game-mode/events.test.ts
npm run typecheck
git add src/features/game-mode
git commit -m "feat(game-mode): define el contrato portable del catalogo"
```

---

### Task 4: Implementar el repositorio Mongo compatible

**Files:**
- Create: `src/features/game-mode/transports/mongo-repository.ts`
- Create: `src/features/game-mode/transports/mongo-repository.test.ts`
- Create: `src/features/game-mode/transports/memory-repository.ts`
- Create: `src/features/game-mode/transports/memory-repository.test.ts`
- Create: `src/features/game-mode/transports/tests/repository-contract.ts`
- Modify: `src/features/game-mode/index.ts`

⚠ **Corrección (ejecución de la Tarea 4).** La lista original tenía cuatro archivos y ninguno
compartido, y esa lista sola produce el defecto que el propio Step 3 dice evitar:
`MemoryGameModeRepository` no es un doble sino el adaptador de la instancia sin Mongo, así que sus
defaults y su orden tienen que ser **los mismos**, y dos suites que describen "lo mismo" derivan en
cuanto una tarea toque un default y se acuerde de un solo archivo. El contrato del puerto se escribe
UNA vez en `transports/tests/repository-contract.ts` y se corre contra los dos adaptadores; cada
archivo `*.test.ts` se queda sólo con lo que su adaptador puede tener (el documento BSON, los cuatro
índices y el nombre de la colección de un lado; la forma del `id` y las copias defensivas del otro).

⚠ **Corrección: el `Clock` se redeclara en el transporte, no se importa de `features/match`.** El
Step 3 pide un `Clock` y no dice de dónde. Traerlo de `features/match/index.ts` es legal hoy (la
Regla 4 lo deja salir por ahí) y es un ciclo mañana: la Tarea 12 hace que el nacimiento de una mesa
resuelva el modo activo, o sea `match → game-mode`, y `no-circular` se pondría rojo en esa tarea.
Es una interfaz de un método y el tipado estructural la une con la de allá.

- [ ] **Step 1: escribir tests rojos de documento, defaults, orden e índices**

Medir explícitamente:

```ts
expect(inserted).toEqual({
  uuid: expect.any(String),
  name: "Clásica",
  multiplier: 1,
  prize: 18,
  entryFee: 10,
  playersQuantity: 2,
  pointsToWin: 25,
  isActive: true,
  isFreeRoom: false,
  enableBots: false,
  createdAt: now,
  updatedAt: now,
  __v: 0,
});
// CORREGIDO: la forma original era una lista de pares `[clave, opciones]`, que es la de un
// `createIndex(key, options)` por índice — y el mismo Step 3 pide `createIndexes`, que recibe un
// solo arreglo de `IndexDescription`. El contenido no cambia: cuatro índices, cuatro nombres y el
// `unique` sobre `uuid`, los cuatro verificados contra el schema de v1
// (`Betaso-Domino-Backend/src/storage/mongo/schemas/game-mode.schema.ts:20-25`, `:57-61` y `:78-79`).
expect(indexes).toEqual([
  { key: { uuid: 1 }, name: "uuid_1", unique: true },
  { key: { isActive: 1 }, name: "isActive_1" },
  { key: { isActive: 1, name: 1 }, name: "isActive_1_name_1" },
  { key: { isActive: 1, uuid: 1 }, name: "isActive_1_uuid_1" },
]);
```

Añadir casos para `playersQuantity: 4` ⇒ `enableBots: true`, decimales UC sin escala, `active()` con
filtro `{isActive:true}` y sort `{createdAt:-1}`, `activeByUuid` ocultando inactivos y update que no
borra campos omitidos. Dos updates efectivos dentro del mismo milisegundo deben producir `__v: 1` y
`__v: 2`; el reloj no es la revisión.

⚠ **"Update que no borra campos omitidos" NO ALCANZA, y se descubrió mutando.** Con el caso escrito
como "no le paso la clave", un `$set: { ...input }` crudo pasa verde en los dos adaptadores. La forma
que de verdad va a llegar es la otra: las rutas de v1 desestructuran el cuerpo entero y pasan TODAS
las claves (`Betaso-Domino-Backend/src/game-modes/routes.ts:117-118`), así que un `PUT` que sólo trae
el premio llega como `{ name: undefined, multiplier: undefined, prize: 20, … }` y la frontera HTTP de
la Tarea 9 hereda esa forma. En JavaScript esa clave EXISTE: el spread la escribe encima, y del lado
de Mongo queda un `null` en la base. El caso obligatorio es el `undefined` explícito.

- [ ] **Step 2: ejecutar el rojo**

```bash
npx vitest run src/features/game-mode/transports/mongo-repository.test.ts src/features/game-mode/transports/memory-repository.test.ts
```

Expected: FAIL por adaptadores inexistentes.

- [ ] **Step 3: implementar el mapper BSON sin Mongoose**

Definir el documento únicamente dentro del transporte:

```ts
interface GameModeDocument {
  _id?: ObjectId;
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

El constructor recibe un `CollectionSource` estructural y `Clock`; `collection()` siempre pide
`game_modes_domino`. `ready()` memoiza `createIndexes`. Usar `randomUUID()` de `node:crypto`,
`insertOne`, `findOne` y `findOneAndUpdate({returnDocument:"after"})`. No añadir mongoose ni uuid.

`MemoryGameModeRepository` aplica los mismos defaults y orden; no se llama “fake”, porque es el
adapter de test/desarrollo sin Mongo.

- [ ] **Step 4: verde, typecheck y commit**

```bash
npx vitest run src/features/game-mode/transports/mongo-repository.test.ts src/features/game-mode/transports/memory-repository.test.ts
npm run typecheck
git add src/features/game-mode
git commit -m "feat(game-mode): persiste el schema productivo en mongo"
```

---

### Task 5: Añadir exclusión distribuida Mongo

**Files:**
- Create: `src/shared/mongo-lease.ts`
- Create: `src/shared/mongo-lease.test.ts`

- [ ] **Step 1: escribir el test rojo de dos dueños**

Con un store de memoria que implemente la misma operación atómica, lanzar dos `within("catalog")` en
paralelo y afirmar que sólo uno entra. Avanzar el reloj más allá del lease y afirmar que el segundo
puede recuperar el lock. Medir que un dueño nunca libera el lease de otro.

- [ ] **Step 2: ejecutar el rojo**

```bash
npx vitest run src/shared/mongo-lease.test.ts
```

Expected: FAIL por módulo inexistente.

- [ ] **Step 3: implementar una sola primitiva**

```ts
export interface Lease {
  within<T>(name: string, ttlMs: number, work: () => Promise<T>): Promise<T | undefined>;
}
```

`MongoLease` usa `game_mode_leases`, `_id = name`, un `owner` UUID de proceso y `until: Date`.
Adquirir con `findOneAndUpdate` sobre lease vencido/del mismo dueño; tratar `E11000` de un upsert
competido como “no adquirido”; liberar sólo con `{_id:name,owner}`. No crear un lock por modo: el
catálogo administrativo tiene bajo volumen y el lock global preserva las reglas de v1.

- [ ] **Step 4: verificar y commit**

```bash
npx vitest run src/shared/mongo-lease.test.ts
npm run typecheck
git add src/shared/mongo-lease.ts src/shared/mongo-lease.test.ts
git commit -m "feat(mongo): serializa trabajos administrativos con lease"
```

---

### Task 6: Portar el publicador AMQP con confirms

**Files:**
- Create: `src/shared/amqp.ts`
- Create: `src/shared/amqp.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: instalar exactamente la dependencia usada por Truco v2**

```bash
npm install amqplib@^2.0.1
```

Expected: `package.json` y lock cambian; no instalar wrappers ni otro cliente.

- [ ] **Step 2: escribir los tests rojos del protocolo**

Mockear `amqplib` y medir que `publishTopic("betaso","game_mode.updated",payload)`:

- abre una sola conexión/canal para publicaciones simultáneas;
- declara `betaso` como exchange durable `topic`;
- publica JSON crudo, no `{pattern,data}`;
- usa `{persistent:true,contentType:"application/json",messageId}`;
- resuelve sólo después del callback confirm;
- rechaza si el callback trae error o `channel.publish()` devuelve `false`;
- limpia el canal al recibir `close`/`error` y lo reabre después;
- `ping()` abre el canal sin publicar;
- `close()` tolera conexión ya cerrada.

- [ ] **Step 3: ejecutar el rojo**

```bash
npx vitest run src/shared/amqp.test.ts
```

Expected: FAIL por módulo inexistente.

- [ ] **Step 4: implementar el contrato mínimo**

```ts
export class AmqpDeliveryError extends Error {}

export interface AmqpDelivery {
  publishTopic(exchange: string, routingKey: string, body: unknown): Promise<void>;
}

export class AmqpPublisher implements AmqpDelivery {
  constructor(private readonly url: string, private readonly logger: Logger) {}
  async publishTopic(exchange: string, routingKey: string, body: unknown): Promise<void>;
  async ping(): Promise<void>;
  async close(): Promise<void>;
}
```

Portar de Truco v2 la conexión lazy, `RecoveringChannelModel`, confirm channel y manejo de cierre.
No portar `publishPattern`: este incremento tiene un solo consumidor real y publica a topic exchange.

- [ ] **Step 5: verde y commit**

```bash
npx vitest run src/shared/amqp.test.ts
npm run typecheck
git add package.json package-lock.json src/shared/amqp.ts src/shared/amqp.test.ts
git commit -m "feat(amqp): publica eventos con confirmacion del broker"
```

---

### Task 7: Persistir y despachar el outbox

**Files:**
- Create: `src/features/game-mode/outbox.ts`
- Create: `src/features/game-mode/outbox.test.ts`
- Create: `src/features/game-mode/transports/mongo-outbox.ts`
- Create: `src/features/game-mode/transports/mongo-outbox.test.ts`
- Create: `src/features/game-mode/transports/memory-outbox.ts`
- Modify: `src/features/game-mode/index.ts`

- [ ] **Step 1: escribir tests rojos de durabilidad e idempotencia**

Cubrir con literales:

1. `enqueueCreated(mode)` escribe `game_mode.created` una vez.
2. `ensureUpdated(mode)` usa la clave determinista
   `JSON.stringify(["game_mode.updated", mode.uuid, mode.version])`.
3. `sync(modes, batchId)` crea un evento nuevo por modo y devuelve `modes.length`.
4. `next()` entrega el evento con `_id` más antiguo y no adelanta otro mientras éste espera retry.
5. confirm exitoso marca `SENT`; fallo incrementa `attempts` y agenda retry.
6. el delay es `min(300_000, 1_000 * 2 ** attempts)`.
7. dos dispatchers compitiendo publican sólo desde el que obtuvo el lease `outbox-publisher`.
8. un modo sin evento recibe un `updated` durante `reconcile`.
9. caída posterior al confirm puede duplicar, pero nunca salta al evento siguiente antes de resolver
   el primero.

- [ ] **Step 2: ejecutar el rojo**

```bash
npx vitest run src/features/game-mode/outbox.test.ts src/features/game-mode/transports/mongo-outbox.test.ts
```

Expected: FAIL por contratos inexistentes.

- [ ] **Step 3: definir registros y puertos**

```ts
export type OutboxStatus = "PENDING" | "SENT";

export interface GameModeOutboxEntry {
  readonly id: string;
  readonly dedupeKey: string;
  readonly routingKey: "game_mode.created" | "game_mode.updated";
  readonly payload: GameModePayload;
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly nextAttemptAt: Date;
  readonly sentAt?: Date;
  readonly lastError?: string;
}

export interface GameModeOutbox {
  enqueueCreated(mode: GameMode): Promise<void>;
  ensureUpdated(mode: GameMode): Promise<void>;
  sync(modes: readonly GameMode[], batchId: string): Promise<number>;
  reconcile(modes: readonly GameMode[]): Promise<void>;
  next(now: Date): Promise<GameModeOutboxEntry | undefined>;
  sent(id: string, at: Date): Promise<void>;
  retry(id: string, error: string, nextAttemptAt: Date): Promise<void>;
}
```

`MongoGameModeOutbox` usa `game_mode_outbox`, `_id: ObjectId` para orden y `dedupeKey` con índice
único para idempotencia; los ids del puerto son el hex string del ObjectId. `ensureUpdated` deduplica
por `uuid + version`; `sync` usa `batchId + uuid`, porque debe forzar un evento aun cuando la revisión
ya se publicó. Crear índices `{dedupeKey:1}` unique y `{status:1,_id:1}`. No TTL ni borrado automático.

- [ ] **Step 4: implementar el dispatcher de una entrada por lease**

```ts
export class OutboxDispatcher {
  start(): void;
  wake(): void;
  drain(): Promise<void>;
  close(): Promise<void>;
}
```

Cada tick obtiene `Lease.within("outbox-publisher", 15_000, ...)`, reconcilia, toma sólo la primera
entrada, publica con timeout de 5 s y marca `SENT` o `retry`. `start()` programa ticks de 1 s con
timer `unref`; `wake()` adelanta el tick tras una mutación; `close()` cancela timers y espera
`inFlight`. El backoff se limita a 300 s, pero no existe límite de intentos: una caída larga no
convierte un evento pendiente en pérdida silenciosa. `next()` mira primero el `_id` PENDING más
antiguo: si todavía no llegó su `nextAttemptAt`, devuelve vacío en vez de publicar el siguiente. No
ejecutar un bucle infinito dentro del lease.

- [ ] **Step 5: verde y commit**

```bash
npx vitest run src/features/game-mode/outbox.test.ts src/features/game-mode/transports/mongo-outbox.test.ts
npm run typecheck
git add src/features/game-mode
git commit -m "feat(game-mode): entrega cambios mediante outbox durable"
```

---

### Task 8: Implementar los casos de uso del catálogo

**Files:**
- Create: `src/features/game-mode/service.ts`
- Create: `src/features/game-mode/service.test.ts`
- Modify: `src/features/game-mode/index.ts`

- [ ] **Step 1: escribir tests rojos para cada operación**

Con repositorio/outbox/lease en memoria, medir:

- `listActive()` y `getActive(uuid)` no mutan ni publican;
- create aplica defaults y rechaza nombre+cantidad duplicados;
- update parcial preserva campos ausentes y rechaza el duplicado equivalente;

⚠ **Hallazgo de la Tarea 4, para cuando se escriba ésta: en v1 la regla de unicidad es ASIMÉTRICA y
es de SERVICIO, no de índice.** `create` consulta
`findOne({ name, playersQuantity })` (`Betaso-Domino-Backend/src/game-modes/game-mode.service.ts:58`)
pero `update` consulta `findOne({ name, uuid: { $ne: uuid } })` (`:100-103`), o sea **sólo el
nombre**, cruzando mesas de dos y de cuatro. Los únicos índices de la colección son los cuatro que
la Tarea 4 recrea, y ninguno la impone. Hay que decidir explícitamente cuál de las dos reglas vale
en v2 —el contrato de `DuplicateGameModeError` dice "name + playersQuantity"— y escribir el
argumento: con la de `create`, un `PUT` que renombra puede crear el par duplicado que v1 rechazaba
al insertar; con la de `update`, dos modos legítimos del catálogo productivo (mismo nombre, 2P y 4P)
dejan de poder renombrarse.
- soft delete sólo cambia `isActive=false` y encola `updated`;
- reactivate sólo cambia `isActive=true` y encola `updated`;
- repetir delete/reactivate devuelve el error específico;
- `syncAll(batchId)` incluye activos e inactivos y devuelve el total;
- si el lease no se obtiene, ninguna escritura ocurre;
- si el repositorio confirma y el outbox falla, la operación rechaza, el cambio permanece y una
  reconciliación posterior crea el evento de esa `version`;
- Rabbit no aparece entre las dependencias del servicio: sólo el outbox.

- [ ] **Step 2: ejecutar el rojo**

```bash
npx vitest run src/features/game-mode/service.test.ts
```

Expected: FAIL por `GameModeService` inexistente.

- [ ] **Step 3: implementar el servicio**

```ts
export class GameModeService {
  constructor(
    private readonly repository: GameModeRepository,
    private readonly outbox: GameModeOutbox,
    private readonly lease: Lease,
    private readonly wakeDispatcher: () => void,
  ) {}

  listActive(): Promise<readonly GameMode[]>;
  getActive(uuid: string): Promise<GameMode | undefined>;
  create(input: CreateGameMode): Promise<GameMode>;
  update(uuid: string, input: UpdateGameMode): Promise<GameMode>;
  softDelete(uuid: string): Promise<GameMode>;
  reactivate(uuid: string): Promise<GameMode>;
  syncAll(batchId: string): Promise<{ synced: number }>;
}
```

Todas las mutaciones ejecutan dentro de `lease.within("catalog-writer", 15_000, ...)`. Después de
persistir, esperan `outbox.enqueue*`; nunca esperan publicación Rabbit. Al terminar llaman
`wakeDispatcher()` mediante el callback inyectado, sin hacer que el servicio dependa de la clase.

- [ ] **Step 4: verde y commit**

```bash
npx vitest run src/features/game-mode/service.test.ts
npm run typecheck
git add src/features/game-mode/service.ts src/features/game-mode/service.test.ts src/features/game-mode/index.ts
git commit -m "feat(game-mode): administra el catalogo compatible con v1"
```

---

### Task 9: Exponer la API HTTP de v1 detrás del orquestador

**Files:**
- Create: `src/features/game-mode/transports/http/schemas.ts`
- Create: `src/features/game-mode/transports/http/schemas.test.ts`
- Create: `src/features/game-mode/transports/http/register-http.ts`
- Create: `src/features/game-mode/transports/http/register-http.test.ts`
- Modify: `src/features/game-mode/index.ts`

- [ ] **Step 1: escribir tests rojos del contrato completo**

Levantar Express en puerto efímero y probar literalmente las siete rutas. Afirmar, como mínimo:

```ts
expect(await get("/game-modes")).toEqual({
  status: 200,
  body: { status: "success", data: [v1Dto] },
});
expect(await post("/game-modes", body, key)).toEqual({
  status: 201,
  body: { status: "success", data: v1Dto },
});
expect(await del("/game-modes/mode-1", key)).toEqual({
  status: 200,
  body: { status: "success", message: "Modo de juego eliminado correctamente" },
});
```

Verificar también:

- `_id`, `__v`, fechas y todos los nombres de campo v1;
- GET públicos sin llave;
- cada mutación da 401 sin llave y usa comparación constante existente;
- si `internalApiKey` es `undefined`, las mutaciones no se registran;
- `reactive/:uuid` se registra antes de `/:uuid`;
- 400 malformed, 404 inexistente, 409 duplicado, 503 lease/infra;
- `playersQuantity` acepta `2` y `"2"`;
- `enableBots` viaja (la ruta v1 lo perdía al destructurar y v2 no repite ese bug).

- [ ] **Step 2: ejecutar el rojo**

```bash
npx vitest run src/features/game-mode/transports/http/schemas.test.ts src/features/game-mode/transports/http/register-http.test.ts
```

Expected: FAIL por rutas inexistentes.

- [ ] **Step 3: implementar schemas y DTO**

```ts
const createBody = z.strictObject({
  name: z.string().min(1),
  multiplier: z.number().finite().min(1).default(1),
  prize: z.number().finite().nonnegative(),
  entryFee: z.number().finite().nonnegative(),
  playersQuantity: z.union([z.literal(2), z.literal(4), z.literal("2"), z.literal("4")])
    .transform(Number),
  pointsToWin: z.number().finite().max(100).default(25),
  isActive: z.boolean().default(true),
  isFreeRoom: z.boolean().default(false),
  enableBots: z.boolean().optional(),
});
```

El update usa `.partial()` sobre los mismos campos sin aplicar defaults a campos omitidos. `toDTO`
mapea `id→_id` y `version→__v`; no devuelve nombres internos.

- [ ] **Step 4: registrar rutas con el envelope histórico**

```ts
export function registerGameModeHttp(app: Application, deps: GameModeHttpDeps): void {
  app.get("/game-modes", /* list */);
  if (deps.internalApiKey) {
    app.get("/game-modes/reactive/:uuid", protectedRoute(/* reactivate */));
  }
  app.get("/game-modes/:uuid", /* active by uuid */);
  if (!deps.internalApiKey) return;
  app.post("/game-modes", protectedRoute(/* create */));
  app.put("/game-modes/:uuid", protectedRoute(/* update */));
  app.post("/game-modes/sync", protectedRoute(/* sync */));
  app.delete("/game-modes/:uuid", protectedRoute(/* soft delete */));
}
```

`reactive` es una mutación aunque conserve GET por compatibilidad: sólo se registra cuando existe
llave y siempre antes de `/:uuid`. El create acepta el campo histórico `isActive`, pero lo ignora y
fuerza `true`, igual que v1. Los handlers reciben `GameModeService`; no resuelven container ni leen
env.

- [ ] **Step 5: verde y commit**

```bash
npx vitest run src/features/game-mode/transports/http/schemas.test.ts src/features/game-mode/transports/http/register-http.test.ts
npm run typecheck
git add src/features/game-mode
git commit -m "feat(game-mode): conserva la api http de domino v1"
```

---

### Task 10: Resolver el modo al crear una partida

**Files:**
- Modify: `src/features/match/transports/match-contract.ts`
- Modify: `src/features/match/transports/match-contract.test.ts`
- Modify: `src/features/match/transports/colyseus/domino-room.ts`
- Modify: `src/features/match/transports/colyseus/domino-room.test.ts`
- Modify: `src/features/match/tests/e2e-harness.ts`
- Modify: `src/features/match/tests/lifecycle-e2e.test.ts`
- Modify: `src/smoke/engine-smoke.ts`
- Modify: `src/replay.ts`
- Modify: `src/features/match/tests/replay.test.ts`

- [ ] **Step 1: escribir tests rojos de autoridad del catálogo**

Probar que:

- un modo inexistente o inactivo impide crear sala;
- `participants.length` debe coincidir con `playersQuantity`;
- un modo 4P devuelve error explícito `UNSUPPORTED_GAME_MODE` antes de génesis;
- `pointsToWin`, `entryFee` y `prize` salen del modo, no del request;
- editar el catálogo después de `onCreate` no cambia `room.state` ni `/config`;
- replay reconstruye usando el snapshot y nunca consulta `GameModeReader`.

El request vivo del test debe ser:

```ts
const request = {
  mode: "CASUAL",
  matchId: "match-1",
  gameModeId: "mode-2p",
  participants,
  seed: "seed-1",
  teamAssignment: "SHUFFLED",
  rateId: "00000000-0000-4000-8000-000000000001",
};
```

- [ ] **Step 2: ejecutar el rojo**

```bash
npx vitest run src/features/match/transports/match-contract.test.ts src/features/match/transports/colyseus/domino-room.test.ts src/features/match/tests/replay.test.ts
```

Expected: FAIL porque `configOf` todavía recibe dinero/puntos del request y la sala no consulta
catálogo.

- [ ] **Step 3: separar request vivo de snapshot reproducible**

```ts
export interface CreateMatchRequest {
  readonly mode: "CASUAL";
  readonly matchId: string;
  readonly gameModeId: string;
  readonly participants: readonly MatchParticipant[];
  readonly seed: string;
  readonly teamAssignment: TeamAssignmentMode;
  readonly rateId: string;
}

export function requestOf(input: unknown): CreateMatchRequest;
export function configOf(request: CreateMatchRequest, mode: GameMode): DominoMatchConfig;
export function replayConfigOf(input: unknown): DominoMatchConfig;
```

`configOf` copia `pointsToWin`, `entryFee` y `prize` del modo. `replayConfigOf` valida el snapshot
completo grabado; no llama Mongo. La validación de identidad sigue normalizando exactamente como
antes. La feature `match` importa `GameMode`/`GameModeReader` sólo desde
`features/game-mode/index.ts`; no cruza hacia archivos internos del catálogo.

- [ ] **Step 4: integrar la sala sin romper su crash path**

Inyectar `GameModeReader` por el container de la sala. En `onCreate`, parsear el request, consultar
`activeByUuid`, validar cantidad/2P y recién entonces construir config/log/metadata. El manejador de
error debe seguir funcionando si el fallo ocurre antes de crear `this.log`, igual que el fix previo
de `onCreate`.

Actualizar el arnés para registrar un `MemoryGameModeRepository` con `mode-2p`; no hacer que cada test
escriba un modo manualmente. El smoke real crea el modo por HTTP antes de crear la sala.

- [ ] **Step 5: regenerar golden, verificar y commit**

```bash
$env:WRITE_GOLDEN='1'; npx vitest run src/features/match/tests/game-2p-e2e.test.ts; Remove-Item Env:WRITE_GOLDEN
npx vitest run src/features/match/transports/match-contract.test.ts src/features/match/transports/colyseus/domino-room.test.ts src/features/match/tests/replay.test.ts src/features/match/tests/game-2p-e2e.test.ts
npm run typecheck
git add src/features/match src/replay.ts src/smoke/engine-smoke.ts
git commit -m "feat(match): resuelve el modo activo al crear la mesa"
```

---

### Task 11: Cablear entorno, DI, readiness y apagado

**Files:**
- Modify: `src/env.ts`
- Modify: `src/env.test.ts`
- Modify: `src/env-single-reader.test.ts`
- Modify: `vitest.setup.ts`
- Modify: `.env.example`
- Modify: `src/di-container.ts`
- Modify: `src/di-container.test.ts`
- Modify: `src/app.config.ts`
- Modify: `src/shared/http/health.test.ts`
- Modify: `src/main.ts`
- Modify: `src/entrypoint.test.ts`

- [ ] **Step 1: escribir tests rojos de configuración segura**

Añadir `RABBITMQ_URL` al único lector. Medir:

```ts
expect(() => parseEnv(productionWithoutMongo)).toThrow(/MONGO_URI/);
expect(() => parseEnv(productionWithoutRabbit)).toThrow(/RABBITMQ_URL/);
expect(() => parseEnv(productionWithoutInternalKey)).toThrow(/INTERNAL_API_KEY/);
expect(parseEnv(testEnv).rabbitmqUrl).toBeUndefined();
```

`env-single-reader.test.ts` debe seguir rechazando cualquier `process.env` fuera de `env.ts` y tests.
`vitest.setup.ts` borra `RABBITMQ_URL` junto a Mongo/Redis para que la suite ordinaria no toque red.

- [ ] **Step 2: escribir tests rojos de wiring/ciclo de vida**

Medir que:

- `registerGameModeHttp` corre antes del error handler;
- `GameModeReader` y `GameModeRepository` resuelven al mismo adapter;
- Mongo presente elige repositorio/outbox/lease Mongo; ausente usa memoria;
- Rabbit presente crea una sola instancia `AmqpPublisher` compartida;
- readiness reporta `rabbit` en 503 y `/health` sigue 200;
- shutdown llama `dispatcher.close`, `history.drain`, `publisher.close`, `mongo.close` en ese orden;
- no aparece `GAME_MODE_DRIVER`, `OUTBOX_DRIVER` ni `AMQP_DRIVER`.

- [ ] **Step 3: ejecutar el rojo**

```bash
npx vitest run src/env.test.ts src/env-single-reader.test.ts src/di-container.test.ts src/shared/http/health.test.ts src/entrypoint.test.ts
```

Expected: FAIL por variables y wiring inexistentes.

- [ ] **Step 4: implementar configuración y composición**

Añadir al schema:

```ts
RABBITMQ_URL: z.string().min(1).optional(),
```

Después del parse, si `NODE_ENV === "production"`, emitir un único error que enumere cualquier
ausencia de `MONGO_URI`, `RABBITMQ_URL` o `INTERNAL_API_KEY`. No leer `process.env` en DI.

En `di-container.ts`:

- reutilizar la única instancia `Mongo`;
- registrar repository/outbox/lease de memoria sin URI y Mongo con URI;
- crear `AmqpPublisher` sólo con URL;
- arrancar `OutboxDispatcher` sólo si existen Mongo y publisher;
- registrar `GameModeService` y `GameModeReader`;
- exportar `amqp` únicamente para readiness/lifecycle, como se exporta `mongo`.

En `app.config.ts`, registrar la API y añadir `rabbit: () => amqp.ping()` a dependencias duras cuando
exista. En shutdown, cerrar dispatcher antes de AMQP/Mongo. Redis continúa fuera de este cierre.

- [ ] **Step 5: verde y commit**

```bash
npx vitest run src/env.test.ts src/env-single-reader.test.ts src/di-container.test.ts src/shared/http/health.test.ts src/entrypoint.test.ts
npm run typecheck
npm run lint
git add src .env.example vitest.setup.ts
git commit -m "feat(game-mode): cablea catalogo y rabbit al proceso"
```

---

### Task 12: Certificar Mongo, Rabbit, HTTP y PM2 reales

**Files:**
- Create: `src/smoke/game-mode-smoke.ts`
- Create: `src/game-mode-integration.test.ts`
- Modify: `package.json`
- Modify: `compose.smoke.yaml`
- Modify: `scripts/run-engine-smoke.mjs`
- Modify: `src/smoke/engine-smoke.ts`
- Modify: `src/deploy-smoke.test.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: escribir el test estático rojo del runner**

En `game-mode-integration.test.ts`, leer `game-mode-smoke.ts`, el runner y Compose como texto y
afirmar que juntos contienen:

- `game_modes_domino`, las cuatro especificaciones de índice y `__v`;
- las siete rutas HTTP;
- `game_mode.created`, `game_mode.updated`, `betaso`;
- una comparación literal de payload;
- un escenario de Rabbit apagado/recuperado;
- una comprobación de dos procesos PM2;
- cleanup en `finally`.

No escribir literalmente `process.env` en el test: `env-single-reader.test.ts` inspecciona todo `src`.

- [ ] **Step 2: ejecutar el rojo**

```bash
npx vitest run src/game-mode-integration.test.ts src/deploy-smoke.test.ts
```

Expected: FAIL porque el script/servicio Rabbit no existen.

- [ ] **Step 3: extender Compose**

Añadir RabbitMQ con volumen aislado y healthcheck:

```yaml
rabbitmq:
  image: rabbitmq:4-management-alpine
  healthcheck:
    test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"]
    interval: 2s
    timeout: 2s
    retries: 30
```

Pasar a la app `RABBITMQ_URL=amqp://guest:guest@rabbitmq:5672` e
`INTERNAL_API_KEY=domino-smoke-internal-key`. Pasar a `smoke-client` las URLs de Mongo y Rabbit que
necesita para hacer aserciones externas. Mantener Mongo en la misma base aislada del smoke.

- [ ] **Step 4: implementar las fases de integración real**

`src/smoke/game-mode-smoke.ts` exporta tres fases ejecutables por argumento: `normal`, `enqueue` y
`recover`. El runner existente deja de usar un solo `compose up --abort-on-container-exit` y, dentro
de un `try/finally`, orquesta:

1. `docker compose up --build -d redis mongo rabbitmq domino nginx`;
2. esperar `/ready` y ejecutar
   `docker compose run --rm --no-deps smoke-client npm run smoke:game-mode -- normal`;
3. detener Rabbit y ejecutar la fase `enqueue`;
4. arrancar Rabbit, esperar readiness y ejecutar la fase `recover`;
5. ejecutar el `smoke:client` de engine ya existente, que crea y termina la partida por `SCORE`;
6. siempre ejecutar `down -v --remove-orphans` en `finally` y propagar el primer código no cero.

El runner usa `--no-deps` en **todas** las fases de cliente: de otro modo `compose run` volvería a
arrancar Rabbit al intentar certificar que está caído. Las fases hacen exactamente esto:

- `normal`: declara antes de mutar una cola de smoke nombrada y durable, bindeada a `game_mode.*`;
  crea por HTTP un modo con `entryFee:10`, `prize:18`, `playersQuantity:2`; comprueba en Mongo claves,
  tipos, defaults, `__v`, fechas e índices; compara literalmente `game_mode.created`; ejecuta PUT,
  DELETE, reactive y sync comprobando envelopes y eventos `updated`; deja el modo activo.
- `enqueue`: no abre AMQP; con Rabbit detenido edita por HTTP, comprueba respuesta exitosa y localiza
  en Mongo el evento exacto todavía `PENDING`.
- `recover`: abre la cola durable creada en `normal`, espera el evento anterior y su estado `SENT`;
  modifica directamente el documento incrementando `__v` pero sin insertar outbox y comprueba que el
  reconciliador emite el `updated`; consulta 2567 y 2568 para demostrar que las dos instancias PM2
  sirven el catálogo compartido.

Después `engine-smoke.ts` crea la partida usando sólo el `gameModeId` dejado por `normal` y la termina
por `SCORE`.

Usar plazos explícitos de 10 s por espera; ningún `sleep` ciego decide éxito. Las fases se coordinan
por el estado durable de Mongo, no mediante archivos temporales del host.

- [ ] **Step 5: integrar el catálogo en el smoke y CI existentes**

Añadir sólo el comando de cliente que el runner invoca dentro de Compose:

```json
"smoke:game-mode": "tsx src/smoke/game-mode-smoke.ts"
```

`engine-smoke.ts` usa el modo dejado por la fase `normal`; ya no inventa el dinero ni los puntos de
la mesa. `.github/workflows/ci.yml` conserva un solo paso `npm run test:deploy` y ningún bloque
`services:`: es Compose quien levanta Mongo, Redis y Rabbit para las aserciones reales, igual que ya
hace con Mongo/Redis. No crear un segundo runner ni un job redundante.

- [ ] **Step 6: ejecutar certificación**

```bash
npx vitest run src/game-mode-integration.test.ts src/deploy-smoke.test.ts
npm run build
$env:RUN_ENGINE_SMOKE='1'; npm run test:deploy
docker compose -f compose.smoke.yaml ps -a
```

Expected: el smoke combinado código 0 y `docker compose ps -a` sin contenedores del proyecto.

- [ ] **Step 7: commit**

```bash
git add scripts/run-engine-smoke.mjs src/smoke src/game-mode-integration.test.ts src/deploy-smoke.test.ts package.json compose.smoke.yaml .github/workflows/ci.yml
git commit -m "test(deploy): certifica catalogo y rabbit reales"
```

---

### Task 13: Cierre, documentación y gates

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-09-14-identidad-multiplataforma-y-smoke-pm2-design.md`
- Modify: `docs/superpowers/plans/2026-09-14-lobby-y-montos-publicos.md`
- Modify: `docs/superpowers/plans/2026-09-15-catalogo-modos-v1-y-outbox-rabbitmq.md`

- [ ] **Step 1: corregir documentación histórica sin reescribirla**

Añadir notas explícitas de supersesión donde documentos anteriores dicen UC minor. No borrar el
registro de la decisión previa: enlazar esta spec y decir que producción v1 corrigió el supuesto.

Actualizar `AGENTS.md` con:

- commits por task;
- baseline de tests/archivos;
- forma Mongo y semántica UC;
- auth por orquestador;
- garantías/duplicados del outbox;
- orden de shutdown;
- deuda 4P/bots/multiplicador todavía abierta;
- primer paso pendiente del incremento siguiente.

- [ ] **Step 2: ejecutar todos los gates frescos**

```bash
npm run format
npm run typecheck
npm test
npm run lint
npm run build
npm run depcruise
```

Expected: todos código 0. Registrar conteos reales, no copiar los de este plan.

- [ ] **Step 3: reindexar y revisar el diff**

Reindexar `domino-backend-v2` en modo moderate sin persistir artefactos dentro del repo. Después:

```bash
git diff --check
git status --short
```

Expected: sin whitespace errors y sólo archivos del incremento.

- [ ] **Step 4: commit final**

```bash
git add AGENTS.md docs
git commit -m "docs(game-mode): cierra el catalogo compatible con v1"
```

---

## Criterio de ejecución

No marcar una Task completa por tener Vitest verde. Cada Task exige su rojo previo, su verde dirigido,
`npm run typecheck` y el commit indicado. Antes de cerrar el incremento deben estar verdes la suite
completa, lint, build, depcruise, integración Mongo/Rabbit y el smoke PM2/Nginx del juego.

No ampliar alcance para “aprovechar” el catálogo: 4P, bots, torneo, matchmaking, multiplicador de
apuesta y liquidación real siguen siendo incrementos separados.
