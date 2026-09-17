import "reflect-metadata";
import { type MatchMakerDriver, type Presence, RedisDriver, RedisPresence } from "colyseus";
import { container } from "tsyringe";
import { env } from "./env.js";
import { JwtVerifier } from "./features/auth/index.js";
import {
  type GameModeReader,
  GameModeService,
  MemoryGameModeRepository,
  MongoGameModeRepository,
} from "./features/game-mode/index.js";
import { LobbySettings } from "./features/lobby/settings.js";
import { type GlobalDominoConfig, globalConfigWith } from "./features/match/core/config.js";
import type { Clock } from "./features/match/core/engine/clock.js";
import type { HistoryPort, HistoryReader } from "./features/match/network/history.js";
import { MemoryHistory } from "./features/match/network/transports/memory-history.js";
import { MongoHistory } from "./features/match/network/transports/mongo-history.js";
import { MatchRegistry } from "./features/match/transports/match-registry.js";
import { type Logger, logger } from "./logger.js";
import { type KeyValueStore, MemoryKeyValueStore } from "./shared/kv.js";
import { type Lease, MemoryLease, MongoLease } from "./shared/mongo-lease.js";
import { Mongo } from "./shared/mongo.js";

// Acá viven solo dependencias globales y sin estado de partida. Los actores del motor
// se arman dentro de cada sala porque pertenecen a una partida concreta.
export const rootContainer = container;

rootContainer.register<GlobalDominoConfig>("GlobalDominoConfig", {
  useValue: globalConfigWith({
    turnTimeoutMs: env.turnTimeoutMs,
    extraTimeReserveMs: env.extraTimeReserveMs,
    dealingTimeoutMs: env.dealingTimeoutMs,
    presentingRoundMs: env.presentingRoundMs,
    presentingMatchMs: env.presentingMatchMs,
    seatingTimeoutMs: env.seatingTimeoutMs,
    reconnectionWindowSeconds: env.reconnectionWindowSeconds,
  }),
});
const clock: Clock = { now: () => Date.now() };
rootContainer.register<Clock>("Clock", { useValue: clock });
rootContainer.register<Logger>("Logger", { useValue: logger });
rootContainer.register("TokenVerifier", { useValue: new JwtVerifier(env.jwtSecret) });

// EL PRESENCE Y EL DRIVER DE COLYSEUS, que son infraestructura del SERVIDOR y no de una feature:
// Colyseus escribe ahí su registro de salas en cada creación y en cada reserva de asiento, y por
// eso los arma el composition root y `src/app.config.ts` se los entrega al servidor.
//
//   · el DRIVER es el registro de salas del clúster. Sin él cada proceso solo ve las suyas, y
//     `joinById` contra una sala de otro nodo no encuentra nada.
//   · el PRESENCE es cómo los procesos se enteran unos de otros: de ahí sale la lista que lee el
//     balanceador (`matchMaker.stats.fetchAll()`) y por ahí viaja el pedido de abrir una sala en
//     otro proceso.
//
// LA PRESENCIA DE LA URL ES LA QUE ELIGE, igual que con Mongo. Sin `REDIS_URL` quedan `undefined`
// y Colyseus usa los suyos, que son los LOCALES —`matchMaker.setup()` cae en `getDefaultDriver()`
// y `getDefaultPresence()`, `@colyseus/core/build/utils/Env.mjs`—: exactamente lo correcto con
// una instancia sola, y lo que hace que ni el servidor ni la suite necesiten un Redis andando.
// No hay ningún `CLUSTER_DRIVER`: `src/di-container.test.ts` se pone rojo si aparece.
//
// Se EXPORTAN en vez de registrarse contra un token, por el mismo motivo que `mongo` de más
// abajo: no son colaboradores que alguien resuelva, son piezas del proceso que el otro
// composition root necesita nombrar.
export const presence: Presence | undefined = env.redisUrl
  ? new RedisPresence(env.redisUrl)
  : undefined;
export const driver: MatchMakerDriver | undefined = env.redisUrl
  ? new RedisDriver(env.redisUrl)
  : undefined;

// EL ALMACÉN COMPARTIDO ES EL MISMO `presence`, y encaja POR ESTRUCTURA: `KeyValueStore` está
// copiado de la interfaz `Presence`, así que no hay una clase en el medio traduciendo
// (ver `src/shared/kv.ts`). Por eso la variable se NOMBRA `Presence` y no `RedisPresence`: la
// clase concreta declara `get(): Promise<unknown>` y no sería asignable; la interfaz declara
// `get(): any` y sí. Verificado con `tsc --noEmit` sobre las dos formas.
//
// Sin Redis queda el de memoria, que NO es un doble: es la implementación del proceso único,
// igual que `MemoryHistory` más abajo.
const store: KeyValueStore = presence ?? new MemoryKeyValueStore();

rootContainer.register(LobbySettings, { useValue: new LobbySettings(store) });

// EL REGISTRO DE PARTIDAS VIVAS, que ya no es del proceso sino del CLÚSTER: sus dos respuestas
// —el config público del endpoint HTTP y en qué sala está sentado un jugador— salen del almacén
// compartido y no de un `Map` local. Sobrevive a las salas sin convertir a la sala en dueña de
// esa infraestructura, igual que el historial.
rootContainer.register(MatchRegistry, { useValue: new MatchRegistry(store) });

