import { z } from "zod";
import type { DealPreset } from "./core/engine/dealer";
import type { StartingScore } from "./core/engine/genesis";

// LAS DOS SECCIONES DE PRUEBA A MANO: fijar el reparto y arrancar con un marcador. Existen sólo en
// local y dev —las cablea el composition root ahí y en ningún otro lado— porque son exactamente lo
// que ningún jugador puede poder hacer. Portadas de truco (`d6e3219`, `6da7372`), con las fichas del
// dominó en vez de las cartas.
//
// Viven en la raíz de la feature y no en `core/` porque zod es un paquete de runtime (Regla 2).

const PIP = z.number().int().min(0).max(6);
const TILE = z.tuple([PIP, PIP]);
const sameTile = (a: readonly [number, number], b: readonly [number, number]) =>
  (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);

/**
 * Las manos pedidas, por asiento: hasta cuatro, hasta siete fichas cada una, y ninguna repetida —ni
 * en la misma mano ni entre dos—. Una ficha repetida no es un reparto raro, es uno imposible.
 */
export const dealPresetPatch = z
  .strictObject({ hands: z.array(z.array(TILE).max(7)).max(4) })
  .partial()
  .superRefine((patch, ctx) => {
    const all = (patch.hands ?? []).flat();
    all.forEach((tile, index) => {
      if (all.findIndex((other) => sameTile(tile, other)) !== index)
        ctx.addIssue({ code: "custom", message: `la ficha ${tile.join("|")} está repetida` });
    });
  }) satisfies z.ZodType<Partial<DealPreset>>;

export const DEAL_PRESET_EDITABLE = ["hands"];

const SCORE = z.number().int().min(0);

/** El marcador de arranque, un equipo a la vez. */
export const startingScorePatch = z
  .strictObject({ teamA: SCORE, teamB: SCORE })
  .partial() satisfies z.ZodType<Partial<StartingScore>>;

export const STARTING_SCORE_EDITABLE = ["teamA", "teamB"];

/**
 * El marcador con el que puede nacer una mesa con ESTA meta: cada equipo un punto por debajo. La
 * sección no lo puede rechazar sola, porque la meta es de cada mesa y la misma sección las sirve a
 * todas.
 */
export function startingScoreBelow(score: StartingScore, pointsToWin: number): StartingScore {
  const cap = Math.max(0, pointsToWin - 1);
  return { teamA: Math.min(score.teamA, cap), teamB: Math.min(score.teamB, cap) };
}
