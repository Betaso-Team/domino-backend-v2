import { z } from "zod";
import type { PlayerRef } from "../../../shared/player-ref.js";
// EL ÚNICO CRUCE DE `match` HACIA `game-mode`, y entra por la superficie de la feature (Regla 4):
// nada de este archivo sabe que el catálogo tiene un repositorio, un outbox ni una API. La arista
// va en un solo sentido —`game-mode` redeclaró su `Clock` estructural en la Tarea 4 justamente
// para no tener que importar de acá— y eso es lo que mantiene el grafo acíclico.
import type { GameMode } from "../../game-mode/index.js";
import type { DominoMatchConfig } from "../core/config.js";

// Contrato en la raíz de transports porque matchmaking crea las salas. `mode` lo deja
// discriminado para sumar otros orígenes sin adivinar por campos opcionales.
//
// ES LA ÚNICA FRONTERA QUE VALIDA, y por eso valida con zod y no con tipos: lo que llega
// por `createRoom` es un objeto del otro lado del cable, y un `CreateMatchRequest` escrito
// en la firma solo describe lo que se espera —no lo comprueba—. De acá para adentro el
// `DominoMatchConfig` es un dato confiable, y eso incluye la moneda, la tasa y los montos.
//
// SON DOS ENTRADAS Y POR ESO SON DOS FUNCIONES. `requestOf` valida lo que matchmaking PIDE —una
// mesa, unos participantes y el uuid de un modo—; `replayConfigOf` valida un snapshot YA GRABADO,
// que trae los asientos numerados y el dinero adentro. Meterlas en una sola con campos opcionales
// haría que la mesa que nace y la partida que se rebobina compartieran reglas que no comparten:
// el 4P se rechaza al nacer y se rebobina sin objeción, porque la historia ya pasó.
const nonBlank = z.string().refine((value) => value.trim().length > 0, "no puede estar vacío");

// LA IDENTIDAD SE NORMALIZA; LA MONEDA NO, y la asimetría es deliberada.
//
// `platformId` y `userUuid` son las dos mitades de una LLAVE: se comparan contra el token en
// `DominoRoom.onJoin` y se concatenan en la clave del registro. Validar con trim y guardar sin
// trim deja que `"betaso "` en el snapshot y `"betaso"` en el token sean el mismo jugador para
// el validador y dos distintos para el cruce — o sea `SeatNotReservedError` con la inscripción
// ya cobrada, por un espacio que nadie ve. `JwtVerifier` normaliza igual, y tienen que hacerlo
// las DOS fronteras: normalizar una sola mueve el problema en vez de cerrarlo.
//
// `currency` es un VALOR CONTABLE que se conserva exactamente como se cobró, no una llave que se
// compare con nada: el diseño pide congelarla, y tocarla acá sería este archivo decidiendo sobre
// dinero que ya se movió. Lo mismo vale para el perfil, que es presentación.
const identityPart = nonBlank.transform((value) => value.trim());

// LOS MONTOS SON UC COMPLETAS Y ADMITEN DECIMALES. `entryFee: 10` son diez UC: es la
// convención del catálogo de v1, de donde salen estos números, y un modo productivo puede
// tener `1.5`. Rechazar la fracción —como hacía `Number.isSafeInteger`— obligaría a
// escalar por 100 en la frontera, y el factor sobreviviría en una sola de las dos puntas
// el día que alguien lo toque.
//
// Lo que se sigue cerrando es todo lo demás, y cada refine cubre un fallo distinto:
// `.finite()` saca `NaN` e `Infinity` —montos que nadie puede acreditar y que contaminan
// cualquier aritmética posterior—, `.nonnegative()` saca el cobro al revés, y el techo del
// entero seguro saca el desborde de la mantisa, donde dos montos distintos son el mismo
// número. No se expresa con `.safe()` porque en zod 4 `.safe()` IMPLICA entero y rechazaría
// `1.5`, que es justo lo que esta frontera vino a aceptar (medido sobre la 4.6.1 instalada).
//
// SIGUE ACÁ AUNQUE EL REQUEST YA NO TRAIGA DINERO: lo trae el SNAPSHOT que el replay rebobina, y
// un fixture golden con un monto corrupto reconstruiría una partida cuya liquidación no cierra.
const ucAmount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);

