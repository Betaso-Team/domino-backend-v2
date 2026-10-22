import type { Logger } from "@/logger";
import { type AdminTokenCheck, requireAdminKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import { type Response, Router } from "express";
import { z } from "zod";
import type { MatchArchive } from "../../network/history";

// En consts para que el aviso de arranque y el registro no puedan divergir.
export const MATCHES_ROUTE = "/internal/matches";
export const MATCH_ROUTE = "/internal/matches/:matchId";
export const GAME_DATA_ROUTE = "/game-data/:roomId";

// LA FORMA DEL HISTORIAL DE SOPORTE (`./history.ts`): largo acotado y sin caracteres de control. El
// `matchId` lo elige el orquestador y el `roomId` Colyseus, y `/game-data` acepta cualquiera de los
// dos, así que no hay un alfabeto que fijar sin rechazar partidas legítimas.
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\P{Cc}+$/u, "id inválido");
const MATCH_PARAMS = z.object({ matchId: id });
const ROOM_PARAMS = z.object({ roomId: id });

// LA PÁGINA LLEGA COMO TEXTO —es la query— y se valida como número entero: `?page=abc` o
// `?pageSize=1000` son 400 y no una página vacía o la colección entera de una vez. El tope de 100 es
// lo que impide que un panel pida todo el historial en un solo request.
const PAGE_QUERY = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const NOT_FOUND_MESSAGE = "Partida no encontrada";

// EL ENVELOPE DE LAS RUTAS DEL PANEL, el mismo de las lecturas administrativas del catálogo
// (`features/game-mode/transports/http/admin.ts`): `{ status, data }` al encontrar y
// `{ status, message }` al no encontrar. Se escribe acá y no se importa de allá porque es de otra
// feature, y una ruta del dominó no puede depender de los mensajes del catálogo.
const sendData = (response: Response, data: unknown) => response.json({ status: "success", data });

/**
 * EL REGISTRO DE CADA PARTIDA, para quien lo mira entero: el panel (el listado y el detalle) y el
 * backend principal (`/game-data`). Detrás de la llave de administración, o de un admin con sesión,
 * porque el documento se escribe mientras se juega y tiene la mano de todos —la del rival incluida—.
 */
export function recordRoutes({
  logger,
  archive,
  adminApiKey,
  adminTokens,
}: {
  readonly logger: Logger;
  readonly archive: MatchArchive;
  /** `undefined` ⇒ las rutas NO se registran. */
  readonly adminApiKey: string | undefined;
  readonly adminTokens?: AdminTokenCheck;
}): Router {
  const router = Router();
  // FAIL CLOSED, como el historial y el catálogo: sin llave las tres rutas no existen, y el aviso las
  // nombra para que el que llega desde un 404 encuentre por qué.
  if (!adminApiKey) {
    logger.warn(
      `API interna deshabilitada: falta ADMIN_API_KEY, no se registran GET ${MATCHES_ROUTE}, GET ${MATCH_ROUTE} ni GET ${GAME_DATA_ROUTE}`,
    );
    return router;
  }
  // Primero QUIÉN SOS y después QUÉ MANDASTE: al revés, un anónimo distinguiría una forma inválida de
  // una válida en rutas que no tiene derecho a tocar.
  const admin = requireAdminKey(adminApiKey, adminTokens);

  // EL LISTADO, sólo `GET`: el `POST` del mismo path es del orquestador, con su propia llave
  // (`./tables.ts`), y Express los separa por método. La más nueva primero, sin `timeline` ni `rounds`.
  router.get(
    MATCHES_ROUTE,
    admin,
    validated({ query: PAGE_QUERY }, async ({ query }, response) => {
      const { items, total } = await archive.page(query.page, query.pageSize);
      sendData(response, { items, page: query.page, pageSize: query.pageSize, total });
    }),
  );

  // EL DETALLE: el documento entero, con su `_id` como texto. `/:matchId` matchea UN segmento, así que
  // `/:matchId/history` (`./history.ts`) no le llega; igual se registra después de aquél (el orden
  // lo pinea `register.ts`).
  router.get(
    MATCH_ROUTE,
    admin,
    validated({ params: MATCH_PARAMS }, async ({ params }, response) => {
      const record = await archive.recordOf(params.matchId);
      if (!record) {
        response.status(404).json({ status: "error", message: NOT_FOUND_MESSAGE });
        return;
      }
      sendData(response, record);
    }),
  );

  // EL CONTRATO ES DEL BACKEND PRINCIPAL y no del panel, igual que en truco (`4472332`): el detalle de
  // un movimiento de billetera le pide `/game-data/:roomId` a cada servidor de juego y muestra lo que
  // vuelve. Por eso va el documento PELADO —sin envelope y sin `_id`— y el 404 con su código.
  router.get(
    GAME_DATA_ROUTE,
    admin,
    validated({ params: ROOM_PARAMS }, async ({ params }, response) => {
      const snapshot = await archive.snapshotOf(params.roomId);
      if (!snapshot) {
        response.status(404).json({ error: "MATCH_NOT_FOUND" });
        return;
      }
      response.json(snapshot);
    }),
  );
  return router;
}
