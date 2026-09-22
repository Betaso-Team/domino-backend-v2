import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { JwtVerifier } from "@/features/auth";
import {
  type AccountDirectory,
  AccountUnavailableError,
  AmqpWallet,
  BetasoWallet,
  HttpAccountDirectory,
  HttpRateBook,
  HttpWallet,
  type Ledger,
  MatchAccounts,
  MatchRates,
  MemoryLedger,
  MongoLedger,
  Outbox,
  type RateBook,
  type WalletPort,
  WalletUnavailableError,
} from "@/features/economy";
import {
  type GameModeReader,
  GameModeService,
  MemoryGameModeOutbox,
  MemoryGameModeRepository,
  MongoGameModeOutbox,
  MongoGameModeRepository,
  OutboxDispatcher,
} from "@/features/game-mode";
import { LobbySettings } from "@/features/lobby/settings";
import {
  ColyseusMatchGateway,
  MatchPlatform,
  MatchRegistry,
  RematchCoordinator,
} from "@/features/match";
import { type GlobalDominoConfig, globalConfigWith } from "@/features/match/core/config";
import type { Clock } from "@/features/match/core/engine/clock";
import type { HistoryPort, HistoryReader } from "@/features/match/network/history";
import type { StandingsFeeds } from "@/features/match/network/standings";
import { AmqpRankingFeed } from "@/features/match/network/transports/amqp-ranking";
import { HttpLeagueFeed } from "@/features/match/network/transports/http-leagues";
import { MemoryHistory } from "@/features/match/network/transports/memory-history";
import { MongoHistory } from "@/features/match/network/transports/mongo-history";
import {
  type AntifraudFlag,
  CASUAL_SCOPE,
  CachedAntifraudFlag,
  CooldownBook,
  DEFAULT_COOLDOWN,
  DEFAULT_MATCHMAKING_CONFIG,
  HttpAntifraudFlag,
  type MaintenanceBook,
  Matchmaker,
  MemoryMatchPool,
  MongoMaintenanceBook,
  OPEN,
  PolledCensus,
  PolledMaintenanceSignal,
  ScopedPoolDirectory,
  VetoBook,
  casualVetoKey,
  matchmakingSink,
  tournamentVetoKey,
} from "@/features/matchmaking";
import {
  AmqpParticipationTransport,
  CachedTournamentClient,
  DEFAULT_TOURNAMENT_CONFIG,
  HttpTournamentClient,
  ParticipationReporter,
  StrikeBook,
  type TournamentClient,
  TournamentUnavailableError,
  TournamentWatcher,
} from "@/features/tournament";
import { AmqpPublisher } from "@/shared/amqp";
import { HttpClient } from "@/shared/http";
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
    rematchWindowMs: env.rematchWindowMs,
    rematchResponseMs: env.rematchResponseMs,
    rematchHandoffMs: env.rematchHandoffMs,
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
const matchRegistry = new MatchRegistry(store);
rootContainer.register(MatchRegistry, { useValue: matchRegistry });
rootContainer.register("MatchCensus", { useValue: matchRegistry });

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
rootContainer.register("PlayerLog", { useValue: history });

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

// The integration ring follows truco: matchmaking owns room creation and the authenticated `sub`
// is the player id. Tests and service-free development keep memory implementations, while the same
// ports use Mongo/HTTP/Rabbit as soon as their coordinates are present.
const http = env.backendUrl ? new HttpClient({ baseUrl: env.backendUrl }) : undefined;
const unavailableAccounts: AccountDirectory = {
  accountOf: async (playerId) => {
    throw new AccountUnavailableError(`backend no configurado para ${playerId}`);
  },
};
const accounts: AccountDirectory = http ? new HttpAccountDirectory(http) : unavailableAccounts;
const unavailableRates: RateBook = {
  rateFor: async (currency) => {
    throw new Error(`backend no configurado para convertir ${currency}`);
  },
};
const rates: RateBook = http ? new HttpRateBook(http) : unavailableRates;
const matchAccounts = new MatchAccounts(accounts);
const matchRates = new MatchRates(rates);
export const ledger: Ledger = mongo
  ? new MongoLedger(mongo, "dominotransactions")
  : new MemoryLedger(clock.now);

