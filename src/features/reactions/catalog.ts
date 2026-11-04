// LOS GESTOS que un jugador le manda a la mesa: una lista cerrada de emojis. No son del dominó —no
// tienen reglas, no puntúan, no entran en el estado de la partida— y por eso viven en su propia
// feature y no dentro de `match`. Portado de truco (`f8713f3`).
//
// **El catálogo es lo que hace que esto no sea un chat.** El cliente manda un ID, no un texto: si
// mandara el contenido habría conversación libre entre desconocidos, con la moderación que eso abre.
// Que la lista sea cerrada y del servidor es la decisión de fondo, no un detalle de forma.

// `emoji`, hoy. El cliente decide cómo pintarlo; el tipo viaja para que un gesto de otra clase
// mañana no se pinte como si fuera un emoji.
export type ReactionType = "emoji";

export interface Reaction {
  // El id que el cliente manda: un slug ASCII estable, que no cambia aunque cambie el dibujo.
  readonly id: string;
  readonly type: ReactionType;
  readonly content: string;
}

// La lista se sirve en paquetes, la forma que el front de truco ya lee. Hoy hay uno solo, `global`.
export interface ReactionPack {
  readonly pack: string;
  readonly items: readonly Reaction[];
}

// QUÉ GESTOS EXISTEN. Es un puerto aunque hoy la lista viva en el código —a diferencia de truco, que
// la pide al backend de Betaso—: el dominó sirve a varios proveedores y ninguno es dependencia suya,
// así que la lista es nuestra. El puerto queda igual al de truco para que quien la consume no sepa de
// dónde sale.
//
// `find` pregunta por UNO: el relay sólo quiere validar el que llegó. `packs` es la lista entera,
// para `GET /reactions`.
export interface ReactionCatalog {
  find(reactionId: string): Promise<Reaction | undefined>;
  packs(): Promise<readonly ReactionPack[]>;
}

export interface ReactionsConfig {
  // Cuántos gestos en la ventana. Tres permite reaccionar seguido a una jugada sin dejar pasar el
  // bombardeo.
  readonly perWindow: number;
  readonly windowMs: number;
}

const SECONDS = 1_000;

export const DEFAULT_REACTIONS_CONFIG: ReactionsConfig = {
  perWindow: 3,
  windowMs: 2 * SECONDS,
};
