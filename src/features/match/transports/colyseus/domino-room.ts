import { StateView } from "@colyseus/schema";
import {
  type AuthContext,
  type Client,
  CloseCode,
  type Deferred,
  type Delayed,
  Room,
  type RoomException,
  type RoomMethodName,
} from "colyseus";
import { rootContainer } from "../../../../di-container.js";
import type { Logger } from "../../../../logger.js";
import { InvalidTokenError, type TokenVerifier } from "../../../auth/index.js";
import type { GlobalDominoConfig } from "../../core/config.js";
import { RuleViolationError } from "../../core/engine/errors.js";
import { createMatchState } from "../../core/engine/genesis.js";
import type { SchemaVisibilityController } from "../../core/engine/visibility.js";
import type { PlayerId } from "../../core/ids.js";
import type { MatchState } from "../../core/state/index.js";
import type { AbortReason, NetworkMatchEvent } from "../../network/events.js";
import { MatchEventNotifier, type MatchHistory } from "../../network/index.js";
import { type DominoRoomOptions, type SeatCredentials, configOf } from "../match-contract.js";
import { MatchRegistry } from "../match-registry.js";
import {
  type MatchHasOutcome,
  type MatchSeatGuard,
  type MatchStarter,
  buildCatalog,
  buildPieces,
  registerIndividualCommands,
} from "./commands/di-wiring.js";
import type { CommandCatalog } from "./commands/index.js";
import {
  PlayerAlreadyOutError,
  SeatNotReservedError,
  UnknownCommandError,
  ValidationError,
} from "./errors.js";
import { RoomTimeoutScheduler } from "./timeout-scheduler.js";
import { StateViewVisibilityController } from "./visibility.js";

const RECONNECTION_WINDOW_SECONDS = 120;

export class DominoRoom extends Room<{ state: MatchState; client: Client }> {
  private seats: readonly PlayerId[] = [];
  private catalog!: CommandCatalog;
  private notifier!: MatchEventNotifier;
  private scheduler!: RoomTimeoutScheduler;
  private history!: MatchHistory;
  private hasOutcome!: MatchHasOutcome;
  private isStillPlaying!: MatchSeatGuard;
  private startMatch!: MatchStarter;
  private log!: Logger;
  private seating?: Delayed;
  private readonly views = new Map<PlayerId, StateView>();
  private readonly seated = new Set<PlayerId>();
  private readonly pendingReconnections = new Map<PlayerId, Deferred<Client>>();

  // @colyseus/auth instala un static onAuth que decodifica el JWT antes de instanciar la
  // sala. Esta override lo neutraliza solo acá: la verificación de firma, algoritmo y sub
  // pertenece al TokenVerifier de instancia, que es la frontera de autenticación del juego.
  static override async onAuth(
    _token: string,
    _options: unknown,
    _context: AuthContext,
  ): Promise<true> {
    return true;
  }

  override onCreate(options: DominoRoomOptions): void {
    const global = rootContainer.resolve<GlobalDominoConfig>("GlobalDominoConfig");
    this.seats = options.seats;
    // Colyseus cuenta las reservas de reconexión aunque unlock() abra el listing. Dos
    // cupos por asiento permiten conservar el token viejo mientras entra un reemplazo,
    // sin abrir capacidad ilimitada: onJoin sigue siendo la puerta de los asientos reales.
    this.maxClients = this.seats.length * 2;

    const config = configOf(options);
    const match = createMatchState(config);
    const child = rootContainer.createChildContainer();
    child.register("Config", { useValue: config });
    child.register("MatchState", { useValue: match });

    // La vista es del asiento, no del socket: existe antes de que el dueño se conecte y
    // conserva las revelaciones privadas si el socket se reemplaza o se reconecta.
    for (const playerId of this.seats) this.views.set(playerId, new StateView());
    child.register<SchemaVisibilityController>("SchemaVisibilityController", {
      useValue: new StateViewVisibilityController(this.views),
    });

    this.scheduler = new RoomTimeoutScheduler(this.clock, (events: readonly NetworkMatchEvent[]) =>
      this.notifier.notify(events),
    );
    // El scheduler tiene que estar registrado antes de armar los actores: el conductor
    // del motor recibe solo el puerto y nunca debe conocer la sala.
    child.register("TimeoutScheduler", { useValue: this.scheduler });
    registerIndividualCommands(child);
    this.catalog = buildCatalog(child);

    const pieces = buildPieces(child, (events: readonly NetworkMatchEvent[]) =>
      this.notifier.notify(events),
    );
    this.history = pieces.history;
    this.notifier = new MatchEventNotifier(
      pieces.listeners,
      (events) => this.broadcast("events", events),
      pieces.sinks,
    );
    this.hasOutcome = child.resolve<MatchHasOutcome>("MatchHasOutcome");
    this.isStillPlaying = child.resolve<MatchSeatGuard>("MatchSeatGuard");
    this.startMatch = child.resolve<MatchStarter>("MatchStarter");

    this.log = rootContainer
      .resolve<Logger>("Logger")
      .child({ matchId: config.matchId, roomId: this.roomId, gameModeId: config.gameModeId });
    this.setState(match);
    rootContainer.resolve(MatchRegistry).register(this.roomId, config);

    this.seating = this.clock.setTimeout(() => {
      this.log.warn("plazo de ocupación vencido", { clients: this.clients.length });
      this.disconnect();
    }, global.seatingTimeoutMs);
    this.onMessage("*", (client, type, payload) =>
      this.handleMessage(client, String(type), payload),
    );
    this.log.info("sala creada");
  }

