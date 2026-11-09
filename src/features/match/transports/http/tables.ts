import type { Logger } from "@/logger";
import { requireApiKey } from "@/shared/http/api-key";
import { sendError } from "@/shared/http/errors";
import { validated } from "@/shared/http/validated";
import { Router } from "express";
import { z } from "zod";
import type { MatchArchive } from "../../network/history";
import type { ColyseusMatchGateway } from "../colyseus/gateway";
import { createMatchRequestSchema } from "../match-contract";
import type { MatchRegistry, PublicMatchConfig } from "../match-registry";

// En consts para que el aviso de arranque y el registro no puedan divergir.
export const OPEN_TABLE_ROUTE = "/internal/matches";
export const SEAT_BACK_ROUTE = "/internal/players/:userId/seat";
export const CENSUS_ROUTE = "/internal/census";
export const PLAYER_MATCH_ROUTE = "/internal/players/:userId/match";
// Dos segmentos después de `matches`: no compite con el detalle del panel (`/internal/matches/:matchId`,
// un segmento) ni con `/:matchId/history` (otro literal).
export const MATCH_EXISTENCE_ROUTE = "/internal/matches/:matchId/existence";

const MATCH_PARAMS = z.object({
  matchId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\P{Cc}+$/u, "matchId inválido"),
});

// Misma forma que el `matchId` del historial: largo acotado y sin controles, porque este id entra
// del llamador y termina en una clave del registro compartido.
const SEAT_PARAMS = z.object({
  userId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\P{Cc}+$/u, "userId inválido"),
});

// LOS RECHAZOS DE LA SALA LLEGAN COMO MENSAJE: Colyseus propaga el `message` del error de
// `onCreate` al que pidió crearla, y el código va adelante (ver `match-contract.ts`).
const REFUSAL = /^(UNKNOWN_GAME_MODE|UNSUPPORTED_GAME_MODE|SEAT_COUNT_MISMATCH):/;

// LA CLASE DE LA MESA en las respuestas que la ubican: el orquestador separa las de torneo. Las mesas
// anotadas antes de los torneos no traen `mode` en el registro, y son casuales.
function modeFieldsOf(config: PublicMatchConfig) {
  return {
    mode: config.mode ?? "CASUAL",
    ...(config.tournamentId === undefined ? {} : { tournamentId: config.tournamentId }),
  };
}

export interface TablesDeps {
  readonly tables: Pick<ColyseusMatchGateway, "openRequest" | "seatBack">;
  readonly registry: Pick<MatchRegistry, "matchOf" | "publicConfigOf" | "census" | "isLive">;
  /** Si una partida tiene registro, sin leerlo: `GET .../existence`. */
  readonly archive: Pick<MatchArchive, "hasRecord">;
  readonly logger: Logger;
  /** `undefined` ⇒ las rutas NO se registran (fail closed, como el historial). */
  readonly orchestratorApiKey: string | undefined;
}

/**
 * LA API QUE USA EL ORQUESTADOR: abrir una mesa, devolverle su asiento a quien sigue jugando y
 * contar quién está jugando, por modo, para los números de su lobby.
 * Primero la llave, después la forma: al revés un anónimo aprendería el contrato gratis.
 */
