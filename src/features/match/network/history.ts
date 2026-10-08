// El registro para el operador de soporte y para el replay. NO es event sourcing:
// la fuente de verdad del estado es el árbol Schema; esto es un registro paralelo.
//
// Se graban las DOS cosas —el ACTO y el HECHO— intercaladas en el orden en que
// pasaron, porque por el criterio de MatchEvent la mayoría de los verbos no emite
// nada: un historial de solo eventos tendría los desenlaces y ninguna jugada.
import type { CommandPayloads } from "../core/command";
import type { Clock } from "../core/engine/clock";
import type { MatchState } from "../core/state";
import type { NetworkMatchEvent } from "./events";

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

// Devuelve `void`, no promesa, a propósito: lo llaman el camino de un comando y el
// de un timer, y ninguno espera. Las decisiones de persistencia —buffering, qué
// hacer si Mongo falla SIN FRENAR LA PARTIDA— quedan de este lado.
export interface HistoryPort {
  record(entries: readonly HistoryEntry[]): void;
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
// Devolver la promesa NO le cambia la semántica a `MemoryHistory`: su `of` sigue
// resolviendo con lo que ya tiene, sin un tick de espera real. Lo que cambia es que el
// llamador no puede volver a asumir que leer el historial es gratis.
export interface HistoryReader {
  of(matchId: string): Promise<readonly HistoryEntry[]>;
}

// Grabador PER-PARTIDA. Lo arma el wiring; la sala solo lo usa.
export class MatchHistory {
  private seq = 0;
  // LA AVANZA `ROUND_STARTED` Y NO SE LEE DEL ÁRBOL: el lote que vence la pausa de una mano también
  // reparte la siguiente, y cuando se graba el árbol ya apunta a la nueva — el vencimiento quedaba
  // archivado en una mano que no cerró. Un comando se graba ANTES que sus eventos, así que el verbo
  // que cierra una mano queda en ella.
  private roundNumber = 0;

  constructor(
    private readonly matchId: string,
    private readonly match: MatchState,
    private readonly clock: Clock,
    private readonly port: HistoryPort,
  ) {}

  // `source` es PARÁMETRO y no una constante `"PLAYER"`. Hoy todos los comandos los dice
  // un jugador, así que la sala pasa siempre `"PLAYER"` — pero el spec §5.1 dice que el
  // MISMO verbo dicho por el sistema se graba con el nombre del verbo y `source: SYSTEM`,
  // y que "el mecanismo del historial no depende de esa elección". Con la firma fijada en
  // PLAYER, sí dependía: cambiar la decisión de qué hace el reloj al vencer el turno
  // habría exigido tocar esta clase. Ahora es un argumento.
  command(source: HistoryEntry["source"], type: keyof CommandPayloads, payload: object): void {
    this.port.record([this.wrap(source, "COMMAND", type, payload)]);
  }

  events(events: readonly NetworkMatchEvent[]): void {
    if (events.length === 0) return;
    this.port.record(
      events.flatMap((event) => {
        if (event.type === "ROUND_STARTED") this.roundNumber = event.roundNumber;
        const { type, ...rest } = event as NetworkMatchEvent & Record<string, unknown>;
        const entry = this.wrap("SYSTEM", "EVENT", type, rest);
        return type === "ROUND_STARTED" ? [entry, this.dealt()] : [entry];
      }),
    );
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