  override async onAuth(
    _client: Client,
    _options: DominoRoomOptions,
    context: AuthContext,
  ): Promise<SeatCredentials> {
    const token = context.token ?? undefined;
    const identity = await rootContainer.resolve<TokenVerifier>("TokenVerifier").verify(token);
    return { userId: identity.userId, token: token ?? "" };
  }

  override onJoin(client: Client): void {
    const { userId: playerId } = client.auth as SeatCredentials;
    // Primero pertenece a la mesa; recién después se pregunta si sigue jugando. Invertir
    // el orden filtra el estado de una partida a un principal sin asiento reservado.
    if (!this.seats.includes(playerId)) throw new SeatNotReservedError(playerId);
    if (!this.isStillPlaying(playerId)) throw new PlayerAlreadyOutError(playerId);
    this.cancelPendingReconnection(playerId);

    client.userData = { playerId };
    client.view = this.views.get(playerId);
    this.player(playerId).connected = true;
    // El dispositivo más nuevo gana. Registrar primero la identidad de esta conexión
    // hace que onLeave del socket desplazado ya la vea y no marque al jugador offline.
    this.clientOf(playerId, client)?.leave(CloseCode.CONSENTED);

    const isBack = this.seated.has(playerId);
    this.seated.add(playerId);
    if (isBack) this.notifier.notify([{ type: "PLAYER_RECONNECTED", playerId }]);
    this.log.info("jugador conectado", { playerId, reconnecting: isBack });
    this.startIfSeated();
  }

  override onDrop(client: Client): void {
    const playerId = this.playerIdOf(client);
    if (!playerId) return;
    // Colyseus finaliza esta promesa cuando vence o se usa el token. Capturar solo su
    // rechazo evita un unhandled rejection al disponer la sala sin interceptar ese flujo.
    this.cancelPendingReconnection(playerId);
    const pending = this.allowReconnection(client, RECONNECTION_WINDOW_SECONDS);
    this.pendingReconnections.set(playerId, pending);
    void pending.then(
      () => this.forgetPendingReconnection(playerId, pending),
      () => this.forgetPendingReconnection(playerId, pending),
    );
    // unlock abre el listing, pero no borra la reserva; el segundo cupo por asiento de
    // onCreate es lo que deja entrar al reemplazo sin invalidar el token viejo.
    void this.unlock();
    this.player(playerId).connected = false;
    this.log.info("jugador desconectado", { playerId });
  }

  override onReconnect(client: Client): void {
    const playerId = this.playerIdOf(client);
    if (!playerId) return;
    if (!this.seats.includes(playerId)) throw new SeatNotReservedError(playerId);
    if (!this.isStillPlaying(playerId)) throw new PlayerAlreadyOutError(playerId);
    // Un token de reconexión pertenece al socket caído, no al asiento. Si una sesión
    // fresca ya ocupó el asiento, esa sesión ganó y el token viejo queda desplazado.
    if (this.clientOf(playerId, client)) {
      client.leave(CloseCode.CONSENTED);
      return;
    }
    this.player(playerId).connected = true;
    if (this.clients.length >= this.maxClients) void this.lock();
    this.notifier.notify([{ type: "PLAYER_RECONNECTED", playerId }]);
    this.log.info("jugador reconectado", { playerId });
  }

