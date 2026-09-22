import type { TokenVerifier } from "@/features/auth";
import { GameModeService, registerGameModeHttp } from "@/features/game-mode";
import { LobbySettings, registerLobbyHttp } from "@/features/lobby";
import {
  type Clock,
  type HistoryReader,
  MatchRegistry,
  type PlayerLog,
  registerMatchHttp,
  selectProcessIdToCreateRoom,
} from "@/features/match";
import { DominoRoom } from "@/features/match/transports/colyseus/domino-room";
import { LobbyRoom, registerMatchmakingHttp } from "@/features/matchmaking";
import { registerSettingsHttp } from "@/features/settings";
import { type StrikeBook, registerTournamentHttp } from "@/features/tournament";
import { httpErrorHandler } from "@/shared/http/error-handler";
import { type DependencyChecks, registerHealth } from "@/shared/http/health";
import { exposeServerTime } from "@/shared/http/server-time";
import config from "@colyseus/tools";
import { type ServerOptions, defineRoom, defineServer } from "colyseus";
import express, { type Application } from "express";
import {
  amqp,
  census,
  driver,
  maintenanceSignal,
  matchmaker,
  mongo,
  presence,
  rootContainer,
  settingsSections,
  settingsSignal,
  settingsWriter,
} from "./di-container";
import { env } from "./env";
import type { Logger } from "./logger";

const rooms = {
  lobby: defineRoom(LobbyRoom, {
    matchmaker,
    verifier: rootContainer.resolve<TokenVerifier>("TokenVerifier"),
    maintenance: maintenanceSignal,
    census,
  }),
  domino: defineRoom(DominoRoom),
};

