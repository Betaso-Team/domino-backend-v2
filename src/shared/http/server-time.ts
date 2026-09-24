import type { RequestHandler } from "express";

// LA HORA DEL SERVIDOR, para que el cliente pueda leerla. Node ya manda la cabecera `Date`
// en toda respuesta; lo que falta es el permiso para que el JavaScript de otro origen la
// LEA — sin `Access-Control-Expose-Headers`, el navegador se la esconde al `fetch` aunque
// haya viajado.
//
// Existe por los contadores. Los plazos del juego viajan como un epoch absoluto
// (`activeDeadline`) y el cliente los resta con el reloj del aparato, así que un móvil con
// la hora corrida dibuja mal TODAS las cuentas atrás — y eso llega como "el turno se me
// acabó antes de tiempo", que es un reporte carísimo de depurar y que no tiene nada que ver
// con el servidor.
//
// NO REEMPLAZA AL `serverNow` DE `/config/:roomId`, que sigue siendo la fuente para el
// offset inicial: lo que agrega es que el desfase se pueda volver a medir contra CUALQUIER
// respuesta que el cliente ya esté pidiendo —el health, el catálogo de modos— sin un viaje
// extra ni un endpoint nuevo. Una partida larga con un reloj que deriva no tiene que esperar
// al próximo `/config` para corregirse.
//
// Va como middleware propio y no pegado a una ruta porque no es de ninguna: es de la costura
// HTTP entera.
//
// **No exporta nada más que el permiso, y con eso alcanza.** El resto del CORS ya está
// puesto: en 0.18 Colyseus antepone un listener al servidor HTTP que estampa sus
// `DEFAULT_CORS_HEADERS` en TODA respuesta —no solo en sus rutas de matchmaking— y ahí ya
// viene un `Access-Control-Allow-Origin: *`. Lo único que a esa lista le falta es la
// exposición, que es esto.
//
// Así que acá no se toca el origen permitido: no por prolijidad, sino porque ponerlo sería
// PISAR lo que Colyseus ya decidió desde un middleware que no habla de eso, y el día que
// alguien quiera cerrarlo de verdad el lugar es `matchMaker.controller.getCorsHeaders` y no
// este archivo.
export function exposeServerTime(): RequestHandler {
  return (_req, res, next) => {
    res.setHeader("Access-Control-Expose-Headers", "Date");
    next();
  };
}
