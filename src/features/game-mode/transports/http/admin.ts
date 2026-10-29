import type { Logger } from "@/logger";
import { type AdminTokenCheck, adminOf, requireAdminKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import { type Response, Router } from "express";
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
  CREATE_BODY,
  PROVIDER_QUERY,
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
// Games con rol `admin`. Las que abren a los admins de PROVEEDOR (`providers`) delegan el ámbito en el
// servicio, que sabe de quién es cada modo; las de sólo lectura (`read`) abren también a `support`.
//
// | ruta                                     | Betaso Games | proveedor                      | support |
// |------------------------------------------|--------------|--------------------------------|---------|
// | GET  /game-modes/admin, /admin/:uuid      | todo         | los suyos + compartidos que juega | lee  |
// | POST /game-modes                          | sí           | sólo propios suyos             | no      |
// | PUT, DELETE, GET reactive/:uuid           | todo         | sólo los propios suyos         | no      |
// | PUT|DELETE /:uuid/subscription            | ?providerId= | él mismo                       | no      |
// | POST /game-modes/copies                   | ?providerId= | para él mismo                  | no      |
// | PUT  /game-modes/source                   | ?providerId= | la suya                        | no      |
//
// EL PROVEEDOR SOBRE EL QUE SE ACTÚA SALE DEL TOKEN, nunca del path ni del cuerpo: ver `providerOf`.
// `GET /game-modes/admin` lo acepta opcional y, si hay uno resuelto, suma la fuente de su catálogo.

/**
 * SOBRE QUÉ PROVEEDOR ACTÚA el pedido, o `undefined` después de contestar por qué ninguno. Un admin de
 * proveedor, el suyo (un `?providerId=` igual al suyo se acepta, uno distinto es 403); Betaso Games
 * —token sin `prv`, o la llave— el que nombre con `?providerId=`, y sin él es 400. Es el mismo patrón
 * que los webhooks del orquestador (`reports/transports/http/webhooks.ts`).
 */
function providerOf(response: Response, asked: string | undefined): string | undefined {
  const { provider } = adminOf(response);
  if (provider === null) {
    if (asked !== undefined) return asked;
    response.status(400).json({
      status: "error",
      code: "PROVIDER_REQUIRED",
      message: "falta ?providerId=: Betaso Games indica sobre qué operador actúa",
    });
    return undefined;
  }
  if (asked !== undefined && asked !== provider) {
    response.status(403).json({
      status: "error",
      code: "FORBIDDEN",
      message: "un operador sólo actúa sobre sí mismo",
    });
    return undefined;
  }
  return provider;
}

// LO MISMO, PERO OPCIONAL PARA BETASO GAMES: el listado del panel sin `?providerId=` es el catálogo
// entero. `null` = Betaso Games sin proveedor; `undefined` = ya se contestó el 403.
function optionalProviderOf(
  response: Response,
  asked: string | undefined,
): string | null | undefined {
  if (adminOf(response).provider === null && asked === undefined) return null;
  return providerOf(response, asked);
}

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
      `POST ${BASE}/copies`,
      `PUT ${BASE}/source`,
      `PUT ${BASE}/:uuid`,
      `PUT|DELETE ${BASE}/:uuid/subscription`,
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

  // LAS PUERTAS: las dos abren a los proveedores, que el servicio acota; sólo `scopedReader` a `support`.
  const scoped = requireAdminKey(adminApiKey, adminTokens, { providers: true });
  const scopedReader = requireAdminKey(adminApiKey, adminTokens, { providers: true, read: true });

  // LAS LECTURAS DEL PANEL, con los dados de baja incluidos. Van acá y no en `catalog.ts` porque
  // son administrativas, y ANTES de `reactive/:uuid` y de todo lo demás por el mismo motivo que
  // aquél: el admin se monta primero (`register.ts`), así que `/game-modes/admin` le gana al
  // `/:uuid` público, que lo tomaría por el uuid de un modo llamado "admin".
  //
  // CON UN PROVEEDOR RESUELTO (el del token, o el `?providerId=` de Betaso Games) la respuesta suma
  // `source`, la fuente de su catálogo: `{ status, data, source }`. Betaso Games sin `?providerId=`
  // ve todos los modos y ninguna fuente, porque no hay un catálogo del que hablar.
  router.get(
    `${BASE}/admin`,
    scopedReader,
    validated({ query: PROVIDER_QUERY }, async ({ query }, response) => {
      const admin = adminOf(response);
      const providerId = optionalProviderOf(response, query.providerId);
      if (providerId === undefined) return;
      if (providerId === null) {
        const modes = await service.listFor(admin);
        sendData(
          response,
          200,
          modes.map((mode) => toAdminDTO(mode, admin)),
        );
        return;
      }
      try {
        const [modes, catalog] = await Promise.all([
          service.listFor(admin, providerId),
          service.catalogOf(admin, providerId),
        ]);
        response.status(200).json({
          status: "success",
          data: modes.map((mode) => toAdminDTO(mode, admin)),
          source: catalog.source,
        });
      } catch (error) {
        sendError(response, error);
      }
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

  // LA COPIA DE LOS COMPARTIDOS QUE EL PROVEEDOR JUEGA a modos propios suyos. Sin cuerpo: el proveedor
  // es el resuelto. 200 y no 201 aunque cree: es idempotente, y el segundo llamado —el reintento de
  // una copia a medias— no crea lo que ya estaba. No la tapa nada: no hay `POST /game-modes/:uuid`.
  router.post(
    `${BASE}/copies`,
    scoped,
    validated({ query: PROVIDER_QUERY }, async ({ query }, response) => {
      const providerId = providerOf(response, query.providerId);
      if (providerId === undefined) return;
      try {
        sendData(response, 200, await service.createCopies(adminOf(response), providerId));
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  // LA FUENTE DEL CATÁLOGO DEL PROVEEDOR (`shared` | `own`). Pasar a `own` exige un modo propio activo:
  // 409 si no hay (`GameModeStateConflictError`). Se lee en `GET /game-modes/admin` (`source`).
  //
  // ⚠ VA ANTES DE `PUT /:uuid`: es un solo segmento, y al revés todo cambio de fuente sería la edición
  // del modo llamado "source". Lo pinea el test que asserta la lista de registros en orden.
  router.put(
    `${BASE}/source`,
    scoped,
    validated(
      { query: PROVIDER_QUERY, body: CATALOG_SOURCE_BODY },
      async ({ query, body }, response) => {
        const providerId = providerOf(response, query.providerId);
        if (providerId === undefined) return;
        try {
          const catalog = await service.setCatalogSource(
            adminOf(response),
            providerId,
            body.source,
          );
          sendData(response, 200, toCatalogDTO(catalog));
        } catch (error) {
          sendError(response, error);
        }
      },
    ),
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

  // LAS SUSCRIPCIONES DEL PROVEEDOR RESUELTO: tres segmentos, así que `/:uuid` no las tapa.
  router.put(
    `${BASE}/:uuid/subscription`,
    scoped,
    validated(
      { params: UUID_PARAMS, query: PROVIDER_QUERY },
      async ({ params, query }, response) => {
        const providerId = providerOf(response, query.providerId);
        if (providerId === undefined) return;
        try {
          const admin = adminOf(response);
          const mode = await service.subscribe(admin, params.uuid, providerId);
          sendData(response, 200, toAdminDTO(mode, admin));
        } catch (error) {
          sendError(response, error);
        }
      },
    ),
  );

  router.delete(
    `${BASE}/:uuid/subscription`,
    scoped,
    validated(
      { params: UUID_PARAMS, query: PROVIDER_QUERY },
      async ({ params, query }, response) => {
        const providerId = providerOf(response, query.providerId);
        if (providerId === undefined) return;
        try {
          const admin = adminOf(response);
          const mode = await service.unsubscribe(admin, params.uuid, providerId);
          sendData(response, 200, toAdminDTO(mode, admin));
        } catch (error) {
          sendError(response, error);
        }
      },
    ),
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
