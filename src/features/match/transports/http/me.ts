import { type TokenVerifier, authenticated } from "@/features/auth";
import type { Logger } from "@/logger";
import { type Response, Router } from "express";
import { z } from "zod";
import { MatchListTimeoutError } from "../../network/history";
import type { MatchRow, Paginated, PlayerLog } from "../../network/player-log";

export const ME_MATCHES_ROUTE = "/me/matches";

// LA PÁGINA, con la ventana que pide el cliente. Con techo porque el tamaño lo manda el que llama, y
// una página de diez mil es un pedido que lee una cuenta entera. Los mismos nombres y límites que truco.
export const PAGE_QUERY = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const TIMEOUT_MESSAGE = "El historial tardó demasiado; inténtalo de nuevo";

/**
 * LA PÁGINA DE UNA CUENTA, la misma para el dueño del token y para el panel (`./players.ts`): cambia
 * quién pregunta y el envelope (`send`), no lo que se lee ni cómo falla.
 */
export async function sendPlayerPage(
  deps: { readonly players: PlayerLog; readonly logger: Logger },
  userId: string,
  query: z.infer<typeof PAGE_QUERY>,
  response: Response,
  send: (page: Paginated<MatchRow>) => unknown = (page) => page,
): Promise<void> {
  try {
    const page = await deps.players.pageOf(userId, query.page, query.limit);
    response.set("Cache-Control", "no-store").json(send(page));
  } catch (error) {
    // EL PLAZO VENCIDO NO ES UN BUG NUESTRO: 503, como el listado del panel. Lo demás sube.
    if (!(error instanceof MatchListTimeoutError)) throw error;
    deps.logger.warn("historial del jugador: la base excedió el plazo", { page: query.page });
    response.status(503).json({ status: "error", message: TIMEOUT_MESSAGE });
  }
}

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
  const { verifier } = deps;
  if (!verifier) return router;

  router.get(
    ME_MATCHES_ROUTE,
    authenticated(verifier, { query: PAGE_QUERY }, (identity, { query }, response) =>
      sendPlayerPage(deps, identity.userId, query, response),
    ),
  );
  return router;
}
