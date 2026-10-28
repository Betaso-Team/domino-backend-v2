import type { Logger } from "@/logger";
import { requireApiKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import { Router } from "express";
import type { GameModeService } from "../../service";
import { INTERNAL_QUERY, catalogSourcesOf, toInternalDTO } from "./schemas";

export const INTERNAL_GAME_MODES_ROUTE = "/internal/game-modes";

// EL CATÁLOGO PARA EL ORQUESTADOR, en una sola lectura:
//
//   { status: "success", data: [modo...], catalogs: { [providerId]: "own" } }
//
// `data` son todos los modos activos —compartidos y propios— con su dueño y sus
// suscriptores (una lista explícita: `[]` es nadie). Con eso arma el catálogo
// efectivo de cada operador y decide qué modo puede pedir cada jugador; el dominó no lo verifica al
// abrir la mesa. `?includeInactive=1` suma los dados de baja, para resolver el modo de una partida
// vieja. `catalogs` son las FUENTES que se apartan del default: un operador que no aparece está en
// `shared` (compartidos activos suscritos); uno en `own` juega sólo sus propios activos. Van en la
// misma respuesta para que el orquestador no pueda leer modos y fuentes de dos momentos distintos.
//
// CON LA LLAVE DEL ORQUESTADOR y fail closed, igual que las mesas (`features/match/.../tables.ts`):
// sin `ORCHESTRATOR_API_KEY` la ruta no existe. La del panel no la abre: el panel tiene su propia
// lectura, con el ámbito de cada admin.
export function internalRoutes({
  service,
  logger,
  orchestratorApiKey,
}: {
  readonly service: GameModeService;
  readonly logger: Logger;
  readonly orchestratorApiKey: string | undefined;
}): Router {
  const router = Router();
  if (!orchestratorApiKey) {
    logger.warn(
      `catálogo del orquestador deshabilitado: falta ORCHESTRATOR_API_KEY, no se registra GET ${INTERNAL_GAME_MODES_ROUTE}`,
    );
    return router;
  }
  router.get(
    INTERNAL_GAME_MODES_ROUTE,
    requireApiKey(orchestratorApiKey),
    validated({ query: INTERNAL_QUERY }, async ({ query }, response) => {
      const { modes, catalogs } = await service.listInternal({
        includeInactive: query.includeInactive === "1",
      });
      response.status(200).json({
        status: "success",
        data: modes.map(toInternalDTO),
        catalogs: catalogSourcesOf(catalogs),
      });
    }),
  );
  return router;
}
