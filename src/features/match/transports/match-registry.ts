import type { KeyValueStore } from "@/shared/kv";
import { UC } from "@/shared/money";
import {
  type DominoMatchConfig,
  type GlobalDominoConfig,
  type MatchMode,
  modeOf,
} from "../core/config";
import { type SeatPriceView, seatPriceView, ucText } from "../network/amounts";

/**
 * LOS PLAZOS CON LOS QUE NACIÓ LA MESA, para que el front dibuje el anillo con el largo de verdad.
 * El vencimiento ya viaja en `activeDeadline`; lo que el cliente no podía saber es cuánto duraba el
 * plazo entero, y con una constante propia el anillo arrancaba a la mitad o trabado arriba apenas el
 * panel editaba la sección `match`. Son los de la foto de `onCreate`, no los de hoy: una edición en
 * caliente llega a la mesa siguiente, y la que está abierta tiene que seguir publicando los suyos.
 */
export interface PublicMatchTimeouts {
  readonly turnMs: number;
  readonly extraTimeMs: number;
  readonly dealingMs: number;
  readonly betResponseMs: number;
}

// Allowlist, como el resto del DTO: la config global también lleva plazos que el front no usa y
// semillas de prueba que no tienen por qué salir. Se recorta acá, ANTES del registro, para que el
// registro nunca tenga la config entera en la mano.
export function publicTimeoutsOf(global: GlobalDominoConfig): PublicMatchTimeouts {
  return {
    turnMs: global.turnTimeoutMs,
    extraTimeMs: global.extraTimeReserveMs,
    dealingMs: global.dealingTimeoutMs,
    betResponseMs: global.betResponseTimeoutMs,
  };
}

export interface PublicMatchConfig {
  /** `CASUAL` o `TOURNAMENT`: el front y el orquestador separan las mesas de torneo con esto. */
  readonly mode: MatchMode;
  /** El torneo de la mesa; solo en una de torneo. */
  readonly tournamentId?: string;
  readonly matchId: string;
  readonly gameModeId: string;
  readonly seats: readonly string[];
  readonly pointsToWin: number;
  /**
   * LA MONEDA DE LA MESA, que es siempre UC: la mesa es de todos sus asientos y cada uno paga en su
   * moneda, así que sus montos son los del catálogo, en UC. La cifra en la moneda de un asiento la recibe
   * sólo ese asiento, en el `seat.price` de su mensaje `config` (`SeatConfigMessage`).
   */
  readonly currency: typeof UC;
  /**
   * LO QUE LA MESA COBRA Y PAGA, en la convención de montos (`network/amounts.ts`): texto decimal con
   * los 4 decimales de UC (`"125.0000"`), sin redondear.
   */
  readonly entryFee: string;
  readonly prize: string;
  /**
   * LOS NIVELES DE AUMENTO QUE LA MESA OFRECE (truco `58ce78f`), para que el front pinte el aumento
   * ANTES de proponer. Con el `extra` del catálogo: el front lo muestra junto al nivel, y no es
   * secreto —lo publica el catálogo de modos—. Vacío = esta mesa no ofrece aumentar. El precio de
   * cada uno es `entryFee × (nivel − 1)` (`betDifference`), o lo lee de `seat.price.levels` de su mensaje `config`.
   *
   * `extra` NO ES PLATA, y por eso sigue siendo un número: es lo que el nivel le SUMA al multiplicador
   * de puntos del ranking (`multiplier + extra`, `core/rules/config.ts`). Ni `additionalPoints`.
   */
  readonly betLevels: readonly {
    readonly level: number;
    readonly extra: number;
    readonly additionalPoints: number;
  }[];
  /** Una mesa gratis no cobra entrada ni ofrece aumentar (`DominoMatchConfig.isFreeRoom`). */
  readonly isFreeRoom: boolean;
  /** Si la mesa sienta una máquina en el asiento del que se retira (`DominoMatchConfig.enableBots`). */
  readonly enableBots: boolean;
  readonly timeouts: PublicMatchTimeouts;
}

