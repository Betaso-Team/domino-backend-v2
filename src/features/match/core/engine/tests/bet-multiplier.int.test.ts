import { decimal } from "@/shared/money";
import { describe, expect, it } from "vitest";
import { BET_CHARGE_WINDOW_MS, type BetLevel } from "../../config";
import { RuleViolationError } from "../errors";
import { engineWithHands } from "./build-engine";

// EL AUMENTO DE APUESTA. Lo que se prueba acá es sobre todo lo que NO se puede hacer: es
// dinero real, así que cada límite que v1 comprueba tiene su caso, y un límite sin test es
// plata que sale.
// LOS NIVELES SON LOS DE v1 —2 y 5— y eso ahora significa algo: el nivel ES el multiplicador
// de la mesa, no un índice. Con `entryFee: 125`, el x2 cuesta 125 de más y el x5 cuesta 500.
// Los montos NO están acá: el catálogo del backend principal no los trae, los deriva
// `betDifference` de la mesa (`@/shared/money`).
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
    // 125 * (5 - 1): la mesa entera multiplicada por el nivel, menos lo ya pagado. En la convención de
    // montos, porque el estado es el wire: texto en UC, la moneda de la mesa.
    expect(e.round().betOffer?.additionalEntryFee).toBe("500.0000");
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

  // Ni siquiera con el cobro del primero en vuelo: la oferta aceptada sigue viva hasta que se cobra.
  it("no se puede proponer mientras se cobra un aumento aceptado", () => {
    const e = started();
    e.proposeBet("u1", 2);
    e.respondBet("u2", true);

    expect(() => e.proposeBet("u1", 5)).toThrow(RuleViolationError);
  });
});

