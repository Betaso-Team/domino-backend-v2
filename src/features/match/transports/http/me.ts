import { type TokenVerifier, authenticated } from "@/features/auth";
import type { Logger } from "@/logger";
import { Router } from "express";
import { z } from "zod";
import { MatchListTimeoutError } from "../../network/history";
import type { PlayerLog } from "../../network/player-log";

export const ME_MATCHES_ROUTE = "/me/matches";

// LA PÁGINA, con la ventana que pide el cliente. Con techo porque el tamaño lo manda el que llama, y
// una página de diez mil es un pedido que lee una cuenta entera. Los mismos nombres y límites que truco.
const PAGE_QUERY = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const TIMEOUT_MESSAGE = "El historial tardó demasiado; inténtalo de nuevo";

/**
 * LO QUE JUGÓ EL DUEÑO DEL TOKEN (truco `features/match/transports/http/history.ts`). Cuelga de `/me` y
 * la cuenta es el `sub` del token: no hay forma de preguntar por otro, así que no hay autorización que
 * equivocar. Sin verificador no se registra, como `/matches/:roomId`.
 */
export function meRoutes(deps: {
  readonly players: PlayerLog;
  readonly verifier?: TokenVerifier;
  readonly logger: Logger;
}): Router {
  const router = Router();
  const { players, verifier, logger } = deps;
  if (!verifier) return router;

  router.get(
    ME_MATCHES_ROUTE,
    authenticated(verifier, { query: PAGE_QUERY }, async (identity, { query }, response) => {
      try {
        const page = await players.pageOf(identity.userId, query.page, query.limit);
        response.set("Cache-Control", "no-store").json(page);
      } catch (error) {
        // EL PLAZO VENCIDO NO ES UN BUG NUESTRO: 503, como el listado del panel. Lo demás sube.
        if (!(error instanceof MatchListTimeoutError)) throw error;
        logger.warn("historial del jugador: la base excedió el plazo", { page: query.page });
        response.status(503).json({ status: "error", message: TIMEOUT_MESSAGE });
      }
    }),
  );
  return router;
}
