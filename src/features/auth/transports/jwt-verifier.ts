import { type KeyObject, createPrivateKey, createPublicKey } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Identity, TokenVerifier } from "../identity";
import { InvalidTokenError } from "../identity";

// billing-auth firma `aud: ['orchestrator','domino']` para TODOS los juegos, así que la audiencia no
// dice de cuál es el token. El claim `game` sí: un ES256 de truco pasaría el emisor y la audiencia,
// y sin esta exigencia sentaría a su dueño en una mesa de dominó.
const BILLING_GAME = "domino";

/** Cómo reconocer un token de billing-auth: su clave pública, quién lo emite y para quién. */
export interface BillingAuthTrust {
  readonly publicKeyPem: string;
  readonly issuer: string;
  readonly audience: string;
}

/**
 * Verifica las identidades que emite billing-auth: ES256 contra su clave pública, y NADA MÁS. Todo
 * jugador llega por el orquestador con el token de billing-auth; no hay otro emisor. Solo verifica:
 * no puede firmar.
 *
 * EL ALGORITMO LO FIJA ESTE LADO, no el header del token: `algorithms: ["ES256"]` rechaza un HS256
 * aunque esté "firmado" con la clave pública como secreto (la confusión de algoritmos).
 */
export class JwtVerifier implements TokenVerifier {
  // La clave ya parseada y validada: se arma UNA vez, al construir, no en cada verificación.
  private readonly key: KeyObject;

  constructor(private readonly trust: BillingAuthTrust) {
    this.key = parseBillingKey(trust.publicKeyPem);
  }

  async verify(token: string | undefined): Promise<Identity> {
    if (token === undefined) {
      throw new InvalidTokenError("ausente");
    }

    let payload: string | jwt.JwtPayload;
    try {
      payload = jwt.verify(token, this.key, {
        algorithms: ["ES256"],
        issuer: this.trust.issuer,
        audience: this.trust.audience,
      });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : "irreconocible";
      throw new InvalidTokenError(reason);
    }

    if (typeof payload === "string") {
      throw new InvalidTokenError("payload no es un objeto");
    }
    // billing-auth SIEMPRE pone `exp`: un token sin vencimiento no es uno suyo.
    if (typeof payload.exp !== "number") {
      throw new InvalidTokenError("sin claim exp");
    }
    if (payload.game !== BILLING_GAME) {
      throw new InvalidTokenError("el token no es de dominó");
    }
    if (typeof payload.sub !== "string" || payload.sub.trim().length === 0) {
      throw new InvalidTokenError("sin claim sub");
    }
    return { userId: payload.sub.trim() };
  }
}

// FALLA AL ARRANCAR, no jugador por jugador: el constructor corre al armar el container. Acepta
// SOLO una clave pública EC P-256 (ES256). Una clave PRIVADA se rechaza aunque Node sepa derivar
// de ella la pública: dominó solo verifica, y no debe tener en la config nada con lo que firmar.
function parseBillingKey(pem: string): KeyObject {
  if (isPrivateKey(pem)) {
    throw new Error(
      "BILLING_AUTH_PUBLIC_KEY contiene una clave PRIVADA: debe ser la clave PÚBLICA de billing-auth",
    );
  }
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new Error("BILLING_AUTH_PUBLIC_KEY no es un PEM de clave pública válido");
  }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    throw new Error("BILLING_AUTH_PUBLIC_KEY debe ser una clave pública EC P-256 (ES256)");
  }
  return key;
}

function isPrivateKey(pem: string): boolean {
  try {
    createPrivateKey(pem);
    return true;
  } catch {
    return false;
  }
}
