import type { KeyValueStore } from "../../../shared/kv.js";
import type { PlayerRef } from "../../../shared/player-ref.js";
import type { DominoMatchConfig } from "../core/config.js";

export interface PublicMatchConfig {
  readonly matchId: string;
  readonly gameModeId: string;
  readonly seats: readonly string[];
  readonly pointsToWin: number;
  /** UC completas, tal como las guarda el catálogo: `125` son 125 UC, y `1.5` es válido. */
  readonly entryFee: number;
  readonly prize: number;
}

export interface MatchConfigResponse extends PublicMatchConfig {
  // No cachear: el cliente usa este instante para calcular el offset de activeDeadline.
  readonly serverNow: number;
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
// LA CLAVE ES LA PAREJA ENTERA, serializada con `JSON.stringify` y no concatenada con un
// separador: `["a","b:c"]` y `["a:b","c"]` son dos parejas distintas que un `a:b:c` vuelve la
// misma clave. Con el escape de JSON, dos parejas distintas nunca colisionan aunque el
// `platformId` o el `userUuid` traigan el separador adentro — y la que colisione sienta a un
// jugador en la mesa de otro.
const playerKey = ({ platformId, userUuid }: PlayerRef) =>
  `player_match:${JSON.stringify([platformId, userUuid])}`;

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

// EL REGISTRO DE PARTIDAS VIVAS DEL CLÚSTER. La `DominoRoom` se anota al nacer, late mientras
// vive y se borra al morir. Vive en `transports/` —y no en `colyseus/`— porque el que pregunta es
// el otro transporte, el HTTP.
//
// **Las dos preguntas se contestan desde el almacén compartido y no desde la memoria**, y ése es
// todo el cambio. Con varios procesos, la sala de un jugador puede estar en otro nodo: el `Map`
// que había acá contestaba "esa sala no existe" —404 en `GET /config/:roomId`— con total
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
  private readonly seatsByRoomId = new Map<string, readonly PlayerRef[]>();

  // EL PLAZO NO SE INYECTA, y es a propósito: truco lo deja como segundo parámetro con default y
  // nadie se lo pasa nunca. Acá los tests mueven el RELOJ del almacén, que es la otra mitad del
  // mismo vencimiento y la que además prueba la implementación de memoria de verdad.
  constructor(private readonly store: KeyValueStore) {}

  // Nace la sala. Es el PRIMER LATIDO y nada más: todo lo que escribe lo vuelve a escribir cada
  // `HEARTBEAT_MS`, así que no hay un camino de alta distinto del de mantenimiento — y un camino
  // que corre una sola vez es el que nadie prueba.
  async register(roomId: string, config: DominoMatchConfig): Promise<void> {
    // Allowlist explícita: restar `seed` filtraría solo lo conocido hoy y una propiedad
    // secreta agregada mañana se filtraría al wire. Tampoco se exponen campos derivados
    // de la ventana de reparto.
    this.byRoomId.set(roomId, {
      matchId: config.matchId,
      gameModeId: config.gameModeId,
      seats: config.seats.map(({ playerId }) => playerId),
      pointsToWin: config.pointsToWin,
      // LOS NOMBRES DEL WIRE SON LOS DE DOMINÓ Y TRUCO, y ahora también los del snapshot:
      // el DTO público publica el mismo número que la mesa cobró, en UC completas.
      entryFee: config.entryFee,
      prize: config.prize,
    });
    this.seatsByRoomId.set(
      roomId,
      config.seats.map(({ platformId, userUuid }) => ({ platformId, userUuid })),
    );
    await this.keepAlive(roomId);
  }

  // EL LATIDO: vuelve a estampar todo lo de esta sala con el plazo entero. Solo late por lo que
  // este proceso anotó — una sala ajena no está en el `Map` y la llamada no hace nada, que es lo
  // que impide que una instancia mantenga viva la sala muerta de otra.
  async keepAlive(roomId: string): Promise<void> {
    const config = this.byRoomId.get(roomId);
    const seats = this.seatsByRoomId.get(roomId);
    if (!config || !seats) return;

    await this.store.setex(configKey(roomId), JSON.stringify(config), TTL_SECONDS);
    for (const seat of seats) {
      await this.store.setex(playerKey(seat), roomId, TTL_SECONDS);
    }
  }

  async publicConfigOf(roomId: string): Promise<PublicMatchConfig | undefined> {
    const raw = await this.store.get(configKey(roomId));
    return raw ? (JSON.parse(raw) as PublicMatchConfig) : undefined;
  }

  // En qué sala está sentado, si está en alguna. Es un GET contra el índice que las salas
  // escriben: la respuesta es del CLÚSTER, no de este proceso.
  async matchOf(player: PlayerRef): Promise<string | undefined> {
    return await this.store.get(playerKey(player));
  }

  async remove(roomId: string): Promise<void> {
    const seats = this.seatsByRoomId.get(roomId);
    if (!this.byRoomId.has(roomId) || !seats) return;
    this.byRoomId.delete(roomId);
    this.seatsByRoomId.delete(roomId);

    this.store.del(configKey(roomId));
    for (const seat of seats) await this.release(seat, roomId);
  }

  // Soltar a un jugador es borrar SU clave, y SOLO SI sigue apuntando acá: entre que dejó esta
  // sala y que esta sala se entera, el jugador puede haberse sentado en otra mesa —en este
  // proceso o en otro—, y borrar a ciegas lo dejaría sin partida justo cuando acaba de empezar
  // una. El chequeo no es atómico y no hace falta que lo sea: la ventana que queda es la de una
  // clave que caduca sola en dos minutos.
  private async release(player: PlayerRef, roomId: string): Promise<void> {
    if ((await this.store.get(playerKey(player))) === roomId) {
      this.store.del(playerKey(player));
    }
  }
}
