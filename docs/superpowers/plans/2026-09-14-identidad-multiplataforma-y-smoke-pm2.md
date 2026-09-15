# Identidad multiplataforma y smoke PM2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hacer que una partida conserve identidad, perfil, moneda y tasa congelados por plataforma, proyecte recompensa/reembolso sin mover dinero y certifique el engine compilado en dos procesos PM2 detrás de Nginx.

**Architecture:** La identidad de negocio será la pareja `{ platformId, userUuid }`, mientras el motor seguirá usando ids opacos `seat-N` dentro de una partida. El contrato de sala validará y normalizará el snapshot completo una sola vez; el estado sincronizará únicamente presentación pública y mantendrá identidad/moneda con `noSync()`. Una proyección pura en `network/` producirá instrucciones monetarias y un Compose aislado ejecutará clientes SDK contra `dist/main.js` bajo PM2 y Nginx.

**Tech Stack:** TypeScript 5.7, Node 22, Colyseus 0.18, `@colyseus/schema` 5, Zod 4, Vitest 3, Docker Compose, PM2 7.0.4, Nginx 1.30.4 Alpine.

---

## Mapa de archivos

- `src/shared/player-ref.ts`: forma mínima de la identidad compartida por auth y match.
- `src/features/auth/identity.ts` y `transports/jwt-verifier.ts`: identidad autenticada desde `sub + platformId`.
- `src/features/match/transports/match-contract.ts`: única frontera que valida opciones externas y genera `seat-N`.
- `src/features/match/core/config.ts`: snapshot inmutable usado por engine, replay y liquidación.
- `src/features/match/core/state/player.ts`: presentación pública e identidad/moneda solo servidor.
- `src/features/match/transports/colyseus/domino-room.ts`: resuelve la pareja autenticada al asiento opaco.
- `src/features/match/transports/match-registry.ts`: índice compartido por pareja, sin filtrar datos privados en `/config`.
- `src/features/match/network/settlement.ts`: proyección pura `MATCH_RESOLVED/MATCH_ABORTED -> REWARD/REFUND`.
- `src/smoke/engine-smoke.ts`: cliente real, sin acceso al proceso servidor ni a wallets.
- `scripts/run-engine-smoke.mjs`: gate de flag, ciclo Compose y limpieza garantizada al terminar.
- `compose.smoke.yaml`, `smoke/nginx.conf` y targets de `Dockerfile`: topología efímera del deploy.
- `src/deploy-smoke.test.ts`: contrato textual de las piezas que TypeScript no importa entre sí.
- `AGENTS.md` y este plan: punto de reanudación y estado comprobado del incremento.

No se añade un puerto de wallet, un adaptador remoto ni un outbox: no existe todavía un orquestador al cual entregarles trabajo. La salida de este incremento es la proyección pura y exportada que ese adaptador consumirá.

### Task 0: Publicar el punto de continuidad antes de tocar código

**Files:**
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md`

- [x] **Step 1: Añadir el incremento activo a `AGENTS.md`**

Insertar después del párrafo `Baseline actual`:

```markdown
## Incremento activo — identidad multiplataforma y smoke real

Autoridad operativa:
`docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md`.
Diseño aprobado:
`docs/superpowers/specs/2026-09-14-identidad-multiplataforma-y-smoke-pm2-design.md`.

Estado: **Tarea 0 en curso; código todavía no iniciado**. La identidad externa pasa a ser
`{ platformId, userUuid }`; `currency` es la moneda ya cobrada y queda congelada, y toda
recompensa/reembolso usa el `rateId` único de la mesa. Los montos `*UcMinor` son enteros seguros:
los dos últimos dígitos son decimales (`1234 = 12,34 UC`).

Al terminar cada tarea, actualizar esta línea con tarea, commit, baseline y primer paso pendiente.
No cambiar `maxClients`: sigue abierta la deuda del `unlock()` descrita más abajo.
```

- [x] **Step 2: Marcar esta tarea completa en el plan**

Cambiar sus dos casillas a `[x]` y dejar bajo este paso:

**Continuidad:** Tarea 0 completa; siguiente paso exacto: Task 1, Step 1.

- [x] **Step 3: Commit de documentación**

```bash
git add AGENTS.md docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md
git commit -m "docs(multiplataforma): publica el incremento activo" -m "Deja identidad, moneda, escala UC y primer paso pendiente en el archivo que lee la próxima sesión; sin esta marca se reconstruirían decisiones financieras desde la conversación.\n\nCo-Authored-By: GPT-5 <noreply@anthropic.com>"
```

Expected: commit creado y `git status --short` vacío.

### Task 1: Migrar identidad, contrato, estado, sala y registro como una sola rebanada

Esta tarea es deliberadamente vertical. Separar el cambio de `DominoMatchConfig` del de la sala dejaría un commit que no pasa `typecheck`, y conservar temporalmente `userId` junto a la pareja nueva dejaría dos identidades autorizables para el mismo dinero.

**Files:**
- Create: `src/shared/player-ref.ts`
- Create: `src/features/match/transports/match-contract.test.ts`
- Create: `src/features/match/core/engine/tests/match-config-fixture.ts`
- Modify: `src/features/auth/identity.ts`
- Modify: `src/features/auth/transports/jwt-verifier.ts`
- Modify: `src/features/auth/transports/jwt-verifier.test.ts`
- Modify: `src/features/match/core/config.ts`
- Modify: `src/features/match/core/state/player.ts`
- Modify: `src/features/match/core/engine/genesis.ts`
- Modify: `src/features/match/core/engine/dealer.ts`
- Modify: `src/features/match/history/engine-factory.ts`
- Modify: `src/features/match/transports/match-contract.ts`
- Modify: `src/features/match/transports/match-registry.ts`
- Modify: `src/features/match/transports/match-registry.test.ts`
- Modify: `src/features/match/transports/colyseus/domino-room.ts`
- Modify: `src/features/match/transports/colyseus/domino-room.test.ts`
- Modify: `src/features/match/core/engine/tests/build-engine.ts`
- Modify: `src/features/match/core/engine/tests/dealer.test.ts`
- Modify: `src/features/match/core/engine/round/tests/round-fixture.ts` *(faltaba en el plan)*
- Modify: `src/features/match/core/engine/round/tests/block.test.ts` *(faltaba en el plan)*
- Modify: `src/features/match/core/engine/tests/genesis.test.ts`
- Modify: `src/features/match/core/engine/tests/match-referee.test.ts`
- Modify: `src/features/match/core/engine/tests/scorer.test.ts`
- Modify: `src/features/match/core/engine/tests/state-projections.test.ts`
- Modify: `src/features/match/network/tests/history.test.ts`
- Modify: `src/features/match/tests/e2e-harness.ts`
- Modify: `src/features/match/tests/deal-window-e2e.test.ts`
- Modify: `src/features/match/tests/lifecycle-e2e.test.ts`
- Modify: `src/features/match/tests/reconnection-e2e.test.ts`
- Modify: `src/features/match/tests/visibility.smoke.test.ts`
- Modify: `src/features/match/tests/replay.test.ts`
- Modify: `src/features/match/tests/fixtures/golden-2p.json`
- Modify: `src/replay.ts`
- Modify: `src/features/match/index.ts`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md`

- [x] **Step 1: Escribir el rojo de JWT compuesto**

En `jwt-verifier.test.ts`, cambiar el caso feliz y añadir los dos rechazos:

```ts
it("verifica un token HS256 y devuelve su identidad compuesta", async () => {
  const token = jwt.sign({ sub: "u1", platformId: "betaso" }, SECRET, {
    algorithm: "HS256",
    expiresIn: "1h",
  });

  await expect(verifier.verify(token)).resolves.toEqual({
    platformId: "betaso",
    userUuid: "u1",
  });
});

it.each<[string, Record<string, unknown>]>([
  ["sin platformId", { sub: "u1" }],
  ["con platformId vacío", { sub: "u1", platformId: "   " }],
])("rechaza un token %s", async (_name, payload) => {
  const token = jwt.sign(payload, SECRET, { algorithm: "HS256" });
  await expect(verifier.verify(token)).rejects.toBeInstanceOf(InvalidTokenError);
});
```

Actualizar los restantes `jwt.sign({ sub: "u1" }` para incluir `platformId: "betaso"`, salvo el caso que prueba ausencia de `sub`.

- [x] **Step 2: Ejecutar el rojo de auth**

Run: `npx vitest run src/features/auth/transports/jwt-verifier.test.ts`

Expected: FAIL; el resultado todavía contiene `userId` y el token sin plataforma aún se acepta.

- [x] **Step 3: Escribir el rojo del contrato monetario**

Crear `match-contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configOf } from "./match-contract.js";

const valid = {
  mode: "CASUAL",
  matchId: "m1",
  gameModeId: "classic-2p",
  participants: [
    {
      platformId: "betaso",
      userUuid: "same",
      displayName: "Ada",
      username: "ada",
      profilePicture: "https://img.test/ada.png",
      currency: "VES",
    },
    {
      platformId: "partner",
      userUuid: "same",
      displayName: "Lin",
      currency: "USD",
    },
  ],
  seed: "seed",
  pointsToWin: 100,
  teamAssignment: "SEAT_ORDER",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFeeUcMinor: 125,
  prizeUcMinor: 250,
} as const;

describe("configOf", () => {
  it("normaliza identidades externas a ids opacos reproducibles", () => {
    expect(configOf(valid).seats).toEqual([
      { ...valid.participants[0], playerId: "seat-1" },
      { ...valid.participants[1], playerId: "seat-2" },
    ]);
  });

  it("conserva moneda, rateId y enteros UC exactamente", () => {
    const config = configOf(valid);
    expect(config.rateId).toBe(valid.rateId);
    expect(config.entryFeeUcMinor).toBe(125);
    expect(config.prizeUcMinor).toBe(250);
    expect(config.seats.map(({ currency }) => currency)).toEqual(["VES", "USD"]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["rateId no UUID", { rateId: "actual" }],
    ["UC fraccionaria", { entryFeeUcMinor: 12.5 }],
    ["UC insegura", { prizeUcMinor: Number.MAX_SAFE_INTEGER + 1 }],
    ["UC negativa", { prizeUcMinor: -1 }],
    ["currency vacía", { participants: [{ ...valid.participants[0], currency: " " }, valid.participants[1]] }],
    ["platformId ausente", { participants: [{ ...valid.participants[0], platformId: undefined }, valid.participants[1]] }],
    ["displayName ausente", { participants: [{ ...valid.participants[0], displayName: undefined }, valid.participants[1]] }],
  ])("rechaza %s", (_name, override) => {
    expect(() => configOf({ ...valid, ...override })).toThrow();
  });

  it("acepta el mismo userUuid en plataformas distintas y rechaza la pareja duplicada", () => {
    expect(() => configOf(valid)).not.toThrow();
    expect(() =>
      configOf({ ...valid, participants: [valid.participants[0], valid.participants[0]] }),
    ).toThrow(/duplicada/);
  });
});
```

