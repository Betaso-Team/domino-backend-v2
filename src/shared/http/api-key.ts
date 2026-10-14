import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

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

/** Un operador de Betaso Games, según el token que billing-auth le emitió al iniciar sesión. */
export interface Operator {
  readonly name: string;
  readonly roles: readonly string[];
}

/**
 * Quién es el operador de un `Bearer`, o `undefined` si no es un token de operador válido. La
 * implementación vive en `features/auth` (verifica contra la clave pública de billing-auth); acá
 * solo se usa, para que esta puerta no dependa de esa feature.
 */
export type OperatorCheck = (token: string) => Promise<Operator | undefined>;

// LA PUERTA DE ENTRADA DEL PANEL, con dos credenciales:
// - la llave (`x-internal-api-key`), que autoriza pero no identifica: dice que habla el panel o un
//   script, no qué administrador apretó el botón;
// - el token de operador (`Authorization: Bearer`), que emite billing-auth al iniciar sesión el
//   operador en el panel. Ese sí identifica, y trae sus roles: si la ruta pide uno (`role`) y el
//   operador no lo tiene, 403. Con él el panel entra sin pedirle nada al backend de Betaso.
// El orquestador entra por el mismo guardia con SU llave (`requireApiKey`): cada llave abre las rutas
// que se le montaron y ninguna otra.
export const requireAdminKey =
  (expected: string, operators?: OperatorCheck, role?: string): RequestHandler =>
  (request, response, next) => {
    const provided = request.get(API_KEY_HEADER);
    if (provided && sameKey(provided, expected)) {
      next();
      return;
    }
    const bearer = /^Bearer (.+)$/.exec(request.get("authorization") ?? "")?.[1];
    if (!bearer || !operators) {
      response.status(401).json({ error: "UNAUTHORIZED" });
      return;
    }
    operators(bearer).then(
      (operator) => {
        if (!operator) {
          response.status(401).json({ error: "UNAUTHORIZED" });
          return;
        }
        if (role && !operator.roles.includes(role)) {
          response.status(403).json({ error: "FORBIDDEN" });
          return;
        }
        response.locals.operator = operator.name;
        next();
      },
      () => response.status(401).json({ error: "UNAUTHORIZED" }),
    );
  };

// EL MISMO GUARDIA para cualquier llave de entrada: entre el panel y el orquestador cambia la
// llave, no el chequeo. El orquestador nunca trae token de operador: no se le pasa `operators`.
export const requireApiKey = (expected: string): RequestHandler => requireAdminKey(expected);
