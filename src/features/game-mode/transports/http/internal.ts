import type { Logger } from "@/logger";
import { requireApiKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import { Router } from "express";
import type { GameModeService } from "../../service";
import { sendData } from "./responses";
import { INTERNAL_QUERY, toInternalDTO } from "./schemas";

export const INTERNAL_GAME_MODES_ROUTE = "/internal/game-modes";

// EL CATÁLOGO PARA EL ORQUESTADOR: todos los modos activos —compartidos y propios— con su dueño y sus
// suscriptores (`null` en un legado, que se ofrece a todos los operadores). Con eso arma el catálogo
// efectivo de cada operador y decide qué modo puede pedir cada jugador; el dominó no lo verifica al
// abrir la mesa. `?includeInactive=1` suma los dados de baja, para resolver el modo de una partida
// vieja.
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
      const modes = await service.listInternal({ includeInactive: query.includeInactive === "1" });
      sendData(response, 200, modes.map(toInternalDTO));
    }),
  );
  return router;
}
