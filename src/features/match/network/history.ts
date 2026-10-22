// El registro para el operador de soporte, para el panel y para el replay. NO es event sourcing:
// la fuente de verdad del estado es el árbol Schema; esto es un registro paralelo.
//
// UN DOCUMENTO POR PARTIDA, con la forma v2.1 de truco (`bed0d33`), escrito en cuatro momentos:
//
//   open    al arrancar: cómo se armó — la mesa, la config, los asientos, el seed
//   record  cada acto y cada hecho, en orden, en la TIMELINE
//   round   cada mano al cerrarse, leída del árbol antes del próximo reparto
//   close   cómo terminó: veredicto, plata, quién se fue y cuándo
//
// La timeline es para el que tiene que rebobinar la partida; lo demás es lo que se puede consultar
// sin rebobinarla.
//
// Se graban las DOS cosas —el ACTO y el HECHO— intercaladas en el orden en que
// pasaron, porque por el criterio de MatchEvent la mayoría de los verbos no emite
// nada: un historial de solo eventos tendría los desenlaces y ninguna jugada.
import type { CommandPayloads } from "../core/command";
import type { BetLevel, TeamAssignmentMode } from "../core/config";
import type { Clock } from "../core/engine/clock";
import type { PlayerId, TeamId } from "../core/ids";
import { handValue } from "../core/rules/tiles";
import type { MatchState } from "../core/state";
import type { AbortReason, NetworkMatchEvent } from "./events";

// EL VOCABULARIO DEL HISTORIAL ES CERRADO, y eso es el punto entero de la corrección
// del v1. Ahí una entrada era un tipo único discriminado por dos booleanos
// (`isPassed`/`isLoaded`), así que `isPassed && isLoaded` typechequeaba y no significaba
// nada. Acá el discriminante es `type`, y su dominio es la unión de los verbos del
// catálogo con los tipos de evento — no `string`.
//
// Si esto fuera `string`, un `type: "LOAD_TILE"` (el nombre del v1) se grabaría sin que
// nada chille, y el replay lo descubriría en runtime rebobinando una partida real.
//
// UNA ENTRADA NO ES NI ACTO NI HECHO DEL JUEGO: `TILES_DEALT`, las manos y el pozo tal como se
// repartieron (truco `b5bb427`). Se graba justo detrás de `ROUND_STARTED`, leída del árbol en ese
// mismo instante, así que todavía nadie jugó ni robó. NO es un evento a propósito: los eventos se
// difunden a la mesa, y éste le daría a cada jugador las fichas de todos. Para soporte es lo que
// el replay no puede dar cuando la partida se jugó con un reparto preparado (`deal`).
export type HistoryEntryType = keyof CommandPayloads | NetworkMatchEvent["type"] | "TILES_DEALT";

/** El payload de una entrada `TILES_DEALT`. Sin `boneyard` en las mesas que no tienen pozo (4P). */
export interface DealtTiles {
  readonly hands: readonly {
    readonly playerId: string;
    readonly tiles: readonly { readonly left: number; readonly right: number }[];
  }[];
  readonly boneyard?: readonly { readonly left: number; readonly right: number }[];
}

export interface HistoryEntry {
  // SE QUEDA, aunque truco lo sacó de la timeline (`e4e630c`) porque el documento ya lo dice. Acá es
  // parte de un contrato que el documento no ve: los goldens del replay y la respuesta del endpoint
  // de soporte llevan cada entrada con su partida, y sacarlo sería regenerar fixtures para ahorrar
  // unos bytes por entrada.
  readonly matchId: string;
  /** Monótono POR PARTIDA. Es el orden, y es lo único que ordena actos y hechos entre sí. */
  readonly seq: number;
  readonly at: number;
  /** La mano en que pasó; 0 antes del primer reparto. */
  readonly roundNumber: number;
  readonly source: "PLAYER" | "SYSTEM";
  readonly kind: "COMMAND" | "EVENT";
  readonly type: HistoryEntryType;
  readonly payload: Record<string, unknown>;
}

