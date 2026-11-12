import type { Logger } from "@/logger";
import { requireApiKey } from "@/shared/http/api-key";
import { sendError } from "@/shared/http/errors";
import { validated } from "@/shared/http/validated";
import { Router } from "express";
import { z } from "zod";
import type { MatchArchive } from "../../network/history";
import type { ColyseusMatchGateway } from "../colyseus/gateway";
import { createMatchRequestSchema } from "../match-contract";
import type { MatchRegistry, PublicMatchConfig } from "../match-registry";

// En consts para que el aviso de arranque y el registro no puedan divergir.
export const OPEN_TABLE_ROUTE = "/internal/matches";
export const SEAT_BACK_ROUTE = "/internal/players/:userId/seat";
export const CENSUS_ROUTE = "/internal/census";
export const PLAYER_MATCH_ROUTE = "/internal/players/:userId/match";
// Dos segmentos después de `matches`: no compite con el detalle del panel (`/internal/matches/:matchId`,
// un segmento) ni con `/:matchId/history` (otro literal).
export const MATCH_EXISTENCE_ROUTE = "/internal/matches/:matchId/existence";

const MATCH_PARAMS = z.object({
  matchId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\P{Cc}+$/u, "matchId inválido"),
});

// Misma forma que el `matchId` del historial: largo acotado y sin controles, porque este id entra
// del llamador y termina en una clave del registro compartido.
const SEAT_PARAMS = z.object({
  userId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\P{Cc}+$/u, "userId inválido"),
});

// LOS RECHAZOS DE LA SALA LLEGAN COMO MENSAJE: Colyseus propaga el `message` del error de
// `onCreate` al que pidió crearla, y el código va adelante (ver `match-contract.ts`).
const REFUSAL = /^(SEAT_COUNT_MISMATCH):/;

// LA CLASE DE LA MESA en las respuestas que la ubican: el orquestador separa las de torneo. Las mesas
// anotadas antes de los torneos no traen `mode` en el registro, y son casuales.
function modeFieldsOf(config: PublicMatchConfig) {
  return {
    mode: config.mode ?? "CASUAL",
    ...(config.tournamentId === undefined ? {} : { tournamentId: config.tournamentId }),
  };
}

export interface TablesDeps {
  readonly tables: Pick<ColyseusMatchGateway, "openRequest" | "seatBack" | "isGone">;
  readonly registry: Pick<
    MatchRegistry,
    "matchOf" | "publicConfigOf" | "census" | "forget" | "isLive"
  >;
  /** Si una partida tiene registro, sin leerlo: `GET .../existence`. */
  readonly archive: Pick<MatchArchive, "hasRecord">;
  /**
   * EL ESTADO DE LAS ENTRADAS DEL OUTBOX DE RESULTADOS por clave (`<matchId>:finished|aborted`), para el
   * `outcome` de `GET .../existence`. Rechaza si la base no contesta.
   */
  readonly results: {
    statuses(keys: readonly string[]): Promise<ReadonlyMap<string, string>>;
  };
  readonly logger: Logger;
  /** `undefined` ⇒ las rutas NO se registran (fail closed, como el historial). */
  readonly orchestratorApiKey: string | undefined;
}

export type MatchOutcome = "none" | "pending" | "published";

// PENDIENTE GANA A PUBLICADO: sólo puede haber los dos en una partida de antes de la exclusión por
// desenlace, y mientras algo de ella siga sin salir, no está todo dicho.
export function outcomeOf(statuses: ReadonlyMap<string, string>): MatchOutcome {
  const values = [...statuses.values()];
  if (values.some((status) => status === "PENDING" || status === "PARKED")) return "pending";
  if (values.some((status) => status === "SENT")) return "published";
  return "none";
}

/**
 * LA API QUE USA EL ORQUESTADOR: abrir una mesa, devolverle su asiento a quien sigue jugando y
 * contar quién está jugando, por proveedor, moneda y mesa, para los números de su lobby.
 * Primero la llave, después la forma: al revés un anónimo aprendería el contrato gratis.
 */
