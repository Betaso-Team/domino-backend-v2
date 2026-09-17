import type { PlayerRef } from "@/shared/player-ref";

/**
 * Identidad mínima que el dominio necesita conocer del principal autenticado: la PAREJA
 * `{ platformId, userUuid }` y nada más. Es el mismo tipo que nombra el asiento de una
 * mesa (`shared/player-ref.ts`), y por eso es un alias y no una copia: dos definiciones
 * estructuralmente iguales habrían compilado igual el día que una de las dos crezca.
 */
export type Identity = PlayerRef;

/** Puerto de autenticación: el match no depende del formato ni del emisor del token. */
export interface TokenVerifier {
  verify(token: string | undefined): Promise<Identity>;
}

export class InvalidTokenError extends Error {
  constructor(reason: string) {
    super(`Token inválido: ${reason}`);
    this.name = "InvalidTokenError";
  }
}
