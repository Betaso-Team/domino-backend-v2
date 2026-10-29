# Acoplamiento con Betaso

El dominó es una pieza de la plataforma de juegos que se ofrece a varios clientes (Betaso, Parley…).
Su único interlocutor debería ser el orquestador. Esta página lista cada punto donde todavía depende
del backend principal de Betaso, de sus datos o de sus reglas. Solo describe el estado actual; la
solución de cada punto todavía no está decidida.

Inventario del 2026-10-13. Las rutas son relativas a la raíz del repo; los números de línea son
orientativos.

**Cómo se lee un nombre.** «Betaso Games» (`betaso_games`, `BETASO_GAMES_*`) es la marca del sistema
de tercerización, y llevarla no es acoplamiento. «Betaso» a secas es el cliente Betaso. Un nombre del
sistema que dice solo «Betaso» se lee como el cliente, y por eso figura en esta lista.

## Lo que ya no depende de Betaso

Sirve de referencia para medir lo que falta:

- **Identidad.** `features/auth/transports/jwt-verifier.ts` acepta solo tokens ES256 de billing-auth
  (`BILLING_AUTH_PUBLIC_KEY`, `game: "domino"`, `sub` como id). No hay secreto HS256 de Betaso.
- **Datos del jugador.** Nombre, usuario y foto llegan del orquestador en el `CreateMatchRequest`
  (`features/match/transports/match-contract.ts`). El dominó no consulta perfiles.
- **Dinero.** La entrada y los aumentos se le piden al orquestador
  (`features/match/network/transports/http-orchestrator.ts`). El dominó no tiene credenciales de
  ninguna billetera.
- **Resultados.** Salen por outbox a RabbitMQ (`features/match/network/match-results.ts`) y los consume
  el orquestador.
- **Niveles de aumento.** Son parte del modo de juego y viajan en el pedido de mesa; no se leen de
  Betaso.
- **Llamadas HTTP.** Las únicas salientes van al orquestador; no hay `BETASO_BACKEND_URL`.

## 1. Dependencias en tiempo de ejecución

### ~~El catálogo se publica al exchange `betaso`~~

Resuelto el 2026-10-28: **el dominó ya no publica nada al exchange `betaso`** ni se conecta al broker
de Betaso. El outbox del catálogo, su despachador, `POST /game-modes/sync`, `events.ts` y
`RABBITMQ_URL` se eliminaron.

Betaso lee los modos de dominó **del orquestador**, como cualquier proveedor:
`GET {ORCHESTRATOR_BASE_URL}/v1/game-modes?includeInactive=1` con su API key de proveedor. El
orquestador arma el catálogo efectivo de cada proveedor con `GET /internal/game-modes` del dominó
(modos con dueño y suscriptores, más la fuente `shared`/`own` de cada proveedor). Betaso conserva su
forma propia (`externalId` = `uuid` del modo, `game: "domino"`, `prize`, `entryFee`, `multiplier`,
`pointsToWin`, `playerCount`) mapeándola de su lado, y las bajas le llegan con `includeInactive=1`.

~~- `src/features/game-mode/events.ts:5`: `GAME_MODE_EXCHANGE = "betaso"`, con las claves
  `game_mode.created` y `game_mode.updated`.~~
~~- Desde los modos con dueño (2026-10-27) sólo salían los modos compartidos; se iba a eliminar cuando
  Betaso-Backend leyera el catálogo del orquestador.~~

⚠ Orden de despliegue: Betaso-Backend tiene que leer dominó del orquestador ANTES de que esta versión
llegue al entorno; si no, su registro de modos se queda sin dominó. La colección `game_mode_outbox`
queda huérfana en las bases que la tenían.

### ~~Producción no arranca sin el broker de Betaso~~

- ~~`src/env.ts`: con `NODE_ENV=production`, `RABBITMQ_URL` es obligatoria junto a `MONGO_URI` y
  `ADMIN_API_KEY`.~~ Resuelto: `RABBITMQ_URL` ya no se lee; en producción se exigen `MONGO_URI` y
  `ADMIN_API_KEY`. Una `RABBITMQ_URL` que quede en un `.env` se ignora (quitarla al desplegar).
