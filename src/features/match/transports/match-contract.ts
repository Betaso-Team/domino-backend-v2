import type { Identity } from "@/features/auth";
import { DECIMAL_TEXT, Decimal, ZERO, decimal, fromNumber } from "@/shared/money";
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

// LOS MONTOS EN LA MONEDA DEL JUGADOR SON TEXTO DECIMAL: los cotizó billing con su tasa y su redondeo
// (`"200.00"`), y el dominó no hace cuentas con ellos —los muestra y elige cuál corresponde—. Un
// `number` acá sería la primera conversión, y la que pierde el centavo. Sin signo ni exponente; el techo
// de largo es de forma, para que un texto de un mega no viaje a cada snapshot.
const decimalText = z.string().max(32).regex(DECIMAL_TEXT, "no es un monto decimal");

// LOS MONTOS DE LA MESA SON UC COMPLETAS, ADMITEN DECIMALES Y ADENTRO SON EL `Decimal` DE BILLING
// (`@/shared/money`): `entryFee` de `10` son diez UC, y un modo productivo puede tener `1.5`. Toda cuenta
// con ellos —el premio a un nivel de aumento— usa las fórmulas compartidas con el orquestador, que
// compara el premio publicado con igualdad decimal exacta: un `number` acá era `0.02 + 0.1 =
// 0.12000000000000001` y un resultado en la DLQ.
//
// LLEGAN EN TRES FORMAS, y las tres terminan en el mismo `Decimal`:
//   · TEXTO DECIMAL (`"10.0000"`): lo que manda el orquestador desde que sus montos son `Decimal`, y lo
//     que guarda el registro desde este cambio.
//   · UN NÚMERO finito no negativo (`10`, `1.5`): lo que mandaba el orquestador anterior y lo que tienen
//     los snapshots grabados antes (los goldens del replay, los registros viejos). Se lee en su forma
//     decimal más corta (`fromNumber`), sin redondear. Se acepta durante una versión, mientras el
//     orquestador desplegado sea el viejo; el registro lo seguirá teniendo siempre.
//   · UN `Decimal` YA VALIDADO: la ruta del orquestador valida el pedido y se lo pasa a la sala, que lo
//     vuelve a validar al crearse. Entre procesos viaja como JSON, y el `Decimal` se serializa como su
//     texto.
// El techo del entero seguro del número saca el desborde de la mantisa, donde dos montos distintos son
// el mismo número; no se expresa con `.safe()` porque en zod 4 `.safe()` IMPLICA entero.
const ucAmount = z
  .union([
    decimalText,
    z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
    z.instanceof(Decimal).refine((value) => value.gte(ZERO), "no puede ser negativo"),
  ])
  .transform((value): Decimal => {
    if (typeof value === "string") return decimal(value);
    if (typeof value === "number") return fromNumber(value);
    return value;
  });

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
  // EL PROVEEDOR DEL JUGADOR (el `prv` de su sesión en billing-auth). Es la AUDIENCIA del asiento: acota
  // el listado y el detalle del panel (cada proveedor ve lo suyo entero y lo del rival recortado,
  // `network/record-view.ts`) y agrupa el censo. Es una LLAVE —se compara contra el `prv` del token del
  // admin—, así que se normaliza como el `userId`. OBLIGATORIO: un asiento sin proveedor no tendría dueño
  // a quién mostrárselo, y el censo lo contaría sin atribuir.
  providerId: identityPart,
});