// LA CONFIGURACIÓN PÚBLICA DE UNA MESA, pura: la usan el registro (lo que estampa en el almacén) y la
// sala (la base del mensaje `config` que manda al entrar), y tienen que ser la misma. Allowlist
// explícita: restar `seed` filtraría solo lo conocido hoy y una propiedad secreta agregada mañana se
// filtraría al wire. Tampoco se exponen campos derivados de la ventana de reparto.
//
// ES DE LA MESA Y DE NADIE MÁS: lo mismo para todos sus asientos, de cualquier proveedor. Nada de un
// asiento —su identidad, su proveedor, su moneda, su precio, la tasa— entra acá: lo de un asiento lo
// arma la sala para ese asiento solo (`DominoRoom.sendConfig`). Antes llevaba `seatPrices`, el precio de
// todos por asiento, y el jugador de un proveedor veía la moneda y lo que pagaba el del otro.
export function publicConfigOf(
  config: DominoMatchConfig,
  timeouts: PublicMatchTimeouts,
): PublicMatchConfig {
  const mode = modeOf(config);
  return {
    mode,
    ...(mode === "TOURNAMENT" && config.tournamentId !== undefined
      ? { tournamentId: config.tournamentId }
      : {}),
    matchId: config.matchId,
    gameModeId: config.gameModeId,
    seats: config.seats.map(({ playerId }) => playerId),
    pointsToWin: config.pointsToWin,
    // LOS NOMBRES DEL WIRE SON LOS DE DOMINÓ Y TRUCO, y ahora también los del snapshot: el DTO
    // público publica el mismo monto que la mesa cobró, en UC, con la forma de la convención.
    currency: UC,
    entryFee: ucText(config.entryFee),
    prize: ucText(config.prize),
    betLevels: config.betLevels.map(({ level, extra, additionalPoints }) => ({
      level,
      extra,
      additionalPoints,
    })),
    isFreeRoom: config.isFreeRoom,
    enableBots: config.enableBots,
    // Campo por campo y no con un spread: un objeto más ancho que el tipo también compila.
    timeouts: {
      turnMs: timeouts.turnMs,
      extraTimeMs: timeouts.extraTimeMs,
      dealingMs: timeouts.dealingMs,
      betResponseMs: timeouts.betResponseMs,
    },
  };
}

/**
 * LO QUE LA MESA LE DICE A UN ASIENTO SOBRE SÍ MISMO, y sólo a él: cuál es el suyo (`playerId`, el
 * `seat-N` del estado) y, si se sentó con precio, lo que la mesa le cuesta y le paga EN SU MONEDA
 * (`{ currency: "VES", rateId, rate, entry: "200.00", prize, levels }`, con la tasa de la mesa con la que
 * billing cotizó, y sin `uc`). Sin precio (mesa gratis, de torneo) no hay `price` y el front sigue en UC.
 */
export interface SeatConfigView {
  readonly playerId: string;
  readonly price?: SeatPriceView;
}

/** EL MENSAJE `config` de la sala: la mesa, el asiento de quien lo recibe y el reloj del servidor. */
export interface SeatConfigMessage extends PublicMatchConfig {
  readonly seat: SeatConfigView;
  // No cachear: el cliente usa este instante para calcular el offset de activeDeadline.
  readonly serverNow: number;
}

// EL MENSAJE DE UN ASIENTO, puro. La mesa va entera (es de todos) y del asiento va sólo el que lo recibe,
// CAMPO POR CAMPO: ni su `userId` —el jugador ya lo conoce, y el rival no tiene por qué— ni su
// proveedor. Nunca recorre `config.seats` para armar algo de varios: un mensaje con lo de otro asiento
// es la fuga que esto vino a cerrar.
export function seatConfigOf(
  table: PublicMatchConfig,
  config: DominoMatchConfig,
  playerId: string,
  serverNow: number,
): SeatConfigMessage {
  const price = config.seats.find((seat) => seat.playerId === playerId)?.price;
  return {
    ...table,
    seat: {
      playerId,
      ...(price === undefined ? {} : { price: seatPriceView(price, config.rateId) }),
    },
    serverNow,
  };
}

