import { rootContainer } from "@/di-container";
import { InvalidTokenError, type TokenVerifier } from "@/features/auth";
import type { GameModeReader } from "@/features/game-mode";
import type { Logger } from "@/logger";
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
import {
  DEFAULT_GLOBAL_CONFIG,
  type DominoMatchConfig,
  type GlobalConfigSource,
  playerIdsOf,
} from "../../core/config";
import { RuleViolationError } from "../../core/engine/errors";
import type { SchemaVisibilityController } from "../../core/engine/visibility";
import type { PlayerId } from "../../core/ids";
import { wasAbortedAtDeal } from "../../core/rules";
import type { MatchState } from "../../core/state";
import { BotTurnTaker, MatchEventNotifier, type MatchHistory } from "../../network";
import type { AbortReason, NetworkMatchEvent } from "../../network/events";
import { type MatchAbortReason, MatchResultRecorder } from "../../network/match-results";
import {
  OrchestratorBetCharger,
  type OrchestratorCharges,
  OrchestratorUnavailableError,
} from "../../network/orchestrator-charges";
import { type SeatCredentials, UnknownGameModeError, configOf, requestOf } from "../match-contract";
import { HEARTBEAT_MS, MatchRegistry } from "../match-registry";
import {
  type MatchHasOutcome,
  type MatchSeatGuard,
  type MatchStarter,
  type MultiplierRevoker,
  type RematchCloser,
  buildCatalog,
  buildPieces,
  buildRouter,
  registerIndividualCommands,
} from "./commands/di-wiring";
import {
  PlayerAlreadyOutError,
  SeatNotReservedError,
  UnknownCommandError,
  ValidationError,
} from "./errors";
import type { MessageRouter } from "./messages";
import { RoomTimeoutScheduler } from "./timeout-scheduler";
import { StateViewVisibilityController } from "./visibility";

export class DominoRoom extends Room<{ state: MatchState; client: Client }> {
  private seats: readonly PlayerId[] = [];
  // EL SNAPSHOT DE LA MESA, y es lo que la puerta consulta: resolver la pareja autenticada
  // al asiento opaco necesita la identidad externa, que el estado no sincroniza y el
  // registro no guarda. Se asigna en `onCreate`, antes de que la sala pueda recibir a nadie.
  private config!: DominoMatchConfig;
  private closeRematch: RematchCloser = () => [];
  // EL MOTIVO QUE SOLO LA SALA SABE de por qué una mesa del orquestador se cerró sin veredicto: el
  // orquestador no pudo cobrar la entrada. Lo lee el resultado al publicarse.
  private orchestratorAbortReason: MatchAbortReason | undefined;
  // EL COBRO DE LA ENTRADA de una mesa del orquestador: se pide UNA vez, con la mesa completa, y la
  // partida arranca recién con el sí. `charged` es lo que deja que una reconexión posterior vuelva a
  // llamar a `startIfSeated` sin volver a cobrar.
  private entryCharge: "idle" | "charging" | "charged" = "idle";
  private disposed = false;
  // LA VENTANA DE RECONEXIÓN, en segundos porque esa es la unidad de `allowReconnection`.
  // El default reutiliza el global: si algún día `onDrop` corriera antes de que
  // `onCreate` termine de resolver la config, la ventana valdría cero y el que se cayó
  // perdería el asiento en el acto.
  private reconnectionWindowSeconds = DEFAULT_GLOBAL_CONFIG.reconnectionWindowSeconds;
  // LA TABLA DEL SOCKET, y no el catálogo de verbos: lo que la sala necesita saber es a
  // quién le toca cada `type` que entra, no cuáles son las jugadas del dominó.
  private router!: MessageRouter;
  private notifier!: MatchEventNotifier;
  private scheduler!: RoomTimeoutScheduler;
  private history!: MatchHistory;
  // EL RELOJ DE LA MÁQUINA. Existe siempre y no sólo en las mesas con bots: su `poke()` es una
  // consulta barata —¿el turno es de un asiento con la bandera puesta?— y hacerlo condicional
  // obligaría a preguntar por el modo en los tres lugares que lo empujan.
  private bots!: BotTurnTaker;
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
  // LA SALA NACIÓ: `onCreate` llegó al final. Desde `@colyseus/core` 0.18.14 un `onCreate` que
  // lanza igual corre `onDispose`, y el `notifier` puede existir sin que la mesa haya abierto
  // nunca. Sin esta bandera ese cierre emite `MATCH_ABORTED` de una mesa donde nadie se sentó.
  private opened = false;
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

