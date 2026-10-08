/**
 * UN BOOLEANO QUE EL MOTOR LEE Y LA RED ESCRIBE: ¿estos dos pueden jugar otra?
 *
 * Existe porque la respuesta no es del juego y NO ES SÍNCRONA — depende del saldo de cada uno,
 * del antifraude y del tope de la cadena, o sea de varias idas y vueltas de red — mientras que
 * el conductor tiene que decidir en el instante en que vence la pausa de presentación. Así que
 * la respuesta se deja acá durante esa pausa, y sin respuesta NO HAY VENTANA.
 *
 * CERRADO ES EL LADO SEGURO EN EL QUE EQUIVOCARSE, y por eso arranca en `false`: una ventana que
 * no se abre cuesta una pantalla; una que se abre sin saldo abre una mesa que uno de los dos no
 * puede pagar. Es el mismo criterio con el que `RematchEligibility` falla hacia el no.
 *
 * NO VUELVE AL MOTOR CONSCIENTE DEL DINERO: no juzga, no gana una precondición y ninguna regla
 * del dominó lo consulta. Las reglas ni siquiera pueden verlo — `eligible` no está en
 * `RematchView` (ver `rules/rematch.ts`).
 *
 * La otra mitad de la conversación NO vive acá: CERRAR una ventana ya abierta mueve una fase, o
 * sea que es una transición, y las transiciones son del conductor.
 */
export class RematchGate {
  private allowed = false;
  private closed = false;

  /**
   * @param offered si ESTA MESA ofrece revancha, que es un hecho distinto de si estos dos
   * pueden pagarla y por eso es un parámetro y no otro `allow()`. Hoy lo decide el modo: una
   * mesa casual sí, una de torneo NO —se vuelve a jugar cuando el torneo lo diga, no cuando los
   * jugadores se pongan de acuerdo—.
   *
   * Colapsar los dos hechos en uno dejaría al torneo mostrando un botón de revancha apagado,
   * que le dice al jugador que le falta saldo cuando lo que pasa es que la revancha no existe
   * ahí. La ventana ni siquiera se abre.
   */
  constructor(private readonly offered: boolean) {}

  /** Si la mesa ofrece revancha. Sin esto, no hay ventana. */
  offersRematch(): boolean {
    return this.offered;
  }

  /** Solo tiene efecto antes de que venza la pausa de presentación, y nunca después de `close()`. */
  allow(): void {
    if (!this.closed) this.allowed = true;
  }

  /** Idempotente y llamable en cualquier momento: una ventana ya abierta la cierra el conductor. */
  deny(): void {
    this.allowed = false;
  }

  /**
   * NO HAY REVANCHA EN ESTA MESA, y es DEFINITIVO (truco `0960663`): alguien se fue después del
   * veredicto. Distinto de `deny()`, que deja abrir la ventana con el botón apagado: acá no hay con
   * quién volver a jugar, así que la ventana no se abre. Las dos respuestas compiten —el permiso
   * puede seguir en vuelo cuando el rival ya se fue— y todo motivo para cerrar es final, mientras
   * que permitir es solo la falta de uno.
   */
  close(): void {
    this.closed = true;
    this.allowed = false;
  }

  /** Si alguien la cerró. Sin ventana, no se abre ni apagada. */
  isClosed(): boolean {
    return this.closed;
  }

  /** Si además de ofrecerse, estos dos pueden jugarla. Es lo que el front recibe en `eligible`. */
  isAllowed(): boolean {
    return this.offered && this.allowed;
  }
}
