import { type TokenVerifier, authenticated } from "@/features/auth";
import type { Logger } from "@/logger";
import { sendError } from "@/shared/http/errors";
import { type Response, Router } from "express";
import { z } from "zod";
import { MatchListTimeoutError } from "../../network/history";
import type { MatchRow, Paginated, PlayerLog } from "../../network/player-log";
import type { PlayerStats, PlayerStatsStore } from "../../network/player-stats";

export const ME_MATCHES_ROUTE = "/me/matches";
export const ME_STATS_ROUTE = "/me/stats";

/** La forma pública de las estadísticas: `winRate` con dos decimales y la racha máxima de victorias. */
export function statsView(stats: PlayerStats): {
  gamesPlayed: number;
  gamesWon: number;
  gamesWonFourPlayers: number;
  gamesAbandoned: number;
  winRate: number;
  maxWinStreak: number;
} {
  return {
    gamesPlayed: stats.gamesPlayed,
    gamesWon: stats.gamesWon,
    gamesWonFourPlayers: stats.gamesWonFourPlayers,
    gamesAbandoned: stats.gamesAbandoned,
    winRate:
      stats.gamesPlayed === 0 ? 0 : Math.round((stats.gamesWon / stats.gamesPlayed) * 100) / 100,
    maxWinStreak: stats.maxStreak,
  };
}

// LA PÁGINA, con la ventana que pide el cliente. Con techo porque el tamaño lo manda el que llama, y
// una página de diez mil es un pedido que lee una cuenta entera. Los mismos nombres y límites que truco.
export const PAGE_QUERY = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const TIMEOUT_MESSAGE = "El historial tardó demasiado; inténtalo de nuevo";
const STATS_TIMEOUT_MESSAGE = "Las estadísticas tardaron demasiado; inténtalo de nuevo";

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
    sendError(response, 503, "MATCH_LIST_TIMEOUT", TIMEOUT_MESSAGE);
  }
}

/**
 * LO QUE JUGÓ EL DUEÑO DEL TOKEN (truco `features/match/transports/http/history.ts`). Cuelga de `/me` y
 * la cuenta es el `sub` del token: no hay forma de preguntar por otro, así que no hay autorización que
 * equivocar. Sin verificador no se registra, como `/matches/:roomId`.
 */
export function meRoutes(deps: {
  readonly players: PlayerLog;
  readonly stats: PlayerStatsStore;
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

  // LAS ESTADÍSTICAS DEL DUEÑO DEL TOKEN: el `userId` de un query no cambia de quién se contesta.
  router.get(
    ME_STATS_ROUTE,
    authenticated(verifier, {}, async (identity, _input, response) => {
      try {
        const stats = await deps.stats.of(identity.userId);
        response.set("Cache-Control", "no-store").json(statsView(stats));
      } catch (error) {
        // Como el historial: el plazo vencido es 503 y lo demás sube.
        if (!(error instanceof MatchListTimeoutError)) throw error;
        deps.logger.warn("estadísticas del jugador: la base excedió el plazo");
        sendError(response, 503, "STATS_TIMEOUT", STATS_TIMEOUT_MESSAGE);
      }
    }),
  );
  return router;
}