- [x] **Step 4: Escribir los rojos de génesis, registro, sala y wire**

Añadir en `core/engine/tests/genesis.test.ts`:

```ts
it("copia perfil e identidad financiera sin cambiar moneda", () => {
  const match = createMatchState(config(["u1", "u2"]));
  expect(match.players[0]).toMatchObject({
    playerId: "u1",
    displayName: "Jugador u1",
    platformId: "betaso",
    userUuid: "u1",
    currency: "VES",
  });
});
```

Añadir en `match-registry.test.ts`:

```ts
it("indexa por la pareja y no mezcla UUID iguales de plataformas distintas", async () => {
  const registry = new MatchRegistry(new MemoryKeyValueStore());
  await registry.register("room-1", collidingConfig);

  expect(await registry.matchOf({ platformId: "betaso", userUuid: "same" })).toBe("room-1");
  expect(await registry.matchOf({ platformId: "partner", userUuid: "same" })).toBe("room-1");
  expect(await registry.matchOf({ platformId: "third", userUuid: "same" })).toBeUndefined();
});

it("no guarda identidad, moneda, tasa ni montos en la configuración pública", async () => {
  const store = new MemoryKeyValueStore();
  const registry = new MatchRegistry(store);
  await registry.register("room-1", collidingConfig);
  const raw = await store.get("match_config:room-1");

  expect(raw).toBeDefined();
  for (const secret of ["betaso", "partner", "VES", "USD", collidingConfig.rateId, "entryFeeUcMinor"]) {
    expect(raw).not.toContain(secret);
  }
});
```

Añadir en `domino-room.test.ts`:

```ts
it("distingue el mismo UUID de dos plataformas y rechaza una tercera", async () => {
  const testServer = requiredServer();
  const participants = [
    { platformId: "betaso", userUuid: "same", displayName: "Ada", currency: "VES" },
    { platformId: "partner", userUuid: "same", displayName: "Lin", currency: "USD" },
  ] as const;
  const room = await testServer.createRoom<DominoRoom>(
    "domino",
    options("match-platforms", participants),
  );
  const a = await connect(testServer, room, { platformId: "betaso", userUuid: "same" });
  const b = await connect(testServer, room, { platformId: "partner", userUuid: "same" });

  expect(room.clients.map((client) => client.userData)).toEqual(
    expect.arrayContaining([{ playerId: "seat-1" }, { playerId: "seat-2" }]),
  );

  const outsider = new ColyseusSDK(`ws://127.0.0.1:${portOf(testServer)}`);
  outsider.auth.token = tokenOf({ platformId: "third", userUuid: "same" });
  await expect(outsider.joinById(room.roomId)).rejects.toThrow();
  await Promise.all([a.leave(), b.leave()]);
});
```

Añadir en `visibility.smoke.test.ts`, usando un par explícito y `clientOf`/`playerIdOf` que se implementan abajo:

```ts
it("sincroniza presentación pero no identidad externa ni moneda", async () => {
  const match = await seatPair(server, [
    { platformId: "betaso", userUuid: "private-a", displayName: "Ada", currency: "VES" },
    { platformId: "partner", userUuid: "private-b", displayName: "Lin", currency: "USD" },
  ]);
  // `Room.state` del SDK está tipado `object`: hay que pasar por el `clientState` del
  // propio archivo, que ya hace el `as MatchState`. Sin eso son dos TS2339.
  await waitUntil(() => clientState(match, "private-a").players.length === 2);

  const wire = JSON.stringify(clientState(match, "private-a").toJSON());
  expect(wire).toContain("Ada");
  expect(wire).toContain("Lin");
  for (const privateValue of ["private-a", "private-b", "betaso", "partner", "VES", "USD"]) {
    expect(wire).not.toContain(privateValue);
  }
});
```

- [x] **Step 5: Ejecutar el rojo de contrato y transporte**

Run:

```bash
npx vitest run src/features/match/transports/match-contract.test.ts src/features/match/core/engine/tests/genesis.test.ts src/features/match/transports/match-registry.test.ts src/features/match/transports/colyseus/domino-room.test.ts src/features/match/tests/visibility.smoke.test.ts
```

Expected: FAIL de compilación/ejecución porque todavía no existen `participants`, `rateId`, la pareja autenticada ni los helpers del arnés.

- [x] **Step 6: Implementar la identidad compartida y el verificador**

Crear `src/shared/player-ref.ts`:

```ts
export interface PlayerRef {
  readonly platformId: string;
  readonly userUuid: string;
}
```

Reemplazar `Identity` en `src/features/auth/identity.ts`:

```ts
import type { PlayerRef } from "../../shared/player-ref.js";

export type Identity = PlayerRef;

export interface TokenVerifier {
  verify(token: string | undefined): Promise<Identity>;
}

// NO se toca `InvalidTokenError`: conserva su `constructor(reason: string)`.
export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`Token inválido: ${reason}`);
    this.name = "InvalidTokenError";
  }
}
```

⚠ **El plan borraba el `reason`** y con él lo único que `DominoRoom.onUncaughtException`
loguea de un rechazo de autenticación (`"rechazo esperado"` imprime `cause.message`). Ningún
test afirma sobre ese mensaje, así que el borrado habría pasado en verde dejando indistinguibles
"firma inválida", "expirado" y "sin platformId" en el log de una ruta que mueve dinero. Se
conserva la firma actual y las ramas nuevas lanzan `InvalidTokenError("sin claim platformId")`.

En `JwtVerifier.verify`, después de `jwt.verify`, usar:

```ts
// La guarda del string VA PRIMERO: `payload` es `string | jwt.JwtPayload`, así que leer
// `payload.platformId` antes de estrecharlo es TS2339.
if (typeof payload === "string") {
  throw new InvalidTokenError("payload no es un objeto");
}
const platformId = payload.platformId;
if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
  throw new InvalidTokenError("sin claim sub");
}
if (typeof platformId !== "string" || platformId.trim().length === 0) {
  throw new InvalidTokenError("sin claim platformId");
}
// SE DEVUELVE NORMALIZADA, igual que la normaliza `configOf`. Validar con trim y devolver
// sin trim deja `"betaso "` en el token y `"betaso"` en el asiento: las dos validaciones
// pasan y el cruce de `onJoin` falla, con la inscripción ya cobrada.
return { platformId: platformId.trim(), userUuid: payload.sub.trim() };
```

Conservar el `try/catch` actual para que errores de firma, algoritmo, expiración y claims se traduzcan al mismo `InvalidTokenError`.

⚠ **El snippet original de este Step no compilaba, por dos motivos a la vez.** Leía
`payload.platformId` sin estrechar `string | jwt.JwtPayload` (TS2339), y lanzaba
`new InvalidTokenError()` sin argumento contra la firma `constructor(reason: string)` que este
mismo Step dice conservar (TS2554). Van las tres ramas separadas: una razón distinta por causa es
lo único que hace investigable un rechazo de autenticación en el log.

- [x] **Step 7: Implementar el contrato validado y el config sin campos duplicados**

Reemplazar la parte de partida en `core/config.ts` por:

```ts
import type { PlayerRef } from "../../../shared/player-ref.js";
import type { PlayerId } from "./ids.js";

export interface MatchSeat extends PlayerRef {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly username?: string;
  readonly profilePicture?: string;
  readonly currency: string;
}

export interface DominoMatchConfig {
  readonly matchId: string;
  readonly gameModeId: string;
  readonly seed: string;
  readonly seats: readonly MatchSeat[];
  readonly pointsToWin: number;
  readonly teamAssignment: TeamAssignmentMode;
  readonly isDealWindowEnabled: boolean;
  readonly rateId: string;
  readonly entryFeeUcMinor: number;
  readonly prizeUcMinor: number;
}

export const playerIdsOf = (config: DominoMatchConfig): readonly PlayerId[] =>
  config.seats.map(({ playerId }) => playerId);
```

Conservar sin cambios `TeamAssignmentMode`, `GlobalDominoConfig`, defaults y `globalConfigWith` del archivo.

Reemplazar `match-contract.ts` por:

```ts
import { z } from "zod";
import type { PlayerRef } from "../../../shared/player-ref.js";
import type { DominoMatchConfig } from "../core/config.js";

const nonBlank = z.string().refine((value) => value.trim().length > 0, "no puede estar vacío");
const ucMinor = z
  .number()
  .refine(Number.isSafeInteger, "debe ser un entero seguro")
  .refine((value) => value >= 0, "no puede ser negativo");

// La identidad se NORMALIZA (es una llave que se compara contra el token y se concatena en
// la clave del registro); la moneda NO (es un valor contable que se conserva como se cobró).
const identityPart = nonBlank.transform((value) => value.trim());