const httpWallet =
  http && env.internalApiKey
    ? new HttpWallet({
        http,
        apiKey: { value: env.internalApiKey },
        accounts,
        matchAccounts,
        rates,
        matchRates,
      })
    : undefined;
const amqpWallet = amqp
  ? new AmqpWallet({ publisher: amqp, matchAccounts, matchRates, ledger })
  : undefined;
const wallet: WalletPort =
  httpWallet && amqpWallet
    ? new BetasoWallet(httpWallet, amqpWallet)
    : {
        canAfford: (query) => httpWallet?.canAfford(query) ?? Promise.resolve(false),
        charge: (movement) =>
          httpWallet?.charge(movement) ??
          Promise.reject(new WalletUnavailableError("backend no configurado")),
        credit: (movement) =>
          amqpWallet?.credit(movement) ??
          Promise.reject(new WalletUnavailableError("broker no configurado")),
        refund: (movement) =>
          amqpWallet?.refund(movement) ??
          Promise.reject(new WalletUnavailableError("broker no configurado")),
        refundMatch: (matchId, playerIds) =>
          amqpWallet?.refundMatch(matchId, playerIds) ??
          Promise.reject(new WalletUnavailableError("broker no configurado")),
      };
export const economyOutbox = new Outbox(wallet, ledger, logger);

const tournamentClient: TournamentClient | undefined =
  http && env.internalApiKey
    ? new HttpTournamentClient(http, { value: env.internalApiKey }, DEFAULT_TOURNAMENT_CONFIG)
    : undefined;
const unavailableTournament: TournamentClient = {
  infoOf: async (id) => {
    throw new TournamentUnavailableError(id);
  },
  isEnrolled: async (id) => {
    throw new TournamentUnavailableError(id);
  },
};
const askTournament = tournamentClient ?? unavailableTournament;
const pollTournament = new CachedTournamentClient(askTournament, 30_000, clock.now);
export const participationReporter = amqp
  ? new ParticipationReporter(new AmqpParticipationTransport(amqp), logger)
  : undefined;

const strikes = new StrikeBook(store, DEFAULT_TOURNAMENT_CONFIG, clock.now);
const maintenanceBook: MaintenanceBook = mongo
  ? new MongoMaintenanceBook(mongo, "domino_settings", logger)
  : {
      current: async () => {
        const value = await rootContainer.resolve(LobbySettings).get();
        return value.isUnderMaintenance
          ? { isUnderMaintenance: true, message: value.maintenanceMessage }
          : OPEN;
      },
    };
export const maintenanceSignal = new PolledMaintenanceSignal({
  book: maintenanceBook,
  intervalMs: DEFAULT_MATCHMAKING_CONFIG.maintenancePollMs,
  log: logger,
});
export const census = new PolledCensus({
  source: { count: () => matchRegistry.census() },
  intervalMs: DEFAULT_MATCHMAKING_CONFIG.censusPollMs,
  log: logger,
});

// Se EXPORTA para que un E2E pueda comprobar que el veto se escribió de verdad. No es una puerta
// nueva: el defecto que esto cerró fue justamente que nadie escribía el libro, y eso solo se ve
// leyéndolo del lado de afuera de la cadena que lo llena.
export const casualVeto = new VetoBook(store, casualVetoKey, { ttlMs: 30 * 60_000 });
const tournamentVeto = new VetoBook(store, tournamentVetoKey, { ttlMs: 6 * 60 * 60_000 });
const cooldown = new CooldownBook(store, DEFAULT_COOLDOWN, clock.now);
const antifraud: AntifraudFlag =
  http && env.internalApiKey
    ? new CachedAntifraudFlag(
        new HttpAntifraudFlag(http, { value: env.internalApiKey }),
        5_000,
        clock.now,
        logger,
      )
    : { isRematchRulesEnabled: async () => true };

