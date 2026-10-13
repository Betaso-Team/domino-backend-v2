import { Writable } from "node:stream";
import { baseFieldsOf, createPino, wrap } from "@/logger";
import { newTrace, withTrace } from "@/shared/trace";
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

// LO QUE SALE DE VERDAD. Se arma el MISMO pino que el del proceso —`createPino`, con su
// redacción y su `mixin`— contra un destino que se puede leer, porque el real escribe al fd 1
// directo y no pasa por `process.stdout`.
const capture = (base: Record<string, unknown> = {}) => {
  const lines: Record<string, unknown>[] = [];
  const destination = new Writable({
    write(chunk, _encoding, done) {
      lines.push(JSON.parse(String(chunk)));
      done();
    },
  });
  return { log: wrap(createPino({ level: "debug", base, destination })), lines };
};

describe("lo que nunca sale", () => {
  // ⚠ UN TOKEN EN UN LOG ES UNA SESIÓN REGALADA a quien lea el panel, y la llave interna es peor.
  // Las dos formas en que llegan: suelto en los campos, y adentro de un objeto (un request, unas
  // opciones de sala).
  it("tapa el token y la autorización, sueltos o un nivel adentro", () => {
    const { log, lines } = capture();

    log.info("entró", { token: "jwt-secreto", req: { authorization: "Bearer otro-secreto" } });

    expect(JSON.stringify(lines)).not.toContain("secreto");
    expect(lines[0]).toMatchObject({ token: "[oculto]", req: { authorization: "[oculto]" } });
  });
});

describe("la causa en curso", () => {
  // EL `traceId` EN CADA LÍNEA SIN QUE NADIE LO PASE: es lo que junta nuestra mitad de un
  // incidente con la del backend principal.
  it("toda línea dentro de una causa lleva su traceId, y fuera de ella no", () => {
    const { log, lines } = capture();
    const trace = newTrace();

    withTrace(trace, () => log.info("adentro"));
    log.info("afuera");

    expect(lines[0]?.traceId).toBe(trace.traceId);
    expect(lines[1]).not.toHaveProperty("traceId");
  });
});

describe("quién habla", () => {
  it("dice la instancia como texto, también la cero, y el release", () => {
    const base = baseFieldsOf({ appEnv: "prod", instanceIndex: 0, release: "20261006-abc" });

    expect(base).toMatchObject({ env: "prod", instance: "0", release: "20261006-abc" });
    expect(base.hostname).toEqual(expect.any(String));
    expect(base.pid).toBe(process.pid);
  });

  // `undefined` NO ES LA INSTANCIA CERO, es "esto no lo levantó pm2". Con un `?? 0`, un
  // `node dist/main.js` a mano se leería como el primer worker.
  it("sin pm2 no inventa instancia, y sin release no inventa release", () => {
    const base = baseFieldsOf({ appEnv: "local", instanceIndex: undefined, release: undefined });

    expect(base).not.toHaveProperty("instance");
    expect(base).not.toHaveProperty("release");
  });
});
