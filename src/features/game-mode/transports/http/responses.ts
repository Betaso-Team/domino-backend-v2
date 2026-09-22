import type { Response } from "express";
import {
  DuplicateGameModeError,
  GameModeNotFoundError,
  GameModeStateConflictError,
  GameModeWriteBusyError,
} from "../../core/catalog";

// LO QUE COMPARTEN LAS DOS MITADES DEL CATÁLOGO —las lecturas del jugador y las mutaciones del panel—:
// la raíz de los paths, los mensajes literales de v1 y el envelope histórico.
export const BASE = "/game-modes";

// LOS MENSAJES LITERALES DE v1, y son parte del contrato: el panel los muestra. El del 404 sale en
// las cuatro rutas que v1 lo tenía (`routes.ts:41-44`, `:71-74`, `:121-124`, `:162-165`).
export const NOT_FOUND_MESSAGE = "Modo de juego no encontrado";
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

// LA TRADUCCIÓN DE LOS CUATRO ERRORES DE APLICACIÓN, Y EL `throw` DEL FINAL ES LA MITAD DEL ARCHIVO.
// Lo que no reconoce se RELANZA: `validated` lo reenvía a `next` y el manejador compartido lo loguea
// con stack y contesta 500. v1 hacía lo contrario —un `catch (error)` por ruta que convertía
// cualquier cosa en 500 con un mensaje genérico—, y ahí se le perdían los dos casos que esta tarea
// recupera: el «ya está inactivo» (que ahora es 409) y el cuerpo inválido (que ahora es 400).
//
// Traducir lo desconocido a 404 sería peor todavía: le diría al panel que el modo no existe cuando
// lo que pasa es que la base no contesta, y manda al operador a auditar el modo equivocado.
export function sendError(response: Response, error: unknown): void {
  if (error instanceof GameModeNotFoundError) {
    // EL MENSAJE LITERAL DE v1 Y NO EL DEL ERROR: es el que el panel muestra, y el del servicio
    // ("no existe el modo <uuid>") está escrito para el log del operador.
    response.status(404).json({ status: "error", message: NOT_FOUND_MESSAGE });
    return;
  }
  // 409 LOS DOS, y con nombres distintos a propósito: el duplicado es la regla de unicidad y el
  // conflicto de estado es «ya está inactivo»/«ya está activo». Comparten código porque los dos son
  // un choque con el estado actual, no con la forma del pedido.
  if (error instanceof DuplicateGameModeError || error instanceof GameModeStateConflictError) {
    response.status(409).json({ status: "error", message: error.message });
    return;
  }
  // 503 Y NO 500: el lease lo tiene otro proceso. Nadie hizo nada mal y reintentar es la respuesta
  // correcta, que es justo lo que un 500 no dice.
  if (error instanceof GameModeWriteBusyError) {
    response.status(503).json({ status: "error", message: error.message });
    return;
  }
  throw error;
}
