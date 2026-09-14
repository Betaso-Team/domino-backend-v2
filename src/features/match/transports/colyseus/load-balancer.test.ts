import { describe, expect, it } from "vitest";
import { NoProcessAvailableError, leastLoaded } from "./load-balancer.js";

// SE PRUEBA EL CRITERIO Y NO LA LECTURA, y por eso el criterio está separado: los números los
// anuncia `matchMaker.stats.fetchAll()` contra el presence compartido, y esta función recibe la
// lista ya leída. Sin esa separación, medir el reparto pediría dos procesos de Colyseus y un
// Redis — y entonces no se mediría nunca.

describe("el reparto de partidas entre procesos", () => {
  it("abre la partida en el proceso con menos salas", () => {
    const libre = leastLoaded([
      { processId: "cargado", roomCount: 9, ccu: 0 },
      { processId: "libre", roomCount: 2, ccu: 40 },
    ]);

    expect(libre).toBe("libre");
  });

  // LAS SALAS PESAN MÁS QUE LOS JUGADORES, y este es el caso que lo fija: el proceso "libre"
  // tiene VEINTE veces más gente sentada y aun así gana. Cada sala del dominó trae su propio
  // bucle de temporizadores —turno, reserva, reparto, presentación— y su propio árbol
  // sincronizado, así que dos mesas de dos cuestan más que una de cuatro.
  it("prefiere menos salas aunque tenga muchos más jugadores", () => {
    const libre = leastLoaded([
      { processId: "cargado", roomCount: 20, ccu: 2 },
      { processId: "libre", roomCount: 1, ccu: 40 },
    ]);

    expect(libre).toBe("libre");
  });

  // A igualdad de salas manda el CCU, que es el desempate: entre dos procesos con las mismas
  // mesas, el que tiene menos gente sentada es el que menos sincroniza.
  it("a igualdad de salas prefiere el que tiene menos jugadores", () => {
    const vacío = leastLoaded([
      { processId: "lleno", roomCount: 3, ccu: 12 },
      { processId: "vacío", roomCount: 3, ccu: 4 },
    ]);

    expect(vacío).toBe("vacío");
  });

  // SIN CANDIDATOS SE FALLA, no se elige "el de siempre". Un clúster que no anuncia ningún
  // proceso es un Redis vacío o recién arrancado, y abrir ahí una partida sería abrirla en
  // ningún lado. Con plata de por medio, se rechaza.
  it("falla si el clúster no anuncia ningún proceso", () => {
    expect(() => leastLoaded([])).toThrow(NoProcessAvailableError);
  });

  // NO ORDENA LA LISTA QUE RECIBE. La que llega es la que `matchMaker.stats` acaba de leer, y
  // reordenarla en el lugar sería mutar un dato ajeno para contestar una pregunta.
  it("no toca la lista que le pasaron", () => {
    const procesos = [
      { processId: "cargado", roomCount: 9, ccu: 0 },
      { processId: "libre", roomCount: 2, ccu: 40 },
    ];

    leastLoaded(procesos);

    expect(procesos.map((proceso) => proceso.processId)).toEqual(["cargado", "libre"]);
  });
});
