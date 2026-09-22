import type { TokenVerifier } from "@/features/auth";
import type { SeatCredentials } from "@/features/match";
import { type AuthContext, type Client, type Delayed, Room } from "@colyseus/core";
import { MatchmakingError, type MatchmakingErrorReason } from "../../errors";
import type { MatchCensus } from "../../live-matches";
import type { MaintenanceSignal } from "../../maintenance";
import type { Matchmaker } from "../../matchmaker";
import type { PoolRequest } from "../../pool-spec";

/**
 * What the room needs of the world, handed to it when the room is defined. It does
 * NOT resolve from a container: this room is no composition root, and importing
 * one would make the container — which builds the matcher — depend on the room.
 * Taking them as options keeps the dependency pointing one way.
 */
export interface LobbyDeps {
  readonly matchmaker: Matchmaker;
  readonly verifier: TokenVerifier;
  // WHETHER THE GAME IS OPEN, so it can be said without being asked. The room does not consult it to
  // DECIDE anything — the matcher is what closes the door — but to TELL it: this is the only place
  // holding the sockets of those staring at the search button.
  readonly maintenance: MaintenanceSignal;
  // How many are playing across the cluster. Same shape as the switch and for the same reason: the
  // room decides nothing with it, it REPORTS it.
  readonly census: MatchCensus;
}

/**
 * The lobby's banner: how many people there are and where. Three numbers and a
 * breakdown, each answering a different question — "is anyone around?", "is anyone
 * looking right now?", "if I join this table, do I wait long?".
 *
 * What is counted is LIVE SEATS and not sockets, which is what "is playing"
 * actually means: someone whose wifi dropped is still playing, their clock runs
 * and their cards are on the table. That is why these numbers do not match v1's.
 */
export interface LobbyStats {
  /** Seated in a live match of the cluster, casual and tournament alike. */
  readonly playersInMatch: number;
  /** Connected to this lobby, whether searching or not. */
  readonly playersInLobby: number;
  /** Queued, waiting for a rival. */
  readonly playersSearching: number;
  /**
   * The breakdown per catalog table. Casual only: a tournament counts towards the
   * total but is not a table anyone can pick.
   */
  readonly byGameMode: readonly GameModeStats[];
}

export interface GameModeStats {
  readonly gameModeId: string;
  readonly playersInMatch: number;
  readonly playersSearching: number;
}

// How often it is published. A pulse of its own and not a reaction to someone joining or leaving:
// what it counts happens at the TABLES, so ten matches could start and end with the banner frozen
// until somebody opened the app.
const STATS_INTERVAL_MS = 5_000;

// What is shown before the first pulse, which lasts as long as the first count takes. Zeroes and not
// silence: the banner falls back to "I do not know yet", which breaks a screen the least. A LATER
// failure does not come back here — there the last good number is kept.
const EMPTY_STATS: LobbyStats = {
  playersInMatch: 0,
  playersInLobby: 0,
  playersSearching: 0,
  byGameMode: [],
};

// THE LOBBY: a transport and nothing else. It decodes the request, waits for the answer and sends it
// back. The queue, the grouping and the opening of a match all live on the other side of three ports.
//
// ONE message in, ONE message out. The wait can last minutes and is held by a promise rather than a
// callback: this room holds the socket, so the waiting is its own.

interface RequestMatchPayload {
  kind?: string;
  gameModeId?: string;
  tournamentId?: string;
}

export class LobbyRoom extends Room {
  // One request in flight per client. Cancelling or leaving aborts theirs and nothing else.
  private readonly pending = new Map<string, AbortController>();
  private deps!: LobbyDeps;
  // How to stop listening to the switch. The signal is per PROCESS and this room is not: it is born
  // and dies many times over while the signal lives on.
  private unwatch?: () => void;
  // The banner's pulse, and the last thing published. It is kept because whoever JOINS has to see a
  // number on their first render and not wait for the next pulse.
  private ticker?: Delayed;
  private stats: LobbyStats = EMPTY_STATS;

