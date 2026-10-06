import type { Logger } from "@/shared/logger";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * UNA LÍNEA POR REQUEST, la frontera de ENTRADA. Un middleware y no una línea por ruta, y ésa es
 * toda la idea: una ruta nueva queda cubierta sin que nadie se acuerde, y una ruta que se olvidó
 * de registrar deja de ser posible. Portado de truco (`e363525`).
 *
 * **Habla al TERMINAR, no al llegar.** Al llegar lo único interesante —cómo salió y cuánto tardó—
 * todavía no se sabe, así que una línea de entrada sería el doble de volumen con la mitad de la
 * historia.
 *
 * **Va DESPUÉS del parser y ANTES de las rutas**, el único lugar desde donde las ve a todas, y
 * DESPUÉS de `traceScope`, para que la línea lleve la causa (`app.config.ts`).
 *
 * El status no decide el nivel: un 4xx NO es un error nuestro —es un cliente pidiendo lo que no
 * puede tener— y registrarlo como tal es la forma clásica de que nadie lea los logs. Un 500 ya lo
 * grita el manejador de errores, así que acá también es `info`: repetirlo en `error` sería la línea
 * duplicada que "el que decide, registra" prohíbe.
 */
export function requestLog(log: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const startedAt = process.hrtime.bigint();

    // LOS DOS FINALES, y una sola línea. `finish` es la respuesta que salió entera; `close` cubre la
    // que no —el cliente cortó, el socket se reseteó, un handler se colgó—, que es justo la request
    // que uno va a buscar cuando algo anda mal. Con sólo `finish` era invisible.
    let said = false;
    const say = (complete: boolean) => {
      if (said) return;
      said = true;
      log.info("request", {
        method: req.method,
        // La ruta REGISTRADA y no la pedida, cuando Express la sabe: con la pedida cada
        // identificador sería un valor distinto y agrupar por endpoint dejaría de ser posible.
        path: req.route?.path ?? req.path,
        status: res.statusCode,
        ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6),
        // Sólo cuando NO terminó: el caso normal no necesita un campo que diga que fue normal.
        ...(complete ? {} : { aborted: true }),
      });
    };

    res.on("finish", () => say(true));
    res.on("close", () => say(false));

    next();
  };
}