const participant = z.strictObject({
  platformId: identityPart,
  userUuid: identityPart,
  displayName: nonBlank,
  username: nonBlank.optional(),
  profilePicture: nonBlank.optional(),
  currency: nonBlank,
});

const roomOptions = z
  .strictObject({
    mode: z.literal("CASUAL"),
    matchId: nonBlank,
    gameModeId: nonBlank,
    participants: z.array(participant).min(2).max(4),
    seed: nonBlank,
    pointsToWin: z.number().int().positive().safe(),
    teamAssignment: z.enum(["SHUFFLED", "SEAT_ORDER"]),
    rateId: z.uuid(),
    entryFeeUcMinor: ucMinor,
    prizeUcMinor: ucMinor,
  })
  .superRefine(({ participants }, context) => {
    if (participants.length % 2 !== 0) {
      context.addIssue({ code: "custom", path: ["participants"], message: "cantidad impar" });
    }
    const seen = new Set<string>();
    participants.forEach((value, index) => {
      const key = JSON.stringify([value.platformId, value.userUuid]);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["participants", index],
          message: "referencia de jugador duplicada",
        });
      }
      seen.add(key);
    });
  });

export type MatchParticipant = z.infer<typeof participant>;
export type DominoRoomOptions = z.infer<typeof roomOptions>;

export interface SeatCredentials extends PlayerRef {
  readonly token: string;
}

export function configOf(input: unknown): DominoMatchConfig {
  const options = roomOptions.parse(input);
  return {
    matchId: options.matchId,
    gameModeId: options.gameModeId,
    seats: options.participants.map((value, index) => ({
      ...value,
      playerId: `seat-${index + 1}`,
    })),
    seed: options.seed,
    pointsToWin: options.pointsToWin,
    teamAssignment: options.teamAssignment,
    isDealWindowEnabled: true,
    rateId: options.rateId,
    entryFeeUcMinor: options.entryFeeUcMinor,
    prizeUcMinor: options.prizeUcMinor,
  };
}
```

Exportar también `MatchParticipant` desde `src/features/match/index.ts`.

- [x] **Step 8: Copiar el snapshot a estado y adaptar los consumidores del motor**

En `PlayerState` añadir antes de `teamId`:

```ts
displayName: t.string(),
username: t.string().optional(),
profilePicture: t.string().optional(),
platformId: t.string().noSync(),
userUuid: t.string().noSync(),
currency: t.string().noSync(),
```

En `createMatchState` usar una sola lista, sin `participants` paralelo:

```ts
const playerIds = playerIdsOf(config);
const teams = assignTeams(playerIds, config.teamAssignment, config.seed);

config.seats.forEach((seat, seatIndex) => {
  const teamId = teams[seatIndex];
  if (!teamId) throw new InvariantViolationError(`sin equipo para el asiento ${seatIndex}`);

  const player = new PlayerState();
  player.playerId = seat.playerId;
  player.displayName = seat.displayName;
  player.username = seat.username;
  player.profilePicture = seat.profilePicture;
  player.platformId = seat.platformId;
  player.userUuid = seat.userUuid;
  player.currency = seat.currency;
  player.seatIndex = seatIndex;
  player.teamId = teamId;
  player.hand = new Hand();
  match.players.push(player);
});
```

Importar `playerIdsOf`. En `dealer.ts`, `history/engine-factory.ts` y `core/engine/tests/build-engine.ts`, reemplazar cada iteración/constructor que espera ids por `playerIdsOf(config)`. No cambiar `assignTeams`, `PlayerRepository` ni `maxClients`.

- [x] **Step 9: Adaptar sala y registro a la pareja**

En `DominoRoom` guardar `private config!: DominoMatchConfig`, construir primero `const config = configOf(options)`, asignar `this.config = config`, y obtener `this.seats = playerIdsOf(config)`.

Cambiar `onCreate(options: DominoRoomOptions)` a `onCreate(options: unknown)` para que Zod sea la frontera real. Cambiar `onAuth` a:

```ts
override async onAuth(
  _client: Client,
  _options: unknown,
  context: AuthContext,
): Promise<SeatCredentials> {
  const token = context.token ?? undefined;
  const identity = await rootContainer.resolve<TokenVerifier>("TokenVerifier").verify(token);
  return { ...identity, token: token ?? "" };
}
```

Al principio de `onJoin`, reemplazar la extracción por:

```ts
const identity = client.auth as SeatCredentials;
const playerId = this.config.seats.find(
  (seat) =>
    seat.platformId === identity.platformId && seat.userUuid === identity.userUuid,
)?.playerId;
if (!playerId) {
  throw new SeatNotReservedError(JSON.stringify([identity.platformId, identity.userUuid]));
}
```

Conservar a partir de ahí la guarda `isStillPlaying`, vistas, reconexión, timers y el cálculo actual de `maxClients`.

En `MatchRegistry`, mantener `PublicMatchConfig.seats` como ids opacos y definir:

```ts
const playerKey = ({ platformId, userUuid }: PlayerRef) =>
  `player_match:${JSON.stringify([platformId, userUuid])}`;
```

En `register`, publicar `seats: config.seats.map(({ playerId }) => playerId)`. En `keepAlive` y `remove`, recorrer `config.seats` originales guardados en un segundo `private readonly seatsByRoomId = new Map<string, readonly MatchSeat[]>()`; `byRoomId` sigue conteniendo únicamente `PublicMatchConfig`. Cambiar las firmas a:

```ts
async matchOf(player: PlayerRef): Promise<string | undefined>
private async release(player: PlayerRef, roomId: string): Promise<void>
```

Aplicar estas escrituras exactas en los métodos:

```ts
private readonly byRoomId = new Map<string, PublicMatchConfig>();
private readonly seatsByRoomId = new Map<string, readonly PlayerRef[]>();

async register(roomId: string, config: DominoMatchConfig): Promise<void> {
  this.byRoomId.set(roomId, {
    matchId: config.matchId,
    gameModeId: config.gameModeId,
    seats: config.seats.map(({ playerId }) => playerId),
    pointsToWin: config.pointsToWin,
  });
  this.seatsByRoomId.set(
    roomId,
    config.seats.map(({ platformId, userUuid }) => ({ platformId, userUuid })),
  );
  await this.keepAlive(roomId);
}

async keepAlive(roomId: string): Promise<void> {
  const config = this.byRoomId.get(roomId);
  const seats = this.seatsByRoomId.get(roomId);
  if (!config || !seats) return;
  await this.store.setex(configKey(roomId), JSON.stringify(config), TTL_SECONDS);
  for (const seat of seats) {
    await this.store.setex(playerKey(seat), roomId, TTL_SECONDS);
  }
}

async matchOf(player: PlayerRef): Promise<string | undefined> {
  return await this.store.get(playerKey(player));
}

async remove(roomId: string): Promise<void> {
  const seats = this.seatsByRoomId.get(roomId);
  if (!this.byRoomId.has(roomId) || !seats) return;
  this.byRoomId.delete(roomId);
  this.seatsByRoomId.delete(roomId);
  this.store.del(configKey(roomId));
  for (const seat of seats) await this.release(seat, roomId);
}

private async release(player: PlayerRef, roomId: string): Promise<void> {
  if ((await this.store.get(playerKey(player))) === roomId) {
    this.store.del(playerKey(player));
  }
}
```

Esto evita reconstruir identidad desde el DTO público y evita guardar el config financiero entero en memoria del registro.

- [x] **Step 10: Crear el fixture de config y migrar los tests unitarios**

Crear `core/engine/tests/match-config-fixture.ts`:

```ts
import type { DominoMatchConfig, MatchSeat } from "../../config.js";

export const matchSeat = (playerId: string): MatchSeat => ({
  playerId,
  platformId: "betaso",
  userUuid: playerId,
  displayName: `Jugador ${playerId}`,
  currency: "VES",
});

export const matchConfig = (
  playerIds: readonly string[],
  overrides: Partial<DominoMatchConfig> = {},
): DominoMatchConfig => ({
  matchId: "m-test",
  gameModeId: "test",
  seed: "seed-test",
  seats: playerIds.map(matchSeat),
  pointsToWin: 100,
  teamAssignment: "SEAT_ORDER",
  isDealWindowEnabled: false,
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFeeUcMinor: 125,
  prizeUcMinor: 250,
  ...overrides,
});
```

Usar `matchConfig`/`matchSeat` en `dealer.test.ts`, `genesis.test.ts`, `match-referee.test.ts`, `scorer.test.ts`, `state-projections.test.ts` y `build-engine.ts`. Las expectativas de ids siguen usando `u1`, porque el fixture ya recibe ids internos; no introducir identidad externa en reglas que no la consumen.

En `network/tests/history.test.ts`, `tests/replay.test.ts` y `match-registry.test.ts`, construir el config con `configOf` y opciones completas. En el replay, derivar ids con `meta.seats.map(({ playerId }) => playerId)`.

En `match-registry.test.ts`, reemplazar el fixture superior por:

```ts
const participant = (userUuid: string) => ({
  platformId: "betaso",
  userUuid,
  displayName: `Jugador ${userUuid}`,
  currency: "VES",
});

const roomOptions = {
  mode: "CASUAL",
  matchId: "m1",
  gameModeId: "clasica-2p",
  participants: [participant("u1"), participant("u2")],
  seed: "secreto-que-no-sale",
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFeeUcMinor: 125,
  prizeUcMinor: 250,
} as const;

const config = configOf(roomOptions);
const collidingConfig = configOf({
  ...roomOptions,
  participants: [
    { ...participant("same"), platformId: "betaso" },
    { ...participant("same"), platformId: "partner", currency: "USD" },
  ],
});
```

En todos los casos existentes de `match-registry.test.ts`, reemplazar `matchOf("uN")` por
`matchOf({ platformId: "betaso", userUuid: "uN" })`; cambiar las expectativas públicas de
`seats: ["u1", "u2"]` a `seats: ["seat-1", "seat-2"]`. Para la prueba que mueve `u1` a
`room-2`, crear el segundo config con `configOf({ ...roomOptions, matchId: "m2", participants:
[participant("u1"), participant("u3")] })`.

En `domino-room.test.ts`, reemplazar sus helpers por:

```ts
const defaultParticipants = [
  { platformId: "betaso", userUuid: "a", displayName: "A", currency: "VES" },
  { platformId: "betaso", userUuid: "b", displayName: "B", currency: "VES" },
] as const;

