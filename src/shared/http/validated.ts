import type { RequestHandler, Response } from "express";
import { z } from "zod";

// VALIDA + TIPA la entrada de un endpoint HTTP, en el mismo molde que el `MessageDecoder`
// del wire de Colyseus (`../../features/match/transports/colyseus/commands/decoders.ts`): el
// schema es la fuente de verdad de la FORMA, el handler recibe algo ya válido, y lo que el
// schema no deja pasar no llega. La diferencia con el socket es de forma y no de fondo
// —allá el catálogo de verbos es un mapa cerrado (`COMMAND_PAYLOADS`) y acá cada ruta declara
// lo suyo—, pero la frontera es la misma: **ningún handler ve un `unknown`**.
//
// POR QUÉ VIVE ACÁ. Nació dentro de `features/match/transports/http/` cuando era su único
// consumidor, con un disparador de promoción escrito sobre una línea que se puede ir a
// mirar: «el día que `app.config.ts` tenga una SEGUNDA llamada de registro de rutas». Ese
// día llegó —`registerLobbyHttp` y `registerMatchHttp` conviven ahí, y el catálogo de modos
// trae la tercera—, así que la pieza subió. No es una preferencia de estilo: la Regla 4
// (`feature-boundary`) prohíbe que una feature importe internals de otra, y frente a ese
// error la salida barata es COPIAR el archivo. Dos copias de la costura que decide qué entra
// al sistema divergen en silencio, y la que arreglás no es la que corre. Lo pinea
// `src/architecture.test.ts` — depcruise no puede: una copia sin importadores no crea
// ninguna arista que mirar.
//
// SIN BARREL, y esa parte del disparador viejo no se cumplió a propósito: un `index.ts` de
// `shared/http/` no tendría un solo consumidor que lo use —las tres piezas de esta carpeta
// se importan por su ruta, cada una desde un lugar distinto— y sería una superficie que hay
// que mantener para nadie.
//
// No sabe de `match` ni de ninguna feature: no importa nada de `core/` ni extiende los
// errores de nadie, que es por lo que mudarla fue mover el archivo.

// Las tres fuentes de entrada de un request. Un endpoint declara SOLO las que le llegan; lo
// que no declara no viaja al handler.
interface RouteSchemas {
  params?: z.ZodType;
  query?: z.ZodType;
  body?: z.ZodType;
}

// La entrada YA VALIDADA, tipada DESDE los schemas. Mismo truco que el `WirePayload<N> =
// z.infer<…>` del wire: el tipo del handler no se escribe a mano, se DERIVA, así que el
// schema y el handler no pueden divergir sin que deje de compilar. Una fuente no declarada
// queda `undefined` en el tipo, no `any`: leerla es un error de compilación y no una
// sorpresa en producción.
//
// El `-?` no es cosmético: sin él el tipo hereda la opcionalidad de `RouteSchemas` y hasta
// la fuente que el endpoint SÍ declaró llega como "puede faltar", que es exactamente lo
// contrario de lo que esta pieza promete. Con `-?`, las tres están siempre presentes: la
// declarada con su tipo, la que no con `undefined`.
type Validated<S extends RouteSchemas> = {
  [K in keyof RouteSchemas]-?: S[K] extends z.ZodType ? z.infer<S[K]> : undefined;
};

// El cuerpo de un 400 por forma inválida. MISMO vocabulario que el del socket
// (`{ code: "MALFORMED", detail }`, ver `domino-room.ts` en el `catch` de `ValidationError`):
// el cliente aprende un solo juego de códigos, no uno por transporte.
const MALFORMED = "MALFORMED";

// ENVOLTORIO Y NO MIDDLEWARE, por dos razones. La de tipos pesa más: un middleware no puede
// decirle a TS que `req.query` ya pasó por el schema, y el handler termina casteando a mano
// —que es exactamente el `unknown` disfrazado que esto viene a sacar—. La otra es que en
// Express 5 `req.query` es un GETTER SIN SETTER (`express/lib/request.js:217`, definido con
// `defineGetter` en la línea 508: `configurable` y `enumerable`, sin `set`), así que la
// receta habitual —un middleware que parsea y sobrescribe `req.query`— tira `TypeError` en
// módulo ESM. Acá no se sobrescribe nada: lo parseado va a un objeto aparte que es lo único
// que el handler ve.
export function validated<S extends RouteSchemas>(
  schemas: S,
  handle: (input: Validated<S>, response: Response) => void | Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    const input: Record<string, unknown> = {};
    for (const source of ["params", "query", "body"] as const) {
      const schema = schemas[source];
      if (!schema) continue;
      const parsed = schema.safeParse(request[source]);
      if (!parsed.success) {
        response.status(400).json({ code: MALFORMED, detail: z.prettifyError(parsed.error) });
        return;
      }
      input[source] = parsed.data;
    }
    // El handler puede ser async. Express 5 reenvía las promesas rechazadas al manejador de
    // errores, pero SOLO si el handler devuelve la promesa; acá se encadena explícito para
    // no depender de esa sutileza del framework y para que se vea de dónde sale el 500 que
    // arma `httpErrorHandler`.
    void Promise.resolve(handle(input as Validated<S>, response)).catch(next);
  };
}
