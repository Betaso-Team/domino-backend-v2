// src/features/match/core/command.ts
import type { PlayerId } from "./ids";
import type { MoveType } from "./rules/actions";
import type { BoardSide } from "./state/tile";

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

// LAS TRES JUGADAS SON VERBOS DE VERDAD, y esta línea lo comprueba. La tabla de arriba es la
// fuente de verdad de los payloads; `MoveType` (§`rules/actions`) extrae de ella las tres que el
// registro de la mano apunta, y se declara allá porque el ÁRBOL tiene que poder nombrarla —este
// archivo no se puede importar desde `state/` sin hacer un ciclo—.
//
// La dirección de la aserción es la que importa: las jugadas son un SUBCONJUNTO de los verbos, no
// al revés. Sin ella, renombrar `DRAW_TILE` acá dejaría a `MoveType` con un literal que ya no
// existe y el registro seguiría compilando contra una palabra muerta.
type Assert<T extends true> = T;
export type MovesAreVerbs = Assert<MoveType extends CommandName ? true : false>;

// SÍNCRONO POR CONTRATO. Nada que espere red cabe adentro: si no hay await,
// Node no puede entrelazar dos mensajes del mismo cliente (spec §6).
export interface Command<N extends CommandName, TEvent> {
  execute(payload: CommandPayload<N>): readonly TEvent[];
}