export function tablesRoutes(deps: TablesDeps): Router {
  const router = Router();
  if (!deps.orchestratorApiKey) {
    deps.logger.warn(
      `API del orquestador deshabilitada: falta ORCHESTRATOR_API_KEY, no se registran ${OPEN_TABLE_ROUTE}, ${SEAT_BACK_ROUTE}, ${PLAYER_MATCH_ROUTE}, ${MATCH_EXISTENCE_ROUTE} ni ${CENSUS_ROUTE}`,
    );
    return router;
  }
  const guard = requireApiKey(deps.orchestratorApiKey);

  router.post(
    OPEN_TABLE_ROUTE,
    guard,
    validated({ body: createMatchRequestSchema }, async ({ body }, response) => {
      try {
        const table = await deps.tables.openRequest(body);
        response.status(201).json({ status: "success", data: table });
      } catch (error) {
        const code = error instanceof Error ? REFUSAL.exec(error.message)?.[1] : undefined;
        // Todo lo que no es un rechazo de la sala es NUESTRO: 500, no un 422 que lo disfrace.
        if (!code) throw error;
        sendError(response, 422, code);
      }
    }),
  );

  router.post(
    SEAT_BACK_ROUTE,
    guard,
    validated({ params: SEAT_PARAMS }, async ({ params }, response) => {
      const roomId = await deps.registry.matchOf(params.userId);
      const config = roomId ? await deps.registry.publicConfigOf(roomId) : undefined;
      const reservation = roomId && config ? await deps.tables.seatBack(roomId) : undefined;
      if (!config || reservation === undefined) {
        sendError(response, 404, "NO_LIVE_MATCH");
        return;
      }
      response.json({
        status: "success",
        data: { matchId: config.matchId, ...modeFieldsOf(config), reservation },
      });
    }),
  );
  // EN QUÉ MESA ESTÁ SENTADO, SIN RESERVAR NADA. Es la pregunta del orquestador cuando solo necesita
  // saber si el jugador tiene partida viva (para no abrirle otra): dos GET al registro compartido y
  // ninguna llamada a Colyseus. `POST .../seat` contesta lo mismo pero además reserva un asiento,
  // que es lo caro y lo que solo hace falta para volver a entrar.
  router.get(
    PLAYER_MATCH_ROUTE,
    guard,
    validated({ params: SEAT_PARAMS }, async ({ params }, response) => {
      const roomId = await deps.registry.matchOf(params.userId);
      const config = roomId ? await deps.registry.publicConfigOf(roomId) : undefined;
      if (!roomId || !config) {
        sendError(response, 404, "NO_LIVE_MATCH");
        return;
      }
      response.json({
        status: "success",
        data: { matchId: config.matchId, roomId, ...modeFieldsOf(config) },
      });
    }),
  );
  // SI UNA PARTIDA EXISTE, y nada más: si su mesa sigue viva (el registro del clúster) y si quedó
  // registro de ella (el archivo). Lo pregunta el orquestador antes de dar por perdida una mesa de torneo
  // que nunca le contestó; con la llave del orquestador, así que NO devuelve el documento (ese es del
  // panel, con su llave). Ante la duda no contesta: un registro o una base que fallan son 503, nunca un
  // `false` que el orquestador tomaría como prueba de que la mesa no existió.
  router.get(
    MATCH_EXISTENCE_ROUTE,
    guard,
    validated({ params: MATCH_PARAMS }, async ({ params }, response) => {
      let live: boolean;
      let recorded: boolean;
      try {
        [live, recorded] = await Promise.all([
          deps.registry.isLive(params.matchId),
          deps.archive.hasRecord(params.matchId),
        ]);
      } catch (error) {
        deps.logger.warn("no se pudo saber si la partida existe", {
          matchId: params.matchId,
          error: String(error),
        });
        sendError(response, 503, "UNAVAILABLE");
        return;
      }
      response.json({ status: "success", data: { live, recorded } });
    }),
  );
  // Del CLÚSTER, no de este proceso: el censo es el hash que escriben todas las salas.
  router.get(CENSUS_ROUTE, guard, async (_request, response) => {
    const { playersInMatch, byGameMode, byTournament } = await deps.registry.census();
    response.json({
      status: "success",
      data: {
        playersInMatch,
        byGameMode: [...byGameMode].map(([gameModeId, players]) => ({
          gameModeId,
          playersInMatch: players,
        })),
        byTournament: [...byTournament].map(([tournamentId, players]) => ({
          tournamentId,
          playersInMatch: players,
        })),
      },
    });
  });
  return router;
}
