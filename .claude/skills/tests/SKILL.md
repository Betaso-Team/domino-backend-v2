---
name: tests
description: Cómo se escriben y dónde van los tests de domino-backend-v2. Usar SIEMPRE antes de crear un archivo *.test.ts, antes de mover o renombrar uno, antes de agregar andamiaje compartido (fixtures, harness, builders) y antes de crear o mudar un doble de un puerto. También para decidir el nivel de un test (unit / int / e2e) o para diagnosticar por qué la suite tarda.
---

# Los tests de domino-backend-v2

Portada de la skill de truco y adaptada a lo que este repo decidió distinto. El porqué largo está en
`AGENTS.md` (bloques «censo del lobby y alcance explícito de tests» e «integración con el front»).

## 1. Antes de escribir: elegí el nivel

```
¿Necesita un MatchState armado por el motor, una base, o el servidor?
│
├── NO  ─────────────────────────►  archivo.test.ts        (unit)
│                                    objetos planos; reglas y derivaciones
│
├── El motor compuesto, un         ►  archivo.int.test.ts   (int)
│   servidor HTTP de verdad, o        varias piezas juntas; un adaptador contra su base
│   Mongo real (MONGO_INT_URI)
│
└── La app entera + clientes       ►  archivo.e2e.test.ts   (e2e)
                                      SOLO el cableado
```

**La regla de oro del e2e:** si el `expect` se puede escribir sin mencionar un cliente, un mensaje o
un timer real, **el test es del motor**. Un e2e que afirma cuántos pips vale una tranca está pagando
un socket para reprobar aritmética.

Lo que **sólo** un e2e puede probar:

- que el mensaje llega y el estado le sincroniza **al cliente correcto** (la mano tapada para el otro)
- que el error vuelve por el canal `illegal` con su `code`
- que el **timer real de la sala** vence — los tests del motor llaman a `fireTimeout()` a mano
- que el evento se difunde (o que **no**: los movimientos de plata)
- la admisión, la autorización y el reparto de asientos, que viven en la puerta

⚠ **LA MESA NACE TAPADA.** Toda mesa arranca con la ventana de reparto abierta, y **irse con la
ventana abierta ANULA la partida** (no da forfeit). Un e2e que quiera un veredicto por abandono tiene
que llamar `revealHands(match)` ANTES del `ABANDON`; si no, el test pasa por `PRESENTING_ABORT`, no
resuelve nada y puede quedar verde sin medir lo que dice.

## 2. Dónde va el archivo

**Manda el sujeto, no el conteo:**

| el sujeto del test es… | va en |
|---|---|
| **un archivo** (`legality.ts`) | al lado, `legality.test.ts` |
| **una carpeta** (cruza varios de sus archivos) | el `tests/` de esa carpeta |
| **una feature entera** | `features/<feature>/tests/` |
| **la app ensamblada** (cruza features, o prueba el composition root) | `src/tests/` |
| **un script de `scripts/`** | al lado, `scripts/<script>.int.test.ts` |

`feature-boundary` vale también para los tests: un test de una feature no importa el andamiaje de
`tests/` de OTRA. Lo que comparten dos features sube a `src/tests/`.

## 3. El andamiaje que ya existe — usalo, no lo copies

Dentro de un `tests/`, **un archivo sin `.test.ts` es andamiaje**.

```
src/tests/e2e.ts                       bootTestServer(port) · mintToken · joinAs · casualTable · waitUntil
src/tests/fake-orchestrator.ts         FakeOrchestratorCharges: cobros de entrada y de aumento
src/tests/game-mode-catalog.ts         siembra los modos de la suite: CASUAL_2P · CASUAL_4P · FREE_2P
src/tests/int-services.ts              MONGO_INT_URI — el único lector de entorno de la suite
src/tests/routes.ts                    routesOf(router): el orden real de las rutas
shared/tests/memory-logger.ts          MemoryLogger, para asertar sobre lo que se registró

features/match/tests/e2e-harness.ts    bootServer · seatPair · seatFour ·
                                       revealHands · act · playUntilDecided · historyOf · linesOf ·
                                       playerIdOf · clientOf · writeGolden
core/engine/tests/build-engine.ts      engineWithHands(manos, pozo, opciones) — el motor entero
core/engine/tests/match-config-fixture.ts  matchConfig · matchSeat
core/engine/round/tests/round-fixture.ts   roundState(setup) — la ronda suelta
core/rules/tests/fixture.ts            viewOf · rulesConfig — la partida en objetos PLANOS
tournament/tests/fake-client.ts        FakeTournamentClient (la feature está sin cablear)
game-mode/transports/tests/*-contract.ts   el contrato compartido de los dos adaptadores
```

**Si vas a copiar algo de otro test, no lo copies: subilo** al mínimo ancestro común de los que lo
usan. `shared/` es sólo para lo portable; nada que sepa de dominó.

Los archivos se nombran **por lo que guardan**, nunca por su papel (`helpers.ts`).

## 4. Los dobles y los adaptadores de memoria

⚠ **Acá es distinto de truco.** Los `Memory*` (`MemoryHistory`, `MemorySettings`,
`MemoryGameModeRepository`, `MemoryKeyValueStore`…) **no son dobles**: son el adaptador real del
despliegue que eligió no tener Mongo/Redis, los registra `di-container.ts` y viven en `transports/`
o en `shared/`. No hay `fake-backend`: `vitest.setup.ts` BORRA `MONGO_URI`, `REDIS_URL` y
`RABBITMQ_URL`, así que el container ya arma lo de memoria.

Los dobles de verdad (`FakeTournamentClient`, `MemoryLogger`) van en un `tests/`, y
**nunca** salen por un `index.ts`. Gatillo mecánico: si ningún archivo fuera de un `tests/` lo
importa, es un doble.

## 5. Correr

```bash
npm run typecheck    # EL GATE. vitest transpila con esbuild y NO chequea tipos
npm run test:unit    # sin servicios, sin aislamiento de módulos
npm run test:int     # motor compuesto, HTTP real, Mongo con MONGO_INT_URI, scripts/ en Linux
npm run test:e2e     # la app entera
npm test             # los tres, en orden, que es lo que corre CI
npm run lint         # biome; `npm run format` antes de commitear
```

Los proyectos los define `vitest.config.ts`. unit e int corren con `isolate=false`, así que **un test
que deja estado global** —un mock sin restaurar, timers falsos prendidos— **contamina al archivo
siguiente**: se arregla ese test, no se vuelve a aislar. `minWorkers` tiene que ser igual a
`maxWorkers` (un pool que se achica mata hilos a mitad de corrida).

`scripts/deploy-remote.int.test.ts` se **saltea fuera de Linux** (el script lee `/proc`). Para
correrlo en Windows: un contenedor `node:22-bookworm` con una copia del repo sin `node_modules`.

## 6. Antes de dar por terminado

- `npm run typecheck && npm test && npm run lint` en verde.
- **Viste el rojo.** Un test que nunca falló no prueba nada; para tests sobre código existente,
  mutá la línea que dice medir y mirá que se ponga rojo SÓLO ese.
- Un test nuevo con sufijo `.int`/`.e2e` tiene que aparecer en su tramo.
- Si escribiste un e2e: releé la regla de oro de §1 y sacale todo `expect` que no mencione la
  frontera.
