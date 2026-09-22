import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

// LAS DOS LLAVES DE SERVIDOR cruzan esta frontera en direcciones opuestas, y viajan en el MISMO
// header: la que el dominó PRESENTA al backend de Betaso (`features/auth/api-key.ts`) y la que el
// PANEL DE ADMINISTRACIÓN de Betaso le presenta al dominó (la puerta de abajo). Son secretos
// distintos a propósito —compartirlos dejaría que el que tiene la primera, para preguntar un saldo,
// también abra mesas y mueva todos los plazos del juego— y el header es uno solo porque NO es nuestro:
// es el que el backend de Betaso exige en sus rutas internas y el que su panel ya manda (truco
// `ebf22dd`). Se escribe UNA vez, acá, porque es un contrato con la otra punta: repetirlo en cada
// transporte es cómo se termina con dos grafías y un 401 que nadie explica.
//
// Vive en `shared/` y no en `features/auth` porque la puerta la usan cuatro features —catálogo,
// mantenimiento, historial y configuración— que no tienen por qué depender de la de autenticación
// de jugadores.
export const API_KEY_HEADER = "x-internal-api-key";

const sameKey = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

// LA PUERTA DE ENTRADA, y su nombre dice el ÚNICO actor que entra por acá: el panel de
// administración de Betaso. La llave autoriza pero no identifica: dice que habla el panel, no qué
// administrador apretó el botón.
export const requireAdminPanelKey =
  (expected: string): RequestHandler =>
  (request, response, next) => {
    const provided = request.get(API_KEY_HEADER);
    if (provided && sameKey(provided, expected)) {
      next();
      return;
    }
    response.status(401).json({ error: "UNAUTHORIZED" });
  };
