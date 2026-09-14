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
import { DEFAULT_GLOBAL_CONFIG, type GlobalDominoConfig } from "../../core/config.js";
import { RuleViolationError } from "../../core/engine/errors.js";
import type { SchemaVisibilityController } from "../../core/engine/visibility.js";
import type { PlayerId } from "../../core/ids.js";
import type { MatchState } from "../../core/state/index.js";
import type { AbortReason, NetworkMatchEvent } from "../../network/events.js";
import { MatchEventNotifier, type MatchHistory } from "../../network/index.js";
import { type DominoRoomOptions, type SeatCredentials, configOf } from "../match-contract.js";
import { HEARTBEAT_MS, MatchRegistry } from "../match-registry.js";
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

export class DominoRoom extends Room<{ state: MatchState; client: Client }> {
  private seats: readonly PlayerId[] = [];
  // LA VENTANA DE RECONEXIÓN, en segundos porque esa es la unidad de `allowReconnection`.
  // El default reutiliza el global: si algún día `onDrop` corriera antes de que
  // `onCreate` termine de resolver la config, la ventana valdría cero y el que se cayó
  // perdería el asiento en el acto.
  private reconnectionWindowSeconds = DEFAULT_GLOBAL_CONFIG.reconnectionWindowSeconds;
  private catalog!: CommandCatalog;
  private notifier!: MatchEventNotifier;
  private scheduler!: RoomTimeoutScheduler;
  private history!: MatchHistory;
  private hasOutcome!: MatchHasOutcome;
  private isStillPlaying!: MatchSeatGuard;
  private startMatch!: MatchStarter;
  private log!: Logger;
  private seating?: Delayed;
  // LAS PARTIDAS VIVAS DEL CLÚSTER. Se resuelve UNA vez y se guarda: la sala se anota al nacer,
  // late mientras vive y se borra al morir, y en el medio nadie más la toca. Resolverlo tres
  // veces del root era barato pero dejaba el `onDispose` dependiendo de que el container siga en
  // pie mientras el proceso se apaga.
  private matches!: MatchRegistry;
  private heartbeat?: Delayed;
  // LOS LATIDOS, EN FILA. Escribir el registro es ir a la red, así que dos latidos que se pisan
  // pueden dejar sus escrituras intercaladas y el último en llegar no es el último que salió. La
  // cadena los ordena, y de paso le da al apagado algo que esperar: lo que se esté escribiendo
  // tiene que terminar ANTES de la limpieza, o la limpieza no limpia nada.
  private beats: Promise<void> = Promise.resolve();
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

