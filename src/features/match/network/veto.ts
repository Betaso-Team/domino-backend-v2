import { type TournamentConfig, computeQuality } from "@/features/tournament";
import type { Clock } from "../core/engine/clock";
import type { MatchState } from "../core/state";
import type { CasualRoomOptions, TournamentRoomOptions } from "../transports/match-contract";
import type { MatchEventListener } from "./listeners";

// LOS DOS QUE ANOTAN «a estos dos, por un rato, no los vuelvas a cruzar». Son la capa que ataca
// la colusión: dos cuentas cómplices que se enfrentan una y otra vez para bombearse puntos o
// mover plata entre ellas.
//
// SOLO EMITEN. Escribir el veto es de matchmaking, que es quien lo lee al emparejar
// (`matchmakingSink` → `VetoBook.register`). Acá no se importa el libro ni se sabe que existe:
// si este archivo pudiera escribirlo, una partida estaría decidiendo a quién empareja el lobby.
//
// ⚠ EL CONSUMIDOR YA EXISTÍA Y ESTOS NO, que es el defecto que este archivo cierra. El port de
// matchmaking trajo `matchmakingSink` escuchando `CASUAL_PAIR_VETOED` y `PAIR_VETOED`, y los dos
// productores quedaron del otro lado. Nadie emitía ninguno de los dos, así que los libros se
// leían siempre vacíos: `vetoedFor()` devolvía `[]` en cada consulta y el emparejador no evitaba
// a nadie nunca. No lo veía ningún test —leer un libro vacío es indistinguible de leer uno que
// funciona— ni el grafo, porque el consumidor compilaba solo.

/**
 * CASUAL: se veta cuando la partida que cierra YA ERA la revancha.
 *
 * Terminar una partida normal no veta a nadie, y esa es toda la regla: el objetivo no es
 * prohibir que dos se vuelvan a cruzar —el emparejador junta a quien haya— sino desalentar
 * REPETIR. Vetar en la primera convertiría cada partida en una pareja prohibida y vaciaría el
 * pozo de rivales de cualquiera que juegue seguido.
 *
 * Por eso mira `rematchCount`: la mesa original llega con cero y la revancha con uno, que es el
 * mismo número con el que `RematchCoordinator` corta la cadena. Un solo dato, dos consecuencias.
 */
export function registerCasualVeto(
  options: CasualRoomOptions,
  match: MatchState,
): MatchEventListener {
  return (event) => {
    if (event.type !== "MATCH_RESOLVED") return [];
    if ((options.rematchCount ?? 0) <= 0) return [];
    return [{ type: "CASUAL_PAIR_VETOED", playerIds: match.players.map((p) => p.playerId) }];
  };
}

export interface TournamentVetoDeps {
  readonly options: TournamentRoomOptions;
  readonly match: MatchState;
  readonly config: TournamentConfig;
  readonly clock: Clock;
}

/**
 * TORNEO: se veta cuando la partida fue de BAJA CALIDAD.
 *
 * El abuso que ataca es otro: dos cómplices que se enfrentan y uno se rinde en treinta segundos
 * para inflar la tabla. La calidad es justamente eso —cuántas rondas y cuánto duró contra lo
 * esperado— así que una partida corta y de pocas manos entre los mismos dos es la firma.
 *
 * RECALCULA LA CALIDAD en vez de recibirla del que reporta la participación, y es a propósito:
 * son dos consecuencias independientes de un mismo hecho, y encadenarlas las volvería una sola
 * pieza partida al medio, con un orden implícito entre las dos. La fórmula es pura y barata.
 */
export function registerTournamentVeto(deps: TournamentVetoDeps): MatchEventListener {
  return (event) => {
    if (event.type !== "MATCH_RESOLVED") return [];
    const durationMs = deps.clock.now() - deps.match.startedAt;
    const { grade } = computeQuality(deps.match.pastRounds.length, durationMs, deps.config);
    if (grade > deps.config.vetoMaxQuality) return [];
    return [
      {
        type: "PAIR_VETOED",
        tournamentId: deps.options.tournamentId,
        playerIds: deps.match.players.map((p) => p.playerId),
      },
    ];
  };
}