// LAS DOS CLAVES, sin prefijo de producto adentro del template a propósito. El aislamiento entre
// productos que comparten un servidor de Redis —el operador que corre truco al lado— viaja en el
// ÍNDICE DE BASE de `REDIS_URL`, que es donde ya está y donde también aísla las claves que
// Colyseus escribe por su cuenta (`roomcaches`, `roomcount`) y que nosotros no controlamos. Un
// prefijo acá solo cubriría estas dos y dejaría aquéllas afuera: media solución, en dos lugares
// que tienen que coincidir.
//
// Medido sobre dos instancias contra el mismo Redis, una en cada índice: estas dos claves salen
// con el MISMO nombre en las dos bases —`match_config:<roomId>` y `player_match:<pareja>`— y
// ninguna ve la de la otra. Que el id de usuario sea COMPARTIDO entre los productos del Betaso es
// justamente lo que haría de una base compartida una colisión real, y no teórica. El detalle de
// la medición está en el comentario de `REDIS_URL` en `src/env.ts`.
//
// Tampoco se comparten con nadie: son el estado de EJECUCIÓN de un clúster, no un dato que dos
// sistemas tengan que ver igual.
const configKey = (roomId: string) => `match_config:${roomId}`;
// LA CLAVE ES EL `userId` Y NADA MÁS. Fue la pareja `{ platformId, userId }` serializada con
// `JSON.stringify` mientras la identidad tenía dos mitades: un `a:b:c` concatenado no dice
// dónde termina una y empieza la otra, y la clave que colisiona sienta a un jugador en la
// mesa de otro. Con UN solo componente no hay dos mitades que confundir, y el prefijo
// `player_match:` ya la separa de las demás claves del almacén.
const playerKey = (userId: string) => `player_match:${userId}`;
// LA SALA DE CADA PARTIDA, por el `matchId` del orquestador: lo que contesta si una mesa sigue viva sin
// conocer su sala. Con el mismo TTL y el mismo latido que la config.
const matchKey = (matchId: string) => `match_room:${matchId}`;
const CENSUS_KEY = "live_seats";

// EL PLAZO DE TODAS ELLAS, y el latido que lo renueva. Son una sola decisión y no dos:
//
//   · SIN PLAZO, un proceso que muere de golpe —`kill -9`, OOM: `onDispose` no corre— deja su
//     sala anunciada para siempre. El endpoint HTTP seguiría sirviendo el config de una partida
//     que no existe, y sus jugadores quedarían anotados en una mesa muerta. La alternativa es un
//     barrido, que es lo que hace v1: una llamada remota por sesión, cada cinco minutos, y solo
//     desde la instancia primaria.
//   · SIN LATIDO, ese mismo plazo vencería en medio de una partida en curso.
//
// DOS MINUTOS y CUATRO LATIDOS ADENTRO. El latido va por el reloj de la sala y no por los hechos
// del juego, así que el plazo no tiene que cubrir la pausa más larga de una partida: tiene que
// cubrir varios latidos perdidos seguidos. Tres de cada cuatro pueden fallar —el registro se
// cayó, la red parpadeó— sin que una mesa viva desaparezca del clúster.
export const TTL_SECONDS = 120;
export const HEARTBEAT_MS = 30_000;
const STALE_MS = 2 * HEARTBEAT_MS;
const DEAD_MS = 4 * HEARTBEAT_MS;

/**
 * LO QUE EL REGISTRO RECUERDA DE CADA ASIENTO: la clave del índice invertido (`userId`) y a quién
 * atribuírselo en el censo (proveedor y moneda). Nada de montos ni de tasa: la moneda es la del
 * asiento (`MatchSeat.currency`), la que ya se cobró.
 */
interface SeatRef {
  readonly userId: string;
  readonly providerId: string;
  readonly currency: string;
}

