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
  // EL ÚNICO NÚMERO QUE EL CLIENTE ELIGE en todo el wire, y por eso viene apretado: entero,
  // positivo y acotado. Lo que este schema NO decide es si ese nivel EXISTE —eso es del
  // dominio, que tiene el catálogo de la mesa—; acá muere lo que no puede ser un nivel de
  // ninguna mesa, como un `-1` o un `1e9`.
  PROPOSE_BET_MULTIPLIER: z.object({ level: z.number().int().positive().max(100) }).strict(),
  // Booleano OBLIGATORIO y sin default: un "sí" por omisión es lo último que puede tener un
  // mensaje que mueve dinero. Si no vino, el mensaje está mal — y mal es rechazo.
  RESPOND_BET_MULTIPLIER: z.object({ accept: z.boolean() }).strict(),
} satisfies Record<CommandName, z.ZodType>;

export type WirePayload<N extends CommandName> = z.infer<(typeof COMMAND_PAYLOADS)[N]>;
