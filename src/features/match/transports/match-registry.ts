import type { KeyValueStore } from "../../../shared/kv.js";
import type { DominoMatchConfig } from "../core/config.js";

export interface PublicMatchConfig {
  readonly matchId: string;
  readonly gameModeId: string;
  readonly seats: readonly string[];
  readonly pointsToWin: number;
}

export interface MatchConfigResponse extends PublicMatchConfig {
  // No cachear: el cliente usa este instante para calcular el offset de activeDeadline.
  readonly serverNow: number;
}

// LAS DOS CLAVES. Sin prefijo de producto adentro del template a propósito: el prefijo lo pone
// el cliente de Redis (`keyPrefix` de `RedisPresence`, ver `src/di-container.ts`), que es el
// mismo mecanismo con el que Colyseus aísla su propio registro de salas. Meterlo acá dejaría dos
// lugares que tienen que coincidir.
const configKey = (roomId: string) => `match_config:${roomId}`;
const playerKey = (playerId: string) => `player_match:${playerId}`;

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

  constructor(
    private readonly store: KeyValueStore,
    private readonly ttlSeconds: number = TTL_SECONDS,
  ) {}

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
      seats: config.seats,
      pointsToWin: config.pointsToWin,
    });
    await this.keepAlive(roomId);
  }

  // EL LATIDO: vuelve a estampar todo lo de esta sala con el plazo entero. Solo late por lo que
  // este proceso anotó — una sala ajena no está en el `Map` y la llamada no hace nada, que es lo
  // que impide que una instancia mantenga viva la sala muerta de otra.
  async keepAlive(roomId: string): Promise<void> {
    const config = this.byRoomId.get(roomId);
    if (!config) return;

    await this.store.setex(configKey(roomId), JSON.stringify(config), this.ttlSeconds);
    for (const playerId of config.seats) {
      await this.store.setex(playerKey(playerId), roomId, this.ttlSeconds);
    }
  }

  async publicConfigOf(roomId: string): Promise<PublicMatchConfig | undefined> {
    const raw = await this.store.get(configKey(roomId));
    return raw ? (JSON.parse(raw) as PublicMatchConfig) : undefined;
  }

  // En qué sala está sentado, si está en alguna. Es un GET contra el índice que las salas
  // escriben: la respuesta es del CLÚSTER, no de este proceso.
  async matchOf(playerId: string): Promise<string | undefined> {
    return await this.store.get(playerKey(playerId));
  }

  async remove(roomId: string): Promise<void> {
    const config = this.byRoomId.get(roomId);
    if (!config) return;
    this.byRoomId.delete(roomId);

    this.store.del(configKey(roomId));
    for (const playerId of config.seats) await this.release(playerId, roomId);
  }

  // Soltar a un jugador es borrar SU clave, y SOLO SI sigue apuntando acá: entre que dejó esta
  // sala y que esta sala se entera, el jugador puede haberse sentado en otra mesa —en este
  // proceso o en otro—, y borrar a ciegas lo dejaría sin partida justo cuando acaba de empezar
  // una. El chequeo no es atómico y no hace falta que lo sea: la ventana que queda es la de una
  // clave que caduca sola en dos minutos.
  private async release(playerId: string, roomId: string): Promise<void> {
    if ((await this.store.get(playerKey(playerId))) === roomId) {
      this.store.del(playerKey(playerId));
    }
  }
}
