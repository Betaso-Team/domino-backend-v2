import type { Logger } from "@/logger";
import { requireApiKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import { Router } from "express";
import { z } from "zod";
import type { ColyseusMatchGateway } from "../colyseus/gateway";
import { createMatchRequestSchema } from "../match-contract";
import type { MatchRegistry } from "../match-registry";

// En consts para que el aviso de arranque y el registro no puedan divergir.
export const OPEN_TABLE_ROUTE = "/internal/matches";
export const SEAT_BACK_ROUTE = "/internal/players/:userId/seat";
export const CENSUS_ROUTE = "/internal/census";

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

export interface TablesDeps {
  readonly tables: Pick<ColyseusMatchGateway, "openRequest" | "seatBack">;
  readonly registry: Pick<MatchRegistry, "matchOf" | "publicConfigOf" | "census">;
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
      `API del orquestador deshabilitada: falta ORCHESTRATOR_API_KEY, no se registran ${OPEN_TABLE_ROUTE}, ${SEAT_BACK_ROUTE} ni ${CENSUS_ROUTE}`,
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
        response.status(422).json({ error: code });
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
        response.status(404).json({ error: "NO_LIVE_MATCH" });
        return;
      }
      response.json({ status: "success", data: { matchId: config.matchId, reservation } });
    }),
  );
  // Del CLÚSTER, no de este proceso: el censo es el hash que escriben todas las salas.
  router.get(CENSUS_ROUTE, guard, async (_request, response) => {
    const { playersInMatch, byGameMode } = await deps.registry.census();
    response.json({
      status: "success",
      data: {
        playersInMatch,
        byGameMode: [...byGameMode].map(([gameModeId, players]) => ({
          gameModeId,
          playersInMatch: players,
        })),
      },
    });
  });
  return router;
}
