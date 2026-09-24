import { describe, expect, it } from "vitest";
import { engineWithHands } from "./build-engine";

// LA MÁQUINA DE LA REVANCHA, sobre el árbol de verdad. Lo que se mide son TRANSICIONES —qué fase
// queda, qué plazo se estampa, qué nodo sobrevive—, así que se entra por donde entra en
// producción: la pausa de presentación venciendo.
//
// LA MESA SE LLEVA A `PRESENTING_MATCH` A MANO en vez de jugar una partida entera hasta el
// veredicto. No es atajo: lo que este archivo prueba empieza DESPUÉS del veredicto, y jugar las
// cien piedras que hacen falta para llegar mediría el marcador —que ya tiene sus suites— y haría
// que un cambio en el conteo pusiera rojo el archivo de la revancha.

const table = (isRematchEnabled = true) =>
  engineWithHands({ "seat-1": [[6, 6]], "seat-2": [[5, 5]] }, [], { isRematchEnabled });

// Vence la pausa de presentación, que es la única puerta de entrada a la revancha.
const presentMatch = (e: ReturnType<typeof table>) => {
  e.match.phase = "PRESENTING_MATCH";
  return e.matchDriver.timeout();
};

const openWindow = (e: ReturnType<typeof table>, eligible = true) => {
  if (eligible) e.gate.allow();
  presentMatch(e);
  return e;
};

describe("la ventana de revancha", () => {
  // LA MESA QUE NO LA OFRECE NO ABRE VENTANA, y no es lo mismo que no poder pagarla: en un torneo
  // el botón no existe, no aparece apagado.
  it("no se abre en una mesa que no ofrece revancha: se termina", () => {
    const e = table(false);
    e.gate.allow();

    const result = presentMatch(e);

    expect(e.match.phase).toBe("FINISHED");
    expect(e.match.rematch).toBeUndefined();
    expect(result.finished).toBe(true);
  });

  // ⚠ SE ABRE AUNQUE NO SEAN ELEGIBLES, y ahí se sigue a v1 y no a truco. Allá, sin elegibilidad
  // no hay ventana; acá se abre con el botón apagado, porque «no te alcanza» y «la revancha no
  // existe acá» son dos cosas distintas que el jugador tiene que poder distinguir.
  it("se abre con el botón apagado cuando la red no dio permiso", () => {
    const e = table();

    presentMatch(e);

    expect(e.match.phase).toBe("REMATCH_WINDOW");
    expect(e.match.rematch?.eligible).toBe(false);
  });

  it("se abre con el botón encendido cuando la red lo dio, y estampa su plazo", () => {
    const e = table();
    e.gate.allow();

    presentMatch(e);

    expect(e.match.phase).toBe("REMATCH_WINDOW");
    expect(e.match.rematch?.eligible).toBe(true);
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 300);
  });

  // La compuerta se lee UNA vez, al vencer la pausa. Un permiso que llega tarde no reabre nada.
  it("si la red dice que no, el botón queda apagado aunque después diga que sí", () => {
    const e = table();
    e.gate.allow();
    e.gate.deny();

    presentMatch(e);

    expect(e.match.rematch?.eligible).toBe(false);
  });

  it("nadie pide: vence y se termina", () => {
    const e = openWindow(table());

    const result = e.matchDriver.timeout();

    expect(result.events[0]).toEqual({ type: "DEADLINE_EXPIRED", kind: "REMATCH_WINDOW" });
    expect(e.match.phase).toBe("FINISHED");
    expect(e.match.rematch).toBeUndefined();
    expect(result.finished).toBe(true);
  });
});