function options(
  matchId: string,
  participants: readonly MatchParticipant[] = defaultParticipants,
): DominoRoomOptions {
  return {
    mode: "CASUAL",
    matchId,
    gameModeId: "classic-2p",
    participants: [...participants],
    seed: "seed",
    pointsToWin: 100,
    teamAssignment: "SEAT_ORDER",
    rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
    entryFeeUcMinor: 125,
    prizeUcMinor: 250,
  };
}

const tokenOf = (player: string | PlayerRef) => {
  const identity =
    typeof player === "string" ? { platformId: "betaso", userUuid: player } : player;
  return jwt.sign({ sub: identity.userUuid, platformId: identity.platformId }, env.jwtSecret, {
    algorithm: "HS256",
  });
};

async function connect(
  testServer: ColyseusTestServer,
  room: DominoRoom,
  player: string | PlayerRef,
) {
  testServer.sdk.auth.token = tokenOf(player);
  return testServer.connectTo(room);
}
```

Importar `PlayerRef` y `MatchParticipant`. En el primer test, usar `tokenOf("a")` y esperar `room.clients[0]?.auth` igual a `{ platformId: "betaso", userUuid: "a", token }`.

- [x] **Step 11: Migrar el arnés E2E sin obligar a cada test a conocer `seat-N`**

En `e2e-harness.ts`, definir:

```ts
type ParticipantInput = string | MatchParticipant;

const participantOf = (input: ParticipantInput): MatchParticipant =>
  typeof input === "string"
    ? {
        platformId: "betaso",
        userUuid: input,
        displayName: `Jugador ${input}`,
        currency: "VES",
      }
    : input;

export function mintToken(player: PlayerRef): string {
  return jwt.sign({ sub: player.userUuid, platformId: player.platformId }, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: "1h",
  });
}
```

Hacer que `casualTable` acepte `readonly ParticipantInput[]` y reemplazar su cuerpo por:

```ts
const participants = seats.map(participantOf);
return {
  mode: "CASUAL",
  matchId: `m-${participants.map(({ userUuid }) => userUuid).join("-")}`,
  gameModeId: "clasica-2p",
  participants,
  seed,
  pointsToWin: 100,
  teamAssignment: "SHUFFLED",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFeeUcMinor: 125,
  prizeUcMinor: 250,
};
```

Añadir `readonly config: DominoMatchConfig` a `SeatedMatch`. Cambiar la entrada de `seatPair` a `readonly [ParticipantInput, ParticipantInput]` y usar este cuerpo:

```ts
const options = casualTable(seats, seed);
const config = configOf(options);
const room = await server.createRoom("domino", options);
const clients: SeatedMatch["clients"] = {};
for (const seat of config.seats) {
  server.sdk.auth.token = mintToken(seat);
  clients[seat.playerId] = await server.connectTo(room);
}
return { roomId: room.roomId, options, config, serverState: room.state as MatchState, clients };
```

Añadir el resolvedor único:

```ts
export function playerIdOf(match: SeatedMatch, selector: string | PlayerRef): string {
  if (typeof selector !== "string") {
    const seat = match.config.seats.find(
      (candidate) =>
        candidate.platformId === selector.platformId && candidate.userUuid === selector.userUuid,
    );
    if (!seat) throw new Error(`sin asiento para ${JSON.stringify(selector)}`);
    return seat.playerId;
  }
  const direct = match.config.seats.find(({ playerId }) => playerId === selector);
  if (direct) return direct.playerId;
  const byUuid = match.config.seats.filter(({ userUuid }) => userUuid === selector);
  if (byUuid.length !== 1) throw new Error(`selector ambiguo o ausente: ${selector}`);
  const seat = byUuid[0];
  if (!seat) throw new Error(`selector ausente: ${selector}`);
  return seat.playerId;
}

export function clientOf(match: SeatedMatch, selector: string | PlayerRef) {
  const playerId = playerIdOf(match, selector);
  const client = match.clients[playerId];
  if (!client) throw new Error(`sin cliente para el asiento ${playerId}`);
  return client;
}
```

Hacer que `act` llame `clientOf(match, selector).send(...)`. Reemplazar `rejoinAs` por:

```ts
export async function rejoinAs(
  server: ColyseusTestServer,
  match: SeatedMatch,
  selector: string | PlayerRef,
): Promise<Room<unknown, MatchState>> {
  const playerId = playerIdOf(match, selector);
  const seat = match.config.seats.find((candidate) => candidate.playerId === playerId);
  if (!seat) throw new Error(`sin asiento para ${playerId}`);
  server.sdk.auth.token = mintToken(seat);
  const room = await server.sdk.joinById<MatchState>(match.roomId);
  await room.waitForInitialState();
  return room;
}
```

`participantOf` se EXPORTA: `lifecycle-e2e.test.ts` tiene tres `mintToken("<uuid>")` que el
plan no menciona y que dejan de compilar cuando `mintToken` pasa a pedir un `PlayerRef`; se
escriben `mintToken(participantOf("d1"))` en vez de repetir `{ platformId: "betaso", … }` en
cada test.

En `visibility` y `reconnection`, cambiar cada llamada a `rejoinAs(server, match.roomId, selector)` por `rejoinAs(server, match, selector)`. En `visibility`, `deal-window`, `lifecycle` y `reconnection`, reemplazar accesos directos `match.clients.<uuid>` y comparaciones `playerId === "<uuid>"` por `clientOf(...)` y `playerIdOf(...)`. No tocar el algoritmo del juego.

Y en `lifecycle` hay además dos aserciones que el plan no nombra y que pasan a ser de asientos:
`players.map(playerId)` deja de valer `["u1", "u2"]` y el DTO de `/config` deja de traer
`seats: ["c1", "c2"]` — las dos pasan a `["seat-1", "seat-2"]`, que es justamente el punto.

- [x] **Step 12: Adaptar el CLI de replay sin fingir datos históricos**

En `src/replay.ts`, mantener los argumentos posicionales actuales como ids de asiento y construir participantes explícitamente sintéticos:

```ts
const participants = seats.map((userUuid) => ({
  platformId: "replay",
  userUuid,
  displayName: userUuid,
  currency: "REPLAY",
}));

const options: DominoRoomOptions = {
  mode: "CASUAL",
  matchId,
  gameModeId: "replay",
  participants,
  seed,
  pointsToWin,
  teamAssignment,
  rateId: "00000000-0000-4000-8000-000000000000",
  entryFeeUcMinor: 0,
  prizeUcMinor: 0,
};
```

Actualizar el comentario del CLI: esos valores solo completan campos que no intervienen en el engine; el historial actual no contiene el snapshot real. No presentar `REPLAY` como moneda real ni usar este config para liquidar.

- [x] **Step 13: Ejecutar targeted, regenerar golden y cerrar el gate completo**

Run:

```bash
npx vitest run src/features/auth/transports/jwt-verifier.test.ts src/features/match/transports/match-contract.test.ts src/features/match/core/engine/tests/genesis.test.ts src/features/match/transports/match-registry.test.ts src/features/match/transports/colyseus/domino-room.test.ts src/features/match/tests/visibility.smoke.test.ts
npm run typecheck
```

Expected: todos PASS y `tsc --noEmit` termina con código 0.

Regenerar el fixture porque cambió `DominoMatchConfig`:

```powershell
$env:WRITE_GOLDEN='1'; npx vitest run src/features/match/tests/game-2p-e2e.test.ts; Remove-Item Env:WRITE_GOLDEN
```

Expected: `game-2p-e2e.test.ts` PASS y `golden-2p.json` contiene `rateId`, montos y asientos normalizados.

Run:

```bash
npm run format
npm run typecheck
npm test
npm run lint
```

Expected: cuatro comandos con código 0; la suite supera el baseline anterior de 320 tests.

- [x] **Step 14: Reindexar, registrar continuidad y commit**

Ejecutar `index_repository` sobre la raíz con modo `fast`. Actualizar `AGENTS.md` a `Tarea 1 completa`, anotar el total real de tests y `siguiente: Task 2, Step 1`. Marcar esta tarea `[x]` en el plan.

```bash
git add src AGENTS.md docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md
git commit -m "feat(multiplataforma): congela identidad y moneda por asiento" -m "Normaliza la pareja plataforma/usuario a un id opaco y deja perfil e identidad financiera en un único snapshot. Mantener userId como identidad global mezclaría cuentas de plataformas distintas y podría recompensar la wallet equivocada.\n\nCo-Authored-By: GPT-5 <noreply@anthropic.com>"
```

Expected: commit creado; `git status --short` vacío.

**Continuidad:** Tarea 1 completa y revisada; baseline 346 tests / 49 archivos; siguiente paso
exacto: Task 2, Step 1.

### Task 2: Proyectar recompensa y reembolso sin mover dinero

**Files:**
- Create: `src/features/match/network/settlement.ts`
- Create: `src/features/match/network/tests/settlement.test.ts`
- Modify: `src/features/match/network/index.ts`
- Modify: `src/features/match/index.ts`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md`

- [x] **Step 1: Escribir los tests monetarios rojos**