  // `unknown` Y NO `CreateMatchRequest`: lo que llega acá viene del otro lado del cable, y
  // una firma tipada describe lo que se espera sin comprobar nada. La frontera real es
  // `requestOf`, que valida con zod y LANZA — así la sala no llega a existir con una mesa
  // cuyos datos no cierran.
  override async onCreate(options: unknown): Promise<void> {
    // EL LOG SE ARMA ANTES QUE NADA, y desde que el request se valida eso dejó de ser cosmético:
    // `onCreate` PUEDE lanzar, Colyseus enruta eso a `onUncaughtException` -> `crash()`, y
    // `crash()` escribe por `this.log`. Con el logger armado recién junto al estado —donde
    // estaba—, un snapshot inválido moría con «Cannot read properties of undefined (reading
    // 'error')» en vez de nombrar el campo que vino mal. MEDIDO, no deducido: es lo que imprimía
    // el test de opciones inválidas antes de mover estas dos líneas.
    //
    // LA TAREA 10 SUMÓ TRES LANZADORES MÁS en esta misma ventana —el modo que no existe, el modo
    // de cuatro y la cantidad que no coincide—, y los tres caen acá con el logger ya puesto. Es la
    // razón de que la resolución del catálogo vaya DESPUÉS de estas dos líneas y no antes.
    const rootLogger = rootContainer.resolve<Logger>("Logger");
    this.log = rootLogger.child({ roomId: this.roomId });

    // SE PREGUNTA UNA VEZ, y ese valor es de la mesa mientras viva: va a su container de abajo y de
    // ahí al motor, así que una edición que llegue a mitad de partida no le mueve los números a los
    // que están jugando.
    const global = rootContainer.resolve<GlobalConfigSource>("GlobalConfigSource")();
    this.reconnectionWindowSeconds = global.reconnectionWindowSeconds;

    // EL CATÁLOGO ES LA AUTORIDAD, Y SE CONSULTA UNA SOLA VEZ. El request nombra un modo; de acá
    // salen los puntos y el dinero de la mesa, y lo que queda en `config` es una COPIA. La sala no
    // vuelve a preguntar nunca más: editar un modo mientras hay una partida en curso no puede
    // cambiarle el premio a una mesa ya cobrada, y `replay` rebobina con lo grabado y sin base.
    //
    // `activeByUuid` y no `byUuid`: un modo dado de baja NO EXISTE desde afuera, y el panel lo da
    // de baja justamente para que deje de sentar mesas.
    const request = requestOf(options);
    const mode = await rootContainer
      .resolve<GameModeReader>("GameModeReader")
      .activeByUuid(request.gameModeId);
    if (!mode) throw new UnknownGameModeError(request.gameModeId);
    // Acá adentro se rechaza el modo que no es de 2 ni de 4 (`UNSUPPORTED_GAME_MODE`) y la cantidad
    // que no coincide, y las dos cosas pasan ANTES de la génesis: el árbol de la partida nace unas
    // líneas más abajo, en el `child.resolve("MatchState")`.
    //
    // LOS NIVELES DE AUMENTO LOS TRAE EL REQUEST: el que cobra el aumento es el orquestador, y es él
    // quien decide cuáles se ofrecen. Sin `betLevels` la mesa no ofrece aumentar.
    const config = configOf(request, mode, request.betLevels ?? []);
    this.config = config;
    this.seats = playerIdsOf(config);
    // SIN `maxClients`, A PROPÓSITO (portado de truco `b90840b`). La puerta es el chequeo del asiento
    // en `onJoin`; un tope solo agrega un candado que Colyseus aplica ANTES de cualquier hook
    // (`MatchMaker.mjs:157`). Con `asientos × 2`, las reservas sin consumir —cada vuelta que pide el
    // orquestador, cada token de reconexión— contaban contra el cupo y llegaban a bloquear la mesa:
    // el dueño de un asiento cuyo socket muerto el servidor todavía no notó (6-9 s de ping) rebotaba
    // con su propia partida en curso. Sin tope la sala nunca se bloquea, y con eso se fueron el
    // `lock()` de `onReconnect` y el `unlock()` de `onDrop`, que era la deuda que nadie medía.

    const child = rootContainer.createChildContainer();
    child.register("Config", { useValue: config });
    // LA CONFIG GLOBAL SE FOTOGRAFÍA ACÁ, y registrarla es lo que lo vuelve cierto para la partida
    // entera: el cableado la resuelve de este container, y sin esta línea caería al root, que es la
    // BASE sin las ediciones en caliente —o sea que el motor se armaría con otros números que los
    // que esta sala leyó arriba—.
    child.register("GlobalDominoConfig", { useValue: global });

    // La vista es del asiento, no del socket: existe antes de que el dueño se conecte y
    // conserva las revelaciones privadas si el socket se reemplaza o se reconecta.
    for (const playerId of this.seats) this.views.set(playerId, new StateView());
    child.register<SchemaVisibilityController>("SchemaVisibilityController", {
      useValue: new StateViewVisibilityController(this.views),
    });

    this.scheduler = new RoomTimeoutScheduler(
      this.clock,
      (events: readonly NetworkMatchEvent[]) => {
        this.notifier.notify(events);
        // EL OTRO EMPUJE, y es el que de verdad importa: el turno vencido es por donde se SIENTA la
        // máquina, así que sin esto el bot recién nacido espera a que alguien mande un mensaje para
        // jugar su primer turno — y en una mesa donde el resto está esperando su jugada, no llega
        // ninguno. La partida se quedaría quieta hasta el siguiente vencimiento.
        this.bots?.poke();
      },
    );
    // El scheduler tiene que estar registrado antes de armar los actores: el conductor
    // del motor recibe solo el puerto y nunca debe conocer la sala.
    child.register("TimeoutScheduler", { useValue: this.scheduler });
    // El árbol nace acá adentro: la génesis es del motor, no de la sala. `MatchState`
    // queda registrado por el wiring y la sala lo recibe ya armado.
    registerIndividualCommands(child);
    const match = child.resolve<MatchState>("MatchState");
    const catalog = buildCatalog(child);

    const pieces = buildPieces(child, (events: readonly NetworkMatchEvent[]) =>
      this.notifier.notify(events),
    );
    this.history = pieces.history;
    // LA REVANCHA: la sala solo la cierra cuando alguien se va (`onLeave`). La compuerta nadie la
    // abre, así que la ventana sale siempre con `eligible: false` (ver `configOf`).
    this.closeRematch = child.resolve<RematchCloser>("RematchCloser");
    const revokeMultiplier = child.resolve<MultiplierRevoker>("MultiplierRevoker");
    // LOS DOS SINKS DE LA PLATA, y ninguno la mueve: el aumento se le pide cobrar al ORQUESTADOR y
    // el resultado se le PUBLICA. Dominó dice qué pasó y pide que se cobre; un juego nunca mueve
    // dinero.
    const orchestratorSinks = [
      rootContainer
        .resolve(MatchResultRecorder)
        .sinkFor(config, match, this.roomId, () => this.orchestratorAbortReason),
      ...(rootContainer.isRegistered(OrchestratorBetCharger)
        ? [
            rootContainer.resolve(OrchestratorBetCharger).sinkFor(
              config.matchId,
              (events) => this.notifier.notify(events),
              () => revokeMultiplier(),
            ),
          ]
        : []),
    ];
    this.notifier = new MatchEventNotifier(
      pieces.listeners,
      (events) => this.broadcast("events", events),
      [
        ...pieces.sinks,
        ...orchestratorSinks,
        // EL VEREDICTO QUE ENCUENTRA A ALGUIEN AUSENTE cierra la revancha: se cayó antes y no
        // volvió, así que con quién jugar otra ya no está. Antes del veredicto la caída sólo se
        // recordaba (`connected`); acá deja de ser un bache y pasa a ser una salida.
        (events) => {
          if (events.some((event) => event.type === "MATCH_RESOLVED") && this.someoneAway())
            this.notifier.notify(this.closeRematch());
        },
        // EL LATIDO POR HECHO, portado de truco, y va ÚLTIMO: los demás sinks ya vieron el hecho y
        // el árbol ya está mutado. Quién sigue jugando cambia con la partida —un retiro, un
        // veredicto— y el que quedó afuera tiene que poder sentarse en otra mesa YA, no al
        // próximo latido del reloj.
        () => this.beat(),
      ],
    );
    // DESPUÉS del historial y del notificador, que es lo que cada verbo necesita para
    // atenderse. El catálogo ya no vive en la sala: entra acá, se convierte en rutas y lo
    // que queda es la tabla.
    this.router = buildRouter(catalog, this.history, (events) => this.notifier.notify(events));
    // ⚠ EL BOT NO ENTRA POR EL ROUTER, y no es un atajo: el router es la frontera del CABLE, y su
    // handler graba la fuente `"PLAYER"` por construcción —que es la mitad del valor de tenerlo—.
    // Una jugada de la máquina es un acto del SISTEMA, y el historial que alguien va a auditar es
    // justamente el de una partida que alguien abandonó.
    this.bots = new BotTurnTaker(
      match,
      config,
      (playerId, move) => {
        // ⚠ LOS CAMPOS SE COPIAN A MANO Y NO CON SPREAD, y acá se paga la misma trampa que
        // `log-sink.ts` ya documenta: **esparcir un nodo del schema devuelve un objeto VACÍO**.
        // La ficha que la política elige sale del árbol VIVO —`SchemaMatchView` no copia nada— así
        // que `{ ...move.tile }` deja `left`/`right` en `undefined` y el comando responde
        // `TILE_NOT_IN_HAND` sobre una ficha que el bot tiene en la mano. Y el modo de falla es
        // cruel: `JSON.stringify` del mismo nodo SÍ imprime los números —`toJSON` funciona— así
        // que el log muestra la ficha correcta mientras el payload va vacío.
        const payload =
          move.type === "PLAY_TILE"
            ? { playerId, left: move.tile.left, right: move.tile.right, side: move.side }
            : { playerId };
        const events = catalog.command(move.type).execute(payload as never);
        this.history.command("SYSTEM", move.type, payload);
        this.notifier.notify(events);
      },
      // ⚠ NUNCA MÁS DE MEDIO TURNO, y no es una optimización: con el plazo de reflexión más largo
      // que el turno, la máquina PIENSA HASTA QUE SE LE VENCE Y LA RETIRAN — el reloj llega antes
      // que su jugada, y como a un bot ya no se lo reemplaza por otro, ahí sí abandona. La mesa
      // se comporta como si los bots no existieran y no falla nada. Lo destapó la suite, que
      // corre con turnos de 600 ms contra los 1500 de v1; en producción el mínimo es el de v1 y
      // esta línea no cambia nada.
      Math.min(global.botTurnDelayMs, Math.floor(global.turnTimeoutMs / 2)),
      (error) => this.log.warn("la máquina no pudo jugar", { error: String(error) }),
    );
    this.hasOutcome = child.resolve<MatchHasOutcome>("MatchHasOutcome");
    this.isStillPlaying = child.resolve<MatchSeatGuard>("MatchSeatGuard");
    this.startMatch = child.resolve<MatchStarter>("MatchStarter");

    // Y ACÁ SE ENRIQUECE, ya con la partida parseada: el de arriba solo sabía el `roomId`,
    // que es todo lo que existe antes de que el snapshot valide.
    this.log = rootLogger.child({
      matchId: config.matchId,
      roomId: this.roomId,
      gameModeId: config.gameModeId,
    });
    this.setState(match);
    // El modo queda en el listing compartido de Colyseus (lo muestra el monitor). La metadata lleva
    // solo el identificador público; perfil, moneda, tasa y seed no salen.
    await this.setMetadata({ gameModeId: config.gameModeId });

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
    // Y ADEMÁS HAY UN LATIDO POR HECHO (el último sink del notificador), como en truco: este
    // reloj renueva, aquél suelta en el acto al que dejó de jugar.
    this.heartbeat = this.clock.setInterval(() => this.beat(), HEARTBEAT_MS);

    this.seating = this.clock.setTimeout(() => {
      this.log.warn("plazo de ocupación vencido", { clients: this.clients.length });
      this.disconnect();
    }, global.seatingTimeoutMs);
    this.onMessage("*", (client, type, payload) =>
      this.handleMessage(client, String(type), payload),
    );
    this.opened = true;
    this.log.info("sala creada");
  }

