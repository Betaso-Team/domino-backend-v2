import { sendError } from "@/shared/http/errors";
import type { Response } from "express";
import {
  DuplicateGameModeError,
  FreeRoomWithEntryError,
  GameModeForbiddenError,
  GameModeNotFoundError,
  GameModeStateConflictError,
  GameModeWriteBusyError,
  UnknownProviderError,
} from "../../core/catalog";

// LO QUE COMPARTEN LAS DOS MITADES DEL CATÁLOGO —las lecturas del jugador y las mutaciones del panel—:
// la raíz de los paths, los mensajes literales de v1 y el envelope histórico de las respuestas de
// éxito. Los ERRORES no usan ese envelope: salen `{ code, detail? }` como el resto del dominó
// (`@/shared/http/errors`).
export const BASE = "/game-modes";

// LOS MENSAJES LITERALES DE v1 de las respuestas de éxito, y son parte del contrato: el panel los
// muestra.
export const DELETED_MESSAGE = "Modo de juego eliminado correctamente";
export const REACTIVATED_MESSAGE = "Modo de juego reactivado correctamente";

// EL ENVELOPE HISTÓRICO, en dos funciones para que ninguna ruta lo escriba a mano: v1 contesta
// `{ status, data }` cuando devuelve un modo y `{ status, message }` cuando devuelve un resultado, y
// mezclarlos es lo que rompe al panel sin que nada falle de este lado.
export function sendData(response: Response, status: number, data: unknown): void {
  response.status(status).json({ status: "success", data });
}

export function sendMessage(response: Response, message: string): void {
  response.json({ status: "success", message });
}

// EL 404 DE UN MODO, para las rutas que lo deciden ellas (una lectura que no encontró nada) y no un
// error del servicio. Sin `detail`: el código lo dice todo, y es el mismo que sale de
// `sendCatalogError` cuando el servicio no encuentra el modo.
export function sendModeNotFound(response: Response): void {
  sendError(response, 404, "MODE_NOT_FOUND");
}

// LA TRADUCCIÓN DE LOS SIETE ERRORES DE APLICACIÓN, Y EL `throw` DEL FINAL ES LA MITAD DEL ARCHIVO.
// Lo que no reconoce se RELANZA: `validated` lo reenvía a `next` y el manejador compartido lo loguea
// con stack y contesta 500. v1 hacía lo contrario —un `catch (error)` por ruta que convertía
// cualquier cosa en 500 con un mensaje genérico—, y ahí se le perdían los dos casos que esta tarea
// recupera: el «ya está inactivo» (que ahora es 409) y el cuerpo inválido (que ahora es 400).
//
// Traducir lo desconocido a 404 sería peor todavía: le diría al panel que el modo no existe cuando
// lo que pasa es que la base no contesta, y manda al operador a auditar el modo equivocado.
//
// EL CÓDIGO LO TRAE EL ERROR (`error.code`, ver `core/catalog.ts`) y acá sólo se elige el status;
// el mensaje del servicio viaja como `detail`, para una persona.
export function sendCatalogError(response: Response, error: unknown): void {
  if (error instanceof GameModeNotFoundError) {
    // SIN `detail`: el mensaje del servicio ("no existe el modo <uuid>") es para el log, y el 404 es
    // el mismo que el de un modo de otro proveedor, que no tiene que poder distinguirse.
    sendModeNotFound(response);
    return;
  }
  // 409 LOS DOS, y con nombres distintos a propósito: el duplicado es la regla de unicidad y el
  // conflicto de estado es «ya está inactivo»/«ya está activo» y compañía, cada uno con su código.
  // Comparten status porque los dos son un choque con el estado actual, no con la forma del pedido.
  if (error instanceof DuplicateGameModeError || error instanceof GameModeStateConflictError) {
    sendError(response, 409, error.code, error.message);
    return;
  }
  // 404 SIN `detail`, como el `?providerId=` ajeno: otro proveedor no existe para éste (crear un modo
  // para él, o cualquier operación sobre él). Confirmar que existe sería decir un 403.
  if (error instanceof UnknownProviderError) {
    sendError(response, 404, error.code);
    return;
  }
  // 403: un proveedor pidiendo algo de un modo que ve pero no es suyo. Lo que no ve sale como el 404
  // de arriba, nunca por acá (ver `service.ts`).
  if (error instanceof GameModeForbiddenError) {
    sendError(response, 403, error.code, error.message);
    return;
  }
  if (error instanceof FreeRoomWithEntryError) {
    sendError(response, 400, error.code, error.message);
    return;
  }
  // 503 Y NO 500: el lease lo tiene otro proceso. Nadie hizo nada mal y reintentar es la respuesta
  // correcta, que es justo lo que un 500 no dice.
  if (error instanceof GameModeWriteBusyError) {
    sendError(response, 503, error.code, error.message);
    return;
  }
  throw error;
}
