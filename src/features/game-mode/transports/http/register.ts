import type { Logger } from "@/logger";
import { Router } from "express";
import type { GameModeService } from "../../service";
import { adminRoutes } from "./admin";
import { catalogRoutes } from "./catalog";

// LAS SIETE RUTAS DEL CATÁLOGO DE v1, con sus métodos, sus paths y su envelope
// (`Betaso-Domino-Backend/src/game-modes/routes.ts`). Este archivo hace DOS cosas y ninguna más:
// ruteo y traducción de errores a códigos HTTP. La forma de lo que entra y sale vive en
// `schemas.ts`; qué es un duplicado y qué se puede reactivar lo decide el servicio.
//
// LO QUE CAMBIA RESPECTO DE v1 ES QUIÉN AUTORIZA. Allá cada mutación llevaba
// `authMiddleware.isAuthenticated()` + `isAuthorized('admin')`, o sea que domino validaba al
// administrador. Acá el panel NO autentica administradores contra domino: el orquestador valida al
// admin y llama con `x-internal-api-key` (la llave del panel). Los dos GET siguen públicos porque el jugador necesita el
// catálogo para entrar a una mesa.

export interface GameModeHttpDeps {
  readonly service: GameModeService;
  readonly logger: Logger;
  /** `undefined` ⇒ las cinco mutaciones NO se registran. Ver el fail closed de abajo. */
  readonly adminPanelApiKey: string | undefined;
}

// EL HTTP DEL CATÁLOGO: las lecturas que ve el jugador (`catalog.ts`) y el CRUD que mueve el panel
// (`admin.ts`). Los paths son absolutos, así que se monta en la raíz. Portado de truco (`0b0a467`).
//
// ⚠ EL ADMIN SE MONTA PRIMERO, AL REVÉS QUE EN TRUCO, y no por gusto: `GET /game-modes/reactive/:uuid`
// es una mutación y tiene que registrarse ANTES que la lectura `GET /game-modes/:uuid`. Hoy Express
// no las confunde —son dos segmentos contra uno—, pero el orden es lo único que protege a la
// reactivación el día que aparezca un `GET /game-modes/:a/:b`. Lo pinea el test que lee el orden de
// las rutas del router montado.
export function gameModeHttp(deps: GameModeHttpDeps): Router {
  return Router().use(adminRoutes(deps)).use(catalogRoutes(deps));
}
