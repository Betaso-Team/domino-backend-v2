import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// LA GUARDA de una decisión que es fácil de deshacer sin querer. Portada de truco
// (`src/di-container.test.ts`), que la escribió al BORRAR su `WALLET_DRIVER`: un interruptor
// que NOMBRA la implementación en el composition root es deuda, no configuración. Deja
// escribir combinaciones incoherentes —"mongo" sin URI, "memory" con una base andando al
// lado— y convierte una decisión de arquitectura en un valor que alguien tipea en un deploy.
//
// Lo que este archivo SÍ permite, y es la forma que reemplazó al interruptor, es que la
// presencia del DATO decida: `env.mongoUri ? new MongoHistory(...) : new MemoryHistory()`.
// Ahí el dato y la decisión son lo mismo, así que no hay combinación inválida que escribir.
//
// Se afirma sobre el TEXTO del archivo y no sobre lo que resuelve el container, a propósito:
// lo que se quiere impedir es que alguien ESCRIBA cierta cosa acá adentro, y eso se ve
// leyendo. Un test que resolviera tokens tendría que saber de antemano cuáles mirar, que es
// justo lo que se olvida al agregar el siguiente puerto.
describe("el composition root", () => {
  const source = readFileSync(new URL("./di-container.ts", import.meta.url), "utf8");

  // No es la palabra "driver" lo que se prohíbe, sino LEER una variable de entorno que elija
  // implementación: el día que el dominó cablee el driver de Colyseus, eso va a ser un
  // colaborador de verdad y no una elección.
  it("no tiene un interruptor de implementación en el entorno", () => {
    expect(source).not.toMatch(/env\.\w*[Dd][Rr][Ii][Vv][Ee][Rr]/);
  });

  // `MemoryHistory` NO cuenta como doble y por eso no está en esta lista: es la
  // implementación de producción de una instancia que elige no persistir. El mismo error lo
  // cometió el comentario de truco, y fue esta guarda la que lo encontró.
  it("no cablea ningún doble", () => {
    expect(source.match(/\b(Fake\w+|Stub\w+|Mock\w+|Dummy\w+)\b/g) ?? []).toEqual([]);
  });
});