// LA PRESENCIA DE LA URI ES LA QUE ELIGE, y no hay un `HISTORY_DRIVER` ni lo va a haber:
// un interruptor que NOMBRA la implementación es deuda, no configuración —deja escribir
// "mongo" sin URI y "memory" con una base andando al lado—, y truco ya borró el suyo por
// esa razón. Acá el dato y la decisión son lo mismo, así que la combinación incoherente no
// se puede escribir. Es el mismo fail-closed que la API interna usa con `INTERNAL_API_KEY`:
// la variable ausente es una decisión, no un error.
//
// Sin `MONGO_URI` queda `MemoryHistory`, que NO es un doble: es la implementación de
// producción de una instancia que elige no persistir —y la que usa la suite entera, que por
// eso no depende de ningún servicio externo—. Lo que pierde está escrito en `.env.example`:
// tope de 200 partidas y muerte en cada reinicio, o sea una consola de soporte que solo ve
// lo que pasó desde el último deploy.
//
// `mongo` se exporta porque el CLI de replay —un proceso corto, no el servidor— tiene que
// poder CERRAR la conexión: el cliente de Mongo mantiene vivo el event loop, así que sin
// esto `npm run replay` imprime el estado final y se queda colgado para siempre.
export const mongo = env.mongoUri ? new Mongo(env.mongoUri) : undefined;

// UNA instancia detrás de DOS tokens: escritura (`HistoryPort`, el camino caliente de la
// sala) y lectura (`HistoryReader`, el endpoint interno y el CLI de replay). Los tokens
// siguen separados aunque hoy los dos resuelvan al mismo objeto, y esa anticipación ya se
// cobró: el `of` de la lectura cambió de forma —pasó a prometer— y el `record` de la
// escritura no, exactamente como el comentario de `history.ts` había previsto. Los dos
// `register` van TIPADOS: sin el parámetro de tipo, tsyringe acepta cualquier valor contra
// el token y el error aparece recién en el `resolve`, es decir en runtime.
const history = mongo ? new MongoHistory(mongo, logger) : new MemoryHistory();
rootContainer.register<HistoryPort>("HistoryPort", { useValue: history });
rootContainer.register<HistoryReader>("HistoryReader", { useValue: history });

// EL CATÁLOGO DE MODOS, que desde la Tarea 10 es la AUTORIDAD sobre la economía de una mesa: la
// sala resuelve acá el modo que el request nombró y de él salen `pointsToWin`, `entryFee` y
// `prize`. Sin este registro ninguna sala puede nacer, así que el token no es opcional.
//
// LA PRESENCIA DE `MONGO_URI` ELIGE LAS DOS PIEZAS A LA VEZ —repositorio y lease— y no una por
// una, porque son la MISMA base: un catálogo en Mongo con un lease de memoria no excluiría a la
// otra instancia, que es lo único que ese lease hace. Se reutiliza la instancia `Mongo` de arriba:
// son colecciones distintas del mismo cliente, y abrir un segundo cliente sería un pool de
// conexiones que nadie cierra.
const gameModeRepository = mongo
  ? new MongoGameModeRepository(mongo, clock)
  : new MemoryGameModeRepository(clock);
const catalogLease: Lease = mongo ? new MongoLease(mongo, clock) : new MemoryLease();

// Se registra SOLO el puerto de LECTURA aunque el adaptador sepa escribir: quien crea y edita es
// la API administrativa del catálogo, que recibe su propio servicio. Un token de escritura acá
// sería una puerta que la sala podría abrir sin querer.
//
// `gameModes` se exporta porque el que siembra el modo de la suite es un módulo de test: un
// catálogo vacío no puede sentar ninguna mesa, y resolver el token para castearlo a repositorio
// sería peor.
export const gameModes = gameModeRepository;
rootContainer.register<GameModeReader>("GameModeReader", { useValue: gameModeRepository });
rootContainer.register(GameModeService, {
  useValue: new GameModeService(gameModeRepository, catalogLease),
});

// CERRAR LO QUE ESTE ARCHIVO ABRIÓ, que es la deuda que el incremento del clúster dejó
// anotada: nadie cerraba nada y `SIGTERM` cortaba en seco. Lo llama el apagado ordenado
// (`src/main.ts`) DESPUÉS de que las salas se disponen, y ese orden es el contrato entero.
//
// EL ORDEN DE ADENTRO:
//
//   1. DRENAR EL HISTORIAL. `record` es `void` por contrato y NO reintenta, así que un lote
//      que todavía está viajando cuando se cierra la conexión se pierde para siempre — y el
//      último lote de una partida es el que lleva su desenlace. Con `MemoryHistory` no hay
//      nada que esperar y esto resuelve de una.
//   2. CERRAR MONGO, y recién ahí. Al revés se pierde exactamente lo que el paso 1 esperó.
//
// LO QUE NO ESTÁ ACÁ ES REDIS, y la ausencia es una MEDICIÓN, no un olvido: `presence` y
// `driver` los cierra el propio Colyseus adentro de `server.gracefullyShutdown()`
// (`@colyseus/core/build/Server.mjs`: `this.presence?.shutdown()` y `await
// this.driver?.shutdown()`, justo después de disponer las salas). Cerrarlos también acá los
// cerraría DOS veces, y un `quit()` de ioredis sobre una conexión ya cerrada rechaza — o sea
// que el precio de la redundancia sería una promesa rechazada en cada apagado, que es ruido
// en el único log que alguien mira cuando un deploy sale mal.
//
// Nadie más que el entrypoint puede llamar a esto: una sala que cierre Mongo se lleva puesto
// el historial de las otras cuarenta que siguen jugando.
export async function shutdown(): Promise<void> {
  await history.drain();
  // MONGO ÚLTIMO: el paso de arriba escribe ahí. Al revés se pierde exactamente lo que se acaba de
  // esperar.
  await mongo?.close();
}
