import type { Application as Express } from "express";
import { z } from "zod";
import type { Logger } from "../../../../logger.js";
import { requireInternalKey } from "../../../../shared/http/internal-key.js";
import { validated } from "../../../../shared/http/validated.js";
import type { Clock } from "../../core/engine/clock.js";
import type { HistoryReader } from "../../network/history.js";
import type { MatchConfigResponse, MatchRegistry } from "../match-registry.js";

// En una const para que el aviso de arranque y el `app.get` no puedan divergir: el warn
// existe para que el operador encuentre ESTA ruta, no una parecida.
const HISTORY_ROUTE = "/internal/matches/:matchId/history";

// EL `roomId` LO GENERA COLYSEUS, y la forma sale del `node_modules`, no de la memoria:
// `MatchMaker.mjs:283` hace `room.roomId = generateId()`, y `generateId` es `nanoid(9)`
// (`@colyseus/core/build/utils/Utils.mjs:15`) sobre el `urlAlphabet` de nanoid
// (`nanoid/url-alphabet/index.js:1`), que son exactamente 64 símbolos: `[A-Za-z0-9_-]`.
//
// El ALFABETO se fija; el LARGO no. Son nueve caracteres hoy, pero `MatchMaker.mjs:281`
// tiene una rama que restaura un `roomId` anterior en devMode, y `generateId` acepta un
// largo. Clavar `.length(9)` haría que la pieza rechace tráfico legítimo el día que
// cualquiera de las dos cosas cambie —y rechazar lo bueno es peor que no validar—, así que
// el largo queda holgado y lo que atrapa lo absurdo es el alfabeto.
const CONFIG_PARAMS = z.object({
  roomId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, "roomId inválido"),
});

// EL `matchId` NO TIENE FORMA GARANTIZADA, y el schema lo dice en vez de inventarla.
// `DominoRoomOptions.matchId` es `string` pelado (`../match-contract.ts`) y lo elige quien
// crea la sala; hoy el único productor es el arnés de tests (`m-${seats.join("-")}` en
// `../../tests/e2e-harness.ts`) y el matchmaking que va a ser el productor real todavía no
// existe. Un regex adivinado acá rechazaría partidas legítimas el día que ese productor
// aparezca con otro formato, así que se elige lo MÁS PERMISIVO que igual atrape lo absurdo:
// largo acotado y sin caracteres de control.
//
// `\P{Cc}` y no una clase con los códigos escritos: es la categoría Unicode "Control", así
// que cubre también los C1 y no mete caracteres de control literales en el fuente —que es
// lo que la regla `noControlCharactersInRegex` de biome prohíbe—.
//
// Los controles NO son un capricho: este `matchId` entra del cliente y SALE en la respuesta
// (`{ matchId, entries }`), o sea que hoy es la única entrada del HTTP que se refleja tal
// cual. Un `%0A` llega decodificado a `request.params`, y el día que alguien meta este id en
// una línea de log —lo natural en un endpoint de soporte— ese salto parte la línea en dos y
// deja escribir una entrada falsa. Cortarlo acá es más barato que acordarse después.
const HISTORY_PARAMS = z.object({
  matchId: z
    .string()
    .min(1)
    .max(128)
    .regex(/^\P{Cc}+$/u, "matchId inválido"),
});

// TODAS las dependencias entran por PARÁMETRO OBLIGATORIO, ninguna con default y ninguna
// leída de `env` acá adentro. El razonamiento ya estaba escrito para la llave interna
// —con un default, `undefined` vuelve a caer en el valor del entorno, así es JS, y el caso
// "no hay llave" queda irrepresentable— y vale igual para las otras cuatro: un default es
// una dependencia que el llamador cree haber elegido.
//
// UN OBJETO y no cinco posicionales. Con posicionales, `(app, registry, clock, logger,
// history, key)` deja tres parámetros de tipos estructuralmente compatibles seguidos
// —`Clock`, `Logger` y `HistoryReader` son interfaces de un puñado de métodos—, así que
// dos argumentos cambiados de orden pueden compilar. Nombrados, un cruce es un error en la
// propiedad. De paso el `internalApiKey` sigue leyéndose por su nombre en el call site,
// que es donde importa que se vea la decisión de fail-closed.
export interface MatchHttpDeps {
  readonly registry: MatchRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly history: HistoryReader;
  /** `undefined` ⇒ la ruta interna NO se registra. Ver registerInternalHistoryHttp. */
  readonly internalApiKey: string | undefined;
}

