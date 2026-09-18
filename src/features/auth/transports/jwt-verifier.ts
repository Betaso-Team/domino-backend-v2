import jwt from "jsonwebtoken";
import type { Identity, TokenVerifier } from "../identity";
import { InvalidTokenError } from "../identity";

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

    // LAS DOS MITADES DE LA IDENTIDAD SE EXIGEN JUNTAS. `platformId` no es un claim
    // opcional que se pueda completar después: sin él, el mismo `sub` firmado por dos
    // productos del Betaso reclama el mismo asiento, y el asiento paga.
    //
    // Se rechaza el BLANCO además del vacío —`"   "` es un string de largo 3— porque lo
    // que se arma con estos dos valores es una clave del registro compartido, y una clave
    // hecha de espacios agrupa a todos los que la mandaron en blanco.
    if (typeof payload === "string") {
      throw new InvalidTokenError("payload no es un objeto");
    }
    const platformId = payload.platformId;
    if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
      throw new InvalidTokenError("sin claim sub");
    }
    if (typeof platformId !== "string" || platformId.trim().length === 0) {
      throw new InvalidTokenError("sin claim platformId");
    }

    // SE DEVUELVE NORMALIZADA, igual que la normaliza `configOf` del otro lado (ver el
    // comentario de `identityPart` en `transports/match-contract.ts`). Validar con trim y
    // devolver sin trim haría que `"betaso "` en el token y `"betaso"` en el asiento pasen
    // las dos validaciones y fallen el cruce de `onJoin`: rechazo de asiento con la
    // inscripción ya cobrada. La comparación tiene que ser contra el MISMO valor.
    return { platformId: platformId.trim(), userUuid: payload.sub.trim() };
  }
}
