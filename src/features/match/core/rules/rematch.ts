import type { PlayerId } from "./ids";
import { LEGAL, type Ruling, illegal } from "./ruling";
import type { PublicMatchView } from "./view";

// LAS REGLAS DE LA REVANCHA, y lo primero que hay que saber de ellas es lo que NO preguntan.
//
// Nada de acá mira un saldo, un antifraude ni cuántas revanchas lleva la cadena. Eso se decide
// ANTES de que la ventana exista y se publica en `rematch.eligible`, que ni siquiera está en
// `RematchView` — así que una regla que quisiera consultarlo **no compila**. Es lo que las deja
// viajar en el paquete que algún día corra el cliente: son reglas de MESA.
//
// Y son las únicas que corren con la partida YA dictaminada, que es por qué ninguna se apoya en
// `matchInProgress`: la revancha vive entre el veredicto y el terminal.

/**
 * PEDIR LA REVANCHA.
 *
 * ⚠ EL ORDEN DE LAS DOS PRIMERAS GUARDAS ES LA REGLA, no estilo. Con una solicitud sobre la mesa
 * la fase YA es `REMATCH_NEGOTIATION`, así que preguntar primero por la fase le contestaría al
 * que perdió la carrera —los dos apretaron a la vez— que la ventana está cerrada. Es falso, y no
 * le dice qué hacer. Preguntando primero por la solicitud se entera de que ya hay una, que es lo
 * único accionable.
 *
 * ⚠ Y NO SE RECHAZA AL NO-SOLICITANTE QUE PIDE DURANTE LA NEGOCIACIÓN: eso lo trata el conductor
 * como una ACEPTACIÓN. Acá se sigue a v1 y no a truco, que lo declara ilegal con el argumento de
 * que un verbo no puede significar dos cosas según cuándo llegue. El argumento es bueno y la
 * consecuencia es peor: con dos jugadores apretando «Revancha» en el mismo segundo —que es lo
 * que pasa cuando los dos la quieren— uno recibe un error y la revancha que ambos querían muere.
 * El doble sentido se paga a propósito, y por eso está escrito acá y en el conductor en vez de
 * emerger de un `if`.
 */
export function canRequestRematch(playerId: PlayerId, match: PublicMatchView): Ruling {
  if (match.rematch) return illegal("REMATCH_ALREADY_REQUESTED");
  if (match.phase !== "REMATCH_WINDOW") return illegal("REMATCH_WINDOW_CLOSED");
  const player = match.players.find((candidate) => candidate.playerId === playerId);
  if (!player || player.hasAbandoned) return illegal("PLAYER_NOT_IN_MATCH");
  // Una revancha contra nadie no es una partida.
  if (rematchRespondersOf(playerId, match).length === 0) return illegal("NO_REMATCH_OPPONENT");
  return LEGAL;
}

/**
 * RESPONDER LA SOLICITUD, que acepte o que decline: las dos respuestas son legales en el mismo
 * momento y por parte de los mismos, así que es UNA regla y no dos. Lo que hace cada respuesta
 * es del conductor.
 */
export function canRespondRematch(playerId: PlayerId, match: PublicMatchView): Ruling {
  const rematch = match.rematch;
  if (!rematch || match.phase !== "REMATCH_NEGOTIATION") return illegal("NO_REMATCH_PENDING");
  // EL QUE PIDE NO SE CONTESTA A SÍ MISMO, y en una mesa de dos es la única forma que habría de
  // abrir una revancha sin que el rival diga nada.
  if (playerId === rematch.requesterId) return illegal("NOT_YOUR_REMATCH");
  const player = match.players.find((candidate) => candidate.playerId === playerId);
  if (!player || player.hasAbandoned) return illegal("PLAYER_NOT_IN_MATCH");
  // Responder dos veces no es cambiar de opinión: el que ya aceptó no puede declinar después,
  // porque entre una cosa y la otra la sala nueva puede estar abriéndose.
  if (rematch.acceptedIds.some((id) => id === playerId)) {
    return illegal("REMATCH_ALREADY_ANSWERED");
  }
  return LEGAL;
}

/**
 * ¿LA MESA SIGUE ENTERA? Es la condición para que la ventana ni siquiera se abra, y es de v1
 * (`computeEligibility`: `players.length !== playersQuantity` ⇒ no elegible).
 *
 * SE VUELVE A JUGAR LA MESA, no lo que quedó de ella: con un asiento retirado no hay revancha
 * posible ni con los tres que siguen, porque la mesa nueva necesita los cuatro. En 2P es más
 * evidente todavía — el que ganó por abandono no tiene contra quién.
 *
 * Es la diferencia entre no abrir la ventana y abrirla apagada: acá NO HAY NADA que el jugador
 * pueda arreglar, así que un botón gris durante treinta segundos solo le hace esperar. `eligible`
 * es para lo que sí depende de él, que es tener saldo.
 */
export function isTableIntact(match: PublicMatchView): boolean {
  return match.players.every((player) => !player.hasAbandoned);
}

/**
 * QUIÉNES TIENEN QUE ACEPTAR: todos los de la mesa que no pidieron y no se retiraron.
 *
 * Es UNA regla para las dos mesas —en 2P devuelve al rival, en 4P a los otros tres, del equipo
 * que sea— y eso es lo que deja el 4P resuelto sin que nadie lo haya abierto. La revancha no es
 * cosa de equipos: se vuelve a jugar LA MESA, así que la acuerdan los cuatro.
 *
 * Los retirados no entran, y no es un detalle: contarlos dejaría toda revancha esperando una
 * respuesta que no puede llegar, hasta que venza el plazo.
 */
export function rematchRespondersOf(
  playerId: PlayerId,
  match: PublicMatchView,
): readonly PlayerId[] {
  return match.players
    .filter((player) => player.playerId !== playerId && !player.hasAbandoned)
    .map((player) => player.playerId);
}
