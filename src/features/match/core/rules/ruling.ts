// EL VEREDICTO DE UNA REGLA: legal, o ilegal con su motivo.
//
// Las reglas **dictaminan, no lanzan**. Una excepción es una forma de contar el resultado que
// solo le sirve a un servidor: "lanza" no se puede pintar. Del lado del cliente lo que hace
// falta es poder preguntar ANTES de intentar —para apagar el botón— y poder decir POR QUÉ está
// apagado, y para eso el motivo tiene que ser dato.
//
// Del lado del motor no se pierde nada: los `assertX` del juez siguen existiendo como
// envoltorio, leen este veredicto y lanzan `RuleViolationError`. Lo que cambia es dónde vive la
// DECISIÓN y dónde el MECANISMO de reporte.
//
// Y de paso caen dos cosas que antes no se podían escribir: saber qué puede hacer un jugador
// deja de ser un barrido de `try/catch` sobre los siete verbos (`actions.ts`), y probar una
// legalidad deja de necesitar `expect(() => …).toThrow`.
//
// NO HAY UN `firstIllegal(...rulings)` que las componga, y la ausencia es deliberada: sus
// argumentos se evaluarían TODOS antes de elegir el primero, y las guardas de acá están
// ordenadas justamente porque las de atrás asumen lo que las de adelante ya comprobó —"no hay
// ronda en curso" tiene que contestarse antes de mirar el turno de esa ronda—. La composición
// es un `if` con `return` temprano, que es perezosa por construcción.
import type { RuleViolationCode } from "./codes.js";

export type Ruling =
  | { readonly legal: true }
  | { readonly legal: false; readonly code: RuleViolationCode };

// Se exportan las dos construcciones —y no se escribe el objeto a mano en cada regla— porque
// `{ legal: true }` repetido es ruido que tapa la regla que sí importa.
export const LEGAL: Ruling = { legal: true };

export const illegal = (code: RuleViolationCode): Ruling => ({ legal: false, code });

export const isIllegal = (ruling: Ruling): ruling is { legal: false; code: RuleViolationCode } =>
  !ruling.legal;