Crear `network/tests/settlement.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { configOf } from "../../transports/match-contract.js";
import { createMatchState } from "../../core/engine/genesis.js";
import { settlementOf } from "../settlement.js";

const options = {
  mode: "CASUAL",
  matchId: "money-1",
  gameModeId: "classic-2p",
  participants: [
    { platformId: "betaso", userUuid: "same", displayName: "Ada", currency: "VES" },
    { platformId: "partner", userUuid: "same", displayName: "Lin", currency: "USD" },
  ],
  seed: "money-seed",
  pointsToWin: 100,
  teamAssignment: "SEAT_ORDER",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFeeUcMinor: 125,
  prizeUcMinor: 250,
} as const;

const config = configOf(options);
const matchOf = () => createMatchState(config);

describe("settlementOf", () => {
  it("premia al ganador con su pareja y la moneda cobrada", () => {
    const match = matchOf();
    const winnerTeamId = match.players[0]?.teamId as "A" | "B";
    expect(
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId, reason: "SCORE" }, match, config),
    ).toEqual({
      matchId: "money-1",
      rateId: options.rateId,
      kind: "REWARD",
      entries: [
        {
          platformId: "betaso",
          userUuid: "same",
          currency: "VES",
          amountUcMinor: 250,
          idempotencyKey: JSON.stringify(["money-1", "REWARD", "betaso", "same"]),
        },
      ],
    });
  });

  it("reembolsa a todos un aborto en la moneda original", () => {
    const match = matchOf();
    const result = settlementOf({ type: "MATCH_ABORTED", reason: "INTERRUPTED" }, match, config);
    expect(result?.kind).toBe("REFUND");
    expect(result?.entries).toEqual([
      expect.objectContaining({ platformId: "betaso", currency: "VES", amountUcMinor: 125 }),
      expect.objectContaining({ platformId: "partner", currency: "USD", amountUcMinor: 125 }),
    ]);
  });

  it("no proyecta eventos no terminales y rechaza un ganador imposible", () => {
    const match = matchOf();
    expect(settlementOf({ type: "PLAYER_DISCONNECTED", playerId: "seat-1" }, match, config)).toBeUndefined();
    for (const player of match.players) player.teamId = "B";
    expect(() =>
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }, match, config),
    ).toThrow(/exactamente un ganador/);
  });

  // LA OTRA MITAD DE LA GUARDA, y es la que puede pasar de verdad: `configOf` acepta cuatro
  // participantes, así que una mesa con dos ganadores del mismo equipo es alcanzable hoy.
  // Sin esta aserción el guard podía ser `=== 0` y la suite seguía verde — pagando el premio
  // ENTERO a cada uno de los dos, o sea el doble de lo que la mesa cobró.
  it("rechaza varios ganadores en vez de pagarle el premio entero a cada uno", () => {
    const match = matchOf();
    for (const player of match.players) player.teamId = "A";
    expect(() =>
      settlementOf({ type: "MATCH_RESOLVED", winnerTeamId: "A", reason: "SCORE" }, match, config),
    ).toThrow(/exactamente un ganador, recibió 2/);
  });
});
```

⚠ **El tercer `it` del plan original decía "rechaza un ganador imposible" y solo medía CERO
ganadores**: con el guard cambiado a `winners.length === 0` los tres tests seguían verdes, y el
caso que la guarda existe para cubrir —varios ganadores, o sea el 4P que `configOf` ya acepta—
pagaba el premio entero a cada uno. El cuarto `it` es el que mide esa rama; se descubrió mutando
el guard a mano y viendo que la suite no se inmutaba.

- [x] **Step 2: Ejecutar el rojo**

Run: `npx vitest run src/features/match/network/tests/settlement.test.ts`

Expected: FAIL porque `network/settlement.ts` no existe.

- [x] **Step 3: Implementar la proyección pura**

Crear `network/settlement.ts`:

```ts
import type { PlayerRef } from "../../../shared/player-ref.js";
import type { DominoMatchConfig, MatchSeat } from "../core/config.js";
import { InvariantViolationError } from "../core/engine/errors.js";
import type { MatchState } from "../core/state/index.js";
import type { NetworkMatchEvent } from "./events.js";

export type SettlementKind = "REWARD" | "REFUND";

export interface SettlementEntry extends PlayerRef {
  readonly currency: string;
  readonly amountUcMinor: number;
  readonly idempotencyKey: string;
}

export interface SettlementInstruction {
  readonly matchId: string;
  readonly rateId: string;
  readonly kind: SettlementKind;
  readonly entries: readonly SettlementEntry[];
}

const entryOf = (
  config: DominoMatchConfig,
  kind: SettlementKind,
  amountUcMinor: number,
  seat: MatchSeat,
): SettlementEntry => ({
  platformId: seat.platformId,
  userUuid: seat.userUuid,
  currency: seat.currency,
  amountUcMinor,
  idempotencyKey: JSON.stringify([config.matchId, kind, seat.platformId, seat.userUuid]),
});

export function settlementOf(
  event: NetworkMatchEvent,
  match: MatchState,
  config: DominoMatchConfig,
): SettlementInstruction | undefined {
  if (event.type === "MATCH_ABORTED") {
    return {
      matchId: config.matchId,
      rateId: config.rateId,
      kind: "REFUND",
      entries: config.seats.map((seat) => entryOf(config, "REFUND", config.entryFeeUcMinor, seat)),
    };
  }
  if (event.type !== "MATCH_RESOLVED") return undefined;

  const winnerIds = new Set(
    match.players
      .filter(({ teamId }) => teamId === event.winnerTeamId)
      .map(({ playerId }) => playerId),
  );
  const winners = config.seats.filter(({ playerId }) => winnerIds.has(playerId));
  if (winners.length !== 1) {
    throw new InvariantViolationError(
      `la liquidación 2P necesita exactamente un ganador, recibió ${winners.length}`,
    );
  }
  return {
    matchId: config.matchId,
    rateId: config.rateId,
    kind: "REWARD",
    entries: winners.map((seat) => entryOf(config, "REWARD", config.prizeUcMinor, seat)),
  };
}
```

Exportar el archivo desde `network/index.ts` y exportar `settlementOf`, `SettlementEntry`, `SettlementInstruction` y `SettlementKind` desde la superficie `features/match/index.ts`.

- [x] **Step 4: Verificar, documentar y commit**

Run:

```bash
npm run format
npm run typecheck
npx vitest run src/features/match/network/tests/settlement.test.ts
npm test
npm run lint
```

Expected: todos código 0. Actualizar `AGENTS.md` con `Tarea 2 completa`, baseline real y `siguiente: Task 3, Step 1`; marcar Task 2 completa.

```bash
git add src/features/match AGENTS.md docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md
git commit -m "feat(liquidacion): proyecta premio y reembolso por plataforma" -m "Devuelve la pareja y moneda congeladas junto al mismo rateId sin convertir ni mover dinero. Resolver la wallet desde playerId o permitir varios ganadores 2P haría ambiguo quién cobra.\n\nCo-Authored-By: GPT-5 <noreply@anthropic.com>"
```

**Lo que la revisión agregó, y que los snippets de arriba NO tienen** (el código que corre está
en `network/settlement.ts` y su test; esto es el índice de las diferencias):

1. **`assertSameTable` antes de cualquier instrucción.** Los `playerId` son posicionales, así que
   `settlementOf(evento, estadoDeLaMesaA, configDeLaMesaB)` **no** da 0 ni 2 ganadores: da
   exactamente 1, y emite una instrucción coherente que le paga a otra persona. La guarda compara
   forma (largo y pertenencia) y nombra el desajuste, no el conteo de ganadores. No puede
   distinguir dos mesas del mismo tamaño: `MatchState` no lleva `matchId`.
2. **`switch` exhaustivo con `const unhandled: never = event`** en vez de
   `if (type !== "MATCH_RESOLVED") return undefined`. Un evento de plataforma nuevo que también
   devuelva plata compilaría, devolvería `undefined` y nadie cobraría; con el `never` lo frena
   `typecheck`.
3. **Tres contratos que estaban solo en prosa, ahora medidos**: `it.each` sobre los tres
   `AbortReason`, igualdad COMPLETA del `SettlementInstruction` del reembolso (con
   `objectContaining` de tres campos, cambiar el `kind` del `REFUND` a `"REWARD"` dejaba la suite
   verde y la clave del reembolso del ganador quedaba idéntica a la de su premio) y un `REFUND` de
   cuatro entradas.
4. **`entryOf` recibe el `matchId` pelado**, no la `config` entera: con la config adentro podría
   leer los montos y el "cuánto" dejaría de decidirse en un solo lugar.
5. **La superficie exporta también `NetworkMatchEvent`, `DominoMatchConfig` y `MatchState`**: el
   primer parámetro de `settlementOf` ES un evento del catálogo, así que sin esos tipos el
   consumidor puede pasar literales pero no declarar la variable ni escribir el `switch`.
6. **Las claves de idempotencia se assertan como literal**, no recalculadas con el mismo
   `JSON.stringify` del código bajo prueba.

### Task 3: Construir el cliente smoke contra el protocolo público

**Files:**
- Create: `src/smoke/engine-smoke.ts`
- Create: `src/smoke/engine-smoke.test.ts`
- Modify: `src/env.ts`
- Modify: `src/env.test.ts`
- Modify: `.env.example`
- Modify: `package.json`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md`

- [x] **Step 1: Escribir el rojo del bot y de la flag**

Crear `src/smoke/engine-smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MatchState } from "../features/match/core/state/index.js";
import { nextAction, requireSmokeFlag } from "./engine-smoke.js";

