import { type KeyObject, createPrivateKey, createPublicKey } from "node:crypto";
import jwt from "jsonwebtoken";
import type { Identity, TokenVerifier } from "../identity";
import { InvalidTokenError } from "../identity";

// La lista explícita evita que el token elija un algoritmo distinto al contratado.
const ALGORITHMS: jwt.Algorithm[] = ["HS256"];

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
 * Verifica identidades emitidas por el backend principal (HS256, secreto compartido) y, si se le
 * da su clave, por billing-auth (ES256, clave pública). Solo verifica: no puede firmar.
 *
 * EL `alg` DEL HEADER ELIGE LA CLAVE, NO EL ALGORITMO. Cada rama fija el suyo: un token que dice
 * ES256 se verifica solo como ES256 contra la clave pública, y cualquier otro solo como HS256
 * contra el secreto. Así un token no puede hacer que su firma se compruebe con la clave que no le
 * corresponde. Los jugadores que abre el orquestador traen ES256; la rama HS256 queda para los
 * tokens del backend principal.
 */
export class JwtVerifier implements TokenVerifier {
  // La clave ya parseada y validada: se arma UNA vez, al construir, no en cada verificación.
  private readonly billingKey: KeyObject | undefined;

  constructor(
    private readonly secret: string,
    private readonly billingAuth?: BillingAuthTrust,
  ) {
    this.billingKey = billingAuth ? parseBillingKey(billingAuth.publicKeyPem) : undefined;
  }

  async verify(token: string | undefined): Promise<Identity> {
    if (token === undefined) {
      throw new InvalidTokenError("ausente");
    }

    let payload: string | jwt.JwtPayload;
    try {
      payload =
        this.billingAuth && this.billingKey && algorithmOf(token) === "ES256"
          ? jwt.verify(token, this.billingKey, {
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
    // billing-auth SIEMPRE pone `exp`: un ES256 sin vencimiento no es uno suyo. (El HS256 del
    // backend principal queda como estaba.)
    if (this.billingAuth && algorithmOf(token) === "ES256" && typeof payload.exp !== "number") {
      throw new InvalidTokenError("sin claim exp");
    }
    if (this.billingAuth && algorithmOf(token) === "ES256" && payload.game !== BILLING_GAME) {
      throw new InvalidTokenError("el token no es de dominó");
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
