import type { TokenVerifier } from "@/features/auth";
import type { Logger } from "@/logger";
import { Router } from "express";
import type { Clock } from "../../core/engine/clock";
import type { HistoryReader } from "../../network/history";
import type { ColyseusMatchGateway } from "../colyseus/gateway";
import type { MatchRegistry } from "../match-registry";
import { historyRoutes } from "./history";
import { matchRoutes } from "./match";
import { tablesRoutes } from "./tables";

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
// propiedad. De paso el `adminApiKey` sigue leyéndose por su nombre en el call site,
// que es donde importa que se vea la decisión de fail-closed.
export interface MatchHttpDeps {
  readonly registry: MatchRegistry;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly history: HistoryReader;
  /** `undefined` ⇒ la ruta interna NO se registra. Ver `historyRoutes`. */
  readonly adminApiKey: string | undefined;
  readonly tables: Pick<ColyseusMatchGateway, "openRequest" | "seatBack">;
  /** `undefined` ⇒ la API del orquestador NO se registra. Ver `tablesRoutes`. */
  readonly orchestratorApiKey: string | undefined;
  readonly verifier?: TokenVerifier;
}

// EL HTTP DE LA PARTIDA, en tres responsabilidades y un solo router: UNA partida (`match.ts`), el
// historial de soporte (`history.ts`) y la API interna del orquestador (`tables.ts`). Los paths son
// absolutos, así que se monta en la raíz; las guardas van por ruta. Portado de truco (`0b0a467`).
//
// RECIBE sus dependencias en vez de resolverlas del container: resolver es una operación de
// COMPOSICIÓN y un transporte no es un composition root (Regla 3). Recibir el CONTAINER
// como parámetro no habría alcanzado —mueve el acoplamiento sin quitarlo: la función
// seguiría dependiendo de tsyringe, escondiendo qué necesita, y sin poder testearse sin
// armar un container—. Lo que un transporte no puede saber es que el container existe.
export function matchHttp(deps: MatchHttpDeps): Router {
  return Router().use(matchRoutes(deps)).use(historyRoutes(deps)).use(tablesRoutes(deps));
}
