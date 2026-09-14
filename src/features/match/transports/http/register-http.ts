import { timingSafeEqual } from "node:crypto";
import type { Application as Express, RequestHandler } from "express";
import { rootContainer } from "../../../../di-container.js";
import { env } from "../../../../env.js";
import type { Logger } from "../../../../logger.js";
import type { Clock } from "../../core/engine/clock.js";
import type { HistoryReader } from "../../network/history.js";
import { type MatchConfigResponse, MatchRegistry } from "../match-registry.js";

const INTERNAL_KEY_HEADER = "X-Internal-Key";
// En una const para que el aviso de arranque y el `app.get` no puedan divergir: el warn
// existe para que el operador encuentre ESTA ruta, no una parecida.
const HISTORY_ROUTE = "/internal/matches/:matchId/history";

// Comparación en tiempo CONSTANTE. Un `===` sobre un secreto corta en el primer byte que
// difiere, así que el tiempo de respuesta filtra la llave carácter a carácter y se la
// puede reconstruir con suficientes pedidos. `timingSafeEqual` LANZA si los buffers no
// miden lo mismo, así que el guard de largo es obligatorio — y no filtra nada que importe:
// el largo de la llave no es el secreto, la llave sí.
function sameKey(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

// 401 y no 404: acá el recurso puede existir perfectamente y lo que falta es la
// credencial. Es middleware y no un `if` dentro del handler para que la próxima ruta
// `/internal/*` no pueda nacer sin guardia por olvido.
function requireInternalKey(expected: string): RequestHandler {
  return (request, response, next) => {
    const provided = request.get(INTERNAL_KEY_HEADER);
    if (provided && sameKey(provided, expected)) {
      next();
      return;
    }
    response.status(401).json({ error: "UNAUTHORIZED" });
  };
}

export function registerMatchHttp(app: Express): void {
  app.get("/config/:roomId", (request, response) => {
    const registry = rootContainer.resolve(MatchRegistry);
    const config = registry.publicConfigOf(request.params.roomId);
    if (!config) {
      response.status(404).json({ error: "NOT_FOUND" });
      return;
    }

    const clock = rootContainer.resolve<Clock>("Clock");
    // El seed nunca cruza esta frontera. serverNow viaja con el pedido que el cliente ya
    // hacía, para calcular el offset de reloj con el que lee activeDeadline.
    const body: MatchConfigResponse = { ...config, serverNow: clock.now() };
    response.set("Cache-Control", "no-store").json(body);
  });

  registerInternalHistoryHttp(app, env.internalApiKey);
}

// La llave entra por PARÁMETRO OBLIGATORIO, no como default (`internalApiKey = env...`) y
// no leyendo `env` acá adentro. Con un default, `registerInternalHistoryHttp(app, undefined)`
// vuelve a caer en el valor del entorno —así es JS—, o sea que el caso "no hay llave" sería
// irrepresentable y su test no mediría nada. Se descubrió escribiéndolo: pasaba en verde
// contra la rama equivocada.
export function registerInternalHistoryHttp(
  app: Express,
  internalApiKey: string | undefined,
): void {
  // FAIL CLOSED: sin llave configurada la ruta interna NO EXISTE. La alternativa —
  // registrarla igual y dejar el guard comparando contra vacío— es peor que no tenerla,
  // porque el operador la ve responder y cree que está protegida.
  if (!internalApiKey) {
    // La RUTA va en el mensaje, no solo la causa y la variable. El que llega a este log
    // llega desde un 404 inexplicable, y busca por path: sin el path acá, el aviso que
    // explica el 404 es justamente el que no encuentra.
    rootContainer
      .resolve<Logger>("Logger")
      .warn(
        `API interna deshabilitada: falta INTERNAL_API_KEY, la ruta ${HISTORY_ROUTE} no se registra`,
      );
    return;
  }

  // Para soporte, detrás de la API key interna. Es el registro COMPLETO de una partida y
  // el `matchId` es enumerable, así que sin llave cualquiera que alcance el HTTP se lleva
  // el historial de cualquier mesa. Hoy ninguna entrada lleva información privada —
  // `DRAW_TILE` graba el jugador y no la ficha—, pero eso es una propiedad del catálogo de
  // hoy, no una barrera: el día que un payload cargue algo oculto, esto pasa a ser vector
  // de trampa sin nada que lo frene. Con plata de por medio, se rechaza.
  // El parámetro de ruta va EXPLÍCITO. Con el overload de tres argumentos —path, guardia,
  // handler— Express deja de inferir los params del literal y `request.params.matchId`
  // pasa a ser `string | string[] | undefined`. Vitest no lo ve (esbuild borra los tipos);
  // `tsc --noEmit` sí.
  app.get<{ matchId: string }>(
    HISTORY_ROUTE,
    requireInternalKey(internalApiKey),
    (request, response) => {
      // Contra `HistoryReader` y no contra la implementación: el cast a `MemoryHistory`
      // que estaba acá compilaba una promesa que el token no hacía.
      const reader = rootContainer.resolve<HistoryReader>("HistoryReader");
      const entries = reader.of(request.params.matchId);
      if (entries.length === 0) {
        response.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      response.json({ matchId: request.params.matchId, entries });
    },
  );
}
