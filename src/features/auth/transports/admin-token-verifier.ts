import type { KeyObject } from "node:crypto";
import type { Admin, AdminRole, AdminTokenCheck } from "@/shared/http/api-key";
import jwt from "jsonwebtoken";
import { type BillingAuthTrust, parseBillingKey } from "./jwt-verifier";

// La audiencia de los tokens de admin de billing-auth: nunca la de un jugador, así que un token de
// jugador (la misma clave y el mismo emisor) no abre una ruta de administración.
const ADMIN_AUDIENCE = "betaso-games-admin";

const ROLES: readonly AdminRole[] = ["admin", "support"];

// LAS DOS CLAIMS DEL ÁMBITO, LEÍDAS TOLERANTES. billing-auth agrega `prv` (el operador del admin,
// `null` = Betaso Games) y `role` (`admin` | `support`), y este verificador se despliega ANTES o
// DESPUÉS que esa versión según el entorno. Exigirlas rechazaría todo token emitido antes —el panel
// entero deslogueado durante un TTL—, así que ausente vale lo que valía siempre: Betaso Games y
// `admin`. Lo que no se tolera es un valor PRESENTE que no se entiende: un `prv` que no es texto, o un
// rol desconocido, es un token de otro contrato, y leerlo como el default sería dar de más.
function providerOf(claim: unknown): string | null | undefined {
  if (claim === undefined || claim === null) return null;
  return typeof claim === "string" && claim.length > 0 ? claim : undefined;
}

function roleOf(claim: unknown): AdminRole | undefined {
  if (claim === undefined) return "admin";
  return ROLES.find((role) => role === claim);
}

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
      const provider = providerOf(payload.prv);
      const role = roleOf(payload.role);
      if (provider === undefined || role === undefined) return undefined;
      return { name: payload.sub, provider, role };
    } catch {
      return undefined;
    }
  };
}
