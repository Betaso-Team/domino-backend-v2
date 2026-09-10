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
    side: t.string(), // BoardSide — narrowing vía sideOf() en state-projections.ts
  },
  "PlacedTile",
);
export type PlacedTile = SchemaType<typeof PlacedTile>;

export type BoardSide = "LEFT" | "RIGHT";
