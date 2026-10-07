import "reflect-metadata";
import { JwtVerifier } from "@/features/auth";
import {
  type GameModeReader,
  GameModeService,
  MemoryGameModeOutbox,
  MemoryGameModeRepository,
  MongoGameModeOutbox,
  MongoGameModeRepository,
  OutboxDispatcher,
} from "@/features/game-mode";
import {
  ColyseusMatchGateway,
  DEAL_PRESET_EDITABLE,
  type DealPreset,
  type DevPresetSource,
  MATCH_EDITABLE,
  MatchRegistry,
  NO_DEAL_PRESET,
  NO_STARTING_SCORE,
  STARTING_SCORE_EDITABLE,
  type StartingScore,
  dealPresetPatch,
  matchConfigPatch,
  startingScoreBelow,
  startingScorePatch,
} from "@/features/match";
import {
  type GlobalConfigSource,
  type GlobalDominoConfig,
  globalConfigWith,
} from "@/features/match/core/config";
import type { Clock } from "@/features/match/core/engine/clock";
import type { HistoryPort, HistoryReader } from "@/features/match/network/history";
import {
  MATCH_RESULT_EXCHANGE,
  type MatchResultKey,
  type MatchResultPayload,
  MatchResultRecorder,
} from "@/features/match/network/match-results";
import {
  OrchestratorBetCharger,
  type OrchestratorCharges,
} from "@/features/match/network/orchestrator-charges";
import { HttpOrchestratorCharges } from "@/features/match/network/transports/http-orchestrator";
import { MemoryHistory } from "@/features/match/network/transports/memory-history";
import { MongoHistory } from "@/features/match/network/transports/mongo-history";
import {
  MemorySettings,
  MongoSettings,
  PolledSettingsSignal,
  SETTINGS_POLL_MS,
  type SettingsSection,
  type SettingsWriter,
} from "@/features/settings";
import { AmqpPublisher } from "@/shared/amqp";
import { HttpClient } from "@/shared/http";
import { type KeyValueStore, MemoryKeyValueStore } from "@/shared/kv";
import { Mongo } from "@/shared/mongo";
import { type Lease, MemoryLease, MongoLease } from "@/shared/mongo-lease";
import { MongoOutboxStore } from "@/shared/mongo-outbox";
import { MemoryOutboxStore, type OutboxStore, TopicOutboxDispatcher } from "@/shared/outbox";
import { type MatchMakerDriver, type Presence, RedisDriver, RedisPresence } from "colyseus";
import { container } from "tsyringe";
import { env, isDevEnvironment } from "./env";
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
rootContainer.register("TokenVerifier", {
  useValue: new JwtVerifier(env.billingAuth),
});

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

// EL REGISTRO DE PARTIDAS VIVAS, que ya no es del proceso sino del CLÚSTER: sus dos respuestas
// —el config público del endpoint HTTP y en qué sala está sentado un jugador— salen del almacén
// compartido y no de un `Map` local. Sobrevive a las salas sin convertir a la sala en dueña de
// esa infraestructura, igual que el historial.
const matchRegistry = new MatchRegistry(store);
rootContainer.register(MatchRegistry, { useValue: matchRegistry });

// LA PRESENCIA DE LA URI ES LA QUE ELIGE, y no hay un `HISTORY_DRIVER` ni lo va a haber:
// un interruptor que NOMBRA la implementación es deuda, no configuración —deja escribir
// "mongo" sin URI y "memory" con una base andando al lado—, y truco ya borró el suyo por
// esa razón. Acá el dato y la decisión son lo mismo, así que la combinación incoherente no
// se puede escribir. Es el mismo fail-closed que la API interna usa con `ADMIN_API_KEY`:
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

// ── LAS MESAS DEL ORQUESTADOR: el resultado y los cobros ────────────────────────────────────────
//
// EL RESULTADO VA POR SU PROPIO BROKER (`BETASO_GAMES_RABBITMQ_URL`, vhost `betaso_games`), que no es
// el de Betaso: otro publicador, otra conexión. El outbox elige por `MONGO_URI` como el del catálogo,
// y el despachador existe con el broker aunque no haya Mongo —sin Mongo, lo encolado se pierde con
// el proceso, pero lo que alcance a salir sale—. Sin broker, el outbox acumula.
//
// `mandatory` es lo que hace que un resultado publicado antes de que el orquestador declare su cola
// cuente como fallo y se reintente (ver `shared/amqp.ts`).
export const betasoGamesAmqp = env.betasoGamesRabbitmqUrl
  ? new AmqpPublisher(env.betasoGamesRabbitmqUrl, logger)
  : undefined;
