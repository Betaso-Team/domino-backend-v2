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

  // LOS TRES INTERRUPTORES QUE EL CATÁLOGO INVITA A ESCRIBIR, nombrados uno por uno y no cubiertos
  // por la expresión de más arriba: ésa mira `env.*Driver`, y la forma tentadora acá es un
  // `env.gameModeDriver === "mongo"` o directamente un `GAME_MODE_DRIVER` en `src/env.ts`. Son tres
  // piezas nuevas que eligen implementación —repositorio, outbox y publicador—, o sea tres
  // oportunidades de convertir una decisión de arquitectura en un valor que alguien tipea en un
  // deploy. La forma correcta ya está escrita abajo: la presencia del DATO elige.
  it.each([["GAME_MODE_DRIVER"], ["OUTBOX_DRIVER"], ["AMQP_DRIVER"]] as const)(
    "no tiene un %s",
    (interruptor) => {
      expect(source).not.toContain(interruptor);
    },
  );

  // LAS TRES PIEZAS DEL CATÁLOGO ELIGEN JUNTAS Y POR `mongo`, nunca por separado. Un catálogo en
  // Mongo con un outbox en memoria pierde en cada reinicio justamente los eventos que el outbox
  // existe para no perder, y un lease de memoria no excluye a la otra instancia, que es lo único
  // que ese lease hace. Se mide que las tres miren la MISMA condición.
  it("repositorio, outbox y lease del catálogo eligen por la misma presencia de Mongo", () => {
    for (const memoria of ["MemoryGameModeRepository", "MemoryGameModeOutbox", "MemoryLease"])
      expect(source).toMatch(new RegExp(`mongo\\s*\\?[\\s\\S]{0,120}?:\\s*new ${memoria}`));
  });

  // EL DESPACHADOR PIDE LAS DOS COSAS. Con una sola, esta instancia administra el catálogo y
  // ACUMULA — que es un estado legítimo, no un error: sin Mongo el outbox es de memoria y despachar
  // sería publicar lo que se va a perder igual; sin publicador no hay a dónde despachar.
  it("el despachador del outbox exige Mongo Y publicador", () => {
    expect(source).toMatch(/mongo\s*&&\s*amqp/);
  });

  // EL ORDEN DEL APAGADO ES EL CONTRATO, y cada paso escribe en el que viene después. Se mide como
  // SECUENCIA —un `indexOf` creciente— y no con cuatro `toContain`, que darían verde con el orden
  // invertido. Lo que se rompe al revés: cerrar Mongo antes de drenar pierde el último lote de cada
  // partida, y cerrar el broker antes que el despachador tira la publicación en vuelo sobre un canal
  // cerrado.
  it("el apagado para el despachador, drena, cierra el broker y recién ahí Mongo", () => {
    const apagado = source.slice(source.indexOf("export async function shutdown"));
    const pasos = ["outboxDispatcher?.close", "history.drain", "amqp?.close", "mongo?.close"];
    const posiciones = pasos.map((paso) => apagado.indexOf(paso));
    expect(posiciones.every((posición) => posición >= 0)).toBe(true);
    expect([...posiciones].sort((a, b) => a - b)).toEqual(posiciones);
  });
});

// EL CABLEADO DE LA SUPERFICIE HTTP se mide acá y no en un test de `app.config.ts`, porque
// importarlo levanta el servidor de Colyseus entero: lo que hay que pinear es el ORDEN en que ese
// archivo registra, y eso se ve leyéndolo.
describe("la superficie Express", () => {
  const source = readFileSync(new URL("./app.config.ts", import.meta.url), "utf8");

  // EXPRESS RECONOCE EL MANEJADOR DE ERRORES POR SU ARIDAD DE CUATRO PARÁMETROS, y solo alcanza lo
  // que se registró ANTES que él. Una ruta del catálogo puesta después devolvería la página HTML por
  // defecto de Express con el stack adentro, y el `NODE_ENV` por default de este repo es
  // `development`. El costo de equivocarse es filtrar el stack en una ruta administrativa.
  it("registra el catálogo antes del manejador de errores", () => {
    expect(source.indexOf("registerGameModeHttp")).toBeGreaterThan(-1);
    expect(source.indexOf("registerGameModeHttp")).toBeLessThan(
      source.indexOf("httpErrorHandler("),
    );
  });

  // RABBIT ENTRA A READINESS Y NO A `/health`. `/health` no consulta NADA a propósito —"reiniciame"
  // es la única respuesta que destruye partidas en curso— y el dominó sigue jugando sin publicar.
  it("suma rabbit a las dependencias duras, con ping y no con una publicación", () => {
    expect(source).toMatch(/rabbit:\s*\(\)\s*=>\s*broker\.ping\(\)/);
  });
});
