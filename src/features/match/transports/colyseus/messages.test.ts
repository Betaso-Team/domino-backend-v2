import { describe, expect, it, vi } from "vitest";
import type { PlayerId } from "../../core/ids";
import { UnknownCommandError } from "./errors";
import { MessageRouter } from "./messages";

const PLAYER = "u1" as PlayerId;
const passthrough = { decode: (raw: unknown) => raw };

describe("MessageRouter", () => {
  it("decodifica y entrega al handler del tipo registrado", () => {
    const handle = vi.fn();
    const router = new MessageRouter().on("PLAY_TILE", passthrough, { handle });

    router.route("PLAY_TILE", { left: 6 }, PLAYER);

    expect(handle).toHaveBeenCalledWith({ left: 6 }, PLAYER);
  });

  it("le inyecta al handler lo que devolvió el decoder, no el crudo", () => {
    const handle = vi.fn();
    const router = new MessageRouter().on(
      "PLAY_TILE",
      { decode: (_raw: unknown, playerId) => ({ tile: "6-6", playerId }) },
      { handle },
    );

    router.route("PLAY_TILE", { tile: "MENTIRA", playerId: "otro" }, PLAYER);

    // El `playerId` del cable NO sobrevive: lo pone el decoder desde la identidad ya
    // verificada. Es la mitad de por qué los dos entran juntos al `on`.
    expect(handle).toHaveBeenCalledWith({ tile: "6-6", playerId: PLAYER }, PLAYER);
  });

  it("un tipo sin registrar lanza UnknownCommandError", () => {
    const router = new MessageRouter().on("PASS", passthrough, { handle: vi.fn() });

    expect(() => router.route("CHEAT", {}, PLAYER)).toThrow(UnknownCommandError);
  });

  // EL CASO QUE IMPORTA, heredado del catálogo que esto reemplaza. Cuando la tabla era un
  // objeto literal había que esquivar el prototipo con `Object.hasOwn`: con `in`, "toString"
  // pasaba la frontera, se llevaba un command() undefined, su .execute reventaba en
  // TypeError y la política de errores traducía eso a CERRAR la partida. Un mensaje de una
  // línea mataba la mesa.
  //
  // Un `Map` lo cierra por construcción. El test se queda igual: fija la PROPIEDAD, no cómo
  // se consigue — el día que alguien vuelva a un objeto literal, esto se pone rojo.
  it("rechaza los nombres heredados de Object.prototype", () => {
    const router = new MessageRouter().on("PASS", passthrough, { handle: vi.fn() });

    for (const name of ["toString", "constructor", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect(() => router.route(name, {}, PLAYER)).toThrow(UnknownCommandError);
    }
  });

  // Dos dueños para un mismo tipo es un bug de composición Y SILENCIOSO: el segundo pisaba
  // al primero y un verbo dejaba de llegar sin que nada se quejara. Los mapas que el router
  // reemplaza no podían tenerlo —un objeto literal con la clave repetida no compila—, así
  // que la garantía se repone en tiempo de registro.
  it("registrar dos veces el mismo tipo es un error", () => {
    const router = new MessageRouter().on("PASS", passthrough, { handle: vi.fn() });

    expect(() => router.on("PASS", passthrough, { handle: vi.fn() })).toThrow(/mensaje duplicado/);
  });

  // Lo que esta separación permite y el catálogo de verbos no podía: un handler que no es
  // del motor. `route` devuelve la promesa para que la sala pueda engancharle el `catch` —
  // sin eso un rechazo se escapa como `unhandledRejection` y se lleva el proceso entero,
  // con todas las demás partidas adentro.
  it("devuelve la promesa de un handler asíncrono", async () => {
    const router = new MessageRouter().on("REACTION", passthrough, {
      handle: () => Promise.reject(new Error("catálogo caído")),
    });

    await expect(router.route("REACTION", {}, PLAYER)).rejects.toThrow("catálogo caído");
  });

  it("un handler síncrono no devuelve promesa, y por eso la sala no le engancha nada", () => {
    const router = new MessageRouter().on("PASS", passthrough, { handle: () => undefined });

    expect(router.route("PASS", {}, PLAYER)).toBeUndefined();
  });
});