  override async onAuth(
    _client: Client,
    _options: unknown,
    context: AuthContext,
  ): Promise<SeatCredentials> {
    const token = context.token ?? undefined;
    const identity = await rootContainer.resolve<TokenVerifier>("TokenVerifier").verify(token);
    return { ...identity, token: token ?? "" };
  }

  override async onJoin(client: Client): Promise<void> {
    // ACÁ SE CRUZA LA IDENTIDAD EXTERNA CON EL ASIENTO OPACO, y es el único lugar donde
    // pasa. De estas cuatro líneas para abajo nadie vuelve a ver una plataforma ni un
    // UUID: el motor, el historial y el wire hablan de `seat-N`.
    const identity = client.auth as SeatCredentials;
    const playerId = this.config.seats.find((seat) => seat.userId === identity.userId)?.playerId;
    // Primero pertenece a la mesa; recién después se pregunta si sigue jugando. Invertir
    // el orden filtra el estado de una partida a un principal sin asiento reservado.
    // LA ÚNICA EXCEPCIÓN DELIBERADA a "la identidad externa no sale del cruce": este error
    // termina en el log de `onUncaughtException` con la pareja adentro. Se cruza con motivo —el
    // rechazo hay que poder investigarlo, y "alguien sin asiento" no se investiga—, y el que se
    // registra es SIEMPRE el rechazado, nunca un jugador sentado. `seat-N` no serviría acá:
    // justamente no tiene asiento, así que no hay id opaco que nombrarlo.
    if (!playerId) {
      throw new SeatNotReservedError(identity.userId);
    }
    if (!this.isStillPlaying(playerId)) throw new PlayerAlreadyOutError(playerId);
    this.cancelPendingReconnection(playerId);

    client.userData = { playerId };
    client.view = this.views.get(playerId);
    this.player(playerId).connected = true;
    // UNA CONEXIÓN POR ASIENTO, Y GANA LA ÚLTIMA. La anterior puede ser otro dispositivo o un socket
    // que murió sin que el servidor lo notara todavía: el servidor no los distingue, y el que acaba
    // de probar quién es, es el que vale la pena conservar. Registrar primero la identidad de esta
    // conexión hace que `onLeave` del socket desplazado ya la vea y no marque al jugador offline.
    // CONSENTED para que el cliente desplazado no intente volver y desplazar a éste.
    //
    // ⚠ TODAS las anteriores y no la primera: un desplazado tarda un viaje en irse, así que con
    // dos vueltas seguidas la primera sigue en `this.clients` y un `find` la volvía a elegir —la del
    // medio no se iba nunca y el asiento quedaba con tres conexiones—. Lo midió el e2e de las vueltas
    // sin consumir.
    const previous = this.clients.filter(
      (other) => other !== client && this.playerIdOf(other) === playerId,
    );
    for (const other of previous) other.leave(CloseCode.CONSENTED);

    // EL REGRESO SE ANUNCIA SOLO SI LA CAÍDA SE ANUNCIÓ: un desplazamiento no anuncia ninguna de las
    // dos, así que para el rival el jugador nunca se fue.
    const isBack = this.seated.has(playerId) && previous.length === 0;
    this.seated.add(playerId);
    if (isBack) this.notifier.notify([{ type: "PLAYER_RECONNECTED", playerId }]);
    this.log.info("jugador conectado", {
      playerId,
      reconnecting: isBack,
      displaced: previous.length,
    });
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
    this.player(playerId).connected = false;
    this.log.info("jugador desconectado", { playerId });
    // DESDE EL VEREDICTO, IRSE ES IRSE, y una recarga no es excepción (truco `0960663`): antes del
    // veredicto la caída sólo se recuerda —todavía puede volver a jugar—, después ya no hay partida
    // a la que volver y la revancha se cierra igual que con una salida.
    if (this.hasOutcome()) this.notifier.notify(this.closeRematch());
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
    this.notifier.notify([{ type: "PLAYER_RECONNECTED", playerId }]);
    this.log.info("jugador reconectado", { playerId });
  }