  // @colyseus/auth instala un static onAuth que decodifica el JWT ANTES de instanciar la sala.
  // Hasta `@colyseus/core` 0.18.12 su resultado GANABA: `Room._onJoin` no llamaba al `onAuth` de
  // instancia, `client.auth` quedaba en el payload crudo —`{ sub, iat, exp }`— y toda búsqueda
  // moría con `INTERNAL`. Desde 0.18.13 el de instancia corre igual (`Room.mjs:1101`), pero la
  // override SIGUE haciendo falta: sin ella un token que ese decodificador no acepta sale
  // `AUTH_FAILED` genérico en el matchmaking, antes de que nuestro verificador diga POR QUÉ. Es la
  // misma override que ya llevan `DominoRoom` y el lobby viejo; truco no la necesita porque no
  // tiene el módulo instalado.
  static override async onAuth(
    _token: string,
    _options: unknown,
    _context: AuthContext,
  ): Promise<true> {
    return true;
  }

  /**
   * The door. Everything underneath — the cooldown, the veto, the penalty — is
   * indexed by account, so while the client could declare its own id all three
   * layers were bypassed by changing a string. Here it stops being able to.
   *
   * @throws {InvalidTokenError} when the token does not verify.
   */
  override async onAuth(
    _client: Client,
    _options: unknown,
    context: AuthContext,
  ): Promise<SeatCredentials> {
    const { userId } = await this.deps.verifier.verify(context.token);
    return { userId, token: context.token ?? "" };
  }

  override onCreate(deps: LobbyDeps): void {
    this.deps = deps;
    // THE PUSH. It exists because the door alone is invisible: refusing whoever asks says nothing to
    // whoever is looking at the button without pressing it yet. The front blocks its UI with this
    // instead of letting someone attempt what is going to fail.
    //
    // The CHANGE is broadcast, both ways. Reopening matters as much as closing — without it the front
    // would stay blocked until someone reloaded.
    this.unwatch = deps.maintenance.onChange((maintenance) =>
      this.broadcast("MAINTENANCE", maintenance),
    );
    // The banner, on the room's clock. It has to beat even when nobody joins or leaves.
    this.ticker = this.clock.setInterval(() => void this.publishStats(), STATS_INTERVAL_MS);
    void this.publishStats();
    this.onMessage("REQUEST_MATCH", (client, payload) => {
      void this.search(client, payload as RequestMatchPayload);
    });
    // Cancelling is aborting the wait. There is no state to clean up here: the matcher removes the
    // ticket from the queue when it receives the signal.
    this.onMessage("CANCEL_MATCH", (client) => this.pending.get(client.sessionId)?.abort());
  }

  /**
   * The greeting: how things stand now, unasked. Someone joining during a
   * maintenance has to see it on their first render, and someone joining with the
   * game open receives the same message with `false` — always sending it leaves
   * the client ONE code path instead of two, and spares it having to infer from
   * silence that all is well.
   *
   * It comes from memory, so it costs no read per lobby join.
   */
  override onJoin(client: Client): void {
    client.send("MAINTENANCE", this.deps.maintenance.current());
    // The banner, in two beats and on purpose. First the last count, waiting for nobody — the first
    // render has a number even if the store is slow or down — with `playersInLobby` corrected
    // because this client is already inside and the previous pulse did not see them. Then a fresh
    // count right away.
    client.send("LOBBY_STATS", { ...this.stats, playersInLobby: this.clients.length });
    void this.publishStats();
  }

  override onLeave(client: Client): void {
    // Leaving the lobby is cancelling. Without this, whoever closes the app stays in the queue and
    // ends up paired with someone who then waits alone until the room gives up.
    this.pending.get(client.sessionId)?.abort();
  }

  override onDispose(): void {
    this.unwatch?.();
    this.unwatch = undefined;
    this.ticker?.clear();
    this.ticker = undefined;
    for (const abort of this.pending.values()) abort.abort();
    this.pending.clear();
  }

