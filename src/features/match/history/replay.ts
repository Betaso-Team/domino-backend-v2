// Reconstruir una partida = mismo config (mismo seed) + los COMANDOS y los vencimientos
// reaplicados en orden de seq. Son las dos únicas entradas del motor; todo lo demás del
// historial es consecuencia y se re-deriva.
import type { Command, CommandName, CommandPayload } from "../core/command";
import {
  DEFAULT_GLOBAL_CONFIG,
  type DominoMatchConfig,
  type GlobalDominoConfig,
} from "../core/config";
import type { Clock } from "../core/engine/clock";
import { deadlineKindOf } from "../core/engine/deadline-kind";
import type { TimeoutScheduler } from "../core/engine/timeout-scheduler";
import type { SchemaVisibilityController } from "../core/engine/visibility";
import type { MatchEvent } from "../core/events";
import type { MatchState } from "../core/state/index";
import type { HistoryEntry } from "../network/history";
import { buildEngineGraph } from "./engine-factory";

export interface ReplayInput {
  readonly meta: DominoMatchConfig;
  readonly entries: readonly HistoryEntry[];
  readonly globalConfig?: GlobalDominoConfig;
  /**
   * El instante en que la partida ARRANCÓ. No está en el historial y no puede estarlo:
   * `begin()` no emite nada, así que la primera entrada grabada es posterior. Viaja
   * aparte —como el `seed`— porque `MatchState.startedAt` es estado observable, y sin
   * este dato el replay lo inventa y el árbol reconstruido difiere del real en un campo.
   * Cuando falta se usa el instante de la primera entrada, que es la mejor cota superior.
   */
  readonly startedAt?: number;
}

export function replay(input: ReplayInput): MatchState {
  // SE ORDENA UNA SOLA VEZ, y las dos cosas que dependen del orden salen de acá: el
  // instante de arranque y el bucle de reaplicación. Antes el fallback leía
  // `input.entries.at(0)` —el arreglo CRUDO— mientras el bucle sí ordenaba por `seq`, así
  // que un historial que no llegara ordenado (Mongo sin `sort`, un merge de dos lotes)
  // arrancaba el reloj en el `at` de una entrada que no era la primera. El orden es `seq`
  // y no `at` a propósito: `seq` es lo único monótono por partida —lo dice `HistoryEntry`—
  // y dos entradas del mismo milisegundo comparten `at`.
  const ordered = [...input.entries].sort((a, b) => a.seq - b.seq);

  // El reloj avanza con los timestamps del historial, así que los deadlines que se
  // estampan son los mismos que la partida real tuvo.
  const clockBox = { now: input.startedAt ?? ordered.at(0)?.at ?? 0 };
  const clock: Clock = { now: () => clockBox.now };

  // No hay timers: los vencimientos ya están EN el historial como DEADLINE_EXPIRED,
  // y se disparan a mano en el orden en que ocurrieron.
  //
  // UN SOLO `pending` alcanza, y no es suerte: el único que programa es
  // `MatchDriver.syncTimeout`, contra el único `MatchState.activeDeadline`. Si algún día
  // hubiera dos plazos vivos a la vez, el segundo pisaría al primero acá y el replay
  // divergiría en silencio — por eso además se comprueba el `kind` más abajo.
  let pending: (() => readonly MatchEvent[]) | undefined;
  const scheduler: TimeoutScheduler = {
    schedule(_at, onExpire) {
      pending = onExpire;
    },
    cancel() {
      pending = undefined;
    },
  };

  // Sin visibilidad: el replay reconstruye el ESTADO, no lo sincroniza a nadie.
  const visibility: SchemaVisibilityController = { makePublic() {}, hide() {} };

  const graph = buildEngineGraph(input.meta, input.globalConfig ?? DEFAULT_GLOBAL_CONFIG, {
    clock,
    scheduler,
    visibility,
  });
  // El catálogo por nombre, con el verbo concreto olvidado a propósito: acá el nombre
  // llega como dato del historial, así que la clave es `string` y el resultado puede
  // no existir. Eso es lo que convierte un verbo desconocido en un error con su `seq`.
  const commands: Readonly<Partial<Record<string, Command<CommandName, MatchEvent>>>> =
    graph.commands;
  graph.begin();

  for (const entry of ordered) {
    clockBox.now = entry.at;

    if (entry.kind === "COMMAND") {
      const command = commands[entry.type];
      if (!command) throw new Error(`seq ${entry.seq}: verbo desconocido ${entry.type}`);
      // El payload se guardó ya decodificado, así que entra tal cual. El cast es sobre el
      // PAYLOAD y no sobre el comando: lo que no está tipado es el dato que viene de la
      // base, y ese es el único punto donde la garantía se pierde de verdad.
      command.execute(entry.payload as CommandPayload<CommandName>);
      continue;
    }

    // El único EVENTO que es entrada del motor: el reloj decidió. Todo lo demás
    // (ROUND_RESOLVED, MATCH_RESOLVED, los verbos del sistema) es consecuencia de
    // este, y se re-deriva al dispararlo.
    if (entry.type === "DEADLINE_EXPIRED") {
      if (!pending) throw new Error(`seq ${entry.seq}: vencimiento sin timer programado`);
      // DETECTOR DE DIVERGENCIA, no despacho: el conductor decide la rama por el estado
      // (`deadlineKindOf`), no por lo que diga el historial, así que usar el `kind`
      // grabado para elegir sería darle a un dato de la base la última palabra sobre una
      // regla. Sirve para lo contrario: si el estado reconstruido está esperando OTRA
      // ventana que la que venció en la partida real, el replay ya divergió y este es el
      // primer punto donde se nota — con el `seq` y las dos ventanas por nombre.
      const expected = deadlineKindOf(graph.match);
      if (entry.payload.kind !== expected) {
        throw new Error(
          `seq ${entry.seq}: venció ${String(entry.payload.kind)} pero el replay espera ${expected}`,
        );
      }
      const run = pending;
      pending = undefined;
      run();
    }
  }

  return graph.match;
}