describe("la negociación", () => {
  it("pedir mueve la fase, anota al que pidió y al que responde, y acorta el plazo", () => {
    const e = openWindow(table());

    e.matchDriver.requestRematch("seat-1");

    expect(e.match.phase).toBe("REMATCH_NEGOTIATION");
    expect(e.match.rematch?.requesterId).toBe("seat-1");
    // Con UN solo respondedor se lo nombra; en 4P quedaría en `""`.
    expect(e.match.rematch?.responderId).toBe("seat-2");
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 50);
  });

  it("aceptar cierra la negociación, pasa al traspaso y dice a quiénes sentar", () => {
    const e = openWindow(table());
    e.matchDriver.requestRematch("seat-1");

    const result = e.matchDriver.respondRematch("seat-2", true);

    expect(result.events).toEqual([{ type: "REMATCH_ACCEPTED", playerIds: ["seat-1", "seat-2"] }]);
    expect(e.match.phase).toBe("REMATCH_ACCEPTED");
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 60);
    // EL NODO SE BORRA: dejarlo vivo permitiría una segunda aceptación sobre una revancha hecha.
    // Por eso la lista viaja en el evento y no se lee del árbol.
    expect(e.match.rematch).toBeUndefined();
  });

  it("declinar cierra para toda la mesa", () => {
    const e = openWindow(table());
    e.matchDriver.requestRematch("seat-1");

    const result = e.matchDriver.respondRematch("seat-2", false);

    expect(e.match.phase).toBe("FINISHED");
    expect(e.match.rematch).toBeUndefined();
    expect(result.finished).toBe(true);
  });

  it("nadie contesta: vence, y el plazo vencido dice que fue la negociación", () => {
    const e = openWindow(table());
    e.matchDriver.requestRematch("seat-1");

    const result = e.matchDriver.timeout();

    expect(result.events[0]).toEqual({ type: "DEADLINE_EXPIRED", kind: "REMATCH_NEGOTIATION" });
    expect(e.match.phase).toBe("FINISHED");
  });

  // ⚠ LA CARRERA DE LOS DOS BOTONES, que es la regla de v1 contra la de truco: con los dos
  // apretando «Revancha» en el mismo segundo, el segundo verbo cuenta como aceptación. Tratarlo
  // como error mataría la revancha que los dos querían.
  it("el segundo que PIDE durante la negociación está aceptando", () => {
    const e = openWindow(table());
    e.matchDriver.requestRematch("seat-1");

    const result = e.matchDriver.requestRematch("seat-2");

    expect(result.events).toEqual([{ type: "REMATCH_ACCEPTED", playerIds: ["seat-1", "seat-2"] }]);
    expect(e.match.phase).toBe("REMATCH_ACCEPTED");
  });
});

describe("cerrar desde afuera", () => {
  // Una desconexión es un hecho de PLATAFORMA: el motor no la mira, así que alguien tiene que
  // venir a decirlo. Sin esto, el que ofreció mira una cuenta atrás que ya no puede terminar.
  it.each([["REMATCH_WINDOW" as const], ["REMATCH_NEGOTIATION" as const]])(
    "cierra la revancha en fase %s",
    (phase) => {
      const e = openWindow(table());
      if (phase === "REMATCH_NEGOTIATION") e.matchDriver.requestRematch("seat-1");

      e.matchDriver.closeRematch();

      expect(e.match.phase).toBe("FINISHED");
      expect(e.match.rematch).toBeUndefined();
    },
  );

  // EN EL TRASPASO NO CIERRA, y es la guarda menos obvia: ahí la sala nueva YA existe y cada uno
  // tiene su reserva. Los dos clientes SALEN de esta sala para consumirla —o sea que se
  // desconectan a propósito—, y cerrar ahí sería quitarle la revancha a quien ya la tiene.
  it("no hace nada durante el traspaso, que es cuando los clientes se van a propósito", () => {
    const e = openWindow(table());
    e.matchDriver.requestRematch("seat-1");
    e.matchDriver.respondRematch("seat-2", true);

    e.matchDriver.closeRematch();

    expect(e.match.phase).toBe("REMATCH_ACCEPTED");
  });

  it("no hace nada mientras se juega", () => {
    const e = table();

    e.matchDriver.closeRematch();

    expect(e.match.phase).toBe("NOT_STARTED");
  });

  it("el traspaso vencido termina la mesa", () => {
    const e = openWindow(table());
    e.matchDriver.requestRematch("seat-1");
    e.matchDriver.respondRematch("seat-2", true);

    const result = e.matchDriver.timeout();

    expect(result.events[0]).toEqual({ type: "DEADLINE_EXPIRED", kind: "REMATCH_ACCEPTED" });
    expect(e.match.phase).toBe("FINISHED");
    expect(result.finished).toBe(true);
  });
});

