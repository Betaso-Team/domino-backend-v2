import { describe, expect, it } from "vitest";
import type { BetLevel } from "../../config";
import { RuleViolationError } from "../errors";
import { engineWithHands } from "./build-engine";

// EL AUMENTO DE APUESTA. Lo que se prueba acá es sobre todo lo que NO se puede hacer: es
// dinero real, así que cada límite que v1 comprueba tiene su caso, y un límite sin test es
// plata que sale.
// LOS NIVELES SON LOS DE v1 —2 y 5— y eso ahora significa algo: el nivel ES el multiplicador
// de la mesa, no un índice. Con `entryFee: 125`, el x2 cuesta 125 de más y el x5 cuesta 500.
// Los montos NO están acá: el catálogo del backend principal no los trae, los deriva
// `betAmountsOf` de la mesa.
const LEVELS: readonly BetLevel[] = [
  { level: 2, extra: 2, additionalPoints: 100 },
  { level: 5, extra: 5, additionalPoints: 250 },
];

// Dos manos que no se cierran solas: lo que se mide es la negociación, no el dominó.
const hands = {
  u1: [
    [6, 6],
    [6, 5],
    [4, 3],
  ] as [number, number][],
  u2: [
    [5, 4],
    [3, 2],
    [2, 1],
  ] as [number, number][],
};

const engine = (betLevels: readonly BetLevel[] = LEVELS) =>
  engineWithHands(hands, [], { betLevels });

const started = (betLevels: readonly BetLevel[] = LEVELS) => {
  const e = engine(betLevels);
  e.start();
  return e;
};

describe("aumento de apuesta: proponer", () => {
  it("congela la ronda y publica la oferta con lo que el rival necesita para decidir", () => {
    const e = started();

    e.proposeBet("u2", 5);

    expect(e.round().phase).toBe("NEGOTIATING_BET");
    expect(e.round().betOffer?.proposerId).toBe("u2");
    expect(e.round().betOffer?.level).toBe(5);
    expect(e.round().betOffer?.extra).toBe(5);
    // 125 * (5 - 1): la mesa entera multiplicada por el nivel, menos lo ya pagado.
    expect(e.round().betOffer?.additionalEntryFee).toBe(500);
    expect(e.round().betOffer?.additionalPoints).toBe(250);
  });

  // EL TURNO NO SE MUEVE: congelar no es jugar. Si esto se rompiera, proponer le pasaría el
  // turno al rival —o se lo sacaría— y el aumento sería una jugada encubierta.
  it("no toca el turno", () => {
    const e = started();
    const before = e.round().currentTurn?.playerId;

    e.proposeBet("u2", 2);

    expect(e.round().currentTurn?.playerId).toBe(before);
  });

  it("una mesa sin catálogo de niveles no ofrece aumentar", () => {
    const e = started([]);

    expect(() => e.proposeBet("u1", 2)).toThrow(RuleViolationError);
  });

  it("un nivel que no está en el catálogo se rechaza", () => {
    const e = started();

    expect(() => e.proposeBet("u1", 99)).toThrow(RuleViolationError);
  });

  it("no se puede proponer dos veces en la misma ronda", () => {
    const e = started();
    e.proposeBet("u1", 2);

    expect(() => e.proposeBet("u1", 5)).toThrow(RuleViolationError);
  });

  // UNO ACEPTADO POR PARTIDA, que es el tope de v1: sin esto la mesa se sube sin techo a
  // fuerza de insistir ronda a ronda.
  it("no se puede volver a proponer después de un aumento aceptado", () => {
    const e = started();
    e.proposeBet("u1", 2);
    e.respondBet("u2", true);

    expect(() => e.proposeBet("u1", 5)).toThrow(RuleViolationError);
  });
});

describe("aumento de apuesta: responder", () => {
  it("aceptar sube lo acordado a la PARTIDA y descongela la ronda", () => {
    const e = started();
    e.proposeBet("u1", 5);

    e.respondBet("u2", true);

    expect(e.match.acceptedBetExtra).toBe(5);
    expect(e.match.acceptedBetLevel).toBe(5);
    expect(e.round().phase).toBe("PLAYING");
    // La oferta muere al contestarse: una oferta que sobrevive se puede contestar dos veces.
    expect(e.round().betOffer).toBeUndefined();
  });

  // EL ACUERDO SE ANUNCIA CON TODO LO QUE EL COBRO NECESITA, y ése es el evento entero: el
  // comando dice «acepto», esto dice CUÁNTO y A QUIÉNES. El cuánto NO está en el payload del
  // comando —vive en la oferta, que `settle` borra en el mismo acto—, así que leerlo del árbol
  // después es imposible. Es el gemelo de `REMATCH_ACCEPTED`.
  it("aceptar anuncia el trato con lo que hace falta para cobrarlo", () => {
    const e = started();
    e.proposeBet("u1", 5);

    expect(e.respondBet("u2", true)).toEqual([
      {
        type: "MULTIPLIER_AGREED",
        level: 5,
        extra: 5,
        additionalEntryFee: 500,
        playerIds: ["u1", "u2"],
      },
    ]);
  });

  // RECHAZAR NO ANUNCIA NADA: no hay nada que cobrar, y un evento de acuerdo sobre un «no» es
  // exactamente el que haría cobrar una mesa que nadie aceptó.
  it("rechazar no anuncia ningún trato", () => {
    const e = started();
    e.proposeBet("u1", 5);

    expect(e.respondBet("u2", false)).toEqual([]);
  });

  it("rechazar descongela sin tocar la plata", () => {
    const e = started();
    e.proposeBet("u1", 5);

    e.respondBet("u2", false);

    expect(e.match.acceptedBetExtra).toBe(0);
    expect(e.match.acceptedBetLevel).toBe(0);
    expect(e.round().phase).toBe("PLAYING");
  });

  // EL QUE PROPONE NO SE PUEDE ACEPTAR A SÍ MISMO. Sin esto, aumentar la apuesta es una
  // decisión unilateral sobre el dinero del otro.
  it("el proponente no puede contestar su propia oferta", () => {
    const e = started();
    e.proposeBet("u1", 2);

    expect(() => e.respondBet("u1", true)).toThrow(RuleViolationError);
    expect(e.match.acceptedBetLevel).toBe(0);
  });

  it("contestar sin oferta viva se rechaza", () => {
    const e = started();

    expect(() => e.respondBet("u2", true)).toThrow(RuleViolationError);
  });
});