const participant = z.strictObject({
  platformId: identityPart,
  userUuid: identityPart,
  displayName: nonBlank,
  username: nonBlank.optional(),
  profilePicture: nonBlank.optional(),
  currency: nonBlank,
});

const teamAssignment = z.enum(["SHUFFLED", "SEAT_ORDER"]);

// LAS DOS REGLAS QUE VALEN PARA LAS DOS ENTRADAS, escritas UNA vez: la mesa que nace y el
// snapshot que se rebobina tienen los mismos asientos, y dos copias de esto derivan el día que
// alguien arregle una sola.
function checkTableShape(
  seats: readonly { readonly platformId: string; readonly userUuid: string }[],
  context: z.RefinementCtx,
  path: string,
): void {
  // Una mesa impar no tiene parejas: `assignTeams` repartiría un equipo con un jugador
  // de más, y el marcador acreditaría puntos a un equipo que no existe simétricamente.
  if (seats.length % 2 !== 0) {
    context.addIssue({ code: "custom", path: [path], message: "cantidad impar" });
  }
  // LA PAREJA ENTERA es lo único único. El mismo `userUuid` en dos plataformas son dos
  // personas; el mismo par dos veces es el mismo principal cobrando dos asientos.
  //
  // Corre DESPUÉS del `.transform()` de cada campo —`superRefine` recibe la salida del
  // objeto, no su entrada—, así que `"same"` y `" same "` ya son la misma clave acá: el
  // padding no alcanza para colar la misma pareja dos veces.
  const seen = new Set<string>();
  seats.forEach((value, index) => {
    const key = JSON.stringify([value.platformId, value.userUuid]);
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        path: [path, index],
        message: "referencia de jugador duplicada",
      });
    }
    seen.add(key);
  });
}

// EL REQUEST VIVO. No trae `pointsToWin`, ni `entryFee`, ni `prize`: los tres salen del catálogo,
// y el `strictObject` los RECHAZA en vez de ignorarlos. La diferencia importa — ignorarlos dejaría
// a un llamador creyendo que fijó la economía de la mesa mientras el modo la pisa en silencio.
const createRequest = z
  .strictObject({
    mode: z.literal("CASUAL"),
    matchId: nonBlank,
    // EL NOMBRE DEL MODO Y NO SU CONTENIDO. Quien lo resuelve es la sala, contra el catálogo, con
    // `activeByUuid`: un modo dado de baja no existe desde afuera y no puede sentar una mesa.
    gameModeId: nonBlank,
    // El techo de cuatro es de FORMA y no la regla del 4P: la cantidad real la decide el modo, y
    // el rechazo del 4P vive en `configOf`, que es el único que ve los dos.
    participants: z.array(participant).min(2).max(4),
    seed: nonBlank,
    teamAssignment,
    rateId: z.uuid(),
  })
  .superRefine(({ participants }, context) =>
    checkTableShape(participants, context, "participants"),
  );