// EL PRECIO VA EN LA MONEDA QUE SE COBRA, y si no coincide el que se equivocó es el que lo mandó: el
// jugador vería la entrada en una moneda y la pagaría en otra. Es una función y no un `.refine` sobre
// la forma porque el snapshot la EXTIENDE con el `playerId`, y zod no extiende un objeto refinado.
const priceInSeatCurrency = <T extends { currency: string; price?: { currency: string } }, I>(
  schema: z.ZodType<T, I>,
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
  // `{ level, extra, additionalPoints }` y la plata se deriva de la mesa (`betDifference`). Guardarlos
  // acá era pedirle al snapshot un dato que nadie produce — y un cobro cableado contra ellos habría
  // cobrado cero, en silencio.
  additionalPoints: z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

/**
 * LAS MESAS QUE ESTE DOMINÓ ABRE: sólo de dos. El dominó de cuatro no sale (ver «Antes de habilitar
 * dominó de 4» en `AGENTS.md`), y tiene que ser IMPOSIBLE crear una mesa de cuatro, ni por error: el
 * pedido que la pide es un 400 en la ruta del orquestador y un rechazo en la sala. Es una constante del
 * código y no una variable de entorno a propósito: habilitar el 4P es un cambio de código con su
 * revisión, no un valor que alguien pueda poner en un `.env`.
 *
 * El motor sí sabe jugar de cuatro, y sus tests lo siguen midiendo: la sala recibe los asientos
 * habilitados por inyección (`EnabledSeats` en el container), y sólo el arnés de los E2E de cuatro la
 * registra (`tests/e2e-harness.ts`). Producción no la registra nunca y queda con esta lista.
 */
export const ENABLED_SEATS: readonly number[] = Object.freeze([2]);

/** El token del container con el que el arnés de los E2E de cuatro le habilita esas mesas a la sala. */
export const ENABLED_SEATS_TOKEN = "EnabledSeats";

// LOS DOS REQUESTS VIVOS, armados para unas mesas habilitadas. Es una función y no dos constantes porque
// la cantidad de asientos es la única regla que cambia entre producción (`ENABLED_SEATS`, sólo 2) y el
// arnés que todavía mide el motor de cuatro; todo lo demás es el mismo schema.
function createRequestFor(enabledSeats: readonly number[]) {
  const maxSeats = Math.max(...enabledSeats);
  const seatCount = z
    .number()
    .int()
    .refine((value) => enabledSeats.includes(value), {
      message: `sólo se abren mesas de ${enabledSeats.join(" o ")}`,
    });

  // EL REQUEST VIVO DE UNA MESA CASUAL. Trae su modo ENTERO en línea (`gameMode`): el catálogo de modos
  // es del orquestador, que lo lee y lo edita, y dominó no guarda ninguno. El orquestador manda los siete
  // campos que `configOf` usa, más el nombre para el historial, tomados de la misma fila con la que armó
  // la planilla y el libro de billing. Las guardas son las del snapshot (`matchSnapshot`): enteros
  // positivos seguros para los puntos, `ucAmount` para los importes; el multiplicador además entero, como
  // lo pide el catálogo del orquestador. Se llama `gameMode` y no `mode` porque `mode` es el
  // discriminante de la unión. `strictObject` rechaza `pointsToWin`, `entryFee` o `prize` sueltos en el
  // pedido: la economía de la mesa viaja solo dentro del modo.
  const inlineGameMode = z.strictObject({
    name: z.string().min(1).max(100),
    // SÓLO LAS MESAS HABILITADAS (`ENABLED_SEATS`): un modo de cuatro es un 400.
    playersQuantity: seatCount,
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
      // EL TECHO ES EL DE LAS MESAS HABILITADAS (dos): más participantes es un 400 aunque el modo diga
      // otra cosa. Que la cantidad coincida con el modo lo decide `configOf`, el único que ve los dos.
      participants: z.array(participant).min(2).max(maxSeats),
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
      // Mismas reglas de forma que la casual: las mesas habilitadas, par, sin el mismo jugador dos
      // veces. Sin modo que diga la cantidad, el techo es la única guarda del 4P.
      participants: z.array(participant).min(2).max(maxSeats),
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

  // `mode` DISCRIMINA: una mesa casual con campos de torneo, o al revés, es un 400 y no una mesa a
  // medias.
  return z.discriminatedUnion("mode", [casualRequest, tournamentRequest]);
}

const createRequest = createRequestFor(ENABLED_SEATS);

// Los schemas de otras mesas habilitadas se arman una vez: la sala valida con ellos cada `onCreate`.
const requestSchemas = new Map<string, typeof createRequest>([
  [ENABLED_SEATS.join(","), createRequest],
]);
function createRequestSchemaFor(enabledSeats: readonly number[]): typeof createRequest {
  const key = enabledSeats.join(",");
  let schema = requestSchemas.get(key);
  if (!schema) {
    schema = createRequestFor(enabledSeats);
    requestSchemas.set(key, schema);
  }
  return schema;
}

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

export type CreateMatchRequest = z.infer<typeof createRequest>;
export type CasualMatchRequest = Extract<CreateMatchRequest, { mode: "CASUAL" }>;
export type TournamentMatchRequest = Extract<CreateMatchRequest, { mode: "TOURNAMENT" }>;
export type InlineGameMode = CasualMatchRequest["gameMode"];

/**
 * EL PEDIDO COMO LO MANDA EL ORQUESTADOR, antes de validarlo: los montos del modo en texto decimal (o el
 * número de un orquestador viejo). Es el tipo de lo que un test le pasa a la sala o a la ruta.
 */
export type CreateMatchRequestInput = z.input<typeof createRequest>;
export type CasualMatchRequestInput = Extract<CreateMatchRequestInput, { mode: "CASUAL" }>;
export type InlineGameModeInput = CasualMatchRequestInput["gameMode"];

export interface SeatCredentials extends Identity {
  readonly token: string;
}

/**
 * El request pidió una cantidad de asientos que no es la del modo. Sin esta guarda, cuatro
 * participantes sobre un modo de dos se sientan igual y juegan una partida cuyo premio e
 * inscripción se configuraron para una mesa que no es ésa. El código viaja en el `message` porque
 * es lo único que cruza el cable: Colyseus propaga el mensaje al que pidió crear la sala.
 *
 * Un modo de otra cantidad que las habilitadas (`ENABLED_SEATS`) no llega hasta acá: el schema lo
 * rechaza, y `configOf` lo vuelve a rechazar (`SeatsNotEnabledError`).
 */
export class SeatCountMismatchError extends Error {
  override readonly name = "SeatCountMismatchError";
  constructor(requested: number, request: CasualMatchRequest) {
    super(
      `SEAT_COUNT_MISMATCH: el modo ${request.gameModeId} sienta ${request.gameMode.playersQuantity} jugadores y el pedido trae ${requested}`,
    );
  }
}

/**
 * LA MESA QUE EL DOMINÓ NO ABRE: una cantidad de asientos fuera de `ENABLED_SEATS`. El schema ya la
 * rechaza; esto es la segunda guarda, en `configOf`, para el pedido que llegue armado a mano sin pasar
 * por `requestOf`. No es un rechazo del contrato sino un defecto nuestro, y por eso no tiene 422.
 */
export class SeatsNotEnabledError extends Error {
  override readonly name = "SeatsNotEnabledError";
  constructor(seats: number, enabledSeats: readonly number[]) {
    super(
      `SEATS_NOT_ENABLED: el dominó sólo abre mesas de ${enabledSeats.join(" o ")}, y el pedido es de ${seats}`,
    );
  }
}

/**
 * @param enabledSeats las mesas que se pueden abrir. Producción usa el default (`ENABLED_SEATS`, sólo
 * 2); sólo el arnés de los E2E de cuatro pasa otra lista.
 */
export function requestOf(
  input: unknown,
  enabledSeats: readonly number[] = ENABLED_SEATS,
): CreateMatchRequest {
  return createRequestSchemaFor(enabledSeats).parse(input);
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
  enabledSeats: readonly number[] = ENABLED_SEATS,
): DominoMatchConfig {
  // EL 4P SE RECHAZA ACÁ TAMBIÉN, y no sólo en el schema: este es el punto por el que nace TODA mesa, y
  // un pedido que llegara sin pasar por `requestOf` no puede sentar a cuatro.
  if (!enabledSeats.includes(request.participants.length)) {
    throw new SeatsNotEnabledError(request.participants.length, enabledSeats);
  }
  // LA MESA DE TORNEO NO TIENE MODO NI NIVELES: se arma con lo que trae el request, y lo que el
  // llamador pase en `betLevels` no la toca.
  if (request.mode === "TOURNAMENT") return tournamentConfigOf(request);
  const mode = request.gameMode;
  if (!enabledSeats.includes(mode.playersQuantity)) {
    throw new SeatsNotEnabledError(mode.playersQuantity, enabledSeats);
  }
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
    entryFee: ZERO,
    prize: ZERO,
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
 * Tampoco mira `ENABLED_SEATS`, por lo mismo.
 */
export function replayConfigOf(input: unknown): DominoMatchConfig {
  return matchSnapshot.parse(input);
}
