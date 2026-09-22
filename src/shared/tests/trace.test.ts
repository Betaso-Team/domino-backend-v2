import {
  currentTrace,
  newTrace,
  traceFrom,
  traceparentOf,
  withTrace,
  withoutTrace,
} from "@/shared/trace";
import { describe, expect, it } from "vitest";

// LA CAUSA EN CURSO, que es lo que permite cruzar nuestros logs con los del backend principal.
// Lo que se mide es el contrato del cable —W3C Trace Context— y las dos formas de romperlo: no
// continuar una causa que vino, o arrastrar una que ya no corresponde.

const ID32 = /^[0-9a-f]{32}$/;
const ID16 = /^[0-9a-f]{16}$/;

describe("abrir una causa", () => {
  it("nace con los dos identificadores del formato", () => {
    const trace = newTrace();

    expect(trace.traceId).toMatch(ID32);
    expect(trace.spanId).toMatch(ID16);
  });

  it("dos causas no comparten identificador", () => {
    expect(newTrace().traceId).not.toBe(newTrace().traceId);
  });
});

describe("la causa en curso", () => {
  it("fuera de una causa no hay ninguna", () => {
    expect(currentTrace()).toBeUndefined();
  });

  it("adentro se lee sin pasarla por parámetro", () => {
    const trace = newTrace();

    expect(withTrace(trace, () => currentTrace())).toEqual(trace);
  });

  // LO QUE `fn` ARRANQUE LA HEREDA, `await` incluidos, y es todo el motivo de usar
  // `AsyncLocalStorage`: la alternativa —un `ctx` en cada firma— le costaría un parámetro a TODOS
  // los puertos del anillo para resolver un problema de observabilidad.
  it("la heredan los await de adentro", async () => {
    const trace = newTrace();

    const seen = await withTrace(trace, async () => {
      await Promise.resolve();
      return currentTrace();
    });

    expect(seen).toEqual(trace);
  });

  // ⚠ SALIRSE A PROPÓSITO EXISTE POR UNA FUGA MEDIDA: `AsyncLocalStorage` le da al callback de un
  // `setInterval` la causa que estaba viva cuando el intervalo se CREÓ, y Colyseus crea el reloj
  // de la sala adentro de `createRoom` — o sea adentro de la causa que formó la partida. Sin
  // esto, cada vencimiento de los diez minutos siguientes hereda el `traceId` del emparejamiento.
  it("se puede correr algo SIN causa aunque haya una viva", () => {
    const trace = newTrace();

    const seen = withTrace(trace, () => withoutTrace(() => currentTrace()));

    expect(seen).toBeUndefined();
  });
});

describe("la causa en el cable", () => {
  it("el traceparent lleva la versión, los dos ids y el flag de muestreo", () => {
    const trace = { traceId: "a".repeat(32), spanId: "b".repeat(16) };

    expect(traceparentOf(trace)).toBe(`00-${"a".repeat(32)}-${"b".repeat(16)}-01`);
  });

  // ⚠ EL `traceId` SE CONTINÚA Y EL SPAN NO: el del header es de quien nos llamó, y reusarlo
  // diría que su tramo y el nuestro son el mismo.
  it("continúa la causa que vino, con un tramo propio", () => {
    const entrante = "c".repeat(32);

    const trace = traceFrom({ traceparent: `00-${entrante}-${"d".repeat(16)}-01` });

    expect(trace.traceId).toBe(entrante);
    expect(trace.spanId).not.toBe("d".repeat(16));
    expect(trace.spanId).toMatch(ID16);
  });

  it("normaliza a minúsculas para que las dos mitades del log crucen", () => {
    const trace = traceFrom({ traceparent: `00-${"A".repeat(32)}-${"B".repeat(16)}-01` });

    expect(trace.traceId).toBe("a".repeat(32));
  });

  // UN HEADER ROTO SE IGNORA, no rechaza el request: lo que está en juego es poder cruzar dos
  // logs, no la corrección de nada.
  it.each([
    ["sin header", {}],
    ["mal formado", { traceparent: "cualquier cosa" }],
    ["versión desconocida", { traceparent: `99-${"a".repeat(32)}-${"b".repeat(16)}-01` }],
    // El identificador todo en ceros es el «no hay traza» de la spec, no una traza.
    ["todo en ceros", { traceparent: `00-${"0".repeat(32)}-${"b".repeat(16)}-01` }],
  ])("%s abre una causa nueva", (_name, headers) => {
    const trace = traceFrom(headers);

    expect(trace.traceId).toMatch(ID32);
    expect(trace.traceId).not.toBe("0".repeat(32));
  });

  // EL FALLBACK es para un servicio que todavía no habla W3C. Tiene que traer 32 hex para servir
  // de `traceId`: cualquier otra cosa no se puede representar en un `traceparent`, y arrastrar un
  // identificador que no podemos re-emitir rompería el enlace en silencio en el salto siguiente.
  it("acepta un x-request-id de 32 hex como causa", () => {
    const id = "e".repeat(32);

    expect(traceFrom({ "x-request-id": id }).traceId).toBe(id);
  });

  it("descarta un x-request-id que no se puede re-emitir", () => {
    const trace = traceFrom({ "x-request-id": "no-son-32-hex" });

    expect(trace.traceId).not.toBe("no-son-32-hex");
    expect(trace.traceId).toMatch(ID32);
  });

  // EL `traceparent` LE GANA al fallback: es el formato del que sí podemos continuar el tramo.
  it("el traceparent tiene prioridad sobre el x-request-id", () => {
    const trace = traceFrom({
      traceparent: `00-${"f".repeat(32)}-${"1".repeat(16)}-01`,
      "x-request-id": "e".repeat(32),
    });

    expect(trace.traceId).toBe("f".repeat(32));
  });

  // Node entrega los headers repetidos como arreglo, y quedarse con el primero es lo único que
  // evita un `traceId` que es en realidad dos pegados.
  it("con el header repetido usa el primero", () => {
    const primero = "1".repeat(32);

    const trace = traceFrom({
      traceparent: [
        `00-${primero}-${"2".repeat(16)}-01`,
        `00-${"3".repeat(32)}-${"4".repeat(16)}-01`,
      ],
    });

    expect(trace.traceId).toBe(primero);
  });
});
