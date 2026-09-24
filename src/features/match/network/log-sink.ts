import type { LogFields, Logger } from "@/shared/logger";
import type { MatchEventSink } from "./listeners";

// LA TRAZA DEL JUEGO: cada hecho de una partida, en el log, para poder reconstruir una mesa que
// se comportó raro.
//
// **ES UN SINK Y NO LÍNEAS ADENTRO DEL MOTOR**, y eso es todo el diseño. El motor es dominio
// puro: no conoce un puerto de salida, y su forma de contar lo que pasó ya existe — devuelve
// eventos. Así que la traza entera cuesta este archivo y ni una línea en los comandos, los
// conductores o los aspectos.
//
// **NO SABE DE NIVELES NI PREGUNTA POR NINGUNO.** Con el debug apagado esta pieza directamente no
// se construye, y de eso se ocupa el composition root — que es el único que lee la configuración.

export function logSink(log: Logger): MatchEventSink {
  return (events) => {
    // EL `event` VA DESPUÉS de los campos del hecho, y no al revés: un hecho que trajera un campo
    // con ese mismo nombre taparía cuál era.
    for (const { type, ...rest } of events) log.debug("hecho", { ...loggable(rest), event: type });
  };
}

/**
 * LO QUE SE PUEDE REGISTRAR DE UN HECHO: escalares y listas de escalares.
 *
 * ⚠ ACÁ EL FILTRO ES MÁS ANCHO QUE EL DE TRUCO, y la diferencia es deliberada. Allá se dejan
 * pasar SOLO escalares, y el argumento es de seguridad: las cartas viajan como objetos y un log
 * con las cartas de una partida en curso convierte el acceso al panel en un vector de trampa.
 *
 * Acá ningún evento lleva fichas —`PLAY_TILE` es un COMANDO y no un evento, y el criterio §5.1 es
 * justamente que no haya eventos que repitan el payload de un comando—, así que el filtro estricto
 * no protegería nada y sí perdería lo único interesante de tres hechos: `playerIds`, que es la
 * lista de asientos de `MULTIPLIER_AGREED`, `REMATCH_ACCEPTED` y los dos vetos. Una traza que no
 * dice a quiénes alcanzó no sirve para reconstruir nada.
 *
 * LO QUE SÍ SE SIGUE DEJANDO AFUERA son los objetos, y por las dos razones que truco escribe:
 *
 *   · SEGURIDAD, por construcción y no por una lista de campos prohibidos que alguien mantiene:
 *     el día que un evento del dominó lleve una ficha, la lleva como objeto y no sale.
 *   · CORRECCIÓN: esparcir un nodo del schema devuelve un objeto VACÍO, así que un nodo logueado
 *     tal cual saldría en blanco igual. El historial lo resuelve porque necesita el payload
 *     entero; el log no.
 */
function loggable(payload: object): LogFields {
  const out: LogFields = {};
  for (const [key, value] of Object.entries(payload)) {
    if (value === null || typeof value !== "object") out[key] = value;
    else if (Array.isArray(value) && value.every((item) => typeof item !== "object")) {
      out[key] = [...value];
    }
  }
  return out;
}