const matchResultOutbox: OutboxStore<MatchResultKey, MatchResultPayload> = mongo
  ? new MongoOutboxStore(mongo, "match_result_outbox", clock, {
      // SIETE DÍAS: lo enviado se borra solo, y mientras tanto es la red si el broker pierde su disco.
      sentRetentionSeconds: 7 * 24 * 3600,
    })
  : new MemoryOutboxStore(clock);
export const matchResultDispatcher = betasoGamesAmqp
  ? new TopicOutboxDispatcher({
      exchange: MATCH_RESULT_EXCHANGE,
      // OTRO LEASE que el del catálogo: comparten colección, no nombre, así que no se bloquean.
      leaseName: "match-result-publisher",
      queue: matchResultOutbox,
      delivery: betasoGamesAmqp,
      lease: catalogLease,
      clock,
      log: logger,
      label: "resultado de partida",
      // LAS PARTIDAS TERMINAN EN RÁFAGAS: una por segundo no alcanza para un servidor lleno.
      perTick: 20,
      // DIEZ MINUTOS sin salir es un error en el log, que es lo que una alerta mira.
      stuckAfterMs: 10 * 60_000,
      publishOptions: (entry) => ({ mandatory: true, messageId: entry.dedupeKey }),
    })
  : undefined;
matchResultDispatcher?.start();
rootContainer.register(MatchResultRecorder, {
  useValue: new MatchResultRecorder({
    outbox: matchResultOutbox,
    wake: () => matchResultDispatcher?.wake(),
    now: () => clock.now(),
    log: logger,
  }),
});
// Para la suite: lo encolado, sin broker. Se exporta como el catálogo exporta `gameModes`.
export const matchResults = matchResultOutbox;

// A QUIÉN LE PIDEN LOS COBROS. Existe si y solo si esta instancia atiende al orquestador: `parseEnv`
// exige la URL y la llave junto con `ORCHESTRATOR_API_KEY`.
const orchestratorCharges: OrchestratorCharges | undefined = env.orchestratorCallback
  ? new HttpOrchestratorCharges(
      new HttpClient({ baseUrl: env.orchestratorCallback.url, timeoutMs: 10_000 }),
      env.orchestratorCallback.apiKey,
    )
  : undefined;
if (orchestratorCharges) {
  rootContainer.register<OrchestratorCharges>("OrchestratorCharges", {
    useValue: orchestratorCharges,
  });
  rootContainer.register(OrchestratorBetCharger, {
    useValue: new OrchestratorBetCharger({
      orchestrator: orchestratorCharges,
      // EL TECHO DE v1 (15 s), generoso a propósito: el que espera es un jugador que ya apretó
      // «acepto», y el trato espera, con la mesa diciendo x2, a lo sumo esto.
      timeoutMs: 15_000,
      log: logger,
    }),
  });
}

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

// ── LA CONFIGURACIÓN QUE SE MUEVE SIN DEPLOY ───────────────────────────────────────────────────
//
// Portado de truco (`3cab0f8`). El token de config —`GlobalDominoConfig`— sigue significando LA
// BASE: lo que sale del entorno y del código, y lo que la suite re-registra para acortar sus plazos.
// En la base queda sólo lo que se APARTA de eso, y la señal compone las dos cosas.
//
// LA PRESENCIA DE `MONGO_URI` ELIGE, como en todo lo demás: con Mongo, un documento propio en la
// colección `domino_settings` de v1; sin Mongo, la memoria del proceso, que
// con una sola instancia es exactamente lo correcto.
//
// Éste es el único lugar donde el nombre de una sección se encuentra con un tipo, porque es el único
// que conoce todas las features. Los `defaults` se resuelven AL PREGUNTAR: un test que re-registra
// la base con el servidor ya levantado tiene que ganar.
const settingsStore = mongo
  ? new MongoSettings(mongo, "domino_settings", logger)
  : new MemorySettings();