// EL SNAPSHOT GRABADO. Es la mesa ENTERA —asientos ya numerados, puntos y dinero adentro— y es lo
// que el replay recibe: reconstruir una partida no puede depender del catálogo, porque el catálogo
// cambia y la partida ya pasó. Valida todo lo que `configOf` produjo, con las mismas guardas de
// identidad y de dinero.
const matchSnapshot = z
  .strictObject({
    matchId: nonBlank,
    gameModeId: nonBlank,
    seats: z
      .array(participant.extend({ playerId: nonBlank }))
      .min(2)
      .max(4),
    seed: nonBlank,
    pointsToWin: z.number().int().positive().safe(),
    teamAssignment,
    isDealWindowEnabled: z.boolean(),
    rateId: z.uuid(),
    entryFee: ucAmount,
    prize: ucAmount,
    // LOS DOS DEL AUMENTO LLEVAN DEFAULT, y es lo único de este schema que lo lleva: los
    // goldens y las partidas grabadas ANTES de que el aumento existiera no los tienen, y un
    // campo obligatorio acá rompería el replay de todo lo anterior — que es justamente lo
    // que el replay existe para poder hacer.
    //
    // Los defaults son el reposo seguro: sin catálogo no se ofrece aumentar, y una mesa vieja
    // nunca lo ofreció. Reconstruye exactamente lo que pasó.
    betLevels: z
      .array(
        z.strictObject({
          level: z.number().int().positive().safe(),
          extra: z.number().nonnegative().safe(),
          additionalEntryFee: ucAmount,
          additionalPrize: ucAmount,
        }),
      )
      .default([]),
    isFreeRoom: z.boolean().default(false),
  })
  .superRefine(({ seats }, context) => checkTableShape(seats, context, "seats"));

export type MatchParticipant = z.infer<typeof participant>;
export type CreateMatchRequest = z.infer<typeof createRequest>;

export interface SeatCredentials extends PlayerRef {
  readonly token: string;
}

// LOS TRES RECHAZOS DEL CATÁLOGO, con su código adentro del mensaje. Van juntos porque son las
// formas de "este modo no puede sentar esta mesa" y el que lee un log quiere verlas al lado.
// El código viaja en el `message` y no solo en el `name` porque es lo único que cruza el cable:
// Colyseus propaga el mensaje al que pidió crear la sala, y el llamador tiene que poder distinguir
// "ese modo no existe" de "ese modo no lo sabemos jugar".

/** El modo no está en el catálogo, o está dado de baja. Desde afuera son el mismo caso. */
export class UnknownGameModeError extends Error {
  override readonly name = "UnknownGameModeError";
  constructor(gameModeId: string) {
    super(`UNKNOWN_GAME_MODE: no hay un modo activo con uuid ${gameModeId}`);
  }
}

/**
 * ⚠ EL 4P, Y NO ES FALTA DE MOTOR SINO DE REGLA DE PLATA. `settlementOf`
 * (`network/settlement.ts`) exige EXACTAMENTE UN ganador, así que el final de una mesa de cuatro
 * lanza `InvariantViolationError` en vez de repartir: no existe la regla escrita de cómo se parte
 * el premio entre compañeros, y repartirlo sin ella sería inventarla al liquidar.
 *
 * Ese throw cae DESPUÉS del veredicto, o sea que esa mesa no cobra premio (hubo desenlace) ni
 * reembolso (no se abortó): **plata trabada**. Rechazar el modo ANTES de génesis es lo que
 * mantiene la deuda inerte, y abrir el 4P de verdad es traer la regla del reparto — no borrar
 * esta guarda ni la de `settlementOf`, que sigue siendo la última red.
 */
export class UnsupportedGameModeError extends Error {
  override readonly name = "UnsupportedGameModeError";
  constructor(mode: GameMode) {
    super(
      `UNSUPPORTED_GAME_MODE: el modo ${mode.uuid} es de ${mode.playersQuantity} jugadores y este motor solo sienta mesas de 2`,
    );
  }
}

/**
 * El request pidió una cantidad de asientos que no es la del modo. Sin esta guarda, cuatro
 * participantes sobre un modo de dos se sientan igual y juegan una partida cuyo premio e
 * inscripción se configuraron para una mesa que no es ésa.
 */
export class SeatCountMismatchError extends Error {
  override readonly name = "SeatCountMismatchError";
  constructor(requested: number, mode: GameMode) {
    super(
      `SEAT_COUNT_MISMATCH: el modo ${mode.uuid} sienta ${mode.playersQuantity} jugadores y el pedido trae ${requested}`,
    );
  }
}

export function requestOf(input: unknown): CreateMatchRequest {
  return createRequest.parse(input);
}

