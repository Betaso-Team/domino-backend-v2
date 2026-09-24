import type { MoveType } from "../rules/actions";
import type { PlayerId } from "../rules/ids";
import { PastMove } from "../state";
import type { MatchState } from "../state";

// EL REGISTRO DE JUGADAS DE LA MANO: apunta quién puso, quién cargó y quién pasó, en orden, en
// `RoundState.pastMoves` (§`PastMove`). Es el único actor del motor que no decide ni conduce nada
// —solo escribe—, y por eso no tiene juez ni conductor asociado: nada de lo que apunta se vuelve a
// leer del lado del servidor.
//
// LO LLAMAN TRES COMANDOS Y NADIE MÁS, y la ausencia de una boca del RELOJ es una afirmación y no
// un olvido: el reloj nunca juega por nadie —cuando el turno vence RETIRA al que se calló, ver
// `MatchDriver.timeout`—, así que no existe una jugada que un jugador no haya hecho. Es la
// diferencia con el historial de soporte, que sí tiene dos bocas, y con truco, donde el conductor
// canta por el que se quedó callado. El día que el dominó tenga bots o jugada automática, esta
// clase es donde aparece el segundo llamador, y `PastMove` el nodo que gana el campo que los
// distinga.
//
// SE APUNTA ANTES DE MUTAR, y es la única regla que sus llamadores tienen que respetar. La razón es
// concreta: `advance` puede cerrar la ronda —por dominó o por tranca— y abrir la siguiente, que ya
// es OTRO registro, así que apuntar después mandaría la última jugada de una mano al registro de la
// mano que sigue. Va DESPUÉS de la guarda de legalidad —que lanza— y antes del verbo, así que lo
// que no se pudo hacer tampoco se apunta.
export class MoveLog {
  constructor(private readonly match: MatchState) {}

  record(type: MoveType, playerId: PlayerId): void {
    // `currentRound` es rama nula hasta la génesis. No puede faltar acá —las tres jugadas exigen
    // una ronda en PLAYING y el juez ya lo comprobó— pero el tipo lo pide, y devolver en vez de
    // lanzar es lo correcto para un actor que no decide nada.
    const round = this.match.currentRound;
    if (!round) return;

    const move = new PastMove();
    move.type = type;
    move.playerId = playerId;
    round.pastMoves.push(move);
  }
}