describe("engine smoke", () => {
  it("se niega a correr sin flag", () => {
    expect(() => requireSmokeFlag(false)).toThrow(/RUN_ENGINE_SMOKE=1/);
    expect(() => requireSmokeFlag(true)).not.toThrow();
  });

  it("elige jugar, robar o pasar desde el estado visible", () => {
    const state = new MatchState();
    expect(nextAction(state, "seat-1")).toBeUndefined();
  });
});
```

El segundo caso fija que fuera de una ronda `PLAYING` no se envía ningún verbo; los caminos jugar/robar/pasar quedarán cubiertos por la partida real y por los E2E existentes del engine.

- [x] **Step 2: Ejecutar el rojo**

Run: `npx vitest run src/smoke/engine-smoke.test.ts`

Expected: FAIL porque el módulo no existe.

- [x] **Step 3: Añadir la flag al único lector de entorno**

En el schema de `env.ts` añadir:

```ts
RUN_ENGINE_SMOKE: z.string().optional(),
```

En `Env` añadir `readonly runEngineSmoke: boolean;` y en `parseEnv`:

```ts
runEngineSmoke: parsed.RUN_ENGINE_SMOKE === "1",
```

En `env.test.ts` añadir:

```ts
it("solo activa el smoke con el valor 1", () => {
  expect(parseEnv({ JWT_SECRET: "s".repeat(16), RUN_ENGINE_SMOKE: "1" }).runEngineSmoke).toBe(true);
  expect(parseEnv({ JWT_SECRET: "s".repeat(16), RUN_ENGINE_SMOKE: "true" }).runEngineSmoke).toBe(false);
});
```

Documentar en `.env.example`:

```dotenv
# Herramienta local/CI: el runner de Docker se niega a correr si no vale exactamente 1.
RUN_ENGINE_SMOKE=0
```

- [x] **Step 4: Implementar el runner con funciones pequeñas y plazos**

Crear `src/smoke/engine-smoke.ts`:

```ts
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { ColyseusSDK, type Room } from "@colyseus/sdk";
import jwt from "jsonwebtoken";
import { env } from "../env.js";
import type { DominoMatchConfig } from "../features/match/core/config.js";
import { createMatchState } from "../features/match/core/engine/genesis.js";
import { boardEndsOf } from "../features/match/core/engine/round/board-ends.js";
import { playableSides } from "../features/match/core/engine/round/playable.js";
import { boneyardCountOf } from "../features/match/core/engine/state-projections.js";
import { MatchState } from "../features/match/core/state/index.js";
import type { BoardSide } from "../features/match/core/state/tile.js";
import { settlementOf } from "../features/match/index.js";
import {
  type DominoRoomOptions,
  configOf,
} from "../features/match/transports/match-contract.js";
import { logger } from "../logger.js";

const WS_URL = "ws://nginx:8080";
const HTTP_URL = "http://nginx:8080";
const OPTIONS = {
  mode: "CASUAL",
  matchId: "smoke-full-game",
  gameModeId: "classic-2p",
  participants: [
    {
      platformId: "betaso",
      userUuid: "shared-smoke-uuid",
      displayName: "Ada",
      currency: "VES",
    },
    {
      platformId: "partner",
      userUuid: "shared-smoke-uuid",
      displayName: "Lin",
      currency: "USD",
    },
  ],
  seed: "smoke-deterministic-seed",
  pointsToWin: 30,
  teamAssignment: "SEAT_ORDER",
  rateId: "8b16f47f-8cf0-4e1f-9e72-ff1a79bb3fd0",
  entryFeeUcMinor: 125,
  prizeUcMinor: 250,
} satisfies DominoRoomOptions;

type SmokeRoom = Room<unknown, MatchState>;

export function requireSmokeFlag(enabled: boolean): void {
  if (!enabled) throw new Error("el smoke requiere RUN_ENGINE_SMOKE=1");
}

export type SmokeAction =
  | {
      readonly type: "PLAY_TILE";
      readonly payload: { left: number; right: number; side: BoardSide };
    }
  | { readonly type: "DRAW_TILE"; readonly payload: Record<string, never> }
  | { readonly type: "PASS"; readonly payload: Record<string, never> };

export function nextAction(state: MatchState, playerId: string): SmokeAction | undefined {
  const round = state.currentRound;
  if (!round || round.phase !== "PLAYING") return undefined;
  const hand = state.players.find((player) => player.playerId === playerId)?.hand;
  if (!hand) throw new Error(`sin mano visible para ${playerId}`);
  const ends = boardEndsOf(round.board);
  for (const tile of hand.tiles) {
    const side = playableSides(tile, ends).at(0);
    if (side) return { type: "PLAY_TILE", payload: { left: tile.left, right: tile.right, side } };
  }
  return boneyardCountOf(round) > 0
    ? { type: "DRAW_TILE", payload: {} }
    : { type: "PASS", payload: {} };
}

async function waitUntil(
  label: string,
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() <= deadline) {
    try {
      if (await predicate()) return;
    } catch (error: unknown) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`${label}: se agotó el plazo${detail}`);
}

const tokenOf = (platformId: string, userUuid: string) =>
  jwt.sign({ sub: userUuid, platformId }, env.jwtSecret, {
    algorithm: "HS256",
    expiresIn: "10m",
  });

const signatureOf = (state: MatchState) =>
  JSON.stringify([
    state.phase,
    state.activeDeadline,
    state.currentRound?.phase,
    state.currentRound?.roundNumber,
    state.currentRound?.currentTurn?.playerId,
    state.currentRound?.board.tiles.map(({ tile, side }) => [tile.left, tile.right, side]),
    state.currentRound?.boneyard?.count,
    state.players.map(({ playerId, hand }) => [playerId, hand.tileCount]),
  ]);

const isReady = async (port: number) => {
  const response = await fetch(`${HTTP_URL}/${port}/ready`);
  return response.status === 200;
};

interface HistoryLine {
  readonly type: string;
  readonly payload: Record<string, unknown>;
}

async function historyOf(matchId: string): Promise<readonly HistoryLine[]> {
  assert.ok(env.internalApiKey, "falta INTERNAL_API_KEY en el cliente smoke");
  const response = await fetch(`${HTTP_URL}/internal/matches/${matchId}/history`, {
    headers: { "X-Internal-Key": env.internalApiKey },
  });
  if (response.status !== 200) return [];
  const body = (await response.json()) as { entries?: readonly HistoryLine[] };
  return body.entries ?? [];
}

function assertSettlements(
  history: readonly HistoryLine[],
  state: MatchState,
  config: DominoMatchConfig,
): void {
  const line = history.find(({ type }) => type === "MATCH_RESOLVED");
  assert.ok(line, "historial sin MATCH_RESOLVED");
  const winnerTeamId = line.payload.winnerTeamId;
  const reason = line.payload.reason;
  assert.ok(winnerTeamId === "A" || winnerTeamId === "B", "winnerTeamId inválido");
  assert.equal(reason, "SCORE", "el smoke terminó sin jugar hasta el puntaje");

  // El estado del SDK no trae `platformId`/`userUuid`: son `noSync()` a propósito. Se
  // reconstruye únicamente ese snapshot privado desde el mismo config y se copian los equipos
  // que sí llegaron del deploy. Así el ganador viene de la partida real sin fingir que el wire
  // puede alimentar la guarda privada de `settlementOf`.
  const settlementState = createMatchState(config);
  for (const player of settlementState.players) {
    const deployed = state.players.find(({ playerId }) => playerId === player.playerId);
    assert.ok(deployed, `el deploy no devolvió ${player.playerId}`);
    player.teamId = deployed.teamId;
  }

  const reward = settlementOf(
    { type: "MATCH_RESOLVED", winnerTeamId, reason },
    settlementState,
    config,
  );
  const winnerId = state.players.find(({ teamId }) => teamId === winnerTeamId)?.playerId;
  const winner = config.seats.find(({ playerId }) => playerId === winnerId);
  assert.ok(winner, "config sin asiento ganador");
  // La clave va como LITERAL. Recalcularla acá con el mismo `JSON.stringify` que usa
  // `settlementOf` mide que dos expresiones idénticas dan lo mismo —una tautología—: si
  // mañana el código serializa distinto, esta aserción lo acompaña sin ponerse roja. El
  // smoke verifica las PROPIEDADES del pago (quién, cuánto, en qué moneda) y el formato
  // exacto de la clave, que es la única defensa del pagador contra el pago doble.
  assert.deepEqual(reward, {
    matchId: config.matchId,
    rateId: config.rateId,
    kind: "REWARD",
    entries: [
      {
        platformId: winner.platformId,
        userUuid: winner.userUuid,
        currency: winner.currency,
        amountUcMinor: config.prizeUcMinor,
        idempotencyKey: `["${config.matchId}","REWARD","${winner.platformId}","${winner.userUuid}"]`,
      },
    ],
  });

  const refund = settlementOf(
    { type: "MATCH_ABORTED", reason: "INTERRUPTED" },
    settlementState,
    config,
  );
  assert.equal(refund?.kind, "REFUND");
  assert.deepEqual(
    refund?.entries.map(({ platformId, currency, amountUcMinor }) => ({
      platformId,
      currency,
      amountUcMinor,
    })),
    [
      { platformId: "betaso", currency: "VES", amountUcMinor: 125 },
      { platformId: "partner", currency: "USD", amountUcMinor: 125 },
    ],
  );
}

async function play(roomA: SmokeRoom, roomB: SmokeRoom, config: DominoMatchConfig) {
  const byPlayerId = new Map([
    [config.seats[0]?.playerId, roomA],
    [config.seats[1]?.playerId, roomB],
  ]);
  const recentActions: string[] = [];
  for (let turn = 0; turn < 3_000 && roomA.state.phase !== "FINISHED"; turn += 1) {
    const before = signatureOf(roomA.state);
    const playerId = roomA.state.currentRound?.currentTurn?.playerId;
    if (roomA.state.currentRound?.phase === "PLAYING" && playerId) {
      const owner = byPlayerId.get(playerId);
      if (!owner) throw new Error(`turno de asiento desconocido: ${playerId}`);
      await waitUntil(
        `la vista de ${playerId} no alcanzó al árbitro`,
        () => signatureOf(owner.state) === before,
        1_000,
      );
      const action = nextAction(owner.state, playerId);
      if (!action) throw new Error(`sin acción para ${playerId}`);
      recentActions.push(`${playerId} ${action.type}`);
      if (recentActions.length > 20) recentActions.shift();
      owner.send(action.type, action.payload);
    }
    await waitUntil("el estado no avanzó", () => signatureOf(roomA.state) !== before, 5_000);
  }
  assert.equal(
    roomA.state.phase,
    "FINISHED",
    `la partida no terminó; últimas acciones: ${recentActions.join(", ")}`,
  );
}

