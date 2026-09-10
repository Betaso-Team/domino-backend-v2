import { type SchemaType, schema, t } from "@colyseus/schema";
import { Tile } from "./tile.js";

// El pozo. Este nodo solo se INSTANCIA en los modos que tienen pozo: en 4P la rama
// `RoundState.boneyard` queda ausente (ver el comentario de `RoundState`).
// `count` es un campo derivado PERMITIDO por el criterio de `PlacedTile`: su fuente
// (`tiles`) está gateada, así que el cliente no tiene de dónde contarla.
// `count` es público (el front lo muestra); `tiles` es de vista y
// NUNCA se le agrega a ninguna audiencia, así que el dominio las tiene y
// nadie las ve. Es la forma de dejar la fuente de verdad en el árbol
// sin sincronizarla (spec §7.1).
export const BoneyardState = schema(
  { count: t.number().default(0), tiles: t.array(Tile).view() },
  "BoneyardState",
);
export type BoneyardState = SchemaType<typeof BoneyardState>;
