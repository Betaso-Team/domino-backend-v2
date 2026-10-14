import type { KeyObject } from "node:crypto";
import type { Operator, OperatorCheck } from "@/shared/http/api-key";
import jwt from "jsonwebtoken";
import { type BillingAuthTrust, parseBillingKey } from "./jwt-verifier";

// La audiencia de los tokens de operador de billing-auth: nunca la de un jugador, así que un token de
// jugador (la misma clave y el mismo emisor) no abre una ruta de administración.
const OPERATOR_AUDIENCE = "betaso-games-admin";

/**
 * Verifica los tokens de OPERADOR que emite billing-auth al iniciar sesión en el panel: ES256 contra su
 * clave pública, uno de sus emisores, la audiencia de administración y `typ: operator`. Nunca lanza:
 * lo que no es un token de operador válido es `undefined`.
 */
export function operatorCheck(trust: BillingAuthTrust): OperatorCheck {
  const key: KeyObject = parseBillingKey(trust.publicKeyPem);
  return async (token: string): Promise<Operator | undefined> => {
    try {
      const payload = jwt.verify(token, key, {
        algorithms: ["ES256"],
        issuer: [...trust.issuer] as [string, ...string[]],
        audience: OPERATOR_AUDIENCE,
      });
      if (typeof payload === "string" || payload.typ !== "operator") return undefined;
      if (typeof payload.sub !== "string" || typeof payload.exp !== "number") return undefined;
      const roles = Array.isArray(payload.roles)
        ? payload.roles.filter((r): r is string => typeof r === "string")
        : [];
      return { name: payload.sub, roles };
    } catch {
      return undefined;
    }
  };
}