export const settingsSections: readonly SettingsSection[] = [
  {
    name: "match",
    schema: matchConfigPatch,
    editable: MATCH_EDITABLE,
    defaults: () => rootContainer.resolve<GlobalDominoConfig>("GlobalDominoConfig"),
  },
  // LAS DOS DE PRUEBA A MANO, y SÓLO donde existen: fijan las fichas y el marcador, que es lo que
  // probar a mano necesita y lo que ningún jugador en ningún otro lado puede poder hacer. Detrás de
  // la misma llave del panel que las demás —truco las sirve sin llave; acá no hay por qué abrir una
  // puerta que dev ya tiene—. Portadas de truco (`d6e3219`, `6da7372`).
  ...(isDevEnvironment(env.appEnv)
    ? [
        {
          name: "deal",
          schema: dealPresetPatch,
          editable: DEAL_PRESET_EDITABLE,
          defaults: () => NO_DEAL_PRESET,
        },
        {
          name: "starting-score",
          schema: startingScorePatch,
          editable: STARTING_SCORE_EDITABLE,
          defaults: () => NO_STARTING_SCORE,
        },
      ]
    : []),
];
export const settingsSignal = new PolledSettingsSignal({
  book: settingsStore,
  sections: settingsSections,
  intervalMs: SETTINGS_POLL_MS,
  log: logger,
});
export const settingsWriter: SettingsWriter = settingsStore;
// CON LO QUE NACE UNA MESA NUEVA. Una función y no un valor, y NUNCA re-registrada desde la pasada:
// tsyringe apila en cada registro, así que un temporizador que registrara un valor haría crecer un
// arreglo sin fin.
rootContainer.register<GlobalConfigSource>("GlobalConfigSource", {
  useValue: () => settingsSignal.effective<GlobalDominoConfig>("match"),
});
// Leídas UNA vez por mesa, como la config de arriba: una edición a mitad de partida espera a la
// siguiente. El aviso es para el que lea una partida donde las fichas no fueron suerte y se olvidó
// de que el preset estaba puesto.
if (isDevEnvironment(env.appEnv)) {
  rootContainer.register<DevPresetSource>("DevPresetSource", {
    useValue: (pointsToWin) => {
      const dealPreset = settingsSignal.effective<DealPreset>("deal");
      const startingScore = startingScoreBelow(
        settingsSignal.effective<StartingScore>("starting-score"),
        pointsToWin,
      );
      if (dealPreset.hands.length > 0) logger.warn("reparto preparado", { dealPreset });
      if (startingScore.teamA > 0 || startingScore.teamB > 0)
        logger.warn("marcador inicial preparado", { startingScore });
      return { dealPreset, startingScore };
    },
  });
}
// LA API INTERNA DEL ORQUESTADOR abre las mesas con este gateway: es la única puerta de entrada a
// una partida.
rootContainer.register(ColyseusMatchGateway, { useValue: new ColyseusMatchGateway() });
// LA TRAZA DEL JUEGO, y el token existe SÓLO cuando el nivel la pide. El sink no sabe de
// niveles ni pregunta por ninguno: con el debug apagado no se construye, y así el costo de
// filtrar los campos de cada evento de cada mesa tampoco se paga.
//
// Se decide acá porque es el único lugar que lee la configuración del proceso — `buildPieces`
// no puede, y darle `env` sería una segunda puerta a la configuración.
// `logLevel` es `"debug" | "info"` y nada más (ver `src/env.ts`), así que la condición es una
// sola: en producción el default es `info` y la traza no existe.
if (env.logLevel === "debug") {
  rootContainer.register("MatchTraceLog", { useValue: logger });
}

export function startServices(): void {
  settingsSignal.start();
}

export function stopAcceptingMatches(): void {
  settingsSignal.stop();
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
  // 0. PARAR EL DESPACHADOR, y va PRIMERO por lo mismo que el historial va antes que Mongo: tiene
  //    una entrega EN VUELO. `close()` cancela el temporizador y espera el `inFlight`, así que lo
  //    que estaba publicado y confirmado alcanza a marcarse `SENT`. Cortarle la base debajo dejaría
  //    un evento entregado al broker y PENDING en Mongo: se republicaría al arrancar, que es un
  //    duplicado que el consumidor ya deduplica, pero el costo de esperar son milisegundos.
  await outboxDispatcher?.close();
  await matchResultDispatcher?.close();
  await history.drain();
  // 2. CERRAR EL BROKER, y DESPUÉS del despachador por la misma razón: al revés la publicación en
  //    vuelo se cae sobre un canal cerrado y el evento vuelve a PENDING sin necesidad. `close()`
  //    tolera una conexión ya cerrada, así que no hay nada que proteger acá.
  await amqp?.close();
  await betasoGamesAmqp?.close();
  // 3. CERRAR MONGO ÚLTIMO. Los tres pasos de arriba escriben ahí: el despachador marca `SENT`, el
  //    historial drena su último lote. Al revés se pierde exactamente lo que se acaba de esperar.
  await mongo?.close();
}