// ── EL DOCUMENTO ──────────────────────────────────────────────────────────────────────────────
//
// LA VERSIÓN ES LA DE TRUCO PARA ESTA FORMA, y ahora sí discrimina algo. Antes el documento no la
// llevaba porque había una sola forma y un solo escritor; desde acá hay dos —la vieja
// `{ matchId, entries, createdAt, updatedAt }` y ésta— y el que lee tiene que poder distinguirlas sin
// adivinar por la presencia de un campo. Los dos juegos guardan la misma forma, así que el número es
// el mismo en los dos.
export const MATCH_RECORD_VERSION = 2.1;

/** Un asiento como queda en el registro: el id opaco, su equipo, su lugar y la identidad que la mesa congeló. */
export interface SeatSetup {
  readonly id: PlayerId;
  readonly teamId: TeamId;
  /** La posición en la mesa, desde 0. Con `SHUFFLED` el equipo NO sale de acá: sale del seed. */
  readonly seat: number;
  readonly userId: string;
  readonly displayName: string;
  readonly username?: string;
  /** La moneda YA COBRADA, congelada en el snapshot (`MatchSeat.currency`). */
  readonly currency: string;
}

/**
 * CÓMO SE ARMÓ LA PARTIDA, sabido antes de que arranque y nunca cambiado después. Se copia al registro
 * porque el catálogo y la config en caliente de donde salió se pueden editar.
 */
export interface MatchSetup {
  readonly roomId: string;
  readonly table: {
    readonly gameModeId: string;
    /** El nombre del modo COMO SE JUGÓ: el panel puede renombrarlo después. */
    readonly name: string;
    /** Lo que la mesa cobraba y ofrecía, en UC completas, ANTES de cualquier aumento. */
    readonly entryFeeInUC: number;
    readonly prizeInUC: number;
    readonly isFree: boolean;
  };
  readonly matchConfig: {
    readonly playersQuantity: number;
    readonly pointsToWin: number;
    /** El marcador con que nació. Cero salvo en local y dev (`starting-score`). */
    readonly startingScore: { readonly teamA: number; readonly teamB: number };
    /** Cada plazo de la mesa en ms, como estaba cuando la sala abrió (la config en caliente incluida). */
    readonly timeoutsInMs: Readonly<Record<string, number>>;
    // ── LO QUE EL REPLAY NECESITA Y TRUCO NO GUARDA ──
    // Sin esto la partida grabada no se puede rebobinar: el seed decide el reparto y las parejas, y
    // los demás deciden qué es legal (la ventana de reparto, los niveles de aumento, los bots, la
    // revancha). Hasta acá viajaban por argumentos del CLI, y eran justo lo que el operador no sabía.
    readonly seed: string;
    readonly teamAssignment: TeamAssignmentMode;
    readonly isDealWindowEnabled: boolean;
    readonly tilesPerPlayer: number;
    readonly betLevels: readonly BetLevel[];
    readonly enableBots: boolean;
    readonly isRematchEnabled: boolean;
  };
  /** En orden de asiento. */
  readonly seats: readonly SeatSetup[];
}

/** La cabecera, escrita cuando la partida arranca. */
export interface MatchOpening extends MatchSetup {
  readonly matchStartedAt: number;
}

/**
 * CÓMO TERMINÓ, un eje para la partida. Quién se fue y por qué es el otro eje, y vive en cada
 * jugador como su `exit`. Es el vocabulario del dominó —el mismo del `MATCH_RESOLVED`/`MATCH_ABORTED`
 * de la timeline y del resultado que recibe el orquestador— y no el de truco: traducirlo a sus nombres
 * daría dos vocabularios para el mismo final dentro del mismo documento.
 *
 *   SCORE            terminada: un equipo llegó a los puntos
 *   ABANDONMENT      terminada: el otro equipo se quedó sin nadie
 *   NEVER_STARTED    abortada: la mesa nunca se llenó
 *   TILES_NOT_SEEN   abortada: alguien se fue con la ventana de reparto abierta
 *   NEVER_PLAYED     abortada: se repartió, nadie levantó y la sala se murió
 *   INTERRUPTED      abortada: la sala se murió con la partida en juego
 *   CHARGE_REJECTED  abortada: el orquestador no cobró la entrada
 */
export type MatchEndReason = "SCORE" | "ABANDONMENT" | AbortReason | "CHARGE_REJECTED";

/**
 * Por qué un jugador ya no está en la mesa: lo dijo él (`LEFT`), o lo retiró el reloj — conectado
 * (`TIMEOUT`) o con la conexión caída (`DISCONNECTED`).
 */
