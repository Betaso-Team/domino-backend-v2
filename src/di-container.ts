import "reflect-metadata";
import { container } from "tsyringe";
import { env } from "./env.js";
import { JwtVerifier } from "./features/auth/index.js";
import { type GlobalDominoConfig, globalConfigWith } from "./features/match/core/config.js";
import type { Clock } from "./features/match/core/engine/clock.js";
import type { HistoryPort, HistoryReader } from "./features/match/network/history.js";
import { MemoryHistory } from "./features/match/network/transports/memory-history.js";
import { MongoHistory } from "./features/match/network/transports/mongo-history.js";
import { MatchRegistry } from "./features/match/transports/match-registry.js";
import { type Logger, logger } from "./logger.js";
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
rootContainer.register<Clock>("Clock", { useValue: { now: () => Date.now() } satisfies Clock });
rootContainer.register<Logger>("Logger", { useValue: logger });
rootContainer.register("TokenVerifier", { useValue: new JwtVerifier(env.jwtSecret) });

// Registro e historial sobreviven a las salas, sin convertir a la sala en dueña de esa
// infraestructura. El del historial ya es Mongo (abajo); el del registro sigue en memoria
// —ver el comentario de `MatchRegistry`, que explica cuándo pasa a Redis—.
rootContainer.register(MatchRegistry, { useValue: new MatchRegistry() });

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