  override onLeave(client: Client): void {
    const playerId = this.playerIdOf(client);
    if (!playerId || this.clientOf(playerId)) return;
    this.player(playerId).connected = false;
    // LA REVANCHA SE CIERRA CUANDO ALGUIEN SE VA, y es lo único que la sala le dice al motor
    // sobre la revancha. Una desconexión es un hecho de PLATAFORMA y el juego no los mira; acá
    // importa por una razón chica y concreta: sin esto, el que ofreció se queda mirando una
    // cuenta atrás que ya no puede terminar en nada.
    //
    // Es inofensivo fuera de las fases de revancha —el conductor lo ignora— y también durante
    // el TRASPASO, que es justamente cuando los dos clientes se van a propósito a consumir su
    // reserva. Cerrar ahí les sacaría la revancha que ya tienen.
    this.notifier.notify([{ type: "PLAYER_DISCONNECTED", playerId }, ...this.closeRematch()]);
    this.log.info("jugador salió", { playerId });
  }

  override async onDispose(): Promise<void> {
    this.disposed = true;
    // PRIMERO SE CORTA EL LATIDO: lo que sigue es limpieza, y un latido posterior volvería a
    // escribir justo lo que estamos por borrar — dejando la sala anunciada dos minutos más.
    this.heartbeat?.clear();
    if (this.opened && !this.hasOutcome()) {
      // Con revancha habrá fases posteriores al veredicto: la guarda futura debe mirar el
      // veredicto del juez, no la fase terminal, para no reembolsar una partida ya pagada.
      this.notifier.notify([{ type: "MATCH_ABORTED", reason: this.abortReason() }]);
      this.log.warn("partida abortada");
    }
    this.scheduler?.cancel();
    this.bots?.cancel();
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
    // Un hecho emitido durante el cierre —el `MATCH_ABORTED` de `onDispose`— no puede volver a
    // anunciar la sala que se está por borrar; y uno emitido antes de anotarla no tiene registro.
    if (this.disposed || !this.matches) return;
    const active = this.activeSeats();
    this.beats = this.beats
      .then(() => this.matches.keepAlive(this.roomId, active))
      .catch((error: unknown) =>
        this.log.error("no se pudo mantener el registro de la partida", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }

  // LOS userId QUE ESTA MESA TODAVÍA RETIENE, para que el registro suelte al resto. Portado de
  // truco, con dos diferencias del dominó:
  //
  //   · SE SUELTA AL TENER VEREDICTO, no en `FINISHED`. Truco espera a `FINISHED`, que llega
  //     después de la revancha; acá una mesa sin revancha posible —todas las del orquestador
  //     (`eligible: false`)— pasaría treinta segundos de ventana mandando al jugador de vuelta a
  //     una partida terminada. Solo una ventana ELEGIBLE retiene los asientos, porque ahí la
  //     revancha todavía puede salir. Aceptada ya no: la mesa nueva anotó a los dos, y un latido
  //     de ésta los pisaría.
  //   · EL REEMPLAZADO POR UN BOT TAMBIÉN SE SUELTA. El asiento sigue jugando —lo juega la
  //     máquina— pero la persona se fue, y `hasAbandoned` no lo dice a propósito.
  //
  // Y LA ANULADA EN EL REPARTO SUELTA A TODOS, aunque no tenga veredicto: no hay revancha ni partida
  // que volver a jugar, y el que se quedó no está retirado, así que sin esta línea la mesa lo retenía
  // hasta disponerse y el orquestador no podía abrirle otra.
  private activeSeats(): readonly string[] {
    const phase = this.state.phase;
    if (wasAbortedAtDeal(this.state)) return [];
    if (this.hasOutcome()) {
      const rematchOpen =
        (phase === "REMATCH_WINDOW" || phase === "REMATCH_NEGOTIATION") &&
        this.state.rematch?.eligible === true;
      if (!rematchOpen) return [];
    }
    return this.config.seats
      .filter(({ playerId }) => this.isStillPlaying(playerId) && !this.player(playerId).isBot)
      .map(({ userId }) => userId);
  }

  // Un asiento que sigue jugando, de carne y hueso, sin conexión. La máquina no tiene socket.
  private someoneAway(): boolean {
    return this.seats.some(
      (playerId) =>
        this.isStillPlaying(playerId) &&
        !this.player(playerId).isBot &&
        !this.player(playerId).connected,
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

  // DE DÓNDE VINO Y A QUIÉN CONTESTARLE. La frontera y qué significa atender un mensaje son
  // del router y de su handler (`./messages.ts`); acá queda lo que de verdad es de la sala.
  //
  // Antes esto tenía los cinco pasos desplegados —frontera, decodificar, ejecutar, grabar,
  // difundir— y por eso "mensaje del cliente" y "verbo del dominó" eran indistinguibles: el
  // `type` ERA un `CommandName`. Ahora los verbos son entradas de una tabla que admite otras.
  private handleMessage(client: Client, type: string, payload: unknown): void {
    const playerId = this.playerIdOf(client);
    if (!playerId) return;
    try {
      const pending = this.router.route(type, payload, playerId);
      // Un handler puede ser asíncrono (`MessageHandler`) y una promesa rechazada NO la
      // atrapa el `catch` de abajo: sin esto se escaparía como `unhandledRejection` y se
      // llevaría el proceso entero, con todas las demás partidas adentro. Los dos caminos
      // desembocan en el mismo manejo.
      //
      // Los verbos del dominó no pasan por acá: son síncronos por contrato, así que `route`
      // devuelve `undefined` y para ellos esta línea no existe.
      if (pending)
        void pending.catch((e: unknown) => this.rejectMessage(e, client, type, playerId));
    } catch (error: unknown) {
      this.rejectMessage(error, client, type, playerId);
    }
    // DESPUÉS DE CADA MENSAJE se mira si la mesa quedó esperando a una máquina, y también cuando
    // el mensaje fue rechazado: el turno pudo haber pasado igual por el camino del error.
    this.bots.poke();
  }

  // QUÉ SE LE CONTESTA AL CLIENTE cuando su mensaje no prosperó. Es un método y no el `catch`
  // de arriba porque los mensajes asíncronos fallan por otro camino y tienen que caer
  // exactamente acá: dos políticas de error para la misma puerta es cómo se consiguen dos
  // comportamientos distintos para el mismo rechazo.
  private rejectMessage(error: unknown, client: Client, type: string, playerId: PlayerId): void {
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

  private startIfSeated(): void {
    if (this.seated.size < this.seats.length) return;
    this.seating?.clear();
    this.seating = undefined;
    if (this.entryCharge === "charged") {
      this.startMatch();
      return;
    }
    if (this.entryCharge === "charging") return;
    this.entryCharge = "charging";
    void this.chargeEntry();
  }

  // LA MESA DEL ORQUESTADOR ARRANCA SOLO SI EL ORQUESTADOR COBRÓ LA ENTRADA A TODOS. Dominó no mueve
  // dinero: pide el cobro y espera. Un rechazo, un orquestador caído o un silencio cierran la mesa
  // sin arrancar —"no sé si pagaron" no es "pagaron"— y el resultado sale como abortado con motivo
  // `CHARGE_REJECTED`; el orquestador devuelve lo que haya llegado a cobrar.
  //
  // El puerto se resuelve AL COBRAR y no al nacer la sala: es del proceso, y la suite lo reemplaza.
  private async chargeEntry(): Promise<void> {
    try {
      if (!rootContainer.isRegistered("OrchestratorCharges")) {
        throw new OrchestratorUnavailableError("esta instancia no tiene orquestador configurado");
      }
      await rootContainer
        .resolve<OrchestratorCharges>("OrchestratorCharges")
        .chargeEntry(this.config.matchId);
    } catch (error: unknown) {
      this.log.warn("el orquestador no cobró la entrada; la mesa no arranca", {
        error: String(error),
      });
      this.orchestratorAbortReason = "CHARGE_REJECTED";
      if (!this.disposed) {
        for (const client of this.clients)
          client.send("matchCancelled", { reason: "CHARGE_REJECTED" });
        void this.disconnect().catch(() => undefined);
      }
      return;
    }
    this.entryCharge = "charged";
    // SI TODOS SE FUERON MIENTRAS SE COBRABA, la sala ya se dispuso y salió como abortada: el
    // orquestador reembolsa por su ficha. Arrancar el motor de una sala muerta dejaría plazos
    // corriendo sin dueño.
    if (this.disposed) return;
    this.startMatch();
  }

  private clientOf(playerId: PlayerId, except?: Client): Client | undefined {
    return this.clients.find((client) => client !== except && this.playerIdOf(client) === playerId);
  }

  // `?.` TAMBIÉN EN `reject`: con la sala disponiéndose, `allowReconnection` no devuelve un
  // `Deferred` sino una `Promise` ya rechazada (`Room.mjs:1189`), y la segunda conexión del mismo
  // asiento que cae en el apagado reventaba acá con «reject is not a function».
  private cancelPendingReconnection(playerId: PlayerId): void {
    this.pendingReconnections.get(playerId)?.reject?.(new Error("reconexión desplazada"));
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
    // Antes que NEVER_PLAYED: que nadie haya levantado no lo distingue de que alguien se haya
    // ido con la ventana abierta, y sólo lo segundo deja a alguien sin reembolso.
    if (wasAbortedAtDeal(this.state)) return "TILES_NOT_SEEN";
    if (this.state.players.every((player) => !player.hasSeenTiles)) return "NEVER_PLAYED";
    return "INTERRUPTED";
  }

  // `method` se tipa contra la unión de Colyseus y no contra `string` porque abajo DECIDE: la
  // comparación con `"onCreate"` elige si se desconecta o no. Ensanchada, un `"oncreate"` o un
  // rename de la unión compilarían igual y apagarían esa guarda sin que nada se ponga rojo.
  private crash(error: unknown, method: RoomMethodName): void {
    const cause = error instanceof Error ? error : new Error(String(error));
    this.log.error("error no controlado", { method, message: cause.message, stack: cause.stack });
    // NO SE DESCONECTA LO QUE TODAVÍA NO EXISTE. Colyseus RECHAZA `disconnect()` durante
    // `onCreate` —lanza «cannot disconnect during onCreate()», `@colyseus/core/build/Room.mjs:1012`—
    // y tiene razón: no hay sala ni clientes, y el matchmaker ya la descarta al propagar el
    // error (`MatchMaker.mjs:296-306`). Sin esta guarda el manejador de errores lanza ADENTRO del
    // manejador de errores, y esa segunda excepción tapa la causa real que se acaba de loguear.
    //
    // Es alcanzable desde que `configOf` valida: un snapshot con la tasa o los montos mal
    // formados entra por acá. Medido con el test de opciones inválidas.
    if (method === "onCreate") return;
    void this.disconnect(CloseCode.WITH_ERROR);
  }
}
