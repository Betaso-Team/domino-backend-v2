// El registro para el operador de soporte y para el replay. NO es event sourcing:
// la fuente de verdad del estado es el árbol Schema; esto es un registro paralelo.
//
// Se graban las DOS cosas —el ACTO y el HECHO— intercaladas en el orden en que
// pasaron, porque por el criterio de MatchEvent la mayoría de los verbos no emite
// nada: un historial de solo eventos tendría los desenlaces y ninguna jugada.
import type { CommandPayloads } from "../core/command.js";
import type { Clock } from "../core/engine/clock.js";
import type { MatchState } from "../core/state/index.js";
import type { NetworkMatchEvent } from "./events.js";

// EL VOCABULARIO DEL HISTORIAL ES CERRADO, y eso es el punto entero de la corrección
// del v1. Ahí una entrada era un tipo único discriminado por dos booleanos
// (`isPassed`/`isLoaded`), así que `isPassed && isLoaded` typechequeaba y no significaba
// nada. Acá el discriminante es `type`, y su dominio es la unión de los verbos del
// catálogo con los tipos de evento — no `string`.
//
// Si esto fuera `string`, un `type: "LOAD_TILE"` (el nombre del v1) se grabaría sin que
// nada chille, y el replay lo descubriría en runtime rebobinando una partida real.
export type HistoryEntryType = keyof CommandPayloads | NetworkMatchEvent["type"];

export interface HistoryEntry {
  readonly matchId: string;
  /** Monótono POR PARTIDA. Es el orden, y es lo único que ordena actos y hechos entre sí. */
  readonly seq: number;
  readonly at: number;
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
}

// Grabador PER-PARTIDA. Lo arma el wiring; la sala solo lo usa.
export class MatchHistory {
  private seq = 0;

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
      events.map((event) => {
        const { type, ...rest } = event as NetworkMatchEvent & Record<string, unknown>;
        return this.wrap("SYSTEM", "EVENT", type, rest);
      }),
    );
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
      roundNumber: this.match.currentRound?.roundNumber ?? 0,
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