const poolDirectory = new ScopedPoolDirectory(
  {
    catalog: gameModeRepository,
    wallet,
    avoid: async (playerId) =>
      (await antifraud.isRematchRulesEnabled()) ? casualVeto.vetoedFor(CASUAL_SCOPE, playerId) : [],
  },
  {
    client: pollTournament,
    strikes,
    avoid: (tournamentId, playerId) => tournamentVeto.vetoedFor(tournamentId, playerId),
  },
);
const gateway = new ColyseusMatchGateway();
export const matchmaker = new Matchmaker({
  directory: poolDirectory,
  pool: new MemoryMatchPool(),
  gateway,
  config: DEFAULT_MATCHMAKING_CONFIG,
  cooldown,
  live: { matchOf: (playerId) => matchRegistry.matchOf(playerId) },
  maintenance: maintenanceSignal,
  now: clock.now,
  seedOf: randomUUID,
  log: logger,
});
// EL COORDINADOR DE LA REVANCHA, con las tres piezas que ya existían y una que es nueva sólo
// como composición: el ANTIFRAUDE de la revancha es la MISMA bandera que apaga el veto del
// emparejador, leída al revés — allá decide si evitar a un rival, acá si dejar repetir con él.
//
// ⚠ EL VETO SE CONSULTA PERO NO SE ESCRIBE ACÁ. Si estos dos ya están vetados entre sí, la
// revancha no se ofrece; anotar el veto cuando una revancha TERMINA es del cierre de esa mesa,
// y hoy no se hace (ver la deuda en AGENTS.md). Sin esa mitad, el tope de la cadena
// —`rematchCount`— es lo único que impide la repetición infinita, y alcanza: el par vuelve al
// emparejador, que es quien los separa.
rootContainer.register(RematchCoordinator, {
  useValue: new RematchCoordinator({
    wallet,
    antifraud: async (playerIds) => {
      if (!(await antifraud.isRematchRulesEnabled())) return true;
      const vetoed = await casualVeto.vetoedFor(CASUAL_SCOPE, playerIds[0] ?? "");
      return !playerIds.some((playerId) => vetoed.includes(playerId));
    },
    opener: gateway,
    seedOf: randomUUID,
    log: logger,
  }),
});
rootContainer.register(MatchPlatform, {
  useValue: new MatchPlatform({
    wallet,
    ledger,
    accounts,
    matchAccounts,
    outbox: economyOutbox,
    tournament: tournamentClient,
    participation: participationReporter,
    strikes,
    tournamentConfig: DEFAULT_TOURNAMENT_CONFIG,
    summaries: history,
    now: clock.now,
    log: logger,
  }),
});
rootContainer.register("MatchSinks", {
  useValue: (options: import("@/features/match").DominoRoomOptions) => {
    const casual = options.mode === "CASUAL";
    return [
      matchmakingSink(
        {
          cooldown,
          veto: casual ? casualVeto : tournamentVeto,
          isCasualVetoEnabled: () => antifraud.isRematchRulesEnabled(),
          log: logger,
        },
        {
          poolId: casual ? options.gameModeId : options.tournamentId,
          playerIds: options.seats,
        },
      ),
    ];
  },
});

export const tournamentWatcher =
  amqp && tournamentClient
    ? new TournamentWatcher({
        client: pollTournament,
        publisher: amqp,
        liveTournaments: () => matchRegistry.tournamentsWithMatches(),
        intervalMs: DEFAULT_TOURNAMENT_CONFIG.gamesCheckIntervalMs,
        log: logger,
      })
    : undefined;
rootContainer.register("StrikeBook", { useValue: strikes });

export function startServices(): void {
  matchmaker.start();
  maintenanceSignal.start();
  census.start();
  tournamentWatcher?.start();
}

export function stopAcceptingMatches(): void {
  matchmaker.stop();
  maintenanceSignal.stop();
  census.stop();
}

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
  stopAcceptingMatches();
  await Promise.allSettled([
    economyOutbox.close(),
    participationReporter?.close(),
    tournamentWatcher?.close(),
  ]);
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
