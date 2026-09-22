import type { WalletPort } from "@/features/economy";
import type { Logger } from "@/shared/logger";
import type {
  CasualRoomOptions,
  DominoRoomOptions,
  MatchOpener,
  Seat,
} from "../transports/match-contract";
import type { NetworkMatchEvent } from "./events";
import type { MatchEventSink } from "./listeners";

// LA MITAD DE LA REVANCHA QUE HABLA CON EL MUNDO: si estos dos pueden jugar otra, y abrir la
// mesa donde la juegan. El motor corre la negociación y no sabe que este archivo existe.
//
// Son las dos preguntas que el juego NO PUEDE contestarse —una necesita el saldo de cada uno y
// el antifraude, la otra necesita crear una sala— y por eso viven acá y llegan al motor por dos
// caminos angostos: un booleano que se deja en la compuerta, y un evento al que este sink
// reacciona.

/**
 * LA MITAD DE LA ELEGIBILIDAD QUE NO ES PLATA. La arma el composition root, que es el único
 * lugar que conoce a la vez esta feature y dónde vive el libro de vetos.
 *
 * Falla HACIA EL NO: un chequeo que revienta contesta que no.
 */
export type RematchAntifraud = (playerIds: readonly string[]) => Promise<boolean>;

/**
 * LO QUE EL MOTOR EXPONE DE SU COMPUERTA, y nada más. Es la `RematchDoor` de truco: dos verbos
 * opacos en vez del `RematchGate` entero, para que este archivo no pueda leer si la ventana
 * está abierta ni decidir nada con eso.
 */
export interface RematchDoor {
  allow(): void;
  deny(): void;
}

export interface RematchCoordinatorDeps {
  readonly wallet: Pick<WalletPort, "canAfford">;
  readonly antifraud: RematchAntifraud;
  readonly opener: MatchOpener;
  /** El `seed` de la mesa nueva. Es de afuera por lo mismo que el de la primera: reproducible. */
  readonly seedOf: () => string;
  /**
   * CUÁNTAS REVANCHAS ADMITE UNA CADENA antes de cortarla (v1: una). Es anti-abuso: sin tope, dos
   * cómplices se pasan la partida entre ellos sin volver nunca por el emparejador, que es quien los
   * separaría. Una FUNCIÓN porque es editable en caliente (`maxRematchesPerChain` de la config del
   * emparejamiento, que es de la misma familia que el cooldown y el veto) y se lee al usar.
   *
   * OBLIGATORIA y sin default a propósito: durante dos incrementos ese campo de la config existió y
   * no lo leía nadie, porque la revancha tenía su propia constante. Un default acá volvería a dejar
   * verde un cableado olvidado.
   */
  readonly maxRematchesPerChain: () => number;
  readonly log: Logger;
}

export class RematchCoordinator {
  constructor(private readonly deps: RematchCoordinatorDeps) {}

  /**
   * EL SINK que la sala engancha. Reacciona a dos eventos y a ninguno más:
   *
   *   · `MATCH_RESOLVED` → contesta la compuerta mientras corre la pausa de presentación.
   *   · `REMATCH_ACCEPTED` → abre la mesa nueva y le da a cada uno su reserva.
   *
   * LAS DOS SON ASÍNCRONAS Y EL SINK NO LO ES, y ésa es la forma entera de este archivo: el
   * motor es SÍNCRONO por contrato, así que lo único que puede hacer un sink es disparar el
   * trabajo y dejar la respuesta donde el motor la va a buscar después. Para la compuerta, ese
   * «después» es el vencimiento de la pausa; para la apertura, ya no hay motor esperando.
   */
  sinkFor(
    options: DominoRoomOptions,
    matchId: string,
    door: RematchDoor,
    send: (playerId: string, type: string, payload: unknown) => void,
    close: () => void,
  ): MatchEventSink {
    // El torneo no ofrece revancha, así que no hay nada que coordinar.
    if (options.mode !== "CASUAL") return () => {};
    return (events: readonly NetworkMatchEvent[]) => {
      for (const event of events) {
        if (event.type === "MATCH_RESOLVED") this.answerDoor(options, matchId, door);
        if (event.type === "REMATCH_ACCEPTED") {
          this.openNext(options, event.playerIds, send, close);
        }
      }
    };
  }