- ~~`/ready` incluye el chequeo `rabbit`.~~ Resuelto: `/ready` sólo consulta el broker de juegos
  (`betaso_games`).

### Las colecciones de Mongo son las de v1

- `src/features/game-mode/transports/mongo-repository.ts:22`: `GAME_MODE_COLLECTION =
  "game_modes_domino"`, el nombre que declaró v1. Otro nombre daría un catálogo vacío.
- `src/di-container.ts:301-308`: los ajustes se leen de `domino_settings`, también de v1.
- Juntas suponen que v2 corre sobre la base de datos del dominó v1 de Betaso.
- **Decidido el 2026-10-14: el catálogo de modos y los ajustes viven en el dominó.** El dominó es
  dueño de los dos: los guarda, los modifica y los sirve; ni el orquestador ni un cliente los
  administran. Lo que queda abierto de este punto es solo el nombre heredado de las colecciones, que
  importa el día que el dominó tenga su propia base y no la del dominó v1.

### Torneos: escritos contra Betaso, todavía sin cablear

Nada fuera de `src/features/tournament/` lo importa, pero si se cablea tal como está, depende de
Betaso en cuatro puntos:

- `transports/http-client.ts:21`: llama a `championship/championships` del backend de Betaso con
  `betasoBackendAuthHeaders`. En `/is-enrolled` reenvía el Bearer del jugador.
- `watcher.ts:15`: publica `tournament.games-check` al exchange `betaso`. Lo consume
  `betaso-backend/src/modules/tournaments/rabbitmq/tournament-queue-consumer.ts`.
- `transports/amqp-participation.ts:7-8`: publica a la cola `tournaments_queue` con el patrón
  `tournament.save-participation`, del `main.ts` de Betaso-Backend.
- `src/features/auth/api-key.ts:20`: `betasoBackendAuthHeaders`, los headers que el backend de Betaso
  exige en sus rutas internas. Se re-exporta desde `features/auth/index.ts`.
- `transports/http-client.ts` traduce campos de los campeonatos de Betaso: `status`,
  `gameConfig.modality` (`"1vs1"`/`"2vs2"`) y `scoringConfig.pointsPerLoss`.

## 2. Contratos con la forma de Betaso

### La API admin del catálogo copia el panel de Betaso v1

- `src/features/game-mode/transports/http/schemas.ts`: el DTO expone `_id` y `__v` de Mongo porque el
  panel los parsea.
- `src/features/game-mode/transports/http/responses.ts`: el envoltorio `{ status, data }` /
  `{ status, message }` y los mensajes literales de v1, por ejemplo `"Modo de juego no encontrado"`.
- El nombre del header `x-internal-api-key` (`src/shared/http/api-key.ts:18`) se eligió porque es el
  que exige Betaso y el que su panel ya manda. El orquestador usa el mismo.

### Unidades y conceptos de dinero de Betaso

- **UC.** Es la unidad interna de Betaso y la que usa el dominó para la entrada, el premio, los
  aumentos y el reparto:
  - `src/features/game-mode/core/game-mode.ts`
  - `src/features/match/core/config.ts`
  - `src/features/match/network/payout.ts`
  - el campo `amountUc` del resultado (`match-results.ts`)
- **`rateId`.** El contrato lo trata como opaco, pero los comentarios y los tests lo explican como el
  `_id` de Mongo del documento de tasas de Betaso (`match-contract.ts`, `match-contract.test.ts:186`,
  `docs/api-y-mensajes.md`).

### Campos del modo que son del ranking de Betaso

`src/features/game-mode/core/game-mode.ts` tiene cuatro campos que vienen del ranking y la liga de
Betaso:

- `multiplier`: el peso del modo en el ranking.
- `betLevels[].additionalPoints`: los puntos de ranking de cada aumento.
- `isFreeRoom` y `enableBots`: los dos vienen del modelo de v1.

