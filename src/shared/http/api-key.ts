import { timingSafeEqual } from "node:crypto";
import type { RequestHandler, Response } from "express";

// SON TRES LLAVES DE SERVIDOR, y cruzan esta frontera en las dos direcciones. Las dos de ENTRADA: la
// de ADMINISTRACIÓN (`ADMIN_API_KEY`) y la del ORQUESTADOR de Betaso Juegos
// (`ORCHESTRATOR_API_KEY`), que abre mesas y pide el asiento de vuelta. La de SALIDA es la que el
// dominó PRESENTA al orquestador para pedir cobros (`ORCHESTRATOR_CALLBACK_API_KEY`). Son secretos distintos a
// propósito —compartirlos dejaría que el que tiene una, para preguntar un saldo, también abra mesas y
// mueva todos los plazos del juego; `parseEnv` rechaza que la del orquestador repita otra— y el
// header es uno solo porque NO es nuestro: es el que el backend de Betaso exige en sus rutas internas
// y el que su panel ya manda (truco `ebf22dd`). Se escribe UNA vez, acá, porque es un contrato con la
// otra punta: repetirlo en cada transporte es cómo se termina con dos grafías y un 401 que nadie
// explica.
//
// Vive en `shared/` y no en `features/auth` porque la puerta la usan cinco features —catálogo,
// mantenimiento, historial, configuración y las mesas del orquestador— que no tienen por qué depender de la de autenticación
// de jugadores.
export const API_KEY_HEADER = "x-internal-api-key";

const sameKey = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

/** Qué puede hacer un admin: `admin` lee y escribe, `support` sólo lee. */
export type AdminRole = "admin" | "support";

/**
 * QUIÉN ESTÁ DEL OTRO LADO de una ruta de administración. `provider` es el operador al que pertenece
 * el admin (`null` = Betaso Games, el dueño del sistema) y `role` qué puede hacer. Lo arma el
 * verificador del token de billing-auth, o la llave, que vale como un admin de Betaso Games.
 */
export interface Admin {
  readonly name: string;
  readonly provider: string | null;
  readonly role: AdminRole;
}

// LA LLAVE ES UN ADMIN DE BETASO GAMES: autoriza todo lo que autorizaba antes de que existieran los
// operadores. No identifica a una persona, así que el nombre dice de dónde vino y nada más.
export const API_KEY_ADMIN: Admin = { name: "ADMIN_API_KEY", provider: null, role: "admin" };

/**
 * Quién es el admin de un `Bearer`, o `undefined` si no es un token de admin válido. La implementación
 * vive en `features/auth` (verifica contra la clave pública de billing-auth); acá solo se usa, para que
 * esta puerta no dependa de esa feature.
 */
export type AdminTokenCheck = (token: string) => Promise<Admin | undefined>;

/**
 * LO QUE UNA RUTA ABRE, además de a un admin de Betaso Games. Los dos son opt-in y el default es el
 * cerrado: una ruta que no dice nada es de escritura y sólo de Betaso Games.
 *
 * - `read`: la ruta sólo lee, así que también entra `support`.
 * - `providers`: entran los admins de un operador. La ruta se compromete a acotar ella misma lo que
 *   cada operador ve y toca; la puerta sólo dice quién es.
 */
export interface AdminAccess {
  readonly read?: boolean;
  readonly providers?: boolean;
}

const deny = (response: Response, status: 401 | 403): void => {
  response.status(status).json({ error: status === 401 ? "UNAUTHORIZED" : "FORBIDDEN" });
};

// LA PUERTA DE ENTRADA DEL PANEL, con dos credenciales:
// - la llave (`x-internal-api-key`), que autoriza pero no identifica: dice que habla el panel o un
//   script, no qué persona apretó el botón. Vale como admin de Betaso Games;
// - el token de admin (`Authorization: Bearer`), que emite billing-auth cuando un admin inicia sesión.
//   Ese sí identifica, y dice además de qué operador es y con qué rol.
//
// ⚠ EL DEFAULT CERRADO ES LA DECISIÓN. Hasta este cambio el token abría todo lo que abría la llave, y
// billing-auth empieza a emitir tokens de ADMINS DE OPERADOR: con el default abierto, un admin de
// Parley entraría como admin total del dominó —el historial de todas las mesas, la configuración en
// caliente, el catálogo entero— el mismo día en que billing-auth despliega, sin una línea cambiada
// acá. Por eso toda ruta que no declare `providers` es de Betaso Games, y toda la que no declare
// `read` exige el rol `admin`. Un 403 de más se ve y se arregla; uno de menos es una fuga.
//
// Lo que deja pasar queda en `response.locals.admin` (un `Admin`), para que la ruta acote lo que ve
// cada operador. `adminOf` lo lee.
export const requireAdminKey =
  (expected: string, adminTokens?: AdminTokenCheck, access: AdminAccess = {}): RequestHandler =>
  (request, response, next) => {
    const admit = (admin: Admin): void => {
      if (admin.provider !== null && access.providers !== true) {
        deny(response, 403);
        return;
      }
      if (admin.role !== "admin" && access.read !== true) {
        deny(response, 403);
        return;
      }
      response.locals.admin = admin;
      next();
    };
    const provided = request.get(API_KEY_HEADER);
    if (provided && sameKey(provided, expected)) {
      admit(API_KEY_ADMIN);
      return;
    }
    const bearer = /^Bearer (.+)$/.exec(request.get("authorization") ?? "")?.[1];
    if (!bearer || !adminTokens) {
      deny(response, 401);
      return;
    }
    adminTokens(bearer).then(
      (admin) => (admin ? admit(admin) : deny(response, 401)),
      () => deny(response, 401),
    );
  };

/**
 * El admin que `requireAdminKey` dejó pasar. Lanza si la ruta no tiene la puerta adelante: una ruta
 * de administración sin principal es un cableado roto, y seguir con un default sería decidir por él.
 */
export function adminOf(response: Response): Admin {
  const admin = response.locals.admin as Admin | undefined;
  if (!admin) throw new Error("ruta de administración sin requireAdminKey adelante");
  return admin;
}

// LA LLAVE DE UN SERVIDOR (el orquestador), y nada más: entre el panel y el orquestador cambia la
// llave, no el chequeo. No deja principal en `locals`: el orquestador no es un admin, y darle el de
// Betaso Games sería una puerta lateral el día que una de sus rutas mire quién es.
export const requireApiKey =
  (expected: string): RequestHandler =>
  (request, response, next) => {
    const provided = request.get(API_KEY_HEADER);
    if (provided && sameKey(provided, expected)) {
      next();
      return;
    }
    deny(response, 401);
  };