async function run(): Promise<void> {
  requireSmokeFlag(env.runEngineSmoke);
  await Promise.all([
    waitUntil("ready de 2567", () => isReady(2567), 30_000),
    waitUntil("ready de 2568", () => isReady(2568), 30_000),
  ]);

  const config = configOf(OPTIONS);
  const sdkA = new ColyseusSDK(WS_URL);
  const sdkB = new ColyseusSDK(WS_URL);
  sdkA.auth.token = tokenOf("betaso", "shared-smoke-uuid");
  sdkB.auth.token = tokenOf("partner", "shared-smoke-uuid");
  let roomA: SmokeRoom | undefined;
  let roomB: SmokeRoom | undefined;
  try {
    const first = await sdkA.create<MatchState>("domino", OPTIONS, MatchState);
    roomA = first;
    const second = await sdkB.joinById<MatchState>(first.roomId, {}, MatchState);
    roomB = second;
    await waitUntil(
      "estado inicial de ambos clientes",
      () => first.state.players.length === 2 && second.state.players.length === 2,
    );

    const outsider = new ColyseusSDK(WS_URL);
    outsider.auth.token = tokenOf("third", "shared-smoke-uuid");
    await assert.rejects(outsider.joinById(first.roomId, {}, MatchState));

    const wire = JSON.stringify(first.state.toJSON());
    assert.match(wire, /Ada/);
    assert.match(wire, /Lin/);
    for (const privateValue of ["shared-smoke-uuid", "betaso", "partner", "VES", "USD"]) {
      assert.equal(wire.includes(privateValue), false, `dato privado filtrado: ${privateValue}`);
    }

    first.send("REVEAL_TILES", {});
    second.send("REVEAL_TILES", {});
    await waitUntil(
      "reparto visible para sus dueños",
      () =>
        first.state.currentRound?.phase === "PLAYING" &&
        second.state.currentRound?.phase === "PLAYING" &&
        first.state.players.find(({ playerId }) => playerId === "seat-1")?.hand.tiles.length === 7 &&
        second.state.players.find(({ playerId }) => playerId === "seat-2")?.hand.tiles.length === 7,
    );

    await play(first, second, config);
    let history: readonly HistoryLine[] = [];
    await waitUntil("historial terminal", async () => {
      history = await historyOf(config.matchId);
      return history.some(({ type }) => type === "MATCH_RESOLVED");
    });
    assertSettlements(history, first.state, config);
    logger.info("smoke completo", { matchId: config.matchId, history: history.length });
  } finally {
    await Promise.allSettled([roomA?.leave(), roomB?.leave()]);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  void run().catch((error: unknown) => {
    logger.error("smoke fallido", {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
  });
}
```

- [x] **Step 5: Añadir el script y verificar local sin Docker**

En `package.json` añadir:

```json
"smoke:client": "tsx src/smoke/engine-smoke.ts"
```

Run:

```bash
npm run format
npm run typecheck
npx vitest run src/smoke/engine-smoke.test.ts src/env.test.ts
npm run lint
```

Expected: todos código 0.

Run: `npm run smoke:client`

Expected: código distinto de cero y mensaje `el smoke requiere RUN_ENGINE_SMOKE=1`; no intenta red.

- [x] **Step 6: Registrar continuidad y commit**

Actualizar `AGENTS.md` con `Tarea 3 completa`, baseline y `siguiente: Task 4, Step 1`; marcar Task 3 completa y reindexar en modo `fast`.

```bash
git add src/smoke src/env.ts src/env.test.ts .env.example package.json AGENTS.md docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md
git commit -m "test(smoke): juega el protocolo público hasta el veredicto" -m "El cliente usa únicamente SDK, HTTP interno y estado filtrado, por lo que puede certificar el artefacto sin importar el servidor. La flag exacta evita arrancar accidentalmente una prueba destructiva desde un entorno normal.\n\nCo-Authored-By: GPT-5 <noreply@anthropic.com>"
```

### Task 4: Levantar `dist/main.js` bajo PM2 y Nginx en Docker

**Files:**
- Create: `src/deploy-smoke.test.ts`
- Create: `compose.smoke.yaml`
- Create: `smoke/nginx.conf`
- Create: `scripts/run-engine-smoke.mjs`
- Modify: `Dockerfile`
- Modify: `package.json`
- Modify: `src/features/match/core/engine/round/player.ts`
- Modify: `src/features/match/core/engine/round/tests/player.test.ts`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md`

- [ ] **Step 1: Escribir el contrato de deploy rojo**

Crear `src/deploy-smoke.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("smoke del deploy", () => {
  it("mantiene la imagen normal y añade PM2 solo al target smoke", () => {
    const dockerfile = read("Dockerfile");
    expect(dockerfile).toContain("FROM runtime AS smoke-server");
    expect(dockerfile).toContain("pm2@7.0.4");
    expect(dockerfile).toContain('CMD ["node", "dist/main.js"]');
    expect(dockerfile).toContain('CMD ["pm2-runtime", "ecosystem.config.cjs"]');
  });

  it("rutea ambas instancias y conserva el upgrade websocket", () => {
    const nginx = read("smoke/nginx.conf");
    for (const port of [2567, 2568]) {
      expect(nginx).toContain(`location /${port}/`);
      expect(nginx).toContain(`proxy_pass http://domino:${port}`);
    }
    expect(nginx).toContain("proxy_set_header Upgrade $http_upgrade");
    expect(nginx).toContain("proxy_set_header Connection $connection_upgrade");
  });

  it("ejecuta dos procesos y un cliente con la flag en un compose aislado", () => {
    const compose = read("compose.smoke.yaml");
    expect(compose).toContain("PM2_INSTANCES: 2");
    expect(compose).toContain("SERVER_ADDRESS: nginx:8080");
    expect(compose).toContain("RUN_ENGINE_SMOKE: 1");
    expect(compose).toContain("target: smoke-server");
    expect(compose).toContain("target: smoke-client");
  });

  it("el wrapper exige flag y siempre declara la limpieza", () => {
    const runner = read("scripts/run-engine-smoke.mjs");
    const processEnv = ["process", "env"].join(".");
    expect(runner).toContain(`${processEnv}.RUN_ENGINE_SMOKE !== "1"`);
    expect(runner).toContain('"--exit-code-from", "smoke-client"');
    expect(runner).toContain('"down", "-v", "--remove-orphans"');
  });
});
```

- [ ] **Step 2: Ejecutar el rojo**

Run: `npx vitest run src/deploy-smoke.test.ts`

Expected: FAIL porque aún no existen Compose, Nginx, wrapper ni targets.

- [ ] **Step 3: Añadir targets sin engordar runtime**

Al final de `Dockerfile`, después del `CMD` normal, añadir:

```dockerfile

# Solo la certificación del deploy necesita PM2; la imagen normal conserva un único proceso.
FROM runtime AS smoke-server
RUN npm install --global pm2@7.0.4
COPY ecosystem.config.cjs ./
EXPOSE 2568
CMD ["pm2-runtime", "ecosystem.config.cjs"]

# El cliente necesita TypeScript y las devDependencies, ya presentes en build.
FROM build AS smoke-client
CMD ["npm", "run", "smoke:client"]
```

- [ ] **Step 4: Configurar Nginx por los paths anunciados**

Crear `smoke/nginx.conf`:

```nginx
map $http_upgrade $connection_upgrade {
  default upgrade;
  '' close;
}

server {
  listen 8080;

  location /2567/ {
    rewrite ^/2567/(.*)$ /$1 break;
    proxy_pass http://domino:2567;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $http_host;
  }

  location /2568/ {
    rewrite ^/2568/(.*)$ /$1 break;
    proxy_pass http://domino:2568;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $http_host;
  }

  location / {
    proxy_pass http://domino:2567;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $http_host;
  }
}
```

- [ ] **Step 5: Crear el Compose efímero**

Crear `compose.smoke.yaml`:

```yaml
name: domino-engine-smoke

services:
  redis:
    image: redis:7-alpine

  mongo:
    image: mongo:7

  domino:
    build:
      context: .
      target: smoke-server
    environment:
      NODE_ENV: production
      PORT: 2567
      PM2_INSTANCES: 2
      SERVER_ADDRESS: nginx:8080
      JWT_SECRET: smoke-jwt-secret-with-more-than-16-chars
      INTERNAL_API_KEY: smoke-internal-key-with-more-than-16-chars
      REDIS_URL: redis://redis:6379/1
      MONGO_URI: mongodb://mongo:27017/domino-smoke
      TURN_TIMEOUT_MS: 5000
      EXTRA_TIME_RESERVE_MS: 1000
      DEALING_TIMEOUT_MS: 5000
      PRESENTING_ROUND_MS: 20
      PRESENTING_MATCH_MS: 20
      SEATING_TIMEOUT_MS: 5000
      RECONNECTION_WINDOW_SECONDS: 5
    depends_on:
      - redis
      - mongo

  nginx:
    image: nginx:1.30.4-alpine3.24
    volumes:
      - ./smoke/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on:
      - domino

  smoke-client:
    build:
      context: .
      target: smoke-client
    environment:
      NODE_ENV: test
      JWT_SECRET: smoke-jwt-secret-with-more-than-16-chars
      INTERNAL_API_KEY: smoke-internal-key-with-more-than-16-chars
      RUN_ENGINE_SMOKE: 1
    depends_on:
      - nginx
```

No publicar puertos ni declarar volúmenes: el cliente vive en la misma red y `down -v` debe dejar cero estado reutilizable.

- [ ] **Step 6: Crear el wrapper portable y el script npm**

Crear `scripts/run-engine-smoke.mjs`:

```js
import { spawnSync } from "node:child_process";