export interface SeatExit {
  readonly reason: "LEFT" | "TIMEOUT" | "DISCONNECTED";
  readonly at: number;
  readonly roundNumber: number;
}

/**
 * Una oferta de aumento. `UNCHARGED` es un trato cuyo cobro no salió, que devolvió la mesa a x1;
 * `UNANSWERED` es una que seguía abierta cuando la partida terminó.
 */
export interface BetMultiplierProposal {
  /** El número del trato entre los de esta partida, desde 1; sólo en los aceptados. */
  readonly betMultiplierAttempt?: number;
  readonly proposedBy: PlayerId;
  readonly respondedBy?: PlayerId;
  /** El nivel ofrecido: el multiplicador de la mesa (2, 3, 5…). */
  readonly value: number;
  readonly outcome: "ACCEPTED" | "REJECTED" | "EXPIRED" | "UNCHARGED" | "UNANSWERED";
  readonly proposedAt: number;
  readonly resolvedAt?: number;
  readonly roundNumber: number;
}

/**
 * LA PLATA DE UN ASIENTO, y es sólo la que el dominó SABE. El dominó no mueve dinero: le pide al
 * orquestador que cobre y le publica el premio. Por eso hay dos números y no los seis de truco —el
 * dominó no convierte a la moneda del jugador ni sabe qué reembolsó el orquestador—:
 *
 *   · `chargedInUC`   la entrada que el orquestador CONFIRMÓ, más el aumento que quedó cobrado.
 *   · `prizePaidInUC` el premio que el resultado publicado le asigna (`settlementOf`). Lo paga el
 *                     orquestador; esto es lo que se le pidió pagar.
 */
export interface SeatMoney {
  readonly chargedInUC: number;
  readonly prizePaidInUC: number;
}

/** Lo que sabe el que cierra sobre cómo terminó. El historial pone el resto. */
export interface MatchClose {
  readonly status: "finished" | "aborted";
  readonly matchEndReason: MatchEndReason;
  readonly winnerTeamId?: TeamId;
  readonly winnerIds: readonly PlayerId[];
  readonly rateId: string;
  readonly money: Readonly<Record<PlayerId, SeatMoney>>;
  readonly betMultiplier: {
    /** Los niveles que la mesa ofrecía. */
    readonly offeredValues: readonly number[];
    /** El nivel con que terminó; 1 si no hubo aumento cobrado. */
    readonly finalValue: number;
    readonly resultingEntryFeeInUC?: number;
    readonly resultingPrizeInUC?: number;
  };
  /** El peso en el ranking: el del modo, más el `extra` del aumento que quedó. */
  readonly rankingMultiplier: {
    readonly base: number;
    readonly extra: number;
    readonly final: number;
  };
}

/** Un asiento como lo guarda el registro cerrado. */
export interface StoredPlayer extends SeatSetup, Partial<SeatMoney> {
  readonly finalScore: number;
  readonly exit?: SeatExit;
}

/**
 * LO QUE LAS REGLAS CONCLUYERON DE UNA MANO, y sólo eso (truco `e4e630c`): las jugadas, los robos y el
 * veredicto con sus puntos ya están en la timeline, cada uno en su momento, y una segunda copia sería
 * una más que puede discrepar. Lo que la secuencia no dice sin reimplementar las reglas es quién
 * salió (la regla de la primera mano) y qué le quedó en la mano a cada uno con sus pips, que es lo
 * que cuenta una tranca y lo que cobra el que dominó.
 *
 * `MATCH_ABANDONED` es la mano que un abandono cortó: cierra sin veredicto propio.
 */
export interface ClosedRound {
  readonly roundNumber: number;
  readonly endReason: "DOMINO" | "BLOCKED" | "MATCH_ABANDONED";
  readonly starterId: PlayerId;
  readonly hands: readonly {
    readonly playerId: PlayerId;
    readonly tiles: readonly { readonly left: number; readonly right: number }[];
    readonly pips: number;
  }[];
}

