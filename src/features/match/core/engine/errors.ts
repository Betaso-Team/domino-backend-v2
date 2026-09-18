import type { RuleViolationCode } from "../rules/codes";
import type { Ruling } from "../rules/ruling";

// El catálogo de motivos se MUDÓ a `rules/codes` —es vocabulario de regla, no el mecanismo
// con el que el servidor lo cuenta— y se re-exporta acá, que es de donde lo importaba todo el
// mundo. Ver la cabecera de ese archivo.
export type { RuleViolationCode };

export abstract class DominoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

// El jugador intentó algo ilegal. Se traduce a un mensaje al cliente; NO cierra la partida
// y NO entra al historial (spec §5.1): va al log como rastro antifraude.
export class RuleViolationError extends DominoError {
  constructor(readonly code: RuleViolationCode) {
    super(`Regla violada: ${code}`);
  }
}

// EL PUENTE ENTRE EL VEREDICTO Y LA EXCEPCIÓN, y es el único lugar donde una regla se vuelve un
// throw. Las reglas dictaminan (`rules/ruling`); el motor necesita cortar la ejecución del
// comando, y eso solo lo hace una excepción.
//
// Vive acá y no en `rules/` a propósito: el día que las reglas viajen en un paquete, este
// archivo NO viaja — el cliente no aborta nada, pinta un botón apagado.
export function assertLegal(ruling: Ruling): void {
  if (!ruling.legal) throw new RuleViolationError(ruling.code);
}

// El estado dejó de ser confiable. Es un bug: la política de errores lo traduce a
// cerrar la partida (spec §10).
export class InvariantViolationError extends DominoError {}
