import jwt from "jsonwebtoken";
import type { Identity, TokenVerifier } from "../identity.js";
import { InvalidTokenError } from "../identity.js";

// La lista explícita evita que el token elija un algoritmo distinto al contratado.
const ALGORITHMS: jwt.Algorithm[] = ["HS256"];

/**
 * Verifica identidades emitidas por el backend principal.
 * Este adaptador solo verifica: no puede firmar ni emitir identidades. El secreto se
 * comparte con el backend principal, que es el único que firma los tokens.
 */
export class JwtVerifier implements TokenVerifier {
  constructor(private readonly secret: string) {}

  async verify(token: string | undefined): Promise<Identity> {
    if (token === undefined) {
      throw new InvalidTokenError("ausente");
    }

    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, this.secret, { algorithms: ALGORITHMS });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "irreconocible";
      throw new InvalidTokenError(reason);
    }

    if (
      typeof payload === "string" ||
      typeof payload.sub !== "string" ||
      payload.sub.length === 0
    ) {
      throw new InvalidTokenError("sin claim sub");
    }

    return { userId: payload.sub };
  }
}