describe("aumento de apuesta: responder", () => {
  // ACEPTAR NO SUBE NADA TODAVÍA: el «sí» del rival abre el cobro, y la mesa sigue diciendo x1 hasta
  // que el orquestador cobró a los dos. Antes se asentaba al instante y el cobro llegaba después, así
  // que el jugador veía «aceptado» y segundos más tarde «no se pudo» con la partida ya en x2.
  it("aceptar deja la oferta aceptada y la ronda congelada, sin subir lo acordado", () => {
    const e = started();
    e.proposeBet("u1", 5);

    e.respondBet("u2", true);

    expect(e.match.acceptedBetExtra).toBe(0);
    expect(e.match.acceptedBetLevel).toBe(0);
    expect(e.round().phase).toBe("NEGOTIATING_BET");
    expect(e.round().betOffer?.accepted).toBe(true);
    expect(e.round().betOffer?.level).toBe(5);
  });

  // EL ACUERDO SE ANUNCIA CON TODO LO QUE EL COBRO NECESITA, y ése es el evento entero: el
  // comando dice «acepto», esto dice CUÁNTO y A QUIÉNES. Es la señal que la red espera para cobrar.
  it("aceptar anuncia el trato con lo que hace falta para cobrarlo", () => {
    const e = started();
    e.proposeBet("u1", 5);

    expect(e.respondBet("u2", true)).toEqual([
      {
        type: "MULTIPLIER_AGREED",
        level: 5,
        extra: 5,
        additionalEntryFee: decimal("500"),
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
    expect(e.round().betOffer).toBeUndefined();
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

  // UNA OFERTA ACEPTADA YA TIENE RESPUESTA: contestarla otra vez —un «no» que llega tarde, un doble
  // clic— no puede cancelar un cobro en vuelo ni pedir un segundo.
  it("una oferta ya aceptada no se vuelve a contestar", () => {
    const e = started();
    e.proposeBet("u1", 2);
    e.respondBet("u2", true);

    expect(() => e.respondBet("u2", false)).toThrow(RuleViolationError);
    expect(e.round().betOffer?.accepted).toBe(true);
  });

  it("mientras se cobra no se juega", () => {
    const e = started();
    e.proposeBet("u1", 2);
    e.respondBet("u2", true);

    expect(() => e.playTile("u1", { left: 6, right: 6 }, "LEFT")).toThrow(RuleViolationError);
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

  // EL TEMPORIZADOR SIGUE AL PLAZO. Antes proponer estampaba los 10 s de la respuesta en el árbol
  // pero el temporizador seguía programado al vencimiento del turno: la oferta se rechazaba sola
  // cuando se le acababa el turno al que jugaba, no a los 10 s.
  it("proponer, contestar y cobrar reprograman el temporizador al plazo vigente", () => {
    const e = started();

    e.proposeBet("u1", 2);
    expect(e.scheduled.at(-1)).toBe(e.match.activeDeadline);

    e.respondBet("u2", true);
    expect(e.scheduled.at(-1)).toBe(e.match.activeDeadline);

    e.confirmMultiplier();
    expect(e.scheduled.at(-1)).toBe(e.match.activeDeadline);
  });

  // MIENTRAS SE COBRA, EL PLAZO DE LA RESPUESTA YA NO CORRE: el rival contestó. Lo que queda es el
  // plazo del cobro, más largo que lo que la red espera al orquestador, así que lo decide la red.
  it("aceptar cambia el plazo de la respuesta por el del cobro", () => {
    const e = started();
    e.proposeBet("u1", 2);

    e.respondBet("u2", true);

    expect(e.match.activeDeadline).toBe(e.clockBox.now + BET_CHARGE_WINDOW_MS);
  });

  // LA RED DE SEGURIDAD: si nadie contestó el cobro en todo el plazo, el aumento se anula. Ante la
  // duda, rechazar: la mesa no puede quedar congelada para siempre esperando a una red que no vuelve.
  it("un cobro que nadie contesta a tiempo anula el aumento y devuelve el turno", () => {
    const e = started();
    e.clockBox.now += 200;
    e.proposeBet("u1", 2);
    e.respondBet("u2", true);
    e.clockBox.now += BET_CHARGE_WINDOW_MS;

    const events = e.fireTimeout();

    expect(events).toContainEqual({ type: "MULTIPLIER_REVOKED", level: 2 });
    expect(events).not.toContainEqual({ type: "BET_MULTIPLIER_REJECTED", playerId: "u2" });
    expect(e.match.acceptedBetLevel).toBe(0);
    expect(e.round().phase).toBe("PLAYING");
    expect(e.round().betOffer).toBeUndefined();
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 400);
  });
});

// EL COBRO CONFIRMADO, que tampoco lo pide un jugador: lo pide la RED cuando el orquestador cobró a
// los dos. Recién acá el aumento existe para la mesa.
describe("aumento de apuesta: confirmarlo cuando el cobro salió", () => {
  it("sube lo acordado a la PARTIDA, borra la oferta y devuelve el turno donde estaba", () => {
    const e = started();
    e.clockBox.now += 200;
    e.proposeBet("u1", 5);
    e.respondBet("u2", true);
    e.clockBox.now += 3_000;

    expect(e.confirmMultiplier()).toEqual([{ type: "MULTIPLIER_CONFIRMED", level: 5 }]);

    expect(e.match.acceptedBetExtra).toBe(5);
    expect(e.match.acceptedBetLevel).toBe(5);
    expect(e.round().phase).toBe("PLAYING");
    expect(e.round().betOffer).toBeUndefined();
    // Lo que le quedaba al turno al proponer (400 de 600), no el turno entero ni lo que tardó el cobro.
    expect(e.match.activeDeadline).toBe(e.clockBox.now + 400);
  });

  it("sin un aumento aceptado no hay nada que confirmar", () => {
    const e = started();
    expect(e.confirmMultiplier()).toEqual([]);
    e.proposeBet("u1", 2);
    // Propuesto pero sin contestar: confirmar no puede saltearse el «sí» del rival.
    expect(e.confirmMultiplier()).toEqual([]);
    expect(e.round().betOffer?.accepted).toBe(false);
  });

  it("confirmar dos veces no anuncia dos veces", () => {
    const e = started();
    e.proposeBet("u1", 2);
    e.respondBet("u2", true);
    e.confirmMultiplier();

    expect(e.confirmMultiplier()).toEqual([]);
    expect(e.match.acceptedBetLevel).toBe(2);
  });

  // UNO ACEPTADO POR PARTIDA, que es el tope de v1: sin esto la mesa se sube sin techo a
  // fuerza de insistir ronda a ronda.
  it("no se puede volver a proponer después de un aumento cobrado", () => {
    const e = started();
    e.proposeBet("u1", 2);
    e.respondBet("u2", true);
    e.confirmMultiplier();

    expect(() => e.proposeBet("u1", 5)).toThrow(RuleViolationError);
  });

  // LA PARTIDA PUEDE TERMINAR CON EL COBRO EN VUELO —uno abandona— y el cobro igual llega. Si salió,
  // los dos pagaron el aumento, así que el premio es el del aumento: el nivel sube aunque la mano ya
  // no siga, y la fase y el plazo de la partida terminada no se tocan.
  it("confirmado después de que la partida se resolvió, cuenta para el premio sin reanudar nada", () => {
    const e = started();
    e.proposeBet("u1", 2);
    e.respondBet("u2", true);
    e.abandon("u2");
    const phase = e.match.phase;
    const deadline = e.match.activeDeadline;

    expect(e.confirmMultiplier()).toEqual([{ type: "MULTIPLIER_CONFIRMED", level: 2 }]);

    expect(e.match.acceptedBetLevel).toBe(2);
    expect(e.match.phase).toBe(phase);
    expect(e.match.activeDeadline).toBe(deadline);
  });
});

// LA ANULACIÓN, el otro final del cobro: la billetera dijo que no, el orquestador no contestó o no se
// pudo preguntar. El aumento nunca existió para la mesa, así que no hay nada que deshacer en la
// partida: se borra la oferta y se devuelve el turno.
describe("aumento de apuesta: anularlo cuando el cobro no salió", () => {
  it("borra la oferta, devuelve el turno y dice qué nivel se cayó, sin tocar lo acordado", () => {
    const e = started();
    e.proposeBet("u1", 5);
    e.respondBet("u2", true);

    expect(e.revokeMultiplier()).toEqual([{ type: "MULTIPLIER_REVOKED", level: 5 }]);

    expect(e.match.acceptedBetExtra).toBe(0);
    expect(e.match.acceptedBetLevel).toBe(0);
    expect(e.round().phase).toBe("PLAYING");
    expect(e.round().betOffer).toBeUndefined();
  });

  // IDEMPOTENTE: dos anulaciones sobre el mismo trato no anuncian dos veces que se cayó.
  it("anular dos veces no anuncia de más", () => {
    const e = started();
    e.proposeBet("u1", 5);
    e.respondBet("u2", true);
    e.revokeMultiplier();

    expect(e.revokeMultiplier()).toEqual([]);
    expect(e.confirmMultiplier()).toEqual([]);
    expect(e.match.acceptedBetLevel).toBe(0);
  });

  it("sin nada aceptado no hay nada que anular", () => {
    expect(started().revokeMultiplier()).toEqual([]);
  });

  // UN AUMENTO COBRADO NO SE ANULA: la mesa ya dice x2 porque los dos pagaron.
  it("un aumento ya confirmado no se anula", () => {
    const e = started();
    e.proposeBet("u1", 2);
    e.respondBet("u2", true);
    e.confirmMultiplier();

    expect(e.revokeMultiplier()).toEqual([]);
    expect(e.match.acceptedBetLevel).toBe(2);
  });

  // EL AUMENTO QUE NO SE PUDO COBRAR NO OCUPÓ EL CUPO de «uno aceptado por partida».
  it("después de anularlo se puede volver a proponer", () => {
    const e = started();
    e.proposeBet("u1", 5);
    e.respondBet("u2", true);
    e.revokeMultiplier();

    expect(() => e.proposeBet("u1", 2)).not.toThrow();
  });
});
