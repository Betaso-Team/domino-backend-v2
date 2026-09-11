# AGENTS.md — domino-backend-v2

Backend de dominó multijugador sobre Colyseus 0.18. Es un **port de la arquitectura de
truco** (`truco-backend-v2`), no un rediseño: cuando algo no cierra, la respuesta suele
estar en cómo lo resolvió truco.

## El plan es la autoridad

`docs/superpowers/plans/2026-09-09-domino-v2-esqueleto-y-juego-2p.md` — 23 tareas, cada
una con sus Steps, su código y sus tests escritos. **No improvises el diseño**: el plan ya
decidió, y las decisiones están argumentadas en los comentarios del propio código.

Los otros dos documentos:

- `docs/superpowers/specs/2026-09-09-domino-v2-port-arquitectura-truco-design.md` — el
  porqué de cada decisión. Lo que el plan ejecuta, esto lo justifica.
- `docs/reglas-de-juego-v1.md` — las reglas del dominó **y** la anatomía del v1, con
  referencias a archivo:línea del backend viejo. Es la fuente cuando hay que saber qué
  hacía el sistema anterior.

**Estado: Tareas 0–9 hechas. La próxima es la 10.** Para confirmarlo, `git log --oneline`.

## Cómo se ejecuta una tarea

Usá la skill `executing-plans`. El orden de los Steps del plan no es decorativo: es TDD.
Escribir el test, **correrlo y verlo fallar**, recién ahí la implementación. Ver el rojo es
lo que prueba que el test mide algo.

## El gate es `typecheck`, no el verde de vitest

```bash
npm run typecheck   # tsc --noEmit  <- ESTE es el gate
npm test            # vitest run
npm run lint        # biome check src
npm run format      # biome format --write src
```

**Vitest transpila con esbuild, que borra los tipos sin chequearlos.** En la Tarea 9 los 6
tests del historial dieron verde con 7 errores de compilación abiertos. Si cerrás una
tarea mirando solo la suite, el error aparece dos tareas después atribuido a otra cosa.

`npm run lint` falla por formato. Corré `npm run format` antes de commitear o el commit
queda con el lint rojo.

Antes de cerrar cualquier tarea: `npm run typecheck && npm test && npm run lint`.

## El plan tiene defectos. Corregilos y documentalos

Ya aparecieron tres, y **dos son el mismo patrón**: los tests del plan están escritos
contra el vocabulario FINAL del juego, no contra el de su propia tarea.

| Tarea | Defecto | Commit |
|---|---|---|
| 7 | `MatchDriver.advance` con un parámetro contra una interfaz que pide dos | `e2d981f` |
| 8 | El test del decoder contradecía al `.strict()` de su propio `payloads.ts` | `cf2e9b9` |
| 9 | Tests del historial usando `PLAY_TILE`/`PASS`, verbos que llegan en la Tarea 19 | dentro de la Tarea 9 |

Esperá encontrarlo otra vez. El catálogo de verbos **crece de a uno** (`CommandPayloads`
en `src/features/match/core/command.ts`): hoy solo existe `ABANDON`. Si un test del plan
nombra un verbo que todavía no está, reescribilo con el vocabulario de la altura — no
adelantes el catálogo para que el test compile.

**La convención**: corregís, y el parche al archivo del plan va en un commit aparte
`docs:` que explica qué estaba mal y cómo se descubrió. El plan es un documento vivo; si
lo dejás mentir, la próxima tarea arranca del mismo pozo.

## Las cuatro reglas de imports

Las aplica `.dependency-cruiser.cjs` y las testea `src/architecture.test.ts`. No son
guía de estilo: el test se pone rojo.

1. **core-allowlist** — `features/X/core/` solo importa de `features/X/core/` y de
   `shared/`. Es allowlist. Lo de afuera (`network/`, `transports/`) sí puede importar
   `core/`; la restricción es solo saliente.
2. **core-no-runtime** — el core no importa paquetes de runtime. Excepción única:
   `@colyseus/schema`, porque el estado ES el Schema.
3. **tsyringe-only-in-roots** — solo en `src/di-container.ts`,
   `.../colyseus/domino-room.ts` y `.../colyseus/commands/di-wiring.ts`. Esos tres nombres
   están escritos en el config; los archivos llegan en las Tareas 10–12.
4. **feature-boundary** — una feature importa de otra solo vía su `index.ts`.

Más `no-circular`, que no es regla de imports sino invariante del grafo.

## Doctrinas que vuelven en cada tarea

- **Sin campos derivados, con un criterio escrito.** Si se calcula de otro dato, es
  consulta pura del módulo dueño. Se guarda SOLO cuando el cliente no puede derivarlo:
  porque su fuente está gateada (`Hand.tileCount`, `BoneyardState.count`) o porque
  derivarlo exigiría reimplementar una regla (`Hand.isRevealed`). El caso canónico del
  criterio es `PlacedTile`, que **no** lleva `lockedNumber` — ver el comentario en
  `src/features/match/core/state/tile.ts`.
- **Ramas nulas.** Un nodo ausente codifica un caso; presente-y-vacío codifica otro
  distinto. `RoundState.boneyard` ausente = este modo no tiene pozo (4P); presente y vacío
  diría "pozo agotado", que es justo donde la tranca se calcula distinto.
- **Schema ancho, uniones angostas.** Colyseus no sincroniza uniones discriminadas, así
  que `phase`/`side`/`reason` son `t.string()` en el árbol. El cast vive en UN archivo,
  `core/engine/state-projections.ts` (`sideOf`, `roundPhaseOf`, `matchPhaseOf`), y de ahí
  para adentro el motor compara contra uniones cerradas.
- **Un evento existe ⟺ no hubo comando detrás.** Si el payload del evento solo repetiría
  el del comando, no es un evento. Por eso `ABANDON` aparece como evento (el retiro por
  timeout, que nadie pidió) y no como eco del verbo voluntario.
- **Los comandos se tipan contra interfaces, no contra clases concretas.** Un comando
  tipado contra `MatchDriver` puede alcanzar miembros que la interfaz `Driver` no expone;
  tipado contra la interfaz no puede, por construcción.
- **Plata de por medio.** Es un juego con dinero real. Un caso no cubierto no es un bug de
  estilo: es plata que sale. Cuando dudes entre rechazar y ignorar en silencio, rechazá.

## Commits

En español, imperativo, con el tipo convencional (`feat`/`fix`/`test`/`docs`/`refactor`) y
alcance. El cuerpo explica **por qué**, y sobre todo **qué se rompe si se hace al revés** —
mirá `git log` para el tono. Terminan con:

```
Co-Authored-By: <tu modelo> <noreply@anthropic.com>
```

Un commit por tarea del plan, más los `docs:` de los defectos que encuentres.

## Herramientas

`codebase-memory-mcp` está configurado: usá `search_graph` / `trace_path` /
`get_code_snippet` antes que grep para descubrir código. Reindexá con
`index_repository` después de agregar archivos.
