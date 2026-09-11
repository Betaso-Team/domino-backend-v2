import { describe, expect, it } from "vitest";
import { ValidationError } from "../../errors.js";
import { identityDecoder } from "../decoders.js";

describe("identityDecoder", () => {
  // EL INVARIANTE DEL WIRE: el playerId no viaja en el mensaje. Lo inyecta el
  // decoder desde la identidad autenticada, así que no hay forma de jugar por otro.
  it("inyecta el playerId autenticado", () => {
    expect(identityDecoder("ABANDON").decode({}, "u1")).toEqual({ playerId: "u1" });
  });

  // RECHAZA, no ignora. Lo decide el `.strict()` de payloads.ts: zod emite
  // `unrecognized_keys` y el decoder lanza. Es la conducta más fuerte de las dos —el
  // que intenta suplantar se come un error duro, no un no-op mudo que lo deja
  // creyendo que el tiro salió—, y es la que el plan escribe como doctrina: un campo
  // de más es un rechazo, no algo que se ignore en silencio.
  it("rechaza un playerId mandado por el cliente", () => {
    expect(() => identityDecoder("ABANDON").decode({ playerId: "victima" }, "u1")).toThrow(
      ValidationError,
    );
  });

  it("acepta un payload ausente", () => {
    expect(identityDecoder("ABANDON").decode(undefined, "u1")).toEqual({ playerId: "u1" });
  });

  it("rechaza un payload que no es objeto", () => {
    expect(() => identityDecoder("ABANDON").decode(42, "u1")).toThrow(ValidationError);
  });
});
