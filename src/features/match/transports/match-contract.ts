import type { Identity } from "@/features/auth";
import { z } from "zod";
import type { BetLevel, DominoMatchConfig } from "../core/config";

// Contrato en la raíz de transports porque las salas las crea la API interna del orquestador. `mode`
// lo deja discriminado para sumar otros orígenes sin adivinar por campos opcionales.
//
// ES LA ÚNICA FRONTERA QUE VALIDA, y por eso valida con zod y no con tipos: lo que llega
// por `createRoom` es un objeto del otro lado del cable, y un `CreateMatchRequest` escrito
// en la firma solo describe lo que se espera —no lo comprueba—. De acá para adentro el
// `DominoMatchConfig` es un dato confiable, y eso incluye la moneda, la tasa y los montos.
//
// SON DOS ENTRADAS Y POR ESO SON DOS FUNCIONES. `requestOf` valida lo que el orquestador PIDE —una
// mesa, unos participantes y su modo—; `replayConfigOf` valida un snapshot YA GRABADO,
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

// LOS MONTOS EN LA MONEDA DEL JUGADOR SON TEXTO DECIMAL, y no `ucAmount`: los cotizó billing con su
// tasa y su redondeo (`"200.00"`), y el dominó no hace cuentas con ellos —los muestra y elige cuál
// corresponde—. Un `number` acá sería la primera conversión, y la que pierde el centavo. Sin signo ni
// exponente; el techo de largo es de forma, para que un texto de un mega no viaje a cada snapshot.
const decimalText = z
  .string()
  .max(32)
  .regex(/^\d+(\.\d+)?$/, "no es un monto decimal");

// UN NIVEL DE AUMENTO CON PRECIO. El nivel 1 es la mesa sin aumento, y su precio es el de arriba.
const levelPrice = z.strictObject({
  level: z.number().int().min(2).safe(),
  entry: decimalText,
  prize: decimalText,
});

// LO QUE LA MESA LE CUESTA Y LE PAGA A UN ASIENTO EN SU MONEDA (`MatchSeat.price`). Opcional y sin
// default en las DOS entradas: ausente es la mesa en UC de siempre —las gratis nunca lo traen, un
// orquestador viejo tampoco— y una partida grabada antes no puede inventarse un precio que no tuvo.
const seatPrice = z
  .strictObject({
    currency: nonBlank,
    rate: decimalText,
    entry: decimalText,
    prize: decimalText,
    levels: z.array(levelPrice).max(16).default([]),
    // LOS DECIMALES DE LA MONEDA (los del catálogo de monedas de billing), para emitir los montos de
    // arriba en la convención con su relleno (`"200"` → `"200.00"`). Aditivo y opcional: el orquestador
    // lo manda recién después de que este campo exista acá (el `strictObject` lo rechazaría), y una
    // partida grabada antes no lo tiene. Sin él no se rellena nada: el texto sale con los decimales que
    // trajo (`fixed(texto, 0)` nunca quita un dígito), que es lo que el front mostraba hasta hoy.
    decimals: z.number().int().min(0).max(8).optional(),
  })
  .superRefine(({ levels }, context) => {
    // DOS PRECIOS PARA EL MISMO NIVEL es elegir uno a ciegas al cerrar.
    const seen = new Set<number>();
    levels.forEach(({ level }, index) => {
      if (seen.has(level)) {
        context.addIssue({ code: "custom", path: ["levels", index], message: "nivel duplicado" });
      }
      seen.add(level);
    });
  });

const participantShape = z.strictObject({
  userId: identityPart,
  displayName: nonBlank,
  username: nonBlank.optional(),
  profilePicture: nonBlank.optional(),
  currency: nonBlank,
  price: seatPrice.optional(),
  // EL PROVEEDOR DEL JUGADOR (el `prv` de su sesión en billing-auth), para que el panel le muestre a cada
  // proveedor sus partidas y sólo ésas. Es una LLAVE —se compara contra el `prv` del token del admin—, así
  // que se normaliza como el `userId`. Opcional: el orquestador lo manda recién después de que este campo
  // exista acá (el `strictObject` lo rechazaría), y una partida grabada antes no lo tiene.
  providerId: identityPart.optional(),
});

// EL PRECIO VA EN LA MONEDA QUE SE COBRA, y si no coincide el que se equivocó es el que lo mandó: el
// jugador vería la entrada en una moneda y la pagaría en otra. Es una función y no un `.refine` sobre
// la forma porque el snapshot la EXTIENDE con el `playerId`, y zod no extiende un objeto refinado.
const priceInSeatCurrency = <T extends { currency: string; price?: { currency: string } }>(
  schema: z.ZodType<T>,
) =>
  schema.refine(({ currency, price }) => price === undefined || price.currency === currency, {
    path: ["price", "currency"],
    message: "no es la moneda del participante",
  });

