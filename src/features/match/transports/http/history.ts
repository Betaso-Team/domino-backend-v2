import type { Logger } from "@/logger";
import { requireAdminPanelKey } from "@/shared/http/api-key";
import { validated } from "@/shared/http/validated";
import { Router } from "express";
import { z } from "zod";
import type { HistoryReader } from "../../network/history";

// En una const para que el aviso de arranque y el `app.get` no puedan divergir: el warn
// existe para que el operador encuentre ESTA ruta, no una parecida.
export const HISTORY_ROUTE = "/internal/matches/:matchId/history";

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
// EL HISTORIAL DE SOPORTE: el registro completo de una partida, para el operador y detrás de la llave
// del panel. Sin llave, la ruta no existe.
export function historyRoutes({
  logger,
  history,
  adminPanelApiKey,
}: {
  readonly logger: Logger;
  readonly history: HistoryReader;
  /** `undefined` ⇒ la ruta NO se registra. */
  readonly adminPanelApiKey: string | undefined;
}): Router {
  const router = Router();
  // FAIL CLOSED: sin llave configurada la ruta interna NO EXISTE. La alternativa —
  // registrarla igual y dejar el guard comparando contra vacío— es peor que no tenerla,
  // porque el operador la ve responder y cree que está protegida.
  if (!adminPanelApiKey) {
    // La RUTA va en el mensaje, no solo la causa y la variable. El que llega a este log
    // llega desde un 404 inexplicable, y busca por path: sin el path acá, el aviso que
    // explica el 404 es justamente el que no encuentra.
    logger.warn(
      `API interna deshabilitada: falta BETASO_ADMIN_PANEL_API_KEY, la ruta ${HISTORY_ROUTE} no se registra`,
    );
    return router;
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
  // El genérico explícito `router.get<{ matchId: string }>` que estaba acá YA NO HACE FALTA, y
  // es la pieza la que lo reemplaza. Estaba porque con el overload de tres argumentos
  // —path, guardia, handler— Express deja de inferir los params del literal de ruta y
  // `request.params.matchId` pasaba a ser `string | string[] | undefined`. Ahora el tipo no
  // sale de la inferencia del literal sino del schema, que es la fuente de verdad, y el
  // handler ni siquiera toca `request`. Verificado contra `tsc --noEmit` y no contra el
  // verde de vitest, que borra los tipos sin chequearlos.
  router.get(
    HISTORY_ROUTE,
    requireAdminPanelKey(adminPanelApiKey),
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
  return router;
}
