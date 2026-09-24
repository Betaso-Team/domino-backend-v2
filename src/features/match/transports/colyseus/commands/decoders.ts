import type { CommandName, CommandPayload } from "../../../core/command";
import type { PlayerId } from "../../../core/ids";
import { ValidationError } from "../errors";
import type { MessageDecoder } from "../messages";
import { COMMAND_PAYLOADS } from "./payloads";

// `MessageDecoder` YA NO VIVE ACÁ, y ese movimiento es el refactor entero en una línea:
// mientras la interfaz estaba en este archivo su parámetro era `N extends CommandName`, o
// sea que "lo que se puede decodificar del cable" y "los verbos del dominó" eran el mismo
// conjunto POR CONSTRUCCIÓN. Ahora es `MessageDecoder<P>` sobre cualquier payload (ver
// `../messages.ts`) y los verbos pasan a ser UN caso de él: éste, el que valida contra el
// catálogo del motor y le pega la identidad.

// Valida con zod y le suma la identidad AUTENTICADA. El cliente no elige quién es.
export function identityDecoder<N extends CommandName>(name: N): MessageDecoder<CommandPayload<N>> {
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