const participant = priceInSeatCurrency(participantShape);

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

// UN NIVEL DE AUMENTO. Lo valida el snapshot y lo valida el request del orquestador, con la misma
// forma: si divergen, una mesa que la ruta acepta la sala la rechaza después de crearla.
const betLevel = z.strictObject({
  level: z.number().int().positive().safe(),
  extra: z.number().nonnegative().safe(),
  // LOS MONTOS NO ESTÁN, y la ausencia es la corrección: el catálogo del backend principal devuelve
  // `{ level, extra, additionalPoints }` y la plata se deriva de la mesa (`betAmountsOf`). Guardarlos
  // acá era pedirle al snapshot un dato que nadie produce — y un cobro cableado contra ellos habría
  // cobrado cero, en silencio.
  additionalPoints: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

// EL REQUEST VIVO DE UNA MESA CASUAL. Trae su modo ENTERO en línea (`gameMode`): el catálogo de modos
// es del orquestador, que lo lee y lo edita, y dominó no guarda ninguno. El orquestador manda los siete
// campos que `configOf` usa, más el nombre para el historial, tomados de la misma fila con la que armó la
// planilla y el libro de billing. Las guardas son las del snapshot (`matchSnapshot`): enteros positivos
// seguros para los puntos, `ucAmount` para los importes; el multiplicador además entero, como lo pide el
// catálogo del orquestador. Se llama `gameMode` y no `mode` porque `mode` es el discriminante de la
// unión. `strictObject` rechaza `pointsToWin`, `entryFee` o `prize` sueltos en el pedido: la economía de
// la mesa viaja solo dentro del modo.
const inlineGameMode = z.strictObject({
  name: z.string().min(1).max(100),
  playersQuantity: z.union([z.literal(2), z.literal(4)]),
  pointsToWin: z.number().int().positive().safe(),
  multiplier: z.number().int().positive().safe(),
  entryFee: ucAmount,
  prize: ucAmount,
  isFreeRoom: z.boolean(),
  enableBots: z.boolean(),
});

const casualRequest = z
  .strictObject({
    mode: z.literal("CASUAL"),
    matchId: nonBlank,
    // EL UUID DEL MODO NO SE RESUELVE: nombra la mesa en el snapshot, el historial, el censo y el
    // resultado. Los números de la mesa los trae `gameMode`.
    gameModeId: nonBlank,
    gameMode: inlineGameMode,
    // El techo de cuatro es de FORMA y no la regla del 4P: la cantidad real la decide el modo, y
    // el rechazo del 4P vive en `configOf`, que es el único que ve los dos.
    participants: z.array(participant).min(2).max(4),
    seed: nonBlank,
    teamAssignment,
    // Opaco: lo emite la plataforma que cobra (Betaso usa el `_id` de Mongo de sus tasas).
    rateId: nonBlank,
    // LOS NIVELES DE AUMENTO QUE OFRECE LA MESA, y los decide el ORQUESTADOR: él es quien cobra el
    // aumento, así que él dice cuáles hay. Opcional y sin default de catálogo: ausente es "esta mesa
    // no ofrece aumentar", que es el reposo y lo que hacen las mesas del orquestador hasta que el
    // orquestador mande niveles.
    betLevels: z.array(betLevel).max(16).optional(),
  })
  .superRefine(({ participants }, context) =>
    checkTableShape(participants, context, "participants"),
  );

// LA MESA DE TORNEO, y NO TRAE DINERO NI CATÁLOGO: ni `gameModeId`, ni `rateId`, ni `betLevels`. Las
// partidas de un torneo son gratis —la inscripción la cobró billing al inscribirse— y las reglas las
// manda el orquestador, que las copió del torneo. `strictObject` rechaza cualquier campo de dinero:
// un llamador que crea estar cobrando una mesa de torneo se entera acá y no al ver que no se cobró.
const tournamentRequest = z
  .strictObject({
    mode: z.literal("TOURNAMENT"),
    matchId: nonBlank,
    tournamentId: identityPart,
    // Mismas reglas de forma que la casual: 2 o 4, par, sin el mismo jugador dos veces.
    participants: z.array(participant).min(2).max(4),
    seed: nonBlank,
    teamAssignment,
    // SIN TECHO PROPIO: el tope de puntos de un torneo es una decisión de producto de
    // `apps/tournaments` (su ajuste `maxPointsToWin`). El motor solo usa `pointsToWin` como meta
    // (`referee.ts`), así que acá se exige únicamente la regla técnica: un entero positivo seguro. El
    // 100 del catálogo casual del orquestador es de ese catálogo, no del motor.
    rules: z.strictObject({
      pointsToWin: z.number().int().positive().safe(),
    }),
  })
  .superRefine(({ participants }, context) =>
    checkTableShape(participants, context, "participants"),
  );

// `mode` DISCRIMINA: una mesa casual con campos de torneo, o al revés, es un 400 y no una mesa a medias.
const createRequest = z.discriminatedUnion("mode", [casualRequest, tournamentRequest]);

// EL SNAPSHOT GRABADO. Es la mesa ENTERA —asientos ya numerados, puntos y dinero adentro— y es lo
// que el replay recibe: reconstruir una partida no puede depender del catálogo, porque el catálogo
// cambia y la partida ya pasó. Valida todo lo que `configOf` produjo, con las mismas guardas de
// identidad y de dinero.
const matchSnapshot = z
  .strictObject({
    // DE QUÉ CLASE ES LA MESA. Opcional y sin default: todo lo grabado antes de los torneos es casual, y
    // una mesa casual sigue sin escribirlo (ver `DominoMatchConfig.mode`), así que el snapshot de
    // siempre se rebobina idéntico.
    mode: z.literal("TOURNAMENT").optional(),
    tournamentId: identityPart.optional(),
    matchId: nonBlank,
    gameModeId: nonBlank,
    seats: z
      .array(priceInSeatCurrency(participantShape.extend({ playerId: nonBlank })))
      .min(2)
      .max(4),
    seed: nonBlank,
    pointsToWin: z.number().int().positive().safe(),
    teamAssignment,
    isDealWindowEnabled: z.boolean(),
    // Opaco: lo emite la plataforma que cobra (Betaso usa el `_id` de Mongo de sus tasas).
    rateId: nonBlank,
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
    betLevels: z.array(betLevel).default([]),
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
  .superRefine((snapshot, context) => {
    checkTableShape(snapshot.seats, context, "seats");
    // Una mesa de torneo sin su torneo, o un torneo colgado de una casual, no se rebobina: no se sabría
    // a qué torneo contó.
    if ((snapshot.mode === "TOURNAMENT") !== (snapshot.tournamentId !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["tournamentId"],
        message: "tournamentId va con mode TOURNAMENT, y solo con él",
      });
    }
  });

// El MISMO schema, para que la API interna valide el cuerpo con el contrato de la sala y no con
// una copia: si divergen, una mesa que la ruta acepta la sala la rechaza después de crearla.
export const createMatchRequestSchema = createRequest;

export type MatchParticipant = z.infer<typeof participant>;
export type InlineGameMode = z.infer<typeof inlineGameMode>;

export type CreateMatchRequest = z.infer<typeof createRequest>;
export type CasualMatchRequest = z.infer<typeof casualRequest>;
export type TournamentMatchRequest = z.infer<typeof tournamentRequest>;

export interface SeatCredentials extends Identity {
  readonly token: string;
}

/**
 * El request pidió una cantidad de asientos que no es la del modo. Sin esta guarda, cuatro
 * participantes sobre un modo de dos se sientan igual y juegan una partida cuyo premio e
 * inscripción se configuraron para una mesa que no es ésa. El código viaja en el `message` porque
 * es lo único que cruza el cable: Colyseus propaga el mensaje al que pidió crear la sala.
 *
 * Un modo que no es de 2 ni de 4 no llega hasta acá: `gameMode.playersQuantity` solo acepta esos
 * dos, que son las mesas que este motor sabe sentar.
 */
export class SeatCountMismatchError extends Error {
  override readonly name = "SeatCountMismatchError";
  constructor(requested: number, request: CasualMatchRequest) {
    super(
      `SEAT_COUNT_MISMATCH: el modo ${request.gameModeId} sienta ${request.gameMode.playersQuantity} jugadores y el pedido trae ${requested}`,
    );
  }
}

export function requestOf(input: unknown): CreateMatchRequest {
  return createRequest.parse(input);
}

/**
 * EL SNAPSHOT DE LA MESA, congelado acá y para siempre. Toma el request vivo, con su modo en línea, y
 * de ahí en adelante la partida no vuelve a mirar ningún catálogo: editar un modo en el orquestador
 * mientras una mesa juega no puede cambiarle los puntos ni el premio, porque lo que la mesa consume es
 * esta copia. Es también lo que permite que `replay` rebobine sin base de datos.
 *
 * @param betLevels los niveles de aumento que esta mesa ofrece, YA RESUELTOS: los trae el request
 * (`betLevels`), y entran por parámetro para que esta función siga siendo síncrona y pura. El default
 * vacío es el reposo: la mesa no ofrece aumentar.
 */
export function configOf(
  request: CreateMatchRequest,
  betLevels: readonly BetLevel[] = [],
): DominoMatchConfig {
  // LA MESA DE TORNEO NO TIENE MODO NI NIVELES: se arma con lo que trae el request, y lo que el
  // llamador pase en `betLevels` no la toca.
  if (request.mode === "TOURNAMENT") return tournamentConfigOf(request);
  const mode = request.gameMode;
  if (request.participants.length !== mode.playersQuantity) {
    throw new SeatCountMismatchError(request.participants.length, request);
  }
  return {
    matchId: request.matchId,
    gameModeId: request.gameModeId,
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
    // LOS NÚMEROS DEL MODO. El que pide la mesa manda su modo, y cuánto vale la mesa lo dice el modo.
    pointsToWin: mode.pointsToWin,
    teamAssignment: request.teamAssignment,
    // La ventana siempre está encendida en este contrato: es control de presencia
    // anti-fraude, no una opción que el orquestador pueda omitir por accidente.
    isDealWindowEnabled: true,
    rateId: request.rateId,
    entryFee: mode.entryFee,
    prize: mode.prize,
    // EL PESO DEL MODO, congelado como los otros números: el ganador suma con el peso que aceptó al
    // sentarse aunque el modo se edite mientras se juega.
    multiplier: mode.multiplier,
    isFreeRoom: mode.isFreeRoom,
    enableBots: mode.enableBots,
    // LA MESA ABRE LA VENTANA DE REVANCHA, pero la compuerta (`RematchGate`) queda CERRADA: nadie
    // la abre, porque la revancha necesita que el orquestador vuelva a cobrar y eso todavía no
    // existe. El cliente ve la ventana con `eligible: false` durante `rematchWindowMs` y la mesa
    // termina. Cuando el orquestador abra revanchas, éste es el campo y el coordinador es suyo.
    isRematchEnabled: true,
    // LOS QUE EL LLAMADOR TRAJO. Vacío = la mesa no ofrece aumentar, que es el reposo: falla
    // CERRADO. Se congelan con el resto de la economía.
    //
    // LA MESA GRATIS NO OFRECE AUMENTAR, traiga lo que traiga el request: no hay entrada que
    // multiplicar ni premio que escalar. Es la regla de v1 (`on-propose-bet-multiplier.ts:46`).
    betLevels: mode.isFreeRoom ? [] : betLevels,
  };
}

/**
 * EL `gameModeId` DE UNA MESA DE TORNEO. No hay modo detrás; el campo sigue siendo
 * obligatorio en el snapshot, el registro, el censo y el resultado, y con el torneo adentro agrupa
 * las mesas de un mismo torneo en el censo. Un consumidor que filtre por modo no lo confunde con un
 * uuid de modo.
 */
export const tournamentGameModeId = (tournamentId: string): string => `tournament:${tournamentId}`;

/**
 * LA TASA DE UNA MESA SIN DINERO. El snapshot y el resultado la exigen no vacía, y una mesa de torneo
 * no cobra ni paga nada que convertir: es un marcador, no una tasa del proveedor.
 */
export const NO_RATE = "none";

/**
 * EL SNAPSHOT DE UNA MESA DE TORNEO, sin modo: las reglas vienen en el request y el resto es fijo.
 * Gratis (`isFreeRoom`, sin entrada ni premio ni aumentos), sin bots —un torneo se juega entre los
 * inscritos; el que se va, pierde— y sin revancha —se vuelve a jugar cuando el torneo lo diga, no
 * cuando los dos se pongan de acuerdo—. Los plazos son los mismos de cualquier mesa: salen de la
 * config global (con sus ediciones en caliente), que la sala fotografía igual que en una casual.
 */
export function tournamentConfigOf(request: TournamentMatchRequest): DominoMatchConfig {
  return {
    mode: "TOURNAMENT",
    tournamentId: request.tournamentId,
    matchId: request.matchId,
    gameModeId: tournamentGameModeId(request.tournamentId),
    seats: request.participants.map((value, index) => ({
      ...value,
      playerId: `seat-${index + 1}`,
    })),
    seed: request.seed,
    pointsToWin: request.rules.pointsToWin,
    teamAssignment: request.teamAssignment,
    isDealWindowEnabled: true,
    rateId: NO_RATE,
    entryFee: 0,
    prize: 0,
    multiplier: 1,
    isFreeRoom: true,
    enableBots: false,
    isRematchEnabled: false,
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
