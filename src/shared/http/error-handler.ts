import type { ErrorRequestHandler } from "express";
import type { Logger } from "../../logger.js";

// LA RED de la capa HTTP: lo que un handler tiró y nadie manejó. Sin esto, Express responde
// su página de error HTML por defecto —con el stack adentro mientras `NODE_ENV` no sea
// production, y en `src/env.ts` el default es `development`—, que es exactamente lo que hoy
// devuelve cualquier ruta que falle. El `express()` sobre el que corren nuestras rutas lo
// construye el transporte de Colyseus (`WebSocketTransport.getExpressApp`) PELADO: sin
// parser de cuerpo y sin manejador de errores. Nadie más iba a poner esto.
//
// Acá sale un JSON con la misma forma que el resto de la capa (`{ error: ... }`, como el 404
// y el 401 de register-http) y el detalle se queda en el log del servidor: un 500 es un BUG
// NUESTRO, así que el cliente no necesita saber cuál — y decírselo sería filtrar la cocina,
// que con plata de por medio es el nombre técnico de un vector.
//
// Es el gemelo del cierre de sala por excepción, con la diferencia que impone el transporte:
// un bug en una sala deja el estado de esa partida sin confiar y por eso la cierra; un bug en
// una request HTTP no deja nada corrupto detrás, así que alcanza con responder y seguir
// sirviendo.
//
// RECIBE el logger en vez de escribir a `console`, por lo mismo que el transporte HTTP recibe
// el suyo: en este repo no hay un solo `console.` y el nivel sale de `env.logLevel`. Un
// `console.error` acá sería la única línea que se escapa de pino.
//
// **Va registrado DESPUÉS de todas las rutas.** Express distingue un manejador de errores de
// un middleware común por la ARIDAD —cuatro parámetros—, así que `next` tiene que estar
// declarado aunque solo se use en el camino de `headersSent`.
export function httpErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error, _request, response, next) => {
    // Si la respuesta ya empezó a salir no hay 500 que mandar: el status y las cabeceras ya
    // viajaron. Lo único correcto es delegar en el manejador por defecto, que corta la
    // conexión.
    if (response.headersSent) {
      next(error);
      return;
    }
    // El STACK, no el Error. `JSON.stringify(new Error(...))` da `{}` —message y stack no
    // son enumerables—, así que pasar el objeto crudo por los campos del logger deja el log
    // vacío justo cuando alguien lo necesita. El stack de V8 ya empieza por "Name: message".
    const detail =
      error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    logger.error("error HTTP sin manejar", { detail });
    response.status(500).json({ error: "INTERNAL" });
  };
}
