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
  platformId: nonBlank,
  userUuid: nonBlank,
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