/**
 * EL SNAPSHOT DE LA MESA, congelado acá y para siempre. Toma el request vivo y el modo YA
 * RESUELTO, y de ahí en adelante la partida no vuelve a consultar el catálogo: editar un modo
 * mientras una mesa juega no puede cambiarle los puntos ni el premio, porque lo que la mesa
 * consume es esta copia. Es también lo que permite que `replay` rebobine sin base de datos.
 */
export function configOf(request: CreateMatchRequest, mode: GameMode): DominoMatchConfig {
  // EL ORDEN DE LAS DOS GUARDAS IMPORTA: primero "no sabemos jugar este modo" y después "pediste
  // mal la cantidad". Al revés, un pedido de cuatro contra un modo de cuatro saldría con el error
  // de cantidad —que coincide— y nadie se enteraría de que el problema es el modo.
  if (mode.playersQuantity !== 2) throw new UnsupportedGameModeError(mode);
  if (request.participants.length !== mode.playersQuantity) {
    throw new SeatCountMismatchError(request.participants.length, mode);
  }
  return {
    matchId: request.matchId,
    // EL MODO QUE SE RESOLVIÓ, no el que el request nombró. Hoy son el mismo string; el día que la
    // resolución acepte un alias, el snapshot tiene que guardar lo resuelto o el replay rebobina
    // una mesa que nunca existió.
    gameModeId: mode.uuid,
    // EL ID DEL ASIENTO ES OPACO Y POSICIONAL. Adentro de la partida nadie necesita saber
    // de qué plataforma viene quién: el motor, el historial y el wire hablan de `seat-N`,
    // así que un `playerId` que se filtre no dice nada de la cuenta de nadie. Y es
    // REPRODUCIBLE: el mismo snapshot da los mismos ids, que es lo que le permite al
    // replay rebobinar una partida sin volver a consultar identidades.
    seats: request.participants.map((value, index) => ({
      ...value,
      playerId: `seat-${index + 1}`,
    })),
    seed: request.seed,
    // LOS TRES NÚMEROS DEL CATÁLOGO. Es el cambio entero de esta tarea: el que pide la mesa nombra
    // un modo, y cuánto vale la mesa lo dice el modo. Un llamador ya no puede inventarse la
    // economía de una partida.
    pointsToWin: mode.pointsToWin,
    teamAssignment: request.teamAssignment,
    // La ventana siempre está encendida en este contrato: es control de presencia
    // anti-fraude, no una opción que matchmaking pueda omitir por accidente.
    isDealWindowEnabled: true,
    rateId: request.rateId,
    entryFee: mode.entryFee,
    prize: mode.prize,
    isFreeRoom: mode.isFreeRoom,
    // VACÍO, y por ahora siempre: el catálogo de niveles de aumento vive en el backend
    // principal (en v1, `internal/bet-increase/config`) y este repo todavía no lo consulta.
    // Lista vacía = la mesa no ofrece aumentar, que es exactamente lo que hace el v1 cuando
    // no consigue el catálogo — falla CERRADO.
    //
    // Es el reposo correcto y no un pendiente disimulado: mientras el cobro no exista, una
    // mesa que aceptara aumentos estaría prometiendo un premio mayor sin haber cobrado la
    // diferencia. El día que el adaptador aparezca, llena esta lista y nada más cambia.
    betLevels: [],
  };
}

/**
 * LA ENTRADA DEL REPLAY, y no llama a nadie. Valida un `DominoMatchConfig` grabado —el `meta` de un
 * fixture golden, los argumentos del CLI de soporte— y lo devuelve tal cual. No consulta el
 * catálogo A PROPÓSITO: una partida vieja se rebobina con el modo que TENÍA, no con el que el
 * panel dejó configurado después.
 *
 * Por eso acepta cuatro asientos y `configOf` no: acá no nace nada, se reconstruye lo que ya pasó.
 */
export function replayConfigOf(input: unknown): DominoMatchConfig {
  return matchSnapshot.parse(input);
}
