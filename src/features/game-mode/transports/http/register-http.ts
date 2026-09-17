import { randomUUID } from "node:crypto";
import type { Logger } from "@/logger";
import { requireInternalKey } from "@/shared/http/internal-key";
import { validated } from "@/shared/http/validated";
import type { Application, Response } from "express";
import {
  DuplicateGameModeError,
  GameModeNotFoundError,
  GameModeStateConflictError,
  GameModeWriteBusyError,
} from "../../core/catalog";
import type { GameModeService } from "../../service";
import {
  CREATE_BODY,
  UPDATE_BODY,
  UUID_PARAMS,
  createInputOf,
  toDTO,
  updateInputOf,
} from "./schemas";

// LAS SIETE RUTAS DEL CATÁLOGO DE v1, con sus métodos, sus paths y su envelope
// (`Betaso-Domino-Backend/src/game-modes/routes.ts`). Este archivo hace DOS cosas y ninguna más:
// ruteo y traducción de errores a códigos HTTP. La forma de lo que entra y sale vive en
// `schemas.ts`; qué es un duplicado y qué se puede reactivar lo decide el servicio.
//
// LO QUE CAMBIA RESPECTO DE v1 ES QUIÉN AUTORIZA. Allá cada mutación llevaba
// `authMiddleware.isAuthenticated()` + `isAuthorized('admin')`, o sea que domino validaba al
// administrador. Acá el panel NO autentica administradores contra domino: el orquestador valida al
// admin y llama con `X-Internal-Key`. Los dos GET siguen públicos porque el jugador necesita el
// catálogo para entrar a una mesa.

const BASE = "/game-modes";

// LOS MENSAJES LITERALES DE v1, y son parte del contrato: el panel los muestra. El del 404 sale en
// las cuatro rutas que v1 lo tenía (`routes.ts:41-44`, `:71-74`, `:121-124`, `:162-165`).
const NOT_FOUND_MESSAGE = "Modo de juego no encontrado";
const DELETED_MESSAGE = "Modo de juego eliminado correctamente";
const REACTIVATED_MESSAGE = "Modo de juego reactivado correctamente";

export interface GameModeHttpDeps {
  readonly service: GameModeService;
  readonly logger: Logger;
  /** `undefined` ⇒ las cinco mutaciones NO se registran. Ver el fail closed de abajo. */
  readonly internalApiKey: string | undefined;
}

// EL ENVELOPE HISTÓRICO, en dos funciones para que ninguna ruta lo escriba a mano: v1 contesta
// `{ status, data }` cuando devuelve un modo y `{ status, message }` cuando devuelve un resultado, y
// mezclarlos es lo que rompe al panel sin que nada falle de este lado.
function sendData(response: Response, status: number, data: unknown): void {
  response.status(status).json({ status: "success", data });
}

function sendMessage(response: Response, message: string): void {
  response.json({ status: "success", message });
}

// LA TRADUCCIÓN DE LOS CUATRO ERRORES DE APLICACIÓN, Y EL `throw` DEL FINAL ES LA MITAD DEL ARCHIVO.
// Lo que no reconoce se RELANZA: `validated` lo reenvía a `next` y el manejador compartido lo loguea
// con stack y contesta 500. v1 hacía lo contrario —un `catch (error)` por ruta que convertía
// cualquier cosa en 500 con un mensaje genérico—, y ahí se le perdían los dos casos que esta tarea
// recupera: el «ya está inactivo» (que ahora es 409) y el cuerpo inválido (que ahora es 400).
//
// Traducir lo desconocido a 404 sería peor todavía: le diría al panel que el modo no existe cuando
// lo que pasa es que la base no contesta, y manda al operador a auditar el modo equivocado.
function sendError(response: Response, error: unknown): void {
  if (error instanceof GameModeNotFoundError) {
    // EL MENSAJE LITERAL DE v1 Y NO EL DEL ERROR: es el que el panel muestra, y el del servicio
    // ("no existe el modo <uuid>") está escrito para el log del operador.
    response.status(404).json({ status: "error", message: NOT_FOUND_MESSAGE });
    return;
  }
  // 409 LOS DOS, y con nombres distintos a propósito: el duplicado es la regla de unicidad y el
  // conflicto de estado es «ya está inactivo»/«ya está activo». Comparten código porque los dos son
  // un choque con el estado actual, no con la forma del pedido.
  if (error instanceof DuplicateGameModeError || error instanceof GameModeStateConflictError) {
    response.status(409).json({ status: "error", message: error.message });
    return;
  }
  // 503 Y NO 500: el lease lo tiene otro proceso. Nadie hizo nada mal y reintentar es la respuesta
  // correcta, que es justo lo que un 500 no dice.
  if (error instanceof GameModeWriteBusyError) {
    response.status(503).json({ status: "error", message: error.message });
    return;
  }
  throw error;
}

export function registerGameModeHttp(app: Application, deps: GameModeHttpDeps): void {
  const { service, logger, internalApiKey } = deps;

  app.get(
    BASE,
    validated({}, async (_input, response) => {
      sendData(response, 200, (await service.listActive()).map(toDTO));
    }),
  );

  // `reactive/:uuid` ES UNA MUTACIÓN aunque conserve el verbo GET por compatibilidad, así que va
  // detrás de la llave. Y VA ANTES DE `/:uuid`: hoy Express no las confunde —`/game-modes/reactive/x`
  // son dos segmentos y `/:uuid` matchea uno solo, medido contra la 5.2 instalada—, pero el orden es
  // lo único que protege a esta ruta el día que se agregue un `GET /game-modes/:a/:b`, y revertirlo
  // convertiría toda reactivación en una consulta del modo llamado "reactive". Lo pinea el test que
  // asserta la lista de registros en orden.
  if (internalApiKey) {
    app.get(
      `${BASE}/reactive/:uuid`,
      // LA CREDENCIAL PRIMERO Y EL SCHEMA DESPUÉS, en las cinco mutaciones: al revés, un anónimo
      // puede distinguir "forma inválida" de "forma válida" en una ruta que no tiene derecho a
      // tocar.
      requireInternalKey(internalApiKey),
      validated({ params: UUID_PARAMS }, async ({ params }, response) => {
        try {
          await service.reactivate(params.uuid);
          sendMessage(response, REACTIVATED_MESSAGE);
        } catch (error) {
          sendError(response, error);
        }
      }),
    );
  }

  app.get(
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

  // FAIL CLOSED, y es la decisión del incremento entero: sin llave configurada las mutaciones NO
  // EXISTEN. La alternativa —registrarlas y comparar contra vacío— deja endpoints que configuran
  // dinero real respondiendo sin credencial, y el operador los ve contestar y los cree protegidos.
  if (!internalApiKey) {
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
      `API administrativa del catálogo deshabilitada: falta INTERNAL_API_KEY, no se registran ${missing}`,
    );
    return;
  }

  app.post(
    BASE,
    requireInternalKey(internalApiKey),
    validated({ body: CREATE_BODY }, async ({ body }, response) => {
      try {
        // 201 y no 200, igual que v1 (`routes.ts:94`).
        sendData(response, 201, toDTO(await service.create(createInputOf(body))));
      } catch (error) {
        sendError(response, error);
      }
    }),
  );

  app.put(
    `${BASE}/:uuid`,
    requireInternalKey(internalApiKey),
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
  app.post(
    `${BASE}/sync`,
    requireInternalKey(internalApiKey),
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

  app.delete(
    `${BASE}/:uuid`,
    requireInternalKey(internalApiKey),
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
}
