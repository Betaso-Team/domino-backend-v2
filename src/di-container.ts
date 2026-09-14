import "reflect-metadata";
import { container } from "tsyringe";
import { env } from "./env.js";
import { JwtVerifier } from "./features/auth/index.js";
import { type GlobalDominoConfig, globalConfigWith } from "./features/match/core/config.js";
import type { Clock } from "./features/match/core/engine/clock.js";
import type { HistoryPort, HistoryReader } from "./features/match/network/history.js";
import { MemoryHistory } from "./features/match/network/transports/memory-history.js";
import { MatchRegistry } from "./features/match/transports/match-registry.js";
import { type Logger, logger } from "./logger.js";

// Acá viven solo dependencias globales y sin estado de partida. Los actores del motor
// se arman dentro de cada sala porque pertenecen a una partida concreta.
export const rootContainer = container;

rootContainer.register<GlobalDominoConfig>("GlobalDominoConfig", {
  useValue: globalConfigWith({
    turnTimeoutMs: env.turnTimeoutMs,
    extraTimeReserveMs: env.extraTimeReserveMs,
    presentingRoundMs: env.presentingRoundMs,
    presentingMatchMs: env.presentingMatchMs,
    seatingTimeoutMs: env.seatingTimeoutMs,
  }),
});
rootContainer.register<Clock>("Clock", { useValue: { now: () => Date.now() } satisfies Clock });
rootContainer.register<Logger>("Logger", { useValue: logger });
rootContainer.register("TokenVerifier", { useValue: new JwtVerifier(env.jwtSecret) });

// Registro e historial sobreviven a las salas: más adelante sus adaptadores serán Redis
// y Mongo, respectivamente, sin convertir a la sala en dueña de esa infraestructura.
rootContainer.register(MatchRegistry, { useValue: new MatchRegistry() });

// UNA instancia detrás de DOS tokens: escritura (`HistoryPort`, el camino caliente de la
// sala) y lectura (`HistoryReader`, el endpoint interno y el CLI de replay). Los tokens
// están separados porque el día que entre Mongo los dos lados no viajan juntos —el de
// escritura puede quedar bufferizado y el de lectura consultar la colección—, y porque
// así el que lee no alcanza `record`. Los dos `register` van TIPADOS: sin el parámetro de
// tipo, tsyringe acepta cualquier valor contra el token y el error aparece recién en el
// `resolve`, es decir en runtime.
const history = new MemoryHistory();
rootContainer.register<HistoryPort>("HistoryPort", { useValue: history });
rootContainer.register<HistoryReader>("HistoryReader", { useValue: history });