  override async onCreate(options: DominoRoomOptions): Promise<void> {
    const global = rootContainer.resolve<GlobalDominoConfig>("GlobalDominoConfig");
    this.reconnectionWindowSeconds = global.reconnectionWindowSeconds;
    this.seats = options.seats;
    // Colyseus cuenta las reservas de reconexión aunque unlock() abra el listing. Dos
    // cupos por asiento permiten conservar el token viejo mientras entra un reemplazo,
    // sin abrir capacidad ilimitada: onJoin sigue siendo la puerta de los asientos reales.
    this.maxClients = this.seats.length * 2;

    const config = configOf(options);
    const child = rootContainer.createChildContainer();
    child.register("Config", { useValue: config });

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
    // El árbol nace acá adentro: la génesis es del motor, no de la sala. `MatchState`
    // queda registrado por el wiring y la sala lo recibe ya armado.
    registerIndividualCommands(child);
    const match = child.resolve<MatchState>("MatchState");
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

    // SE ANOTA ENTRE LAS PARTIDAS VIVAS DEL CLÚSTER, y SE ESPERA. A partir de que `onCreate`
    // devuelve, la sala ya puede recibir gente y su `roomId` ya circula en la reserva de asiento:
    // un `GET /config/:roomId` que llegue antes de que la clave esté escrita —y que caiga en otro
    // proceso, que es todo el punto de esto— responde 404 por una sala que existe.
    this.matches = rootContainer.resolve(MatchRegistry);
    await this.matches.register(this.roomId, config);

    // EL LATIDO que renueva ese plazo. Va POR EL RELOJ DE LA SALA —el mismo que vence los
    // turnos— y no colgado de los hechos del juego, porque tiene que darse aunque no pase nada:
    // una mesa esperando a que levanten las fichas no produce un solo evento durante todo el
    // `dealingTimeoutMs`, y sus asientos siguen ocupados igual.
    //
    // Y NO HAY, ADEMÁS, UN LATIDO POR HECHO como el de truco. Allá cada evento es una oportunidad
    // de SOLTAR al que el motor retiró, porque su registro guarda quién sigue jugando; acá lo
    // anotado son los ASIENTOS DE LA MESA, que salen del config y no cambian en toda la partida.
    // Un latido por hecho escribiría exactamente lo mismo que el anterior.
    this.heartbeat = this.clock.setInterval(() => this.beat(), HEARTBEAT_MS);

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
    const pending = this.allowReconnection(client, this.reconnectionWindowSeconds);
    this.pendingReconnections.set(playerId, pending);
    void pending.then(
      () => this.forgetPendingReconnection(playerId, pending),
      () => this.forgetPendingReconnection(playerId, pending),
    );
    // ESTA LÍNEA NO TIENE EFECTO OBSERVABLE HOY, y no hay test que la ejerza. Se deja, con
    // la condición escrita, porque el día que alguien toque `maxClients` vuelve a hacer falta.
    //
    // `unlock()` deshace un lock, y con el `maxClients = seats.length * 2` de `onCreate` la
    // sala NUNCA se lockea: `hasReachedMaxClients()` suma `clients + reservedSeats`
    // (@colyseus/core Room.mjs:434), y en una mesa de 2 con 4 cupos el máximo alcanzable
    // tras una caída es 1 + 1 = 2. Medido: `locked` vale `false` antes y después del drop.
    //
    // CUÁNDO VOLVERÍA A IMPORTAR — con `maxClients = seats.length`, la sala se auto-lockea
    // al ocuparse el último asiento, y `joinById` muere en `room.locked` (MatchMaker.mjs:157)
    // ANTES de mirar la reserva. El auto-unlock del core no salva: cuelga de
    // `#_decrementClientCount`, que con una reconexión pendiente queda encadenado al rechazo
    // de esa promesa (Room.mjs:1461-1463), o sea recién cuando la ventana vence. Durante toda
    // la ventana, sin este `unlock()`, el dueño del asiento rebota con "room is locked".
    //
    // Y es el único que puede limpiar el lock EXPLÍCITO de `onReconnect` más abajo: el
    // automático se abstiene si `_lockedExplicitly` está puesto (Room.mjs:1495).
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

  override async onDispose(): Promise<void> {
    // PRIMERO SE CORTA EL LATIDO: lo que sigue es limpieza, y un latido posterior volvería a
    // escribir justo lo que estamos por borrar — dejando la sala anunciada dos minutos más.
    this.heartbeat?.clear();
    if (this.notifier && !this.hasOutcome()) {
      // Con revancha habrá fases posteriores al veredicto: la guarda futura debe mirar el
      // veredicto del juez, no la fase terminal, para no reembolsar una partida ya pagada.
      this.notifier.notify([{ type: "MATCH_ABORTED", reason: this.abortReason() }]);
      this.log.warn("partida abortada");
    }
    this.scheduler?.cancel();
    this.seating?.clear();
    for (const view of this.views.values()) view.dispose();
    // Se esperan los latidos EN VUELO y recién después se borra: un latido que llegue tarde al
    // almacén volvería a anunciar la sala después del borrado. Colyseus espera lo que este hook
    // devuelve (`@colyseus/core/build/Room.mjs:1383`), así que el apagado de la sala espera esto.
    await this.beats;
    // `?.` por el mismo motivo que el `scheduler` de arriba: si `onCreate` se cayó antes de
    // resolverlo, esta sala nunca se anotó y no hay nada que borrar.
    await this.matches?.remove(this.roomId);
  }

  // UN LATIDO. No se espera —la partida no depende de él— pero sí se ENCOLA, y un fallo se
  // registra y no tumba nada: si el almacén se cae, lo que se pierde es que esta mesa figure en
  // el clúster durante dos minutos, no la partida que se está jugando adentro.
  private beat(): void {
    this.beats = this.beats
      .then(() => this.matches.keepAlive(this.roomId))
      .catch((error: unknown) =>
        this.log.error("no se pudo mantener el registro de la partida", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
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