  // COUNTS AND BROADCASTS. The two questions run in parallel because neither depends on the other
  // and one of them goes to the shared store.
  //
  // A failure breaks neither the lobby nor the banner: the last good number is kept and the next
  // pulse retries. A hiccup in the store is no reason to tell everyone nobody is playing.
  private async publishStats(): Promise<void> {
    try {
      const [census, waiting] = await Promise.all([
        this.deps.census.count(),
        this.deps.matchmaker.waiting(),
      ]);
      this.stats = {
        playersInMatch: census.playersInMatch,
        playersInLobby: this.clients.length,
        playersSearching: waiting.total,
        byGameMode: byGameModeOf(census.byGameMode, waiting.byGameMode),
      };
      this.broadcast("LOBBY_STATS", this.stats);
    } catch {
      // No log: the lobby has no logger and this is a banner. If the store is down, whoever uses it
      // to decide is what reports it.
    }
  }

  private async search(client: Client, payload: RequestMatchPayload): Promise<void> {
    // One request per client: asking again replaces the previous one instead of leaving two alive.
    this.pending.get(client.sessionId)?.abort();
    const abort = new AbortController();
    this.pending.set(client.sessionId, abort);

    try {
      const credentials = client.auth as SeatCredentials;
      const seat = await this.deps.matchmaker.request(
        poolRequestOf(payload),
        { playerId: credentials.userId, token: credentials.token },
        abort.signal,
      );
      // The reservation is sent AS-IS: to this room it is opaque. The client consumes it and turns
      // up in its match.
      client.send("MATCH_FOUND", seat.reservation);
    } catch (e) {
      client.send("MATCHMAKING_ERROR", { reason: reasonOf(e) });
    } finally {
      // Only if it is still theirs: a new request may already have put another in the map.
      if (this.pending.get(client.sessionId) === abort) this.pending.delete(client.sessionId);
    }
  }
}

// THE TWO HALVES OF A TABLE, joined by its id: those already playing at it and those waiting for it.
// They come from different places — the cluster census and this process's queue — and a table can
// appear in one and not the other: the one with matches and nobody waiting, and the freshly opened
// one where the first player is still waiting alone.
function byGameModeOf(
  inMatch: ReadonlyMap<string, number>,
  searching: ReadonlyMap<string, number>,
): readonly GameModeStats[] {
  return [...new Set([...inMatch.keys(), ...searching.keys()])].map((gameModeId) => ({
    gameModeId,
    playersInMatch: inMatch.get(gameModeId) ?? 0,
    playersSearching: searching.get(gameModeId) ?? 0,
  }));
}

// What the client sends is unverified text, and out of here comes the discriminated union the rest
// of matchmaking takes for granted. This is the boundary: nothing is validated again inside.
function poolRequestOf(payload: RequestMatchPayload): PoolRequest {
  if (payload?.kind === "TOURNAMENT") {
    if (!payload.tournamentId)
      throw new MatchmakingError("POOL_NOT_FOUND", "falta el tournamentId");
    return { kind: "TOURNAMENT", tournamentId: payload.tournamentId };
  }
  if (payload?.kind === "CASUAL") {
    if (!payload.gameModeId) throw new MatchmakingError("POOL_NOT_FOUND", "falta el gameModeId");
    return { kind: "CASUAL", gameModeId: payload.gameModeId };
  }
  throw new MatchmakingError("POOL_NOT_FOUND", `modo desconocido: ${String(payload?.kind)}`);
}

// The client receives the REASON and never the message: internal details — which tournament, which
// service failed — are none of its business, and an exception's text is exactly where they leak.
function reasonOf(error: unknown): MatchmakingErrorReason {
  return error instanceof MatchmakingError ||
    (error instanceof Error && error.name === "MatchmakingError")
    ? (error as MatchmakingError).reason
    : "INTERNAL";
}