describe("aumento de apuesta: el reloj", () => {
  // EL SILENCIO ES UN NO. La mesa queda congelada esperando, así que dejar correr el reloj no
  // puede salir gratis ni dejar la ronda trabada para siempre.
  it("al vencer el plazo se rechaza en nombre del que calló, y el juego sigue", () => {
    const e = started();
    e.proposeBet("u1", 5);

    const events = e.fireTimeout();

    expect(events).toContainEqual({ type: "BET_MULTIPLIER_REJECTED", playerId: "u2" });
    expect(e.match.acceptedBetLevel).toBe(0);
    expect(e.round().phase).toBe("PLAYING");
    expect(e.round().betOffer).toBeUndefined();
  });

  // EL RELOJ DEL TURNO NO SE REGALA. Sin esto, el que está en turno propone, le dicen que no,
  // y vuelve con el plazo entero de nuevo: un turno gratis por ronda, gratis para el que
  // propone y pago por el que no.
  it("descongelar devuelve lo que le quedaba al turno, no un turno entero", () => {
    const e = started();
    const deadlineBefore = e.match.activeDeadline;
    // Se consume la mitad del turno antes de proponer.
    e.clockBox.now += 300;

    e.proposeBet("u1", 2);
    e.respondBet("u2", false);

    // Lo que quedaba eran 300 ms, no los 600 del turno entero.
    expect(e.match.activeDeadline).toBe(e.clockBox.now + (deadlineBefore - e.clockBox.now));
    expect(e.match.activeDeadline).toBeLessThan(deadlineBefore + 600);
  });

  it("mientras se negocia, el plazo vigente es el de la respuesta y no el del turno", () => {
    const e = started();
    const turnDeadline = e.match.activeDeadline;

    e.proposeBet("u1", 2);

    expect(e.match.activeDeadline).not.toBe(turnDeadline);
  });
});

// LA COMPENSACIÓN, que es lo único del aumento que no pide un jugador. El motor asienta el trato
// sin esperar a la billetera —es síncrono por contrato— así que cuando el cobro no sale hay que
// deshacerlo con un segundo acto. Sin esto el estado diría x5 para siempre sobre una mesa que
// nadie pagó, y el cierre pagaría un premio con dinero que no entró.
describe("aumento de apuesta: deshacerlo cuando el cobro no salió", () => {
  it("devuelve el escalar de la partida a cero y dice qué nivel se cayó", () => {
    const e = started();
    e.proposeBet("u1", 5);
    e.respondBet("u2", true);

    expect(e.revokeMultiplier()).toBe(5);

    expect(e.match.acceptedBetExtra).toBe(0);
    expect(e.match.acceptedBetLevel).toBe(0);
  });

  // IDEMPOTENTE: dos compensaciones sobre el mismo trato no dejan el escalar en negativo ni
  // anuncian dos veces que se cayó. El que cobra puede reintentar.
  it("deshacer dos veces no deshace de más", () => {
    const e = started();
    e.proposeBet("u1", 5);
    e.respondBet("u2", true);
    e.revokeMultiplier();

    expect(e.revokeMultiplier()).toBe(0);
    expect(e.match.acceptedBetLevel).toBe(0);
  });

  it("sin nada acordado no hay nada que deshacer", () => {
    expect(started().revokeMultiplier()).toBe(0);
  });

  // ⚠ DESHACER DEJA LA MESA COMO SI NADIE HUBIERA ACEPTADO, y eso incluye poder volver a
  // proponer: el tope de «uno aceptado por partida» lo lleva `acceptedBetLevel`, que esto pone
  // en cero. Es correcto — el aumento que no se pudo cobrar no ocupó el cupo —, y es la clase de
  // consecuencia que conviene tener medida antes de que alguien la descubra jugando.
  it("después de deshacerlo se puede volver a proponer", () => {
    const e = started();
    e.proposeBet("u1", 5);
    e.respondBet("u2", true);
    e.revokeMultiplier();

    expect(() => e.proposeBet("u1", 2)).not.toThrow();
  });
});