### El panel de admin

El admin inicia sesión en billing-auth, que le emite un token ES256 con audiencia
`betaso-games-admin`. Las rutas de admin del dominó lo aceptan como `Bearer`, verificado con la misma
clave pública de billing-auth (`admin-token-verifier.ts`): no se le pregunta a Betaso quién es un
administrador. Truco, en cambio, sigue validando contra `GET auth/me` de Betaso.

Desde el 2026-10-27 el token dice además de qué proveedor es el admin (`prv`) y con qué rol (`role`), y
el dominó acota cada ruta (`docs/api-y-mensajes.md`, «HTTP interno»). Betaso es un proveedor más: un
admin de Betaso entra al catálogo con su ámbito y a nada más.

**Decidido el 2026-10-14:** no se porta. El panel será uno propio de Betaso Games, con login del
sistema, y no es del MVP. Mientras tanto el catálogo y los ajustes se administran con `ADMIN_API_KEY`
desde un cliente HTTP.

## 3. Reglas de negocio copiadas de Betaso v1

- **Niveles de aumento.** El `extra` tiene que crecer con el nivel: es la regla de
  `bet-increase/lib/monotonic.ts` de Betaso (`game-mode/transports/http/schemas.ts:38`).
- **Tiempos.** Los límites de los timeouts son los de `Betaso-Domino-Backend`
  (`src/features/match/config-schema.ts:18`): turno de 15 a 300 s y reserva de 10 a 120 s.
- **Mesa gratis.** No ofrece aumentar, por `isFreeRoom`, igual que en v1.
- **Mesa de 4.** La mitad del reparto se queda en la casa (`match-contract.ts:213`).
- **Torneos** (sin cablear). `pointsToWinBySeats` y la escala antifraude están en
  `features/tournament/config.ts`.

## 4. Nombres, datos fijos y documentación

Ninguno de estos puntos cambia el comportamiento, pero todos usan el nombre del cliente donde va la
marca del sistema, o atan el servicio a Betaso de otra forma. Los nombres del broker de resultados
(`BETASO_GAMES_RABBITMQ_URL`, `betasoGamesAmqp` y el exchange `betaso_games`) llevan la marca y no
figuran aquí.

- **Paquete.** `package.json`: `"@betaso/domino-backend"`, «Backend del Dominó Betaso».
- **Dominios y rutas.**
  - `.env.example:154`: `SERVER_ADDRESS=domino.betaso.com`.
  - `scripts/deploy/lib/deploy-common.sh:10` y `.github/workflows/ci-cd.yml`:
    `/var/www/Betaso/domino-backend-v2`.
  - `docs/operacion.md`: dominios `*.elbetaso.com`.
  - `docs/.vitepress/config.ts`: título «Dominó Betaso».
- **Monedas en fixtures.** `"VES"` y `"USD"` en los fixtures y smoke tests. El motor trata la moneda
  como texto opaco.
- **Exchange `betaso` en pruebas.** ~~Aparece en los smoke tests y en los tests de amqp, outbox y
  torneo.~~ Sólo queda en los tests de torneo (sin cablear).
- **Comentarios.** Unos veinte citan `Betaso-Domino-Backend/src/...` como fuente de verdad.
  `features/match/transports/match-registry.ts:34` supone que el id de usuario es compartido entre
  los productos de Betaso.
- **Comentario obsoleto.** `match-contract.ts:258` menciona `BETASO_BACKEND_URL`, que ya no existe.
- **Docs.**
  - ~~`.env.example` describe `RABBITMQ_URL` como «el del exchange `betaso` de Betaso».~~ Ya no está.
  - `AGENTS.md` lista las deudas con Betaso: ~~el exchange `betaso`~~, la migración de
    `bet_increase_configs` y el login del panel.
  - `README.md`, `docs/index.md`, `docs/arquitectura.md`, `docs/api-y-mensajes.md` y
    `docs/reglas-de-juego-v1.md` presentan el servicio como «Dominó Betaso».