// RECIBE sus dependencias en vez de resolverlas del container: resolver es una operación de
// COMPOSICIÓN y un transporte no es un composition root (Regla 3). Recibir el CONTAINER
// como parámetro no habría alcanzado —mueve el acoplamiento sin quitarlo: la función
// seguiría dependiendo de tsyringe, escondiendo qué necesita, y sin poder testearse sin
// armar un container—. Lo que un transporte no puede saber es que el container existe.
export function registerMatchHttp(app: Express, deps: MatchHttpDeps): void {
  app.get(
    "/config/:roomId",
    // Un `roomId` de forma imposible es 400 ANTES de consultar, y no un 404 después. La
    // diferencia no es cosmética: 400 y 404 son dos respuestas distintas para el cliente
    // —"pediste mal" contra "eso no existe"— y sin el schema las dos caían en la misma,
    // porque cualquier cosa rara se volvía una búsqueda fallida.
    //
    // Y DESDE QUE EL REGISTRO ES COMPARTIDO la guarda dejó de ser barata en el buen sentido: lo
    // que antes era un `Map.get` ahora es una CLAVE que se arma concatenando lo que mandó el
    // cliente (`match_config:${roomId}`), contra un almacén que el clúster entero comparte.
    //
    // EL `await` ES LO ÚNICO QUE EL REGISTRO COMPARTIDO LE PIDIÓ A ESTA RUTA, y llegó gratis:
    // este handler ya podía ser asíncrono porque `validated` reenvía el rechazo a `next` desde
    // que el historial lo necesitó. Lo que cambió del otro lado es la RESPUESTA: antes, un
    // `GET /config/:roomId` que caía en un proceso distinto del que hospeda la sala daba 404
    // —"eso no existe"— con total confianza y total falsedad; ahora la pregunta va al almacén
    // compartido y contesta igual desde cualquier instancia.
    validated({ params: CONFIG_PARAMS }, async ({ params }, response) => {
      const config = await deps.registry.publicConfigOf(params.roomId);
      if (!config) {
        response.status(404).json({ error: "NOT_FOUND" });
        return;
      }

      // El seed nunca cruza esta frontera. serverNow viaja con el pedido que el cliente ya
      // hacía, para calcular el offset de reloj con el que lee activeDeadline.
      const body: MatchConfigResponse = { ...config, serverNow: deps.clock.now() };
      response.set("Cache-Control", "no-store").json(body);
    }),
  );

  registerInternalHistoryHttp(app, deps);
}

export function registerInternalHistoryHttp(
  app: Express,
  { logger, history, internalApiKey }: Pick<MatchHttpDeps, "logger" | "history" | "internalApiKey">,
): void {
  // FAIL CLOSED: sin llave configurada la ruta interna NO EXISTE. La alternativa —
  // registrarla igual y dejar el guard comparando contra vacío— es peor que no tenerla,
  // porque el operador la ve responder y cree que está protegida.
  if (!internalApiKey) {
    // La RUTA va en el mensaje, no solo la causa y la variable. El que llega a este log
    // llega desde un 404 inexplicable, y busca por path: sin el path acá, el aviso que
    // explica el 404 es justamente el que no encuentra.
    logger.warn(
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
  // EL ORDEN DE LOS DOS HANDLERS ES EL CONTRATO: primero se prueba QUIÉN SOS, después QUÉ
  // MANDASTE. Al revés, un anónimo podría distinguir "forma inválida" de "forma válida" en
  // una ruta que no tiene derecho a tocar — un oráculo gratis sobre el formato de los ids
  // internos, servido antes de pedir la credencial.
  //
  // El genérico explícito `app.get<{ matchId: string }>` que estaba acá YA NO HACE FALTA, y
  // es la pieza la que lo reemplaza. Estaba porque con el overload de tres argumentos
  // —path, guardia, handler— Express deja de inferir los params del literal de ruta y
  // `request.params.matchId` pasaba a ser `string | string[] | undefined`. Ahora el tipo no
  // sale de la inferencia del literal sino del schema, que es la fuente de verdad, y el
  // handler ni siquiera toca `request`. Verificado contra `tsc --noEmit` y no contra el
  // verde de vitest, que borra los tipos sin chequearlos.
  app.get(
    HISTORY_ROUTE,
    requireInternalKey(internalApiKey),
    validated({ params: HISTORY_PARAMS }, async ({ params }, response) => {
      // Contra `HistoryReader` y no contra la implementación: el cast a `MemoryHistory`
      // que estaba acá compilaba una promesa que el token no hacía.
      //
      // El `await` es el único cambio que la persistencia le pidió a esta ruta, y no lleva
      // `try`/`catch`: si la consulta a Mongo revienta, `validated` reenvía el rechazo a
      // `next` y `httpErrorHandler` responde 500. Tragarlo acá devolvería el mismo 404 que
      // "esa partida no existe", y en un endpoint de soporte confundir "la base no
      // contesta" con "no hay nada" manda al operador a investigar la mesa equivocada.
      const entries = [...(await history.of(params.matchId))].sort((a, b) => a.seq - b.seq);
      if (entries.length === 0) {
        response.status(404).json({ error: "NOT_FOUND" });
        return;
      }
      // El `matchId` que sale es el PARSEADO, no `request.params`: lo que se refleja al
      // cliente pasó por el schema, que es la mitad de la razón para validarlo acá.
      response.json({ matchId: params.matchId, entries });
    }),
  );
}
