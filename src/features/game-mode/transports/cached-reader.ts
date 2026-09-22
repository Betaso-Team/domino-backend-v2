import type { GameModeReader } from "../core/catalog";
import type { GameMode } from "../core/game-mode";

// EL MODO, EN CACHÉ, y sólo para quien SONDEA. El tick del emparejador rearma la especificación del
// pozo en cada pasada para ver si la mesa sigue ahí —a propósito: el modo se puede dar de baja con
// gente esperando—, y contra el catálogo real eso son cuatro lecturas de Mongo por segundo por modo
// con alguien en la cola, para siempre y desde el único proceso que tiene el lobby. Portado de truco
// (`10cdd0e`).
//
// SÓLO `byUuid`, que es la única lectura del tick. Las otras tres pasan derecho, y una de ellas es
// la que importa: `activeByUuid` es con la que NACE la mesa y congela entrada y premio en su
// snapshot. Cachearla sería que el caché decida lo que se cobra.
//
// EL ERROR NO SE RECUERDA. «La base no contestó» no es un estado del modo, y el emparejador VACÍA el
// pozo cuya especificación lanza: recordarlo cerraría la cola entera durante la ventana por un hipo.
// La AUSENCIA sí se recuerda: un id viejo se pregunta en cada tick de una cola que nunca se forma.
//
// ponytail: el mapa crece con cada uuid preguntado y no se poda. El techo son los ids que llegan a
// la cola, y `casualPoolSpec` rechaza el inexistente; si alguien sondea ids al azar, barrer vencidos.
export class CachedGameModeReader implements GameModeReader {
  private readonly cache = new Map<string, { mode?: GameMode; expiresAt: number }>();
  // Una lectura en vuelo por modo: cuatro que entran a la vez esperan la misma respuesta.
  private readonly inFlight = new Map<string, Promise<GameMode | undefined>>();

  constructor(
    private readonly source: GameModeReader,
    private readonly ttlMs: number,
    private readonly now: () => number,
  ) {}

  byUuid(uuid: string): Promise<GameMode | undefined> {
    const hit = this.cache.get(uuid);
    if (hit && hit.expiresAt > this.now()) return Promise.resolve(hit.mode);
    const pending = this.inFlight.get(uuid);
    if (pending) return pending;

    const request = this.source
      .byUuid(uuid)
      .then((mode) => {
        this.cache.set(uuid, { mode, expiresAt: this.now() + this.ttlMs });
        return mode;
      })
      .finally(() => this.inFlight.delete(uuid));
    this.inFlight.set(uuid, request);
    return request;
  }

  activeByUuid(uuid: string): Promise<GameMode | undefined> {
    return this.source.activeByUuid(uuid);
  }

  active(): Promise<readonly GameMode[]> {
    return this.source.active();
  }

  all(): Promise<readonly GameMode[]> {
    return this.source.all();
  }
}
