import { type SchemaType, schema, t } from "@colyseus/schema";
import { PlacedTile } from "./tile.js";

// La cadena jugada. Los extremos NO son campos: se derivan de `tiles`
// (spec §7.1, "sin campos derivados") con boardEndsOf().
export const BoardState = schema({ tiles: t.array(PlacedTile) }, "BoardState");
export type BoardState = SchemaType<typeof BoardState>;
