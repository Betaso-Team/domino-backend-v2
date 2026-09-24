import type { Logger } from "@/logger";
import type { DominoMatchConfig, MatchSeat } from "../core/config";
import type { MatchState } from "../core/state";
import type { NetworkMatchEvent } from "./events";
import type { MatchEventListener } from "./listeners";
import type { LeagueFeed, LeaguePlayer, RankingFeed } from "./standings";

// CERRÓ LA PARTIDA CON GANADOR: se le cuenta a las dos tablas que el jugador mira. Es un
// TRADUCTOR, como `settlementOf` —lee el estado y el snapshot y arma dos llamadas— y por eso vive
// acá y no adentro de los transportes que publican.
//
// **UN LISTENER Y DOS DESTINOS**, porque es un solo hecho contado a dos lados y separarlo es
// exactamente cómo se desincronizan. Lo que no comparten es la CONDICIÓN, que está en `standings.ts`.
//
// **NADA DE ESTO PUEDE TUMBAR EL CIERRE DE LA PARTIDA.** El veredicto ya salió al cliente —el
// notificador difunde primero y tal cual entró— y la liquidación es de otro camino. Un reporte que
// falla es una fila que falta en una tabla, no una partida rota. Por eso se dispara SIN esperar y
// el fallo solo se anota, que es la misma política que el notificador ya tiene escrita: un efecto
// de plataforma que falle no puede tapar lo del dominio.
//
// ES UNA FUNCIÓN Y NO UNA CLASE porque el listener del dominó es una función
// (`MatchEventListener`), sin la lista de `listens` que truco necesita para despachar por tipo.
// Acá el filtrado por tipo es el `if` de la primera línea, y con dos eventos de cierre en todo el
// catálogo eso es más barato que un registro.

// LOS DOS DESTINOS SON OPCIONALES Y POR SEPARADO, y no es defensividad: dependen de dos cosas
// distintas del entorno —el ranking del broker (`RABBITMQ_URL`), la liga del backend principal
// (`BACKEND_URL`)— y exigir los dos juntos dejaría a una instancia con broker y sin URL sin
// reportar tampoco el ranking, que sí puede.
//
// Ausente NO es un no-op silencioso: se anota. Es la misma política que el outbox del catálogo, que
// sin publicador acumula y lo dice, en vez de arrancar creyendo que publica.
export interface ReportStandingsDeps {
  readonly config: DominoMatchConfig;
  readonly match: MatchState;
  readonly ranking?: RankingFeed;
  readonly leagues?: LeagueFeed;
  readonly log: Logger;
}

export function reportStandings(deps: ReportStandingsDeps): MatchEventListener {
  return (event: NetworkMatchEvent): readonly NetworkMatchEvent[] => {
    // SOLO EL CIERRE CON VEREDICTO. `MATCH_ABORTED` no entra: una partida sin ganador no tiene
    // nada que contarle a un ranking de victorias ni a una tabla de liga, y su plata ya la
    // reembolsa `settlementOf`.
    if (event.type === "MATCH_RESOLVED") {
      void report(deps, event.winnerTeamId).catch((error) =>
        deps.log.error("no se pudo reportar el cierre", {
          err: String(error),
          matchId: deps.config.matchId,
        }),
      );
    }
    // No emite nada: estas dos tablas son de la PLATAFORMA y ningún oyente de esta partida las
    // mira. Devolver algo acá sería una cascada sin consumidor.
    return [];
  };
}

