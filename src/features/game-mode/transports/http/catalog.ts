import { validated } from "@/shared/http/validated";
import { Router } from "express";
import type { GameModeService } from "../../service";
import { BASE, NOT_FOUND_MESSAGE, sendData } from "./responses";
import { UUID_PARAMS, toDTO } from "./schemas";

// LAS DOS LECTURAS DEL CATÁLOGO, públicas: el jugador necesita la lista para entrar a una mesa.
export function catalogRoutes({ service }: { readonly service: GameModeService }): Router {
  const router = Router();

  router.get(
    BASE,
    validated({}, async (_input, response) => {
      sendData(response, 200, (await service.listActive()).map(toDTO));
    }),
  );

  router.get(
    `${BASE}/:uuid`,
    validated({ params: UUID_PARAMS }, async ({ params }, response) => {
      // `getActive` y no `get`: desde afuera un modo dado de baja NO EXISTE, y devolverlo acá lo
      // dejaría elegible en el lobby público.
      const mode = await service.getActive(params.uuid);
      if (!mode) {
        response.status(404).json({ status: "error", message: NOT_FOUND_MESSAGE });
        return;
      }
      sendData(response, 200, toDTO(mode));
    }),
  );
  return router;
}
