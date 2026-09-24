import { describe, expect, it } from "vitest";
import { canRequestRematch, canRespondRematch, rematchRespondersOf } from "../rematch";
import { isIllegal } from "../ruling";
import { viewOf } from "./fixture";

// LAS REGLAS DE LA REVANCHA JUZGAN LA MESA Y NO EL DINERO. El saldo, el antifraude y el tope de
// la cadena se deciden ANTES de que la ventana exista —los escribe la red en `rematch.eligible`—,
// así que acá no hay una sola pregunta al mundo. Es lo que las deja viajar al cliente.
//
// Son las únicas reglas que corren con la partida YA dictaminada, que es por qué ninguna se apoya
// en `matchInProgress`.

const codeOf = (ruling: ReturnType<typeof canRequestRematch>) =>
  isIllegal(ruling) ? ruling.code : undefined;

// La mesa de dos recién dictaminada, con la ventana abierta y nadie que haya pedido todavía.
// ⚠ EL NODO EXISTE DURANTE LA VENTANA, y el fixture tiene que decirlo: es quien lleva
// `eligible`, así que se crea al abrir y no al pedir. Un fixture que lo dejara en `undefined`
// —como lo hacía el primero— deja verde una guarda que en producción rechaza todo.
const openWindow = (over: Partial<Parameters<typeof viewOf>[0]> = {}) =>
  viewOf({
    hands: { "seat-1": [], "seat-2": [] },
    noRound: true,
    matchPhase: "REMATCH_WINDOW",
    rematch: { requesterId: "", responderId: "", acceptedIds: [] },
    ...over,
  });

const negotiating = (
  requesterId = "seat-1",
  acceptedIds: string[] = [],
  over: Partial<Parameters<typeof viewOf>[0]> = {},
) =>
  viewOf({
    hands: { "seat-1": [], "seat-2": [] },
    noRound: true,
    matchPhase: "REMATCH_NEGOTIATION",
    rematch: { requesterId, responderId: "seat-2", acceptedIds },
    ...over,
  });

describe("canRequestRematch", () => {
  it("deja pedir con la ventana abierta", () => {
    expect(isIllegal(canRequestRematch("seat-1", openWindow()))).toBe(false);
  });

  it.each([
    ["PLAYING" as const],
    ["PRESENTING_MATCH" as const],
    ["FINISHED" as const],
    ["REMATCH_ACCEPTED" as const],
  ])("rechaza pedir en fase %s", (matchPhase) => {
    expect(codeOf(canRequestRematch("seat-1", openWindow({ matchPhase })))).toBe(
      "REMATCH_WINDOW_CLOSED",
    );
  });

  // EL ORDEN DE LAS DOS GUARDAS ES LA REGLA, y es la lección que truco dejó escrita: con una
  // solicitud sobre la mesa la fase YA es `REMATCH_NEGOTIATION`, así que preguntar primero por la
  // fase le diría al que perdió la carrera que la ventana está cerrada — que es FALSO y no le
  // dice qué hacer. Preguntando primero por la solicitud, se entera de que ya hay una.
  it("nombra la solicitud existente y no la fase, que es lo que el perdedor de la carrera necesita", () => {
    expect(codeOf(canRequestRematch("seat-1", negotiating()))).toBe("REMATCH_ALREADY_REQUESTED");
  });

  it("rechaza a quien no está en la mesa", () => {
    expect(codeOf(canRequestRematch("seat-9", openWindow()))).toBe("PLAYER_NOT_IN_MATCH");
  });

  it("rechaza al que se retiró", () => {
    expect(codeOf(canRequestRematch("seat-1", openWindow({ abandoned: ["seat-1"] })))).toBe(
      "PLAYER_NOT_IN_MATCH",
    );
  });

  // Una revancha contra nadie no es una partida.
  it("rechaza cuando el rival se retiró", () => {
    expect(codeOf(canRequestRematch("seat-1", openWindow({ abandoned: ["seat-2"] })))).toBe(
      "NO_REMATCH_OPPONENT",
    );
  });
});

describe("canRespondRematch", () => {
  it("deja responder al que no pidió", () => {
    expect(isIllegal(canRespondRematch("seat-2", negotiating()))).toBe(false);
  });

  it.each([["REMATCH_WINDOW" as const], ["FINISHED" as const], ["REMATCH_ACCEPTED" as const]])(
    "rechaza responder en fase %s",
    (matchPhase) => {
      expect(codeOf(canRespondRematch("seat-2", openWindow({ matchPhase })))).toBe(
        "NO_REMATCH_PENDING",
      );
    },
  );

  // EL QUE PIDE NO SE CONTESTA A SÍ MISMO. En una mesa de dos es la única forma de abrir una
  // revancha sin que el rival diga nada.
  it("rechaza que el solicitante acepte su propia solicitud", () => {
    expect(codeOf(canRespondRematch("seat-1", negotiating()))).toBe("NOT_YOUR_REMATCH");
  });

  it("rechaza al que ya aceptó", () => {
    expect(codeOf(canRespondRematch("seat-2", negotiating("seat-1", ["seat-2"])))).toBe(
      "REMATCH_ALREADY_ANSWERED",
    );
  });

  it("rechaza a quien no está en la mesa", () => {
    expect(codeOf(canRespondRematch("seat-9", negotiating()))).toBe("PLAYER_NOT_IN_MATCH");
  });
});

// QUIÉNES TIENEN QUE ACEPTAR: todos los que no pidieron y siguen en la mesa. La regla se escribe
// igual para uno que para tres, que es lo que deja el 4P resuelto sin que nadie lo abra.
describe("rematchRespondersOf", () => {
  it("en 2P es el rival, y nadie más", () => {
    expect(rematchRespondersOf("seat-1", openWindow())).toEqual(["seat-2"]);
  });

  it("en 4P son los otros tres, del equipo que sea", () => {
    const table = viewOf({
      hands: { "seat-1": [], "seat-2": [], "seat-3": [], "seat-4": [] },
      noRound: true,
      matchPhase: "REMATCH_WINDOW",
    });

    expect(rematchRespondersOf("seat-1", table)).toEqual(["seat-2", "seat-3", "seat-4"]);
  });

  // El que se retiró no tiene que aceptar nada: ya se fue. Contarlo dejaría toda revancha
  // esperando una respuesta que no va a llegar hasta que venza el plazo.
  it("no cuenta a los que se retiraron", () => {
    expect(rematchRespondersOf("seat-1", openWindow({ abandoned: ["seat-2"] }))).toEqual([]);
  });
});
