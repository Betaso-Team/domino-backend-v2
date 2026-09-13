// src/features/match/core/command.ts
import type { PlayerId } from "./ids.js";
import type { BoardSide } from "./state/tile.js";

// El mapa de verbos. Crece de a uno: cada verbo nuevo rompe la compilación en TRES
// lugares —el schema del wire, los decoders y los comandos— cada uno apuntando a lo
// que falta. Eso reemplaza a un test de exhaustividad del catálogo.
export interface CommandPayloads {
  ABANDON: { playerId: PlayerId };
  PLAY_TILE: { playerId: PlayerId; left: number; right: number; side: BoardSide };
  DRAW_TILE: { playerId: PlayerId };
  PASS: { playerId: PlayerId };
  REVEAL_TILES: { playerId: PlayerId };
}

export type CommandName = keyof CommandPayloads;
export type CommandPayload<N extends CommandName> = CommandPayloads[N];

// SÍNCRONO POR CONTRATO. Nada que espere red cabe adentro: si no hay await,
// Node no puede entrelazar dos mensajes del mismo cliente (spec §6).
export interface Command<N extends CommandName, TEvent> {
  execute(payload: CommandPayload<N>): readonly TEvent[];
}
