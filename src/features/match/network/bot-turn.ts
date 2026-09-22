import type { DominoMatchConfig } from "../core/config";
import type { PlayerId } from "../core/ids";
import { type BotMove, botMoveOf } from "../core/rules/bot";
import type { MatchState } from "../core/state";
import { SchemaMatchView } from "../core/state/view";

/**
 * EL RELOJ DE LA MÁQUINA: lo único que separa «hay un bot sentado» de «el bot juega».
 *
 * **ES DE LA RED Y NO DEL MOTOR**, por lo mismo que el cobro del aumento: los comandos son
 * SÍNCRONOS por contrato —es lo que impide que dos mensajes del mismo cliente se entrelacen a
 * mitad de una mutación— y esto necesita ESPERAR. La espera es deliberada y viene de v1
 * (`playBotTile`, 1500 ms): sin ella el bot juega en el mismo tick en que le llega el turno, la
 * mesa se mueve sola y el que está mirando no ve qué pasó.
 *
 * **SE LO EMPUJA, NO SE SUSCRIBE.** El turno cambia sin emitir ningún evento —jugar no es un
 * evento, el comando ya es el registro— así que no hay a qué suscribirse: es la sala la que
 * después de cada mutación pregunta si la mesa quedó esperando a una máquina. Es el encadenado
 * de v1 (`on-play-tile.ts:110-112`) puesto en un solo lugar en vez de repetido en cada comando.
 */
export class BotTurnTaker {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly match: MatchState,
    private readonly config: DominoMatchConfig,
    /**
     * EJECUTA LA JUGADA, y no es `command.execute` a secas: tiene que grabarla en el historial
     * como acto del SISTEMA y notificar los eventos, igual que el camino del cliente. Un bot que
     * mutara sin grabar deja el historial mintiendo justo en las partidas que alguien va a
     * auditar — que son éstas, las que alguien abandonó.
     */
    private readonly play: (playerId: PlayerId, move: BotMove) => void,
    private readonly delayMs: number,
    private readonly onError: (error: unknown) => void,
  ) {}

  /**
   * ¿LA MESA QUEDÓ ESPERANDO A UNA MÁQUINA? Si sí, le programa la jugada.
   *
   * Idempotente: con una jugada ya programada no encola otra. Sin esa guarda, dos mensajes que
   * lleguen mientras el bot espera dejan dos temporizadores, y el segundo juega sobre un tablero
   * que el primero ya movió — o sea una jugada ilegal, que el comando rechaza y que deja al
   * asiento sin haber jugado.
   */
  poke(): void {
    if (this.timer) return;
    const playerId = this.waitingBot();
    if (!playerId) return;
    this.timer = setTimeout(() => this.take(playerId), this.delayMs);
  }

  /** La sala se va. Un temporizador vivo acá mantendría el proceso despierto y jugaría solo. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private waitingBot(): PlayerId | undefined {
    const turn = this.match.currentRound?.currentTurn?.playerId;
    if (!turn) return undefined;
    const player = this.match.players.find((candidate) => candidate.playerId === turn);
    return player?.isBot ? turn : undefined;
  }

  private take(playerId: PlayerId): void {
    this.timer = undefined;
    // SE VUELVE A PREGUNTAR, no se confía en lo que se decidió al programar: entre el `poke` y
    // este tick pasaron 1500 ms en los que la ronda pudo cerrarse, el turno pudo pasar a otro o
    // la partida pudo terminar. Jugar la jugada que era buena hace un segundo y medio es
    // exactamente el bug que la guarda de reentrada evita del otro lado.
    if (this.waitingBot() !== playerId) return;
    const move = botMoveOf(playerId, new SchemaMatchView(this.match), this.config);
    if (!move) return;

    try {
      this.play(playerId, move);
    } catch (error) {
      // ⚠ NO SE REINTENTA, y es la decisión: una jugada rechazada significa que la política y la
      // legalidad no coinciden, y volver a intentarla da el mismo rechazo en un bucle que no
      // termina. Se deja correr el reloj del turno, que retira el asiento — que es exactamente
      // lo que pasaría sin bots. Peor final, pero final.
      this.onError(error);
      return;
    }
    // Y SE VUELVE A MIRAR: el siguiente turno puede ser de la otra máquina. Encadena por el
    // temporizador y no por recursión, así que dos bots seguidos no llenan la pila.
    this.poke();
  }
}
