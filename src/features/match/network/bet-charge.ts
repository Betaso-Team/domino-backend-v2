import type { PlayerId } from "../core/ids.js";

/**
 * EL COBRO DEL AUMENTO DE APUESTA, que todavía NO TIENE ADAPTADOR. Este archivo es el
 * contrato y el argumento de por qué falta; no hay implementación y no debería inventarse una
 * que "no cobre y siga": una mesa que aplica el aumento sin cobrarlo paga un premio mayor con
 * el dinero que nadie puso.
 *
 * QUÉ HACE V1, que es lo que hay que reproducir (`on-respond-bet-multiplier.ts`): al aceptar,
 * descuenta `additionalEntryFee` a LOS DOS jugadores, y si alguno de los dos cobros falla
 * devuelve el que sí salió y el aumento NO se aplica. Después sube `entryFee` y `prize` de la
 * mesa, y al cerrar la partida manda al ranking `multiplier + acceptedBetExtra`.
 *
 * POR QUÉ NO ESTÁ ENCHUFADO, y no es que se haya olvidado: cobrar es red, y los comandos del
 * motor son SÍNCRONOS POR CONTRATO. No hay forma de meter el cobro adentro de
 * `RespondBetMultiplierCommand` sin romper eso —y romperlo es lo que permite que dos mensajes
 * del mismo cliente se entrelacen a mitad de una mutación—. O sea que el cobro tiene que
 * colgarse del acuerdo YA ASENTADO, por afuera del motor.
 *
 * Y ahí aparece lo único que falta decidir, que es una decisión y no trabajo: **qué pasa si el
 * cobro falla después de que el motor ya asentó el trato.** V1 no tiene el problema porque
 * cobra ANTES de mutar. Las dos salidas razonables:
 *
 *   · COMPENSAR — un segundo verbo del motor que deshaga el aumento cuando el cobro no salió.
 *     El rival ve el aumento aceptado y después revertido, que es feo pero honesto.
 *   · RESERVAR — cobrar al PROPONER en vez de al aceptar, dejando el dinero retenido mientras
 *     se contesta, y liberarlo si el otro dice que no. Es lo que hace cualquier pasarela, y
 *     mueve el problema al lugar donde sí es síncrono.
 *
 * La segunda cambia el contrato de cara al jugador (se le retiene plata por una oferta que
 * puede no prosperar), así que es de producto, no de arquitectura.
 *
 * MIENTRAS TANTO NADA DE ESTO CORRE, y es seguro: `configOf` deja `betLevels` vacío, así que
 * ninguna mesa ofrece aumentar y `PROPOSE_BET_MULTIPLIER` siempre se rechaza con
 * `BETTING_DISABLED`. La negociación está entera y probada; lo que no está es el dinero.
 */
export interface BetChargeInstruction {
  readonly matchId: string;
  /** Los dos pagan lo mismo: es la entrada que sube, no una apuesta contra el otro. */
  readonly players: readonly PlayerId[];
  readonly additionalEntryFee: number;
  /** El nivel acordado, para la traza del ranking (`{ level, extra, baseMultiplier }` en v1). */
  readonly level: number;
  readonly extra: number;
}

export interface BetChargePort {
  /**
   * Cobra a los dos o no cobra a ninguno. La atomicidad es del adaptador —v1 la consigue
   * devolviendo lo cobrado cuando el segundo falla— y no de quien llama: el llamador no tiene
   * cómo saber cuál de los dos quedó a medias.
   */
  charge(instruction: BetChargeInstruction): Promise<void>;
}