async function report(deps: ReportStandingsDeps, winnerTeamId: string): Promise<void> {
  const { config, match } = deps;
  const seatOf = new Map(config.seats.map((seat) => [seat.playerId, seat]));
  // LOS EQUIPOS SE LEEN DEL ESTADO —que es quien reparte los asientos— y LA IDENTIDAD DEL
  // SNAPSHOT, que es donde está congelada. Es el mismo cruce por id opaco que hace la
  // liquidación, y por el mismo motivo: el motor no sabe de plataformas.
  const seatsOf = (matches: (teamId: string) => boolean): MatchSeat[] =>
    match.players
      .filter((player) => matches(player.teamId))
      .map((player) => seatOf.get(player.playerId))
      .filter((seat): seat is MatchSeat => seat !== undefined);

  const winners = seatsOf((teamId) => teamId === winnerTeamId);
  const losers = seatsOf((teamId) => teamId !== winnerTeamId);
  const [winner] = winners;
  // SIN GANADOR NO SE REPORTA NADA, y es alcanzable sin ser un bug: el cruce de un estado con el
  // snapshot de otra mesa deja los asientos sin resolver. La liquidación revienta la invariante
  // ahí porque mueve plata; acá se calla, porque una fila que falta es más barata que un cierre
  // roto por una tabla de puntos.
  if (!winner) {
    deps.log.warn("cierre sin asiento ganador: no se reporta", {
      matchId: config.matchId,
      winnerTeamId,
    });
    return;
  }

  // EL RANKING, SOLO EN MESAS PAGAS. La condición es `isFreeRoom` y no `entryFee > 0`: son dos
  // hechos distintos —"acá no se juega por plata" y "esta mesa salió gratis"— y v1 pregunta por el
  // primero.
  if (config.isFreeRoom) {
    // Una mesa gratis no reparte puntos, y NO es lo mismo que no tener a dónde reportarlos: se
    // anota distinto porque el que investiga "no me sumó" necesita saber cuál de las dos fue.
    deps.log.debug("mesa gratis: no suma al ranking", { matchId: config.matchId });
  } else if (!deps.ranking) {
    deps.log.debug("sin destino de ranking: la victoria no se reporta", {
      matchId: config.matchId,
    });
  } else {
    // LOS PUNTOS ESCALAN CON EL AUMENTO ACEPTADO, sumando: es la fórmula de v1
    // (`multiplier + acceptedBetExtra`). Sin aumento, `acceptedBetExtra` es 0 y queda el peso del
    // modo tal cual, así que una mesa sin la feature no cambia de comportamiento.
    const multiplier = config.multiplier + match.acceptedBetExtra;
    const betIncrease =
      match.acceptedBetLevel > 0
        ? {
            level: match.acceptedBetLevel,
            extra: match.acceptedBetExtra,
            baseMultiplier: config.multiplier,
          }
        : undefined;
    const opponentIds = losers.map((seat) => seat.userId);

    const ranking = deps.ranking;
    // EN SERIE Y NO EN PARALELO: en 2P es UNA sola participación, y el día que el 4P se abra son
    // dos del mismo equipo. Encadenarlas deja el orden de las filas estable en el log del otro
    // lado, que es lo que se mira cuando alguien reclama sus puntos.
    for (const seat of winners) {
      await ranking.won({
        userId: seat.userId,
        username: seat.username ?? "",
        profilePicture: seat.profilePicture ?? "",
        currency: seat.currency,
        multiplier,
        opponentIds,
        ...(betIncrease && { betIncrease }),
      });
    }
  }

  // LA LIGA, TAMBIÉN EN LAS GRATIS: queda FUERA del `if` de arriba, igual que en v1.
  if (deps.leagues) {
    await deps.leagues.record({
      winner: leaguePlayerOf(winner),
      losers: losers.map(leaguePlayerOf),
    });
  } else {
    deps.log.debug("sin destino de liga: el cierre no se reporta", { matchId: config.matchId });
  }
}

// `?? ""` en el nombre y `?? null` en la foto, y la asimetría es de v1: manda
// `String(username ?? "")` y `profilePicture ?? null`. Un invitado no tiene ninguno de los dos.
const leaguePlayerOf = (seat: MatchSeat): LeaguePlayer => ({
  userId: seat.userId,
  username: seat.username ?? "",
  profilePicture: seat.profilePicture ?? null,
});
