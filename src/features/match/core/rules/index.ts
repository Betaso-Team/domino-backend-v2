// LAS REGLAS DEL DOMINÓ, y la única puerta hacia ellas.
//
// Todo lo de esta carpeta es CONSULTA: dado el estado, qué ficha engancha, qué verbo es legal,
// cuánto vale una mano. Nada de acá muta nada y nada de acá conoce Colyseus — ésa es la
// condición para que el día de mañana viva en un paquete que el cliente también consuma, y con
// eso se acabe la única forma real de que las reglas del dominó se desincronicen: tenerlas
// escritas dos veces.
//
// Adentro, los archivos se importan por ruta relativa y no por este índice —igual que dentro del
// engine, y por lo mismo: para no crear ciclos—.
//
// ────────────────────────────────────────────────────────────────────────────────────────────
// ESTE ARCHIVO ES LA API DEL MÓDULO, y tiene UNA sola entrada. Es la misma razón por la que la
// legalidad sale COMPUESTA y no aspecto por aspecto: **ninguna pregunta que alguien se hace de
// verdad es de un aspecto**. `canPlayTile` pregunta a la vez por la partida, la ronda y el
// tablero, y quien la llama no tiene por qué saber que son tres.
//
// LO QUE NO SALE: `projections.ts`. Son las lecturas con las que las reglas están escritas —el
// angostamiento de los ejes, la puerta de `privateOf`—, no una API: quien consuma esto tiene la
// vista y la puede leer. Exportarlas sería ofrecer dos formas de preguntar lo mismo, y una de
// ellas sin la regla puesta.
export type {
  AvailableAction,
  AvailableActionType,
  MoveType,
  TilePlacement,
} from "./actions";
export { availableActionsFor } from "./actions";
export type { BoardEnds, BoardSide } from "./board-ends";
export { boardEndsOf } from "./board-ends";
export type { RuleViolationCode } from "./codes";
export type { PlayerId, TeamId } from "./ids";
export type { BetLevel, DominoRulesConfig } from "./config";
export {
  betLevelOf,
  canAbandon,
  canAct,
  canDrawTile,
  canPass,
  canPlayTile,
  canProposeBet,
  canRespondBet,
  canRevealTiles,
  hasPlayable,
  playersWithoutTilesSeen,
} from "./legality";
export type { MatchPhase, RoundEndReason, RoundPhase } from "./phases";
export { hasPlayableTile, playableSides } from "./playable";
export type { Ruling } from "./ruling";
export { LEGAL, illegal, isIllegal } from "./ruling";
export type { TileLike } from "./tiles";
export {
  DOMINO_MAX_PIP,
  DOMINO_SET_SIZE,
  handValue,
  isDouble,
  orderedTileSet,
  sameTile,
  tileValue,
} from "./tiles";
export type {
  BetOfferView,
  BoardView,
  BoneyardView,
  HandView,
  MatchView,
  PlacedTileView,
  PlayerView,
  PrivatePlayerView,
  PublicMatchView,
  ReadonlyList,
  RoundSummaryView,
  RoundView,
  ScoreboardView,
  TurnView,
} from "./view";
export { teamIdOf } from "./view";
