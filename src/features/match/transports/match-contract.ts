import { z } from "zod";
import type { PlayerRef } from "../../../shared/player-ref.js";
import type { DominoMatchConfig } from "../core/config.js";

// Contrato en la raíz de transports porque matchmaking crea las salas. `mode` lo deja
// discriminado para sumar otros orígenes sin adivinar por campos opcionales.
//
// ES LA ÚNICA FRONTERA QUE VALIDA, y por eso valida con zod y no con tipos: lo que llega
// por `createRoom` es un objeto del otro lado del cable, y un `DominoRoomOptions` escrito
// en la firma solo describe lo que se espera —no lo comprueba—. De acá para adentro el
// `DominoMatchConfig` es un dato confiable, y eso incluye la moneda, la tasa y los montos.
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

// LOS MONTOS SON ENTEROS SEGUROS, sin excepción. `Number.isSafeInteger` cierra las tres
// puertas de un solo golpe: la fracción (`12.5` de UC no existe, los centésimos ya son la
// unidad), el desborde de la mantisa —donde dos montos distintos son el mismo número— y
// los no-finitos. El negativo va aparte porque es entero seguro y aun así es un cobro al
// revés.
const ucMinor = z
  .number()
  .refine(Number.isSafeInteger, "debe ser un entero seguro")
  .refine((value) => value >= 0, "no puede ser negativo");

const participant = z.strictObject({
  platformId: identityPart,
  userUuid: identityPart,
  displayName: nonBlank,
  username: nonBlank.optional(),
  profilePicture: nonBlank.optional(),
  currency: nonBlank,
});

const roomOptions = z
  .strictObject({
    mode: z.literal("CASUAL"),
    matchId: nonBlank,
    gameModeId: nonBlank,
    // ⚠ ACEPTA CUATRO Y LA LIQUIDACIÓN NO SABE PAGARLOS. `settlementOf`
    // (`network/settlement.ts`) exige EXACTAMENTE UN ganador, así que el final de una mesa
    // de cuatro lanza `InvariantViolationError` en vez de repartir el premio: no existe la
    // regla escrita de cómo se parte entre compañeros, y repartirlo sin ella sería
    // inventarla al liquidar.
    //
    // Hoy es inofensivo porque nadie liquida. El día que exista el orquestador deja de
    // serlo, y de una forma que conviene ver ANTES: el throw cae DESPUÉS del veredicto, o
    // sea que esa mesa no cobra premio (tiró) ni reembolso (hubo desenlace). Plata trabada.
    // Abrir el 4P de verdad es traer la regla del reparto; este `max(4)` no es esa regla.
    participants: z.array(participant).min(2).max(4),
    seed: nonBlank,
    pointsToWin: z.number().int().positive().safe(),
    teamAssignment: z.enum(["SHUFFLED", "SEAT_ORDER"]),
    rateId: z.uuid(),
    entryFeeUcMinor: ucMinor,
    prizeUcMinor: ucMinor,
  })
  .superRefine(({ participants }, context) => {
    // Una mesa impar no tiene parejas: `assignTeams` repartiría un equipo con un jugador
    // de más, y el marcador acreditaría puntos a un equipo que no existe simétricamente.
    if (participants.length % 2 !== 0) {
      context.addIssue({ code: "custom", path: ["participants"], message: "cantidad impar" });
    }
    // LA PAREJA ENTERA es lo único único. El mismo `userUuid` en dos plataformas son dos
    // personas; el mismo par dos veces es el mismo principal cobrando dos asientos.
    //
    // Corre DESPUÉS del `.transform()` de cada campo —`superRefine` recibe la salida del
    // objeto, no su entrada—, así que `"same"` y `" same "` ya son la misma clave acá: el
    // padding no alcanza para colar la misma pareja dos veces.
    const seen = new Set<string>();
    participants.forEach((value, index) => {
      const key = JSON.stringify([value.platformId, value.userUuid]);
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["participants", index],
          message: "referencia de jugador duplicada",
        });
      }
      seen.add(key);
    });
  });

export type MatchParticipant = z.infer<typeof participant>;
export type DominoRoomOptions = z.infer<typeof roomOptions>;

export interface SeatCredentials extends PlayerRef {
  readonly token: string;
}

export function configOf(input: unknown): DominoMatchConfig {
  const options = roomOptions.parse(input);
  return {
    matchId: options.matchId,
    gameModeId: options.gameModeId,
    // EL ID DEL ASIENTO ES OPACO Y POSICIONAL. Adentro de la partida nadie necesita saber
    // de qué plataforma viene quién: el motor, el historial y el wire hablan de `seat-N`,
    // así que un `playerId` que se filtre no dice nada de la cuenta de nadie. Y es
    // REPRODUCIBLE: el mismo snapshot da los mismos ids, que es lo que le permite al
    // replay rebobinar una partida sin volver a consultar identidades.
    seats: options.participants.map((value, index) => ({
      ...value,
      playerId: `seat-${index + 1}`,
    })),
    seed: options.seed,
    pointsToWin: options.pointsToWin,
    teamAssignment: options.teamAssignment,
    // La ventana siempre está encendida en este contrato: es control de presencia
    // anti-fraude, no una opción que matchmaking pueda omitir por accidente.
    isDealWindowEnabled: true,
    rateId: options.rateId,
    entryFeeUcMinor: options.entryFeeUcMinor,
    prizeUcMinor: options.prizeUcMinor,
  };
}