if (process.env.RUN_ENGINE_SMOKE !== "1") {
  console.error("test:deploy requiere RUN_ENGINE_SMOKE=1");
  process.exit(1);
}

const compose = ["compose", "-f", "compose.smoke.yaml"];
const up = spawnSync(
  "docker",
  [...compose, "up", "--build", "--abort-on-container-exit", "--exit-code-from", "smoke-client"],
  { stdio: "inherit" },
);
const down = spawnSync("docker", [...compose, "down", "-v", "--remove-orphans"], {
  stdio: "inherit",
});

if (down.status !== 0) console.error("no se pudo limpiar el stack del smoke");
const upStatus = up.status ?? 1;
process.exit(upStatus === 0 && down.status !== 0 ? 1 : upStatus);
```

En `package.json` añadir:

```json
"test:deploy": "node scripts/run-engine-smoke.mjs"
```

- [ ] **Step 7: Verificar el contrato estático y el rechazo sin flag**

Run:

```bash
npm run format
npm run typecheck
npx vitest run src/deploy-smoke.test.ts src/entrypoint.test.ts
npm run lint
npm run build
npm run test:deploy
```

Expected: tests, lint y build código 0; el último comando código distinto de cero con `test:deploy requiere RUN_ENGINE_SMOKE=1` y sin crear contenedores.

- [ ] **Step 8: Medir y cerrar la visibilidad de una ficha robada**

El primer smoke real encontró un agujero anterior: hacer visible `hand.tiles` no vuelve visible
automáticamente una referencia `Tile` añadida después. Escribir primero un test en
`round/tests/player.test.ts` que espere `makePublic(drawn, { kind: "PLAYER", playerId })`, correrlo
y verlo fallar. Después, en `RoundPlayer.drawTile`, publicar al dueño la ficha recién movida:

```ts
this.visibility.makePublic(tile, { kind: "PLAYER", playerId: this.playerId });
```

Run: `npx vitest run src/features/match/core/engine/round/tests/player.test.ts`

Expected: rojo antes de la línea y verde después. El smoke Docker de abajo es la prueba de que el
adaptador `StateView` cumple esa llamada en el wire real.

- [ ] **Step 9: Ejecutar el smoke real**

PowerShell:

```powershell
$env:RUN_ENGINE_SMOKE='1'; npm run test:deploy; $code=$LASTEXITCODE; Remove-Item Env:RUN_ENGINE_SMOKE; exit $code
```

Expected: imágenes construidas, readiness 200 para `/2567/ready` y `/2568/ready`, partida en
`FINISHED` por `SCORE` y sin comandos ilegales, historial con `MATCH_RESOLVED`, `REWARD`/`REFUND`
válidos, `smoke-client` sale 0 y Compose elimina contenedores/red/volúmenes.

Si falla por una API real de PM2, Nginx o Colyseus distinta de la asumida, corregir primero el plan en un commit `docs:` separado, explicando el comportamiento medido, y recién después ajustar código/config.

- [ ] **Step 10: Registrar continuidad y commit**

Actualizar `AGENTS.md` con salida real del smoke, versión de Docker/PM2 observada, baseline y `siguiente: Task 5, Step 1`; marcar Task 4 completa.

```bash
git add Dockerfile compose.smoke.yaml smoke/nginx.conf scripts/run-engine-smoke.mjs package.json src/deploy-smoke.test.ts src/features/match/core/engine/round/player.ts src/features/match/core/engine/round/tests/player.test.ts AGENTS.md docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md
git commit -m "test(deploy): certifica PM2 y Nginx con una partida real" -m "Ejecuta el bundle que se despliega en dos procesos y sigue los publicAddress por el proxy. Los E2E embebidos no podían detectar un puerto anunciado al proceso equivocado ni un Dockerfile que arrancara otro archivo.\n\nCo-Authored-By: GPT-5 <noreply@anthropic.com>"
```

### Task 5: Hacer del smoke un gate anterior al artefacto

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `src/deploy-smoke.test.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md`

- [ ] **Step 1: Escribir el rojo del orden del CI**

Añadir a `src/deploy-smoke.test.ts`:

```ts
it("CI ejecuta el smoke después del build y antes de empaquetar", () => {
  const ci = read(".github/workflows/ci.yml");
  const build = ci.indexOf("name: Build");
  const smoke = ci.indexOf("name: Smoke Docker, PM2 y Nginx");
  const pack = ci.indexOf("name: Empaquetar el release");
  expect(build).toBeGreaterThan(-1);
  expect(smoke).toBeGreaterThan(build);
  expect(pack).toBeGreaterThan(smoke);
  expect(ci.slice(smoke, pack)).toContain("RUN_ENGINE_SMOKE: '1'");
  expect(ci.slice(smoke, pack)).toContain("npm run test:deploy");
});
```

- [ ] **Step 2: Ejecutar el rojo**

Run: `npx vitest run src/deploy-smoke.test.ts`

Expected: FAIL porque el workflow no contiene el paso smoke.

- [ ] **Step 3: Insertar el gate en CI**

En `.github/workflows/ci.yml`, inmediatamente después de `Build` y antes de empaquetar:

```yaml
      # Suite de integración separada: sí levanta Mongo/Redis porque además certifica el bundle,
      # PM2 y los paths de Nginx. No contradice que Vitest sea hermético.
      - name: Smoke Docker, PM2 y Nginx
        env:
          RUN_ENGINE_SMOKE: '1'
        run: npm run test:deploy
```

- [ ] **Step 4: Documentar ejecución y límite**

En `README.md` añadir una sección breve:

````markdown
## Smoke del deploy

El gate completo compila `dist/main.js` y juega una partida 2P contra dos procesos PM2 detrás de
Nginx, con Redis y Mongo efímeros:

```powershell
$env:RUN_ENGINE_SMOKE='1'; npm run test:deploy; Remove-Item Env:RUN_ENGINE_SMOKE
```

Sin la flag el comando se niega a correr. Esta prueba no llama wallets ni valida el Nginx de
producción; valida el contrato `/2567` y `/2568` que ese proxy debe implementar.
````

- [ ] **Step 5: Ejecutar todos los gates en el orden de deploy**

Run:

```bash
npm run format
npm run typecheck
npm test
npm run lint
npm run build
```

Expected: cinco comandos código 0.

PowerShell:

```powershell
$env:RUN_ENGINE_SMOKE='1'; npm run test:deploy; $code=$LASTEXITCODE; Remove-Item Env:RUN_ENGINE_SMOKE; exit $code
```

Expected: código 0 y stack eliminado.

- [ ] **Step 6: Auditar secretos, arquitectura y worktree**

Run:

```bash
npm run depcruise
git diff --check
git status --short
```

Expected: depcruise sin violaciones, `git diff --check` sin salida y status únicamente con archivos de esta tarea.

Comprobar además:

```bash
rg -n "userId|ucRate|profilePicture|currency|rateId|UcMinor" src
```

Expected: ningún `userId` vivo en auth/sala/registro; no aparece un `ucRate` copiado; `currency`, `rateId` y `UcMinor` solo están en contrato, snapshot, liquidación y pruebas correspondientes.

- [ ] **Step 7: Cerrar documentación y commit**

Actualizar `AGENTS.md` con:

```markdown
Estado: **incremento completo**. Tareas 0–5 cerradas. Registrar aquí los hashes reales de los
commits, el total real de tests, `npm run typecheck/test/lint/build/depcruise` y el resultado del
último smoke. Deuda deliberada: la entrega remota/outbox pertenece al futuro orquestador; el juego
solo exporta `settlementOf`. El Nginx entregado es de certificación, no infraestructura productiva.
```

Marcar Task 5 y todos sus pasos `[x]`; reindexar el repositorio en modo `fast`.

```bash
git add .github/workflows/ci.yml src/deploy-smoke.test.ts README.md AGENTS.md docs/superpowers/plans/2026-09-14-identidad-multiplataforma-y-smoke-pm2.md
git commit -m "ci(deploy): bloquea el release sin smoke real" -m "Coloca la partida Docker después de compilar y antes de crear el artefacto, de modo que una falla de PM2, proxy o engine nunca llegue al workflow de deploy.\n\nCo-Authored-By: GPT-5 <noreply@anthropic.com>"
```

Expected: `git status --short` vacío y `AGENTS.md` permite reanudar sin esta conversación.

## Criterio de cierre

El incremento se cierra únicamente si se cumplen juntos:

- `(platformId, userUuid)` autentica y localiza el asiento; UUID iguales entre plataformas no colisionan.
- El estado servidor conserva perfil/moneda, pero el wire solo entrega presentación e id opaco.
- `currency`, `rateId`, `entryFeeUcMinor` y `prizeUcMinor` no tienen ninguna ruta de mutación posterior a `configOf`.
- `settlementOf` devuelve la misma pareja y moneda para premio/reembolso, rechaza el ganador 2P ambiguo y rechaza el estado que no es de la mesa del snapshot.
- ⚠ **Deuda que este incremento NO cierra: el 4P.** `configOf` acepta cuatro participantes y
  `settlementOf` lanza contra cualquier final de mesa de cuatro, porque no existe la regla escrita
  de cómo se parte el premio entre compañeros. Hoy es inofensivo —nadie liquida—; el día que exista
  el orquestador, ese throw cae DESPUÉS del veredicto y esa mesa se queda sin premio (tiró) y sin
  reembolso (hubo desenlace): plata trabada. Abrir el 4P empieza por la regla del reparto, no por
  borrar la guarda. Está escrito también en `configOf` y en `network/settlement.ts`.
- `npm run typecheck`, suite, lint, build y depcruise pasan.
- `RUN_ENGINE_SMOKE=1 npm run test:deploy` termina una partida real y limpia el stack.
- CI ejecuta ese smoke antes de empaquetar.
- El plan y `AGENTS.md` contienen hashes, baseline y cualquier diferencia descubierta al medir APIs reales.
