import { describe, expect, it } from "vitest";
import { uuidV5 } from "./copy-uuid";

describe("uuidV5", () => {
  // EL VECTOR DEL RFC, calculado con `uuid.uuid5(uuid.NAMESPACE_DNS, "www.example.com")` de Python y
  // escrito como literal: recalcularlo con la misma función mediría que dos llamadas dan lo mismo.
  it("da el v5 del RFC 4122 para el espacio DNS", () => {
    expect(uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "www.example.com")).toBe(
      "2ed6657d-e927-568b-95e1-2665a8aea6a2",
    );
  });

  it("es el mismo para el mismo origen y proveedor, y distinto si cambia cualquiera", () => {
    const origen = "11111111-2222-4333-8444-555555555555";

    expect(uuidV5(origen, "parley")).toBe("bb041643-c230-559e-9082-526e5f05487b");
    expect(uuidV5(origen.toUpperCase(), "parley")).toBe("bb041643-c230-559e-9082-526e5f05487b");
    expect(uuidV5(origen, "otro")).not.toBe(uuidV5(origen, "parley"));
    expect(uuidV5("11111111-2222-4333-8444-555555555556", "parley")).not.toBe(
      uuidV5(origen, "parley"),
    );
  });

  it("un origen que no es un UUID no tiene v5", () => {
    expect(uuidV5("mode-1", "parley")).toBeUndefined();
  });
});