/**
 * LA MESA DE UN GRUPO DEL CENSO: el modo de una casual (`gameModeId`) o el torneo de una de torneo
 * (`tournamentId`), exactamente uno de los dos. Con la mesa adentro, el orquestador decide qué grupos
 * ve cada proveedor (los modos que ofrece, sus torneos) sin perder el número de los demás.
 */
export type CensusTable =
  | { readonly gameModeId: string; readonly tournamentId?: never }
  | { readonly tournamentId: string; readonly gameModeId?: never };

/**
 * UN GRUPO DEL CENSO: cuántos asientos activos tiene un (proveedor, moneda) en una mesa (un modo o un
 * torneo). Todo asiento tiene proveedor, así que la suma de los grupos es exactamente `playersInMatch`.
 */
export type CensusGroup = CensusTable & {
  readonly providerId: string;
  readonly currency: string;
  readonly seats: number;
};

interface CensusEntry {
  readonly seats: number;
  /** Los `seats` de esta sala por (proveedor, moneda), cada grupo con la mesa. */
  readonly groups: readonly CensusGroup[];
  readonly at: number;
}

export interface MatchCensusCount {
  /** Todos los asientos que siguen jugando, casuales y de torneo. */
  readonly playersInMatch: number;
  /**
   * Los mismos asientos por (proveedor, moneda, mesa), en el orden en que aparecen. Suman exactamente
   * `playersInMatch`: no hay asientos sin atribuir.
   */
  readonly groups: readonly CensusGroup[];
}

// EL REGISTRO DE PARTIDAS VIVAS DEL CLÚSTER. La `DominoRoom` se anota al nacer, late mientras
// vive y se borra al morir. Vive en `transports/` —y no en `colyseus/`— porque el que pregunta es
// el otro transporte, el HTTP.
//
// **Las dos preguntas se contestan desde el almacén compartido y no desde la memoria**, y ése es
// todo el cambio. Con varios procesos, la sala de un jugador puede estar en otro nodo: el `Map`
// que había acá contestaba "esa sala no existe" —404 en la ruta de la config, que ya no existe— con total
// confianza y total falsedad. La memoria que queda es de ESCRITURA: qué anotó ESTE proceso, para
// saber qué renovar y qué borrar. Nadie lee de ella.
//
// `matchOf` dejó de recorrer las salas y pasó a ser un ÍNDICE INVERTIDO que la sala escribe,
// porque un `Map` de closures no se serializa: en vez de preguntarle a cada sala quién está
// sentado, cada sala anota a los suyos.
//
// El contrato público no cambió salvo que los métodos ahora PROMETEN, que es lo que el comentario
// que estaba acá anticipaba. El costo real fue cero: el único llamador de `publicConfigOf` es el
// endpoint HTTP, que ya era asíncrono desde que `HistoryReader.of()` pasó a prometer.
export class MatchRegistry {
  // LO QUE ESTE PROCESO ESCRIBIÓ. Es el DTO ya recortado y no el `DominoMatchConfig` entero: así
  // el `seed` no llega ni siquiera a la memoria del registro, y el latido no puede filtrarlo por
  // descuido el día que alguien cambie lo que se estampa.
  private readonly byRoomId = new Map<string, PublicMatchConfig>();
  // LAS PAREJAS QUE ESTE PROCESO ANOTÓ, aparte y no derivadas del DTO. El DTO público lleva
  // ids OPACOS —`seat-1`, `seat-2`—, así que reconstruir de ahí la clave del índice invertido
  // es imposible; y guardar el `DominoMatchConfig` entero para tenerla metería moneda, tasa y
  // montos en la memoria del registro, que es justo lo que la allowlist de arriba evita.
  // Cada asiento lleva además su proveedor y su moneda, que el censo necesita para agrupar: son ids y
  // un código de moneda, no montos ni tasa.
  private readonly seatsByRoomId = new Map<string, readonly SeatRef[]>();

  // El reloj solo decide cuándo un campo del censo dejó de latir. Las demás claves conservan el
  // plazo del almacén, que es lo que Redis aplica en producción.
  constructor(
    private readonly store: KeyValueStore,
    private readonly now: () => number = Date.now,
  ) {}

