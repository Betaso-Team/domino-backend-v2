import type { KeyObject } from "node:crypto";
import type { Admin, AdminTokenCheck } from "@/shared/http/api-key";
import jwt from "jsonwebtoken";
import { type BillingAuthTrust, parseBillingKey } from "./jwt-verifier";

// La audiencia de los tokens de admin de billing-auth: nunca la de un jugador, así que un token de
// jugador (la misma clave y el mismo emisor) no abre una ruta de administración.
const ADMIN_AUDIENCE = "betaso-games-admin";

/**
 * Verifica los tokens de ADMIN que emite billing-auth cuando un admin inicia sesión: ES256 contra su
 * clave pública, uno de sus emisores, la audiencia de administración y `typ: admin`. Nunca lanza: lo
 * que no es un token de admin válido es `undefined`.
 */
export function adminTokenCheck(trust: BillingAuthTrust): AdminTokenCheck {
  const key: KeyObject = parseBillingKey(trust.publicKeyPem);
  return async (token: string): Promise<Admin | undefined> => {
    try {
      const payload = jwt.verify(token, key, {
        algorithms: ["ES256"],
        issuer: trust.issuer,
        audience: ADMIN_AUDIENCE,
      });
      if (typeof payload === "string" || payload.typ !== "admin") return undefined;
      if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return undefined;
      return { name: payload.sub };
    } catch {
      return undefined;
    }
  };
}