// LA MESA QUE PERDIÓ UN ASIENTO NO ABRE VENTANA, y es distinto de abrirla apagada: acá no hay
// nada que el que quedó pueda arreglar. Es la condición de v1 —la mesa completa— y es lo que hace
// que una partida ganada por abandono termine cuando termina, en vez de dejar al ganador treinta
// segundos frente a un botón gris.
describe("la mesa que no está entera", () => {
  it("no abre ventana cuando alguien se retiró", () => {
    const e = table();
    e.gate.allow();
    e.players.abandon("seat-2");

    const result = presentMatch(e);

    expect(e.match.phase).toBe("FINISHED");
    expect(e.match.rematch).toBeUndefined();
    expect(result.finished).toBe(true);
  });
});

describe("una mesa de cuatro", () => {
  const fourSeats = () =>
    engineWithHands(
      { "seat-1": [[6, 6]], "seat-2": [[5, 5]], "seat-3": [[4, 4]], "seat-4": [[3, 3]] },
      [],
      { isRematchEnabled: true },
    );

  // ⚠ NO HAY UN `it` DE «NO ESPERA AL QUE SE RETIRÓ», y la ausencia es una afirmación: con la
  // regla de la mesa entera, ese estado ya no se alcanza. Después del veredicto nadie se retira
  // —`ABANDON` exige la partida en curso y el reloj del turno ya no corre—, así que un asiento
  // retirado significa que la ventana nunca se abrió.
  //
  // El filtro de retirados de `rematchRespondersOf` SIGUE ahí, como segunda cerradura y no como
  // la primera, y lo mide su propio test en `rules/tests/rematch.test.ts` — donde es una función
  // pura y el caso se puede construir sin fingir un estado que la máquina no produce.

  // EL PLAZO NO SE RE-ESTAMPA CON CADA RESPUESTA, y con dos jugadores no se puede ver: es de la
  // SOLICITUD entera. Sin esto, tres jugadores contestando de a uno lo estirarían a quince
  // segundos mientras el que pidió mira una pantalla quieta.
  it("espera a los otros tres y no estira el plazo con cada aceptación", () => {
    const e = fourSeats();
    e.gate.allow();
    e.match.phase = "PRESENTING_MATCH";
    e.matchDriver.timeout();
    e.matchDriver.requestRematch("seat-1");
    const deadline = e.match.activeDeadline;
    // Con más de un respondedor no se nombra a ninguno: el front usa `acceptedIds`.
    expect(e.match.rematch?.responderId).toBe("");

    e.clockBox.now += 10;
    expect(e.matchDriver.respondRematch("seat-2", true).events).toEqual([]);
    e.clockBox.now += 10;
    expect(e.matchDriver.respondRematch("seat-3", true).events).toEqual([]);
    expect(e.match.phase).toBe("REMATCH_NEGOTIATION");
    expect(e.match.activeDeadline).toBe(deadline);

    const result = e.matchDriver.respondRematch("seat-4", true);

    expect(result.events).toEqual([
      { type: "REMATCH_ACCEPTED", playerIds: ["seat-1", "seat-2", "seat-3", "seat-4"] },
    ]);
    expect(e.match.phase).toBe("REMATCH_ACCEPTED");
  });
});