  // Nace la sala. Es el PRIMER LATIDO y nada más: todo lo que escribe lo vuelve a escribir cada
  // `HEARTBEAT_MS`, así que no hay un camino de alta distinto del de mantenimiento — y un camino
  // que corre una sola vez es el que nadie prueba.
  //
  // LOS PLAZOS SON OBLIGATORIOS y no tienen default: uno fijo acá publicaría la base aunque la mesa
  // haya nacido con una edición del panel, y el anillo del front volvería a mentir sin un test rojo.
  async register(
    roomId: string,
    config: DominoMatchConfig,
    timeouts: PublicMatchTimeouts,
  ): Promise<void> {
    this.byRoomId.set(roomId, publicConfigOf(config, timeouts));
    this.seatsByRoomId.set(
      roomId,
      config.seats.map(({ userId, providerId, currency }) => ({ userId, providerId, currency })),
    );
    await this.keepAlive(roomId);
  }

  // EL LATIDO: vuelve a estampar todo lo de esta sala con el plazo entero. Solo late por lo que
  // este proceso anotó — una sala ajena no está en el `Map` y la llamada no hace nada, que es lo
  // que impide que una instancia mantenga viva la sala muerta de otra.
  //
  // Y SUELTA A QUIEN YA NO JUEGA, portado de truco. `activeUserIds` son los asientos que la
  // partida todavía retiene: el que se retiró o el de una mesa que ya terminó deja de estar, y su
  // clave se borra en el acto en vez de seguir apuntando acá hasta que la sala se disponga. Sin
  // eso, una mesa terminada que sigue viva —la ventana de revancha, los clientes que no se
  // fueron— mandaba al jugador de vuelta a una partida donde `onJoin` lo rechaza.
  //
  // Soltar es PARA SIEMPRE: lo soltado sale de la lista de esta sala, así que omitir el parámetro
  // —el primer latido, el de `register`— renueva a los que quedaban y no revive a nadie. Retirarse y
  // terminar son irreversibles en el juego, y el registro no puede ser menos.
  //
  // LAS ESCRITURAS VAN EN PARALELO y el censo al final. Cada `setex` y cada `release` toca una
  // clave distinta, así que en serie solo sumaban viajes a Redis: con cuatro asientos eran seis
  // idas y vueltas por latido. El censo va después porque cuenta a los que quedaron.
  async keepAlive(roomId: string, activeUserIds?: readonly string[]): Promise<void> {
    const config = this.byRoomId.get(roomId);
    const seats = this.seatsByRoomId.get(roomId);
    if (!config || !seats) return;
    const active = activeUserIds
      ? seats.filter(({ userId }) => activeUserIds.includes(userId))
      : seats;
    const released = seats.filter((seat) => !active.includes(seat));

    await Promise.all([
      this.store.setex(configKey(roomId), JSON.stringify(config), TTL_SECONDS),
      this.store.setex(matchKey(config.matchId), roomId, TTL_SECONDS),
      ...active.map(({ userId }) => this.store.setex(playerKey(userId), roomId, TTL_SECONDS)),
      ...released.map(({ userId }) => this.release(userId, roomId)),
    ]);
    this.seatsByRoomId.set(roomId, active);
    await this.writeCensus(roomId, config, active);
  }

  // EL LATIDO POR HECHO: solo SUELTA, no renueva. Los plazos los renueva el reloj de la sala cada
  // `HEARTBEAT_MS` con `keepAlive`; lo único que un hecho del juego puede cambiar es quién sigue
  // jugando, y eso solo se achica —soltar es irreversible—. Así que si la lista no se achicó
  // respecto de lo que este proceso anotó, no hay nada que escribir: CERO I/O, que es el caso de
  // casi todos los hechos (una ficha jugada, un paso, un robo).
  //
  // Si alguien salió: se suelta su clave (con el mismo chequeo de `release`) y el censo se reescribe
  // en el acto, para que el orquestador pueda sentarlo en otra mesa sin esperar al próximo latido.
  async settle(roomId: string, activeUserIds: readonly string[]): Promise<void> {
    const config = this.byRoomId.get(roomId);
    const seats = this.seatsByRoomId.get(roomId);
    if (!config || !seats) return;
    const active = seats.filter(({ userId }) => activeUserIds.includes(userId));
    if (active.length === seats.length) return;
    const released = seats.filter((seat) => !active.includes(seat));

    await Promise.all(released.map(({ userId }) => this.release(userId, roomId)));
    this.seatsByRoomId.set(roomId, active);
    await this.writeCensus(roomId, config, active);
  }

