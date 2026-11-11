import type { Logger } from "@/logger";
import { type AdminTokenCheck, adminOf, requireAdminKey } from "@/shared/http/api-key";
import { sendError } from "@/shared/http/errors";
import { validated } from "@/shared/http/validated";
import { type Response, Router } from "express";
import { z } from "zod";
import {
  MATCH_END_REASONS,
  MATCH_STATUSES,
  type MatchArchive,
  type MatchCursor,
  MatchListTimeoutError,
} from "../../network/history";

// En consts para que el aviso de arranque y el registro no puedan divergir.
export const MATCHES_ROUTE = "/internal/matches";
export const MATCH_ROUTE = "/internal/matches/:matchId";
export const GAME_DATA_ROUTE = "/game-data/:roomId";

// LA FORMA DEL HISTORIAL DE SOPORTE (`./history.ts`): largo acotado y sin caracteres de control. El
// `matchId` lo elige el orquestador y el `roomId` Colyseus, y `/game-data` acepta cualquiera de los
// dos, así que no hay un alfabeto que fijar sin rechazar partidas legítimas. La misma regla vale para el
// `userId` del filtro y de `./players.ts`.
export const id = z
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
    matchEndReason: z.enum(MATCH_END_REASONS).optional(),
    status: z.enum(MATCH_STATUSES).optional(),
    tournamentId: id.optional(),
    providerId: id.optional(),
  })
  .refine(({ from, to }) => !from || !to || from.getTime() <= to.getTime(), {
    message: "`from` no puede ser posterior a `to`",
    path: ["from"],
  });

const TIMEOUT_MESSAGE = "La búsqueda tardó demasiado; acota el rango de fechas";

// EL ENVELOPE DE LAS RUTAS DEL PANEL: `{ status, data }` al encontrar. Los errores salen
// `{ code, detail? }` (`@/shared/http/errors`), como en todo el dominó.
const sendData = (response: Response, data: unknown) => response.json({ status: "success", data });

/**
 * DE QUÉ PROVEEDOR SON LAS PARTIDAS QUE SE LISTAN, o `undefined` después de contestar el 404. Un admin
 * de proveedor, siempre el suyo: un `?providerId=` igual se acepta y uno distinto es 404
 * `UNKNOWN_PROVIDER` —lo de otro proveedor no existe para éste—. Tablea Gaming (token sin `prv`, o la
 * llave) filtra
 * por el que nombre, o por ninguno (`null`).
 */
function listedProviderOf(
  response: Response,
  asked: string | undefined,
): string | null | undefined {
  const { provider } = adminOf(response);
  if (provider === null) return asked ?? null;
  if (asked !== undefined && asked !== provider) {
    sendError(response, 404, "UNKNOWN_PROVIDER");
    return undefined;
  }
  return provider;
}

/** ¿Algún asiento del registro es de este proveedor? Un documento sin asientos no es de nadie. */
const hasProviderSeat = (record: Record<string, unknown>, provider: string): boolean =>
  Array.isArray(record.seats) &&
  record.seats.some((seat) => (seat as { providerId?: unknown } | null)?.providerId === provider);

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
  // LAS TRES SON LECTURAS (`support` incluido). EL LISTADO Y EL DETALLE ABREN A LOS PROVEEDORES, acotados
  // por el `providerId` que el registro guarda en cada asiento (`seats[].providerId`, lo manda el
  // orquestador): un admin de proveedor ve sólo las partidas donde se sentó alguno de sus jugadores, y
  // una sin el campo —grabada antes de que el orquestador lo mandara— sólo la ve Tablea Gaming.
  //
  // ⚠ EN UNA CASUAL CRUZADA LOS DOS PROVEEDORES VEN EL DOCUMENTO ENTERO, el asiento del rival incluido
  // (su `userId`, su nombre, su mano en la timeline). Es aceptado: es la partida que jugó su jugador, y
  // recortarla dejaría un registro que no se puede rebobinar.
  //
  // `/game-data` sigue siendo de Tablea Gaming: es el contrato del backend principal, no del panel.
  const admin = requireAdminKey(adminApiKey, adminTokens, { read: true });
  const scoped = requireAdminKey(adminApiKey, adminTokens, { read: true, providers: true });

  // EL LISTADO, sólo `GET`: el `POST` del mismo path es del orquestador, con su propia llave
  // (`./tables.ts`), y Express los separa por método. La más nueva primero, sin `timeline` ni `rounds`,
  // paginado por cursor (`MatchCursor`) y con el total que se puede contar barato (`MatchListPage`).
  router.get(
    MATCHES_ROUTE,
    scoped,
    validated({ query: LIST_QUERY }, async ({ query }, response) => {
      // EL PROVEEDOR DEL TOKEN SE FUERZA: un admin de proveedor no puede listar sin él.
      const providerId = listedProviderOf(response, query.providerId);
      if (providerId === undefined) return;
      const {
        pageSize,
        after,
        from,
        to,
        matchId,
        roomId,
        id,
        userId,
        matchEndReason,
        status,
        tournamentId,
      } = query;
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
          ...(matchEndReason === undefined ? {} : { matchEndReason }),
          ...(status === undefined ? {} : { status }),
          ...(tournamentId === undefined ? {} : { tournamentId }),
          ...(providerId === null ? {} : { providerId }),
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
        sendError(response, 503, "MATCH_LIST_TIMEOUT", TIMEOUT_MESSAGE);
      }
    }),
  );

  // EL DETALLE: el documento entero, con su `_id` como texto. `/:matchId` matchea UN segmento, así que
  // `/:matchId/history` (`./history.ts`) no le llega; igual se registra después de aquél (el orden
  // lo pinea `register.ts`).
  //
  // Un admin de proveedor recibe 404 por una partida en la que no se sentó ninguno de sus jugadores, igual
  // que por una que no existe: lo de otro proveedor no existe para él.
  router.get(
    MATCH_ROUTE,
    scoped,
    validated({ params: MATCH_PARAMS }, async ({ params }, response) => {
      const record = await archive.recordOf(params.matchId);
      const { provider } = adminOf(response);
      if (!record || (provider !== null && !hasProviderSeat(record, provider))) {
        sendError(response, 404, "MATCH_NOT_FOUND");
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
        sendError(response, 404, "MATCH_NOT_FOUND");
        return;
      }
      response.json(snapshot);
    }),
  );
  return router;
}
