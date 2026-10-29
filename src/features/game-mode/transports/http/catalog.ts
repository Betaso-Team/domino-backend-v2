import { validated } from "@/shared/http/validated";
import { Router } from "express";
import type { GameModeService } from "../../service";
import { BASE, NOT_FOUND_MESSAGE, sendData } from "./responses";
import { UUID_PARAMS, toDTO } from "./schemas";

// LAS DOS LECTURAS DEL CATÁLOGO, públicas: el jugador necesita la lista para entrar a una mesa.
//
// SÓLO LOS COMPARTIDOS ACTIVOS, con la forma de siempre (sin dueño ni suscriptores). Un modo propio es
// la configuración de UN proveedor: no se lista, y `/:uuid` lo contesta 404 como a uno que no existe.
// Lo que cada proveedor ofrece de verdad —sus propios y los compartidos que juega— lo arma el
// orquestador con `GET /internal/game-modes`; esta lista es la de Betaso Games, como antes.
export function catalogRoutes({ service }: { readonly service: GameModeService }): Router {
  const router = Router();

  router.get(
    BASE,
    validated({}, async (_input, response) => {
      sendData(response, 200, (await service.listPublic()).map(toDTO));
    }),
  );

  router.get(
    `${BASE}/:uuid`,
    validated({ params: UUID_PARAMS }, async ({ params }, response) => {
      // Sólo activos: desde afuera un modo dado de baja NO EXISTE, y devolverlo acá lo dejaría
      // elegible para quien arma las mesas. Y sólo compartidos (ver arriba).
      const mode = await service.getPublic(params.uuid);
      if (!mode) {
        response.status(404).json({ status: "error", message: NOT_FOUND_MESSAGE });
        return;
      }
      sendData(response, 200, toDTO(mode));
    }),
  );
  return router;
}
