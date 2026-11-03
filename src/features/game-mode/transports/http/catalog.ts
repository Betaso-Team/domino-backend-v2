import { validated } from "@/shared/http/validated";
import { Router } from "express";
import type { GameModeService } from "../../service";
import { BASE, sendData, sendModeNotFound } from "./responses";
import { UUID_PARAMS, toDTO } from "./schemas";

// LAS DOS LECTURAS DEL CATÁLOGO, públicas: el jugador necesita la lista para entrar a una mesa.
//
// SÓLO LOS COMPARTIDOS ACTIVOS, con la forma de siempre (sin dueño ni suscriptores). Un modo propio es
// la configuración de UN proveedor: no se lista, y `/:uuid` lo contesta 404 como a uno que no existe.
// Lo que cada proveedor ofrece de verdad —sus propios y los compartidos que juega— lo arma el
// orquestador con `GET /internal/game-modes`; esta lista es la de Betaso Games, como antes.
//
// CACHEABLES DIEZ SEGUNDOS, y sólo los 200: es la misma lista para todos los jugadores, y el servicio ya
// la guarda cinco (`PUBLIC_MEMO_MS`). Un 404 sale `no-store`: un modo que se publica en este momento no
// puede quedar «inexistente» en un caché intermedio.
const PUBLIC_CACHE = "public, max-age=10";

export function catalogRoutes({ service }: { readonly service: GameModeService }): Router {
  const router = Router();

  router.get(
    BASE,
    validated({}, async (_input, response) => {
      const modes = await service.listPublic();
      response.set("Cache-Control", PUBLIC_CACHE);
      sendData(response, 200, modes.map(toDTO));
    }),
  );

  router.get(
    `${BASE}/:uuid`,
    validated({ params: UUID_PARAMS }, async ({ params }, response) => {
      // Sólo activos: desde afuera un modo dado de baja NO EXISTE, y devolverlo acá lo dejaría
      // elegible para quien arma las mesas. Y sólo compartidos (ver arriba).
      const mode = await service.getPublic(params.uuid);
      if (!mode) {
        response.set("Cache-Control", "no-store");
        sendModeNotFound(response);
        return;
      }
      response.set("Cache-Control", PUBLIC_CACHE);
      sendData(response, 200, toDTO(mode));
    }),
  );
  return router;
}