export function tablesRoutes(deps: TablesDeps): Router {
  const router = Router();
  if (!deps.orchestratorApiKey) {
    deps.logger.warn(
      `API del orquestador deshabilitada: falta ORCHESTRATOR_API_KEY, no se registran ${OPEN_TABLE_ROUTE}, ${SEAT_BACK_ROUTE}, ${PLAYER_MATCH_ROUTE}, ${MATCH_EXISTENCE_ROUTE} ni ${CENSUS_ROUTE}`,
    );
    return router;
  }
  const guard = requireApiKey(deps.orchestratorApiKey);

  router.post(
    OPEN_TABLE_ROUTE,
    guard,
    validated({ body: createMatchRequestSchema }, async ({ body }, response) => {
      try {
        const table = await deps.tables.openRequest(body);
        response.status(201).json({ status: "success", data: table });
      } catch (error) {
        // UN DUPLICADO QUE NO ENCONTRÓ LA SALA A TIEMPO: la está abriendo otro pedido. Reintentable.
        if (error instanceof Error && error.message.startsWith("MATCH_OPENING:")) {
          sendError(response, 409, "MATCH_OPENING");
          return;
        }
        const code = error instanceof Error ? REFUSAL.exec(error.message)?.[1] : undefined;
        // Todo lo que no es un rechazo de la sala es NUESTRO: 500, no un 422 que lo disfrace.
        if (!code) throw error;
        sendError(response, 422, code);
      }
    }),
  );

  // LA SALA QUE YA NO EXISTE NO RETIENE AL JUGADOR (truco `53d1030`, T-04). Su proceso murió sin
  // `onDispose`, así que su entrada de `player_match` sigue ahí hasta vencer (`TTL_SECONDS`); el
  // gateway confirma contra el matchmaker que la sala no está, y acá se borra la entrada antes de
  // contestar 404: el orquestador lo vuelve a poner a buscar, y la próxima pregunta ya no la encuentra.
  router.post(
    SEAT_BACK_ROUTE,
    guard,
    validated({ params: SEAT_PARAMS }, async ({ params }, response) => {
      const roomId = await deps.registry.matchOf(params.userId);
      const config = roomId ? await deps.registry.publicConfigOf(roomId) : undefined;
      const reservation = roomId && config ? await deps.tables.seatBack(roomId) : undefined;
      if (roomId && config && reservation === undefined) {
        await deps.registry.forget(params.userId, roomId);
      }
      if (!config || reservation === undefined) {
        sendError(response, 404, "NO_LIVE_MATCH");
        return;
      }
      response.json({
        status: "success",
        data: { matchId: config.matchId, ...modeFieldsOf(config), reservation },
      });
    }),
  );
  // EN QUÉ MESA ESTÁ SENTADO, SIN RESERVAR NADA. Es la pregunta del orquestador cuando solo necesita
  // saber si el jugador tiene partida viva (para no abrirle otra): dos GET al registro compartido y
  // una lectura del registro de salas de Colyseus, sin reservar. `POST .../seat` contesta lo mismo
  // pero además reserva un asiento, que es lo caro y lo que solo hace falta para volver a entrar.
  //
  // LA SALA SE CONFIRMA (T-04): una entrada de `player_match` cuya sala ya no figura en el matchmaker
  // es de un proceso muerto, y contestar 200 por ella dejaba al jugador trabado hasta que vencía. Se
  // borra y se contesta 404. Si la pregunta falla o no contesta a tiempo, se contesta como hoy: «no sé»
  // no es «no existe».
  router.get(
    PLAYER_MATCH_ROUTE,
    guard,
    validated({ params: SEAT_PARAMS }, async ({ params }, response) => {
      const roomId = await deps.registry.matchOf(params.userId);
      const config = roomId ? await deps.registry.publicConfigOf(roomId) : undefined;
      if (!roomId || !config) {
        sendError(response, 404, "NO_LIVE_MATCH");
        return;
      }
      if (await deps.tables.isGone(roomId)) {
        await deps.registry.forget(params.userId, roomId);
        sendError(response, 404, "NO_LIVE_MATCH");
        return;
      }
      response.json({
        status: "success",
        data: { matchId: config.matchId, roomId, ...modeFieldsOf(config) },
      });
    }),
  );
  // SI UNA PARTIDA EXISTE, y nada más: si su mesa sigue viva (el registro del clúster), si quedó
  // registro de ella (el archivo) y en qué está su DESENLACE en el outbox de resultados (`outcome`):
  //
  //   none       ninguna entrada `finished` ni `aborted` de esa partida
  //   pending    hay una sin publicar todavía (`PENDING`, o `PARKED` esperando que alguien la reproduzca)
  //   published  el broker la confirmó (`SENT`; compactada o no, la lápida no vence)
  //
  // El orquestador aborta el ledger de una mesa casual paga —reembolsa las entradas— SOLO con
  // `live: false && outcome: "none"` pasada la duración máxima de una partida: un `none` falso
  // reembolsaría una partida cuyo resultado sí existe. Por eso ante la duda no contesta: un registro o
  // una base que fallan son 503, nunca un `false` ni un `none`. Con la llave del orquestador, así que NO
  // devuelve el documento (ese es del panel, con su llave).
  router.get(
    MATCH_EXISTENCE_ROUTE,
    guard,
    validated({ params: MATCH_PARAMS }, async ({ params }, response) => {
      let live: boolean;
      let recorded: boolean;
      let statuses: ReadonlyMap<string, string>;
      try {
        [live, recorded, statuses] = await Promise.all([
          deps.registry.isLive(params.matchId),
          deps.archive.hasRecord(params.matchId),
          deps.results.statuses([`${params.matchId}:finished`, `${params.matchId}:aborted`]),
        ]);
      } catch (error) {
        deps.logger.warn("no se pudo saber si la partida existe", {
          matchId: params.matchId,
          error: String(error),
        });
        sendError(response, 503, "UNAVAILABLE");
        return;
      }
      response.json({ status: "success", data: { live, recorded, outcome: outcomeOf(statuses) } });
    }),
  );
  // Del CLÚSTER, no de este proceso: el censo es el hash que escriben todas las salas. CAMPO POR CAMPO:
  // cada grupo con su proveedor, su moneda, exactamente una mesa (el modo de una casual o el torneo de
  // una de torneo) y sus jugadores. Es del orquestador, que decide qué grupos ve cada proveedor.
  router.get(CENSUS_ROUTE, guard, async (_request, response) => {
    const { playersInMatch, groups } = await deps.registry.census();
    response.json({
      status: "success",
      data: {
        playersInMatch,
        groups: groups.map((group) => ({
          providerId: group.providerId,
          currency: group.currency,
          ...(group.tournamentId === undefined
            ? { gameModeId: group.gameModeId }
            : { tournamentId: group.tournamentId }),
          playersInMatch: group.seats,
        })),
      },
    });
  });
  return router;
}
