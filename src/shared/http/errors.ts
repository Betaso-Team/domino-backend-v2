import type { Response } from "express";

/**
 * EL CUERPO DE TODO ERROR HTTP DEL DOMINÓ: `{ code, detail? }`. `code` es una constante en
 * MAYÚSCULAS que el cliente compara (`MODE_NOT_FOUND`, `UNAUTHORIZED`…) y `detail`, cuando viaja, es
 * texto para una persona: el cliente no lo parsea. Es el mismo vocabulario que el socket
 * (`{ code: "MALFORMED", detail }` en `domino-room.ts`), así que el cliente aprende un solo juego de
 * códigos y no uno por transporte.
 *
 * Las respuestas de éxito no cambian (`{ status: "success", data }` del catálogo y del panel), y
 * `/health` y `/ready` siguen siendo sondas del balanceador con su propia forma.
 */
export interface ErrorBody {
  readonly code: string;
  readonly detail?: string;
}

/**
 * Contesta un error con la forma de arriba. Toda ruta que contesta un 4xx o un 5xx pasa por acá, para
 * que ninguna escriba el cuerpo a mano y se vuelva a tener tres formas (`{ error }`,
 * `{ status: "error", message }`, `{ code }`) según quién escribió la ruta.
 */
export function sendError(response: Response, status: number, code: string, detail?: string): void {
  const body: ErrorBody = detail === undefined ? { code } : { code, detail };
  response.status(status).json(body);
}
