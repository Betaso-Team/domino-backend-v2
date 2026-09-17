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
  // EL AUMENTO DE APUESTA, que es económico y no de juego: el motor corre la negociación y
  // NUNCA calcula con lo acordado — las piedras se cuentan igual con aumento que sin él.
  //
  // `level` es lo ÚNICO que el cliente elige, y es un nivel del catálogo de la mesa, no un
  // importe: los números los pone el servidor (`DominoMatchConfig.betLevels`). Es el único
  // payload del repo con un número elegido por el cliente, así que el schema valida la FORMA
  // y el dominio juzga si ese nivel es ofrecible.
  PROPOSE_BET_MULTIPLIER: { playerId: PlayerId; level: number };
  // Booleano y verbo propio, como en v1 — y no un QUIERO/NO_QUIERO compartido como truco,
  // que acá no tendría con quién compartirse: el dominó no tiene otros cantos.
  RESPOND_BET_MULTIPLIER: { playerId: PlayerId; accept: boolean };
}

export type CommandName = keyof CommandPayloads;
export type CommandPayload<N extends CommandName> = CommandPayloads[N];

// SÍNCRONO POR CONTRATO. Nada que espere red cabe adentro: si no hay await,
// Node no puede entrelazar dos mensajes del mismo cliente (spec §6).
export interface Command<N extends CommandName, TEvent> {
  execute(payload: CommandPayload<N>): readonly TEvent[];
}
