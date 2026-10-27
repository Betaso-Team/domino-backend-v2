import type { TokenVerifier } from "@/features/auth";
import type { Logger } from "@/logger";
import type { AdminTokenCheck } from "@/shared/http/api-key";
import { Router } from "express";
import type { Clock } from "../../core/engine/clock";
import type { HistoryReader, MatchArchive } from "../../network/history";
import type { PlayerLog } from "../../network/player-log";
import type { ColyseusMatchGateway } from "../colyseus/gateway";
import type { MatchRegistry } from "../match-registry";
import { historyRoutes } from "./history";
import { matchRoutes } from "./match";
import { meRoutes } from "./me";
import { playerRoutes } from "./players";
import { recordRoutes } from "./records";
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
  /** El documento de cada partida, para el panel y `/game-data`. Ver `recordRoutes`. */
  readonly archive: MatchArchive;
  /** Lo que jugó cada cuenta, para `GET /me/matches` y el panel. Ver `meRoutes` y `playerRoutes`. */
  readonly players: PlayerLog;
  /** `undefined` ⇒ las rutas internas NO se registran. Ver `historyRoutes` y `recordRoutes`. */
  readonly adminApiKey: string | undefined;
  /** Los operadores con sesión en el panel (token de billing-auth). Sin él, solo la llave abre. */
  readonly adminTokens?: AdminTokenCheck;
  readonly tables: Pick<ColyseusMatchGateway, "openRequest" | "seatBack">;
  /** `undefined` ⇒ la API del orquestador NO se registra. Ver `tablesRoutes`. */
  readonly orchestratorApiKey: string | undefined;
  readonly verifier?: TokenVerifier;
}

// EL HTTP DE LA PARTIDA, en seis responsabilidades y un solo router: UNA partida (`match.ts`), lo que
// jugó el dueño del token (`me.ts`) y lo que jugó cualquier cuenta, para el panel (`players.ts`), el historial de soporte (`history.ts`), el registro de cada partida para el panel y el backend
// principal (`records.ts`) y la API interna del orquestador (`tables.ts`). Los paths son absolutos,
// así que se monta en la raíz; las guardas van por ruta. Portado de truco (`0b0a467`).
//
// EL ORDEN ES PARTE DEL CONTRATO, y lo pinea `records.int.test.ts`: el historial antes que el
// detalle —`/internal/matches/:matchId/history` antes que `/internal/matches/:matchId`— aunque hoy
// Express no los confunda (un parámetro es un solo segmento), porque es lo único que protege al
// historial el día que el detalle gane un comodín; y el `GET /internal/matches` del panel separado
// del `POST` del orquestador, cada uno con su llave.
//
// RECIBE sus dependencias en vez de resolverlas del container: resolver es una operación de
// COMPOSICIÓN y un transporte no es un composition root (Regla 3). Recibir el CONTAINER
// como parámetro no habría alcanzado —mueve el acoplamiento sin quitarlo: la función
// seguiría dependiendo de tsyringe, escondiendo qué necesita, y sin poder testearse sin
// armar un container—. Lo que un transporte no puede saber es que el container existe.
export function matchHttp(deps: MatchHttpDeps): Router {
  return Router()
    .use(matchRoutes(deps))
    .use(meRoutes(deps))
    .use(historyRoutes(deps))
    .use(recordRoutes(deps))
    .use(playerRoutes(deps))
    .use(tablesRoutes(deps));
}