/** Todo lo que escribe el cierre; el armado incluido, para la partida que nunca llegó a abrir. */
export interface MatchClosing extends MatchSetup {
  readonly status: "finished" | "aborted";
  readonly matchStartedAt?: number;
  readonly matchEndedAt: number;
  readonly matchDurationInMs?: number;
  readonly matchEndReason: MatchEndReason;
  readonly winnerTeamId?: TeamId;
  readonly winnerIds: readonly PlayerId[];
  readonly players: readonly StoredPlayer[];
  readonly rateId: string;
  readonly betMultiplier: MatchClose["betMultiplier"] & {
    readonly proposals: readonly BetMultiplierProposal[];
  };
  readonly rankingMultiplier: MatchClose["rankingMultiplier"];
}

/**
 * UN DOCUMENTO GUARDADO, tal como está: en la forma que lo haya escrito su versión —la vieja
 * `{ matchId, entries, createdAt, updatedAt }` incluida— y con los instantes como `Date`. Es lo que
 * contestan el detalle del panel y `/game-data`, que muestran el documento y no lo interpretan.
 */
export type StoredMatchRecord = Readonly<Record<string, unknown>>;

/**
 * UNA FILA DEL LISTADO DEL PANEL: lo de arriba del documento, sin `timeline` ni `rounds`. Un documento
 * de la forma vieja aparece con lo que tiene —`_id`, `matchId` y las dos fechas—.
 */
export interface MatchSummary {
  readonly _id: string;
  readonly matchId: string;
  readonly game: "domino";
  readonly roomId?: string;
  readonly status?: "started" | "finished" | "aborted";
  readonly table?: MatchSetup["table"];
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
  readonly matchStartedAt?: Date;
  readonly matchEndedAt?: Date;
  readonly matchEndReason?: MatchEndReason;
  readonly winnerIds?: readonly PlayerId[];
}

export interface MatchPage {
  readonly items: readonly MatchSummary[];
  readonly total: number;
}

// ── LOS PUERTOS ───────────────────────────────────────────────────────────────────────────────

// Devuelve `void`, no promesa, a propósito: lo llaman el camino de un comando y el
// de un timer, y ninguno espera. Las decisiones de persistencia —buffering, qué
// hacer si Mongo falla SIN FRENAR LA PARTIDA— quedan de este lado.
//
// CUATRO VERBOS EN UN SOLO PUERTO porque caen todos en el MISMO documento: el que lo crea tiene que
// ser uno, o dos escritores dirían cada uno haberlo creado (truco `8d4001a`).
export interface HistoryPort {
  /** La cabecera. IDEMPOTENTE: el primer armado gana, y una partida cerrada no vuelve a `started`. */
  open(matchId: string, opening: MatchOpening): void;
  record(entries: readonly HistoryEntry[]): void;
  round(matchId: string, round: ClosedRound): void;
  /** El desenlace. IDEMPOTENTE: el primer cierre gana; uno segundo no cambia nada. */
  close(matchId: string, closing: MatchClosing): void;
  /**
   * LA CONTRAPARTIDA DEL `void` DE ARRIBA, y existe por el apagado. `record` no espera y no
   * reintenta: un lote que todavía está viajando cuando alguien cierra la conexión no se vuelve
   * a intentar nunca, y el último lote de una partida es justamente el que lleva su desenlace.
   *
   * Un solo llamador, y no es una sala: el apagado ordenado (`src/di-container.ts`), que lo
   * espera ANTES de cerrar Mongo. Que esto SÍ prometa no afloja el contrato de `record` —el
   * camino caliente sigue sin tener nada que esperar—, lo COMPLETA: alguien tiene que poder
   * preguntar "¿terminaste?" y hasta ahora nadie podía.
   *
   * NUNCA RECHAZA. Un lote que falló ya se logueó, que es lo único que se le debe al operador;
   * propagarlo acá cortaría el resto del apagado, que es peor que perder el lote.
   */
  drain(): Promise<void>;
}