// EL COMPOSITION ROOT de la superficie Express. Acá —y solo acá— se resuelve del container
// y se lee `env`: el transporte recibe las cinco dependencias ya armadas y no sabe que
// ninguna de las dos cosas existe (Regla 3). Es el mismo lugar que `src/index.ts` ocupa en
// truco; en domino el `app.config` es el que arma las dos superficies, la de test y la real.
//
// EL ORDEN DE LAS TRES LÍNEAS ES EL CONTRATO, y no es estilo:
//   1. `express.json()` primero, o las rutas leen un `req.body` que nadie parseó;
//   2. las rutas;
//   3. el manejador de errores ÚLTIMO. Express lo reconoce por la ARIDAD de cuatro
//      parámetros y solo alcanza lo que se registró ANTES que él.
//
// El `express()` de abajo no es nuestro: lo construye `WebSocketTransport.getExpressApp()`
// PELADO —sin parser de cuerpo y sin manejador de errores—, así que hoy una ruta que tira
// devuelve la página HTML por defecto de Express con el stack adentro (el default de
// `NODE_ENV` en `src/env.ts` es `development`).
//
// `express.json()` NO le come el cuerpo al `POST /matchmake/*` del SDK: en 0.18 el
// matchmaking ni siquiera pasa por Express. `bindRouterToTransport` antepone un listener de
// `request` en el servidor HTTP y, si la URL es del router de Colyseus, la resuelve contra
// el `req` crudo; solo delega en `expressApp.handle()` cuando NO lo es. Verificado además
// contra el servidor levantado: el mismo `POST /matchmake/*` responde idéntico con y sin
// estas líneas, y los e2e —que se reconectan por `joinById`, o sea por HTTP— siguen verdes.
//
// Y LA RAÍZ `/` TAMBIÉN ES DE ACÁ el día que alguien la registre, aunque Colyseus tenga un
// banner propio en esa misma ruta. Medido, no deducido: `Server.listen()` hace
// `await this._bootForListen()` —el que llama a esta función (`Server.mjs:257`)— ANTES de
// `bindRoutes()` (`Server.mjs:68` y `:93`), así que cuando `bindRouterToTransport` pregunta
// si ya hay una raíz (`router/index.mjs:21-28`) las rutas de acá YA están en el stack de
// Express y el `Colyseus x.y.z` no llega a registrarse. Sin endpoint `/` en su router, el
// `findRoute` del listener antepuesto no matchea y la request cae en `expressApp.handle()`
// (`router/index.mjs:39` y `:45`).
//
// Ese chequeo vive en una dependencia y un bump de versión puede invertir el orden sin
// avisar, dejando una raíz nuestra ignorada sin un solo error. Lo pinea
// `src/tests/http-root-route.e2e.test.ts`, que levanta el servidor con un `GET /` puesto y lo pide.
// LAS DEPENDENCIAS DURAS DE ESTA INSTANCIA, que las sabe el composition root y nadie más. Se
// arman acá y no en `shared/http/health.ts` porque ese archivo no conoce —ni tiene que conocer—
// ni a Mongo ni a Redis.
//
// UNA DEPENDENCIA QUE ESTA INSTANCIA ELIGIÓ NO TENER NO ENTRA AL MAPA, y eso es el corazón de
// la decisión: sin `MONGO_URI` el historial es el de memoria, sin `REDIS_URL` este proceso es un
// clúster de uno, y las dos son decisiones del operador, no fallas (§`src/di-container.ts`). Un
// `/ready` que las contara como faltantes sacaría de rotación para siempre a la instancia única,
// que es el despliegue por default de este repo.
//
// A Redis se le pide una LECTURA CUALQUIERA: lo que se mide es el viaje de ida y vuelta, no el
// valor. El `presence` es el mismo objeto que el almacén compartido —encaja por estructura, ver
// `shared/kv.ts`—, así que preguntarle a él es preguntarle exactamente a la conexión que usan
// el registro de salas y el registro de partidas vivas.
//
// LO QUE ESTE CHEQUEO NO PUEDE CUBRIR, medido y no supuesto: si Redis está caído AL ARRANCAR, el
// proceso no llega a escuchar. ioredis reintenta la conexión para siempre, `matchMaker.setup()`
// nunca resuelve y `listen()` no termina, así que no hay `/ready` que contestar —ni un `ready`
// que mandarle a pm2, que lo reiniciaría en bucle al vencer su `listen_timeout`—. Es
// comportamiento de Colyseus y no algo que se decida acá; lo que este chequeo cubre es el otro
// caso, que es el común: Redis que se cae con el proceso ya levantado.
//
// LO QUE SÍ CAMBIÓ es que ese arranque colgado ya no es ETERNO: `src/main.ts` le puso plazo, y al
// vencerse la instancia lo dice y se muere con 1 en vez de quedar viva sin servidor. No es un
// chequeo de dependencias —no distingue un Redis caído de un puerto ocupado— y no tiene por qué:
// las dos cosas son "esta instancia no llegó a escuchar", que es una sola respuesta.
// Los dos alias locales NO son cosmética: tsc no estrecha un binding IMPORTADO adentro de una
// clausura —no puede probar que el módulo de origen no lo reasigne— así que `mongo.ping()`
// dentro de la flecha no compila aunque el ternario de afuera ya lo haya descartado. Con la
// copia local sí, y el gate lo cazó con la suite en verde, que es el modo de falla de siempre.
//
// A RABBIT SE LE PIDE UN `ping()`, que abre el canal SIN publicar: una sonda que publicara mandaría
// un evento de catálogo a los consumidores en cada chequeo del balanceador.
//
// ⚠ Y `ping()` NO RECHAZA SOLO CON EL BROKER CAÍDO: **cuelga**. `amqplib` con `recovery: true` usa
// `maxRetries: Infinity` (`lib/recovery.js:8`), así que la rama que rechaza el connect inicial es
// inalcanzable (§`src/shared/amqp.ts`). Lo que lo convierte en un 503 y no en un `/ready` que no
// contesta es el plazo POR CHEQUEO de `registerHealth` — el mismo que ya cubre el Mongo inalcanzable
// y por el mismo motivo: una base caída no falla, CUELGA. Sacar ese plazo saca a Rabbit del mapa sin
// que ningún test de esta capa se ponga rojo.
const mongoConnection = mongo;
const sharedStore = presence;
const broker = amqp;
const hardDependencies: DependencyChecks = {
  ...(mongoConnection ? { mongo: () => mongoConnection.ping() } : {}),
  ...(sharedStore ? { redis: () => sharedStore.get("readiness") } : {}),
  ...(broker ? { rabbit: () => broker.ping() } : {}),
};

