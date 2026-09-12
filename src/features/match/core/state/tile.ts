import { type SchemaType, schema, t } from "@colyseus/schema";

// Una ficha. `left` y `right` son los dos números, 0..6.
export const Tile = schema({ left: t.number(), right: t.number() }, "Tile");
export type Tile = SchemaType<typeof Tile>;

// Una ficha ya puesta en la mesa: qué ficha, quién la puso, y de qué extremo se colgó.
//
// NO lleva `lockedNumber`. El número por el que enganchó es DERIVABLE de la cadena
// (`board.tiles` + `side`), con el mismo recorrido que hace `boardEndsOf`, y `board.tiles`
// es PÚBLICO — así que el cliente puede derivarlo. Guardarlo sería el campo derivado que
// spec §7.1 prohíbe, y de paso arrastraba el centinela `-1` del v1 a un campo donde 0 es
// un valor legítimo (la blanca).
//
// El criterio, escrito una vez: un campo derivado se guarda SOLO cuando el cliente no
// puede derivarlo —porque su fuente está gateada (`Hand.tileCount`, `BoneyardState.count`)
// o porque derivarlo exigiría reimplementar una regla del juego—. `lockedNumber` no
// califica por ninguna de las dos.
export const PlacedTile = schema(
  {
    tile: t.ref(Tile),
    playedBy: t.string(),
    // NOTA COMPARTIDA sobre uniones codificadas como `t.string()` (aplica también a
    // `RoundState.phase`, `RoundSummary.reason` y `MatchState.phase` en los otros
    // archivos de este directorio, así que se escribe una sola vez, acá): la API builder
    // de schema 5 no tiene un tipo de campo "unión de strings" — `t.string()` es
    // `string` a secas en el wire y en el tipo inferido. La unión (`BoardSide`,
    // `RoundPhase`, `RoundEndReason`, `MatchPhase`) vive solo en el tipo exportado junto
    // al schema, y el angostamiento real pasa por una función pura del lado que lee el
    // campo (p. ej. `sideOf()` en `state-projections.ts`), no por el campo mismo. Es un
    // trade-off aceptado, no una laguna: correspondería a `.optional()`/refinamiento en
    // otras librerías, pero acá el costo de introducir ese mecanismo no está pagado por
    // ningún caso de uso todavía.
    side: t.string(), // BoardSide — narrowing vía sideOf() en state-projections.ts
  },
  "PlacedTile",
);
export type PlacedTile = SchemaType<typeof PlacedTile>;

export type BoardSide = "LEFT" | "RIGHT";

export type { TileLike } from "../engine/tile-set.js";