// El lado de LECTURA, separado del de escritura porque tiene otros dueños: escribe la sala
// en el camino caliente, lee el operador de soporte —el endpoint interno y el CLI de
// replay—. Un adaptador puede implementar los dos, y los dos que hay lo hacen:
// `MemoryHistory` y `MongoHistory`. Que hoy coincidan no los junta: son los tokens los que
// tienen dueños distintos, y por eso `of` ya cambió de forma sin que `record` se moviera.
//
// Existe como puerto y no como un cast porque el cast era una MENTIRA que tsc no podía
// ver: `resolve("HistoryPort") as MemoryHistory` afirma la implementación concreta sobre
// un token cuyo tipo declarado solo promete `record`. Con "HistoryPort" ya registrado
// contra el adaptador de Mongo, el cast seguiría compilando y el endpoint reventaría en
// runtime con `of is not a function`. Con el puerto aparte, el que no compila es el
// registro, que es donde está la decisión.
//
// PROMETE, y es la ASIMETRÍA con `record` lo que hay que leer acá, no el `Promise`. Los
// dos lados tienen dueños distintos: `record` corre en el camino de un comando y en el de
// un timer —ninguno espera, y que la base falle no puede frenar una partida—, mientras que
// `of` lo llama el operador de soporte, que no tiene nada que hacer salvo esperar la
// respuesta. Un lector sincrónico obligaba al adaptador de Mongo a tener la partida ya
// cargada en memoria, que es exactamente lo que la persistencia vino a dejar de exigir.
//
// `of` LEE LAS DOS FORMAS: `timeline` y, si no está, la `entries` de los documentos viejos, con los
// instantes de vuelta en epoch ms —el replay los usa como reloj—.
export interface HistoryReader {
  of(matchId: string): Promise<readonly HistoryEntry[]>;
}

// EL TERCER LECTOR, y tiene otro dueño: el panel y el backend principal, que miran el DOCUMENTO y no
// la secuencia. Va aparte de `HistoryReader` por lo mismo que ése va aparte del puerto de escritura.
export interface MatchArchive {
  /** El documento de una partida, con su `_id` como texto. `undefined` si no hay. */
  recordOf(matchId: string): Promise<StoredMatchRecord | undefined>;
  /**
   * El documento SIN `_id`, para el detalle de movimientos del backend principal
   * (`/game-data/:roomId`). Busca por `roomId` y, si no, por `matchId`: los documentos viejos no
   * guardaban la sala, y quien pregunta puede tener cualquiera de los dos ids.
   */
  snapshotOf(roomId: string): Promise<StoredMatchRecord | undefined>;
  /** Una página del listado, la más nueva primero por `createdAt`. `page` cuenta desde 1. */
  page(page: number, pageSize: number): Promise<MatchPage>;
}

// ── EL GRABADOR ───────────────────────────────────────────────────────────────────────────────

// Grabador PER-PARTIDA. Lo arma el wiring; la sala solo lo usa.
//
// Además de grabar sigue dos cosas que ninguna pieza ve enteras —quién se fue de la mesa y cómo, y qué
// fue de cada oferta de aumento—, porque es el único lugar donde se juntan los comandos y los eventos.
export class MatchHistory {
  private seq = 0;
  // LA AVANZA `ROUND_STARTED` Y NO SE LEE DEL ÁRBOL: el lote que vence la pausa de una mano también
  // reparte la siguiente, y cuando se graba el árbol ya apunta a la nueva — el vencimiento quedaba
  // archivado en una mano que no cerró. Un comando se graba ANTES que sus eventos, así que el verbo
  // que cierra una mano queda en ella.
  private roundNumber = 0;
  private openedAt?: number;
  private closed = false;
  private readonly recordedRounds = new Set<number>();
  private readonly exits = new Map<PlayerId, SeatExit>();
  private readonly proposals: BetMultiplierProposal[] = [];
  private agreements = 0;

  constructor(
    private readonly matchId: string,
    private readonly match: MatchState,
    private readonly clock: Clock,
    private readonly port: HistoryPort,
    private readonly setup: MatchSetup,
  ) {}

  // `source` es PARÁMETRO y no una constante `"PLAYER"`. Hoy todos los comandos los dice
  // un jugador, así que la sala pasa siempre `"PLAYER"` — pero el spec §5.1 dice que el
  // MISMO verbo dicho por el sistema se graba con el nombre del verbo y `source: SYSTEM`,
  // y que "el mecanismo del historial no depende de esa elección". Con la firma fijada en
  // PLAYER, sí dependía: cambiar la decisión de qué hace el reloj al vencer el turno
  // habría exigido tocar esta clase. Ahora es un argumento.
  command(source: HistoryEntry["source"], type: keyof CommandPayloads, payload: object): void {
    const entry = this.wrap(source, "COMMAND", type, payload);
    this.follow(source, type, entry.payload);
    this.port.record([entry]);
  }

