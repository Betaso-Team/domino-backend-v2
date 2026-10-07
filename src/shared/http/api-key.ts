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

// LA PUERTA DE ENTRADA DEL PANEL. La llave autoriza pero no identifica: dice que habla el panel, no
// qué administrador apretó el botón. El orquestador entra por el mismo guardia con SU llave
// (`requireApiKey`): cada llave abre las rutas que se le montaron y ninguna otra.
export const requireAdminKey =
  (expected: string): RequestHandler =>
  (request, response, next) => {
    const provided = request.get(API_KEY_HEADER);
    if (provided && sameKey(provided, expected)) {
      next();
      return;
    }
    response.status(401).json({ error: "UNAUTHORIZED" });
  };

// EL MISMO GUARDIA para cualquier llave de entrada: entre el panel y el orquestador cambia la
// llave, no el chequeo.
export const requireApiKey = requireAdminKey;