const registerHttp = (app: Application) => {
  const logger = rootContainer.resolve<Logger>("Logger");
  app.use(express.json());
  // PRIMERO DE TODOS, porque es de la costura y no de una ruta: así la cabecera sale también
  // en las respuestas de los chequeos y en las de error, que son las que el cliente tiene a
  // mano cuando algo va mal.
  app.use(exposeServerTime());
  // LOS DOS CHEQUEOS DEL BALANCEADOR, y van ANTES de las rutas de la feature por nada
  // profundo: no se solapan con ninguna. Son dos a propósito y la diferencia está argumentada
  // en `shared/http/health.ts` — `/health` no consulta nada porque "reiniciame" es la única
  // respuesta que destruye partidas en curso.
  registerHealth(app, hardDependencies);
  registerLobbyHttp(app, {
    settings: rootContainer.resolve(LobbySettings),
    internalApiKey: env.internalApiKey,
  });
  registerMatchmakingHttp(app, maintenanceSignal, census);
  registerTournamentHttp(
    app,
    rootContainer.resolve<StrikeBook>("StrikeBook"),
    rootContainer.resolve<TokenVerifier>("TokenVerifier"),
  );
  registerMatchHttp(app, {
    registry: rootContainer.resolve(MatchRegistry),
    clock: rootContainer.resolve<Clock>("Clock"),
    logger,
    history: rootContainer.resolve<HistoryReader>("HistoryReader"),
    internalApiKey: env.internalApiKey,
    verifier: rootContainer.resolve<TokenVerifier>("TokenVerifier"),
    playerLog: rootContainer.resolve<PlayerLog>("PlayerLog"),
  });
  // EL CATÁLOGO, y va ANTES del manejador de errores como todas las demás: Express reconoce ese
  // manejador por su aridad de cuatro parámetros y solo alcanza lo que se registró antes. Una ruta
  // puesta después queda con el HTML por defecto de Express, con el stack adentro.
  //
  // Los GET son públicos y las cinco mutaciones viven detrás de `internalApiKey`; sin llave no se
  // registran (fail closed, §`features/game-mode/transports/http/register-http.ts`). Quien autentica
  // al administrador es el orquestador, no el dominó.
  registerGameModeHttp(app, {
    service: rootContainer.resolve(GameModeService),
    logger,
    internalApiKey: env.internalApiKey,
  });
  // LA CONFIGURACIÓN EN CALIENTE, detrás de la misma llave interna y con la misma regla: sin llave no
  // se registra. Antes del manejador de errores, como todas.
  registerSettingsHttp(app, {
    sections: settingsSections,
    signal: settingsSignal,
    writer: settingsWriter,
    internalApiKey: env.internalApiKey,
    log: logger,
  });
  app.use(httpErrorHandler(logger));
};

// LO QUE CONVIERTE A VARIOS PROCESOS EN UN CLÚSTER, y las cuatro piezas son una sola decisión:
//
//   · `presence` y `driver` — compartidos, el registro de salas y la comunicación entre procesos
//     viven en Redis. Cuando `REDIS_URL` no está los dos son `undefined` y Colyseus usa los
//     LOCALES, que es exactamente lo correcto con una instancia sola (ver `src/di-container.ts`).
//   · `publicAddress` — CÓMO SE LLEGA A ESTE PROCESO. Colyseus se lo manda al cliente en la
//     reserva de asiento, y por eso cada instancia anuncia la suya: con las salas repartidas, el
//     jugador tiene que conectarse al proceso que hospeda la SUYA, no a cualquiera. Sin esto, un
//     `joinById` contra una sala de otro nodo se conecta al nodo equivocado.
//   · `selectProcessIdToCreateRoom` — dónde se abre la partida siguiente. Ver `load-balancer.ts`.
//
// VAN EN LAS DOS SUPERFICIES, la real y la de test, porque una superficie de test que no arma el
// servidor igual que la real deja de medir lo que se despliega. En test no cambia nada: la suite
// corre sin `REDIS_URL` —`vitest.setup.ts` la BORRA— así que las cuatro caen en el camino local.
const cluster: ServerOptions = {
  presence,
  driver,
  publicAddress: env.publicAddress,
  selectProcessIdToCreateRoom,
  // EL APAGADO ES NUESTRO. Con el default, Colyseus registra por su cuenta las señales y
  // `uncaughtException` (`registerGracefulShutdown`, `@colyseus/core/build/Server.mjs`) y lo que
  // hace ahí es cerrar las salas y llamar a `process.exit` — sin esperar a que el historial
  // termine de escribir. Con las dos cosas registradas, una señal dispara los dos caminos a la
  // vez y el que termina primero le corta la mano al otro: el último lote de cada partida se
  // pierde en una carrera.
  //
  // Lo que se apaga por nuestra cuenta está en `src/main.ts`, y ahí se reponen las dos redes que
  // esto saca: las señales y `uncaughtException`. Lo que NO se saca es el
  // `server.gracefullyShutdown(false)` en sí —seguimos llamándolo, y es él quien dispone las
  // salas y cierra Redis—: lo único que este `false` apaga es que Colyseus decida CUÁNDO.
  //
  // VA EN LAS DOS SUPERFICIES, como las otras cuatro. En la de test es de hecho lo correcto por
  // partida doble: un worker de vitest no quiere a Colyseus interceptándole el SIGINT, y como
  // `main.ts` no lo importa nadie, en test no queda nadie registrado.
  gracefullyShutdown: false,
};

// @colyseus/testing solo respeta el puerto pedido cuando recibe opciones, no un
// Server ya construido. Ambas superficies comparten estas mismas definiciones.
export const testConfig = config({
  rooms,
  initializeExpress: registerHttp,
  options: cluster,
});

// El export nombrado conserva el tipo de salas para el cliente generado de Colyseus.
export const server = defineServer({
  rooms,
  express: registerHttp,
  ...cluster,
});

export default server;
