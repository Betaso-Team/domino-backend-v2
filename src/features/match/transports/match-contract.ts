import type { Identity } from "@/features/auth";
// EL ÚNICO CRUCE DE `match` HACIA `game-mode`, y entra por la superficie de la feature (Regla 4):
// nada de este archivo sabe que el catálogo tiene un repositorio, un outbox ni una API. La arista
// va en un solo sentido —`game-mode` redeclaró su `Clock` estructural en la Tarea 4 justamente
// para no tener que importar de acá— y eso es lo que mantiene el grafo acíclico.
import type { GameMode } from "@/features/game-mode";
import { z } from "zod";
import type { BetLevel, DominoMatchConfig } from "../core/config";
import type { MatchEventSink } from "../network/listeners";

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
// `userId` es una LLAVE: se compara contra el `sub` del token en `DominoRoom.onJoin` y es la
// clave del registro compartido. Validar con trim y guardar sin trim deja que `"ada "` en el
// snapshot y `"ada"` en el token sean el mismo jugador para
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
  userId: identityPart,
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
  seats: readonly { readonly userId: string }[],
  context: z.RefinementCtx,
  path: string,
): void {
  // Una mesa impar no tiene parejas: `assignTeams` repartiría un equipo con un jugador
  // de más, y el marcador acreditaría puntos a un equipo que no existe simétricamente.
  if (seats.length % 2 !== 0) {
    context.addIssue({ code: "custom", path: [path], message: "cantidad impar" });
  }
  // EL `userId` ES LO ÚNICO ÚNICO: el mismo dos veces es el mismo principal cobrando dos
  // asientos.
  //
  // Corre DESPUÉS del `.transform()` del campo —`superRefine` recibe la salida del objeto,
  // no su entrada—, así que `"same"` y `" same "` ya son la misma clave acá: el padding no
  // alcanza para colar al mismo jugador dos veces.
  const seen = new Set<string>();
  seats.forEach((value, index) => {
    const key = value.userId;
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
    // LOS TRES CAMPOS CON DEFAULT, y son los únicos de este schema que lo llevan: los goldens y
    // las partidas grabadas ANTES de que el aumento y el peso existieran no los tienen, y un
    // campo obligatorio acá rompería el replay de todo lo anterior — que es justamente lo
    // que el replay existe para poder hacer.
    //
    // Los defaults son el reposo seguro: sin catálogo no se ofrece aumentar, una mesa vieja nunca
    // lo ofreció, y peso 1 es el neutro del ranking. Reconstruye exactamente lo que pasó.
    //
    // ⚠ El default del PESO no es inocuo del todo, y conviene tenerlo escrito: rebobinar una
    // partida vieja con peso 1 y volver a reportarla al ranking le daría menos puntos de los que
    // le dio. No pasa —el replay NO reporta nada afuera, solo reconstruye el árbol— pero el día
    // que alguien quiera re-liquidar desde el historial, esto es lo que tiene que mirar primero.
    betLevels: z
      .array(
        z.strictObject({
          level: z.number().int().positive().safe(),
          extra: z.number().nonnegative().safe(),
          // LOS MONTOS NO ESTÁN, y la ausencia es la corrección: el catálogo del backend
          // principal devuelve `{ level, extra, additionalPoints }` y la plata se deriva de la
          // mesa (`betAmountsOf`). Guardarlos acá era pedirle al snapshot un dato que nadie
          // produce — y un cobro cableado contra ellos habría cobrado cero, en silencio.
          additionalPoints: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
        }),
      )
      .default([]),
    isFreeRoom: z.boolean().default(false),
    // CUARTO campo con default en el schema del replay, por lo mismo que los otros tres: toda la
    // historia grabada antes de la mesa de cuatro tiene que seguir rebobinando. El default es el
    // inocuo —una partida vieja es de dos, donde no hay bots que sentar—.
    enableBots: z.boolean().default(false),
    multiplier: z.number().positive().safe().default(1),
    // EL CUARTO CAMPO CON DEFAULT DEL SNAPSHOT, y el default es `false` a propósito: una partida
    // grabada antes de que la revancha existiera se rebobina SIN ventana de revancha, que es
    // exactamente lo que pasó. Con `true` el replay abriría una ventana que en su día no hubo y
    // la reconstrucción dejaría de ser fiel.
    isRematchEnabled: z.boolean().default(false),
  })
  .superRefine(({ seats }, context) => checkTableShape(seats, context, "seats"));

export type MatchParticipant = z.infer<typeof participant>;
export type CreateMatchRequest = z.infer<typeof createRequest>;

export interface SeatCredentials extends Identity {
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
 * ⚠ ESTE MOTOR SIENTA MESAS DE DOS Y DE CUATRO, Y NADA MÁS. La de cuatro se abrió trayendo la
 * regla de reparto de v1 —cada ganador cobra `prize` entero, el socio que se fue no cobra y su
 * mitad se queda en la casa (`domino-room-state.ts:672-678`)— y el piso de `settlementOf` sigue
 * siendo la última red: un equipo ganador sin nadie que cobre cierra la partida en vez de pagar.
 *
 * Lo que este error rechaza ahora es una mesa de tres, de seis o de uno: cantidades que ni las
 * reglas ni el reparto contemplan. `assignTeams` ya exige un número par, pero lanza DESPUÉS de
 * génesis y con un mensaje de invariante — acá se rechaza antes, con el modo a la vista.
 */
export class UnsupportedGameModeError extends Error {
  override readonly name = "UnsupportedGameModeError";
  constructor(mode: GameMode) {
    super(
      `UNSUPPORTED_GAME_MODE: el modo ${mode.uuid} es de ${mode.playersQuantity} jugadores y este motor solo sienta mesas de 2 o de 4`,
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
/**
 * @param betLevels los niveles de aumento que esta mesa ofrece, YA RESUELTOS. Entran por
 * parámetro y no se consultan acá por lo mismo que el modo: esta función es SÍNCRONA y pura, y
 * el catálogo de niveles vive en el backend principal. Quien los trae es la sala, que es async.
 *
 * El default vacío es el reposo: una instancia sin `BACKEND_URL` no ofrece aumentar, y eso es
 * correcto en vez de estar roto.
 */
export function configOf(
  request: CreateMatchRequest,
  mode: GameMode,
  betLevels: readonly BetLevel[] = [],
): DominoMatchConfig {
  // EL ORDEN DE LAS DOS GUARDAS IMPORTA: primero "no sabemos jugar este modo" y después "pediste
  // mal la cantidad". Al revés, un pedido de tres contra un modo de tres saldría con el error de
  // cantidad —que coincide— y nadie se enteraría de que el problema es el modo.
  if (mode.playersQuantity !== 2 && mode.playersQuantity !== 4) {
    throw new UnsupportedGameModeError(mode);
  }
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
    // EL PESO DEL MODO EN EL RANKING. Sale del catálogo como los otros tres números y se congela
    // por la misma razón: el panel puede cambiarle el peso al modo mientras la mesa se juega, y el
    // ganador tiene que sumar con el peso que aceptó al sentarse.
    multiplier: mode.multiplier,
    isFreeRoom: mode.isFreeRoom,
    enableBots: mode.enableBots,
    // TODA MESA CASUAL OFRECE REVANCHA, y esta función solo sienta mesas casuales: el torneo no
    // pasa por acá. Cuando el catálogo tenga la palanca por modo, sale de `mode`.
    isRematchEnabled: true,
    // LOS QUE EL LLAMADOR TRAJO. Vacío = la mesa no ofrece aumentar, que es el reposo y lo que
    // hace v1 cuando no consigue el catálogo: falla CERRADO. Se congelan con el resto de la
    // economía — el panel puede cambiar los niveles de un modo mientras la mesa se juega, y el
    // que aceptó un x5 lo aceptó al precio de cuando se sentó.
    betLevels,
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

interface CommonRoomOptions {
  readonly seats: readonly string[];
  readonly seed: string;
  readonly pointsToWin: number;
}

export interface CasualRoomOptions extends CommonRoomOptions {
  readonly mode: "CASUAL";
  readonly gameModeId: string;
  readonly entryFee: number;
  readonly prize: number;
  readonly rankingWeight: number;
  readonly isFreeRoom: boolean;
  /**
   * CUÁNTAS REVANCHAS LLEVA ESTA CADENA. Ausente es CERO —la mesa original no tiene por qué
   * declararse «la número cero»— y la revancha llega con uno, que es lo que la vuelve
   * inelegible: `MAX_REMATCHES_PER_CHAIN` es 1 (ver `network/rematch.ts`).
   *
   * Es anti-abuso y es de v1: sin el tope, dos cómplices se pasan la partida entre ellos
   * indefinidamente sin volver a pasar por el emparejador, que es quien los separaría.
   */
  readonly rematchCount?: number;
  /**
   * QUÉ CADENA. Lo bautiza la PRIMERA mesa y las revanchas lo heredan; sin él cada revancha
   * empezaría una cadena nueva y el tope de la anterior no limitaría nada.
   *
   * Hoy nadie lo lee más que la mesa siguiente — existe para que el día que el reporte quiera
   * agrupar «estas tres partidas fueron la misma sentada» el dato ya esté grabado.
   */
  readonly rematchChainId?: string;
}

export interface TournamentRoomOptions extends CommonRoomOptions {
  readonly mode: "TOURNAMENT";
  readonly tournamentId: string;
  readonly pointsPerLoss: number;
}

export type DominoRoomOptions = CasualRoomOptions | TournamentRoomOptions;
export type MatchSinks = (options: DominoRoomOptions) => readonly MatchEventSink[];

/**
 * Matchmaking owns creation now. The engine keeps its existing snapshot shape while account data is
 * resolved at admission, exactly as in truco: the authenticated `sub` is the seat id and no client
 * supplied identity is trusted.
 */
export function configFromRoomOptions(
  options: DominoRoomOptions,
  matchId: string,
  betLevels: readonly BetLevel[] = [],
): DominoMatchConfig {
  return {
    matchId,
    gameModeId: options.mode === "CASUAL" ? options.gameModeId : options.tournamentId,
    seed: options.seed,
    seats: options.seats.map((playerId) => ({
      playerId,
      userId: playerId,
      displayName: playerId,
      currency: "USD",
    })),
    pointsToWin: options.pointsToWin,
    teamAssignment: "SHUFFLED",
    isDealWindowEnabled: true,
    // The platform integration freezes the real account and rate on admission. These legacy fields
    // remain only so old replay snapshots keep their shape; no movement reads them on this path.
    rateId: "00000000-0000-4000-8000-000000000000",
    entryFee: options.mode === "CASUAL" ? options.entryFee : 0,
    prize: options.mode === "CASUAL" ? options.prize : 0,
    multiplier: options.mode === "CASUAL" ? options.rankingWeight : 1,
    // EL TORNEO NO OFRECE REVANCHA: ahí se vuelve a jugar cuando el torneo lo diga.
    isRematchEnabled: options.mode === "CASUAL",
    betLevels,
    isFreeRoom: options.mode === "CASUAL" ? options.isFreeRoom : true,
    // EL EMPAREJADOR NO TRAE EL MODO ENTERO, así que acá no hay de dónde leerlo. Queda apagado, que
    // es el reposo correcto: este camino sienta mesas de dos, donde `canSeatBot` diría que no
    // igual. El día que el emparejador arme mesas de cuatro, el campo entra por `DominoRoomOptions`
    // junto con el resto de la economía.
    enableBots: false,
  };
}

export interface Seat {
  readonly playerId: string;
  readonly reservation: unknown;
}

export interface MatchOpener {
  open(options: DominoRoomOptions): Promise<readonly Seat[]>;
}
