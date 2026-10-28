import type { Logger } from "@/logger";
import { type AdminTokenCheck, requireAdminKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import { Router } from "express";
import { z } from "zod";
import type { PlayerLog } from "../../network/player-log";
import { PAGE_QUERY, sendPlayerPage } from "./me";
import { id } from "./records";

export const PLAYER_MATCHES_ROUTE = "/internal/players/:userId/matches";

const PLAYER_PARAMS = z.object({ userId: id });

/**
 * LO QUE JUGÓ UNA CUENTA, para el panel: la vista de `GET /me/matches` (`./me.ts`) con la cuenta en el
 * path en vez de en el token. Por eso va detrás de la llave de administración, o de un admin con
 * sesión: es la única puerta para preguntar por otro. Vive bajo `/internal/players/:userId`, al lado
 * del asiento del orquestador (`./tables.ts`), y el `data` del envelope del panel es la página tal
 * cual la ve el jugador.
 */
export function playerRoutes({
  players,
  logger,
  adminApiKey,
  adminTokens,
}: {
  readonly players: PlayerLog;
  readonly logger: Logger;
  /** `undefined` ⇒ la ruta NO se registra. */
  readonly adminApiKey: string | undefined;
  readonly adminTokens?: AdminTokenCheck;
}): Router {
  const router = Router();
  // FAIL CLOSED, como el resto de las rutas de administración.
  if (!adminApiKey) {
    logger.warn(
      `API interna deshabilitada: falta ADMIN_API_KEY, no se registra GET ${PLAYER_MATCHES_ROUTE}`,
    );
    return router;
  }
  router.get(
    PLAYER_MATCHES_ROUTE,
    requireAdminKey(adminApiKey, adminTokens, { read: true }),
    validated({ params: PLAYER_PARAMS, query: PAGE_QUERY }, ({ params, query }, response) =>
      sendPlayerPage({ players, logger }, params.userId, query, response, (data) => ({
        status: "success",
        data,
      })),
    ),
  );
  return router;
}
