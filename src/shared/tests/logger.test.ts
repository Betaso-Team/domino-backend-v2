import { wrap } from "@/logger";
import type pino from "pino";
import { describe, expect, it, vi } from "vitest";

// LA FACHADA DEL LOG, y lo único que puede romper: el ORDEN de los argumentos.
//
// ⚠ `pino` recibe los CAMPOS primero y el mensaje después; nuestra interfaz es al revés
// —`(message, fields)`— porque es la que se lee. Invertir la traducción NO FALLA: deja logs donde
// el mensaje es un objeto y el objeto es el mensaje, y eso no se ve hasta que alguien va a buscar
// un incidente y encuentra `{"msg":"[object Object]"}`.
//
// Es la clase de defecto que ningún otro test puede atrapar, porque todo el repo loguea a través
// de esta fachada y ninguno mira lo que sale.

const fake = () => {
  const calls: { level: string; fields: unknown; message: unknown }[] = [];
  const at = (level: string) => (fields: unknown, message: unknown) =>
    calls.push({ level, fields, message });
  const instance = {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    child: vi.fn(),
  };
  return { calls, instance };
};

describe("la fachada del log", () => {
  it.each(["debug", "info", "warn", "error"] as const)(
    "%s manda los campos primero y el mensaje después",
    (level) => {
      const { calls, instance } = fake();

      wrap(instance as unknown as pino.Logger)[level]("pasó algo", { roomId: "r1" });

      expect(calls).toEqual([{ level, fields: { roomId: "r1" }, message: "pasó algo" }]);
    },
  );

  // SIN CAMPOS MANDA UN OBJETO VACÍO y no `undefined`: con `undefined` en la primera posición,
  // pino interpreta el mensaje como los campos y la línea sale sin texto.
  it("sin campos manda un objeto vacío, no undefined", () => {
    const { calls, instance } = fake();

    wrap(instance as unknown as pino.Logger).info("sin nada");

    expect(calls[0]).toEqual({ level: "info", fields: {}, message: "sin nada" });
  });

  // EL HIJO TAMBIÉN VIENE ENVUELTO, y es la mitad que se olvida: `child()` de pino devuelve un
  // pino, así que sin volver a envolverlo la sala —que crea un hijo con `matchId`/`roomId`—
  // estaría llamando la interfaz de pino con nuestros argumentos, al revés.
  it("el hijo sigue hablando nuestro idioma", () => {
    const { calls, instance } = fake();
    const childCalls: { fields: unknown; message: unknown }[] = [];
    instance.child = vi.fn(() => ({
      ...instance,
      info: (fields: unknown, message: unknown) => childCalls.push({ fields, message }),
    }));

    wrap(instance as unknown as pino.Logger)
      .child({ matchId: "m1" })
      .info("en la sala", { a: 1 });

    expect(instance.child).toHaveBeenCalledWith({ matchId: "m1" });
    expect(childCalls).toEqual([{ fields: { a: 1 }, message: "en la sala" }]);
    expect(calls).toEqual([]);
  });
});