  /**
   * CONTESTA LA COMPUERTA, y corre DENTRO de la pausa de presentación: el veredicto sale al
   * ENTRAR a esa pausa, así que hay cuatro segundos entre esto y el instante en que el conductor
   * tiene que decidir. Una ida y vuelta entra cómoda, y si no entra el default es NO — la
   * ventana se abre con el botón apagado, que es el lado seguro.
   */
  private answerDoor(options: CasualRoomOptions, matchId: string, door: RematchDoor): void {
    void this.isEligible(options, matchId)
      .then((eligible) => (eligible ? door.allow() : door.deny()))
      // Sin esto una falla acá sería una promesa rechazada sin dueño, y eso termina el proceso
      // con todas las demás partidas adentro.
      .catch((err: unknown) => this.deps.log.error("no se pudo resolver la elegibilidad", { err }));
  }

  /**
   * ¿PUEDEN JUGAR OTRA? Tres preguntas, y las tres fallan hacia el NO.
   *
   * EL MONTO ES EL DE LA MESA y no el de la partida que terminó: una revancha se juega al precio
   * base aunque la última haya ido con aumento aceptado.
   *
   * SE PREGUNTA POR `matchId` Y NO CON EL TOKEN de cada uno: la cuenta de cada jugador quedó
   * congelada al admitirlo, así que preguntar así es lo que compara el saldo contra la MISMA
   * moneda en la que vienen jugando. Es lo que `WalletPort.canAfford` documenta para todo lo
   * que pasa después de la puerta.
   */
  async isEligible(options: CasualRoomOptions, matchId: string): Promise<boolean> {
    try {
      // EL TOPE DE LA CADENA ES LO PRIMERO porque es lo único que no cuesta red. La partida
      // original llega con 0 y es elegible; la revancha llega con 1 y ya no lo es.
      if ((options.rematchCount ?? 0) >= this.deps.maxRematchesPerChain()) return false;
      if (!(await this.deps.antifraud(options.seats))) return false;
      if (options.entryFee <= 0) return true;
      const answers = await Promise.all(
        options.seats.map((playerId) =>
          this.deps.wallet.canAfford({ playerId, amount: options.entryFee, matchId }),
        ),
      );
      return answers.every(Boolean);
    } catch (err: unknown) {
      this.deps.log.error("no se pudo verificar la elegibilidad de la revancha", { err, matchId });
      return false;
    }
  }

  /**
   * ABRE LA MESA NUEVA y le da a cada uno su asiento.
   *
   * ⚠ LA RESERVA VIAJA POR CLIENTE Y NUNCA POR BROADCAST, y no es prolijidad: una reserva de
   * asiento es un secreto de su dueño, y el que tenga la ajena puede consumirla y sentarse en
   * su lugar — dejándolo afuera de una partida que ya pagó.
   *
   * NO SE RE-CHEQUEA EL SALDO ACÁ, y es donde este repo se aparta de truco y de v1. Allá se
   * vuelve a preguntar porque la foto puede tener treinta y cinco segundos; acá la ventana
   * entera dura eso y el cobro de la mesa nueva ocurre en SU puerta, con su propio `matchId`:
   * si uno gastó el saldo en el medio, es la admisión la que lo rechaza — y rechaza sólo a él,
   * en vez de matar la revancha de los dos con una foto de hace un rato.
   *
   * Si la apertura falla NO HAY NADA QUE DESHACER: la partida vieja ya terminó y no se movió un
   * centavo, porque la inscripción de la nueva se cobra en su propia puerta.
   */
  private openNext(
    options: CasualRoomOptions,
    playerIds: readonly string[],
    send: (playerId: string, type: string, payload: unknown) => void,
    close: () => void,
  ): void {
    void this.deps.opener
      .open(this.nextOptions(options, playerIds))
      .then((seats: readonly Seat[]) => {
        for (const seat of seats) send(seat.playerId, "REMATCH_SEAT", seat.reservation);
      })
      .catch((err: unknown) => {
        this.deps.log.error("no se pudo abrir la sala de la revancha", { err });
        // Se cierra para que el que aceptó no se quede mirando el traspaso hasta que venza:
        // la mesa se apaga ahora y el jugador vuelve al lobby.
        close();
      });
  }

  // LA MESA NUEVA ES LA MISMA MESA con otra semilla y un eslabón más de cadena. El `gameModeId`,
  // la economía y los asientos se conservan: la revancha se juega al precio y en el modo de la
  // que terminó, que es lo que el jugador aceptó al apretar el botón.
  private nextOptions(options: CasualRoomOptions, playerIds: readonly string[]): CasualRoomOptions {
    return {
      ...options,
      seats: [...playerIds],
      seed: this.deps.seedOf(),
      rematchCount: (options.rematchCount ?? 0) + 1,
      // LA CADENA LA BAUTIZA LA PRIMERA MESA. Sin esto, cada revancha empezaría una cadena
      // nueva y el tope de una no limitaría nada.
      rematchChainId: options.rematchChainId ?? options.seed,
    };
  }
}
