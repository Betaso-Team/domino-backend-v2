import { type TokenVerifier, requireBearer } from "@/features/auth";
import { validated } from "@/shared/http/validated";
import { Router } from "express";
import { z } from "zod";
import type { Clock } from "../../core/engine/clock";
import type { MatchConfigResponse, MatchRegistry } from "../match-registry";

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

// UNA PARTIDA: su configuración pública, para el que se va a sentar o ya está sentado. Dos puertas y
// la misma respuesta: `/matches/:roomId` pide token —lleva perfiles y apuesta— y `/config/:roomId`
// es la de siempre, pública, con el `serverNow` del que el cliente saca su desfase de reloj.
export function matchRoutes(deps: {
  readonly registry: MatchRegistry;
  readonly clock: Clock;
  readonly verifier?: TokenVerifier;
}): Router {
  const router = Router();
  if (deps.verifier) {
    router.get(
      "/matches/:roomId",
      requireBearer(deps.verifier),
      validated({ params: CONFIG_PARAMS }, async ({ params }, response) => {
        const match = await deps.registry.publicConfigOf(params.roomId);
        if (!match) {
          response.status(404).json({ error: "ROOM_NOT_FOUND" });
          return;
        }
        response.set("Cache-Control", "no-store").json(match);
      }),
    );
  }
  router.get(
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
  return router;
}
