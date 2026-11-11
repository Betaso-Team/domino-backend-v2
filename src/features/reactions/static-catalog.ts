import type { Reaction, ReactionCatalog, ReactionPack } from "./catalog";

// LA LISTA, fija en el código y en este orden, que es el orden en que el front la dibuja. El id es
// lo que viaja por el cable: cambiarle el dibujo a un id es cambiar lo que ven todos los clientes
// que ya lo mandan, y cambiar un id deja a los clientes viejos mandando algo que ya no existe (el
// relay lo descarta en silencio).
const EMOJIS: readonly (readonly [id: string, content: string])[] = [
  ["grin", "😀"],
  ["joy", "😂"],
  ["cool", "😎"],
  ["heart-eyes", "😍"],
  ["angry", "😡"],
  ["sob", "😭"],
  ["thumbs-up", "👍"],
  ["thumbs-down", "👎"],
  ["pray", "🙏"],
  ["muscle", "💪"],
  ["victory", "✌️"],
  ["fire", "🔥"],
  ["zzz", "💤"],
  ["thinking", "🤔"],
  ["sleeping", "😴"],
  ["mind-blown", "🤯"],
  ["scream", "😱"],
  ["huffing", "😤"],
  ["devil", "😈"],
  ["skull", "💀"],
  ["trophy", "🏆"],
  ["dollar", "💵"],
  ["money-bag", "💰"],
  ["money-mouth", "🤑"],
];

export const REACTION_PACKS: readonly ReactionPack[] = [
  {
    pack: "global",
    items: EMOJIS.map(([id, content]): Reaction => ({ id, type: "emoji", content })),
  },
];

// EL CATÁLOGO DEL DOMINÓ: la lista de arriba detrás del mismo puerto que truco llena por HTTP. Es
// asíncrono sólo por el puerto; acá no se espera nada.
export class StaticReactionCatalog implements ReactionCatalog {
  private readonly byId: ReadonlyMap<string, Reaction>;

  constructor(private readonly all: readonly ReactionPack[] = REACTION_PACKS) {
    this.byId = new Map(all.flatMap(({ items }) => items.map((r) => [r.id, r] as const)));
  }

  async find(reactionId: string): Promise<Reaction | undefined> {
    return this.byId.get(reactionId);
  }

  async packs(): Promise<readonly ReactionPack[]> {
    return this.all;
  }
}
