import { describe, expect, it } from "vitest";
import type { GameMode } from "./core/game-mode.js";
import {
  GAME_MODE_CREATED_KEY,
  GAME_MODE_EXCHANGE,
  GAME_MODE_UPDATED_KEY,
  createdEventOf,
  updatedEventOf,
} from "./events.js";

// El modo lleva `id` y `uuid` DISTINTOS a propósito: son los dos candidatos a `payload.id` y
// con el mismo valor ninguna aserción distingue cuál se mapeó. `id` tiene forma de hex de
// ObjectId porque eso es lo que el repositorio Mongo va a poner ahí (Tarea 4), y `uuid` es el
// identificador lógico que v1 publica.
//
// `isFreeRoom` y `enableBots` están puestos y no viajan: el `toEqual` de abajo es lo que mide
// esa omisión. Con `objectContaining` el test seguiría verde después de agregarlos al cuerpo,
// que es exactamente el cambio de contrato que este archivo existe para impedir.
const mode: GameMode = {
  id: "507f1f77bcf86cd799439011",
  uuid: "mode-1",
  name: "Clásica",
  multiplier: 2,
  prize: 18,
  entryFee: 10,
  playersQuantity: 2,
  pointsToWin: 25,
  isActive: true,
  isFreeRoom: true,
  enableBots: true,
  createdAt: new Date("2026-09-15T00:00:00.000Z"),
  updatedAt: new Date("2026-09-15T01:00:00.000Z"),
  version: 7,
};

describe("eventos del catálogo de modos", () => {
  it("publica al exchange y con las claves de v1", () => {
    // Literales y no referencias a las constantes: una aserción que compara la constante
    // consigo misma acompaña cualquier renombre del valor sin ponerse roja, y el valor es el
    // contrato — lo que un consumidor tiene bindeado en su cola.
    expect(GAME_MODE_EXCHANGE).toBe("betaso");
    expect(GAME_MODE_CREATED_KEY).toBe("game_mode.created");
    expect(GAME_MODE_UPDATED_KEY).toBe("game_mode.updated");
  });

  it("conserva el contrato Rabbit de domino v1", () => {
    expect(updatedEventOf(mode)).toEqual({
      key: "game_mode.updated",
      payload: {
        id: "mode-1",
        game: "domino",
        name: "Clásica",
        isActive: true,
        prize: 18,
        entryFee: 10,
        multiplier: 2,
        pointsToWin: 25,
        playerCount: 2,
      },
    });
  });

  it("la creación cambia la clave y no el cuerpo", () => {
    expect(createdEventOf(mode)).toEqual({
      key: "game_mode.created",
      payload: {
        id: "mode-1",
        game: "domino",
        name: "Clásica",
        isActive: true,
        prize: 18,
        entryFee: 10,
        multiplier: 2,
        pointsToWin: 25,
        playerCount: 2,
      },
    });
  });

  it("un modo desactivado de cuatro jugadores viaja igual", () => {
    // La desactivación y la reactivación viajan como `updated` con `isActive` adentro: no hay
    // una clave `game_mode.deleted` en v1, así que el booleano es el único dato que distingue
    // un baja de una edición. Y el 4P se publica aunque el motor no lo acepte todavía —el
    // catálogo lista y publica modos que ninguna mesa puede abrir.
    expect(
      updatedEventOf({ ...mode, isActive: false, playersQuantity: 4, enableBots: true }),
    ).toEqual({
      key: "game_mode.updated",
      payload: {
        id: "mode-1",
        game: "domino",
        name: "Clásica",
        isActive: false,
        prize: 18,
        entryFee: 10,
        multiplier: 2,
        pointsToWin: 25,
        playerCount: 4,
      },
    });
  });

  it("los importes viajan en UC completas, con decimales y sin escalar", () => {
    expect(updatedEventOf({ ...mode, entryFee: 1.5, prize: 2.75 }).payload).toMatchObject({
      entryFee: 1.5,
      prize: 2.75,
    });
  });
});