  // El censo cuenta ASIENTOS QUE SIGUEN JUGANDO, como truco: el que perdió la señal sigue
  // contando —su reloj corre—, el que se retiró o terminó ya no está en ninguna partida. Los `groups`
  // salen de la MISMA lista `active`, así que suman exactamente `seats`, y cada uno lleva la mesa: el
  // torneo si es de torneo, el modo si es casual.
  private async writeCensus(
    roomId: string,
    config: PublicMatchConfig,
    active: readonly SeatRef[],
  ): Promise<void> {
    const table: CensusTable =
      config.tournamentId === undefined
        ? { gameModeId: config.gameModeId }
        : { tournamentId: config.tournamentId };
    const entry: CensusEntry = {
      seats: active.length,
      groups: groupSeats(active, table),
      at: this.now(),
    };
    await this.store.hset(CENSUS_KEY, roomId, JSON.stringify(entry));
  }

  async publicConfigOf(roomId: string): Promise<PublicMatchConfig | undefined> {
    const raw = await this.store.get(configKey(roomId));
    return raw ? (JSON.parse(raw) as PublicMatchConfig) : undefined;
  }

  // En qué sala está sentado, si está en alguna. Es un GET contra el índice que las salas
  // escriben: la respuesta es del CLÚSTER, no de este proceso.
  /**
   * SI LA MESA DE ESA PARTIDA SIGUE VIVA en el clúster: su sala anotada y la config de esa sala presente
   * (la misma prueba que la ruta del asiento). Rechaza si el registro no contesta.
   */
  async isLive(matchId: string): Promise<boolean> {
    const roomId = await this.store.get(matchKey(matchId));
    return roomId !== undefined && (await this.store.get(configKey(roomId))) !== undefined;
  }

  async matchOf(userId: string): Promise<string | undefined> {
    return await this.store.get(playerKey(userId));
  }

  async census(): Promise<MatchCensusCount> {
    const now = this.now();
    let playersInMatch = 0;
    const groups = new GroupTally();

    for (const [roomId, raw] of Object.entries(await this.store.hgetall(CENSUS_KEY))) {
      const entry = parseCensus(raw);
      if (!entry || now - entry.at >= DEAD_MS) {
        await this.store.hdel(CENSUS_KEY, roomId);
        continue;
      }
      if (now - entry.at >= STALE_MS) continue;
      playersInMatch += entry.seats;
      for (const group of entry.groups)
        groups.add(group.providerId, group.currency, group, group.seats);
    }

    return { playersInMatch, groups: groups.list() };
  }

  async remove(roomId: string): Promise<void> {
    const seats = this.seatsByRoomId.get(roomId);
    const config = this.byRoomId.get(roomId);
    if (!config || !seats) return;
    this.byRoomId.delete(roomId);
    this.seatsByRoomId.delete(roomId);

    this.store.del(configKey(roomId));
    this.store.del(matchKey(config.matchId));
    await this.store.hdel(CENSUS_KEY, roomId);
    for (const { userId } of seats) {
      await this.release(userId, roomId);
    }
  }