  events(events: readonly NetworkMatchEvent[]): void {
    if (events.length === 0) return;
    const entries = events.flatMap((event) => {
      if (event.type === "ROUND_STARTED") {
        // LA PARTIDA ARRANCÓ: el primer reparto es el único momento en que la sala ya cobró, el motor
        // ya sembró y nadie jugó. Se abre ANTES de grabar el lote, así que la cabecera llega a la base
        // antes que la primera entrada de la partida.
        this.open();
        this.roundNumber = event.roundNumber;
      }
      const { type, ...rest } = event as NetworkMatchEvent & Record<string, unknown>;
      const entry = this.wrap("SYSTEM", "EVENT", type, rest);
      this.follow("SYSTEM", type, entry.payload);
      return type === "ROUND_STARTED" ? [entry, this.dealt()] : [entry];
    });
    this.port.record(entries);
    for (const event of events) {
      if (event.type === "ROUND_RESOLVED") this.closeRound(event.roundNumber, event.reason);
      // LA MANO QUE UN ABANDONO CORTÓ no tiene `ROUND_RESOLVED`, y sin esto sería la única que falta.
      if (event.type === "MATCH_RESOLVED" && event.reason === "ABANDONMENT") {
        const current = this.match.currentRound?.roundNumber;
        if (current) this.closeRound(current, "MATCH_ABANDONED");
      }
    }
  }

  /** La partida arrancó. Idempotente, como el arranque que sigue. */
  open(): void {
    if (this.openedAt !== undefined || this.closed) return;
    this.openedAt = this.match.startedAt || this.clock.now();
    this.port.open(this.matchId, { ...this.setup, matchStartedAt: this.openedAt });
  }

  /** Escribe el desenlace una vez; una segunda llamada es la misma partida contada dos veces y no cambia nada. */
  close(ending: MatchClose): void {
    if (this.closed) return;
    this.closed = true;
    const endedAt = this.clock.now();
    const startedAt = this.openedAt ?? (this.match.startedAt || undefined);
    const board = this.match.scoreboard;
    const players: StoredPlayer[] = this.setup.seats.map((seat) => {
      const exit = this.exits.get(seat.id) ?? this.walkedOutUnseen(seat.id, endedAt);
      return {
        ...seat,
        finalScore: (seat.teamId === "A" ? board?.teamA : board?.teamB) ?? 0,
        ...(exit ? { exit } : {}),
        ...ending.money[seat.id],
      };
    });
    this.port.close(this.matchId, {
      ...this.setup,
      status: ending.status,
      ...(startedAt === undefined
        ? {}
        : { matchStartedAt: startedAt, matchDurationInMs: endedAt - startedAt }),
      matchEndedAt: endedAt,
      matchEndReason: ending.matchEndReason,
      ...(ending.winnerTeamId === undefined ? {} : { winnerTeamId: ending.winnerTeamId }),
      winnerIds: ending.winnerIds,
      players,
      rateId: ending.rateId,
      betMultiplier: { ...ending.betMultiplier, proposals: [...this.proposals] },
      rankingMultiplier: ending.rankingMultiplier,
    });
  }

  // ── lo que ninguna pieza ve entero ──────────────────────────────────────────────────────────

  private follow(source: HistoryEntry["source"], type: string, payload: Record<string, unknown>) {
    const playerId = typeof payload.playerId === "string" ? payload.playerId : undefined;
    const now = this.clock.now();
    switch (type) {
      case "ABANDON":
        // Lo dijo el jugador, o el reloj por el que calló — y ahí, si seguía conectado es lo que
        // separa un turno vencido de una conexión caída. Se mira el ÁRBOL y no los
        // `PLAYER_DISCONNECTED` del historial: una caída con la ventana de reconexión abierta
        // (`onDrop`) no emite nada, y es justamente la que el reloj termina retirando.
        if (playerId && !this.exits.has(playerId)) {
          const connected = this.match.players.find((p) => p.playerId === playerId)?.connected;
          this.exits.set(playerId, {
            reason: source === "PLAYER" ? "LEFT" : connected === false ? "DISCONNECTED" : "TIMEOUT",
            at: now,
            roundNumber: this.roundNumber,
          });
        }
        return;
      case "PROPOSE_BET_MULTIPLIER":
        if (playerId && typeof payload.level === "number")
          this.proposals.push({
            proposedBy: playerId,
            value: payload.level,
            outcome: "UNANSWERED",
            proposedAt: now,
            roundNumber: this.roundNumber,
          });
        return;
      case "RESPOND_BET_MULTIPLIER":
      case "BET_MULTIPLIER_REJECTED": {
        // Con una oferta abierta la mesa está congelada, así que la próxima respuesta es la suya. El
        // rechazo del RELOJ es un evento con el que calló, no un comando.
        const open = this.openProposal();
        if (!open || !playerId) return;
        const accepted = type === "RESPOND_BET_MULTIPLIER" && payload.accept === true;
        this.proposals[this.proposals.indexOf(open)] = {
          ...open,
          respondedBy: playerId,
          outcome: accepted
            ? "ACCEPTED"
            : type === "BET_MULTIPLIER_REJECTED"
              ? "EXPIRED"
              : "REJECTED",
          resolvedAt: now,
          ...(accepted ? { betMultiplierAttempt: ++this.agreements } : {}),
        };
        return;
      }
      case "MULTIPLIER_REVOKED": {
        const last = [...this.proposals].reverse().find((p) => p.outcome === "ACCEPTED");
        if (last) this.proposals[this.proposals.indexOf(last)] = { ...last, outcome: "UNCHARGED" };
        return;
      }
    }
  }