  override onLeave(client: Client): void {
    const playerId = this.playerIdOf(client);
    if (!playerId || this.clientOf(playerId)) return;
    this.player(playerId).connected = false;
    this.notifier.notify([{ type: "PLAYER_DISCONNECTED", playerId }]);
    this.log.info("jugador salió", { playerId });
  }

  override onDispose(): void {
    if (this.notifier && !this.hasOutcome()) {
      // Con revancha habrá fases posteriores al veredicto: la guarda futura debe mirar el
      // veredicto del juez, no la fase terminal, para no reembolsar una partida ya pagada.
      this.notifier.notify([{ type: "MATCH_ABORTED", reason: this.abortReason() }]);
      this.log.warn("partida abortada");
    }
    this.scheduler?.cancel();
    this.seating?.clear();
    for (const view of this.views.values()) view.dispose();
    rootContainer.resolve(MatchRegistry).remove(this.roomId);
  }

  override onUncaughtException(error: RoomException, methodName: RoomMethodName): void {
    const cause = error.cause;
    if (
      cause instanceof SeatNotReservedError ||
      cause instanceof PlayerAlreadyOutError ||
      cause instanceof ValidationError ||
      cause instanceof UnknownCommandError ||
      cause instanceof InvalidTokenError
    ) {
      this.log.warn("rechazo esperado", { method: methodName, reason: cause.message });
      return;
    }
    this.crash(cause, methodName);
  }

  private handleMessage(client: Client, type: string, payload: unknown): void {
    const playerId = this.playerIdOf(client);
    if (!playerId) return;
    try {
      if (!this.catalog.accepts(type)) throw new UnknownCommandError(type);
      const decoded = this.catalog.decoder(type).decode(payload, playerId);
      const events = this.catalog.command(type).execute(decoded);
      // El acto se registra antes de sus hechos, pero solo después de ejecutar: un rechazo
      // del dominio no es un acto de juego y no debe contaminar el historial.
      this.history.command("PLAYER", type, decoded);
      this.notifier.notify(events);
    } catch (error: unknown) {
      if (error instanceof RuleViolationError) {
        this.log.warn("comando ilegal", { playerId, type, code: error.code });
        client.send("illegal", { code: error.code });
        return;
      }
      if (error instanceof ValidationError) {
        this.log.warn("payload malformado", { playerId, type, detail: error.detail });
        client.send("illegal", { code: "MALFORMED", detail: error.detail });
        return;
      }
      if (error instanceof UnknownCommandError) {
        this.log.warn("comando desconocido", { playerId, type });
        client.send("illegal", { code: "UNKNOWN_COMMAND" });
        return;
      }
      // Los handlers de mensajes son síncronos: Colyseus 0.18 no los envuelve, así que
      // propagar este error dejaría la sala viva con estado posiblemente inconsistente.
      this.crash(error, "onMessage");
    }
  }

  private startIfSeated(): void {
    if (this.seated.size < this.seats.length) return;
    this.seating?.clear();
    this.seating = undefined;
    this.startMatch();
  }

  private clientOf(playerId: PlayerId, except?: Client): Client | undefined {
    return this.clients.find((client) => client !== except && this.playerIdOf(client) === playerId);
  }

  private cancelPendingReconnection(playerId: PlayerId): void {
    this.pendingReconnections.get(playerId)?.reject(new Error("reconexión desplazada"));
  }

  private forgetPendingReconnection(playerId: PlayerId, pending: Deferred<Client>): void {
    if (this.pendingReconnections.get(playerId) === pending) {
      this.pendingReconnections.delete(playerId);
    }
  }

  private playerIdOf(client: Client): PlayerId | undefined {
    const data = client.userData as { playerId?: PlayerId } | undefined;
    return data?.playerId;
  }

  private player(playerId: PlayerId): MatchState["players"][number] {
    const player = this.state.players.find((candidate) => candidate.playerId === playerId);
    if (!player) throw new Error(`jugador sin estado: ${playerId}`);
    return player;
  }

  private abortReason(): AbortReason {
    if (this.state.startedAt === 0) return "NEVER_STARTED";
    if (this.state.players.every((player) => !player.hasSeenTiles)) return "NEVER_PLAYED";
    return "INTERRUPTED";
  }

  private crash(error: unknown, method: string): void {
    const cause = error instanceof Error ? error : new Error(String(error));
    this.log.error("error no controlado", { method, message: cause.message, stack: cause.stack });
    void this.disconnect(CloseCode.WITH_ERROR);
  }
}
