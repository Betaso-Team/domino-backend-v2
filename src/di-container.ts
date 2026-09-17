import "reflect-metadata";
import { JwtVerifier } from "@/features/auth/index";
import {
  type GameModeReader,
  GameModeService,
  MemoryGameModeOutbox,
  MemoryGameModeRepository,
  MongoGameModeOutbox,
  MongoGameModeRepository,
  OutboxDispatcher,
} from "@/features/game-mode/index";
import { LobbySettings } from "@/features/lobby/settings";
import { type GlobalDominoConfig, globalConfigWith } from "@/features/match/core/config";
import type { Clock } from "@/features/match/core/engine/clock";
import type { HistoryPort, HistoryReader } from "@/features/match/network/history";
import type { StandingsFeeds } from "@/features/match/network/standings";
import { AmqpRankingFeed } from "@/features/match/network/transports/amqp-ranking";
import { HttpLeagueFeed } from "@/features/match/network/transports/http-leagues";
import { MemoryHistory } from "@/features/match/network/transports/memory-history";
import { MongoHistory } from "@/features/match/network/transports/mongo-history";
import { MatchRegistry } from "@/features/match/transports/match-registry";
import { AmqpPublisher } from "@/shared/amqp";
import { type KeyValueStore, MemoryKeyValueStore } from "@/shared/kv";
import { Mongo } from "@/shared/mongo";
import { type Lease, MemoryLease, MongoLease } from "@/shared/mongo-lease";
import { type MatchMakerDriver, type Presence, RedisDriver, RedisPresence } from "colyseus";
import { container } from "tsyringe";
import { env } from "./env";
import { type Logger, logger } from "./logger";

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

// EL PUBLICADOR DEL BROKER, que es la ÚNICA instancia del proceso: `AmqpPublisher` memoiza una
// conexión y un canal confirm adentro, así que dos instancias serían dos conexiones al mismo
// broker y ninguna de las dos sabría de la otra al cerrarse.
//
// LA PRESENCIA DE LA URL ELIGE, igual que `MONGO_URI` y `REDIS_URL`, y `undefined` acá NO es una
// falla: el outbox es durable y sigue acumulando. Se exporta por lo mismo que `mongo` —para que
// `app.config.ts` lo meta en readiness y `main.ts` lo cierre—, y para nada más: publicar es cosa
// del despachador.
export const amqp = env.rabbitmqUrl ? new AmqpPublisher(env.rabbitmqUrl, logger) : undefined;

// ── LAS DOS TABLAS DEL CIERRE ───────────────────────────────────────────────────────────────────
//
// El ranking y la liga, que son lo que se cuenta afuera cuando una partida cierra con ganador y no
// es plata (ver `network/standings.ts`). Se registran JUNTOS en un solo token porque el único
// consumidor es el mismo listener, y dos tokens opcionales obligarían al wiring de la sala a
// preguntar `isRegistered` dos veces por algo que se decide una.
//
// CADA UNO DEPENDE DE LO SUYO Y POR SEPARADO: el ranking del broker, la liga del backend
// principal. Una instancia con broker y sin `BACKEND_URL` reporta puntos y no liga, que es un
// estado legítimo y no un error — el mismo criterio que el outbox que acumula sin publicador.
//
// SON DEL PROCESO y no de la sala: el publicador ya es único y el destino de liga no tiene estado.
// Lo per-partida es el listener, que lo arma `buildPieces` con el árbol y el snapshot a la vista.
const standings: StandingsFeeds = {
  ranking: amqp ? new AmqpRankingFeed(amqp) : undefined,
  leagues: env.backendUrl ? new HttpLeagueFeed(env.backendUrl) : undefined,
};
rootContainer.register<StandingsFeeds>("StandingsFeeds", { useValue: standings });

// EL CATÁLOGO DE MODOS, que desde la Tarea 10 es la AUTORIDAD sobre la economía de una mesa: la
// sala resuelve acá el modo que el request nombró y de él salen `pointsToWin`, `entryFee` y
// `prize`. Sin este registro ninguna sala puede nacer, así que el token no es opcional.
//
// LA PRESENCIA DE `MONGO_URI` ELIGE LAS TRES PIEZAS A LA VEZ —repositorio, outbox y lease— y no
// una por una, porque las tres son la MISMA base: un catálogo en Mongo con un outbox en memoria
// perdería en cada reinicio justamente los eventos que el outbox existe para no perder, y un lease
// de memoria no excluiría a la otra instancia, que es lo único que ese lease hace. Se reutiliza la
// instancia `Mongo` de arriba: son colecciones distintas del mismo cliente, y abrir un segundo
// cliente sería un pool de conexiones que nadie cierra.
const gameModeRepository = mongo
  ? new MongoGameModeRepository(mongo, clock)
  : new MemoryGameModeRepository(clock);
const gameModeOutbox = mongo
  ? new MongoGameModeOutbox(mongo, clock)
  : new MemoryGameModeOutbox(clock);
const catalogLease: Lease = mongo ? new MongoLease(mongo, clock) : new MemoryLease();

// EL DESPACHADOR SOLO EXISTE CON LAS DOS COSAS, y la conjunción es la decisión: sin Mongo el outbox
// es de memoria y despacharlo sería publicar lo que se va a perder igual; sin publicador no hay a
// dónde despachar. Con una sola de las dos, el proceso administra el catálogo y acumula — que es un
// estado legítimo y no un error, exactamente como el historial de memoria.
//
// `wake()` sin despachador es un no-op y NO un error: el servicio no puede saber si esta instancia
// publica, y hacérselo saber sería devolverle al caso de uso la dependencia que el callback
// inyectado vino a sacarle.
export const outboxDispatcher =
  mongo && amqp
    ? new OutboxDispatcher(gameModeRepository, gameModeOutbox, amqp, catalogLease, clock, logger)
    : undefined;
outboxDispatcher?.start();

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
  useValue: new GameModeService(gameModeRepository, gameModeOutbox, catalogLease, () =>
    outboxDispatcher?.wake(),
  ),
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
  // 0. PARAR EL DESPACHADOR, y va PRIMERO por lo mismo que el historial va antes que Mongo: tiene
  //    una entrega EN VUELO. `close()` cancela el temporizador y espera el `inFlight`, así que lo
  //    que estaba publicado y confirmado alcanza a marcarse `SENT`. Cortarle la base debajo dejaría
  //    un evento entregado al broker y PENDING en Mongo: se republicaría al arrancar, que es un
  //    duplicado que el consumidor ya deduplica, pero el costo de esperar son milisegundos.
  await outboxDispatcher?.close();
  await history.drain();
  // 2. CERRAR EL BROKER, y DESPUÉS del despachador por la misma razón: al revés la publicación en
  //    vuelo se cae sobre un canal cerrado y el evento vuelve a PENDING sin necesidad. `close()`
  //    tolera una conexión ya cerrada, así que no hay nada que proteger acá.
  await amqp?.close();
  // 3. CERRAR MONGO ÚLTIMO. Los tres pasos de arriba escriben ahí: el despachador marca `SENT`, el
  //    historial drena su último lote. Al revés se pierde exactamente lo que se acaba de esperar.
  await mongo?.close();
}
