import { z } from "zod";
import type { CommandName } from "../../../core/command.js";

// EL WIRE NO EXPONE PALANCAS. `.strict()` en todos: un campo de más es un rechazo,
// no algo que se ignore en silencio. Y el playerId NO está en ningún schema —lo
// inyecta el decoder desde client.auth—, así que no hay forma de mandarlo.
//
// El `.strict()` es lo que hace que mandar `playerId` desde el cliente REBOTE en vez
// de colarse y ser pisado por el decoder. Las dos conductas dejan al suplantador sin
// efecto; la diferencia es que ésta se lo dice.
//
// `satisfies` cierra el mapa: un verbo nuevo en CommandPayloads sin su fila acá
// NO COMPILA.
export const COMMAND_PAYLOADS = {
  ABANDON: z.object({}).strict(),
  PLAY_TILE: z
    .object({
      left: z.number().int().min(0).max(6),
      right: z.number().int().min(0).max(6),
      side: z.enum(["LEFT", "RIGHT"]),
    })
    .strict(),
  DRAW_TILE: z.object({}).strict(),
  PASS: z.object({}).strict(),
  REVEAL_TILES: z.object({}).strict(),
} satisfies Record<CommandName, z.ZodType>;

export type WirePayload<N extends CommandName> = z.infer<(typeof COMMAND_PAYLOADS)[N]>;
