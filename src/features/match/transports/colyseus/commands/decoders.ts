import type { CommandName, CommandPayload } from "../../../core/command.js";
import type { PlayerId } from "../../../core/ids.js";
import { ValidationError } from "../errors.js";
import { COMMAND_PAYLOADS } from "./payloads.js";

export interface MessageDecoder<N extends CommandName> {
  decode(raw: unknown, playerId: PlayerId): CommandPayload<N>;
}

// Valida con zod y le suma la identidad AUTENTICADA. El cliente no elige quién es.
export function identityDecoder<N extends CommandName>(name: N): MessageDecoder<N> {
  return {
    decode(raw: unknown, playerId: PlayerId): CommandPayload<N> {
      const result = COMMAND_PAYLOADS[name].safeParse(raw ?? {});
      if (!result.success) {
        throw new ValidationError(result.error.issues.map((issue) => issue.message).join("; "));
      }
      // `playerId` va DESPUÉS del spread a propósito: aunque hoy `.strict()` hace que
      // un payload con `playerId` ni llegue hasta acá, el orden deja la inyección
      // ganando por construcción si mañana algún verbo afloja su schema.
      return { ...(result.data as object), playerId } as CommandPayload<N>;
    },
  };
}
