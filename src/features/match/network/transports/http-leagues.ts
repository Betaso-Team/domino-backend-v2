import type { LeagueFeed, LeaguePlayer, LeagueResult } from "../standings";

// LA LIGA, que va por HTTP y no por cola. Es la excepción entre los reportes del cierre —el
// premio, el ranking y el historial salen todos por cola o por Mongo— y no por diseño nuestro: el
// endpoint existe así del otro lado desde v1 (`src/league/league.service.ts:36`) y replicarlo es
// lo que no rompe nada el día del corte.
//
// **Va SIN credencial**, como en v1: ni este lado la manda ni el otro la pide. Se reproduce tal
// cual porque cambiarlo unilateralmente dejaría la liga sin recibir nada, pero conviene que esté
// escrito: una ruta que acepta resultados de partidas sin autenticar es de las cosas que vale
// reportar del lado de la plataforma.
//
// USA EL `fetch` DE LA PLATAFORMA y no un cliente HTTP propio, que es lo que truco tiene
// (`shared/http`). Acá hay UN solo consumidor saliente en todo el repo y la llamada es un POST sin
// credencial, sin reintentos y sin leer la respuesta: un cliente con baseUrl, timeouts y
// traducción de errores sería una capa cuyo único usuario no la necesita. El día que aparezca el
// segundo, ahí se extrae.
const PATH = "leagues/save";

// CUÁL LIGA. En v1 es una cadena literal y es la misma para todas las mesas: el dominó tiene UNA
// liga, no una por modo (`domino-room-state.ts:606`).
const LEAGUE_NAME = "Domino";

// El plazo. Nada de esto puede colgar el cierre de la partida —el listener ya lo dispara sin
// esperar—, pero una petición sin plazo deja el socket abierto hasta que el kernel se aburra, y
// con él el `Promise` que el listener dejó corriendo.
const TIMEOUT_MS = 5_000;

const userOf = (player: LeaguePlayer) => ({
  id: player.userUuid,
  username: player.username,
  profilePicture: player.profilePicture,
});

export class HttpLeagueFeed implements LeagueFeed {
  // La `baseUrl` llega CON la barra final o sin ella y acá se normaliza, porque las dos formas
  // existen en los `.env` de v1 y `${base}leagues/save` contra `${base}/leagues/save` son dos
  // rutas distintas — una de ellas 404.
  private readonly base: string;

  constructor(baseUrl: string) {
    this.base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  }

  async record(result: LeagueResult): Promise<void> {
    const response = await fetch(`${this.base}${PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // `loosers` CON DOS O, y no es un typo nuestro: es el nombre del campo del otro lado
      // (`league.service.ts:38`). Corregirlo acá deja a la liga sin los perdedores.
      body: JSON.stringify({
        leagueName: LEAGUE_NAME,
        users: { winner: userOf(result.winner), loosers: result.losers.map(userOf) },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // SE MIRA EL ESTADO aunque nadie use el cuerpo. `fetch` solo rechaza por fallo de RED, así que
    // sin esto un 500 del backend principal resolvería como éxito y el log del listener diría que
    // la liga recibió el resultado que no recibió.
    if (!response.ok) {
      throw new Error(`la liga rechazó el resultado: HTTP ${response.status}`);
    }
  }
}
