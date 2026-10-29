import type { Logger } from "@/logger";
import { type AdminTokenCheck, requireAdminKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import { type Response, Router } from "express";
import { z } from "zod";
import { type MatchArchive, type MatchCursor, MatchListTimeoutError } from "../../network/history";

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

// EL `_id` DE UN DOCUMENTO: un `ObjectId` en texto. Se aceptan mayúsculas y se pasa a minúscula, que es
// como lo escribe Mongo y como lo compara el listado.
const objectId = z
  .string()
  .regex(/^[0-9a-fA-F]{24}$/, "`id` es un ObjectId: 24 hexadecimales")
  .transform((value) => value.toLowerCase());

// UN INSTANTE ISO 8601 con hora y zona (`Z` u offset): `2026-10-01T00:00:00.000Z`. Una fecha sola no,
// porque "el 1 de octubre" en Caracas y en UTC son dos rangos distintos y el panel tiene que decir cuál.
const instant = z.iso
  .datetime({ offset: true, message: "fecha inválida: ISO 8601 con hora y zona" })
  .transform((value) => new Date(value));

// EL CURSOR ES OPACO PARA EL PANEL y es nuestro: base64url de `{ t, id }` —el `createdAt` en epoch ms y
// el `_id` de la última fila—. Se valida entero al volver, porque lo que vuelve lo escribió el
// cliente: cualquier cosa que no sea exactamente lo que emitimos es 400 y no una página arbitraria.
const CURSOR_JSON = z
  .object({ t: z.number().int().min(0).max(8.64e15), id: z.string().regex(/^[0-9a-f]{24}$/) })
  .strict();

function encodeCursor(cursor: MatchCursor): string {
  return Buffer.from(JSON.stringify({ t: cursor.createdAt.getTime(), id: cursor.id })).toString(
    "base64url",
  );
}

const cursor = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_-]+$/, "cursor inválido")
  .transform((raw, context): MatchCursor => {
    const parsed = CURSOR_JSON.safeParse(jsonOf(Buffer.from(raw, "base64url").toString("utf8")));
    if (!parsed.success) {
      context.addIssue({ code: "custom", message: "cursor inválido" });
      return z.NEVER;
    }
    return { createdAt: new Date(parsed.data.t), id: parsed.data.id };
  });

function jsonOf(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// EL LISTADO, todo opcional. Un parámetro que no está acá se ignora —es la regla de `validated`, que
// valida lo que la ruta declara—, pero uno que está y no se entiende es 400: un filtro descartado en
// silencio mostraría partidas que nadie pidió como si fueran las pedidas. El tope de 100 es lo que
// impide que un panel pida todo el historial en un solo request.
const LIST_QUERY = z
  .object({
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    after: cursor.optional(),
    from: instant.optional(),
    to: instant.optional(),
    matchId: id.optional(),
    roomId: id.optional(),
    id: objectId.optional(),
    userId: id.optional(),
  })
  .refine(({ from, to }) => !from || !to || from.getTime() <= to.getTime(), {
    message: "`from` no puede ser posterior a `to`",
    path: ["from"],
  });

const NOT_FOUND_MESSAGE = "Partida no encontrada";
const TIMEOUT_MESSAGE = "La búsqueda tardó demasiado; acota el rango de fechas";

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
  //
  // LAS TRES SON LECTURAS DE BETASO GAMES (`support` incluido) y ningún admin de PROVEEDOR las abre: el
  // registro no guarda de qué proveedor es cada asiento, así que no hay ámbito con el que acotarlo, y
  // abrirlas le mostraría a un proveedor las partidas —y los `userId`— de todos los demás.
  const admin = requireAdminKey(adminApiKey, adminTokens, { read: true });

  // EL LISTADO, sólo `GET`: el `POST` del mismo path es del orquestador, con su propia llave
  // (`./tables.ts`), y Express los separa por método. La más nueva primero, sin `timeline` ni `rounds`,
  // paginado por cursor (`MatchCursor`) y con el total que se puede contar barato (`MatchListPage`).
  router.get(
    MATCHES_ROUTE,
    admin,
    validated({ query: LIST_QUERY }, async ({ query }, response) => {
      const { pageSize, after, from, to, matchId, roomId, id, userId } = query;
      try {
        const page = await archive.list({
          pageSize,
          ...(after ? { after } : {}),
          ...(from ? { from } : {}),
          ...(to ? { to } : {}),
          ...(matchId === undefined ? {} : { matchId }),
          ...(roomId === undefined ? {} : { roomId }),
          ...(id === undefined ? {} : { id }),
          ...(userId === undefined ? {} : { userId }),
        });
        sendData(response, {
          items: page.items,
          pageSize,
          nextCursor: page.next ? encodeCursor(page.next) : null,
          total: page.total,
          totalExact: page.totalExact,
        });
      } catch (error) {
        // EL PLAZO VENCIDO NO ES UN BUG NUESTRO —es una búsqueda demasiado ancha para la base de ese
        // momento—, así que no es un 500: es 503 con qué hacer. Cualquier otro fallo sí sube.
        if (!(error instanceof MatchListTimeoutError)) throw error;
        logger.warn("listado de partidas: la base excedió el plazo", { query: { ...query } });
        response.status(503).json({ status: "error", message: TIMEOUT_MESSAGE });
      }
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
