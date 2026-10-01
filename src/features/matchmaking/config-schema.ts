import { z } from "zod";
import type { MatchmakingConfig } from "./config";

// LA CONFIG DEL EMPAREJAMIENTO, EDITABLE EN CALIENTE. Portado de truco (`3cab0f8`).
const SECOND = 1_000;

const ms = (min: number, max: number) => z.number().int().min(min).max(max);

const FIELDS = {
  // Un timer de Node SATURA: pasado 2^31-1 ms dispara al milisegundo, así que un número con dígitos
  // de más no alarga la espera, rechaza a todos los encolados de golpe. Las cotas son las de v1
  // (`TIMEOUT_LIMITS.MATCHMAKING`: de 30 s a 10 minutos).
  searchTimeoutMs: ms(30 * SECOND, 10 * 60 * SECOND),
  // El cero es legítimo: es el veto sin demorar a nadie.
  vetoBypassMs: ms(0, 10 * 60 * SECOND),
  // Combinaciones de n tomadas de a `seats`, cuatro veces por segundo: con 12 son 495, con 60 son
  // 487 635.
  groupingCandidates: z.number().int().min(2).max(20),
  maxRematchesPerChain: z.number().int().min(0).max(10),
} as const;

// LOS CAMPOS QUE NO SE EDITAN EN CALIENTE, y por qué: EL PROCESO LOS LEE UNA VEZ, AL ARRANCAR, y se
// los entrega a un intervalo que nunca se vuelve a armar.
//
// Se dejan AFUERA en vez de aceptarlos e ignorarlos. Un operador que baja el tick, no ve cambiar nada
// y nadie le avisa deja de confiar en el panel para los campos que sí funcionan.
export const MATCHMAKING_NOT_EDITABLE = [
  "tickIntervalMs",
  "maintenancePollMs",
  "censusPollMs",
] as const;

// Un parche sobre la afinación del emparejamiento: parcial y estricto, como el de la partida.
export const matchmakingConfigPatch = z.strictObject(FIELDS).partial() satisfies z.ZodType<
  Partial<MatchmakingConfig>
>;

export const MATCHMAKING_EDITABLE: readonly string[] = Object.keys(FIELDS);
