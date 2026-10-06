import { traceFrom, withTrace } from "@/shared/trace";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * ABRE LA CAUSA DE UNA REQUEST: continúa la que trae el `traceparent` o empieza una nueva, y corre
 * TODO lo que sigue adentro. Portado de truco (`f8215bd`).
 *
 * **Va primero de todo**, antes incluso del log de requests: lo que no esté adentro de este alcance
 * no lleva `traceId`, y eso incluye la línea que cierra la request.
 *
 * Es un middleware propio y no un pedazo del log de requests porque son dos conceptos: uno abre un
 * alcance causal, útil a todo lo que corra abajo registre o no, y el otro cuenta cómo terminó.
 * Usarse juntos no los vuelve uno.
 */
export function traceScope(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    // `next()` corre ADENTRO, así que toda la cadena que sigue —y los `await` de cada handler—
    // hereda la causa sin que nadie la nombre.
    withTrace(traceFrom(req.headers), next);
  };
}
