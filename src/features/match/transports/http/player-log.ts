import { type TokenVerifier, authenticated } from "@/features/auth";
import { Router } from "express";
import { z } from "zod";
import type { PlayerLog } from "../../network/player-log";

const PAGE_QUERY = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

// LO QUE JUGÓ EL QUE PREGUNTA. Cuelga de `/me` y el portador del token es el SUJETO de la respuesta:
// no hay forma de preguntar por otro, así que no hay autorización que se pueda equivocar. Sin
// verificador o sin registro de partidas, las dos rutas no existen.
export function playerLogRoutes(deps: {
  readonly verifier?: TokenVerifier;
  readonly playerLog?: PlayerLog;
}): Router {
  const router = Router();
  const { verifier, playerLog } = deps;
  if (!verifier || !playerLog) return router;
  router.get(
    "/me/matches",
    authenticated(verifier, { query: PAGE_QUERY }, async (identity, { query }, response) => {
      response.json(await playerLog.pageOf(identity.userId, query.page, query.limit));
    }),
  );
  router.get(
    "/me/metrics",
    authenticated(verifier, {}, async (identity, _input, response) => {
      response.json(await playerLog.statsOf(identity.userId));
    }),
  );
  return router;
}
