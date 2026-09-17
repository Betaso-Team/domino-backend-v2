import type { PlayerId } from "../ids";
import type { MatchView, PrivatePlayerView, RoundView } from "../rules/view";
import type { MatchState } from "./match";

// CÓMO ESTE ÁRBOL SE MUESTRA COMO UNA `MatchView`. Es la mitad SERVIDOR de la frontera de las
// reglas.
//
// **No copia nada y no traduce nada.** Los nodos de Colyseus ya satisfacen las interfaces de la
// vista por estructura —`ArraySchema<V> implements Array<V>`, y un objeto con campos de más
// satisface una interfaz que pide menos—, así que cada getter devuelve el nodo VIVO. Lo único
// que esta clase agrega es la PUERTA de lo privado, que un schema no tiene porque del lado del
// servidor no hace falta: acá se ve todo.
//
// Esa asimetría es justamente el contrato. La vista del cliente implementará la misma interfaz y
// su `privateOf` contestará solo por su propio asiento; una regla escrita contra `MatchView` no
// puede notar la diferencia salvo preguntando, que es lo que se quiere.
//
// Se construye UNA vez por juez y no tiene estado propio. Los getters existen —en vez de un
// spread del árbol— porque el árbol se MUTA: una copia quedaría mirando la ronda de hace tres
// jugadas, y los campos de un Schema viven en el prototipo, así que el spread ni siquiera los
// copiaría.
export class SchemaMatchView implements MatchView {
  constructor(private readonly match: MatchState) {}

  get phase() {
    return this.match.phase;
  }
  get scoreboard() {
    return this.match.scoreboard;
  }
  get players() {
    return this.match.players;
  }
  get currentRound(): RoundView | undefined {
    return this.match.currentRound;
  }
  get pastRounds() {
    return this.match.pastRounds;
  }
  get pointsToWin() {
    return this.match.pointsToWin;
  }
  get activeDeadline() {
    return this.match.activeDeadline;
  }
  get startedAt() {
    return this.match.startedAt;
  }
  get acceptedBetExtra() {
    return this.match.acceptedBetExtra;
  }
  get acceptedBetLevel() {
    return this.match.acceptedBetLevel;
  }

  // En el servidor SIEMPRE contesta: acá no hay nada oculto. `undefined` queda reservado para el
  // jugador que no existe, que del lado del motor es un error de invariante y no una cuestión de
  // visibilidad — y por eso no se distingue: quien pregunta por un id inventado no merece otra
  // respuesta que "no lo ves".
  privateOf(playerId: PlayerId): PrivatePlayerView | undefined {
    const player = this.match.players.find((candidate) => candidate.playerId === playerId);
    return player ? { tiles: player.hand.tiles } : undefined;
  }
}