  private openProposal(): BetMultiplierProposal | undefined {
    const last = this.proposals.at(-1);
    return last?.outcome === "UNANSWERED" ? last : undefined;
  }

  // Un asiento que el árbol dice retirado pero que este registro nunca vio irse: se fue antes de que
  // se grabara nada. Se fecha en el cierre, que es todo lo que se sabe.
  private walkedOutUnseen(playerId: PlayerId, endedAt: number): SeatExit | undefined {
    const player = this.match.players.find((p) => p.playerId === playerId);
    if (!player?.hasAbandoned) return undefined;
    return { reason: "LEFT", at: endedAt, roundNumber: this.roundNumber };
  }

  // LA MANO SE LEE DEL ÁRBOL EN EL LOTE QUE LA CIERRA: el siguiente reparto la reemplaza, y desde ahí
  // ya no se puede leer. El `roundNumber` se compara para no archivar la mano equivocada si algún día
  // un mismo lote cerrara una y repartiera la otra.
  private closeRound(roundNumber: number, endReason: ClosedRound["endReason"]): void {
    const round = this.match.currentRound;
    if (!round || round.roundNumber !== roundNumber || this.recordedRounds.has(roundNumber)) return;
    this.recordedRounds.add(roundNumber);
    this.port.round(this.matchId, {
      roundNumber,
      endReason,
      starterId: round.starterId,
      hands: this.match.players.map((player) => {
        const tiles = flatten([...player.hand.tiles]) as ClosedRound["hands"][number]["tiles"];
        return { playerId: player.playerId, tiles, pips: handValue(tiles) };
      }),
    });
  }

  private dealt(): HistoryEntry {
    const boneyard = this.match.currentRound?.boneyard;
    const tiles: DealtTiles = {
      hands: this.match.players.map((player) => ({
        playerId: player.playerId,
        tiles: flatten([...player.hand.tiles]) as DealtTiles["hands"][number]["tiles"],
      })),
      ...(boneyard ? { boneyard: flatten([...boneyard.tiles]) as DealtTiles["boneyard"] } : {}),
    };
    return this.wrap("SYSTEM", "EVENT", "TILES_DEALT", tiles);
  }

  private wrap(
    source: HistoryEntry["source"],
    kind: HistoryEntry["kind"],
    type: HistoryEntryType,
    payload: object,
  ): HistoryEntry {
    this.seq += 1;
    return {
      matchId: this.matchId,
      seq: this.seq,
      at: this.clock.now(),
      roundNumber: this.roundNumber,
      source,
      kind,
      type,
      payload: flatten(payload) as Record<string, unknown>,
    };
  }
}

// En @colyseus/schema 5 los campos NO son propiedades propias del objeto: viven en
// un símbolo interno. Un `{ ...tile }` devuelve `{}` y la ficha se registra vacía.
// Todo lo que pueda ser un Schema pasa por toJSON(), recursivo dentro de arrays.
function flatten(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(flatten);
  const candidate = value as { toJSON?: () => unknown };
  if (typeof candidate.toJSON === "function") return candidate.toJSON();
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, flatten(item)]),
  );
}
