import type { KeyObject } from "node:crypto";
import type { Admin, AdminRole, AdminTokenCheck } from "@/shared/http/api-key";
import jwt from "jsonwebtoken";
import { type BillingAuthTrust, parseBillingKey } from "./jwt-verifier";

// La audiencia de los tokens de admin de billing-auth: nunca la de un jugador, así que un token de
// jugador (la misma clave y el mismo emisor) no abre una ruta de administración.
const ADMIN_AUDIENCE = "betaso-games-admin";

const ROLES: readonly AdminRole[] = ["admin", "support"];

// LAS DOS CLAIMS DEL ÁMBITO, EXIGIDAS. billing-auth firma en todo token de admin `prv` (el proveedor
// del admin, `null` = Betaso Games) y `role` (`admin` | `support`). Un token sin alguna de las dos es
// de antes de los proveedores o de otro contrato, y no se tolera: leer la ausencia como «Betaso Games,
// admin» sería darle el máximo justo al que no dice quién es. `prv` tiene que estar PRESENTE —texto
// no vacío o `null` explícito—; ausente es `undefined` y el token se rechaza.
function providerOf(payload: jwt.JwtPayload): string | null | undefined {
  if (!("prv" in payload)) return undefined;
  const claim: unknown = payload.prv;
  if (claim === null) return null;
  return typeof claim === "string" && claim.length > 0 ? claim : undefined;
}

function roleOf(claim: unknown): AdminRole | undefined {
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
      const provider = providerOf(payload);
      const role = roleOf(payload.role);
      if (provider === undefined || role === undefined) return undefined;
      return { name: payload.sub, provider, role };
    } catch {
      return undefined;
    }
  };
}
