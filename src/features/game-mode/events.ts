import type { GameMode } from "./core/game-mode";

// El exchange productivo de Betaso, `topic` y durable. Es de v1 y no se renombra: hay
// consumidores con sus colas ya bindeadas contra este nombre, y el corte a v2 no los toca.
export const GAME_MODE_EXCHANGE = "betaso";

// Las DOS claves, y son dos y no cuatro: la desactivación, la reactivación y el `POST /sync`
// viajan todas como `game_mode.updated` con `isActive` adentro del cuerpo. v1 nunca publicó
// un `game_mode.deleted`, así que inventarlo acá dejaría a los consumidores sin binding para
// la baja — o sea, un modo retirado que sigue vivo del otro lado.
export const GAME_MODE_CREATED_KEY = "game_mode.created";
export const GAME_MODE_UPDATED_KEY = "game_mode.updated";

export type GameModeEventKey = typeof GAME_MODE_CREATED_KEY | typeof GAME_MODE_UPDATED_KEY;

// EL CUERPO CRUDO DE v1, y NO es la entidad. Tres diferencias, las tres deliberadas:
//
// 1. `id` es el `uuid` del modo, NO el `id` (el hex del `_id` de Mongo). Medido contra el v1
//    productivo: `Betaso-Domino-Backend/src/game-modes/game-mode.publisher.ts:43` hace
//    `id: mode.uuid`. Es el punto que rompe en silencio si se hace al revés: el consumidor
//    upsertea por `id`, así que publicar el `_id` le crea un registro nuevo por cada modo en
//    vez de actualizar el que ya tiene, y nada falla de este lado.
// 2. `playerCount` es el `playersQuantity` interno, y `game` es la constante `"domino"`: el
//    exchange es compartido entre juegos, así que el discriminador viaja en el cuerpo.
// 3. NO LLEVA `isFreeRoom` NI `enableBots`. Existen en Mongo y en HTTP, pero los consumidores
//    de v1 nunca los vieron, y agregarle campos a un contrato que consume otro equipo no es
//    una decisión de este incremento. El `toEqual` de `events.test.ts` es lo que mide la
//    omisión; un `objectContaining` dejaría pasar el agregado sin ponerse rojo.
//
// Sin wrapper de NestJS: v1 usa `publishToExchange`, que serializa el payload PELADO (el
// `{ pattern, data, id }` es del camino de colas, no del exchange).
export interface GameModePayload {
  readonly id: string;
  readonly game: "domino";
  readonly name: string;
  readonly isActive: boolean;
  readonly prize: number;
  readonly entryFee: number;
  readonly multiplier: number;
  readonly pointsToWin: number;
  readonly playerCount: number;
}

// La clave y el cuerpo VIAJAN JUNTOS. El outbox persiste los dos y el publicador no decide
// ninguno: separarlos dejaría que una entrada se publique con la clave de la otra, y en un
// topic exchange eso es un mensaje que llega a la cola equivocada sin error de nadie.
export interface GameModeEvent {
  readonly key: GameModeEventKey;
  readonly payload: GameModePayload;
}

function payloadOf(mode: GameMode): GameModePayload {
  return {
    id: mode.uuid,
    game: "domino",
    name: mode.name,
    isActive: mode.isActive,
    prize: mode.prize,
    entryFee: mode.entryFee,
    multiplier: mode.multiplier,
    pointsToWin: mode.pointsToWin,
    playerCount: mode.playersQuantity,
  };
}

// Dos funciones y un solo cuerpo: lo único que cambia entre crear y editar es la clave. Que
// el cuerpo se construya en un lugar es lo que impide que dentro de seis meses el `created`
// lleve un campo que el `updated` no —y el reconciliador REPUBLICA un `created` perdido como
// `updated`, así que dos cuerpos distintos harían que recuperarse de una caída cambie el dato.
export function createdEventOf(mode: GameMode): GameModeEvent {
  return { key: GAME_MODE_CREATED_KEY, payload: payloadOf(mode) };
}

export function updatedEventOf(mode: GameMode): GameModeEvent {
  return { key: GAME_MODE_UPDATED_KEY, payload: payloadOf(mode) };
}
