import type { ReactionRelay, ReactionSent } from "@/features/reactions";
import { z } from "zod";
import type { PlayerId } from "../../core/ids";
import { ValidationError } from "./errors";
import type { MessageDecoder, MessageHandler } from "./messages";

// EL CABLE DE LAS REACCIONES, y nada más: cómo se llama el mensaje que entra, cómo se valida, cómo se
// llama el que sale. La feature `reactions` no sabe que existe un socket y esta sala no sabe qué es
// un gesto; acá se tocan. Portado de truco (`f8713f3`).
//
// Es el PRIMER mensaje del cliente que no es un verbo del dominó, y por eso no está en
// `commands/payloads.ts`: aquel archivo cierra la lista de VERBOS contra `CommandName`, y una reacción
// no es un `CommandName` ni debe serlo — no tiene reglas, no muta el estado, no produce eventos de la
// partida ni entra en el historial. Lo que comparte con los verbos es la frontera, y esa la da el
// router.

export const SEND_REACTION = "SEND_REACTION";
export const REACTION_SENT = "REACTION_SENT";

// Lo ÚNICO que el cliente elige. Sin `.strict()`, al revés que los verbos: el front viejo mandaba un
// `targetPlayerId` que el servidor nunca usó, y rechazarlo dejaría mudo a ese cliente por un campo
// que no cambia nada. zod ignora lo que sobra.
const SendReactionSchema = z.object({ reactionId: z.string().min(1).max(64) });

type SendReaction = z.infer<typeof SendReactionSchema>;

// Valida y tipa, con el mismo error que los decoders de los verbos: el cliente aprende UN juego de
// códigos (`illegal` con `MALFORMED`), no uno por clase de mensaje.
export const sendReactionDecoder: MessageDecoder<SendReaction> = {
  decode(raw: unknown): SendReaction {
    const parsed = SendReactionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues.map((issue) => issue.message).join("; "));
    }
    return parsed.data;
  },
};

// Adapta el relay al contrato del router. Va en esta dirección —`match` conoce `reactions`, nunca al
// revés— porque enchufar una feature a una partida es de la partida.
//
// SIN MIRAR LA FASE, a propósito: se puede reaccionar durante el reparto, entre manos y en la
// pantalla del resultado, mientras la sala esté abierta. Quién puede mandar ya lo decidió la puerta:
// a esta sala sólo entra el dueño de un asiento (`onJoin`), y el router recibe el `playerId` de ese
// asiento, nunca uno que mande el cliente.
export function reactionHandler(relay: ReactionRelay): MessageHandler<SendReaction> {
  return {
    handle: async ({ reactionId }: SendReaction, playerId: PlayerId) =>
      relay.relay(playerId, reactionId),
  };
}

// Cómo sale a la mesa. Se difunde a TODOS, incluido el que lo mandó: es lo que hace que todos vean lo
// mismo en el mismo orden, y cada cliente sabe cuál es suyo por el `fromPlayerId` (el `seat-N` de
// `PlayerState.playerId`).
export const broadcastReaction =
  (broadcast: (type: string, payload: unknown) => void) => (sent: ReactionSent) =>
    broadcast(REACTION_SENT, sent);