  // LA ENTRADA QUE DEJÓ UN PROCESO MUERTO (truco `53d1030`). Un `kill -9` o un OOM no corre `onDispose`,
  // así que `player_match` sigue apuntando a una sala que ya no existe hasta que vence su plazo
  // (`TTL_SECONDS`), y mientras tanto el orquestador no puede volver a sentar al jugador. La borra
  // quien CONFIRMÓ que la sala no existe —la API del orquestador, contra el matchmaker—, y es lo mismo
  // que `release`: solo si sigue apuntando a esa sala.
  async forget(userId: string, roomId: string): Promise<void> {
    await this.release(userId, roomId);
  }

  // Soltar a un jugador es borrar SU clave, y SOLO SI sigue apuntando acá: entre que dejó esta
  // sala y que esta sala se entera, el jugador puede haberse sentado en otra mesa —en este
  // proceso o en otro—, y borrar a ciegas lo dejaría sin partida justo cuando acaba de empezar
  // una. El chequeo no es atómico y no hace falta que lo sea: la ventana que queda es la de una
  // clave que caduca sola en dos minutos.
  private async release(userId: string, roomId: string): Promise<void> {
    if ((await this.store.get(playerKey(userId))) === roomId) {
      this.store.del(playerKey(userId));
    }
  }
}

// LA SUMA POR (PROVEEDOR, MONEDA, MESA). La clave es la tupla serializada con `JSON.stringify` y no
// concatenada: un `a|b|c` no dice dónde termina cada parte. El modo y el torneo van en posiciones
// distintas, así que un torneo nunca se suma con un modo que se llame igual.
class GroupTally {
  private readonly byKey = new Map<string, CensusGroup>();

  add(providerId: string, currency: string, table: CensusTable, seats: number): void {
    // La mesa se copia CAMPO POR CAMPO: un grupo leído del almacén puede traer más de lo que dice el tipo.
    const only: CensusTable =
      table.tournamentId === undefined
        ? { gameModeId: table.gameModeId }
        : { tournamentId: table.tournamentId };
    const key = JSON.stringify([
      providerId,
      currency,
      only.gameModeId ?? null,
      only.tournamentId ?? null,
    ]);
    const seen = this.byKey.get(key);
    this.byKey.set(key, { providerId, currency, ...only, seats: (seen?.seats ?? 0) + seats });
  }

  list(): readonly CensusGroup[] {
    return [...this.byKey.values()];
  }
}

function groupSeats(seats: readonly SeatRef[], table: CensusTable): readonly CensusGroup[] {
  const tally = new GroupTally();
  for (const { providerId, currency } of seats) tally.add(providerId, currency, table, 1);
  return tally.list();
}

const isText = (value: unknown): value is string => typeof value === "string";

// UN GRUPO DE LA FORMA DE HOY: proveedor y moneda en texto, y exactamente una mesa. Uno de una versión
// anterior (sin mesa, o con `providerId: null`) no lo es.
function isCensusGroup(value: unknown): value is CensusGroup {
  if (typeof value !== "object" || value === null) return false;
  const group = value as Record<string, unknown>;
  return (
    isText(group.providerId) &&
    isText(group.currency) &&
    typeof group.seats === "number" &&
    isText(group.gameModeId) !== isText(group.tournamentId) &&
    (group.gameModeId === undefined || isText(group.gameModeId)) &&
    (group.tournamentId === undefined || isText(group.tournamentId))
  );
}

// UNA ENTRADA DE LA FORMA DE HOY, o nada. La de una versión anterior —sin `groups`, o con grupos sin
// mesa o sin proveedor— no se lee de otra manera: se trata como una entrada rota, no cuenta y se barre.
// Si la escribió una sala viva de un proceso todavía viejo, la vuelve a escribir en su próximo latido y
// vuelve a no contar, hasta que ese proceso se reemplaza (ver «Censo» en `docs/api-y-mensajes.md`).
function parseCensus(raw: string): CensusEntry | undefined {
  try {
    const entry = JSON.parse(raw) as Partial<CensusEntry>;
    return typeof entry.seats === "number" &&
      Array.isArray(entry.groups) &&
      entry.groups.every(isCensusGroup) &&
      typeof entry.at === "number"
      ? (entry as CensusEntry)
      : undefined;
  } catch {
    return undefined;
  }
}
