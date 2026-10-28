import type { Logger } from "@/logger";
import { type AdminTokenCheck, adminOf, requireAdminKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import { Router } from "express";
import type { GameModeService } from "../../service";
import {
  BASE,
  DELETED_MESSAGE,
  NOT_FOUND_MESSAGE,
  REACTIVATED_MESSAGE,
  sendData,
  sendError,
  sendMessage,
} from "./responses";
import {
  CATALOG_SOURCE_BODY,
  COPY_SHARED_BODY,
  CREATE_BODY,
  PROVIDER_PARAMS,
  SUBSCRIPTION_PARAMS,
  UPDATE_BODY,
  UUID_PARAMS,
  createInputOf,
  toAdminDTO,
  toCatalogDTO,
  updateInputOf,
} from "./schemas";

// LAS MUTACIONES DEL PANEL Y SUS DOS LECTURAS, detrás de su llave.
//
// QUIÉN ENTRA A CADA UNA lo dice su puerta (`requireAdminKey`), y el default es el cerrado: Betaso
// Games con rol `admin`. Las que abren a los admins de OPERADOR (`providers`) delegan el ámbito en el
// servicio, que sabe de quién es cada modo; las de sólo lectura (`read`) abren también a `support`.
//
// | ruta                                     | Betaso Games | operador                       | support |
// |------------------------------------------|--------------|--------------------------------|---------|
// | GET  /game-modes/admin, /admin/:uuid      | todo         | los suyos + compartidos que juega | lee  |
// | POST /game-modes                          | sí           | sólo propios suyos             | no      |
// | PUT, DELETE, GET reactive/:uuid           | todo         | sólo los propios suyos         | no      |
// | PUT|DELETE /:uuid/subscriptions/:provider | cualquiera   | sólo a sí mismo                | no      |
// | POST /game-modes/copy-shared              | cualquiera   | sólo para sí mismo             | no      |
// | GET  /game-modes/catalogs/:providerId     | cualquiera   | sólo el suyo                   | lee     |
// | PUT  /game-modes/catalogs/:providerId     | cualquiera   | sólo el suyo                   | no      |
export function adminRoutes({
  service,
  logger,
  adminApiKey,
  adminTokens,
}: {
  readonly service: GameModeService;
  readonly logger: Logger;
  readonly adminApiKey: string | undefined;
  readonly adminTokens?: AdminTokenCheck;
}): Router {
  const router = Router();

  // FAIL CLOSED, y es la decisión del incremento entero: sin llave configurada las mutaciones NO
  // EXISTEN. La alternativa —registrarlas y comparar contra vacío— deja endpoints que configuran
  // dinero real respondiendo sin credencial, y el operador los ve contestar y los cree protegidos.
  if (!adminApiKey) {
    // LAS RUTAS VAN EN EL MENSAJE. El que llega a este log llega desde un 404 inexplicable en el
    // panel y busca por path: sin el path acá, el aviso que explica el 404 es justamente el que no
    // encuentra.
    const missing = [
      `POST ${BASE}`,
      `PUT ${BASE}/:uuid`,
      `POST ${BASE}/copy-shared`,
      `GET|PUT ${BASE}/catalogs/:providerId`,
      `PUT|DELETE ${BASE}/:uuid/subscriptions/:providerId`,
      `DELETE ${BASE}/:uuid`,
      `GET ${BASE}/reactive/:uuid`,
      `GET ${BASE}/admin`,
      `GET ${BASE}/admin/:uuid`,
    ].join(", ");
    logger.warn(
      `API administrativa del catálogo deshabilitada: falta ADMIN_API_KEY, no se registran ${missing}`,
    );
    return router;
  }

  // LAS PUERTAS: las dos abren a los operadores, que el servicio acota; sólo `scopedReader` a `support`.
  const scoped = requireAdminKey(adminApiKey, adminTokens, { providers: true });
  const scopedReader = requireAdminKey(adminApiKey, adminTokens, { providers: true, read: true });

  // LAS LECTURAS DEL PANEL, con los dados de baja incluidos. Van acá y no en `catalog.ts` porque
  // son administrativas, y ANTES de `reactive/:uuid` y de todo lo demás por el mismo motivo que
  // aquél: el admin se monta primero (`register.ts`), así que `/game-modes/admin` le gana al
  // `/:uuid` público, que lo tomaría por el uuid de un modo llamado "admin".
  router.get(
    `${BASE}/admin`,
    scopedReader,
    validated({}, async (_input, response) => {
      const admin = adminOf(response);
      const modes = await service.listFor(admin);
      sendData(
        response,
        200,
        modes.map((mode) => toAdminDTO(mode, admin)),
      );
    }),
  );

  router.get(
    `${BASE}/admin/:uuid`,
    scopedReader,
    validated({ params: UUID_PARAMS }, async ({ params }, response) => {
      const admin = adminOf(response);
      const mode = await service.getFor(admin, params.uuid);
      if (!mode) {
        response.status(404).json({ status: "error", message: NOT_FOUND_MESSAGE });
        return;
      }
      sendData(response, 200, toAdminDTO(mode, admin));
    }),
  );

  // `reactive/:uuid` ES UNA MUTACIÓN aunque conserve el verbo GET por compatibilidad, así que va
  // detrás de la llave y SIN `read`: un `support` no reactiva. Y VA ANTES DE `/:uuid`: hoy Express
  // no las confunde —`/game-modes/reactive/x` son dos segmentos y `/:uuid` matchea uno solo, medido
  // contra la 5.2 instalada—, pero el orden es lo único que protege a esta ruta el día que se agregue
  // un `GET /game-modes/:a/:b`, y revertirlo convertiría toda reactivación en una consulta del modo
  // llamado "reactive". Lo pinea el test que asserta la lista de registros en orden.
  router.get(
    `${BASE}/reactive/:uuid`,
    // LA CREDENCIAL PRIMERO Y EL SCHEMA DESPUÉS, en todas las mutaciones: al revés, un anónimo
    // puede distinguir "forma inválida" de "forma válida" en una ruta que no tiene derecho a
    // tocar.
    scoped,
    validated({ params: UUID_PARAMS }, async ({ params }, response) => {
      try {
        await service.reactivate(adminOf(response), params.uuid);
        sendMessage(response, REACTIVATED_MESSAGE);
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  router.post(
    BASE,
    scoped,
    validated({ body: CREATE_BODY }, async ({ body }, response) => {
      try {
        const admin = adminOf(response);
        // 201 y no 200, igual que v1 (`routes.ts:94`).
        sendData(
          response,
          201,
          toAdminDTO(await service.create(admin, createInputOf(body)), admin),
        );
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  router.put(
    `${BASE}/:uuid`,
    scoped,
    validated({ params: UUID_PARAMS, body: UPDATE_BODY }, async ({ params, body }, response) => {
      try {
        const admin = adminOf(response);
        const updated = await service.update(admin, params.uuid, updateInputOf(body));
        sendData(response, 200, toAdminDTO(updated, admin));
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  // LA COPIA DE LOS COMPARTIDOS QUE UN OPERADOR JUEGA a modos propios. 200 y no 201 aunque cree: es
  // idempotente, y el segundo llamado —el reintento de una copia a medias— no crea lo que ya estaba.
  // Tampoco la tapa nada: no hay `POST /game-modes/:uuid`.
  router.post(
    `${BASE}/copy-shared`,
    scoped,
    validated({ body: COPY_SHARED_BODY }, async ({ body }, response) => {
      try {
        sendData(response, 200, await service.copyShared(adminOf(response), body.providerId));
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  // LA FUENTE DEL CATÁLOGO DE UN OPERADOR (`shared` | `own`). Dos segmentos después de la base, así
  // que no la tapa `/:uuid`; y va antes que las suscripciones, que tampoco la confunden.
  router.get(
    `${BASE}/catalogs/:providerId`,
    scopedReader,
    validated({ params: PROVIDER_PARAMS }, async ({ params }, response) => {
      try {
        sendData(
          response,
          200,
          toCatalogDTO(await service.catalogOf(adminOf(response), params.providerId)),
        );
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  // PASAR A `own` EXIGE UN MODO PROPIO ACTIVO: 409 si no hay (`GameModeStateConflictError`).
  router.put(
    `${BASE}/catalogs/:providerId`,
    scoped,
    validated(
      { params: PROVIDER_PARAMS, body: CATALOG_SOURCE_BODY },
      async ({ params, body }, response) => {
        try {
          const catalog = await service.setCatalogSource(
            adminOf(response),
            params.providerId,
            body.source,
          );
          sendData(response, 200, toCatalogDTO(catalog));
        } catch (error) {
          sendError(response, error);
        }
      },
    ),
  );

  // LAS SUSCRIPCIONES: tres segmentos, así que `/:uuid` no las tapa.
  router.put(
    `${BASE}/:uuid/subscriptions/:providerId`,
    scoped,
    validated({ params: SUBSCRIPTION_PARAMS }, async ({ params }, response) => {
      try {
        const admin = adminOf(response);
        const mode = await service.subscribe(admin, params.uuid, params.providerId);
        sendData(response, 200, toAdminDTO(mode, admin));
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  router.delete(
    `${BASE}/:uuid/subscriptions/:providerId`,
    scoped,
    validated({ params: SUBSCRIPTION_PARAMS }, async ({ params }, response) => {
      try {
        const admin = adminOf(response);
        const mode = await service.unsubscribe(admin, params.uuid, params.providerId);
        sendData(response, 200, toAdminDTO(mode, admin));
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  router.delete(
    `${BASE}/:uuid`,
    scoped,
    validated({ params: UUID_PARAMS }, async ({ params }, response) => {
      try {
        // SIN `data`, igual que v1 (`routes.ts:167-170`): la baja devuelve el mensaje y nada más.
        await service.softDelete(adminOf(response), params.uuid);
        sendMessage(response, DELETED_MESSAGE);
      } catch (error) {
        sendError(response, error);
      }
    }),
  );
  return router;
}
