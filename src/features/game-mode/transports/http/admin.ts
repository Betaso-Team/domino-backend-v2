import { randomUUID } from "node:crypto";
import type { Logger } from "@/logger";
import { requireAdminPanelKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import { Router } from "express";
import type { GameModeService } from "../../service";
import {
  BASE,
  DELETED_MESSAGE,
  REACTIVATED_MESSAGE,
  sendData,
  sendError,
  sendMessage,
} from "./responses";
import {
  CREATE_BODY,
  UPDATE_BODY,
  UUID_PARAMS,
  createInputOf,
  toDTO,
  updateInputOf,
} from "./schemas";

// LAS CINCO MUTACIONES DEL PANEL, detrás de su llave.
export function adminRoutes({
  service,
  logger,
  adminPanelApiKey,
}: {
  readonly service: GameModeService;
  readonly logger: Logger;
  readonly adminPanelApiKey: string | undefined;
}): Router {
  const router = Router();

  // FAIL CLOSED, y es la decisión del incremento entero: sin llave configurada las mutaciones NO
  // EXISTEN. La alternativa —registrarlas y comparar contra vacío— deja endpoints que configuran
  // dinero real respondiendo sin credencial, y el operador los ve contestar y los cree protegidos.
  if (!adminPanelApiKey) {
    // LAS RUTAS VAN EN EL MENSAJE. El que llega a este log llega desde un 404 inexplicable en el
    // panel y busca por path: sin el path acá, el aviso que explica el 404 es justamente el que no
    // encuentra.
    const missing = [
      `POST ${BASE}`,
      `PUT ${BASE}/:uuid`,
      `POST ${BASE}/sync`,
      `DELETE ${BASE}/:uuid`,
      `GET ${BASE}/reactive/:uuid`,
    ].join(", ");
    logger.warn(
      `API administrativa del catálogo deshabilitada: falta BETASO_ADMIN_PANEL_API_KEY, no se registran ${missing}`,
    );
    return router;
  }

  // `reactive/:uuid` ES UNA MUTACIÓN aunque conserve el verbo GET por compatibilidad, así que va
  // detrás de la llave. Y VA ANTES DE `/:uuid`: hoy Express no las confunde —`/game-modes/reactive/x`
  // son dos segmentos y `/:uuid` matchea uno solo, medido contra la 5.2 instalada—, pero el orden es
  // lo único que protege a esta ruta el día que se agregue un `GET /game-modes/:a/:b`, y revertirlo
  // convertiría toda reactivación en una consulta del modo llamado "reactive". Lo pinea el test que
  // asserta la lista de registros en orden.
  router.get(
    `${BASE}/reactive/:uuid`,
    // LA CREDENCIAL PRIMERO Y EL SCHEMA DESPUÉS, en las cinco mutaciones: al revés, un anónimo
    // puede distinguir "forma inválida" de "forma válida" en una ruta que no tiene derecho a
    // tocar.
    requireAdminPanelKey(adminPanelApiKey),
    validated({ params: UUID_PARAMS }, async ({ params }, response) => {
      try {
        await service.reactivate(params.uuid);
        sendMessage(response, REACTIVATED_MESSAGE);
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  router.post(
    BASE,
    requireAdminPanelKey(adminPanelApiKey),
    validated({ body: CREATE_BODY }, async ({ body }, response) => {
      try {
        // 201 y no 200, igual que v1 (`routes.ts:94`).
        sendData(response, 201, toDTO(await service.create(createInputOf(body))));
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  router.put(
    `${BASE}/:uuid`,
    requireAdminPanelKey(adminPanelApiKey),
    validated({ params: UUID_PARAMS, body: UPDATE_BODY }, async ({ params, body }, response) => {
      try {
        sendData(response, 200, toDTO(await service.update(params.uuid, updateInputOf(body))));
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  // DESPUÉS DEL `POST` DE LA COLECCIÓN y sin que nada lo tape: son dos paths distintos y no hay
  // `POST /game-modes/:uuid` que pueda absorberlo. El orden es el del plan y el del archivo de v1.
  router.post(
    `${BASE}/sync`,
    requireAdminPanelKey(adminPanelApiKey),
    validated({}, async (_input, response) => {
      try {
        // EL LOTE SE GENERA ACÁ, UNO POR REQUEST, y no es un detalle: la clave de deduplicación del
        // outbox lleva el `batchId` (`["game_mode.sync", batchId, uuid]`) justamente para que este
        // botón fuerce el evento aunque esa revisión ya se haya publicado. Con un id fijo, el
        // segundo apretón del botón de recuperación no encolaría NADA y contestaría éxito igual.
        sendData(response, 200, await service.syncAll(randomUUID()));
      } catch (error) {
        // TAMBIÉN VA ADENTRO DEL LEASE aunque no toque el catálogo —escribe el outbox—, así que
        // también puede salir ocupado. Sin este `catch`, el único desenlace que este botón tiene
        // además del éxito se vería como un 500: el operador que aprieta "republicar todo" mientras
        // otro proceso edita leería una caída donde hay un "reintentá".
        sendError(response, error);
      }
    }),
  );

  router.delete(
    `${BASE}/:uuid`,
    requireAdminPanelKey(adminPanelApiKey),
    validated({ params: UUID_PARAMS }, async ({ params }, response) => {
      try {
        // SIN `data`, igual que v1 (`routes.ts:167-170`): la baja devuelve el mensaje y nada más.
        await service.softDelete(params.uuid);
        sendMessage(response, DELETED_MESSAGE);
      } catch (error) {
        sendError(response, error);
      }
    }),
  );
  return router;
}
