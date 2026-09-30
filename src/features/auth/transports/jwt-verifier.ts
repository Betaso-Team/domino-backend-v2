import jwt from "jsonwebtoken";
import type { Identity, TokenVerifier } from "../identity";
import { InvalidTokenError } from "../identity";

// La lista explícita evita que el token elija un algoritmo distinto al contratado.
const ALGORITHMS: jwt.Algorithm[] = ["HS256"];

/** Cómo reconocer un token de billing-auth: su clave pública, quién lo emite y para quién. */
export interface BillingAuthTrust {
  readonly publicKeyPem: string;
  readonly issuer: string;
  readonly audience: string;
}

/**
 * Verifica identidades emitidas por el backend principal (HS256, secreto compartido) y, si se le
 * da su clave, por billing-auth (ES256, clave pública). Solo verifica: no puede firmar.
 *
 * EL `alg` DEL HEADER ELIGE LA CLAVE, NO EL ALGORITMO. Cada rama fija el suyo: un token que dice
 * ES256 se verifica solo como ES256 contra la clave pública, y cualquier otro solo como HS256
 * contra el secreto. Así un token no puede hacer que su firma se compruebe con la clave que no le
 * corresponde. Conviven mientras el lobby propio de dominó siga recibiendo tokens del backend
 * principal.
 */
export class JwtVerifier implements TokenVerifier {
  constructor(
    private readonly secret: string,
    private readonly billingAuth?: BillingAuthTrust,
  ) {}

  async verify(token: string | undefined): Promise<Identity> {
    if (token === undefined) {
      throw new InvalidTokenError("ausente");
    }

    let payload: string | jwt.JwtPayload;
    try {
      payload =
        this.billingAuth && algorithmOf(token) === "ES256"
          ? jwt.verify(token, this.billingAuth.publicKeyPem, {
              algorithms: ["ES256"],
              issuer: this.billingAuth.issuer,
              audience: this.billingAuth.audience,
            })
          : jwt.verify(token, this.secret, { algorithms: ALGORITHMS });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "irreconocible";
      throw new InvalidTokenError(reason);
    }

    if (typeof payload === "string") {
      throw new InvalidTokenError("payload no es un objeto");
    }
    if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
      throw new InvalidTokenError("sin claim sub");
    }
    return { userId: payload.sub.trim() };
  }
}

// Solo LEE el header para elegir la rama; la firma la comprueba `jwt.verify` después.
function algorithmOf(token: string): string | undefined {
  return jwt.decode(token, { complete: true })?.header.alg;
}
